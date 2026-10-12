import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  candidateAt,
  createAttempt,
  MINUTE as M,
  nextLegalPriceAbove,
  reduceAttempt,
  type AttemptConfig,
  type AttemptInput,
  type AttemptState,
  type DecisionGates,
  type TriggerBar,
  type TriggerEvent,
} from "./trigger.js";

const config = (extra: Partial<AttemptConfig> = {}): AttemptConfig => ({
  attemptId: "attempt-1",
  planId: "plan-1",
  planVersion: 1,
  sessionId: "test-session",
  sessionOpenAt: 0,
  activatedAt: 0,
  mode: "CLOSE_CONFIRM",
  lower: "99.75",
  upper: "100.25",
  stop: "99.40",
  entryMin: "100.25",
  entryMax: "104",
  tick: "0.01",
  previousDayClose: "101",
  evidenceEpoch: "epoch-1",
  template: "SESSION_FIRST",
  preActivationEvidence: "NO_TOUCH",
  ...extra,
});
const bar = (start: number, extra: Partial<TriggerBar> = {}): TriggerBar => {
  const duration = start < 15 * M ? M : 5 * M;
  return {
    id: `bar-${start}`,
    sessionId: "test-session",
    start,
    end: start + duration,
    period: duration === M ? "1m" : "5m",
    open: "100.50",
    high: "100.60",
    low: "100.00",
    close: "100.20",
    final: true,
    revision: "1",
    receivedAt: start + duration + 1_000,
    ...extra,
  };
};
const gates = (
  time: number,
  price = "100.61",
  extra: Partial<DecisionGates> = {},
): DecisionGates => ({
  capability: "LIVE_CLOSED_BAR",
  dataHealthy: true,
  quote: { price, at: time },
  risk: { status: "PASS", reasons: [], quantity: 10 },
  ...extra,
});
function harness(c = config(), initial?: AttemptState) {
  let state = initial ?? createAttempt(c);
  let seq = state.lastIngestSeq + 1;
  const events: TriggerEvent[] = [];
  const feed = (
    input: Omit<AttemptInput, "id" | "ingestSeq"> | Record<string, unknown>,
  ) => {
    const full = {
      id: `input-${seq}`,
      ingestSeq: seq++,
      ...input,
    } as AttemptInput;
    const result = reduceAttempt(state, full, c);
    state = result.state;
    events.push(...result.events);
    return result;
  };
  return {
    get state() {
      return state;
    },
    events,
    feed,
    closed(b: TriggerBar, g?: DecisionGates) {
      return feed({ type: "BAR", receivedAt: b.receivedAt, bar: b, gates: g });
    },
    reference(
      r: TriggerBar,
      b = candidateAt(r.end, c)!,
      receivedAt = r.receivedAt,
    ) {
      return feed({ type: "REFERENCE", receivedAt, bar: r, candidate: b });
    },
    tick(
      price: string,
      at: number,
      token: string,
      previousSequence: string | null,
      extra: Record<string, unknown> = {},
      g?: DecisionGates,
    ) {
      return feed({
        type: "TICK",
        receivedAt: at,
        tick: {
          price,
          at,
          sessionId: c.sessionId,
          evidenceEpoch: c.evidenceEpoch,
          sequence: token,
          previousSequence,
          orderVerified: true,
          continuityVerified: true,
          ...extra,
        },
        gates: g ?? gates(at, price, { capability: "LIVE_TICK" }),
      });
    },
  };
}
function armed(c = config(), touch = bar(0)) {
  const h = harness(c);
  h.closed(touch);
  h.reference(touch);
  return h;
}
function crossingBar(start = M, extra: Partial<TriggerBar> = {}) {
  return bar(start, {
    open: "100.2",
    high: "100.7",
    low: "100.1",
    close: "100.61",
    ...extra,
  });
}
const entries = (events: TriggerEvent[]) =>
  events.filter((e) => e.type === "ENTRY_TRIGGERED");
const technicals = (events: TriggerEvent[]) =>
  events.filter((e) => e.type === "TECHNICAL_TRIGGERED");

describe("close-confirm deterministic attempt kernel", () => {
  it("T08 observes the first retest, freezes 100.61 and emits exactly one entry at equality", () => {
    const h = armed();
    const b = crossingBar();
    expect(h.state.status).toBe("ARMED");
    expect(h.state.reference?.threshold).toBe("100.61");
    h.closed(b, gates(b.receivedAt));
    expect(h.state.status).toBe("TRIGGERED");
    expect(technicals(h.events)).toHaveLength(1);
    expect(entries(h.events)).toHaveLength(1);
    expect(entries(h.events)[0].quantity).toBe(10);
  });
  it("T08/T09 does not treat a high or a close one tick below T as a close breakout", () => {
    for (const close of ["100.60", "100.50"]) {
      const h = armed();
      const b = crossingBar(M, { high: "100.80", close });
      h.closed(b, gates(b.receivedAt, close));
      expect(technicals(h.events)).toHaveLength(0);
      expect(h.state.status).toBe("ARMED");
    }
  });
  it("touching bar cannot itself trigger, even if its close breaks an earlier reference", () => {
    const h = harness();
    const r = bar(0, { high: "100.5", close: "100.4" });
    h.reference(r);
    h.closed(crossingBar(), gates(2 * M + 1_000));
    expect(h.state.status).toBe("ARMED");
    expect(entries(h.events)).toHaveLength(0);
  });
  it("T11 rolls reference only for the next candidate and preserves the original snapshot", () => {
    const h = armed();
    const b = crossingBar(M, { high: "100.8", close: "100.5" });
    h.closed(b, gates(b.receivedAt));
    expect(h.state.reference?.threshold).toBe("100.61");
    h.reference(b);
    expect(h.state.reference?.threshold).toBe("100.81");
    expect(h.state.references["1m:60000:120000"].threshold).toBe("100.61");
  });
  it("T12 chooses open-aligned 1m/5m periods and rejects the first-hour next candidate", () => {
    const c = config();
    expect(candidateAt(14 * M, c)).toEqual({
      start: 14 * M,
      end: 15 * M,
      period: "1m",
    });
    expect(candidateAt(15 * M, c)).toEqual({
      start: 15 * M,
      end: 20 * M,
      period: "5m",
    });
    expect(candidateAt(59 * M, c)).toEqual({
      start: 55 * M,
      end: 60 * M,
      period: "5m",
    });
    expect(candidateAt(60 * M, c)).toBeNull();
    const h = harness();
    h.reference(bar(-M), { start: 0, end: M, period: "1m" });
    expect(h.state.reference).toBeNull();
    expect(h.events[0].reasons).toContain("REFERENCE_NOT_ADJACENT_FINAL");
  });
  it("T12 accepts 10–15m 5m reference at the period switch, never a 1m substitute", () => {
    const h = harness();
    h.reference(bar(14 * M), { start: 15 * M, end: 20 * M, period: "5m" });
    expect(h.state.reference).toBeNull();
    h.reference(
      bar(10 * M, { period: "5m", end: 15 * M, receivedAt: 15 * M + 1_000 }),
    );
    expect(h.state.reference?.candidate.period).toBe("5m");
  });
  it("T13 gives stop priority over a simultaneous same-bar breakout", () => {
    const h = armed();
    const b = crossingBar(M, { low: "99.4" });
    h.closed(b, gates(b.receivedAt));
    expect(h.state.status).toBe("INVALID");
    expect(h.state.reason).toBe("STOP_REFERENCE_TOUCHED");
    expect(technicals(h.events)).toHaveLength(0);
  });
  it("an already received stop tick prevents a queued close from reviving the attempt", () => {
    const h = armed();
    h.tick("99.40", 2 * M + 500, "stop", null);
    const b = crossingBar();
    h.closed(b, gates(b.receivedAt));
    expect(h.state.status).toBe("INVALID");
    expect(entries(h.events)).toHaveLength(0);
  });
  it("fresh quote stop evidence also invalidates before technical consumption", () => {
    const h = armed();
    const b = crossingBar();
    h.closed(b, gates(b.receivedAt, "99.4"));
    expect(h.state.status).toBe("INVALID");
    expect(technicals(h.events)).toHaveLength(0);
  });
  it("T13/U02 accepts the final waiting-boundary bar plus 30s exactly; +31s is historical", () => {
    for (const delay of [2_000, 30_000, 31_000]) {
      const c = config();
      const h = harness(c);
      h.closed(bar(9 * M)); // touch 10m; wait deadline 25m
      const r = bar(15 * M, {
        low: "100.3",
        high: "100.6",
        open: "100.4",
        close: "100.5",
      });
      h.reference(r);
      const b = crossingBar(20 * M, { receivedAt: 25 * M + delay });
      h.closed(b, gates(b.receivedAt));
      expect(h.state.deadline).toBe(25 * M);
      expect(entries(h.events)).toHaveLength(delay <= 30_000 ? 1 : 0);
      expect(
        h.events.filter((e) => e.type === "HISTORICAL_TRIGGERED"),
      ).toHaveLength(delay > 30_000 ? 1 : 0);
    }
  });
  it("U02 clock at the market deadline leaves close grace; timer finalization retains late history", () => {
    const h = harness();
    h.closed(bar(40 * M)); // 45m touch, 60m deadline
    h.reference(bar(50 * M, { low: "100.3", high: "100.6", close: "100.5" }));
    h.feed({ type: "CLOCK", receivedAt: 60 * M });
    expect(h.state.status).toBe("ARMED");
    h.feed({ type: "CLOCK", receivedAt: 60 * M + 30_001 });
    expect(h.state.status).toBe("EXPIRED");
    const b = crossingBar(55 * M, { receivedAt: 60 * M + 31_000 });
    h.closed(b, gates(b.receivedAt));
    expect(entries(h.events)).toHaveLength(0);
    expect(h.events.some((e) => e.type === "HISTORICAL_TRIGGERED")).toBe(true);
  });
  it("T14 chase equality passes; 3.01% blocks; later low cannot rewrite the decision", () => {
    for (const price of ["103", "103.01"]) {
      const h = armed(config({ chaseFromLowMax: "0.03" }));
      const b = crossingBar();
      h.closed(
        b,
        gates(b.receivedAt, price, {
          lod: { price: "100", from: 0, through: b.receivedAt, complete: true },
        }),
      );
      expect(entries(h.events)).toHaveLength(price === "103" ? 1 : 0);
      const outcome = structuredClone(h.events);
      h.tick("95", 7 * 60 * M, "late", null);
      expect(h.events.slice(0, outcome.length)).toEqual(outcome);
    }
  });
  it("C06 blocks incomplete or mismatched LOD coverage without deleting the technical event", () => {
    for (const lod of [
      undefined,
      { price: "100", from: -M, through: 121_000, complete: true },
      { price: "100", from: 0, through: 120_000, complete: true },
    ]) {
      const h = armed(config({ chaseFromLowMax: "0.03" }));
      const b = crossingBar();
      h.closed(b, gates(b.receivedAt, "100.61", { lod }));
      expect(technicals(h.events)).toHaveLength(1);
      expect(entries(h.events)).toHaveLength(0);
      expect(h.state.reason).toContain("SESSION_LOW_INCOMPLETE");
    }
  });
  it("T15 UNKNOWN/DELAYED capability cannot create an actionable entry", () => {
    for (const capability of ["UNKNOWN", "DELAYED"] as const) {
      const h = armed();
      const b = crossingBar();
      h.closed(b, gates(b.receivedAt, "100.61", { capability }));
      expect(entries(h.events)).toHaveLength(0);
      expect(h.state.consumed).toBe(true);
      expect(h.state.reason).toContain("LIVE_CAPABILITY_UNAVAILABLE");
    }
  });
  it("demo historical with UNKNOWN capability still records an honest historical technical result", () => {
    const h = armed();
    const b = crossingBar();
    h.closed(
      b,
      gates(b.receivedAt, "100.61", {
        capability: "UNKNOWN",
        historical: true,
      }),
    );
    expect(entries(h.events)).toHaveLength(0);
    expect(
      h.events.filter((e) => e.type === "HISTORICAL_TRIGGERED"),
    ).toHaveLength(1);
    expect(technicals(h.events)[0].historical).toBe(true);
  });
  it("U03 consumes the first technical breakout even when risk fails; new funds cannot retry it", () => {
    const h = armed();
    const b = crossingBar();
    h.closed(
      b,
      gates(b.receivedAt, "100.61", {
        risk: {
          status: "BLOCKED",
          reasons: ["CASH_INSUFFICIENT"],
          quantity: 0,
        },
      }),
    );
    expect(h.state.status).toBe("USER_PAUSED");
    expect(h.state.reason).toBe("CASH_INSUFFICIENT");
    h.reference(b);
    const next = crossingBar(2 * M, { high: "100.9", close: "100.81" });
    h.closed(next, gates(next.receivedAt, next.close));
    expect(technicals(h.events)).toHaveLength(1);
    expect(entries(h.events)).toHaveLength(0);
  });
  it("C03 blocks either a technical price or the fresh price outside entry range", () => {
    const h = armed(config({ entryMax: "100.65" }));
    const b = crossingBar(M, { high: "100.8", close: "100.70" });
    h.closed(b, gates(b.receivedAt, "100.62"));
    expect(technicals(h.events)).toHaveLength(1);
    expect(entries(h.events)).toHaveLength(0);
    expect(h.state.reason).toContain("ENTRY_OUTSIDE_ALLOWED_RANGE");
  });
  it("U04 input replay and restart cannot duplicate an entry; pure inputs remain unmodified", () => {
    const c = config();
    const h = armed(c);
    const b = crossingBar();
    const initial = structuredClone(h.state);
    const input: AttemptInput = {
      type: "BAR",
      id: "entry-input",
      ingestSeq: 3,
      receivedAt: b.receivedAt,
      bar: b,
      gates: gates(b.receivedAt),
    };
    const result = reduceAttempt(initial, input, c);
    expect(initial).toEqual(h.state);
    let state = JSON.parse(JSON.stringify(result.state)) as AttemptState;
    for (let i = 0; i < 10; i++) {
      const repeat = reduceAttempt(state, input, c);
      expect(repeat.events).toEqual([]);
      state = repeat.state;
    }
    expect(entries(result.events)).toHaveLength(1);
  });
  it("U04 event keys remain non-null for no-reference failures", () => {
    const h = harness();
    h.reference(bar(-M), { start: 0, end: M, period: "1m" });
    h.reference(bar(-M), { start: 0, end: M, period: "1m" });
    expect(h.events).toHaveLength(1);
    expect(h.events[0].key).toBe("attempt-1:REFERENCE_UNAVAILABLE");
  });
  it("T16 reference revision and config drift pause without mutating previously frozen references", () => {
    const h = armed();
    const old = structuredClone(h.state.reference);
    h.feed({
      type: "REFERENCE_REVISED",
      receivedAt: 62_000,
      refBarId: "bar-0",
      revision: "2",
    });
    expect(h.state.status).toBe("DATA_PAUSED");
    expect(h.state.reference).toEqual(old);
    const b = crossingBar();
    h.closed(b, gates(b.receivedAt));
    expect(technicals(h.events)).toHaveLength(0);
    const fresh = armed();
    const changed = reduceAttempt(
      fresh.state,
      { type: "CLOCK", id: "change", ingestSeq: 3, receivedAt: 65_000 },
      config({ planVersion: 2 }),
    );
    expect(changed.state.reason).toBe("PLAN_VERSION_CHANGED");
  });
  it("C01 rejects stale, non-adjacent, unclosed and wrong-session references", () => {
    for (const r of [
      bar(0, { receivedAt: M + 30_001 }),
      bar(0, { final: false }),
      bar(0, { sessionId: "yesterday" }),
      bar(-M),
    ]) {
      const h = armed();
      const clean = harness(config(), {
        ...h.state,
        references: {},
        reference: null,
      });
      clean.reference(r, { start: M, end: 2 * M, period: "1m" });
      expect(clean.state.reference).toBeNull();
    }
    const h = harness();
    h.reference(bar(0, { receivedAt: M + 30_000 }));
    expect(h.state.reference?.readyAt).toBe(M + 30_000);
  });
  it("C05 late activation must verify all prior session history", () => {
    expect(
      createAttempt(
        config({ activatedAt: M, preActivationEvidence: "UNKNOWN" }),
      ).status,
    ).toBe("DATA_PAUSED");
    expect(
      createAttempt(
        config({ activatedAt: M, preActivationEvidence: "TOUCHED" }),
      ).status,
    ).toBe("INVALID");
    expect(
      createAttempt(
        config({ activatedAt: M, preActivationEvidence: "NO_TOUCH" }),
      ).status,
    ).toBe("WAIT_RETEST");
  });
  it("C05 recovery requires new above-zone evidence and never resets the old disconnected attempt", () => {
    const old = armed();
    old.feed({
      type: "DATA_GAP",
      receivedAt: 62_000,
      reason: "CONNECTION_GAP",
    });
    old.closed(crossingBar(), gates(121_000));
    expect(old.state.status).toBe("DATA_PAUSED");
    expect(entries(old.events)).toHaveLength(0);
    const h = harness(
      config({
        attemptId: "recovery-2",
        evidenceEpoch: "epoch-2",
        template: "RECOVERY",
        activatedAt: M,
      }),
    );
    h.closed(bar(M));
    expect(h.state.status).toBe("WAIT_RETEST");
    h.closed(bar(2 * M, { low: "100.4", close: "100.5" }));
    expect(h.state.aboveEvidence).toBe(true);
    h.closed(bar(3 * M));
    expect(h.state.status).toBe("ARMED");
    expect(h.state.template).toBe("RECOVERY");
    expect(h.state.evidenceEpoch).toBe("epoch-2");
  });
});

describe("ordered intrabar mode", () => {
  function tickHarness(extra: Partial<AttemptConfig> = {}) {
    const h = harness(config({ mode: "INTRABAR_CROSS", ...extra }));
    h.reference(bar(0));
    return h;
  }
  it("T09/T10 ordered touch then cross emits once; fade and stop append evidence only", () => {
    const h = tickHarness();
    h.tick("100.2", 62_000, "p7", null);
    h.tick("100.60", 63_000, "p9", "p7");
    h.tick("100.62", 64_000, "p20", "p9");
    expect(entries(h.events)).toHaveLength(1);
    expect(h.state.reference?.threshold).toBe("100.61");
    h.closed(crossingBar(M, { close: "100.50" }));
    h.tick("99.4", 122_000, "p21", "p20");
    expect(h.events.filter((e) => e.type === "BREAKOUT_FADED")).toHaveLength(1);
    expect(
      h.events.filter((e) => e.type === "STOP_REFERENCE_TOUCHED"),
    ).toHaveLength(1);
    expect(entries(h.events)).toHaveLength(1);
    expect(h.state.status).toBe("TRIGGERED");
  });
  it("T10 a pre-touch cross and OHLC high cannot reconstruct causality", () => {
    const h = tickHarness();
    h.tick("100.60", 62_000, "a", null);
    h.tick("100.62", 63_000, "b", "a");
    h.tick("100.2", 64_000, "c", "b");
    h.closed(crossingBar());
    expect(entries(h.events)).toHaveLength(0);
    expect(h.state.status).toBe("ARMED");
  });
  it("C01 ignores a cross using a trade from before reference readiness", () => {
    const h = harness(config({ mode: "INTRABAR_CROSS" }));
    h.tick("100.2", 60_100, "a", null);
    h.tick("100.60", 60_500, "b", "a");
    h.reference(bar(0));
    h.tick("100.62", 61_500, "c", "b");
    expect(entries(h.events)).toHaveLength(0);
    h.tick("100.60", 62_000, "d", "c");
    h.tick("100.62", 62_500, "e", "d");
    expect(entries(h.events)).toHaveLength(1);
  });
  it("U12 trusted non-contiguous opaque sequence tokens and same-second trades remain ordered", () => {
    const h = tickHarness();
    h.tick("100.2", 62_000, "packet-7:0", null);
    h.tick("100.60", 62_000, "packet-19:0", "packet-7:0");
    h.tick("100.62", 62_000, "packet-19:1", "packet-19:0");
    expect(entries(h.events)).toHaveLength(1);
  });
  it("U12 duplicate provider token does not become a new crossing", () => {
    const h = tickHarness();
    h.tick("100.2", 62_000, "a", null);
    h.tick("100.60", 63_000, "b", "a");
    h.tick("100.60", 63_000, "b", "a");
    expect(entries(h.events)).toHaveLength(0);
    expect(h.state.lastTick?.price).toBe("100.60");
  });
  it("the same provider identity with conflicting contents pauses instead of creating a cross", () => {
    const h = tickHarness();
    h.tick("100.2", 62_000, "a", null);
    h.tick("100.60", 63_000, "b", "a");
    h.tick("100.62", 63_000, "b", "a");
    expect(entries(h.events)).toHaveLength(0);
    expect(h.state.status).toBe("DATA_PAUSED");
    expect(h.state.reason).toBe("TICK_SEQUENCE_CONFLICT");
  });
  it("U12 missing order, missing sequence, broken chain or epoch causes data pause", () => {
    for (const extra of [
      { sequence: null },
      { orderVerified: false },
      { continuityVerified: false },
      { evidenceEpoch: "new-epoch" },
      { previousSequence: "unseen" },
    ]) {
      const h = tickHarness();
      h.tick("100.2", 62_000, "a", null);
      h.tick("100.62", 63_000, "b", "a", extra);
      expect(h.state.status).toBe("DATA_PAUSED");
      expect(entries(h.events)).toHaveLength(0);
    }
  });
  it("touching bar close below support invalidates an unconsumed intrabar attempt", () => {
    const h = tickHarness();
    h.tick("100.2", 62_000, "a", null);
    h.closed(bar(M, { low: "99.5", close: "99.6" }));
    expect(h.state.status).toBe("INVALID");
    expect(h.state.reason).toBe("TOUCH_BAR_CLOSED_BELOW_SUPPORT");
  });
  it("cannot borrow close grace or use a cross across candidate boundaries", () => {
    const h = tickHarness();
    h.tick("100.2", 62_000, "a", null);
    h.tick("100.60", 119_000, "b", "a");
    h.reference(bar(M, { receivedAt: 120_000 }));
    h.tick("100.62", 120_001, "c", "b");
    expect(entries(h.events)).toHaveLength(0);
    h.tick("100.60", h.state.deadline, "d", "c");
    expect(h.state.status).toBe("EXPIRED");
  });
  it("same-bar historical low cannot be presented as a post-trigger stop touch", () => {
    const h = tickHarness();
    h.tick("100.2", 62_000, "a", null);
    h.tick("100.62", 63_000, "b", "a");
    h.closed(crossingBar(M, { low: "99.3", close: "100.62" }));
    expect(h.events.some((e) => e.type === "STOP_REFERENCE_TOUCHED")).toBe(
      false,
    );
  });
});

describe("numeric and invariant checks", () => {
  it("uses exact decimal next-price arithmetic across verified tick bands", () => {
    expect(nextLegalPriceAbove("100.60", { tick: "0.01" })).toBe("100.61");
    expect(
      nextLegalPriceAbove("9.99", {
        tick: "0.01",
        priceBands: [
          { from: "0", tick: "0.01" },
          { from: "10", tick: "0.05" },
        ],
      }),
    ).toBe("10");
    expect(
      nextLegalPriceAbove("10", {
        tick: "0.01",
        priceBands: [
          { from: "0", tick: "0.01" },
          { from: "10", tick: "0.05" },
        ],
      }),
    ).toBe("10.05");
  });
  it("property: replaying arbitrary numbers of repeated crossings never creates another entry", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (count) => {
        const h = armed();
        const b = crossingBar();
        h.closed(b, gates(b.receivedAt));
        for (let i = 0; i < count; i++) h.closed(b, gates(b.receivedAt));
        expect(entries(h.events)).toHaveLength(1);
        expect(technicals(h.events)).toHaveLength(1);
        expect(h.state.consumed).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
