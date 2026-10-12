import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Instrument } from "../../packages/contracts/index.js";
import type {
  MarketDataAdapter,
  ProviderBarSample,
} from "../../packages/market-data/longbridge.js";
import {
  OperationTimeout,
  withDeadline,
} from "../../packages/market-data/deadline.js";
import type { MarketSession } from "../../packages/market-data/calendar.js";
import { BarRepository } from "../../packages/market-data/ingestion.js";
import {
  MarketDataError,
  normalizeBar,
  type RawBar,
} from "../../packages/market-data/normalize.js";

export type WorkerInvalidation = {
  instrumentId: string;
  reason: "BAR_REVISION" | "BAR_CONFLICT" | "DATA_GAP";
  at: number;
  ingestSequence: number;
};
export interface VerifiedSampleEvidence {
  /** Audited source evidence is required. The production factory does not supply this resolver. */
  evidenceId: string;
  verifiedAt: number;
  /** This first audited path supports providers whose daily timestamp equals the session open. */
  raw: RawBar;
  session: MarketSession;
  /** Previous exchange session's start, from an audited calendar, never weekday arithmetic. */
  expectedPreviousStart?: number;
}
export interface MarketWorkerStatus {
  enabled: boolean;
  state: "DISABLED" | "IDLE" | "POLLING" | "BACKOFF" | "STOPPED";
  reason: string;
  source: string | null;
  connectionEpoch: number;
  liveEligible: false;
  providerQuotaVerified: false;
  continuity: "UNVERIFIED";
  lastStartedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorCode: string | null;
  lastQuarantineReason: string | null;
  nextPollAt: number | null;
  consecutiveFailures: number;
  requestCount: number;
  sampleCount: number;
  quarantinedCount: number;
  acceptedCount: number;
  duplicateCount: number;
  revisionCount: number;
  gapCount: number;
  researchCount: number;
  researchLimit: 100;
  latestReceiptSequence: number | null;
  watermarks: Array<{
    instrumentId: string;
    providerTimestamp: number;
    receivedAt: number;
    connectionEpoch: number;
    historical: true;
  }>;
}
export interface MarketWorkerOptions {
  db: Database.Database;
  researchInstruments: () => Instrument[];
  enabled?: boolean;
  credentialsPresent?: boolean;
  adapterFactory?: () => MarketDataAdapter | Promise<MarketDataAdapter>;
  now?: () => number;
  pollIntervalMs?: number;
  requestSpacingMs?: number;
  shutdownTimeoutMs?: number;
  requestTimeoutMs?: number;
  verifySample?: (
    sample: ProviderBarSample,
    instrument: Instrument,
  ) => VerifiedSampleEvidence | null;
  /** Synchronous hook in the same transaction as accepted revision/gap evidence. */
  onInvalidation?: (event: WorkerInvalidation) => void;
}
type Watermark = {
  instrumentId: string;
  providerTimestamp: number;
  receivedAt: number;
  connectionEpoch: number;
  historical: true;
  acceptedStart?: number;
};
export const emptyMarketWorkerStatus = (): MarketWorkerStatus => ({
  enabled: false,
  state: "DISABLED",
  reason: "WORKER_DISABLED",
  source: null,
  connectionEpoch: 0,
  liveEligible: false,
  providerQuotaVerified: false,
  continuity: "UNVERIFIED",
  lastStartedAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastErrorCode: null,
  lastQuarantineReason: null,
  nextPollAt: null,
  consecutiveFailures: 0,
  requestCount: 0,
  sampleCount: 0,
  quarantinedCount: 0,
  acceptedCount: 0,
  duplicateCount: 0,
  revisionCount: 0,
  gapCount: 0,
  researchCount: 0,
  researchLimit: 100,
  latestReceiptSequence: null,
  watermarks: [],
});
const safeSymbol = (instrument: Instrument) =>
  !instrument.id.startsWith("DEMO-") &&
  /^[A-Z0-9._-]+\.(US|SH|SZ)$/.test(instrument.symbol) &&
  (instrument.market === "US"
    ? instrument.symbol.endsWith(".US")
    : /\.(SH|SZ)$/.test(instrument.symbol));
const bounded = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) =>
  value !== undefined && Number.isSafeInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

export const MARKET_WORKER_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS market_worker_state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS market_worker_epochs(epoch INTEGER PRIMARY KEY AUTOINCREMENT,started_at INTEGER NOT NULL,stopped_at INTEGER);
      CREATE TABLE IF NOT EXISTS market_provider_receipts(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,epoch INTEGER NOT NULL REFERENCES market_worker_epochs(epoch),instrument_id TEXT NOT NULL,
        source TEXT NOT NULL,received_at INTEGER NOT NULL,observed_at INTEGER NOT NULL,
        provider_timestamp INTEGER NOT NULL,historical INTEGER NOT NULL CHECK(historical=1),
        payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,
        evidence_id TEXT,normalized_sequence INTEGER REFERENCES market_raw_inputs(ingest_sequence));
      CREATE INDEX IF NOT EXISTS market_provider_identity ON market_provider_receipts(instrument_id,source,provider_timestamp,payload_hash);
      CREATE TABLE IF NOT EXISTS market_worker_watermarks(instrument_id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS market_worker_admission(id INTEGER PRIMARY KEY CHECK(id=1),last_request_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS market_worker_monthly_symbols(month TEXT NOT NULL,symbol TEXT NOT NULL,PRIMARY KEY(month,symbol));

      CREATE TRIGGER IF NOT EXISTS market_provider_receipts_no_update BEFORE UPDATE ON market_provider_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROVIDER_RECEIPT'); END;
      CREATE TRIGGER IF NOT EXISTS market_provider_receipts_no_delete BEFORE DELETE ON market_provider_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROVIDER_RECEIPT'); END;
      CREATE TRIGGER IF NOT EXISTS market_provider_receipts_no_replace BEFORE INSERT ON market_provider_receipts WHEN EXISTS(SELECT 1 FROM market_provider_receipts WHERE sequence=NEW.sequence) BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROVIDER_RECEIPT'); END;
`;

/** Server-owned, daily-only evidence collection. It never activates a plan or emits an entry signal. */
export class MarketWorker {
  private readonly now: () => number;
  private readonly repository: BarRepository;
  private readonly interval: number;
  private readonly spacing: number;
  private readonly shutdownTimeout: number;
  private readonly requestTimeout: number;
  private readonly shutdown = new AbortController();
  private providerPending = false;
  private current: MarketWorkerStatus;
  private adapter: MarketDataAdapter | null = null;
  private task: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private requestWait: { timer: NodeJS.Timeout; resolve: () => void } | null =
    null;
  private stopped = false;
  private initialized = false;
  private automatic = false;
  constructor(private readonly options: MarketWorkerOptions) {
    this.now = options.now ?? Date.now;
    this.interval = bounded(
      options.pollIntervalMs,
      15 * 60_000,
      60_000,
      24 * 60 * 60_000,
    );
    this.spacing = bounded(options.requestSpacingMs, 1000, 1000, 60_000);
    this.shutdownTimeout = bounded(options.shutdownTimeoutMs, 2000, 1, 5000);
    this.requestTimeout = bounded(options.requestTimeoutMs, 20_000, 1, 60_000);
    options.db.exec(MARKET_WORKER_SCHEMA_SQL);
    this.repository = new BarRepository(options.db);
    const row = options.db
      .prepare("SELECT json FROM market_worker_state WHERE id=1")
      .get() as { json: string } | undefined;
    this.current = {
      ...emptyMarketWorkerStatus(),
      ...(row ? JSON.parse(row.json) : {}),
      watermarks: [],
    };
    this.current.liveEligible = false;
    this.current.providerQuotaVerified = false;
    this.current.continuity = "UNVERIFIED";
    const pendingBackoff =
      this.current.state === "BACKOFF" &&
      this.current.nextPollAt !== null &&
      this.current.nextPollAt > this.now();
    this.current.enabled = options.enabled === true;
    this.current.state = this.current.enabled
      ? pendingBackoff
        ? "BACKOFF"
        : "IDLE"
      : "DISABLED";
    this.current.nextPollAt = pendingBackoff ? this.current.nextPollAt : null;
    this.current.reason = !this.current.enabled
      ? "WORKER_DISABLED"
      : options.credentialsPresent === false || !options.adapterFactory
        ? "CREDENTIALS_MISSING"
        : pendingBackoff
          ? (this.current.lastErrorCode ?? "PROVIDER_REQUEST_FAILED")
          : "SAMPLING_ONLY_CAPABILITY_UNVERIFIED";
    if (this.current.reason === "CREDENTIALS_MISSING")
      this.current.state = "DISABLED";
    if (this.current.state === "DISABLED") this.current.nextPollAt = null;
    this.save();
  }
  private save() {
    this.options.db
      .prepare(
        "INSERT INTO market_worker_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(JSON.stringify({ ...this.current, watermarks: [] }));
  }
  status(): MarketWorkerStatus {
    try {
      this.current.watermarks = (
        this.options.db
          .prepare(
            "SELECT json FROM market_worker_watermarks ORDER BY instrument_id",
          )
          .all() as { json: string }[]
      ).map((row) => {
        const { acceptedStart: _private, ...publicMark } = JSON.parse(
          row.json,
        ) as Watermark;
        return publicMark;
      });
    } catch {
      this.persistenceFailure();
    }
    return structuredClone(this.current);
  }
  private persistenceFailure() {
    // SQLite may be full, locked or unavailable. Do not recursively write/log the underlying exception.
    this.current.state = this.stopped ? "STOPPED" : "BACKOFF";
    this.current.reason = "PERSISTENCE_UNAVAILABLE";
    this.current.lastErrorCode = "PERSISTENCE_UNAVAILABLE";
    this.current.lastFailureAt = this.now();
    this.current.nextPollAt = this.stopped ? null : this.now() + this.interval;
  }
  private initialize() {
    if (this.initialized || this.current.state === "DISABLED" || this.stopped)
      return;
    const previous = structuredClone(this.current);
    try {
      this.options.db
        .transaction(() => {
          const now = this.now();
          const epoch = this.options.db
            .prepare("INSERT INTO market_worker_epochs(started_at) VALUES(?)")
            .run(now);
          this.current.connectionEpoch = Number(epoch.lastInsertRowid);
          this.current.lastStartedAt = now;
          this.save();
        })
        .immediate();
      this.initialized = true;
    } catch (error) {
      this.current = previous;
      throw error;
    }
  }
  start(): void {
    if (this.automatic || this.stopped || this.current.state === "DISABLED")
      return;
    this.automatic = true;
    try {
      this.initialize();
    } catch {
      this.persistenceFailure();
    }
    this.schedule(0);
  }
  private schedule(delay: number) {
    if (this.stopped || !this.automatic) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const reschedule = () => {
        if (!this.stopped)
          this.schedule(
            Math.max(
              0,
              (this.current.nextPollAt ?? this.now() + this.interval) -
                this.now(),
            ),
          );
      };
      try {
        void this.pollOnce().then(reschedule, () => {
          this.persistenceFailure();
          reschedule();
        });
      } catch {
        this.persistenceFailure();
        reschedule();
      }
    }, delay);
    this.timer.unref();
  }
  /** Also used by controlled jobs/tests; concurrent callers share exactly one poll. */
  pollOnce(): Promise<void> {
    if (this.task) return this.task;
    if (this.stopped || this.current.state === "DISABLED")
      return Promise.resolve();
    if (
      this.current.nextPollAt !== null &&
      this.now() < this.current.nextPollAt
    )
      return Promise.resolve();
    try {
      this.initialize();
    } catch {
      this.persistenceFailure();
      return Promise.resolve();
    }
    this.task = this.poll().finally(() => {
      this.task = null;
    });
    return this.task;
  }
  private async admitRequest(symbol: string): Promise<boolean> {
    // One shared admission ledger covers both markets and survives restart. Local bounds are not supplier entitlement claims.
    const month = new Date(this.now()).toISOString().slice(0, 7);
    const admitted = this.options.db
      .transaction(() => {
        const already = this.options.db
          .prepare(
            "SELECT 1 FROM market_worker_monthly_symbols WHERE month=? AND symbol=?",
          )
          .get(month, symbol);
        const count = this.options.db
          .prepare(
            "SELECT COUNT(*) AS n FROM market_worker_monthly_symbols WHERE month=?",
          )
          .get(month) as { n: number };
        if (!already && count.n >= 100) return false;
        this.options.db
          .prepare(
            "INSERT OR IGNORE INTO market_worker_monthly_symbols VALUES(?,?)",
          )
          .run(month, symbol);
        return true;
      })
      .immediate();
    if (!admitted) throw new WorkerFailure("LOCAL_MONTHLY_SYMBOL_LIMIT");
    const row = this.options.db
      .prepare("SELECT last_request_at FROM market_worker_admission WHERE id=1")
      .get() as { last_request_at: number } | undefined;
    const delay = row
      ? Math.max(0, row.last_request_at + this.spacing - this.now())
      : 0;
    if (delay)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.requestWait = null;
          resolve();
        }, delay);
        this.requestWait = { timer, resolve };
      });
    if (this.stopped) return false;
    this.options.db
      .prepare(
        "INSERT INTO market_worker_admission VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_request_at=excluded.last_request_at",
      )
      .run(this.now());
    this.current.requestCount++;
    this.save();
    return true;
  }
  private async providerCall<T>(operation: () => Promise<T>): Promise<T> {
    if (this.providerPending)
      throw new WorkerFailure("PROVIDER_REQUEST_UNSETTLED");
    return withDeadline(
      () => {
        this.providerPending = true;
        const pending = Promise.resolve().then(operation);
        // Settlement releases only the request lane, never writes data or changes a stopped worker.
        void pending.then(
          () => {
            this.providerPending = false;
          },
          () => {
            this.providerPending = false;
          },
        );
        return pending;
      },
      this.requestTimeout,
      this.shutdown.signal,
    );
  }
  private async poll() {
    this.current.state = "POLLING";
    this.current.nextPollAt = null;
    try {
      this.save();
      // A deadline cannot cancel the SDK. Never pile retries on a still-pending call.
      if (this.providerPending)
        throw new WorkerFailure("PROVIDER_REQUEST_UNSETTLED");
      if (!this.adapter)
        this.adapter = await this.providerCall(async () =>
          this.options.adapterFactory!(),
        );
      if (this.stopped) return;
      this.current.source = this.adapter.source;
      const all = this.options.researchInstruments();
      if (all.length > 100) throw new WorkerFailure("RESEARCH_POOL_LIMIT");
      const instruments = all
        .filter(safeSymbol)
        .sort((a, b) => a.id.localeCompare(b.id));
      this.current.researchCount = instruments.length;
      for (const instrument of instruments) {
        if (!(await this.admitRequest(instrument.symbol)) || this.stopped)
          return;
        const sampledBefore = this.options.db
          .prepare(
            "SELECT 1 FROM market_worker_watermarks WHERE instrument_id=?",
          )
          .get(instrument.id);
        // Bootstrap research history once; later observations retain only a five-session correction overlap.
        // This is bounded sampling, not a claim that older history or intraday continuity is complete.
        const samples = await this.providerCall(() =>
          this.adapter!.fetchBars(
            instrument.symbol,
            "1D",
            sampledBefore ? 5 : 300,
          ),
        );
        if (this.stopped) return;
        if (samples.length > 1000)
          throw new WorkerFailure("PROVIDER_SAMPLE_LIMIT");
        for (const sample of samples) this.receive(sample, instrument);
      }
      this.current.lastSuccessAt = this.now();
      this.current.lastErrorCode = null;
      this.current.consecutiveFailures = 0;
      this.current.state = "IDLE";
      this.current.reason =
        instruments.length === 0
          ? "RESEARCH_POOL_EMPTY"
          : "SAMPLING_ONLY_CAPABILITY_UNVERIFIED";
      this.current.nextPollAt = this.now() + this.interval;
      this.save();
    } catch (error) {
      if (this.stopped) return;
      if (
        typeof (error as { code?: unknown })?.code === "string" &&
        String((error as { code: string }).code).startsWith("SQLITE_")
      ) {
        this.persistenceFailure();
        return;
      }
      this.current.lastFailureAt = this.now();
      this.current.lastErrorCode =
        error instanceof OperationTimeout
          ? "PROVIDER_REQUEST_TIMEOUT"
          : error instanceof WorkerFailure
            ? error.code
            : "PROVIDER_REQUEST_FAILED";
      this.current.reason = this.current.lastErrorCode;
      this.current.consecutiveFailures++;
      this.current.state = "BACKOFF";
      this.current.nextPollAt =
        this.now() +
        Math.min(
          15 * 60_000,
          5000 * 2 ** Math.min(this.current.consecutiveFailures - 1, 8),
        );
      try {
        this.save();
      } catch {
        this.persistenceFailure();
      }
    }
  }
  private receive(sample: ProviderBarSample, instrument: Instrument) {
    const priorStatus = structuredClone(this.current);
    try {
      this.options.db
        .transaction(() => {
          const { receivedAt: _receipt, ...payload } = sample;
          const digest = createHash("sha256")
            .update(JSON.stringify(payload))
            .digest("hex");
          const source = this.adapter!.source;
          const observedAt = this.now();
          const validReceipt =
            sample.symbol === instrument.symbol &&
            sample.period === "1D" &&
            Number.isSafeInteger(sample.timestamp) &&
            sample.timestamp >= 0 &&
            Number.isSafeInteger(sample.receivedAt) &&
            sample.receivedAt >= sample.timestamp &&
            sample.receivedAt <= observedAt;
          const duplicate = this.options.db
            .prepare(
              "SELECT 1 FROM market_provider_receipts WHERE instrument_id=? AND source=? AND provider_timestamp=? AND payload_hash=? LIMIT 1",
            )
            .get(instrument.id, source, sample.timestamp, digest);
          let reason = "AUDITED_EVIDENCE_REQUIRED";
          let status = "QUARANTINED";
          let evidence: VerifiedSampleEvidence | null = null;
          let normalizedSequence: number | null = null;
          let normalizedStart: number | undefined;
          let invalidation: WorkerInvalidation["reason"] | undefined;
          const oldRow = this.options.db
            .prepare(
              "SELECT json FROM market_worker_watermarks WHERE instrument_id=?",
            )
            .get(instrument.id) as { json: string } | undefined;
          const previous = oldRow
            ? (JSON.parse(oldRow.json) as Watermark)
            : null;
          try {
            if (!validReceipt)
              throw new MarketDataError("SAMPLE_IDENTITY_OR_TIME_INVALID");
            if (sample.finality !== "CONFIRMED")
              throw new MarketDataError("FINALITY_UNVERIFIED");
            evidence = this.options.verifySample?.(sample, instrument) ?? null;
            if (!evidence)
              throw new MarketDataError("AUDITED_EVIDENCE_REQUIRED");
            const raw = evidence.raw;
            if (
              !evidence.evidenceId ||
              !Number.isSafeInteger(evidence.verifiedAt) ||
              evidence.verifiedAt > observedAt ||
              raw.instrumentId !== instrument.id ||
              raw.market !== instrument.market ||
              raw.source !== source ||
              raw.period !== "1D" ||
              raw.receivedAt !== sample.receivedAt ||
              sample.timestamp !== raw.start ||
              sample.adjustment !== "RAW" ||
              !raw.final ||
              raw.synthetic === true ||
              ["open", "high", "low", "close", "volume", "turnover"].some(
                (key) =>
                  raw[key as keyof RawBar] !==
                  sample[key as keyof ProviderBarSample],
              )
            )
              throw new MarketDataError("EVIDENCE_SAMPLE_MISMATCH");
            const normalized = {
              ...normalizeBar(raw, evidence.session),
              historical: true,
            };
            const result = this.repository.ingest(normalized);
            normalizedSequence = result.ingestSequence;
            status = result.status;
            if (status !== "CONFLICT") normalizedStart = normalized.start;
            reason = "VERIFIED_RESEARCH_ONLY";
            if (result.invalidatesActivePlans)
              invalidation =
                result.status === "CONFLICT" ? "BAR_CONFLICT" : "BAR_REVISION";
            if (
              previous?.acceptedStart !== undefined &&
              normalized.start > previous.acceptedStart &&
              evidence.expectedPreviousStart !== undefined &&
              evidence.expectedPreviousStart !== previous.acceptedStart
            ) {
              invalidation = "DATA_GAP";
              this.current.gapCount++;
            }
            if (result.status === "REVISION" || result.status === "CONFLICT")
              this.current.revisionCount++;
          } catch (error) {
            if (!(error instanceof MarketDataError)) throw error;
            reason = error.code;
          }
          const inserted = this.options.db
            .prepare(
              `INSERT INTO market_provider_receipts(epoch,instrument_id,source,received_at,observed_at,provider_timestamp,historical,payload_hash,payload_json,status,reason,evidence_id,normalized_sequence) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)`,
            )
            .run(
              this.current.connectionEpoch,
              instrument.id,
              source,
              sample.receivedAt,
              observedAt,
              sample.timestamp,
              digest,
              JSON.stringify(sample),
              status,
              reason,
              evidence?.evidenceId ?? null,
              normalizedSequence,
            );
          if (invalidation)
            this.options.onInvalidation?.({
              instrumentId: instrument.id,
              reason: invalidation,
              at: observedAt,
              ingestSequence: normalizedSequence!,
            });
          this.current.sampleCount++;
          if (status === "QUARANTINED") {
            this.current.quarantinedCount++;
            this.current.lastQuarantineReason = reason;
          } else if (status === "INSERTED" || status === "REVISION")
            this.current.acceptedCount++;
          if (duplicate || status === "DUPLICATE")
            this.current.duplicateCount++;
          this.current.latestReceiptSequence = Number(inserted.lastInsertRowid);
          const next: Watermark = {
            instrumentId: instrument.id,
            providerTimestamp: Math.max(
              previous?.providerTimestamp ?? 0,
              sample.timestamp,
            ),
            receivedAt: Math.max(previous?.receivedAt ?? 0, sample.receivedAt),
            connectionEpoch: this.current.connectionEpoch,
            historical: true,
            ...((normalizedStart ?? previous?.acceptedStart) === undefined
              ? {}
              : {
                  acceptedStart: Math.max(
                    previous?.acceptedStart ?? 0,
                    normalizedStart ?? 0,
                  ),
                }),
          };
          if (validReceipt)
            this.options.db
              .prepare(
                "INSERT INTO market_worker_watermarks VALUES(?,?) ON CONFLICT(instrument_id) DO UPDATE SET json=excluded.json",
              )
              .run(instrument.id, JSON.stringify(next));
          this.save();
        })
        .immediate();
    } catch (error) {
      this.current = priorStatus;
      throw error;
    }
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.shutdown.abort();
    this.automatic = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.requestWait) {
      clearTimeout(this.requestWait.timer);
      this.requestWait.resolve();
      this.requestWait = null;
    }
    if (this.task) {
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([
        this.task,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, this.shutdownTimeout);
        }),
      ]);
      if (deadline) clearTimeout(deadline);
    }
    this.current.state = "STOPPED";
    this.current.reason = "WORKER_STOPPED";
    this.current.nextPollAt = null;
    if (this.initialized)
      this.options.db
        .prepare("UPDATE market_worker_epochs SET stopped_at=? WHERE epoch=?")
        .run(this.now(), this.current.connectionEpoch);
    this.save();
  }
}
class WorkerFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function createMarketWorkerFromEnvironment(
  store: {
    db: Database.Database;
    listInstruments: () => Array<{ instrument: Instrument }>;
  },
  env: NodeJS.ProcessEnv = process.env,
  onInvalidation?: MarketWorkerOptions["onInvalidation"],
): MarketWorker {
  const credentialsPresent = [
    env.LONGBRIDGE_APP_KEY,
    env.LONGBRIDGE_APP_SECRET,
    env.LONGBRIDGE_ACCESS_TOKEN,
  ].every((value) => Boolean(value?.trim()));
  return new MarketWorker({
    db: store.db,
    researchInstruments: () =>
      store.listInstruments().map((row) => row.instrument),
    enabled: env.PULLBACK_MARKET_WORKER === "1",
    credentialsPresent,
    adapterFactory: async () => {
      const { LongbridgeReadOnlyAdapter } =
        await import("../../packages/market-data/longbridge.js");
      return LongbridgeReadOnlyAdapter.fromEnvironment(env);
    },
    onInvalidation,
  });
}
