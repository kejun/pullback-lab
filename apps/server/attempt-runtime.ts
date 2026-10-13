import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { chaseRatio } from "../../packages/domain/plan-controls.js";
import type { Bar } from "../../packages/contracts/index.js";
import {
  createAttempt,
  reduceAttempt,
  type AttemptConfig,
  type AttemptInput,
  type AttemptState,
  type TriggerBar,
  type TriggerEvent,
} from "../../packages/domain/trigger.js";
import { ApiError, type Store } from "./store.js";
import { calculateIndicators } from "../../packages/domain/indicators.js";

/** No public route accepts these inputs: only installed synthetic fixtures enter this runtime. */
export type RuntimeInput = AttemptInput extends infer I
  ? I extends AttemptInput
    ? Omit<I, "ingestSeq">
    : never
  : never;
type Phase =
  "READY" | "RUNNING" | "COMPLETE" | "RECOVERY_PAUSED" | "DATA_PAUSED";
interface RuntimeRow {
  attempt_id: string;
  plan_id: string;
  plan_version: number;
  owner_epoch: string;
  phase: Phase;
  step: number;
  simulation_time: number;
  deadline_watermark: number | null;
  config_json: string;
  fixture_json: string;
  source_json: string;
  state_json: string;
  emitted_json: string;
  created_at: number;
}
export interface RuntimeProgress {
  synthetic: true;
  template: AttemptConfig["template"];
  activatedAt: number;
  recoveredFromAttemptId: string | null;
  attemptId: string;
  planId: string;
  planVersion: number;
  phase: Phase;
  step: number;
  totalSteps: number;
  inputCount: number;
  status: AttemptState["status"];
  reason: string | null;
  simulationTime: number;
  deadline: number;
  deadlineWatermark: number | null;
  lastInput: {
    id: string;
    type: string;
    ingestSeq: number;
    receivedAt: number;
  } | null;
  nextInput: { id: string; type: string; receivedAt: number } | null;
  eventTypes: string[];
}
export interface RuntimeCommand {
  expectedVersion: number;
  expectedAttemptId: string;
}
export interface RuntimeStepCommand extends RuntimeCommand {
  expectedStep: number;
  count?: number;
}
export interface RuntimeRecoveryCommand {
  expectedVersion: number;
  /** The current plan may have no attempt after an explicit version edit. */
  expectedAttemptId: string | null;
  sourceAttemptId: string;
  expectedStep: number;
}
interface RuntimeOptions {
  now?: () => number;
  epoch?: string;
  /** False only for another connection participating in the same running service or tests. */
  recover?: boolean;
}
const encode = (value: unknown) => JSON.stringify(value);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const frozen = <T>(value: string): T => JSON.parse(value) as T;
const active = (phase: Phase) => phase === "READY" || phase === "RUNNING";

/**
 * Durable, server-owned synthetic execution. A receipt, its reduction, checkpoint, events and
 * reservation effects commit under one BEGIN IMMEDIATE. This is not a live market ingress API.
 */
export class AttemptRuntime {
  private readonly now: () => number;
  private readonly epoch: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private readonly store: Store,
    options: RuntimeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.epoch = options.epoch ?? randomUUID();
    if (options.recover !== false) this.pauseInterrupted();
  }

  private assertOpen() {
    if (this.closed)
      throw new ApiError(503, "RUNTIME_CLOSED", "演练运行器已关闭");
  }
  private row(attemptId: string): RuntimeRow {
    const row = this.store.db
      .prepare("SELECT * FROM runtime_attempts WHERE attempt_id=?")
      .get(attemptId) as RuntimeRow | undefined;
    if (!row)
      throw new ApiError(404, "RUNTIME_NOT_STARTED", "请先准备分步演练");
    return row;
  }
  private validateCommand(
    planId: string,
    command: { expectedVersion: number; expectedAttemptId: string | null },
  ) {
    const plan = this.store.plan(planId);
    if (plan.version !== command.expectedVersion)
      throw new ApiError(
        409,
        "PLAN_VERSION_CONFLICT",
        "计划版本已改变，请重新读取",
      );
    if (plan.attemptId !== command.expectedAttemptId)
      throw new ApiError(409, "ATTEMPT_CONFLICT", "观察尝试已改变，请重新读取");
    return plan;
  }
  private sessionAttempts(planId: string, sessionDate: string) {
    return this.store.db
      .prepare(
        `SELECT a.id,a.plan_version,a.consumed FROM attempts a
       JOIN plan_versions v ON v.plan_id=a.plan_id AND v.version=a.plan_version
       WHERE a.plan_id=? AND json_extract(v.json,'$.sessionDate')=?
       ORDER BY a.rowid DESC`,
      )
      .all(planId, sessionDate) as {
      id: string;
      plan_version: number;
      consumed: number;
    }[];
  }
  status(planId: string): RuntimeProgress | null {
    const plan = this.store.plan(planId);
    // A version edit clears the live attempt pointer, but keeps its recovery source visible.
    const attemptId =
      plan.attemptId ?? this.sessionAttempts(plan.id, plan.sessionDate)[0]?.id;
    if (!attemptId) return null;
    const row = this.store.db
      .prepare("SELECT * FROM runtime_attempts WHERE attempt_id=?")
      .get(attemptId) as RuntimeRow | undefined;
    return row ? this.progress(row) : null;
  }
  private progress(row: RuntimeRow): RuntimeProgress {
    const state = frozen<AttemptState>(row.state_json);
    const config = frozen<AttemptConfig>(row.config_json);
    const source = frozen<{ recovery?: { fromAttemptId: string } }>(
      row.source_json,
    );
    const fixture = frozen<RuntimeInput[]>(row.fixture_json);
    const receipt = this.store.db
      .prepare(
        "SELECT input_json FROM runtime_inputs WHERE attempt_id=? ORDER BY ingest_seq DESC LIMIT 1",
      )
      .get(row.attempt_id) as { input_json: string } | undefined;
    const last = receipt ? frozen<AttemptInput>(receipt.input_json) : null;
    const next = fixture[row.step];
    return {
      synthetic: true,
      template: config.template,
      activatedAt: config.activatedAt,
      recoveredFromAttemptId: source.recovery?.fromAttemptId ?? null,
      attemptId: row.attempt_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      phase: row.phase,
      step: row.step,
      totalSteps: fixture.length,
      inputCount: Math.max(state.lastIngestSeq, 0),
      status: state.status,
      reason: state.reason,
      simulationTime: row.simulation_time,
      deadline: state.deadline,
      deadlineWatermark: row.deadline_watermark,
      lastInput: last
        ? {
            id: last.id,
            type: last.type,
            ingestSeq: last.ingestSeq,
            receivedAt: last.receivedAt,
          }
        : null,
      nextInput:
        active(row.phase) && next
          ? { id: next.id, type: next.type, receivedAt: next.receivedAt }
          : null,
      eventTypes: frozen<TriggerEvent[]>(row.emitted_json).map(
        (event) => event.type,
      ),
    };
  }

  start(planId: string, command: RuntimeCommand): RuntimeProgress {
    this.assertOpen();
    return this.store.transaction(() => {
      const plan = this.validateCommand(planId, command);
      if (
        !plan.instrumentId.startsWith("DEMO-") ||
        plan.mode !== "CLOSE_CONFIRM"
      )
        throw new ApiError(
          422,
          "SYNTHETIC_ONLY",
          "分步入口只接受合成收盘确认演练",
        );
      const existing = this.status(planId);
      if (existing) return existing;
      if (!plan.attemptId || !["WAIT_RETEST", "ARMED"].includes(plan.status))
        throw new ApiError(
          409,
          "ATTEMPT_INACTIVE",
          "请显式启用新的合成观察尝试",
        );
      if (
        this.store
          .eventsForAttempt(plan.attemptId)
          .some((event) => event.type === "TECHNICAL_TRIGGERED")
      )
        throw new ApiError(
          409,
          "ATTEMPT_CONSUMED",
          "该尝试已由快速回放消费，请建立新尝试",
        );
      const prior = this.sessionAttempts(plan.id, plan.sessionDate).find(
        (attempt) => attempt.id !== plan.attemptId,
      );
      if (prior) {
        const hasWatermark = this.store.db
          .prepare("SELECT 1 FROM runtime_attempts WHERE attempt_id=?")
          .get(prior.id);
        throw new ApiError(
          409,
          hasWatermark ? "RECOVERY_REQUIRED" : "RECOVERY_WATERMARK_MISSING",
          hasWatermark
            ? "本交易日已有观察尝试，请从已保存水位显式恢复"
            : "本交易日旧尝试没有可验证水位，不能从开盘重新演练",
        );
      }
      const now = this.now();
      const reasons = this.store.supportRevisionReasons(plan, now);
      if (reasons.length || !plan.supportSnapshot?.ready)
        throw new ApiError(
          422,
          reasons[0] ?? "SUPPORT_NOT_READY",
          "支撑依据缺失或改变，请核对后保存新版本",
        );
      const version = this.store.planVersion(plan);
      const oneMinute = this.store.bars(plan.instrumentId, "1m");
      const fiveMinute = this.store.bars(plan.instrumentId, "5m");
      const daily = this.store
        .bars(plan.instrumentId, "1D")
        .filter(
          (bar) =>
            bar.final &&
            bar.receivedAt <= now &&
            new Date(bar.time * 1000).toISOString().slice(0, 10) <
              plan.sessionDate,
        );
      if (
        !oneMinute.length ||
        !fiveMinute.length ||
        !daily.length ||
        !version.previousDailyBar
      )
        throw new ApiError(422, "FIXTURE_MISSING", "请载入完整合成数据");
      if (
        ![...oneMinute, ...fiveMinute, ...daily].every(
          (bar) =>
            bar.id.startsWith("synthetic:") &&
            (bar as Bar & { synthetic?: boolean }).synthetic === true,
        )
      )
        throw new ApiError(
          422,
          "SYNTHETIC_ONLY",
          "演练序列必须来自明确合成数据",
        );
      const open = oneMinute[0].time * 1000;
      if (new Date(open).toISOString().slice(0, 10) !== plan.sessionDate)
        throw new ApiError(
          422,
          "FIXTURE_SESSION_MISMATCH",
          "计划交易日与已安装合成序列不符",
        );
      const config: AttemptConfig = {
        attemptId: plan.attemptId,
        planId: plan.id,
        planVersion: plan.version,
        sessionId: `synthetic:${plan.instrumentId}:${plan.sessionDate}`,
        sessionOpenAt: open,
        activatedAt: open - 1,
        mode: version.mode,
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
        tick: version.instrument.tick,
        previousDayClose: version.previousDailyBar.close,
        evidenceEpoch: `synthetic:${plan.attemptId}`,
        template: "SESSION_FIRST",
        preActivationEvidence: "NO_TOUCH",
      };
      const convert = (bar: Bar, period: "1m" | "5m"): TriggerBar => ({
        id: bar.id,
        sessionId: config.sessionId,
        period,
        start: bar.time * 1000,
        end: bar.time * 1000 + (period === "1m" ? 60_000 : 300_000),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        final: bar.final,
        revision: bar.adjustmentVersion,
        receivedAt: bar.receivedAt,
      });
      const candidates = [
        ...oneMinute
          .filter((bar) => bar.time * 1000 < open + 15 * 60_000)
          .map((bar) => convert(bar, "1m")),
        ...fiveMinute
          .filter(
            (bar) =>
              bar.time * 1000 >= open + 15 * 60_000 &&
              bar.time * 1000 < open + 60 * 60_000,
          )
          .map((bar) => convert(bar, "5m")),
      ];
      const fixture: RuntimeInput[] = [];
      for (const bar of candidates) {
        const source = bar.period === "1m" ? oneMinute : fiveMinute;
        const prior = source.find(
          (value) =>
            value.time * 1000 + (bar.period === "1m" ? 60_000 : 300_000) ===
            bar.start,
        );
        if (prior)
          fixture.push({
            type: "REFERENCE",
            id: `synthetic:ref:${bar.id}`,
            receivedAt: prior.receivedAt,
            candidate: { start: bar.start, end: bar.end, period: bar.period },
            bar: convert(prior, bar.period),
          });
        fixture.push({
          type: "BAR",
          id: `synthetic:bar:${bar.id}`,
          receivedAt: bar.receivedAt,
          bar,
        });
      }
      this.store.db
        .prepare(
          "INSERT INTO runtime_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          plan.attemptId,
          plan.id,
          plan.version,
          this.epoch,
          "READY",
          0,
          open - 1,
          null,
          encode(config),
          encode(fixture),
          encode({ daily, oneMinute, fiveMinute }),
          encode(createAttempt(config)),
          "[]",
          now,
        );
      return this.progress(this.row(plan.attemptId));
    });
  }

  /** Explicit recovery starts a new identity; no old reduction or input is replayed. */
  recover(planId: string, command: RuntimeRecoveryCommand): RuntimeProgress {
    this.assertOpen();
    if (!Number.isSafeInteger(command.expectedStep) || command.expectedStep < 0)
      throw new ApiError(422, "INVALID_RUNTIME_STEP", "恢复水位必须为非负整数");
    return this.store.transaction(() => {
      const current = this.validateCommand(planId, command);
      if (
        !current.instrumentId.startsWith("DEMO-") ||
        current.mode !== "CLOSE_CONFIRM"
      )
        throw new ApiError(
          422,
          "SYNTHETIC_ONLY",
          "恢复入口只接受合成收盘确认演练",
        );
      const latest = this.sessionAttempts(planId, current.sessionDate)[0];
      if (!latest || latest.id !== command.sourceAttemptId)
        throw new ApiError(
          409,
          "RECOVERY_SOURCE_CONFLICT",
          "恢复来源已改变，请重新读取",
        );
      const source = this.store.db
        .prepare("SELECT * FROM runtime_attempts WHERE attempt_id=?")
        .get(command.sourceAttemptId) as RuntimeRow | undefined;
      if (!source)
        throw new ApiError(
          409,
          "RECOVERY_WATERMARK_MISSING",
          "旧尝试没有可验证水位，不能从开盘重新演练",
        );
      if (source.step !== command.expectedStep)
        throw new ApiError(
          409,
          "RUNTIME_STEP_CONFLICT",
          "演练进度已改变，请重新读取",
        );
      const previous = frozen<AttemptState>(source.state_json);
      if (
        latest.consumed ||
        previous.consumed ||
        current.status === "TRIGGERED" ||
        this.store
          .reservations()
          .some(
            (reservation) =>
              reservation.planId === planId &&
              reservation.state === "TAKEN_PENDING",
          )
      )
        throw new ApiError(
          409,
          "ATTEMPT_CONSUMED",
          "旧尝试已消费或交易尚待核对，不能通过恢复重复入场",
        );
      if (
        !["USER_PAUSED", "DATA_PAUSED"].includes(current.status) &&
        !(
          current.status === "DRAFT" &&
          current.attemptId === null &&
          current.version > source.plan_version
        )
      )
        throw new ApiError(
          409,
          "RECOVERY_NOT_PAUSED",
          "请先暂停当前观察，再显式恢复",
        );
      const oldConfig = frozen<AttemptConfig>(source.config_json);
      if (
        oldConfig.sessionId !==
        `synthetic:${current.instrumentId}:${current.sessionDate}`
      )
        throw new ApiError(
          409,
          "RECOVERY_SESSION_MISMATCH",
          "恢复来源与当前证券或交易日不符",
        );
      const watermark = source.simulation_time;
      if (!Number.isSafeInteger(watermark) || watermark < oldConfig.activatedAt)
        throw new ApiError(
          409,
          "RECOVERY_WATERMARK_MISSING",
          "旧尝试水位无效，不能恢复",
        );
      if (
        watermark >=
        Math.min(
          oldConfig.sessionOpenAt + 60 * 60_000,
          oldConfig.sessionCloseAt ?? Infinity,
        )
      )
        throw new ApiError(
          409,
          "RECOVERY_OUTSIDE_FIRST_HOUR",
          "已超过首小时，不能重新建立恢复观察",
        );
      const fixture = frozen<RuntimeInput[]>(source.fixture_json).filter(
        (input) => this.afterWatermark(input, watermark),
      );
      if (!fixture.some((input) => input.type === "BAR"))
        throw new ApiError(
          409,
          "RECOVERY_INPUTS_EXHAUSTED",
          "水位之后没有完整的新合成行情，不能恢复",
        );
      if (!current.backgroundConfirmed || !current.reason.trim())
        throw new ApiError(
          422,
          "BACKGROUND_UNCONFIRMED",
          "请确认日线背景并填写关注理由",
        );
      if (!this.store.screeningSettings().current)
        throw new ApiError(
          422,
          "RULES_UNCONFIRMED",
          "请先在设置中确认 C 类工程筛选预设",
        );
      const daily = this.store.bars(current.instrumentId, "1D");
      if (!calculateIndicators(daily).screeningReady || !daily.at(-1))
        throw new ApiError(
          422,
          "DAILY_HISTORY_INCOMPLETE",
          "日线预热或完整性不足",
        );
      const now = this.now();
      const { plan } = this.store.activate(
        planId,
        command.expectedVersion,
        now,
        {
          recovery: true,
          expectedAttemptId: command.expectedAttemptId,
          sourceAttemptId: command.sourceAttemptId,
        },
      );
      const version = this.store.planVersion(plan);
      // Recovery uses the newly activated immutable plan version, including an explicit disable.
      const { chaseFromLowMax: priorChaseLimit, ...baseConfig } = oldConfig;
      const config: AttemptConfig = {
        ...baseConfig,
        attemptId: plan.attemptId!,
        planVersion: plan.version,
        activatedAt: watermark,
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
        tick: version.instrument.tick,
        previousDayClose:
          version.previousDailyBar?.close ?? oldConfig.previousDayClose,
        evidenceEpoch: `synthetic:${randomUUID()}`,
        template: "RECOVERY",
        preActivationEvidence: "UNKNOWN",
      };
      this.store.db
        .prepare(
          "INSERT INTO runtime_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          plan.attemptId,
          plan.id,
          plan.version,
          this.epoch,
          "READY",
          0,
          watermark,
          null,
          encode(config),
          encode(fixture),
          encode({
            ...frozen<Record<string, unknown>>(source.source_json),
            recovery: {
              fromAttemptId: source.attempt_id,
              watermark,
              planVersion: version,
              sourceBarsRole: "ORIGINAL_SYNTHETIC_FIXTURE",
            },
          }),
          encode(createAttempt(config)),
          "[]",
          now,
        );
      return this.progress(this.row(plan.attemptId!));
    });
  }

  private afterWatermark(input: RuntimeInput, watermark: number): boolean {
    if (input.receivedAt <= watermark) return false;
    if (input.type === "BAR") return input.bar.start > watermark;
    if (input.type === "REFERENCE")
      return input.bar.start > watermark && input.candidate.start > watermark;
    return false;
  }

  private snapshot(
    row: RuntimeRow,
    state: AttemptState,
    emitted: TriggerEvent[],
  ) {
    const inputs = (
      this.store.db
        .prepare(
          "SELECT input_json FROM runtime_inputs WHERE attempt_id=? ORDER BY ingest_seq",
        )
        .all(row.attempt_id) as { input_json: string }[]
    ).map((input) => frozen<AttemptInput>(input.input_json));
    return {
      algorithmVersion: "pullback-c01-c07-v1",
      runtimeVersion: "synthetic-step-v1",
      synthetic: true,
      config: frozen<AttemptConfig>(row.config_json),
      inputs,
      state,
      emitted,
      sourceBars: frozen<Record<string, unknown>>(row.source_json),
      simulationOnly: true,
      liveCapability: "UNKNOWN",
      simulationRiskTime: this.now(),
    };
  }

  /** Internal server boundary. Never expose this method as a client-supplied input route. */
  ingest(attemptId: string, raw: RuntimeInput): RuntimeProgress {
    this.assertOpen();
    let conflict = false;
    const progress = this.store.transaction(() => {
      const row = this.row(attemptId);
      const payloadHash = hash(canonical(raw));
      const duplicate = this.store.db
        .prepare(
          "SELECT payload_hash FROM runtime_inputs WHERE attempt_id=? AND input_id=?",
        )
        .get(attemptId, raw.id) as { payload_hash: string } | undefined;
      if (duplicate) {
        if (duplicate.payload_hash === payloadHash) return this.progress(row);
        conflict = true;
        if (active(row.phase) || row.phase === "COMPLETE") {
          this.accept(row, {
            type: "DATA_GAP",
            id: `synthetic:conflict:${raw.id}:${payloadHash}`,
            receivedAt: row.simulation_time,
            reason: "DUPLICATE_INPUT_CONFLICT",
          });
          this.store.db
            .prepare(
              "UPDATE runtime_attempts SET phase='DATA_PAUSED' WHERE attempt_id=?",
            )
            .run(attemptId);
        }
        return this.progress(this.row(attemptId));
      }
      if (!active(row.phase))
        throw new ApiError(
          409,
          "RUNTIME_PAUSED",
          "该演练已结束或暂停，请显式建立新尝试",
        );
      this.accept(row, raw);
      return this.progress(this.row(attemptId));
    });
    if (conflict)
      throw new ApiError(
        409,
        "DUPLICATE_INPUT_CONFLICT",
        "同一输入标识对应不同内容，尝试已暂停",
      );
    return progress;
  }

  /** Caller holds the immediate transaction; state and side effects must never be committed separately. */
  private accept(row: RuntimeRow, raw: RuntimeInput): void {
    const config = frozen<AttemptConfig>(row.config_json);
    const previous = frozen<AttemptState>(row.state_json);
    if (
      config.template === "RECOVERY" &&
      (raw.type === "BAR" || raw.type === "REFERENCE") &&
      !this.afterWatermark(raw, config.activatedAt)
    )
      throw new ApiError(
        409,
        "RECOVERY_INPUT_BEFORE_WATERMARK",
        "恢复只能接受旧水位之后完整的新行情",
      );
    const plan = this.store.plan(row.plan_id);
    if (plan.attemptId !== row.attempt_id || plan.version !== row.plan_version)
      throw new ApiError(409, "ATTEMPT_CONFLICT", "冻结尝试已被新版本替代");
    if (
      (raw.type === "BAR" || raw.type === "REFERENCE") &&
      !previous.consumed &&
      !["WAIT_RETEST", "ARMED"].includes(plan.status) &&
      !(
        plan.status === "EXPIRED" &&
        previous.status === "EXPIRED" &&
        previous.expiredByClock
      )
    )
      throw new ApiError(
        409,
        "ATTEMPT_INACTIVE",
        "计划已暂停，不能继续接受行情",
      );
    if (
      !raw.id.startsWith("synthetic:") ||
      raw.type === "TICK" ||
      (raw.type === "BAR" && !raw.bar.id.startsWith("synthetic:"))
    )
      throw new ApiError(
        422,
        "SYNTHETIC_ONLY",
        "运行器不接受真实行情或逐笔输入",
      );
    const now = this.now();
    const input = {
      ...structuredClone(raw),
      ingestSeq: Math.max(previous.lastIngestSeq, 0) + 1,
    } as AttemptInput;
    if (input.type === "BAR") {
      const risk = this.store.replayRisk(plan, now, input.bar.close, {
        quoteAt: input.bar.end,
        receivedAt: input.receivedAt,
        sessionOpenAt: config.sessionOpenAt,
      });
      const priorBars = (
        this.store.db
          .prepare(
            "SELECT input_json FROM runtime_inputs WHERE attempt_id=? ORDER BY ingest_seq",
          )
          .all(row.attempt_id) as { input_json: string }[]
      )
        .map((value) => frozen<AttemptInput>(value.input_json))
        .filter(
          (value): value is Extract<AttemptInput, { type: "BAR" }> =>
            value.type === "BAR",
        );
      const low = Decimal.min(
        input.bar.low,
        ...priorBars.map((value) => value.bar.low),
      ).toFixed();
      input.gates = {
        capability: "UNKNOWN",
        dataHealthy: true,
        historical: true,
        quote: { price: input.bar.close, at: input.bar.end },
        risk: {
          status: risk.passed ? "PASS" : "BLOCKED",
          reasons: risk.reasons,
          quantity: risk.quantity,
        },
        lod: {
          price: low,
          from:
            config.template === "RECOVERY"
              ? config.activatedAt
              : config.sessionOpenAt,
          through: input.bar.end,
          // Recovery has only the new attempt's observations, not a verified whole-session low.
          complete: config.template !== "RECOVERY",
        },
      };
    }
    const reduced = reduceAttempt(previous, input, config);
    const emitted = [
      ...frozen<TriggerEvent[]>(row.emitted_json),
      ...reduced.events,
    ];
    const inputJson = encode(input);
    this.store.db
      .prepare("INSERT INTO runtime_inputs VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        row.attempt_id,
        input.ingestSeq,
        input.id,
        hash(canonical(raw)),
        hash(inputJson),
        inputJson,
        encode(reduced.state),
        encode(reduced.events),
        now,
      );
    const snapshot = this.snapshot(row, reduced.state, emitted);
    const technical = reduced.events.find(
      (event) => event.type === "TECHNICAL_TRIGGERED",
    );
    if (
      technical &&
      input.type === "BAR" &&
      reduced.state.status !== "EXPIRED"
    ) {
      const assessment = reduced.events.find(
        (event) => event.type === "HISTORICAL_TRIGGERED",
      );
      const checks = assessment?.snapshot.checks as
        Record<string, { status: string; reasons: string[] }> | undefined;
      const reasons = Object.entries(checks ?? {})
        .filter(([name]) => name !== "capability")
        .flatMap(([, check]) => check.reasons);
      this.store.commitTechnical(
        plan.id,
        plan.version,
        row.attempt_id,
        {
          entry: input.bar.close,
          time: technical.time,
          receivedAt: input.receivedAt,
          refId: reduced.state.reference?.barId ?? "",
          historical: true,
          reasons,
          snapshot,
          simulationClock: {
            quoteAt: input.bar.end,
            receivedAt: input.receivedAt,
            sessionOpenAt: config.sessionOpenAt,
          },
        },
        now,
      );
    }
    this.store.commitRuntimeTransition(
      plan.id,
      plan.version,
      row.attempt_id,
      reduced.state,
      reduced.events,
      snapshot,
      now,
    );
    this.store.db
      .prepare(
        "UPDATE runtime_attempts SET state_json=?,emitted_json=?,simulation_time=?,deadline_watermark=?,phase=? WHERE attempt_id=?",
      )
      .run(
        encode(reduced.state),
        encode(emitted),
        Math.max(row.simulation_time, input.receivedAt),
        input.type === "CLOCK" ? input.receivedAt : row.deadline_watermark,
        reduced.state.status === "DATA_PAUSED" ? "DATA_PAUSED" : "RUNNING",
        row.attempt_id,
      );
  }

  private dueClock(row: RuntimeRow, through: number): boolean {
    const state = frozen<AttemptState>(row.state_json);
    const config = frozen<AttemptConfig>(row.config_json);
    const due = state.deadline + (config.referenceGraceMs ?? 30_000) + 1;
    if (
      state.consumed ||
      !["WAIT_RETEST", "ARMED"].includes(state.status) ||
      through < due ||
      (row.deadline_watermark !== null && row.deadline_watermark >= due)
    )
      return false;
    this.accept(row, {
      type: "CLOCK",
      id: `synthetic:clock:${due}`,
      receivedAt: due,
    });
    return true;
  }

  step(planId: string, command: RuntimeStepCommand): RuntimeProgress {
    this.assertOpen();
    if (
      !Number.isSafeInteger(command.expectedStep) ||
      !Number.isSafeInteger(command.count ?? 1) ||
      (command.count ?? 1) < 1 ||
      (command.count ?? 1) > 20
    )
      throw new ApiError(
        422,
        "INVALID_RUNTIME_STEP",
        "步数必须为 1 至 20 的整数",
      );
    let result!: RuntimeProgress;
    // Each fixture receipt has its own atomic commit, including a deadline CLOCK if due.
    for (let index = 0; index < (command.count ?? 1); index++) {
      result = this.store.transaction(() => {
        const plan = this.validateCommand(planId, command);
        let row = this.row(command.expectedAttemptId);
        if (row.step !== command.expectedStep + index)
          throw new ApiError(
            409,
            "RUNTIME_STEP_CONFLICT",
            "演练进度已改变，请重新读取",
          );
        if (!active(row.phase))
          throw new ApiError(
            409,
            "RUNTIME_PAUSED",
            "该演练已结束或暂停，请显式建立新尝试",
          );
        const state = frozen<AttemptState>(row.state_json);
        const revision = this.store.supportRevisionReasons(plan, this.now());
        if (
          (!state.consumed &&
            !["WAIT_RETEST", "ARMED"].includes(plan.status) &&
            !(
              plan.status === "EXPIRED" &&
              state.status === "EXPIRED" &&
              state.expiredByClock
            )) ||
          revision.length
        ) {
          this.accept(row, {
            type: "DATA_GAP",
            id: `synthetic:paused:${row.step}`,
            receivedAt: row.simulation_time,
            reason: revision[0] ?? "PLAN_NO_LONGER_ACTIVE",
          });
          this.store.db
            .prepare(
              "UPDATE runtime_attempts SET phase='DATA_PAUSED' WHERE attempt_id=?",
            )
            .run(row.attempt_id);
          return this.progress(this.row(row.attempt_id));
        }
        const fixture = frozen<RuntimeInput[]>(row.fixture_json);
        const next = fixture[row.step];
        if (!next)
          throw new ApiError(409, "RUNTIME_COMPLETE", "合成序列已完成");
        if (this.dueClock(row, next.receivedAt)) row = this.row(row.attempt_id);
        this.accept(row, next);
        this.store.db
          .prepare("UPDATE runtime_attempts SET step=step+1 WHERE attempt_id=?")
          .run(row.attempt_id);
        row = this.row(row.attempt_id);
        if (row.step === fixture.length) {
          this.dueClock(
            row,
            frozen<AttemptState>(row.state_json).deadline + 30_001,
          );
          this.store.db
            .prepare(
              "UPDATE runtime_attempts SET phase=CASE WHEN phase='DATA_PAUSED' THEN phase ELSE 'COMPLETE' END WHERE attempt_id=?",
            )
            .run(row.attempt_id);
        }
        return this.progress(this.row(row.attempt_id));
      });
      if (!active(result.phase)) break;
    }
    return result;
  }

  /** No wall clock advances historical fixtures. Only persisted explicit simulation time is eligible. */
  flushDueClocks(): void {
    if (this.closed) return;
    this.store.transaction(() => {
      const rows = this.store.db
        .prepare(
          "SELECT * FROM runtime_attempts WHERE phase IN ('READY','RUNNING')",
        )
        .all() as RuntimeRow[];
      for (const row of rows) this.dueClock(row, row.simulation_time);
    });
  }
  startScheduler(intervalMs = 1_000): void {
    this.assertOpen();
    if (this.timer) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10)
      throw new Error("INVALID_SCHEDULER_INTERVAL");
    this.timer = setInterval(() => {
      // A failed write rolls back; a later explicit step retries. Never manufacture receipt progress.
      try {
        this.flushDueClocks();
      } catch {
        /* SQLite errors leave the persisted watermark unchanged. */
      }
    }, intervalMs);
    this.timer.unref();
  }
  private pauseInterrupted(): void {
    this.store.transaction(() => {
      const rows = this.store.db
        .prepare(
          "SELECT * FROM runtime_attempts WHERE phase IN ('READY','RUNNING') AND owner_epoch<>?",
        )
        .all(this.epoch) as RuntimeRow[];
      for (const row of rows) {
        const plan = this.store.plan(row.plan_id);
        if (
          plan.attemptId === row.attempt_id &&
          plan.version === row.plan_version
        )
          this.accept(row, {
            type: "DATA_GAP",
            id: `synthetic:recovery:${this.epoch}`,
            receivedAt: row.simulation_time,
            reason: "RUNTIME_RESTARTED",
          });
        this.store.db
          .prepare(
            "UPDATE runtime_attempts SET phase='RECOVERY_PAUSED',owner_epoch=? WHERE attempt_id=?",
          )
          .run(this.epoch, row.attempt_id);
      }
    });
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
