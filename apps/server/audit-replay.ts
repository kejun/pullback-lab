import { calculateClosedRisk, type ClosedRiskInput } from "./closed-risk.js";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { chaseRatio } from "../../packages/domain/plan-controls.js";
import { z } from "zod";
import {
  createAttempt,
  reduceAttempt,
  type AttemptConfig,
  type AttemptInput,
  type AttemptState,
  type TriggerEvent,
} from "../../packages/domain/trigger.js";
import { solveRisk } from "../../packages/domain/risk.js";
import type {
  Funds,
  FeeSchedule,
  PlanInput,
  Instrument,
  RiskResult,
} from "../../packages/contracts/index.js";

export const AUDIT_ALGORITHM_VERSION = "pullback-c01-c07-v1";
export interface AuditCheck {
  name: string;
  status: "PASS" | "FAIL" | "UNSUPPORTED";
  detail: string;
}
export interface AuditSummary {
  status: string | null;
  eventTypes: string[];
  quantity: number | null;
}
export interface AuditReplayResult {
  status: "MATCH" | "MISMATCH" | "UNSUPPORTED";
  checks: AuditCheck[];
  reasons: string[];
  original: AuditSummary;
  replayed: AuditSummary | null;
  inputHash: string;
  algorithmVersion: string | null;
  coverage: {
    trigger: "VERIFIED" | "NOT_VERIFIED";
    /** RECOMPUTED covers the final archived risk result, not the funding source of every earlier gate. */
    risk: "FROZEN_GATE_ONLY" | "RECOMPUTED" | "NOT_VERIFIED";
    scope: "PERSISTED_INPUTS_ONLY";
  };
}
export interface AuditReplayInput {
  snapshot: Record<string, unknown>;
  expectedInputHash: string;
  /** Pass the exact decision_inputs.json value so whitespace and key order remain covered by its hash. */
  serializedInput?: string;
}
const integer = z.number().int().safe();
const decimal = z.string().refine((v) => {
  try {
    return new Decimal(v).isFinite();
  } catch {
    return false;
  }
});
const windowSchema = z
  .object({ start: integer, end: integer, period: z.enum(["1m", "5m"]) })
  .passthrough();
const barSchema = windowSchema.extend({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  open: decimal,
  high: decimal,
  low: decimal,
  close: decimal,
  final: z.boolean(),
  revision: z.string(),
  receivedAt: integer,
});
const gatesSchema = z
  .object({
    capability: z.enum([
      "LIVE_CLOSED_BAR",
      "LIVE_TICK",
      "DELAYED",
      "EOD_ONLY",
      "UNKNOWN",
    ]),
    dataHealthy: z.boolean(),
    quote: z.object({ price: decimal, at: integer }).optional(),
    risk: z.object({
      status: z.enum(["PASS", "BLOCKED", "UNAVAILABLE"]),
      reasons: z.array(z.string()),
      quantity: integer,
    }),
    lod: z
      .object({
        price: decimal,
        from: integer,
        through: integer,
        complete: z.boolean(),
      })
      .optional(),
    historical: z.boolean().optional(),
  })
  .passthrough();
const envelope = z.object({
  id: z.string().min(1),
  receivedAt: integer,
  ingestSeq: integer.positive(),
});
const inputSchema = z.discriminatedUnion("type", [
  envelope
    .extend({
      type: z.literal("REFERENCE"),
      candidate: windowSchema,
      bar: barSchema,
    })
    .passthrough(),
  envelope
    .extend({
      type: z.literal("BAR"),
      bar: barSchema,
      gates: gatesSchema.optional(),
    })
    .passthrough(),
  envelope
    .extend({
      type: z.literal("TICK"),
      tick: z.object({
        price: decimal,
        at: integer,
        sessionId: z.string(),
        evidenceEpoch: z.string(),
        sequence: z.string().nullable(),
        previousSequence: z.string().nullable(),
        orderVerified: z.boolean(),
        continuityVerified: z.boolean(),
      }),
      gates: gatesSchema.optional(),
    })
    .passthrough(),
  envelope.extend({ type: z.literal("CLOCK") }).passthrough(),
  envelope
    .extend({ type: z.literal("DATA_GAP"), reason: z.string() })
    .passthrough(),
  envelope
    .extend({
      type: z.literal("REFERENCE_REVISED"),
      refBarId: z.string(),
      revision: z.string(),
    })
    .passthrough(),
  envelope
    .extend({ type: z.literal("VERSION_CHANGED"), reason: z.string() })
    .passthrough(),
  envelope.extend({ type: z.literal("PAUSE") }).passthrough(),
  envelope
    .extend({
      type: z.literal("FEEDBACK"),
      feedback: z.enum(["TAKEN", "SKIPPED"]),
    })
    .passthrough(),
]);
const configSchema = z
  .object({
    attemptId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: integer.positive(),
    sessionId: z.string().min(1),
    sessionOpenAt: integer,
    sessionCloseAt: integer.optional(),
    activatedAt: integer,
    mode: z.enum(["CLOSE_CONFIRM", "INTRABAR_CROSS"]),
    lower: decimal,
    upper: decimal,
    stop: decimal,
    entryMin: decimal,
    entryMax: decimal,
    tick: decimal,
    previousDayClose: decimal,
    evidenceEpoch: z.string().min(1),
    template: z.enum(["SESSION_FIRST", "RECOVERY"]),
    preActivationEvidence: z.enum(["NO_TOUCH", "TOUCHED", "UNKNOWN"]),
    chaseFromLowMax: decimal.optional(),
    referenceGraceMs: integer.optional(),
    quoteMaxAgeMs: integer.optional(),
    priceBands: z.array(z.object({ from: decimal, tick: decimal })).optional(),
  })
  .passthrough();
const currencyValues = z.object({ USD: decimal, CNY: decimal });
const fundsSchema = z
  .object({
    generation: integer.nonnegative(),
    nav: decimal,
    baseCurrency: z.enum(["USD", "CNY"]),
    cash: currencyValues,
    existing: z.record(z.string(), decimal),
    riskBudget: decimal,
    riskPool: decimal,
    maxWeight: decimal,
    fx: currencyValues,
    fxAsOf: integer,
    confirmedAt: integer,
    stale: z.boolean(),
    buyFee: decimal,
    sellFee: decimal,
    slippageIn: decimal,
    slippageOut: decimal,
    feesConfirmed: z.boolean(),
  })
  .passthrough();
const instrumentSchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    name: z.string(),
    market: z.enum(["US", "CN"]),
    currency: z.enum(["USD", "CNY"]),
    tick: decimal,
    qMin: integer,
    qStep: integer,
    sellSameDay: z.boolean(),
    rulesVerified: z.boolean(),
  })
  .passthrough();
const riskResultSchema = z
  .object({
    quantity: integer,
    entry: decimal,
    stopExec: decimal,
    cashUse: decimal,
    riskBase: decimal,
    exposureBase: decimal,
    reasons: z.array(z.string()),
    passed: z.boolean(),
  })
  .passthrough();
const riskSnapshotSchema = z
  .object({
    synthetic: z.literal(true),
    plan: z
      .object({
        id: z.string(),
        instrumentId: z.string(),
        entryMin: decimal,
        entryMax: decimal,
        stop: decimal,
        approvedQuantity: integer,
      })
      .passthrough(),
    planVersion: z.object({ instrument: instrumentSchema }).passthrough(),
    funds: fundsSchema,
    scenarioFunds: fundsSchema,
    simulationClock: z.object({
      quoteAt: integer,
      receivedAt: integer,
      sessionOpenAt: integer,
    }),
    reservations: z.array(
      z
        .object({
          planId: z.string(),
          instrumentId: z.string(),
          currency: z.enum(["USD", "CNY"]),
          cash: decimal,
          riskBase: decimal,
          exposureBase: decimal,
          state: z.enum(["ACTIVE", "TAKEN_PENDING", "RELEASED"]),
        })
        .passthrough(),
    ),
    decisionTime: integer,
    risk: riskResultSchema,
  })
  .passthrough();
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** Compare JSON values, preserving array/input/event order but ignoring object insertion order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v))
    return `{${Object.keys(v)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(v[key])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
function summary(snapshot: Record<string, unknown>): AuditSummary {
  const state = object(snapshot.state) ? snapshot.state : {};
  const events = Array.isArray(snapshot.emitted)
    ? snapshot.emitted.filter(object)
    : [];
  const quantity = object(snapshot.risk)
    ? snapshot.risk.quantity
    : events.toReversed().find((e) => typeof e.quantity === "number")?.quantity;
  return {
    status: typeof state.status === "string" ? state.status : null,
    eventTypes: events.flatMap((event) =>
      typeof event.type === "string" ? [event.type] : [],
    ),
    quantity:
      typeof quantity === "number" && Number.isSafeInteger(quantity)
        ? quantity
        : null,
  };
}

/**
 * Audit only persisted facts. This module has no Store, network, clock, event writer or notification dependency.
 * MATCH describes deterministic replay of the archived kernel inputs; it does not validate provider truth,
 * grant live capability, send an alert, or reconstruct source funding for earlier frozen risk gates.
 */
export function auditDecisionInput(input: AuditReplayInput): AuditReplayResult {
  const suppliedSnapshot = object(input.snapshot) ? input.snapshot : {};
  const result: AuditReplayResult = {
    status: "UNSUPPORTED",
    checks: [],
    reasons: [],
    original: summary(suppliedSnapshot),
    replayed: null,
    inputHash: input.expectedInputHash,
    algorithmVersion:
      typeof suppliedSnapshot.algorithmVersion === "string"
        ? suppliedSnapshot.algorithmVersion
        : null,
    coverage: {
      trigger: "NOT_VERIFIED",
      risk: "NOT_VERIFIED",
      scope: "PERSISTED_INPUTS_ONLY",
    },
  };
  const check = (name: string, status: AuditCheck["status"], detail: string) =>
    result.checks.push({ name, status, detail });
  const stop = (status: AuditReplayResult["status"], reason: string) => {
    result.status = status;
    result.reasons.push(reason);
    return result;
  };
  const encoded = input.serializedInput ?? JSON.stringify(input.snapshot);
  const hash = createHash("sha256").update(encoded).digest("hex");
  if (
    !/^[0-9a-f]{64}$/.test(input.expectedInputHash) ||
    hash !== input.expectedInputHash
  ) {
    check("inputHash", "FAIL", "冻结输入原文的 SHA-256 与事件引用不一致");
    return stop("MISMATCH", "INPUT_HASH_MISMATCH");
  }
  check("inputHash", "PASS", "冻结输入原文的 SHA-256 与事件引用一致");
  let snapshot: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(encoded);
    if (!object(value) || canonical(value) !== canonical(input.snapshot))
      throw new Error("PARSED_SNAPSHOT_MISMATCH");
    snapshot = value;
  } catch {
    check(
      "serializedInput",
      "FAIL",
      "解析快照与存储原文不一致或原文不是有效 JSON 对象",
    );
    return stop("MISMATCH", "SERIALIZED_INPUT_MISMATCH");
  }
  if (snapshot.algorithmVersion !== AUDIT_ALGORITHM_VERSION) {
    check(
      "algorithmVersion",
      "UNSUPPORTED",
      "该记录没有受支持的算法版本；不会使用当前算法替代旧版本",
    );
    return stop("UNSUPPORTED", "ALGORITHM_VERSION_UNSUPPORTED");
  }
  check("algorithmVersion", "PASS", AUDIT_ALGORITHM_VERSION);
  const config = configSchema.safeParse(snapshot.config);
  const inputs = z.array(inputSchema).safeParse(snapshot.inputs);
  if (
    !config.success ||
    !inputs.success ||
    !object(snapshot.state) ||
    !Array.isArray(snapshot.emitted) ||
    !snapshot.emitted.every(object)
  ) {
    check(
      "snapshotSchema",
      "UNSUPPORTED",
      "缺少完整配置、输入序列、原状态或原事件，或结构尚不受支持",
    );
    return stop("UNSUPPORTED", "SNAPSHOT_SCHEMA_UNSUPPORTED");
  }
  check("snapshotSchema", "PASS", "包含可重放的配置、输入序列和原始结果");
  // Use the original parsed values, never zod's stripped/reordered output or the newest live data.
  const frozenConfig = snapshot.config as AttemptConfig;
  const frozenInputs = snapshot.inputs as AttemptInput[];
  let lastSequence = 0,
    duplicates = 0;
  const ids = new Map<string, string>();
  for (const item of frozenInputs) {
    const prior = ids.get(item.id),
      value = canonical(item);
    if (prior !== undefined) {
      if (prior !== value) {
        check("ingestSequence", "FAIL", "同一输入 ID 对应不同内容");
        return stop("MISMATCH", "DUPLICATE_INPUT_CONFLICT");
      }
      duplicates++;
      continue;
    }
    if (item.ingestSeq <= lastSequence) {
      check(
        "ingestSequence",
        "FAIL",
        "不同输入的 ingestSeq 必须严格递增；审计不会重排输入",
      );
      return stop("MISMATCH", "INGEST_SEQUENCE_INVALID");
    }
    ids.set(item.id, value);
    lastSequence = item.ingestSeq;
  }
  check(
    "ingestSequence",
    "PASS",
    `按持久化顺序重放 ${frozenInputs.length} 项输入；${duplicates} 项完全相同的重复输入由纯核幂等处理`,
  );
  let state: AttemptState;
  const emitted: TriggerEvent[] = [];
  let triggeringInput: AttemptInput | undefined;
  try {
    state = createAttempt(structuredClone(frozenConfig));
    for (const item of frozenInputs) {
      const reduced = reduceAttempt(state, structuredClone(item), frozenConfig);
      state = reduced.state;
      emitted.push(...reduced.events);
      if (reduced.events.some((event) => event.type === "TECHNICAL_TRIGGERED"))
        triggeringInput = item;
    }
  } catch {
    check("triggerReplay", "FAIL", "冻结输入无法由其声明的算法执行");
    return stop("MISMATCH", "TRIGGER_REPLAY_FAILED");
  }
  result.replayed = summary({ state, emitted });
  const stateMatches = canonical(snapshot.state) === canonical(state);
  const eventsMatch = canonical(snapshot.emitted) === canonical(emitted);
  check(
    "attemptState",
    stateMatches ? "PASS" : "FAIL",
    stateMatches ? "重算状态与原始状态完整一致" : "重算状态与原始状态不同",
  );
  check(
    "emittedEvents",
    eventsMatch ? "PASS" : "FAIL",
    eventsMatch ? "事件内容与顺序完整一致" : "事件内容或顺序不同",
  );
  if (!stateMatches || !eventsMatch)
    return stop("MISMATCH", "TRIGGER_OUTPUT_MISMATCH");
  result.coverage.trigger = "VERIFIED";
  result.coverage.risk = "FROZEN_GATE_ONLY";
  if (snapshot.risk === undefined) {
    check(
      "risk",
      "PASS",
      "只验证输入中已冻结的风险门；该记录未归档可独立重算的最终资金风险结果",
    );
    result.status = "MATCH";
    return result;
  }
  if (snapshot.runtimeVersion === "closed-bar-v1") {
    const riskInput = snapshot.riskInput;
    if (
      !object(riskInput) ||
      !object(riskInput.plan) ||
      !object(riskInput.instrument) ||
      !Array.isArray(riskInput.reservations) ||
      !Number.isSafeInteger(riskInput.decisionAt) ||
      !Number.isSafeInteger(riskInput.sessionOpenAt)
    )
      return stop("UNSUPPORTED", "RISK_SNAPSHOT_UNSUPPORTED");
    try {
      const frozen = riskInput as unknown as ClosedRiskInput;
      const latest = frozenInputs.at(-1);
      if (
        frozen.plan.id !== frozenConfig.planId ||
        frozen.plan.version !== frozenConfig.planVersion ||
        frozen.plan.attemptId !== frozenConfig.attemptId ||
        frozen.instrument.id !== frozen.plan.instrumentId ||
        frozen.sessionOpenAt !== frozenConfig.sessionOpenAt ||
        canonical(frozen.plan.feeSchedule) !==
          canonical(
            (snapshot.planVersion as { feeSchedule?: unknown })?.feeSchedule,
          ) ||
        (frozen.plan.chaseLimit !== undefined &&
          chaseRatio(frozen.plan) !== frozenConfig.chaseFromLowMax) ||
        canonical(frozen.plan) !== canonical(snapshot.plan) ||
        canonical(frozen.funds) !== canonical(snapshot.funds) ||
        canonical(frozen.reservations) !== canonical(snapshot.reservations) ||
        canonical(frozen.instrument) !==
          canonical(
            (snapshot.planVersion as { instrument?: unknown })?.instrument,
          ) ||
        canonical(
          frozen.quote
            ? { price: frozen.quote.price, at: frozen.quote.at }
            : undefined,
        ) !==
          canonical(latest?.type === "BAR" ? latest.gates?.quote : undefined) ||
        frozen.decisionAt !== snapshot.decisionTime ||
        latest?.type !== "BAR" ||
        latest.gates?.decisionAt !== frozen.decisionAt
      )
        throw new Error("RISK_FROZEN_CONTEXT_MISMATCH");
      const risk = calculateClosedRisk(frozen);
      const gate = {
        status: risk.passed ? "PASS" : "BLOCKED",
        reasons: risk.reasons,
        quantity: risk.quantity,
      };
      const matches =
        canonical(risk) === canonical(snapshot.risk) &&
        canonical(gate) === canonical(latest.gates?.risk);
      check(
        "risk",
        matches ? "PASS" : "FAIL",
        matches
          ? "按冻结的真实决策时间、报价、资金代际与当前预留重算一致"
          : "正式风险或门控与冻结输入不一致",
      );
      if (!matches) return stop("MISMATCH", "RISK_OUTPUT_MISMATCH");
      result.coverage.risk = "RECOMPUTED";
      result.replayed!.quantity = risk.quantity;
      result.status = "MATCH";
      return result;
    } catch {
      return stop("MISMATCH", "RISK_FROZEN_CONTEXT_MISMATCH");
    }
  }
  const riskSnapshot = riskSnapshotSchema.safeParse(snapshot);
  if (!riskSnapshot.success) {
    check(
      "risk",
      "UNSUPPORTED",
      "存在原风险结果，但缺少其冻结资金、交易规则、预留或报价，不能独立重算",
    );
    return stop("UNSUPPORTED", "RISK_SNAPSHOT_UNSUPPORTED");
  }
  try {
    const frozen = riskSnapshot.data;
    const { plan, simulationClock: clock } = frozen;
    const instrument = frozen.planVersion.instrument as Instrument;
    const technical = emitted.find(
      (event) => event.type === "TECHNICAL_TRIGGERED",
    );
    const triggerInput = triggeringInput;
    if (
      !technical ||
      !triggerInput ||
      (triggerInput.type !== "BAR" && triggerInput.type !== "TICK")
    )
      throw new Error("RISK_TRIGGER_INPUT_MISSING");
    const entry =
      triggerInput.type === "BAR"
        ? triggerInput.bar.close
        : triggerInput.tick.price;
    if (
      plan.id !== frozenConfig.planId ||
      instrument.id !== plan.instrumentId ||
      plan.entryMin !== frozenConfig.entryMin ||
      plan.entryMax !== frozenConfig.entryMax ||
      plan.stop !== frozenConfig.stop ||
      canonical(plan.feeSchedule) !==
        canonical(frozen.planVersion.feeSchedule) ||
      (plan.chaseLimit !== undefined &&
        chaseRatio(plan as unknown as PlanInput) !==
          frozenConfig.chaseFromLowMax) ||
      clock.sessionOpenAt !== frozenConfig.sessionOpenAt ||
      clock.receivedAt !== triggerInput.receivedAt ||
      clock.quoteAt !== technical.time ||
      canonical(frozen.scenarioFunds) !==
        canonical({
          ...frozen.funds,
          confirmedAt: clock.sessionOpenAt,
          fxAsOf: clock.sessionOpenAt,
        })
    )
      throw new Error("RISK_FROZEN_CONTEXT_MISMATCH");
    const others = frozen.reservations.filter(
      (r) => r.planId !== plan.id && r.state !== "RELEASED",
    );
    const sum = (
      rows: typeof others,
      key: "cash" | "riskBase" | "exposureBase",
    ) =>
      rows
        .reduce((value, row) => value.plus(row[key]), new Decimal(0))
        .toFixed();
    const reservations = {
      cash: sum(
        others.filter((r) => r.currency === instrument.currency),
        "cash",
      ),
      riskBase: sum(others, "riskBase"),
      exposureBase: sum(
        others.filter((r) => r.instrumentId === plan.instrumentId),
        "exposureBase",
      ),
    };
    const baseline = solveRisk({
      feeSchedule: plan.feeSchedule as FeeSchedule | undefined,
      instrument,
      funds: frozen.funds as Funds,
      entryCheck: plan.entryMax,
      entryMin: plan.entryMin,
      entryMax: plan.entryMax,
      stop: plan.stop,
      now: frozen.decisionTime,
      approvedQuantity: plan.approvedQuantity,
      phase: "PLAN",
      reservations,
    });
    const risk = baseline.passed
      ? solveRisk({
          feeSchedule: plan.feeSchedule as FeeSchedule | undefined,
          instrument,
          funds: frozen.scenarioFunds as Funds,
          entryCheck: entry,
          entryMin: plan.entryMin,
          entryMax: plan.entryMax,
          stop: plan.stop,
          now: clock.receivedAt,
          quoteAsOf: clock.quoteAt,
          sessionStartedAt: clock.sessionOpenAt,
          approvedQuantity: plan.approvedQuantity,
          phase: "TRIGGER",
          reservations,
        })
      : baseline;
    const gate = {
      status: risk.passed ? "PASS" : "BLOCKED",
      reasons: risk.reasons,
      quantity: risk.quantity,
    };
    const matches =
      canonical(risk) === canonical(snapshot.risk) &&
      canonical(gate) === canonical(triggerInput.gates?.risk);
    result.replayed.quantity = risk.quantity;
    check(
      "risk",
      matches ? "PASS" : "FAIL",
      matches
        ? "最终风险结果及触发风险门与冻结资金、预留、规则和原报价的重算结果一致；早期输入仅验证其冻结风险门"
        : "最终风险结果或触发风险门与冻结输入重算结果不同",
    );
    if (!matches) return stop("MISMATCH", "RISK_OUTPUT_MISMATCH");
    result.coverage.risk = "RECOMPUTED";
  } catch (error) {
    check("risk", "FAIL", "冻结风险上下文缺失、互相冲突或无法执行");
    return stop(
      "MISMATCH",
      error instanceof Error ? error.message : "RISK_REPLAY_FAILED",
    );
  }
  result.status = "MATCH";
  return result;
}
