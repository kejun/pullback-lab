import {
  intrabarContractReason,
  tickToken,
  validateTickPacket,
  type TickPacket,
  type TickCursor,
} from "./intrabar-contract.js";
import { withDeadline } from "../../packages/market-data/deadline.js";
import type { ClosedRiskInput } from "./closed-risk.js";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { chaseRatio } from "../../packages/domain/plan-controls.js";
import type { Plan, RiskResult } from "../../packages/contracts/index.js";
import {
  createAttempt,
  reduceAttempt,
  candidateAt,
  type AttemptConfig,
  type AttemptInput,
  type AttemptState,
  type TriggerBar,
  type TriggerEvent,
} from "../../packages/domain/trigger.js";
import { assessCapability } from "../../packages/market-data/capabilities.js";
import { BarRepository } from "../../packages/market-data/ingestion.js";
import {
  aggregateFiveMinuteBars,
  normalizeBar,
  type NormalizedBar,
} from "../../packages/market-data/normalize.js";
import {
  closedHash,
  validateClosedContext,
  type ClosedBarAdapter,
  type ClosedBarSink,
  type ClosedMinute,
  type ClosedQuote,
  type StoredClosedContext,
} from "./closed-bar-adapter.js";
import { ApiError, type Store } from "./store.js";

type Input = AttemptInput extends infer I
  ? I extends AttemptInput
    ? Omit<I, "ingestSeq">
    : never
  : never;
type Phase = "RUNNING" | "DATA_PAUSED" | "RECOVERY_PAUSED" | "COMPLETE";
interface Row {
  attempt_id: string;
  plan_id: string;
  plan_version: number;
  owner_epoch: string;
  connection_epoch: string;
  context_id: string;
  activation_seq: number;
  config_json: string;
  state_json: string;
  emitted_json: string;
  phase: Phase;
  watermark: number;
  deadline_watermark: number | null;
  source_attempt_id: string | null;
  created_at: number;
}
interface Receipt {
  seq: number;
  owner_epoch: string;
  connection_epoch: string;
  instrument_id: string;
  received_at: number;
  kind: string;
  payload_hash: string;
  payload_json: string;
}
interface Stream {
  connection_epoch: string;
  instrument_id: string;
  context_id: string;
  from_at: number;
  through_at: number;
  healthy: number;
  reason: string | null;
}
interface Options {
  adapter?: ClosedBarAdapter;
  now?: () => number;
  epoch?: string;
  recover?: boolean;
  autoDrain?: boolean;
  adapterTimeoutMs?: number;
}
const minute = 60_000;
const encode = JSON.stringify;
const decode = <T>(s: string) => JSON.parse(s) as T;
function error(
  code: string,
  message = "正式观察缺少已验证依据，尚未启用",
): never {
  throw new ApiError(422, code, message);
}

/** Durable formal bar/tick execution. No route accepts market inputs or adapter evidence. */
export class ClosedBarRuntime {
  private readonly now: () => number;
  private readonly epoch: string;
  private readonly repository: BarRepository;
  private connectionEpoch: string | null = null;
  private connected = false;
  private opening = false;
  private startPending = false;
  private subscriptionNativePending = false;
  private readonly abort = new AbortController();
  private subscriptionDirty = false;
  private subscriptionTask: Promise<void> | null = null;
  private subscriptionKey = "";
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastClock: number;
  constructor(
    private readonly store: Store,
    private readonly options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.epoch = options.epoch ?? randomUUID();
    this.lastClock = this.now();
    this.repository = new BarRepository(store.db);
    if (options.recover !== false)
      store.transaction(() => {
        store.db.prepare("DELETE FROM closed_sources").run();
        for (const row of this.rows()) {
          if (row.phase === "COMPLETE") continue;
          this.accept(row, {
            type: "DATA_GAP",
            id: `restart:${this.epoch}`,
            receivedAt: this.now(),
            reason: "RUNTIME_RESTARTED",
          });
          store.db
            .prepare(
              "UPDATE closed_attempts SET phase='RECOVERY_PAUSED' WHERE attempt_id=?",
            )
            .run(row.attempt_id);
        }
        store.db
          .prepare(
            "INSERT INTO closed_receipt_results SELECT seq,'RESTART_HISTORY_ONLY',? FROM closed_receipts WHERE seq NOT IN (SELECT seq FROM closed_receipt_results)",
          )
          .run(this.now());
      });
  }
  private rows(): Row[] {
    return this.store.db
      .prepare("SELECT * FROM closed_attempts ORDER BY rowid")
      .all() as Row[];
  }
  private row(id: string): Row {
    const r = this.store.db
      .prepare("SELECT * FROM closed_attempts WHERE attempt_id=?")
      .get(id) as Row | undefined;
    if (!r)
      throw new ApiError(404, "CLOSED_ATTEMPT_MISSING", "没有正式观察尝试");
    return r;
  }
  private context(id: string): StoredClosedContext {
    return decode(
      (
        this.store.db
          .prepare("SELECT json FROM closed_contexts WHERE id=?")
          .get(id) as { json: string }
      ).json,
    );
  }
  private stream(epoch: string, instrumentId: string): Stream | undefined {
    return this.store.db
      .prepare(
        "SELECT * FROM closed_streams WHERE connection_epoch=? AND instrument_id=?",
      )
      .get(epoch, instrumentId) as Stream | undefined;
  }
  private currentContext(instrumentId: string): StoredClosedContext {
    if (!this.connected || !this.options.adapter || this.closed)
      error("LIVE_CAPABILITY_UNVERIFIED");
    const s = this.stream(this.connectionEpoch!, instrumentId);
    if (!s) error("CLOSED_INSTRUMENT_NOT_SUBSCRIBED");
    const c = this.context(s.context_id);
    if (
      !["LIVE_CLOSED_BAR", "LIVE_TICK"].includes(
        assessCapability(c.capability, this.now()).level,
      )
    )
      error("LIVE_CAPABILITY_UNVERIFIED");
    return c;
  }
  status(planId: string) {
    const p = this.store.plan(planId);
    const row = this.rows()
      .filter((r) => r.plan_id === planId)
      .at(-1);
    if (!row) return null;
    const s = decode<AttemptState>(row.state_json),
      c = decode<AttemptConfig>(row.config_json);
    return {
      attemptId: row.attempt_id,
      planVersion: row.plan_version,
      sessionDate: this.context(row.context_id).session.date,
      phase: row.phase,
      status: s.status,
      reason: s.reason,
      template: c.template,
      mode: c.mode,
      sourceAttemptId: row.source_attempt_id,
      activatedAt: c.activatedAt,
      watermark: row.watermark,
      deadline: s.deadline,
      deadlineWatermark: row.deadline_watermark,
      inputCount: Math.max(0, s.lastIngestSeq),
      current: p.attemptId === row.attempt_id,
      synthetic: false,
    };
  }
  availability() {
    const streams = this.connectionEpoch
      ? (this.store.db
          .prepare("SELECT * FROM closed_streams WHERE connection_epoch=?")
          .all(this.connectionEpoch) as Stream[])
      : [];
    const instruments = streams.map((s) => ({
      instrumentId: s.instrument_id,
      liveEligible:
        this.connected &&
        Boolean(s.healthy) &&
        ["LIVE_CLOSED_BAR", "LIVE_TICK"].includes(
          assessCapability(this.context(s.context_id).capability, this.now())
            .level,
        ),
      tickEligible:
        this.connected &&
        Boolean(s.healthy) &&
        intrabarContractReason(this.context(s.context_id), this.now()) === null,
      tickReason: !this.connected
        ? "PROVIDER_DISCONNECTED"
        : !s.healthy
          ? s.reason
          : intrabarContractReason(this.context(s.context_id), this.now()),
      reason: s.reason,
    }));
    const liveEligible = instruments.some((s) => s.liveEligible);
    return {
      configured: Boolean(this.options.adapter),
      connected: this.connected,
      liveEligible,
      instruments,
      reason: liveEligible
        ? "SERVER_ADAPTER_CONNECTED"
        : "LIVE_CAPABILITY_UNVERIFIED",
    };
  }
  async start(): Promise<void> {
    if (this.closed) throw new Error("CLOSED_RUNTIME_STOPPED");
    if (this.connected) return;
    if (!this.options.adapter) return;
    if (this.startPending || this.subscriptionNativePending || this.opening)
      throw new Error("ADAPTER_START_IN_FLIGHT");
    this.startPending = true;
    this.opening = true;
    const assertOpening = () => {
      if (this.closed || !this.opening)
        throw new Error("ADAPTER_START_CANCELLED");
    };
    const operation = (async () => {
      if (this.connectionEpoch) {
        await this.options.adapter!.stop();
        assertOpening();
      }
      const now = this.now();
      const contexts = this.options
        .adapter!.contexts()
        .map((c) => validateClosedContext(c, now));
      if (
        !contexts.length ||
        contexts.length > 10 ||
        new Set(contexts.map((c) => c.instrument.id)).size !== contexts.length
      )
        error("CLOSED_SUBSCRIPTION_LIMIT");
      const epoch = randomUUID();
      this.store.transaction(() => {
        this.store.db.prepare("DELETE FROM closed_sources").run();
        for (const c of contexts) {
          const existing = this.store.instrument(c.instrument.id);
          this.store.db
            .prepare(
              "INSERT INTO closed_contexts SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM closed_contexts WHERE id=?)",
            )
            .run(c.id, c.instrument.id, c.session.date, encode(c), c.id);
          this.store.db
            .prepare("INSERT INTO closed_sources VALUES(?,?,?)")
            .run(c.instrument.id, c.id, this.epoch);
          this.store.putInstrument({ ...existing, instrument: c.instrument });
          const start = Math.max(
            c.session.open,
            c.session.open +
              Math.ceil((now - c.session.open) / minute) * minute,
          );
          this.store.db
            .prepare("INSERT INTO closed_streams VALUES(?,?,?,?,?,1,NULL)")
            .run(epoch, c.instrument.id, c.id, start, start);
        }
      });
      this.connectionEpoch = epoch;

      const sink: ClosedBarSink = {
        tickPacket: (v) => this.receive(epoch, "TICK_PACKET", v),
        minute: (v) => this.receive(epoch, "MINUTE", v),
        quote: (v) => this.receive(epoch, "QUOTE", v),
        noTrade: (v) => this.receive(epoch, "NO_TRADE", v),
        disconnect: (reason) => {
          if (epoch === this.connectionEpoch && !this.closed)
            this.disconnect(reason);
        },
      };

      await this.options.adapter!.start(sink);
      assertOpening();
      await this.options.adapter!.setSubscriptions([]);
      assertOpening();
    })().catch(async (cause) => {
      // A timeout cancels waiting, not the native operation. Late start success is cleaned up here.
      try {
        await this.options.adapter!.stop();
      } catch {
        /* Preserve the startup failure. */
      }
      throw cause;
    });
    void operation.then(
      () => {
        this.startPending = false;
      },
      () => {
        this.startPending = false;
      },
    );
    try {
      await withDeadline(
        () => operation,
        this.options.adapterTimeoutMs ?? 20_000,
        this.abort.signal,
      );
      assertOpening();
      this.connected = true;
      this.opening = false;
      this.subscriptionKey = "[]";
      if (this.options.autoDrain !== false) this.drain();
      this.syncSubscriptions();
    } catch {
      this.opening = false;
      if (!this.closed) this.disconnect("ADAPTER_START_FAILED");
      throw new Error("ADAPTER_START_FAILED");
    }
  }
  /** Reconcile only after the synchronous transaction stack commits. Provider calls never hold a DB lock. */
  private syncSubscriptions(): void {
    if (this.closed || !this.connected || !this.options.adapter) return;
    this.subscriptionDirty = true;
    if (this.subscriptionTask) return;
    this.subscriptionTask = Promise.resolve().then(async () => {
      try {
        while (this.subscriptionDirty && !this.closed && this.connected) {
          this.subscriptionDirty = false;
          const ids = [
            ...new Set(
              this.rows()
                .filter(
                  (r) =>
                    r.connection_epoch === this.connectionEpoch &&
                    r.phase === "RUNNING" &&
                    Boolean(
                      this.stream(
                        r.connection_epoch,
                        this.context(r.context_id).instrument.id,
                      )?.healthy,
                    ) &&
                    ["WAIT_RETEST", "ARMED", "TRIGGERED"].includes(
                      this.store.plan(r.plan_id).status,
                    ),
                )
                .map((r) => this.context(r.context_id).instrument.id),
            ),
          ].sort();
          const key = encode(ids);
          if (key === this.subscriptionKey) continue;
          this.subscriptionNativePending = true;
          const operation = Promise.resolve()
            .then(() => this.options.adapter!.setSubscriptions(ids))
            .then(async () => {
              if (this.closed || !this.connected)
                await this.options.adapter!.stop();
            })
            .catch(async (cause) => {
              if (!this.closed) this.disconnect("SUBSCRIPTION_UPDATE_FAILED");
              try {
                await this.options.adapter!.stop();
              } catch {
                /* Keep native operation ownership until it settles. */
              }
              throw cause;
            });
          void operation.then(
            () => {
              this.subscriptionNativePending = false;
            },
            () => {
              this.subscriptionNativePending = false;
            },
          );
          await withDeadline(
            () => operation,
            this.options.adapterTimeoutMs ?? 20_000,
            this.abort.signal,
          );
          this.subscriptionKey = key;
        }
      } catch {
        if (!this.closed) this.disconnect("SUBSCRIPTION_UPDATE_FAILED");
      } finally {
        this.subscriptionTask = null;
      }
    });
  }

  private receive(
    epoch: string,
    kind: string,
    value:
      | ClosedMinute
      | ClosedQuote
      | TickPacket
      | Parameters<ClosedBarSink["noTrade"]>[0],
  ): void {
    // Old callbacks are fenced by the captured subscription identity, including callbacks after stop.
    if (
      this.closed ||
      (!this.connected && !this.opening) ||
      epoch !== this.connectionEpoch
    )
      return;
    const receivedAt = this.now();
    if (!Number.isSafeInteger(receivedAt) || receivedAt < this.lastClock) {
      this.disconnect("SERVER_CLOCK_REGRESSED");
      return;
    }
    this.lastClock = receivedAt;
    const payload = encode(value);
    if (payload.length > 32_000) {
      this.disconnect("CLOSED_INPUT_TOO_LARGE");
      return;
    }
    const stream = this.stream(epoch, value.instrumentId);
    if (!stream) return;
    this.store.transaction(() => {
      const pending = this.store.db
        .prepare(
          "SELECT COUNT(*) n FROM closed_receipts WHERE seq NOT IN (SELECT seq FROM closed_receipt_results)",
        )
        .get() as { n: number };
      if (pending.n >= 1000) {
        this.pauseStream(stream, "INGRESS_BACKLOG_LIMIT", receivedAt);
        return;
      }
      this.store.db
        .prepare(
          "INSERT INTO closed_receipts(owner_epoch,connection_epoch,instrument_id,received_at,kind,payload_hash,payload_json) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          this.epoch,
          epoch,
          value.instrumentId,
          receivedAt,
          kind,
          closedHash(value),
          payload,
        );
    });
    if (this.connected && this.options.autoDrain !== false) this.drain();
  }
  private validQuote(r: Receipt, c: StoredClosedContext): ClosedQuote | null {
    if (r.kind !== "QUOTE") return null;
    const q = decode<ClosedQuote>(r.payload_json);
    try {
      if (
        !q.id ||
        q.instrumentId !== c.instrument.id ||
        q.source !== c.source ||
        q.sessionId !== c.session.id ||
        !Number.isSafeInteger(q.at) ||
        !c.session.intervals.some(
          (interval) => q.at >= interval.start && q.at <= interval.end,
        ) ||
        q.at > r.received_at ||
        q.at > this.now() ||
        !new Decimal(q.price).isFinite() ||
        !new Decimal(q.price).gt(0)
      )
        return null;
    } catch {
      return null;
    }
    return q;
  }
  private knownQuotes(
    row: Row,
    decisionAt: number,
  ): Array<{ q: ClosedQuote; r: Receipt }> {
    const c = this.context(row.context_id);
    return (
      this.store.db
        .prepare(
          "SELECT * FROM closed_receipts WHERE connection_epoch=? AND instrument_id=? AND kind='QUOTE' AND seq>? AND received_at<=? ORDER BY seq",
        )
        .all(
          row.connection_epoch,
          c.instrument.id,
          row.activation_seq,
          decisionAt,
        ) as Receipt[]
    ).flatMap((r) => {
      const q = this.validQuote(r, c);
      return q ? [{ q, r }] : [];
    });
  }
  private minutes(stream: Stream): NormalizedBar[] {
    return (
      this.store.db
        .prepare(
          "SELECT json FROM closed_minutes WHERE connection_epoch=? AND instrument_id=? ORDER BY start",
        )
        .all(stream.connection_epoch, stream.instrument_id) as {
        json: string;
      }[]
    )
      .map((r) => decode<NormalizedBar>(r.json))
      .filter((b) => b.period === "1m");
  }
  private accept(row: Row, raw: Input, receiptSeq: number | null = null): void {
    const p = this.store.plan(row.plan_id);
    if (p.attemptId !== row.attempt_id || p.version !== row.plan_version) {
      this.store.db
        .prepare(
          "UPDATE closed_attempts SET phase='COMPLETE' WHERE attempt_id=?",
        )
        .run(row.attempt_id);
      return;
    }
    const config = decode<AttemptConfig>(row.config_json),
      previous = decode<AttemptState>(row.state_json),
      now = this.now();
    if (previous.processedIds.includes(raw.id)) return;
    if (
      raw.type !== "CLOCK" &&
      raw.type !== "DATA_GAP" &&
      raw.type !== "PAUSE" &&
      raw.type !== "FEEDBACK" &&
      !previous.consumed &&
      !["WAIT_RETEST", "ARMED"].includes(p.status)
    ) {
      if (previous.status !== p.status) {
        this.accept(
          row,
          {
            type: p.status === "USER_PAUSED" ? "PAUSE" : "DATA_GAP",
            id: `external:${p.status}:${receiptSeq ?? now}`,
            receivedAt: raw.receivedAt,
            ...(p.status === "USER_PAUSED"
              ? {}
              : { reason: "PLAN_NO_LONGER_ACTIVE" }),
          } as Input,
          receiptSeq,
        );
      }
      return;
    }
    if (
      !["CLOCK", "DATA_GAP", "PAUSE", "FEEDBACK"].includes(raw.type) &&
      this.store.supportRevisionReasons(p, now).length
    ) {
      this.accept(
        row,
        {
          type: "DATA_GAP",
          id: `evidence:${receiptSeq ?? now}`,
          receivedAt: raw.receivedAt,
          reason: "PLAN_EVIDENCE_CHANGED",
        },
        receiptSeq,
      );
      return;
    }
    if (raw.type === "TICK" && raw.tick.at < config.activatedAt) return;
    if (
      (raw.type === "BAR" && raw.bar.start < config.activatedAt) ||
      (raw.type === "REFERENCE" && raw.bar.start < config.activatedAt)
    )
      return;
    const input = {
      ...structuredClone(raw),
      ingestSeq: Math.max(0, previous.lastIngestSeq) + 1,
    } as AttemptInput;
    let risk: RiskResult | null = null;
    let riskInput: ClosedRiskInput | undefined;
    if (
      input.type === "BAR" ||
      (input.type === "TICK" && config.mode === "INTRABAR_CROSS")
    ) {
      const quotes = [
        ...this.knownQuotes(row, now),
        ...(config.mode === "INTRABAR_CROSS"
          ? this.knownTickQuotes(row, now)
          : []),
      ].filter((x) => x.q.at >= config.activatedAt);
      const latest = quotes
        .toSorted((a, b) => a.q.at - b.q.at || a.r.seq - b.r.seq)
        .at(-1)?.q;
      const stop = quotes.find((x) => new Decimal(x.q.price).lte(config.stop));
      let knownStop = stop
        ? { price: stop.q.price, at: stop.q.at, receivedAt: stop.r.received_at }
        : undefined;
      if (!knownStop)
        for (const receipt of this.store.db
          .prepare(
            "SELECT * FROM closed_receipts WHERE connection_epoch=? AND instrument_id=? AND kind='MINUTE' AND seq>? AND received_at<=? ORDER BY seq",
          )
          .all(
            row.connection_epoch,
            p.instrumentId,
            row.activation_seq,
            now,
          ) as Receipt[]) {
          try {
            const b = normalizeBar(
              {
                ...decode<ClosedMinute>(receipt.payload_json),
                receivedAt: receipt.received_at,
                synthetic: false,
              },
              this.context(row.context_id).session,
            );
            if (
              b.final &&
              b.start >= config.activatedAt &&
              new Decimal(b.low).lte(config.stop)
            ) {
              knownStop = {
                price: b.low,
                at: b.end,
                receivedAt: receipt.received_at,
              };
              break;
            }
          } catch {
            /* Invalid frames are rejected by preflight, never used as stop evidence. */
          }
        }
      const stream = this.stream(row.connection_epoch, p.instrumentId)!;
      const bars = this.minutes(stream),
        c = this.context(row.context_id);
      riskInput = this.store.closedRiskInput(
        p,
        now,
        latest,
        config.sessionOpenAt,
      );
      risk = this.store.closedRisk(p, now, latest, config.sessionOpenAt);
      input.gates = {
        decisionAt: now,
        ...((raw.type === "BAR" &&
          "historical" in raw.bar &&
          raw.bar.historical === true) ||
        (raw.type === "TICK" &&
          (now >= previous.deadline || now - raw.tick.at > 3000))
          ? { historical: true }
          : {}),
        capability: assessCapability(c.capability, now).level,
        dataHealthy:
          Boolean(stream.healthy) &&
          this.connected &&
          row.connection_epoch === this.connectionEpoch,
        ...(latest ? { quote: { price: latest.price, at: latest.at } } : {}),
        ...(knownStop ? { knownStop } : {}),
        risk: {
          status: risk.passed ? "PASS" : "BLOCKED",
          reasons: risk.reasons,
          quantity: risk.quantity,
        },
        ...(config.mode === "INTRABAR_CROSS"
          ? this.tickLow(stream, config.sessionOpenAt)
          : bars.length
            ? {
                lod: {
                  price: Decimal.min(...bars.map((b) => b.low)).toFixed(),
                  from: stream.from_at,
                  through: stream.through_at,
                  complete:
                    stream.from_at === config.sessionOpenAt &&
                    Boolean(stream.healthy),
                },
              }
            : {}),
      };
    }
    const reduced = reduceAttempt(previous, input, config),
      emitted = [
        ...decode<TriggerEvent[]>(row.emitted_json),
        ...reduced.events,
      ];
    const serialized = encode(input);
    this.store.db
      .prepare("INSERT INTO closed_inputs VALUES(?,?,?,?,?,?,?,?)")
      .run(
        row.attempt_id,
        input.ingestSeq,
        receiptSeq,
        closedHash(input),
        serialized,
        encode(reduced.state),
        encode(reduced.events),
        now,
      );
    const inputs = reduced.events.length
      ? (
          this.store.db
            .prepare(
              "SELECT input_json FROM closed_inputs WHERE attempt_id=? ORDER BY ingest_seq",
            )
            .all(row.attempt_id) as { input_json: string }[]
        ).map((r) => decode<AttemptInput>(r.input_json))
      : [];
    const snapshot = {
      algorithmVersion: "pullback-c01-c07-v1",
      runtimeVersion:
        config.mode === "INTRABAR_CROSS" ? "intrabar-v1" : "closed-bar-v1",
      synthetic: false,
      contextId: row.context_id,
      context: this.context(row.context_id),
      config,
      inputs,
      state: reduced.state,
      emitted,
      plan: p,
      planVersion: this.store.planVersion(p),
      funds: this.store.funds(),
      reservations: this.store.reservations(),
      decisionTime: now,
      ...(risk ? { risk, riskInput } : {}),
      receiptSeq,
      connectionEpoch: row.connection_epoch,
    };
    this.store.commitClosedTransition(
      p.id,
      p.version,
      row.attempt_id,
      reduced.state,
      reduced.events,
      snapshot,
      risk,
      now,
    );
    const terminal = [
      "INVALID",
      "EXPIRED",
      "USER_PAUSED",
      "TAKEN",
      "SKIPPED",
    ].includes(reduced.state.status);
    this.store.db
      .prepare(
        "UPDATE closed_attempts SET state_json=?,emitted_json=?,phase=?,watermark=?,deadline_watermark=? WHERE attempt_id=?",
      )
      .run(
        encode(reduced.state),
        encode(emitted),
        reduced.state.status === "DATA_PAUSED"
          ? "DATA_PAUSED"
          : terminal
            ? "COMPLETE"
            : "RUNNING",
        Math.max(row.watermark, input.receivedAt),
        input.type === "CLOCK" ? input.receivedAt : row.deadline_watermark,
        row.attempt_id,
      );
  }
  private pauseStream(stream: Stream, reason: string, at: number): void {
    this.store.db
      .prepare(
        "UPDATE closed_streams SET healthy=0,reason=? WHERE connection_epoch=? AND instrument_id=?",
      )
      .run(reason, stream.connection_epoch, stream.instrument_id);
    for (const row of this.rows().filter(
      (r) =>
        r.connection_epoch === stream.connection_epoch &&
        this.context(r.context_id).instrument.id === stream.instrument_id &&
        r.phase !== "COMPLETE",
    ))
      this.accept(row, {
        type: "DATA_GAP",
        id: `gap:${reason}:${at}`,
        receivedAt: at,
        reason,
      });
  }
  disconnect(reason = "PROVIDER_DISCONNECTED"): void {
    if (this.closed) return;
    this.connected = false;
    this.opening = false;
    this.store.transaction(() => {
      for (const s of this.store.db
        .prepare("SELECT * FROM closed_streams WHERE connection_epoch=?")
        .all(this.connectionEpoch) as Stream[])
        this.pauseStream(
          s,
          /^[A-Z][A-Z0-9_]{0,79}$/.test(reason)
            ? reason
            : "PROVIDER_DISCONNECTED",
          this.now(),
        );
    });
  }
  private dispatchBar(stream: Stream, bar: NormalizedBar, seq: number): void {
    const c = this.context(stream.context_id),
      converted: TriggerBar = {
        ...bar,
        revision: bar.revision,
        period: bar.period as "1m" | "5m",
      };
    for (let row of this.rows().filter(
      (r) =>
        r.connection_epoch === stream.connection_epoch &&
        r.context_id === c.id &&
        r.phase === "RUNNING",
    )) {
      this.accept(
        row,
        {
          type: "BAR",
          id: `receipt:${seq}:${bar.period}:bar`,
          receivedAt: bar.receivedAt,
          bar: converted,
        },
        seq,
      );
      row = this.row(row.attempt_id);
      const next = candidateAt(bar.end, {
        sessionOpenAt: c.session.open,
        sessionCloseAt: c.session.close,
      });
      if (next && next.period === bar.period)
        this.accept(
          row,
          {
            type: "REFERENCE",
            id: `receipt:${seq}:${bar.period}:reference`,
            receivedAt: bar.receivedAt,
            candidate: next,
            bar: converted,
          },
          seq,
        );
    }
  }
  private tickCursor(stream: Stream): TickCursor | null {
    const row = this.store.db
      .prepare(
        "SELECT cursor_json FROM tick_packets WHERE connection_epoch=? AND instrument_id=? ORDER BY receipt_seq DESC LIMIT 1",
      )
      .get(stream.connection_epoch, stream.instrument_id) as
      { cursor_json: string } | undefined;
    return row ? decode<TickCursor>(row.cursor_json) : null;
  }
  private tickTrades(stream: Stream): TickPacket["trades"] {
    return (
      this.store.db
        .prepare(
          "SELECT t.json FROM tick_trades t JOIN closed_receipts r ON r.seq=t.receipt_seq WHERE r.connection_epoch=? AND r.instrument_id=? ORDER BY r.seq,t.position",
        )
        .all(stream.connection_epoch, stream.instrument_id) as {
        json: string;
      }[]
    ).map((r) => decode<TickPacket["trades"][number]>(r.json));
  }
  private tickLow(stream: Stream, sessionOpenAt: number) {
    const cursor = this.tickCursor(stream),
      trades = this.tickTrades(stream);
    return cursor && trades.length
      ? {
          lod: {
            price: Decimal.min(...trades.map((t) => t.price)).toFixed(),
            from: cursor.coverageFrom,
            through: cursor.coverageThrough,
            complete:
              cursor.coverageFrom === sessionOpenAt && Boolean(stream.healthy),
          },
        }
      : {};
  }
  /** Only server-installed protocol packets enter here; preflight validates all known queued packets before any action. */
  private knownTickQuotes(
    row: Row,
    decisionAt: number,
  ): Array<{ q: ClosedQuote; r: Receipt }> {
    const c = this.context(row.context_id);
    return (
      this.store.db
        .prepare(
          "SELECT * FROM closed_receipts WHERE connection_epoch=? AND instrument_id=? AND kind='TICK_PACKET' AND seq>? AND received_at<=? ORDER BY seq",
        )
        .all(
          row.connection_epoch,
          c.instrument.id,
          row.activation_seq,
          decisionAt,
        ) as Receipt[]
    ).flatMap((r) => {
      const packet = decode<TickPacket>(r.payload_json);
      return packet.trades.map((t) => ({
        r,
        q: {
          instrumentId: packet.instrumentId,
          sessionId: packet.sessionId,
          source: packet.source,
          id: tickToken(packet, t.position),
          price: t.price,
          at: t.at,
        },
      }));
    });
  }
  private processTickPacket(
    r: Receipt,
    stream: Stream,
    c: StoredClosedContext,
  ): string {
    const packet = decode<TickPacket>(r.payload_json);
    if (!stream.healthy) return "PAUSED_HISTORY_ONLY";
    if (intrabarContractReason(c, this.now())) {
      this.pauseStream(
        stream,
        "TICK_PROTOCOL_EVIDENCE_UNVERIFIED",
        r.received_at,
      );
      return "TICK_CAPABILITY_PAUSED";
    }
    const prior = this.store.db
      .prepare(
        "SELECT payload_hash FROM tick_packets WHERE connection_epoch=? AND instrument_id=? AND provider_epoch=? AND provider_sequence=?",
      )
      .get(
        r.connection_epoch,
        r.instrument_id,
        packet.providerEpoch,
        packet.providerSequence,
      ) as { payload_hash: string } | undefined;
    if (prior) {
      if (prior.payload_hash === r.payload_hash) return "DUPLICATE";
      this.pauseStream(stream, "TICK_PACKET_CONFLICT", r.received_at);
      return "TICK_CONFLICT";
    }
    const previous = this.tickCursor(stream);
    let cursor: TickCursor;
    try {
      cursor = validateTickPacket(packet, c, r.received_at, previous);
    } catch (error) {
      this.pauseStream(
        stream,
        error instanceof Error ? error.message : "TICK_PACKET_INVALID",
        r.received_at,
      );
      return "TICK_REJECTED";
    }
    this.store.db
      .prepare("INSERT INTO tick_packets VALUES(?,?,?,?,?,?,?)")
      .run(
        r.connection_epoch,
        r.instrument_id,
        packet.providerEpoch,
        packet.providerSequence,
        r.seq,
        r.payload_hash,
        encode(cursor),
      );
    for (const trade of packet.trades)
      this.store.db
        .prepare("INSERT INTO tick_trades VALUES(?,?,?,?)")
        .run(
          r.seq,
          trade.position,
          tickToken(packet, trade.position),
          encode(trade),
        );
    for (let row of this.rows().filter(
      (row) =>
        row.connection_epoch === r.connection_epoch &&
        row.context_id === c.id &&
        row.phase === "RUNNING" &&
        decode<AttemptConfig>(row.config_json).mode === "INTRABAR_CROSS",
    )) {
      const config = decode<AttemptConfig>(row.config_json);
      if (
        cursor.coverageFrom > Math.max(config.sessionOpenAt, config.activatedAt)
      ) {
        this.accept(
          row,
          {
            type: "DATA_GAP",
            id: `tick-anchor:${r.seq}`,
            receivedAt: r.received_at,
            reason: "TICK_ACTIVATION_COVERAGE_GAP",
          },
          r.seq,
        );
        continue;
      }
      let previousToken = previous?.lastTradeToken ?? null;
      for (const trade of packet.trades) {
        const sequence = tickToken(packet, trade.position);
        this.accept(
          row,
          {
            type: "TICK",
            id: `tick:${r.seq}:${trade.position}`,
            receivedAt: r.received_at,
            tick: {
              price: trade.price,
              at: trade.at,
              sessionId: packet.sessionId,
              evidenceEpoch: config.evidenceEpoch,
              sequence,
              previousSequence: previousToken,
              orderVerified: true,
              continuityVerified: true,
            },
          },
          r.seq,
        );
        previousToken = sequence;
        row = this.row(row.attempt_id);
      }
    }
    return "TICK_ACCEPTED";
  }
  private process(r: Receipt): string {
    const stream = this.stream(r.connection_epoch, r.instrument_id);
    if (
      !stream ||
      r.owner_epoch !== this.epoch ||
      r.connection_epoch !== this.connectionEpoch ||
      !this.connected
    )
      return "OLD_EPOCH_HISTORY_ONLY";
    const c = this.context(stream.context_id);
    if (
      !["LIVE_CLOSED_BAR", "LIVE_TICK"].includes(
        assessCapability(c.capability, this.now()).level,
      )
    ) {
      this.pauseStream(stream, "LIVE_CAPABILITY_UNVERIFIED", r.received_at);
      return "CAPABILITY_PAUSED";
    }
    if (r.kind === "TICK_PACKET") return this.processTickPacket(r, stream, c);
    if (r.kind === "QUOTE") {
      const q = this.validQuote(r, c);
      if (!q) {
        this.pauseStream(stream, "QUOTE_CONTRACT_INVALID", r.received_at);
        return "INVALID_QUOTE";
      }
      for (const row of this.rows().filter(
        (x) =>
          x.connection_epoch === r.connection_epoch &&
          x.context_id === c.id &&
          x.phase === "RUNNING",
      )) {
        const state = decode<AttemptState>(row.state_json),
          config = decode<AttemptConfig>(row.config_json);
        // All quotes remain in the immutable ingress log. Only invalidation/fade facts need a reducer input.
        if (
          new Decimal(q.price).gt(config.stop) &&
          (!state.trigger || new Decimal(q.price).gte(state.trigger.threshold))
        )
          continue;
        this.accept(
          row,
          {
            type: "TICK",
            id: `quote:${r.seq}`,
            receivedAt: r.received_at,
            tick: {
              price: q.price,
              at: q.at,
              sessionId: q.sessionId,
              evidenceEpoch: config.evidenceEpoch,
              sequence: null,
              previousSequence: null,
              orderVerified: false,
              continuityVerified: false,
            },
          },
          r.seq,
        );
      }
      return "QUOTE";
    }
    if (r.kind === "NO_TRADE") {
      const n = decode<Parameters<ClosedBarSink["noTrade"]>[0]>(r.payload_json);
      const existing = this.store.db
        .prepare(
          "SELECT json FROM closed_minutes WHERE connection_epoch=? AND instrument_id=? AND start=?",
        )
        .get(r.connection_epoch, r.instrument_id, n.start) as
        { json: string } | undefined;
      if (existing) {
        if (
          closedHash(decode(existing.json)) ===
          closedHash({ ...n, kind: "NO_TRADE" })
        )
          return "DUPLICATE";
        this.pauseStream(stream, "NO_TRADE_COVERAGE_CONFLICT", r.received_at);
        return "CONFLICT";
      }
      if (
        n.source !== c.source ||
        n.sessionId !== c.session.id ||
        !n.evidenceId ||
        n.start !== stream.through_at ||
        n.end !== n.start + minute ||
        r.received_at < n.end ||
        r.received_at > n.end + 30_000
      ) {
        this.pauseStream(stream, "NO_TRADE_COVERAGE_INVALID", r.received_at);
        return "INVALID_COVERAGE";
      }
      if (!stream.healthy) return "PAUSED_HISTORY_ONLY";
      this.store.db
        .prepare("INSERT INTO closed_minutes VALUES(?,?,?,?,?)")
        .run(
          r.connection_epoch,
          r.instrument_id,
          n.start,
          r.seq,
          encode({ ...n, kind: "NO_TRADE" }),
        );
      this.store.db
        .prepare(
          "UPDATE closed_streams SET through_at=? WHERE connection_epoch=? AND instrument_id=?",
        )
        .run(n.end, r.connection_epoch, r.instrument_id);
      return "NO_TRADE";
    }
    let bar: NormalizedBar;
    try {
      const raw = decode<ClosedMinute & { synthetic?: boolean }>(
        r.payload_json,
      );
      if (raw.source !== c.source || raw.period !== "1m" || raw.synthetic)
        throw new Error("CLOSED_SOURCE_MISMATCH");
      bar = normalizeBar(
        { ...raw, receivedAt: r.received_at, synthetic: false },
        c.session,
      );
    } catch {
      this.pauseStream(stream, "MINUTE_CONTRACT_INVALID", r.received_at);
      return "INVALID_MINUTE";
    }
    if (!bar.final) return "UNCONFIRMED";
    const result = this.repository.ingest(bar);
    if (result.invalidatesActivePlans) {
      this.pauseStream(
        stream,
        result.status === "CONFLICT"
          ? "MINUTE_PAYLOAD_CONFLICT"
          : "MINUTE_REVISION_CHANGED",
        r.received_at,
      );
      return result.status;
    }
    if (result.status === "DUPLICATE") return "DUPLICATE";
    if (bar.start < stream.from_at) return "PRE_CONNECTION_HISTORY_ONLY";
    if (!stream.healthy) return "PAUSED_HISTORY_ONLY";
    if (bar.start !== stream.through_at) {
      this.pauseStream(stream, "MINUTE_OUT_OF_ORDER_OR_GAP", r.received_at);
      return "GAP";
    }
    if (bar.historical) {
      // Preserve a late technical reference when determinable, but do not repair live continuity.
      this.dispatchBar(stream, bar, r.seq);
      this.pauseStream(stream, "MINUTE_TOO_LATE", r.received_at);
      return "LATE_HISTORY_ONLY";
    }
    this.store.db
      .prepare("INSERT INTO closed_minutes VALUES(?,?,?,?,?)")
      .run(r.connection_epoch, r.instrument_id, bar.start, r.seq, encode(bar));
    this.store.db
      .prepare(
        "UPDATE closed_streams SET through_at=? WHERE connection_epoch=? AND instrument_id=?",
      )
      .run(bar.end, r.connection_epoch, r.instrument_id);
    this.dispatchBar(stream, bar, r.seq);
    if ((bar.end - c.session.open) % 300_000 === 0) {
      const aggregated = aggregateFiveMinuteBars(
        this.minutes(stream),
        c.session,
      ).bars.find((b) => b.end === bar.end);
      if (aggregated) {
        // All pre-switch buckets are retained for the 09:45 five-minute reference.
        if (aggregated.start >= c.session.open + 15 * minute)
          this.dispatchBar(stream, aggregated, r.seq);
        else
          for (const row of this.rows().filter(
            (x) =>
              x.connection_epoch === r.connection_epoch &&
              x.context_id === c.id &&
              x.phase === "RUNNING",
          )) {
            const next = candidateAt(aggregated.end, {
              sessionOpenAt: c.session.open,
              sessionCloseAt: c.session.close,
            });
            if (next?.period === "5m")
              this.accept(
                row,
                {
                  type: "REFERENCE",
                  id: `receipt:${r.seq}:5m:reference`,
                  receivedAt: aggregated.receivedAt,
                  candidate: next,
                  bar: { ...aggregated, period: "5m" },
                },
                r.seq,
              );
          }
      }
    }
    return "ACCEPTED";
  }
  /** Facts already received by decision time can revoke eligibility even while queued behind an older bar. */
  private preflight(r: Receipt): void {
    const stream = this.stream(r.connection_epoch, r.instrument_id);
    if (!stream?.healthy || r.connection_epoch !== this.connectionEpoch) return;
    const context = this.context(stream.context_id);
    const pending = this.store.db
      .prepare(
        "SELECT * FROM closed_receipts WHERE connection_epoch=? AND instrument_id=? AND seq NOT IN (SELECT seq FROM closed_receipt_results) ORDER BY seq",
      )
      .all(r.connection_epoch, r.instrument_id) as Receipt[];
    const known = new Map(this.minutes(stream).map((b) => [b.start, b]));
    const coverage = new Map(
      (
        this.store.db
          .prepare(
            "SELECT start,json FROM closed_minutes WHERE connection_epoch=? AND instrument_id=?",
          )
          .all(r.connection_epoch, r.instrument_id) as {
          start: number;
          json: string;
        }[]
      ).map((x) => [x.start, decode(x.json)]),
    );
    const payload = (b: NormalizedBar) => {
      const { receivedAt, historical, ...value } = b;
      return closedHash(value);
    };
    let through = stream.through_at;
    let tickCursor = this.tickCursor(stream);
    const tickHashes = new Map(
      (
        this.store.db
          .prepare(
            "SELECT provider_epoch,provider_sequence,payload_hash FROM tick_packets WHERE connection_epoch=? AND instrument_id=?",
          )
          .all(stream.connection_epoch, stream.instrument_id) as {
          provider_epoch: string;
          provider_sequence: string;
          payload_hash: string;
        }[]
      ).map((p) => [
        JSON.stringify([p.provider_epoch, p.provider_sequence]),
        p.payload_hash,
      ]),
    );
    for (const item of pending) {
      let reason: string | null = null;
      if (item.kind === "TICK_PACKET") {
        try {
          const packet = decode<TickPacket>(item.payload_json);
          const key = JSON.stringify([
            packet.providerEpoch,
            packet.providerSequence,
          ]);
          const prior = tickHashes.get(key);
          if (prior) {
            if (prior !== item.payload_hash) reason = "TICK_PACKET_CONFLICT";
          } else {
            tickCursor = validateTickPacket(
              packet,
              context,
              item.received_at,
              tickCursor,
            );
            tickHashes.set(key, item.payload_hash);
          }
        } catch (error) {
          reason =
            error instanceof Error ? error.message : "TICK_PACKET_INVALID";
        }
      } else if (item.kind === "QUOTE") {
        if (!this.validQuote(item, context)) reason = "QUOTE_CONTRACT_INVALID";
      } else if (item.kind === "MINUTE") {
        try {
          const raw = decode<ClosedMinute & { synthetic?: boolean }>(
            item.payload_json,
          );
          if (
            raw.source !== context.source ||
            raw.period !== "1m" ||
            raw.synthetic
          )
            throw new Error("source");
          const b = normalizeBar(
            { ...raw, receivedAt: item.received_at, synthetic: false },
            context.session,
          );
          if (!b.final || b.start < stream.from_at) continue;
          const prior = known.get(b.start);
          if (
            prior &&
            (prior.revision !== b.revision || payload(prior) !== payload(b))
          )
            reason = "MINUTE_REVISION_CHANGED";
          else if (!prior) {
            if (b.start !== through) reason = "MINUTE_OUT_OF_ORDER_OR_GAP";
            // A selected late bar can still leave a historical technical record. A late constituent
            // received later in the pending queue must prevent an earlier actionable decision now.
            else if (b.historical && item.seq !== r.seq)
              reason = "MINUTE_TOO_LATE";
            known.set(b.start, b);
            through = b.end;
          }
        } catch {
          reason = "MINUTE_CONTRACT_INVALID";
        }
      } else if (item.kind === "NO_TRADE") {
        const n = decode<Parameters<ClosedBarSink["noTrade"]>[0]>(
          item.payload_json,
        );
        if (coverage.has(n.start)) {
          if (
            closedHash(coverage.get(n.start)) !==
            closedHash({ ...n, kind: "NO_TRADE" })
          )
            reason = "NO_TRADE_COVERAGE_CONFLICT";
          else continue;
        }
        if (
          n.start !== through ||
          n.end !== n.start + minute ||
          n.source !== context.source ||
          n.sessionId !== context.session.id ||
          !n.evidenceId ||
          !Number.isSafeInteger(n.start) ||
          (n.start - context.session.open) % minute !== 0 ||
          !context.session.intervals.some(
            (i) => n.start >= i.start && n.end <= i.end,
          ) ||
          item.received_at < n.end ||
          item.received_at > n.end + 30_000
        )
          reason = "NO_TRADE_COVERAGE_INVALID";
        else {
          through = n.end;
          coverage.set(n.start, { ...n, kind: "NO_TRADE" });
        }
      }
      if (reason) {
        this.pauseStream(stream, reason, this.now());
        return;
      }
    }
    if (
      through <
        Math.min(context.session.open + 60 * minute, context.session.close) &&
      this.now() > through + minute + 30_000
    )
      this.pauseStream(stream, "MISSING_MINUTE", this.now());
  }
  drain(): void {
    if (this.closed) return;
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < this.lastClock) {
      this.disconnect("SERVER_CLOCK_REGRESSED");
      return;
    }
    this.lastClock = at;
    // Each ingress record is immutable. Processing outcome, cursors and all attempt effects are one transaction.
    for (;;) {
      const did = this.store.transaction(() => {
        if (this.now() < this.lastClock) {
          this.disconnect("SERVER_CLOCK_REGRESSED");
          return false;
        }
        this.lastClock = this.now();
        const r = this.store.db
          .prepare(
            "SELECT * FROM closed_receipts WHERE owner_epoch=? AND seq NOT IN (SELECT seq FROM closed_receipt_results) ORDER BY seq LIMIT 1",
          )
          .get(this.epoch) as Receipt | undefined;
        if (!r) return false;
        this.preflight(r);
        const status = this.process(r);
        this.store.db
          .prepare("INSERT INTO closed_receipt_results VALUES(?,?,?)")
          .run(r.seq, status, this.now());
        return true;
      });
      if (!did) break;
    }
    this.syncSubscriptions();
  }
  activate(
    planId: string,
    command: { expectedVersion: number; expectedAttemptId: string | null },
    recovery?: { sourceAttemptId: string; expectedWatermark: number },
  ) {
    const result = this.store.transaction(() => {
      this.drain();
      const now = this.now(),
        p = this.store.plan(planId);
      if (
        p.version !== command.expectedVersion ||
        p.attemptId !== command.expectedAttemptId
      )
        throw new ApiError(409, "ATTEMPT_CONFLICT", "计划或观察尝试已改变");
      const c = this.currentContext(p.instrumentId),
        stream = this.stream(this.connectionEpoch!, p.instrumentId)!;
      if (!stream.healthy) error("DATA_NOT_HEALTHY");
      if (p.researchHistoryId) error("HISTORICAL_RESEARCH_ONLY");
      if (p.mode === "INTRABAR_CROSS") {
        const reason = intrabarContractReason(c, now);
        if (reason)
          error(
            reason,
            "连续逐笔协议、原始序号及实际部署证据尚未核验，盘中模式不可启用",
          );
      }
      if (p.sessionDate !== c.session.date) error("CLOSED_SESSION_MISMATCH");
      if (!p.backgroundConfirmed || !p.reason.trim())
        error("BACKGROUND_UNCONFIRMED");
      if (!this.store.screeningSettings().current) error("RULES_UNCONFIRMED");
      if (p.supportSnapshot?.providerContextId !== c.id)
        error("PROVIDER_CONTEXT_REVISION_CHANGED");
      if (
        !p.supportSnapshot?.ready ||
        this.store.supportRevisionReasons(p, now).length
      )
        error("SUPPORT_NOT_READY");
      if (now >= Math.min(c.session.open + 60 * minute, c.session.close))
        error("OUTSIDE_FIRST_HOUR");
      const prior = this.rows()
        .filter(
          (r) =>
            r.plan_id === planId &&
            this.context(r.context_id).session.date === p.sessionDate,
        )
        .at(-1);
      let source: Row | undefined;
      if (recovery) {
        if (
          !prior ||
          prior.attempt_id !== recovery.sourceAttemptId ||
          prior.watermark !== recovery.expectedWatermark
        )
          throw new ApiError(
            409,
            "RECOVERY_SOURCE_CONFLICT",
            "恢复来源或水位已改变",
          );
        source = prior;
        const old = decode<AttemptState>(source.state_json);
        if (
          old.consumed ||
          !["USER_PAUSED", "DATA_PAUSED", "DRAFT"].includes(p.status)
        )
          error("RECOVERY_UNAVAILABLE");
      } else {
        if (prior)
          throw new ApiError(
            409,
            "RECOVERY_REQUIRED",
            "本会话已有尝试，请显式新建恢复尝试",
          );
        if (now > c.session.open) {
          if (p.mode === "INTRABAR_CROSS") {
            const cursor = this.tickCursor(stream);
            if (
              !cursor ||
              cursor.coverageFrom !== c.session.open ||
              cursor.coverageThrough < now
            )
              error("SESSION_HISTORY_INCOMPLETE");
            if (
              this.tickTrades(stream).some((t) =>
                new Decimal(t.price).lte(p.upper),
              )
            )
              error("EARLIER_RETEST_ALREADY_OBSERVED");
          } else {
            if (stream.from_at !== c.session.open || stream.through_at < now)
              error("SESSION_HISTORY_INCOMPLETE");
            if (
              this.minutes(stream).some((b) => new Decimal(b.low).lte(p.upper))
            )
              error("EARLIER_RETEST_ALREADY_OBSERVED");
          }
        }
      }
      const activated = this.store.activate(
        planId,
        p.version,
        now,
        source
          ? {
              recovery: true,
              expectedAttemptId: p.attemptId,
              sourceAttemptId: source.attempt_id,
            }
          : undefined,
      );
      const plan = activated.plan;
      const version = this.store.planVersion(plan);
      const config: AttemptConfig = {
        allowPausedCancellation: true,
        allowFeedbackCorrections: true,
        attemptId: plan.attemptId!,
        planId,
        planVersion: p.version,
        sessionId: c.session.id,
        sessionOpenAt: c.session.open,
        sessionCloseAt: c.session.close,
        activatedAt: Math.max(now, source?.watermark ?? now),
        mode: p.mode,
        lower: version.lower,
        upper: version.upper,
        stop: version.stop,
        entryMin: version.entryMin,
        entryMax: version.entryMax,
        ...(version.chaseLimit?.enabled
          ? {
              chaseFromLowMax: chaseRatio(version),
            }
          : {}),
        tick: c.instrument.tick,
        previousDayClose: version.supportSnapshot!.reference.close!,
        evidenceEpoch: randomUUID(),
        template: source ? "RECOVERY" : "SESSION_FIRST",
        preActivationEvidence: source ? "UNKNOWN" : "NO_TOUCH",
      };
      const state = createAttempt(config);
      if (state.status !== "WAIT_RETEST")
        error(state.reason ?? "CLOSED_ACTIVATION_BLOCKED");
      const activationSeq = (
        this.store.db
          .prepare("SELECT COALESCE(MAX(seq),0) n FROM closed_receipts")
          .get() as { n: number }
      ).n;
      this.store.db.prepare("UPDATE attempts SET json=? WHERE id=?").run(
        encode({
          kind: p.mode === "INTRABAR_CROSS" ? "LIVE_TICK" : "LIVE_CLOSED_BAR",
          startedAt: now,
          version: p.version,
          approvedQuantity: plan.approvedQuantity,
          evidenceEpoch: config.evidenceEpoch,
          contextId: c.id,
          template: config.template,
          parentAttemptId: source?.attempt_id ?? null,
        }),
        plan.attemptId,
      );
      this.store.db
        .prepare(
          "INSERT INTO closed_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          plan.attemptId,
          planId,
          p.version,
          this.epoch,
          this.connectionEpoch,
          c.id,
          activationSeq,
          encode(config),
          encode(state),
          "[]",
          "RUNNING",
          now,
          null,
          source?.attempt_id ?? null,
          now,
        );
      return { ...activated, monitor: this.status(planId) };
    });
    this.syncSubscriptions();
    return result;
  }
  flush(): void {
    if (this.closed) return;
    this.drain();
    const now = this.now();
    if (now < this.lastClock) {
      this.disconnect("SERVER_CLOCK_REGRESSED");
      return;
    }
    this.lastClock = now;
    this.store.transaction(() => {
      for (const row of this.rows()) {
        const state = decode<AttemptState>(row.state_json);
        const p = this.store.plan(row.plan_id);
        if (state.consumed) {
          if (
            p.attemptId === row.attempt_id &&
            ["TAKEN", "SKIPPED"].includes(p.status) &&
            state.status !== p.status
          )
            this.accept(row, {
              type: "FEEDBACK",
              id: `feedback:${p.status}:${now}`,
              receivedAt: now,
              feedback: p.status as "TAKEN" | "SKIPPED",
            });
          continue;
        }
        if (
          row.phase !== "COMPLETE" &&
          p.attemptId === row.attempt_id &&
          p.version === row.plan_version &&
          !["WAIT_RETEST", "ARMED", "DATA_PAUSED"].includes(p.status)
        )
          this.accept(row, {
            type: "PAUSE",
            id: `external:pause:${now}`,
            receivedAt: now,
          });
        const mode = decode<AttemptConfig>(row.config_json).mode;
        if (
          (mode === "INTRABAR_CROSS"
            ? now >= state.deadline
            : now > state.deadline + 30_000) &&
          row.deadline_watermark === null
        )
          this.accept(this.row(row.attempt_id), {
            type: "CLOCK",
            id: `clock:${state.deadline}:${mode}`,
            receivedAt: now,
          });
      }
      if (this.connected)
        for (const s of this.store.db
          .prepare(
            "SELECT * FROM closed_streams WHERE connection_epoch=? AND healthy=1",
          )
          .all(this.connectionEpoch) as Stream[]) {
          const c = this.context(s.context_id);
          if (
            !["LIVE_CLOSED_BAR", "LIVE_TICK"].includes(
              assessCapability(c.capability, now).level,
            )
          )
            this.pauseStream(s, "LIVE_CAPABILITY_UNVERIFIED", now);
          else if (
            this.rows().some(
              (row) =>
                row.connection_epoch === s.connection_epoch &&
                row.context_id === s.context_id &&
                row.phase === "RUNNING" &&
                decode<AttemptConfig>(row.config_json).mode ===
                  "INTRABAR_CROSS",
            ) &&
            intrabarContractReason(c, now)
          )
            this.pauseStream(s, "TICK_PROTOCOL_EVIDENCE_UNVERIFIED", now);
          else if (
            s.through_at <
              Math.min(c.session.open + 60 * minute, c.session.close) &&
            now > s.through_at + minute + 30_000
          )
            this.pauseStream(s, "MISSING_MINUTE", now);
        }
    });
    this.syncSubscriptions();
  }
  startScheduler(intervalMs = 1000): void {
    if (this.timer) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10)
      throw new Error("INVALID_SCHEDULER_INTERVAL");
    this.timer = setInterval(() => {
      try {
        this.flush();
      } catch {
        /* Durable pending receipts are retried; no successful transition is claimed. */
      }
    }, intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.closed) return;
    try {
      this.disconnect("RUNTIME_STOPPED");
    } finally {
      // Storage failure must not leave the scheduler or provider alive. Preserve
      // the persistence error for the caller while always fencing this instance.
      this.closed = true;
      this.connected = false;
      this.opening = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.abort.abort();
      if (this.options.adapter)
        try {
          await withDeadline(
            () => this.options.adapter!.stop(),
            this.options.adapterTimeoutMs ?? 2000,
          );
        } catch {
          /* The runtime and all callbacks remain fenced after bounded shutdown. */
        }
    }
  }
}
