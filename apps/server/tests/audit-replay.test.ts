import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Funds, Instrument } from "../../../packages/contracts/index.js";
import {
  createAttempt,
  reduceAttempt,
  type AttemptConfig,
  type AttemptInput,
  type TriggerBar,
  type TriggerEvent,
} from "../../../packages/domain/trigger.js";
import { solveRisk } from "../../../packages/domain/risk.js";
import {
  auditDecisionInput,
  AUDIT_ALGORITHM_VERSION,
} from "../audit-replay.js";
import { Store } from "../store.js";

const open = Date.parse("2026-10-09T13:30:00Z");
const now = Date.parse("2026-10-12T10:00:00Z");
const instrument: Instrument = {
  id: "ARCHIVED-A",
  symbol: "ARCHIVED-A.US",
  name: "Archived fixture",
  market: "US",
  currency: "USD",
  tick: "0.01",
  qMin: 1,
  qStep: 1,
  sellSameDay: true,
  rulesVerified: true,
};
const funds: Funds = {
  generation: 3,
  nav: "10000",
  baseCurrency: "USD",
  cash: { USD: "10000", CNY: "0" },
  existing: {},
  riskBudget: "50",
  riskPool: "100",
  maxWeight: "0.2",
  fx: { USD: "1", CNY: "0.14" },
  fxAsOf: now,
  confirmedAt: now,
  stale: false,
  buyFee: "0",
  sellFee: "0",
  slippageIn: "0",
  slippageOut: "0",
  feesConfirmed: true,
};
function fixture(withRisk = false) {
  const config: AttemptConfig = {
    attemptId: "audit-attempt-1",
    planId: "audit-plan-1",
    planVersion: 2,
    sessionId: "archive:2026-10-09",
    sessionOpenAt: open,
    activatedAt: open - 1,
    mode: "CLOSE_CONFIRM",
    lower: "99.75",
    upper: "100.25",
    stop: "99.4",
    entryMin: "100.61",
    entryMax: "101.5",
    tick: "0.01",
    previousDayClose: "101",
    evidenceEpoch: "epoch-audit-1",
    template: "SESSION_FIRST",
    preActivationEvidence: "NO_TOUCH",
  };
  const plan = {
    id: config.planId,
    instrumentId: instrument.id,
    entryMin: config.entryMin,
    entryMax: config.entryMax,
    stop: config.stop,
    approvedQuantity: 19,
  };
  const simulationClock = {
    sessionOpenAt: open,
    quoteAt: open + 120000,
    receivedAt: open + 121000,
  };
  const scenarioFunds = { ...funds, confirmedAt: open, fxAsOf: open };
  const risk = solveRisk({
    instrument,
    funds: scenarioFunds,
    entryCheck: "100.7",
    entryMin: plan.entryMin,
    entryMax: plan.entryMax,
    stop: plan.stop,
    now: simulationClock.receivedAt,
    quoteAsOf: simulationClock.quoteAt,
    sessionStartedAt: open,
    approvedQuantity: plan.approvedQuantity,
    phase: "TRIGGER",
    reservations: { cash: "0", riskBase: "0", exposureBase: "0" },
  });
  const bar: TriggerBar = {
    id: "b-1",
    sessionId: config.sessionId,
    start: open,
    end: open + 60000,
    period: "1m",
    open: "100.5",
    high: "100.6",
    low: "100",
    close: "100.2",
    final: true,
    revision: "frozen-1",
    receivedAt: open + 61000,
  };
  const candidate: TriggerBar = {
    ...bar,
    id: "b-2",
    start: open + 60000,
    end: open + 120000,
    open: "100.3",
    high: "100.8",
    low: "100.1",
    close: "100.7",
    receivedAt: open + 121000,
  };
  const inputs: AttemptInput[] = [
    {
      type: "BAR",
      id: "input-1",
      ingestSeq: 1,
      receivedAt: bar.receivedAt,
      bar,
    },
    {
      type: "REFERENCE",
      id: "input-2",
      ingestSeq: 2,
      receivedAt: bar.receivedAt,
      candidate: { start: candidate.start, end: candidate.end, period: "1m" },
      bar,
    },
    {
      type: "BAR",
      id: "input-3",
      ingestSeq: 3,
      receivedAt: candidate.receivedAt,
      bar: candidate,
      gates: {
        capability: withRisk ? "UNKNOWN" : "LIVE_CLOSED_BAR",
        dataHealthy: true,
        quote: { price: candidate.close, at: candidate.end },
        historical: withRisk,
        risk: { status: "PASS", reasons: [], quantity: risk.quantity },
      },
    },
  ];
  const snapshot: Record<string, unknown> = {
    algorithmVersion: AUDIT_ALGORITHM_VERSION,
    config,
    inputs,
    ...reduce(config, inputs),
    ...(withRisk
      ? {
          synthetic: true,
          plan,
          planVersion: { instrument },
          funds,
          scenarioFunds,
          simulationClock,
          reservations: [
            {
              planId: plan.id,
              instrumentId: plan.instrumentId,
              currency: "USD",
              cash: "1928.5",
              riskBase: "39.9",
              exposureBase: "1928.5",
              state: "ACTIVE",
            },
          ],
          risk,
          decisionTime: now,
        }
      : {}),
  };
  return snapshot;
}
function reduce(config: AttemptConfig, inputs: AttemptInput[]) {
  let state = createAttempt(config);
  const emitted: TriggerEvent[] = [];
  for (const input of inputs) {
    const next = reduceAttempt(state, input, config);
    state = next.state;
    emitted.push(...next.events);
  }
  return { state, emitted };
}
function payload(
  snapshot: Record<string, unknown>,
  serializedInput = JSON.stringify(snapshot),
) {
  return {
    snapshot,
    serializedInput,
    expectedInputHash: createHash("sha256")
      .update(serializedInput)
      .digest("hex"),
  };
}
function recalculate(snapshot: Record<string, unknown>) {
  Object.assign(
    snapshot,
    reduce(snapshot.config as AttemptConfig, snapshot.inputs as AttemptInput[]),
  );
}
function readPersisted(store: Store, id = "event-1") {
  const row = store.db
    .prepare(
      "SELECT i.json, e.input_hash FROM decision_inputs i JOIN decision_events e ON e.input_hash=i.hash WHERE e.id=?",
    )
    .get(id) as { json: string; input_hash: string };
  return auditDecisionInput({
    snapshot: JSON.parse(row.json),
    serializedInput: row.json,
    expectedInputHash: row.input_hash,
  });
}

describe("persisted-input decision audit", () => {
  it("replays arbitrary archived closed-bar inputs, not a demo generator, and leaves the caller's values untouched", () => {
    const snapshot = fixture();
    const before = JSON.stringify(snapshot);
    const result = auditDecisionInput(payload(snapshot));
    expect(result.status).toBe("MATCH");
    expect(result.original).toEqual(result.replayed);
    expect(result.replayed?.eventTypes).toEqual([
      "RETEST_OBSERVED",
      "TECHNICAL_TRIGGERED",
      "ENTRY_TRIGGERED",
    ]);
    expect(result.coverage).toEqual({
      trigger: "VERIFIED",
      risk: "FROZEN_GATE_ONLY",
      scope: "PERSISTED_INPUTS_ONLY",
    });
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it("recomputes the final archived risk from frozen funds, rules, reservations and original quote", () => {
    const result = auditDecisionInput(payload(fixture(true)));
    expect(result.status).toBe("MATCH");
    expect(result.coverage.risk).toBe("RECOMPUTED");
    expect(result.original).toEqual(result.replayed);
    expect(result.replayed?.eventTypes).toEqual([
      "RETEST_OBSERVED",
      "TECHNICAL_TRIGGERED",
      "HISTORICAL_TRIGGERED",
    ]);
  });
  it("validates the exact original JSON bytes rather than canonical reserialization", () => {
    const snapshot = fixture();
    const serialized = JSON.stringify(snapshot, null, 2);
    expect(auditDecisionInput(payload(snapshot, serialized)).status).toBe(
      "MATCH",
    );
    const input = payload(snapshot, serialized);
    input.serializedInput = JSON.stringify(snapshot);
    expect(auditDecisionInput(input).reasons).toEqual(["INPUT_HASH_MISMATCH"]);
  });
  it("rejects tampered input before it can replay", () => {
    const input = payload(fixture());
    input.serializedInput = input.serializedInput.replace('"100.7"', '"100.9"');
    const result = auditDecisionInput(input);
    expect(result.status).toBe("MISMATCH");
    expect(result.reasons).toEqual(["INPUT_HASH_MISMATCH"]);
    expect(result.replayed).toBeNull();
  });
  it("rejects a caller snapshot that differs from the verified persisted JSON", () => {
    const input = payload(fixture());
    input.snapshot.algorithmVersion = "forged";
    expect(auditDecisionInput(input).reasons).toEqual([
      "SERIALIZED_INPUT_MISMATCH",
    ]);
  });
  it("checks state and full event contents even when a mutated snapshot has a matching hash", () => {
    const changedState = fixture();
    (changedState.state as Record<string, unknown>).consumed = false;
    const stateResult = auditDecisionInput(payload(changedState));
    expect(stateResult.status).toBe("MISMATCH");
    expect(
      stateResult.checks.find((c) => c.name === "attemptState")?.status,
    ).toBe("FAIL");
    const changedEvent = fixture();
    (changedEvent.emitted as TriggerEvent[])[0].time += 1;
    const eventResult = auditDecisionInput(payload(changedEvent));
    expect(eventResult.status).toBe("MISMATCH");
    expect(
      eventResult.checks.find((c) => c.name === "emittedEvents")?.status,
    ).toBe("FAIL");
  });
  it("retains input order and rejects duplicate IDs with conflicting content", () => {
    const outOfOrder = fixture();
    (outOfOrder.inputs as AttemptInput[])[1].ingestSeq = 1;
    expect(auditDecisionInput(payload(outOfOrder)).reasons).toEqual([
      "INGEST_SEQUENCE_INVALID",
    ]);
    const conflict = fixture();
    const inputs = conflict.inputs as AttemptInput[];
    inputs.push({ ...inputs[0], receivedAt: inputs[0].receivedAt + 1 });
    expect(auditDecisionInput(payload(conflict)).reasons).toEqual([
      "DUPLICATE_INPUT_CONFLICT",
    ]);
  });
  it("audits exact duplicate deliveries without double emitting or rejecting legitimate idempotency", () => {
    const snapshot = fixture();
    const inputs = snapshot.inputs as AttemptInput[];
    inputs.splice(1, 0, structuredClone(inputs[0]));
    recalculate(snapshot);
    const result = auditDecisionInput(payload(snapshot));
    expect(result.status).toBe("MATCH");
    expect(result.replayed?.eventTypes).toHaveLength(3);
    expect(
      result.checks.find((c) => c.name === "ingestSequence")?.detail,
    ).toContain("1 项完全相同");
  });
  it("replays persisted timer and gap facts without obtaining a new wall clock", () => {
    const snapshot = fixture();
    const inputs: AttemptInput[] = [
      {
        type: "DATA_GAP",
        id: "gap-1",
        ingestSeq: 11,
        receivedAt: open + 30000,
        reason: "SOURCE_DISCONNECTED",
      },
      {
        type: "CLOCK",
        id: "clock-1",
        ingestSeq: 12,
        receivedAt: open + 3600000 + 30001,
      },
    ];
    snapshot.inputs = inputs;
    recalculate(snapshot);
    const result = auditDecisionInput(payload(snapshot));
    expect(result.status).toBe("MATCH");
    expect(result.replayed?.eventTypes).toEqual(["DATA_PAUSED", "EXPIRED"]);
  });
  it.each([undefined, "pullback-c01-c07-v0", "future-v2"])(
    "does not substitute the current algorithm for unknown version %s",
    (version) => {
      const snapshot = fixture();
      snapshot.algorithmVersion = version;
      const parsed = JSON.parse(JSON.stringify(snapshot));
      const result = auditDecisionInput(payload(parsed));
      expect(result.status).toBe("UNSUPPORTED");
      expect(result.reasons).toEqual(["ALGORITHM_VERSION_UNSUPPORTED"]);
      expect(result.replayed).toBeNull();
    },
  );
  it("reports missing input structures and missing archived risk sources as unsupported", () => {
    const old = {
      algorithmVersion: AUDIT_ALGORITHM_VERSION,
      funds,
      state: { status: "DATA_PAUSED" },
    };
    expect(auditDecisionInput(payload(old)).reasons).toEqual([
      "SNAPSHOT_SCHEMA_UNSUPPORTED",
    ]);
    const partialRisk = fixture(true);
    delete partialRisk.reservations;
    const result = auditDecisionInput(payload(partialRisk));
    expect(result.status).toBe("UNSUPPORTED");
    expect(result.coverage.trigger).toBe("VERIFIED");
    expect(result.coverage.risk).toBe("FROZEN_GATE_ONLY");
    expect(result.reasons).toEqual(["RISK_SNAPSHOT_UNSUPPORTED"]);
  });
  it("detects changed final risk and contradictory frozen scenario funding", () => {
    const snapshot = fixture(true);
    (snapshot.risk as Record<string, unknown>).quantity = 18;
    expect(auditDecisionInput(payload(snapshot)).reasons).toEqual([
      "RISK_OUTPUT_MISMATCH",
    ]);
    const inconsistent = fixture(true);
    (inconsistent.scenarioFunds as Funds).cash = { USD: "9000", CNY: "0" };
    expect(auditDecisionInput(payload(inconsistent)).reasons).toEqual([
      "RISK_FROZEN_CONTEXT_MISMATCH",
    ]);
  });
  it("has no DB side effects or dependency on later market, funds, anchors, acknowledgements or feedback", () => {
    const store = new Store();
    try {
      const input = payload(fixture(true));
      store.db
        .prepare("INSERT INTO decision_inputs(hash,json) VALUES(?,?)")
        .run(input.expectedInputHash, input.serializedInput);
      store.db
        .prepare(
          "INSERT INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES(?,?,?,?,?,?)",
        )
        .run(
          "event-1",
          "audit-attempt-1",
          "HISTORICAL_TRIGGERED",
          "audit-attempt-1:entry",
          input.expectedInputHash,
          JSON.stringify({ id: "event-1" }),
        );
      store.db
        .prepare("INSERT INTO notifications VALUES(?,?)")
        .run("event-1", now);
      const initial = readPersisted(store);
      expect(initial.status).toBe("MATCH");
      store.setSetting("current_anchor", "changed-after-decision");
      store.setSetting("latest_quote", "9999");
      store.db
        .prepare("INSERT INTO account_snapshots VALUES(?,?)")
        .run(
          999,
          JSON.stringify({ ...funds, generation: 999, nav: "1", stale: true }),
        );
      store.setSetting("funds_generation", "999");
      store.db
        .prepare("INSERT INTO notification_ack VALUES(?,?)")
        .run("event-1", now + 1000);
      store.db
        .prepare("INSERT INTO record_revisions VALUES(?,?,?,?)")
        .run(
          "feedback-1",
          "event-1",
          now + 1000,
          JSON.stringify({ kind: "SKIPPED", note: "later" }),
        );
      const before = store.db.serialize();
      expect(readPersisted(store)).toEqual(initial);
      expect(readPersisted(store)).toEqual(initial);
      expect(store.db.serialize().equals(before)).toBe(true);
      expect(store.decisionInput("event-1")).toEqual(input.snapshot);
    } finally {
      store.close();
    }
  });
});

it("serves authenticated read-only audit of an actual committed decision, without replaying the demo or changing its feedback", async () => {
  const { createApp } = await import("../app.js");
  const app = await createApp({
    password: "audit-test-password",
    demo: true,
    now: () => now,
  });
  try {
    const marker = { "x-requested-with": "PullbackLab" };
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: marker,
      payload: { password: "audit-test-password" },
    });
    expect(login.statusCode).toBe(200);
    const headers = {
      ...marker,
      cookie: String(login.headers["set-cookie"]).split(";")[0],
    };
    const post = async (url: string, payload?: object) => {
      const response = await app.inject({
        method: "POST",
        url,
        headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    await post("/api/demo/seed");
    await post("/api/settings/screening", { confirmed: true });
    await post("/api/funds", { ...funds, expectedGeneration: 0 });
    const plan = await post("/api/plans", {
      instrumentId: "DEMO-US-A",
      anchorTime: null,
      primarySupport: "100",
      lower: "99.75",
      upper: "100.25",
      stop: "99.4",
      entryMin: "100.61",
      entryMax: "101.5",
      mode: "CLOSE_CONFIRM",
      sessionDate: "2026-10-09",
      reason: "仅合成审计集成测试",
      backgroundConfirmed: true,
      supportSelections: [
        { source: "EMA9" },
        { source: "HORIZONTAL", id: "main", price: "100", label: "人工水平线" },
      ],
    });
    const { plan: activePlan } = await post(`/api/plans/${plan.id}/activate`, {
      expectedVersion: plan.version,
      expectedAttemptId: plan.attemptId ?? null,
    });
    const { events } = await post(`/api/demo/plans/${plan.id}/replay`, {
      expectedVersion: activePlan.version,
      expectedAttemptId: activePlan.attemptId,
    });
    const final = events.find(
      (event: { type: string }) => event.type === "HISTORICAL_TRIGGERED",
    );
    expect(final).toBeDefined();
    expect(
      (await app.inject({ url: `/api/events/${final.id}/replay` })).statusCode,
    ).toBe(401);
    const original = app.store.decisionInput(final.id);
    const before = app.store.db.serialize();
    const audited = await app.inject({
      url: `/api/events/${final.id}/replay`,
      headers,
    });
    expect(audited.statusCode).toBe(200);
    expect(audited.json().status, audited.body).toBe("MATCH");
    expect(audited.json().coverage.risk).toBe("RECOMPUTED");
    expect(app.store.db.serialize().equals(before)).toBe(true);
    expect(app.store.decisionInput(final.id)).toEqual(original);
    await post(`/api/events/${final.id}/feedback`, {
      kind: "SKIPPED",
      note: "审计后更新反馈",
    });
    const beforeSecond = app.store.db.serialize();
    const auditedAgain = await app.inject({
      url: `/api/events/${final.id}/replay`,
      headers,
    });
    expect(auditedAgain.json()).toEqual(audited.json());
    expect(app.store.db.serialize().equals(beforeSecond)).toBe(true);
    expect(app.store.decisionInput(final.id)).toEqual(original);
  } finally {
    await app.close();
  }
});
