import { assertClosedActionEvidenceCurrent } from "./closed-action-binding.js";
import {
  Config,
  Period,
  PushCandlestickMode,
  QuoteContext,
  SubType,
  TradeSession,
  TradeSessions,
  TradeStatus,
} from "longbridge";
import type Database from "better-sqlite3";
import { assessCapability } from "../../packages/market-data/capabilities.js";
import { withDeadline } from "../../packages/market-data/deadline.js";
import { normalizeBar } from "../../packages/market-data/normalize.js";
import {
  reserveQuota,
  type ProviderQuota,
} from "../../packages/market-data/quota.js";
import {
  closedHash,
  validateClosedContext,
  type ClosedBarAdapter,
  type ClosedBarContext,
  type ClosedBarSink,
  type StoredClosedContext,
} from "./closed-bar-adapter.js";

export const LONGBRIDGE_SOURCE = "longbridge-node-5.2.0";
/** Only quote methods are available to this adapter. No account/trade context. */
export type LongbridgeQuotePort = Pick<
  QuoteContext,
  | "setOnCandlestick"
  | "setOnQuote"
  | "subscribeCandlesticks"
  | "unsubscribeCandlesticks"
  | "subscribe"
  | "unsubscribe"
>;
export interface LongbridgeClosedOptions {
  /** Audited, server-owned inputs. Never deserialize these from a request, env JSON or upload. */
  contexts: readonly ClosedBarContext[];
  /** Same quota contract as the existing sampler; account-specific limits must be audited. */
  quota: ProviderQuota;
  db: Database.Database;
  contextFactory: () => LongbridgeQuotePort | Promise<LongbridgeQuotePort>;
  now?: () => number;
  requestTimeoutMs?: number;
}
interface Connection {
  port: LongbridgeQuotePort;
  sink: ClosedBarSink;
  active: Set<string>;
  attempted: Set<string>;
  stopped: boolean;
  abort: AbortController;
  cleanup?: Promise<void>;
}
const fail = (code: string): never => {
  throw new Error(code);
};
const validTime = (at: number) => Number.isSafeInteger(at) && at >= 0;

/**
 * Real SDK transport for the existing closed-bar runtime. It grants no capability:
 * all evidence is validated before opening a context, and only CLOSE_CONFIRM is supported.
 */
export class LongbridgeClosedBarAdapter implements ClosedBarAdapter {
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly evidence: StoredClosedContext[];
  private readonly quota: ProviderQuota;
  private readonly bySymbol: Map<string, StoredClosedContext>;
  private connection: Connection | null = null;
  private starting = false;
  private updating = false;
  private nativePending = 0;
  private cleanupFailed = false;
  private lane: Promise<void> = Promise.resolve();
  private lastInvocation = -Infinity;
  private generation = 0;
  private lastClock: number;
  constructor(private readonly options: LongbridgeClosedOptions) {
    this.now = options.now ?? Date.now;
    this.timeout = options.requestTimeoutMs ?? 20_000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60_000
    )
      fail("LONGBRIDGE_TIMEOUT_INVALID");
    this.lastClock = this.now();
    // The SDK cannot attest ordered/continuous tick delivery. Never inherit LIVE_TICK.
    this.evidence = options.contexts.map((context) =>
      validateClosedContext(
        {
          ...structuredClone(context),
          capability: {
            ...context.capability,
            sequenceContractVerified: false,
            continuousTradesVerified: false,
          },
        },
        this.lastClock,
      ),
    );
    if (
      !this.evidence.length ||
      this.evidence.length > 10 ||
      new Set(this.evidence.map((c) => c.instrument.id)).size !==
        this.evidence.length ||
      new Set(this.evidence.map((c) => c.instrument.symbol)).size !==
        this.evidence.length
    )
      fail("CLOSED_SUBSCRIPTION_LIMIT");
    for (const c of this.evidence) {
      if (
        c.source !== LONGBRIDGE_SOURCE ||
        !/^[A-Z0-9._-]+\.(US|SH|SZ)$/.test(c.instrument.symbol) ||
        (c.instrument.market === "US"
          ? !c.instrument.symbol.endsWith(".US")
          : !/\.(SH|SZ)$/.test(c.instrument.symbol))
      )
        fail("LONGBRIDGE_CONTEXT_SOURCE_MISMATCH");
    }
    this.quota = structuredClone(options.quota);
    this.bySymbol = new Map(this.evidence.map((c) => [c.instrument.symbol, c]));
    this.validateAdmission([]);
  }
  contexts(): readonly ClosedBarContext[] {
    return this.evidence.map(
      ({
        id: _id,
        session: _session,
        dailyHash: _dailyHash,
        instrumentHash: _instrumentHash,
        ...context
      }) => structuredClone(context),
    );
  }
  private checkClock(): number {
    const now = this.now();
    if (!validTime(now) || now < this.lastClock)
      fail("LONGBRIDGE_CLOCK_REGRESSION");
    this.lastClock = now;
    return now;
  }
  private checkEvidence(): void {
    for (const c of this.evidence)
      assertClosedActionEvidenceCurrent(this.options.db, c);
    const now = this.checkClock();
    if (
      this.evidence.some(
        (c) => assessCapability(c.capability, now).level !== "LIVE_CLOSED_BAR",
      )
    )
      fail("LIVE_CAPABILITY_UNVERIFIED");
  }
  private validateAdmission(symbols: string[], commit = false): void {
    this.checkEvidence();
    const db = this.options.db;
    // The legacy historical sampler has an unverified quota policy; do not run two lanes.
    const worker = db
      .prepare("SELECT json FROM market_worker_state WHERE id=1")
      .get() as { json: string } | undefined;
    if (
      worker &&
      JSON.parse(worker.json).enabled === true &&
      JSON.parse(worker.json).state !== "STOPPED"
    )
      fail("LONGBRIDGE_SAMPLER_MUST_BE_DISABLED");
    const research = (
      db.prepare("SELECT json FROM instruments").all() as { json: string }[]
    )
      .map((row) => JSON.parse(row.json).instrument)
      .filter((i: { id: string }) => !i.id.startsWith("DEMO-"));
    const now = this.checkClock();
    const month = new Date(now).toISOString().slice(0, 7);
    const monthly = (
      db
        .prepare(
          "SELECT symbol FROM market_worker_monthly_symbols WHERE month=?",
        )
        .all(month) as { symbol: string }[]
    ).map((row) => row.symbol);
    if (
      !this.quota.verified ||
      this.quota.requestsPerSecond === null ||
      this.quota.requestsPerSecond < 1 ||
      this.quota.researchSymbols === null ||
      research.length > Math.min(100, this.quota.researchSymbols)
    )
      fail("PROVIDER_QUOTA_UNKNOWN");
    let state = {
      researchSymbols: research.map((i: { symbol: string }) => i.symbol),
      monitoringSymbols: [] as string[],
      monthlySymbols: monthly,
      requestTimes: [] as number[],
    };
    // REQUEST validates every quota field even when nothing is selected.
    const check = reserveQuota(state, this.quota, "REQUEST", "", now);
    if (!check.ok) fail(check.reason);
    for (const symbol of symbols) {
      const result = reserveQuota(state, this.quota, "MONITOR", symbol, now);
      if (!result.ok) fail(result.reason);
      state = (result as { ok: true; state: typeof state }).state;
    }
    if (commit)
      for (const symbol of symbols)
        db.prepare(
          "INSERT OR IGNORE INTO market_worker_monthly_symbols VALUES(?,?)",
        ).run(month, symbol);
  }
  /** Reserve synchronously while the store is open; queued shutdown work never needs the DB later. */
  private reserveSlot(cleanup: boolean): number {
    const now = cleanup
      ? Math.max(this.lastClock, this.now())
      : this.checkClock();
    if (!validTime(now)) fail("LONGBRIDGE_ADMISSION_CLOCK_INVALID");
    return this.options.db
      .transaction(() => {
        const prior = this.options.db
          .prepare(
            "SELECT last_request_at FROM market_worker_admission WHERE id=1",
          )
          .get() as { last_request_at: number } | undefined;
        if (prior && prior.last_request_at > now + 60_000)
          fail("LONGBRIDGE_ADMISSION_CLOCK_INVALID");
        const at = Math.max(now, (prior?.last_request_at ?? now - 1000) + 1000);
        this.options.db
          .prepare(
            "INSERT INTO market_worker_admission VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_request_at=excluded.last_request_at",
          )
          .run(at);
        return at;
      })
      .immediate();
  }
  private call<T>(
    c: Connection,
    operation: () => Promise<T>,
    cleanup = false,
  ): Promise<T> {
    // Reservation happens BEFORE queueing; a stop can return while the native SDK is
    // unresolved, and the owner may then close the DB. No callback touches it later.
    const slot = this.reserveSlot(cleanup);
    this.nativePending++;
    const pending = this.lane.then(async () => {
      if (!cleanup && c.stopped) fail("LONGBRIDGE_CONNECTION_STOPPED");
      const due = Math.max(
        performance.now() + Math.max(0, slot - this.now()),
        this.lastInvocation + 1000,
      );
      // Node truncates fractional setTimeout delays; recheck the monotonic deadline.
      while (performance.now() < due)
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            c.abort.signal.removeEventListener("abort", abort);
          };
          const abort = () => {
            finish();
            reject(new Error("LONGBRIDGE_CONNECTION_STOPPED"));
          };
          const timer = setTimeout(
            () => {
              finish();
              resolve();
            },
            Math.ceil(due - performance.now()),
          );
          if (!cleanup)
            c.abort.signal.addEventListener("abort", abort, { once: true });
        });
      if (!cleanup) {
        if (c.stopped) fail("LONGBRIDGE_CONNECTION_STOPPED");
        this.checkEvidence();
      }
      this.lastInvocation = performance.now();
      return operation();
    });
    // The lane stays occupied until the NATIVE request settles, not until our deadline.
    // Thus queued unsubscribe runs after a late subscribe acknowledgement without another request.
    this.lane = pending.then(
      () => {
        this.nativePending--;
      },
      () => {
        this.nativePending--;
        if (cleanup) this.cleanupFailed = true;
      },
    );
    return withDeadline(() => pending, cleanup ? 2000 : this.timeout);
  }
  async start(sink: ClosedBarSink): Promise<void> {
    if (
      this.connection ||
      this.starting ||
      this.nativePending ||
      this.cleanupFailed ||
      this.updating
    )
      fail("LONGBRIDGE_OPERATION_IN_FLIGHT");
    this.checkEvidence();
    this.validateAdmission([]);
    this.starting = true;
    const generation = ++this.generation;
    let opening: Connection | null = null;
    try {
      this.nativePending++;
      const pending = Promise.resolve().then(this.options.contextFactory);
      void pending.then(
        (port) => {
          this.nativePending--;
          if (generation !== this.generation) {
            try {
              port.setOnCandlestick(() => {});
            } catch {
              this.cleanupFailed = true;
            }
            try {
              port.setOnQuote(() => {});
            } catch {
              this.cleanupFailed = true;
            }
          }
        },
        () => {
          this.nativePending--;
        },
      );
      const port = await withDeadline(() => pending, this.timeout);
      if (generation !== this.generation) fail("LONGBRIDGE_START_CANCELLED");
      const c: Connection = {
        port,
        sink,
        active: new Set(),
        attempted: new Set(),
        stopped: false,
        abort: new AbortController(),
      };
      opening = c;
      this.connection = c;
      port.setOnCandlestick((err, event) => {
        if (c.stopped || this.connection !== c) return;
        if (err) return this.disconnect(c, "LONGBRIDGE_CANDLE_STREAM_ERROR");
        try {
          if (!c.active.has(event.symbol)) return;
          this.checkEvidence();
          const data = event.data;
          if (data.period !== Period.Min_1 || data.isConfirmed !== true) return;
          const b = data.candlestick;
          if (b.tradeSession !== TradeSession.Intraday) return;
          const context = this.bySymbol.get(event.symbol)!;
          const start = b.timestamp.getTime();
          if (!Number.isSafeInteger(b.volume) || b.volume < 0)
            fail("LONGBRIDGE_VOLUME_PRECISION_UNSAFE");
          const value = {
            id: `longbridge:minute:${event.symbol}:${start}`,
            instrumentId: context.instrument.id,
            market: context.instrument.market,
            period: "1m" as const,
            start,
            end: start + 60_000,
            open: b.open.toString(),
            high: b.high.toString(),
            low: b.low.toString(),
            close: b.close.toString(),
            volume: String(b.volume),
            turnover: b.turnover.toString(),
            volumeUnit: "SHARE" as const,
            final: true,
            source: LONGBRIDGE_SOURCE,
            // SDK exposes no revision or sequence. Changed content becomes a conflict, never a fabricated version.
            providerRevision: "sdk-unversioned-v1",
            sessionId: context.session.id,
            adjustment: "RAW" as const,
          };
          normalizeBar(
            { ...value, receivedAt: this.checkClock() },
            context.session,
          );
          c.sink.minute(value);
        } catch {
          this.disconnect(c, "LONGBRIDGE_CANDLE_CONTRACT_INVALID");
        }
      });
      port.setOnQuote((err, event) => {
        if (c.stopped || this.connection !== c) return;
        if (err) return this.disconnect(c, "LONGBRIDGE_QUOTE_STREAM_ERROR");
        try {
          if (!c.active.has(event.symbol)) return;
          this.checkEvidence();
          const q = event.data;
          if (q.tradeSession !== TradeSession.Intraday) return;
          if (q.tradeStatus !== TradeStatus.Normal)
            fail("LONGBRIDGE_SECURITY_NOT_TRADING");
          const context = this.bySymbol.get(event.symbol)!;
          const at = q.timestamp.getTime(),
            price = q.lastDone.toString();
          if (
            !validTime(at) ||
            at > this.checkClock() ||
            !context.session.intervals.some(
              (i) => at >= i.start && at <= i.end,
            ) ||
            !/^\d+(\.\d+)?$/.test(price) ||
            !/[1-9]/.test(price)
          )
            fail("LONGBRIDGE_QUOTE_INVALID");
          c.sink.quote({
            instrumentId: context.instrument.id,
            sessionId: context.session.id,
            source: LONGBRIDGE_SOURCE,
            id: `longbridge:quote:${closedHash({ symbol: event.symbol, at, price })}`,
            price,
            at,
          });
        } catch {
          this.disconnect(c, "LONGBRIDGE_QUOTE_CONTRACT_INVALID");
        }
      });
    } catch {
      this.generation++;
      if (opening) await this.cleanup(opening);
      this.connection = null;
      throw new Error("LONGBRIDGE_START_FAILED");
    } finally {
      this.starting = false;
    }
  }
  private disconnect(c: Connection, reason: string): void {
    if (c.stopped) return;
    c.stopped = true;
    c.active.clear();
    c.abort.abort();
    try {
      c.sink.disconnect(reason);
    } finally {
      void this.cleanup(c).catch(() => {});
    }
  }
  private cleanup(c: Connection): Promise<void> {
    if (c.cleanup) return c.cleanup;
    c.stopped = true;
    c.active.clear();
    c.abort.abort();
    let callbackFailure = false;
    try {
      c.port.setOnCandlestick(() => {});
    } catch {
      callbackFailure = true;
    }
    try {
      c.port.setOnQuote(() => {});
    } catch {
      callbackFailure = true;
    }
    const requests: Promise<unknown>[] = [];
    const attempted = [...c.attempted];
    try {
      for (const symbol of attempted)
        requests.push(
          this.call(
            c,
            () => c.port.unsubscribeCandlesticks(symbol, Period.Min_1),
            true,
          ),
        );
      if (attempted.length)
        requests.push(
          this.call(
            c,
            () => c.port.unsubscribe(attempted, [SubType.Quote]),
            true,
          ),
        );
    } catch {
      callbackFailure = true;
    }
    if (callbackFailure) this.cleanupFailed = true;
    c.cleanup = Promise.allSettled(requests).then((results) => {
      if (callbackFailure || results.some((r) => r.status === "rejected"))
        fail("LONGBRIDGE_CLEANUP_FAILED");
    });
    return c.cleanup;
  }
  async setSubscriptions(instrumentIds: readonly string[]): Promise<void> {
    const c = this.connection;
    if (!c || c.stopped) fail("LONGBRIDGE_NOT_CONNECTED");
    if (this.updating || this.nativePending)
      fail("LONGBRIDGE_OPERATION_IN_FLIGHT");
    if (
      new Set(instrumentIds).size !== instrumentIds.length ||
      instrumentIds.some(
        (id) => !this.evidence.some((e) => e.instrument.id === id),
      )
    )
      fail("LONGBRIDGE_SUBSCRIPTION_UNKNOWN");
    const connection = c!;
    const symbols = instrumentIds
      .map(
        (id) =>
          this.evidence.find((e) => e.instrument.id === id)!.instrument.symbol,
      )
      .sort();
    this.options.db
      .transaction(() => this.validateAdmission(symbols, true))
      .immediate();
    this.updating = true;
    try {
      for (const symbol of [...connection.active])
        if (!symbols.includes(symbol)) {
          connection.active.delete(symbol);
          await this.call(connection, () =>
            connection.port.unsubscribeCandlesticks(symbol, Period.Min_1),
          );
          await this.call(connection, () =>
            connection.port.unsubscribe([symbol], [SubType.Quote]),
          );
          connection.attempted.delete(symbol);
        }
      for (const symbol of symbols)
        if (!connection.active.has(symbol)) {
          connection.attempted.add(symbol);
          // SDK live callbacks can precede either subscription ACK. The requested symbol
          // is admitted now; failure fences the connection and never retries old opportunities.
          connection.active.add(symbol);
          await this.call(connection, () =>
            connection.port.subscribe([symbol], [SubType.Quote]),
          );
          if (connection.stopped) fail("LONGBRIDGE_CONNECTION_STOPPED");
          // Quote is ready before subscribing candles.
          // Return value is historical catch-up, NOT a newly closed live callback.
          await this.call(connection, () =>
            connection.port.subscribeCandlesticks(
              symbol,
              Period.Min_1,
              TradeSessions.Intraday,
            ),
          );
          if (connection.stopped) fail("LONGBRIDGE_CONNECTION_STOPPED");
        }
    } catch {
      this.disconnect(connection, "LONGBRIDGE_SUBSCRIPTION_FAILED");
      throw new Error("LONGBRIDGE_SUBSCRIPTION_FAILED");
    } finally {
      this.updating = false;
    }
  }
  async stop(): Promise<void> {
    this.generation++;
    const c = this.connection;
    this.connection = null;
    if (c) await this.cleanup(c);
    if (this.nativePending || this.cleanupFailed)
      fail("LONGBRIDGE_CLEANUP_UNCONFIRMED");
  }
}

/** Explicit server wiring only. Credentials are read lazily, after context/quota validation. */
export function longbridgeClosedBarFactory(
  contexts: readonly ClosedBarContext[],
  quota: ProviderQuota,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): (store: { db: Database.Database }) => LongbridgeClosedBarAdapter {
  if (env.PULLBACK_MARKET_WORKER === "1")
    fail("LONGBRIDGE_SAMPLER_MUST_BE_DISABLED");
  return (store) =>
    new LongbridgeClosedBarAdapter({
      contexts,
      quota,
      db: store.db,
      now,
      contextFactory: () => {
        const {
          LONGBRIDGE_APP_KEY: key,
          LONGBRIDGE_APP_SECRET: secret,
          LONGBRIDGE_ACCESS_TOKEN: token,
        } = env;
        if (!key?.trim() || !secret?.trim() || !token?.trim())
          fail("LONGBRIDGE_CREDENTIALS_MISSING");
        const config = Config.fromApikey(key!, secret!, token!, {
          enablePrintQuotePackages: false,
          enableOvernight: false,
          pushCandlestickMode: PushCandlestickMode.Confirmed,
        });
        return QuoteContext.new(config);
      },
    });
}
