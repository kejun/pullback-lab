import Decimal from "decimal.js";
import type { Bar, DecisionEvent } from "../../packages/contracts/index.js";
import {
  createAttempt,
  reduceAttempt,
  type AttemptConfig,
  type AttemptInput,
  type TriggerBar,
  type TriggerEvent,
} from "../../packages/domain/trigger.js";
import { ApiError, type Store } from "./store.js";

/** One explicit historical fixture replay; no synthetic event can become a live entry. */
export function replayPlan(
  store: Store,
  planId: string,
  now: number,
): DecisionEvent[] {
  const plan = store.plan(planId);
  if (!plan.instrumentId.startsWith("DEMO-"))
    throw new ApiError(422, "SYNTHETIC_ONLY", "回放仅接受明确合成标的");
  if (!plan.attemptId)
    throw new ApiError(
      422,
      "ATTEMPT_REQUIRED",
      "请先完成风险检查并启用一次合成尝试",
    );
  const existing = store
    .events()
    .filter((event) => event.attemptId === plan.attemptId);
  if (existing.length) return existing;
  if (!["WAIT_RETEST", "ARMED"].includes(plan.status))
    throw new ApiError(
      409,
      "ATTEMPT_INACTIVE",
      "当前尝试不能继续，请显式建立新尝试",
    );
  const frozen = store.planVersion(plan);
  const instrument = frozen.instrument;
  const oneMinute = store.bars(plan.instrumentId, "1m");
  const fiveMinute = store.bars(plan.instrumentId, "5m");
  const daily = store.bars(plan.instrumentId, "1D");
  if (!oneMinute.length || !daily.length)
    throw new ApiError(422, "FIXTURE_MISSING", "请先载入完整合成数据");
  if (
    JSON.stringify(instrument) !==
      JSON.stringify(store.instrument(plan.instrumentId).instrument) ||
    JSON.stringify(frozen.previousDailyBar) !== JSON.stringify(daily.at(-1))
  ) {
    return store.recordReplayState(
      plan.id,
      plan.version,
      "DATA_PAUSED",
      now,
      { synthetic: true, frozenPlanVersion: frozen },
      ["PLAN_DATA_REVISION_CHANGED"],
    );
  }
  const open = oneMinute[0].time * 1000;
  const config: AttemptConfig = {
    attemptId: plan.attemptId,
    planId: plan.id,
    planVersion: plan.version,
    sessionId: `synthetic:${plan.instrumentId}:${plan.sessionDate}`,
    sessionOpenAt: open,
    activatedAt: open - 1,
    mode: plan.mode,
    lower: plan.lower,
    upper: plan.upper,
    stop: plan.stop,
    entryMin: plan.entryMin,
    entryMax: plan.entryMax,
    tick: instrument.tick,
    previousDayClose: frozen.previousDailyBar!.close,
    evidenceEpoch: `synthetic:${plan.attemptId}`,
    template: "SESSION_FIRST",
    preActivationEvidence: "NO_TOUCH",
  };
  let state = createAttempt(config);
  let seq = 0;
  const inputs: AttemptInput[] = [];
  const emitted: TriggerEvent[] = [];
  let knownLow: string | null = null;
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
  const run = (input: AttemptInput) => {
    inputs.push(input);
    const result = reduceAttempt(state, input, config);
    state = result.state;
    emitted.push(...result.events);
    return result.events;
  };
  const candidates = [
    ...oneMinute
      .filter((bar) => bar.time * 1000 < open + 15 * 60_000)
      .map((b) => convert(b, "1m")),
    ...fiveMinute
      .filter((bar) => bar.time * 1000 >= open + 15 * 60_000)
      .map((b) => convert(b, "5m")),
  ];
  for (const bar of candidates) {
    const source = bar.period === "1m" ? oneMinute : fiveMinute;
    const prior = source.find(
      (b) =>
        b.time * 1000 + (bar.period === "1m" ? 60_000 : 300_000) === bar.start,
    );
    if (prior)
      run({
        type: "REFERENCE",
        id: `synthetic:ref:${bar.id}`,
        receivedAt: prior.receivedAt,
        ingestSeq: ++seq,
        candidate: { start: bar.start, end: bar.end, period: bar.period },
        bar: convert(prior, bar.period),
      });
    knownLow =
      knownLow === null ? bar.low : Decimal.min(knownLow, bar.low).toFixed();
    const simulationClock = {
      quoteAt: bar.end,
      receivedAt: bar.receivedAt,
      sessionOpenAt: open,
    };
    const risk = store.replayRisk(plan, now, bar.close, simulationClock);
    const events = run({
      type: "BAR",
      id: `synthetic:bar:${bar.id}`,
      receivedAt: bar.receivedAt,
      ingestSeq: ++seq,
      bar,
      gates: {
        capability: "UNKNOWN",
        dataHealthy: true,
        historical: true,
        quote: { price: bar.close, at: bar.end },
        risk: {
          status: risk.passed ? "PASS" : "BLOCKED",
          reasons: risk.reasons,
          quantity: risk.quantity,
        },
        lod: { price: knownLow, from: open, through: bar.end, complete: true },
      },
    });
    const technical = events.find(
      (event) => event.type === "TECHNICAL_TRIGGERED",
    );
    if (technical) {
      const assessment = events.find(
        (event) => event.type === "HISTORICAL_TRIGGERED",
      );
      const checks = assessment?.snapshot.checks as
        Record<string, { status: string; reasons: string[] }> | undefined;
      // Real capability remains UNKNOWN; simulation checks are explicitly separate.
      const simulationReasons = Object.entries(checks ?? {})
        .filter(([name]) => name !== "capability")
        .flatMap(([, check]) => check.reasons);
      return store.commitTechnical(
        plan.id,
        plan.version,
        plan.attemptId,
        {
          entry: bar.close,
          time: bar.end,
          receivedAt: bar.receivedAt,
          refId: state.reference?.barId ?? "",
          historical: true,
          reasons: simulationReasons,
          simulationClock,
          snapshot: {
            synthetic: true,
            config,
            inputs,
            state,
            emitted,
            sourceBars: { daily, oneMinute, fiveMinute },
            simulationOnly: true,
            liveCapability: "UNKNOWN",
            simulationRiskTime: now,
          },
        },
        now,
      );
    }
    if (["INVALID", "EXPIRED", "DATA_PAUSED"].includes(state.status)) break;
  }
  if (["WAIT_RETEST", "ARMED"].includes(state.status))
    run({
      type: "CLOCK",
      id: "synthetic:final-clock",
      receivedAt: open + 60 * 60_000 + 30_001,
      ingestSeq: ++seq,
    });
  return store.recordReplayState(
    plan.id,
    plan.version,
    state.status,
    now,
    {
      synthetic: true,
      config,
      inputs,
      state,
      emitted,
      sourceBars: { daily, oneMinute, fiveMinute },
    },
    state.reason ? [state.reason] : [],
  );
}
