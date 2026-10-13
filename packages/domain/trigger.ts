import Decimal from "decimal.js";

const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
export const MINUTE = 60_000;
export type TriggerMode = "CLOSE_CONFIRM" | "INTRABAR_CROSS";
export type AttemptStatus =
  | "WAIT_RETEST"
  | "ARMED"
  | "TRIGGERED"
  | "INVALID"
  | "EXPIRED"
  | "USER_PAUSED"
  | "DATA_PAUSED"
  | "TAKEN"
  | "SKIPPED";
export interface CandidateWindow {
  start: number;
  end: number;
  period: "1m" | "5m";
}
export interface TriggerBar extends CandidateWindow {
  id: string;
  sessionId: string;
  open: string;
  high: string;
  low: string;
  close: string;
  final: boolean;
  revision: string;
  receivedAt: number;
}
export interface AttemptConfig {
  /** Formal runtime opt-in; absent keeps archived v1 cancellation semantics unchanged. */
  allowPausedCancellation?: boolean;
  allowFeedbackCorrections?: boolean;
  attemptId: string;
  planId: string;
  planVersion: number;
  sessionId: string;
  sessionOpenAt: number;
  sessionCloseAt?: number;
  activatedAt: number;
  mode: TriggerMode;
  lower: string;
  upper: string;
  stop: string;
  entryMin: string;
  entryMax: string;
  tick: string;
  previousDayClose: string;
  evidenceEpoch: string;
  template: "SESSION_FIRST" | "RECOVERY";
  preActivationEvidence: "NO_TOUCH" | "TOUCHED" | "UNKNOWN";
  chaseFromLowMax?: string;
  referenceGraceMs?: number;
  quoteMaxAgeMs?: number;
  /** Verified exchange tick bands; from is inclusive and the band grid origin. */
  priceBands?: { from: string; tick: string }[];
}
export interface DecisionGates {
  /** Actual server decision time; receipt time remains the close eligibility boundary. */
  decisionAt?: number;
  /** A stop quote known before decision remains invalidating after a later rebound. */
  knownStop?: { price: string; at: number; receivedAt: number };
  capability:
    "LIVE_CLOSED_BAR" | "LIVE_TICK" | "DELAYED" | "EOD_ONLY" | "UNKNOWN";
  dataHealthy: boolean;
  quote?: { price: string; at: number };
  risk: {
    status: "PASS" | "BLOCKED" | "UNAVAILABLE";
    reasons: string[];
    quantity: number;
  };
  lod?: { price: string; from: number; through: number; complete: boolean };
  /** Historical/demo inputs never create an actionable entry. */
  historical?: boolean;
}
export interface OrderedTick {
  price: string;
  at: number;
  sessionId: string;
  evidenceEpoch: string;
  /** Provider-adapter chain tokens, never locally synthesized sequence numbers. */
  sequence: string | null;
  previousSequence: string | null;
  orderVerified: boolean;
  continuityVerified: boolean;
}
interface InputEnvelope {
  id: string;
  receivedAt: number;
  ingestSeq: number;
}
export type AttemptInput = InputEnvelope &
  (
    | { type: "REFERENCE"; candidate: CandidateWindow; bar: TriggerBar }
    | { type: "BAR"; bar: TriggerBar; gates?: DecisionGates }
    | { type: "TICK"; tick: OrderedTick; gates?: DecisionGates }
    | { type: "CLOCK" }
    | { type: "DATA_GAP"; reason: string }
    | { type: "REFERENCE_REVISED"; refBarId: string; revision: string }
    | { type: "VERSION_CHANGED"; reason: string }
    | { type: "PAUSE" }
    | { type: "FEEDBACK"; feedback: "TAKEN" | "SKIPPED" }
  );
export interface FrozenReference {
  candidate: CandidateWindow;
  barId: string;
  revision: string;
  high: string;
  close: string;
  threshold: string;
  readyAt: number;
  evidenceEpoch: string;
}
export interface TriggerEvent {
  key: string;
  type: string;
  time: number;
  receivedAt: number;
  historical: boolean;
  reasons: string[];
  quantity?: number;
  snapshot: Record<string, unknown>;
}
export interface AttemptState {
  attemptId: string;
  planVersion: number;
  configSignature: string;
  evidenceEpoch: string;
  template: AttemptConfig["template"];
  status: AttemptStatus;
  reason: string | null;
  consumed: boolean;
  aboveEvidence: boolean;
  touchAt: number | null;
  touchBarId: string | null;
  touchCandidateKey: string | null;
  deadline: number;
  references: Record<string, FrozenReference>;
  reference: FrozenReference | null;
  lastTick: (OrderedTick & { receivedAt: number; candidateKey: string }) | null;
  trigger: {
    threshold: string;
    candidate: CandidateWindow;
    time: number;
  } | null;
  processedIds: string[];
  eventKeys: string[];
  lastIngestSeq: number;
  expiredByClock: boolean;
}
export interface AttemptReduction {
  state: AttemptState;
  events: TriggerEvent[];
}

function signature(c: AttemptConfig): string {
  return JSON.stringify(
    Object.entries(c).sort(([a], [b]) => a.localeCompare(b)),
  );
}
function dec(v: string): Decimal {
  return new D(v);
}
function validPrice(v: string): boolean {
  try {
    const d = dec(v);
    return d.isFinite() && d.gt(0);
  } catch {
    return false;
  }
}
const keyOf = (b: CandidateWindow) => `${b.period}:${b.start}:${b.end}`;
const active = (s: AttemptState) =>
  s.status === "WAIT_RETEST" || s.status === "ARMED";
const grace = (c: AttemptConfig) => c.referenceGraceMs ?? 30_000;
const hourEnd = (c: AttemptConfig) =>
  Math.min(c.sessionOpenAt + 60 * MINUTE, c.sessionCloseAt ?? Infinity);

/** Select a market-aligned candidate. Times throughout this module are UTC milliseconds. */
export function candidateAt(
  time: number,
  c: Pick<AttemptConfig, "sessionOpenAt" | "sessionCloseAt">,
): CandidateWindow | null {
  const offset = time - c.sessionOpenAt;
  if (offset < 0 || offset >= 60 * MINUTE) return null;
  const duration = offset < 15 * MINUTE ? MINUTE : 5 * MINUTE;
  const start = c.sessionOpenAt + Math.floor(offset / duration) * duration;
  const end = start + duration;
  if (
    end > Math.min(c.sessionOpenAt + 60 * MINUTE, c.sessionCloseAt ?? Infinity)
  )
    return null;
  return { start, end, period: duration === MINUTE ? "1m" : "5m" };
}
function validCandidate(b: CandidateWindow, c: AttemptConfig): boolean {
  const expected = candidateAt(b.start, c);
  return (
    expected !== null && expected.end === b.end && expected.period === b.period
  );
}
function validBar(b: TriggerBar): boolean {
  return (
    [b.open, b.high, b.low, b.close].every(validPrice) &&
    dec(b.low).lte(b.open) &&
    dec(b.low).lte(b.close) &&
    dec(b.high).gte(b.open) &&
    dec(b.high).gte(b.close) &&
    b.start < b.end &&
    Number.isSafeInteger(b.start) &&
    Number.isSafeInteger(b.end) &&
    Number.isSafeInteger(b.receivedAt)
  );
}

/** Exact first legal price strictly above the reference, including a verified tick-band boundary. */
export function nextLegalPriceAbove(
  price: string,
  c: Pick<AttemptConfig, "tick" | "priceBands">,
): string {
  const p = dec(price);
  if (!c.priceBands?.length)
    return p.div(c.tick).floor().plus(1).times(c.tick).toFixed();
  const bands = [...c.priceBands].sort((a, b) => dec(a.from).cmp(b.from));
  for (let i = 0; i < bands.length; i++) {
    const from = dec(bands[i].from);
    const tick = dec(bands[i].tick);
    if (!tick.gt(0)) throw new Error("INVALID_TICK_BAND");
    const next = p.lt(from)
      ? from
      : p.minus(from).div(tick).floor().plus(1).times(tick).plus(from);
    if ((!bands[i + 1] || next.lt(bands[i + 1].from)) && next.gt(p))
      return next.toFixed();
  }
  throw new Error("MISSING_TICK_BAND");
}

export function createAttempt(c: AttemptConfig): AttemptState {
  if (
    ![
      c.lower,
      c.upper,
      c.stop,
      c.entryMin,
      c.entryMax,
      c.tick,
      c.previousDayClose,
    ].every(validPrice) ||
    dec(c.lower).gt(c.upper) ||
    !dec(c.stop).lt(c.lower) ||
    !dec(c.entryMin).gt(c.stop) ||
    !dec(c.entryMax).gt(c.entryMin) ||
    !c.attemptId ||
    !c.evidenceEpoch ||
    !Number.isSafeInteger(c.activatedAt) ||
    !Number.isSafeInteger(c.sessionOpenAt) ||
    (c.chaseFromLowMax !== undefined &&
      (!dec(c.chaseFromLowMax).isFinite() || dec(c.chaseFromLowMax).lt(0))) ||
    grace(c) < 0 ||
    grace(c) > 30_000
  )
    throw new Error("INVALID_ATTEMPT_CONFIG");
  let status: AttemptStatus = "WAIT_RETEST";
  let reason: string | null = null;
  if (c.activatedAt >= hourEnd(c)) {
    status = "EXPIRED";
    reason = "OUTSIDE_FIRST_HOUR";
  } else if (
    c.template === "SESSION_FIRST" &&
    c.activatedAt > c.sessionOpenAt &&
    c.preActivationEvidence !== "NO_TOUCH"
  ) {
    status = c.preActivationEvidence === "TOUCHED" ? "INVALID" : "DATA_PAUSED";
    reason =
      c.preActivationEvidence === "TOUCHED"
        ? "EARLIER_RETEST_ALREADY_OBSERVED"
        : "SESSION_HISTORY_INCOMPLETE";
  } else if (
    c.template === "SESSION_FIRST" &&
    !dec(c.previousDayClose).gt(c.upper)
  ) {
    status = "INVALID";
    reason = "PREVIOUS_CLOSE_NOT_ABOVE_SUPPORT";
  }
  return {
    attemptId: c.attemptId,
    planVersion: c.planVersion,
    configSignature: signature(c),
    evidenceEpoch: c.evidenceEpoch,
    template: c.template,
    status,
    reason,
    consumed: false,
    aboveEvidence: c.template === "SESSION_FIRST" && status === "WAIT_RETEST",
    touchAt: null,
    touchBarId: null,
    touchCandidateKey: null,
    deadline: hourEnd(c),
    references: {},
    reference: null,
    lastTick: null,
    trigger: null,
    processedIds: [],
    eventKeys: [],
    lastIngestSeq: -1,
    expiredByClock: false,
  };
}

/**
 * Pure deterministic reducer. Persist its state and emitted events in the SAME transaction.
 * The dispatcher must feed persisted ingress sequence order, including timer facts; worker
 * processing time is deliberately absent. Risk/quote/LOD gates must come from the server.
 * A resumed feed always requires createAttempt with a new ID and evidence epoch.
 */
export function reduceAttempt(
  previous: AttemptState,
  input: AttemptInput,
  c: AttemptConfig,
): AttemptReduction {
  const state: AttemptState = structuredClone(previous);
  const events: TriggerEvent[] = [];
  if (state.processedIds.includes(input.id)) return { state, events };
  state.processedIds.push(input.id);
  const emit = (
    type: string,
    time: number,
    reasons: string[] = [],
    extra: Record<string, unknown> = {},
    historical = false,
    quantity?: number,
  ) => {
    // Technical and entry identity is attempt-wide, independent of rolling references.
    const key = `${c.attemptId}:${type}`;
    if (state.eventKeys.includes(key)) return;
    state.eventKeys.push(key);
    events.push({
      key,
      type,
      time,
      receivedAt: input.receivedAt,
      historical,
      reasons,
      ...(quantity === undefined ? {} : { quantity }),
      snapshot: {
        planId: c.planId,
        planVersion: state.planVersion,
        attemptId: state.attemptId,
        evidenceEpoch: state.evidenceEpoch,
        template: state.template,
        touchAt: state.touchAt,
        deadline: state.deadline,
        reference: structuredClone(state.reference),
        ...extra,
      },
    });
  };
  const pauseData = (reason: string) => {
    if (
      !state.consumed &&
      !["INVALID", "TAKEN", "SKIPPED", "USER_PAUSED"].includes(state.status)
    )
      state.status = "DATA_PAUSED";
    state.reason = reason;
    state.lastTick = null;
    emit("DATA_PAUSED", input.receivedAt, [reason], {}, true);
  };
  const expire = () => {
    state.status = "EXPIRED";
    state.reason = "ATTEMPT_DEADLINE";
    state.expiredByClock = true;
    emit("EXPIRED", state.deadline, ["ATTEMPT_DEADLINE"], {}, true);
  };
  const invalidate = (reason: string, time: number) => {
    state.status = "INVALID";
    state.reason = reason;
    emit("INVALID", time, [reason]);
  };
  if (signature(c) !== state.configSignature) {
    pauseData("PLAN_VERSION_CHANGED");
    return { state, events };
  }
  if (
    !Number.isSafeInteger(input.ingestSeq) ||
    input.ingestSeq <= state.lastIngestSeq ||
    !Number.isSafeInteger(input.receivedAt)
  ) {
    pauseData("INGRESS_ORDER_INVALID");
    return { state, events };
  }
  state.lastIngestSeq = input.ingestSeq;
  if (input.type === "DATA_GAP" || input.type === "VERSION_CHANGED") {
    pauseData(input.reason);
    return { state, events };
  }
  if (input.type === "REFERENCE_REVISED") {
    if (
      Object.values(state.references).some(
        (r) => r.barId === input.refBarId && r.revision !== input.revision,
      )
    )
      pauseData("REFERENCE_REVISION_CHANGED");
    return { state, events };
  }
  if (input.type === "PAUSE") {
    if (
      !state.consumed &&
      (active(state) ||
        (c.allowPausedCancellation === true && state.status === "DATA_PAUSED"))
    ) {
      state.status = "USER_PAUSED";
      state.reason = "USER_PAUSED";
      emit("USER_PAUSED", input.receivedAt);
    }
    return { state, events };
  }
  if (input.type === "FEEDBACK") {
    if (
      state.eventKeys.includes(`${c.attemptId}:ENTRY_TRIGGERED`) &&
      (!["TAKEN", "SKIPPED"].includes(state.status) ||
        (c.allowFeedbackCorrections === true &&
          state.status !== input.feedback))
    ) {
      state.status = input.feedback;
      emit(input.feedback, input.receivedAt);
    }
    return { state, events };
  }
  if (input.type === "CLOCK") {
    if (
      !state.consumed &&
      (active(state) || state.status === "DATA_PAUSED") &&
      (c.mode === "CLOSE_CONFIRM"
        ? input.receivedAt > state.deadline + grace(c)
        : input.receivedAt >= state.deadline)
    )
      expire();
    return { state, events };
  }
  if (input.type === "REFERENCE") {
    const b = input.candidate;
    const r = input.bar;
    if (!active(state) || !validCandidate(b, c) || b.end > state.deadline)
      return { state, events };
    if (
      !validBar(r) ||
      !r.final ||
      r.sessionId !== c.sessionId ||
      r.period !== b.period ||
      r.end !== b.start ||
      r.start !== r.end - (r.period === "1m" ? MINUTE : 5 * MINUTE) ||
      r.start < c.sessionOpenAt ||
      r.receivedAt < r.end ||
      input.receivedAt < r.receivedAt
    ) {
      emit(
        "REFERENCE_UNAVAILABLE",
        input.receivedAt,
        ["REFERENCE_NOT_ADJACENT_FINAL"],
        { candidate: b },
        true,
      );
      return { state, events };
    }
    const old = state.references[keyOf(b)];
    if (
      old &&
      (old.barId !== r.id ||
        old.revision !== r.revision ||
        old.high !== r.high ||
        old.close !== r.close)
    ) {
      pauseData("REFERENCE_REVISION_CHANGED");
      return { state, events };
    }
    const readyAt = Math.max(input.receivedAt, r.receivedAt);
    if (readyAt > b.start + grace(c)) {
      emit(
        "REFERENCE_UNAVAILABLE",
        readyAt,
        ["REFERENCE_TOO_LATE"],
        { candidate: b },
        true,
      );
      return { state, events };
    }
    if (!old)
      state.references[keyOf(b)] = {
        candidate: { ...b },
        barId: r.id,
        revision: r.revision,
        high: r.high,
        close: r.close,
        threshold: nextLegalPriceAbove(r.high, c),
        readyAt,
        evidenceEpoch: c.evidenceEpoch,
      };
    state.reference = state.references[keyOf(b)];
    return { state, events };
  }

  const postTrigger = (price: string, time: number) => {
    if (!state.trigger) return;
    if (dec(price).lte(c.stop))
      emit(
        "STOP_REFERENCE_TOUCHED",
        time,
        ["STOP_REFERENCE_TOUCHED"],
        { price },
        true,
      );
    if (dec(price).lt(state.trigger.threshold))
      emit("BREAKOUT_FADED", time, ["PRICE_BELOW_TRIGGER"], { price }, true);
  };
  const trigger = (
    ref: FrozenReference,
    price: string,
    time: number,
    gates?: DecisionGates,
    forcedHistory = false,
  ) => {
    state.reference = ref;
    state.consumed = true;
    state.trigger = {
      threshold: ref.threshold,
      candidate: { ...ref.candidate },
      time,
    };
    const historical = forcedHistory || gates?.historical === true;
    emit(
      "TECHNICAL_TRIGGERED",
      time,
      [],
      { technicalPrice: price },
      historical,
    );
    const checks: Record<
      string,
      { status: "PASS" | "BLOCKED" | "UNAVAILABLE"; reasons: string[] }
    > = {};
    const check = (
      name: string,
      status: "PASS" | "BLOCKED" | "UNAVAILABLE",
      reasons: string[] = [],
    ) => {
      checks[name] = { status, reasons };
    };
    const q = gates?.quote;
    const decisionAt = gates?.decisionAt ?? input.receivedAt;
    const quoteGood =
      Number.isSafeInteger(decisionAt) &&
      decisionAt >= input.receivedAt &&
      !!q &&
      Number.isSafeInteger(q.at) &&
      validPrice(q.price) &&
      q.at <= decisionAt &&
      decisionAt - q.at <= (c.quoteMaxAgeMs ?? 3_000);
    const echeck = q && validPrice(q.price) ? q.price : price;
    check(
      "quote",
      quoteGood ? "PASS" : "UNAVAILABLE",
      quoteGood ? [] : ["QUOTE_STALE_OR_MISSING"],
    );
    const within = [price, echeck].every(
      (p) => dec(p).gte(c.entryMin) && dec(p).lte(c.entryMax),
    );
    check(
      "entryRange",
      within ? "PASS" : "BLOCKED",
      within ? [] : ["ENTRY_OUTSIDE_ALLOWED_RANGE"],
    );
    const capable =
      c.mode === "INTRABAR_CROSS"
        ? gates?.capability === "LIVE_TICK"
        : ["LIVE_CLOSED_BAR", "LIVE_TICK"].includes(
            gates?.capability ?? "UNKNOWN",
          );
    check(
      "capability",
      capable ? "PASS" : "UNAVAILABLE",
      capable ? [] : ["LIVE_CAPABILITY_UNAVAILABLE"],
    );
    check(
      "health",
      gates?.dataHealthy ? "PASS" : "UNAVAILABLE",
      gates?.dataHealthy ? [] : ["DATA_NOT_HEALTHY"],
    );
    if (c.chaseFromLowMax !== undefined) {
      const lod = gates?.lod;
      const lodGood =
        !!lod &&
        lod.complete &&
        lod.from === c.sessionOpenAt &&
        lod.through >= Math.max(q?.at ?? time, time) &&
        lod.through <= decisionAt &&
        validPrice(lod.price);
      if (!lodGood) check("chase", "UNAVAILABLE", ["SESSION_LOW_INCOMPLETE"]);
      else {
        const passed = dec(echeck)
          .minus(lod.price)
          .div(lod.price)
          .lte(c.chaseFromLowMax);
        check(
          "chase",
          passed ? "PASS" : "BLOCKED",
          passed ? [] : ["CHASE_FROM_LOW_EXCEEDED"],
        );
      }
    }
    const riskPassed =
      gates?.risk.status === "PASS" &&
      Number.isSafeInteger(gates.risk.quantity) &&
      gates.risk.quantity > 0;
    check(
      "risk",
      riskPassed
        ? "PASS"
        : gates?.risk.status === "BLOCKED"
          ? "BLOCKED"
          : "UNAVAILABLE",
      riskPassed
        ? []
        : gates?.risk.reasons.length
          ? [...gates.risk.reasons]
          : ["RISK_UNAVAILABLE"],
    );
    const reasons = Object.values(checks).flatMap((v) => v.reasons);
    const snapshot = {
      checks,
      echeck,
      lod: gates?.lod ? { ...gates.lod } : null,
      gates: gates ? structuredClone(gates) : null,
    };
    if (historical) {
      state.status = forcedHistory ? "EXPIRED" : "USER_PAUSED";
      state.reason = "HISTORICAL_ONLY";
      emit(
        "HISTORICAL_TRIGGERED",
        time,
        ["HISTORICAL_ONLY", ...reasons],
        snapshot,
        true,
        riskPassed ? gates!.risk.quantity : undefined,
      );
    } else if (!reasons.length) {
      state.status = "TRIGGERED";
      state.reason = null;
      emit("ENTRY_TRIGGERED", time, [], snapshot, false, gates!.risk.quantity);
    } else {
      state.status = "USER_PAUSED";
      state.reason = reasons.join(",");
      emit("ENTRY_BLOCKED", time, reasons, snapshot);
    }
  };

  if (input.type === "BAR") {
    const b = input.bar;
    if (
      b.sessionId !== c.sessionId ||
      b.end <= c.sessionOpenAt ||
      b.receivedAt !== input.receivedAt
    ) {
      pauseData("BAR_SESSION_OR_RECEIPT_INVALID");
      return { state, events };
    }
    if (!validBar(b)) {
      pauseData("BAR_VALUES_INVALID");
      return { state, events };
    }
    if (!b.final) return { state, events };
    if (b.receivedAt < b.end) {
      pauseData("BAR_CONFIRMED_BEFORE_END");
      return { state, events };
    }
    if (state.consumed) {
      // A same-bar low may precede the intrabar entry; OHLC cannot establish its order.
      if (state.trigger && b.start >= state.trigger.time)
        postTrigger(b.low, b.end);
      if (state.trigger && b.end >= state.trigger.time)
        postTrigger(b.close, b.end);
      return { state, events };
    }
    // Stop evidence takes precedence, including a later tick received before a queued close.
    const currentQuote = input.gates?.quote;
    const decisionAt = input.gates?.decisionAt ?? input.receivedAt;
    const knownStop = input.gates?.knownStop;
    if (
      active(state) &&
      (dec(b.low).lte(c.stop) ||
        (currentQuote &&
          validPrice(currentQuote.price) &&
          currentQuote.at <= decisionAt &&
          dec(currentQuote.price).lte(c.stop)) ||
        (knownStop &&
          validPrice(knownStop.price) &&
          knownStop.at >= c.activatedAt &&
          knownStop.at <= knownStop.receivedAt &&
          knownStop.receivedAt <= decisionAt &&
          dec(knownStop.price).lte(c.stop)))
    ) {
      invalidate("STOP_REFERENCE_TOUCHED", b.end);
      return { state, events };
    }
    if (c.mode === "INTRABAR_CROSS") {
      if (
        state.status === "ARMED" &&
        keyOf(b) === state.touchCandidateKey &&
        dec(b.close).lt(c.lower)
      )
        invalidate("TOUCH_BAR_CLOSED_BELOW_SUPPORT", b.end);
      return { state, events };
    }
    const expiredHistory =
      state.status === "EXPIRED" &&
      state.expiredByClock &&
      state.touchAt !== null;
    if (
      (!active(state) && !expiredHistory) ||
      !validCandidate(b, c) ||
      b.end > state.deadline ||
      b.start < c.activatedAt
    )
      return { state, events };
    const late = input.receivedAt > b.end + grace(c);
    if (state.status === "WAIT_RETEST") {
      const intersects = dec(b.low).lte(c.upper) && dec(b.high).gte(c.lower);
      if (late) {
        pauseData("BAR_TOO_LATE_FOR_FIRST_RETEST");
        return { state, events };
      }
      if (intersects && state.aboveEvidence) {
        if (dec(b.close).lt(c.lower))
          invalidate("TOUCH_BAR_CLOSED_BELOW_SUPPORT", b.end);
        else {
          state.status = "ARMED";
          state.touchAt = b.end;
          state.touchBarId = b.id;
          state.touchCandidateKey = keyOf(b);
          state.deadline = Math.min(hourEnd(c), b.end + 15 * MINUTE);
          emit("RETEST_OBSERVED", b.end);
        }
      } else if (dec(b.close).gt(c.upper) && dec(b.low).gt(c.upper))
        state.aboveEvidence = true;
      return { state, events };
    }
    const ref = state.references[keyOf(b)];
    if (
      !ref ||
      b.id === state.touchBarId ||
      b.start < (state.touchAt ?? Infinity) ||
      ref.readyAt > b.start + grace(c)
    )
      return { state, events };
    if (
      dec(ref.close).lt(ref.threshold) &&
      dec(b.close).gte(ref.threshold) &&
      dec(b.low).gt(c.stop)
    )
      trigger(ref, b.close, b.end, input.gates, late || expiredHistory);
    else if (late) pauseData("BAR_TOO_LATE");
    return { state, events };
  }

  const x = input.tick;
  if (
    x.sessionId !== c.sessionId ||
    !Number.isSafeInteger(x.at) ||
    x.at < c.sessionOpenAt ||
    x.at > input.receivedAt ||
    !validPrice(x.price)
  ) {
    pauseData("TICK_VALUES_OR_SESSION_INVALID");
    return { state, events };
  }
  if (state.consumed) {
    // Later receipt does not turn an older event into post-entry risk evidence.
    if (state.trigger && x.at >= state.trigger.time) postTrigger(x.price, x.at);
    return { state, events };
  }
  if (active(state) && dec(x.price).lte(c.stop)) {
    invalidate("STOP_REFERENCE_TOUCHED", x.at);
    return { state, events };
  }
  if (c.mode !== "INTRABAR_CROSS" || !active(state)) return { state, events };
  if (x.at >= state.deadline) {
    expire();
    return { state, events };
  }
  if (
    !x.sequence ||
    !x.orderVerified ||
    !x.continuityVerified ||
    x.evidenceEpoch !== c.evidenceEpoch
  ) {
    pauseData("TICK_ORDER_EVIDENCE_UNAVAILABLE");
    return { state, events };
  }
  if (state.lastTick?.sequence === x.sequence) {
    if (state.lastTick.price !== x.price || state.lastTick.at !== x.at)
      pauseData("TICK_SEQUENCE_CONFLICT");
    return { state, events };
  }
  if (
    state.lastTick &&
    (x.previousSequence !== state.lastTick.sequence || x.at < state.lastTick.at)
  ) {
    pauseData("TICK_CONTINUITY_GAP");
    return { state, events };
  }
  if (input.receivedAt - x.at > (c.quoteMaxAgeMs ?? 3_000)) {
    pauseData("TICK_TOO_OLD");
    return { state, events };
  }
  const b = candidateAt(x.at, c);
  if (!b || x.at < c.activatedAt) return { state, events };
  const previousTick = state.lastTick;
  state.lastTick = {
    ...x,
    receivedAt: input.receivedAt,
    candidateKey: keyOf(b),
  };
  if (state.status === "WAIT_RETEST") {
    if (dec(x.price).gt(c.upper)) state.aboveEvidence = true;
    if (
      state.aboveEvidence &&
      dec(x.price).gte(c.lower) &&
      dec(x.price).lte(c.upper)
    ) {
      state.status = "ARMED";
      state.touchAt = x.at;
      state.touchBarId = `${b.period}:${b.start}`;
      state.touchCandidateKey = keyOf(b);
      state.deadline = Math.min(hourEnd(c), x.at + 15 * MINUTE);
      emit("RETEST_OBSERVED", x.at, [], {
        touchSequence: x.sequence,
        candidate: b,
      });
    }
    return { state, events };
  }
  const ref = state.references[keyOf(b)];
  if (
    !ref ||
    !previousTick ||
    previousTick.candidateKey !== keyOf(b) ||
    previousTick.receivedAt < ref.readyAt ||
    input.receivedAt < ref.readyAt ||
    previousTick.at < ref.readyAt ||
    x.at < ref.readyAt ||
    x.at < (state.touchAt ?? Infinity) ||
    (x.at === state.touchAt && x.sequence === previousTick.sequence)
  )
    return { state, events };
  if (
    dec(previousTick.price).lt(ref.threshold) &&
    dec(x.price).gte(ref.threshold)
  )
    trigger(ref, x.price, x.at, input.gates);
  return { state, events };
}
