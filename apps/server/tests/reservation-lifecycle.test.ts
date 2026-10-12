import { afterEach, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import type {
  Funds,
  Plan,
  PlanInput,
} from "../../../packages/contracts/index.js";
import {
  demoInstruments,
  generateDemoBars,
} from "../../../packages/market-data/fixtures.js";
import { Store } from "../store.js";
import { actionTestManifest } from "../../../packages/market-data/action-evidence-fixture.js";
import { ActionEvidenceRepository } from "../../../packages/market-data/action-evidence.js";

const now = Date.parse("2026-10-12T10:00:00Z");
const sessionOpenAt = Date.parse("2026-10-09T13:30:00Z");
const input: PlanInput = {
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
  reason: "合成预留生命周期样本",
  backgroundConfirmed: true,
  supportSelections: [
    { source: "EMA9" },
    { source: "HORIZONTAL", id: "main", price: "100", label: "水平支撑" },
  ],
};
const funds: Funds = {
  generation: 0,
  nav: "100000",
  baseCurrency: "USD",
  cash: { USD: "100000", CNY: "0" },
  existing: {},
  riskBudget: "50",
  riskPool: "1000",
  maxWeight: "1",
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
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = new Store();
  stores.push(store);
  store.putInstrument({
    instrument: demoInstruments[0],
    tags: [],
    note: "synthetic",
    manual: false,
  });
  for (const period of ["1D", "1m", "5m"] as const)
    store.putBars(
      input.instrumentId,
      period,
      generateDemoBars(input.instrumentId, period),
    );
  store.updateFunds(funds, 0, now);
  return store;
}
function activate(store: Store) {
  const plan = store.createPlan(input, now);
  return store.activate(plan.id, plan.version, now).plan;
}
function trigger(store: Store, plan: Plan) {
  const events = store.commitTechnical(
    plan.id,
    plan.version,
    plan.attemptId!,
    {
      entry: "100.8",
      time: sessionOpenAt + 2 * 60_000,
      receivedAt: sessionOpenAt + 2 * 60_000 + 1_000,
      refId: "synthetic:reference",
      historical: true,
      snapshot: { synthetic: true },
      simulationClock: {
        sessionOpenAt,
        quoteAt: sessionOpenAt + 2 * 60_000 + 1_000,
        receivedAt: sessionOpenAt + 2 * 60_000 + 1_000,
      },
    },
    now,
  );
  expect(events.map((event) => event.type)).toEqual([
    "TECHNICAL_TRIGGERED",
    "HISTORICAL_TRIGGERED",
  ]);
  return events[1];
}
function immutableRows(store: Store) {
  return [
    "plan_versions",
    "decision_events",
    "decision_inputs",
    "record_revisions",
  ].map((table) =>
    store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}

describe("reservation lifecycle boundaries", () => {
  it("imports action evidence and pauses active plans atomically without changing frozen inputs or reservations", () => {
    const store = setup(),
      plan = activate(store),
      m = actionTestManifest();
    const frozen = store.planVersion(plan),
      reserves = store.reservations();
    const beforeEvents = store.events();
    expect(store.importActionEvidence(m, now, true).status).toBe("PREVIEW");
    expect(store.plan(plan.id).status).toBe("WAIT_RETEST");
    store.db.exec(
      "CREATE TRIGGER reject_action_pause BEFORE INSERT ON decision_events BEGIN SELECT RAISE(ABORT,'pause unavailable'); END;",
    );
    expect(() => store.importActionEvidence(m, now)).toThrow(
      "pause unavailable",
    );
    expect(
      new ActionEvidenceRepository(store.db).latest(m.instrumentId),
    ).toBeNull();
    expect(store.plan(plan.id).status).toBe("WAIT_RETEST");
    expect(store.events()).toEqual(beforeEvents);
    store.db.exec("DROP TRIGGER reject_action_pause");
    const imported = store.importActionEvidence(m, now);
    expect(imported.status).toBe("IMPORTED");
    expect(store.plan(plan.id).status).toBe("DATA_PAUSED");
    expect(store.planVersion(plan)).toEqual(frozen);
    expect(store.reservations()).toEqual(reserves);
    expect(
      store
        .events()
        .some(
          (e) =>
            e.type === "DATA_PAUSED" &&
            e.reasons.includes("CORPORATE_ACTION_EVIDENCE_CHANGED"),
        ),
    ).toBe(true);
    const events = store.events();
    expect(
      events.find((e) => e.type === "DATA_PAUSED")?.snapshot
        .corporateActionEvidenceVersion,
    ).toBe(imported.version);
    expect(store.importActionEvidence(m, now + 1).status).toBe("DUPLICATE");
    expect(store.events()).toEqual(events);
  });
  it("keeps TAKEN_PENDING when new corporate action evidence arrives", () => {
    const store = setup(),
      plan = activate(store),
      event = trigger(store, plan);
    store.feedback(event.id, { kind: "TAKEN", note: "合成" }, now);
    const pending = store.reservations(),
      facts = immutableRows(store);
    store.importActionEvidence(actionTestManifest(), now);
    expect(store.reservations()).toEqual(pending);
    expect(store.plan(plan.id).status).toBe("TAKEN");
    expect(immutableRows(store)).toEqual(facts);
  });
  it("keeps reported trades locked across editing, pausing and expiry until funds reconciliation", () => {
    const store = setup();
    const plan = activate(store);
    const event = trigger(store, plan);
    store.feedback(event.id, { kind: "TAKEN", note: "实际价量尚未填写" }, now);
    const pending = store.reservations()[0];
    const immutable = immutableRows(store);
    expect(pending.state).toBe("TAKEN_PENDING");
    expect(() => store.pause(plan.id, plan.version, now)).toThrow(/已经完成/);
    expect(store.plan(plan.id).status).toBe("TAKEN");
    const edited = store.updatePlan(
      plan.id,
      { ...input, reason: "新版本草稿" },
      plan.version,
      now,
    );
    expect(store.reservations()[0]).toEqual(pending);
    store.pause(edited.id, edited.version, now);
    store.recordReplayState(
      edited.id,
      edited.version,
      "EXPIRED",
      now,
      { synthetic: true },
      [],
    );
    expect(store.reservations()[0]).toEqual(pending);
    expect(store.risk(store.plan(plan.id), now)).toMatchObject({
      passed: false,
      quantity: 0,
      reasons: ["TAKEN_RECONCILIATION_REQUIRED"],
    });
    expect(() => store.activate(plan.id, edited.version, now)).toThrow(
      /已交易占用尚待核对/,
    );
    // The old plan version and original entry evidence remain byte-for-byte unchanged.
    expect(immutableRows(store)[0][0]).toEqual(immutable[0][0]);
    expect(immutableRows(store)[1].slice(0, 2)).toEqual(immutable[1]);
    expect(immutableRows(store)[2].slice(0, 1)).toEqual(immutable[2]);
    expect(immutableRows(store)[3]).toEqual(immutable[3]);
    store.updateFunds(
      {
        ...funds,
        cash: { USD: "97000", CNY: "0" },
        existing: { [input.instrumentId]: "3000" },
      },
      2,
      now,
    );
    expect(store.reservations()[0].state).toBe("RELEASED");
    expect(store.funds()).toMatchObject({ generation: 3, stale: false });
    expect(
      store.activate(plan.id, edited.version, now).plan.attemptId,
    ).not.toBe(plan.attemptId);
  });

  it("does not unlock a reported trade after correcting its feedback to skipped", () => {
    const store = setup();
    const plan = activate(store);
    const event = trigger(store, plan);
    store.feedback(event.id, { kind: "TAKEN", note: "" }, now);
    store.feedback(
      event.id,
      { kind: "SKIPPED", note: "记录更正仍需重新核对实际账户" },
      now,
    );
    const pending = store.reservations()[0];
    expect(pending.state).toBe("TAKEN_PENDING");
    expect(() => store.pause(plan.id, plan.version, now)).toThrow(/已经完成/);
    const edited = store.updatePlan(plan.id, input, plan.version, now);
    store.pause(edited.id, edited.version, now);
    expect(store.reservations()[0]).toEqual(pending);
    expect(store.funds()).toMatchObject({ generation: 2, stale: true });
    expect(() => store.activate(plan.id, edited.version, now)).toThrow(
      /已交易占用尚待核对/,
    );
  });

  it("never releases a newer attempt when an older skipped record is corrected", () => {
    const store = setup();
    const first = activate(store);
    const event = trigger(store, first);
    store.feedback(event.id, { kind: "SKIPPED", note: "首次跳过" }, now);
    const second = store.activate(first.id, first.version, now).plan;
    const reservation = store.reservations()[0];
    store.feedback(event.id, { kind: "SKIPPED", note: "补充旧记录备注" }, now);
    expect(store.plan(first.id).attemptId).toBe(second.attemptId);
    expect(store.plan(first.id).status).toBe("WAIT_RETEST");
    expect(store.reservations()[0]).toEqual(reservation);
    store.feedback(
      event.id,
      { kind: "TAKEN", note: "旧记录更正为已交易" },
      now,
    );
    expect(store.funds()).toMatchObject({ generation: 2, stale: true });
    expect(store.reservations()[0]).toEqual(reservation);
    store.feedback(event.id, { kind: "SKIPPED", note: "再次更正" }, now);
    expect(store.reservations()[0]).toEqual(reservation);
    expect(store.funds()).toMatchObject({ generation: 2, stale: true });
  });

  it("retains a later pending entry before rebuilding earlier unconsumed plans in allocation order", () => {
    const store = setup();
    const first = activate(store);
    const second = activate(store);
    const last = activate(store);
    trigger(store, last);
    const originals = store.reservations();
    const pending = originals.find((r) => r.planId === last.id)!;
    const immutable = immutableRows(store);
    const cash = new Decimal(pending.cash).plus(500).toFixed();
    store.updateFunds({ ...funds, cash: { USD: cash, CNY: "0" } }, 1, now);
    const rebuilt = store.reservations();
    expect(rebuilt.find((r) => r.planId === last.id)).toEqual({
      ...pending,
      generation: 2,
    });
    expect(store.plan(last.id).status).toBe("TRIGGERED");
    expect(rebuilt.find((r) => r.planId === first.id)).toMatchObject({
      state: "ACTIVE",
      quantity: 4,
      allocationOrder: originals[0].allocationOrder,
      generation: 2,
    });
    expect(rebuilt.find((r) => r.planId === second.id)?.state).toBe("RELEASED");
    expect(store.plan(second.id).status).toBe("DATA_PAUSED");
    expect(
      rebuilt
        .filter((r) => r.state !== "RELEASED")
        .reduce((sum, r) => sum.plus(r.cash), new Decimal(0))
        .lte(cash),
    ).toBe(true);
    expect(immutableRows(store)[0]).toEqual(immutable[0]);
    expect(immutableRows(store)[1].slice(0, 2)).toEqual(immutable[1]);
    expect(immutableRows(store)[2].slice(0, 1)).toEqual(immutable[2]);
  });

  it("rolls back the entire funds rebuild if persisting a replacement reservation fails", () => {
    const store = setup();
    const first = activate(store);
    const last = activate(store);
    trigger(store, last);
    const tables = [
      "account_snapshots",
      "settings",
      "plans",
      "reservations",
      "decision_events",
      "decision_inputs",
    ];
    const snapshot = () =>
      tables.map((table) =>
        store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    const before = snapshot();
    store.db
      .exec(`CREATE TEMP TRIGGER fail_rebuild BEFORE UPDATE ON reservations
      WHEN NEW.plan_id='${first.id}' AND json_extract(NEW.json, '$.generation')=2
      BEGIN SELECT RAISE(ABORT, 'injected reservation persistence failure'); END`);
    expect(() =>
      store.updateFunds({ ...funds, cash: { USD: "5000", CNY: "0" } }, 1, now),
    ).toThrow(/injected reservation/);
    expect(snapshot()).toEqual(before);
  });

  it("replaces an unconsumed paused reservation atomically without losing allocation priority", () => {
    const store = setup();
    const first = activate(store);
    activate(store);
    const previousReservation = store.reservations()[0];
    const previousAttempt = store.db
      .prepare("SELECT * FROM attempts WHERE id=?")
      .get(first.attemptId);
    store.invalidateEvidence(input.instrumentId, "SYNTHETIC_GAP", now);
    const { plan } = store.activate(first.id, first.version, now, {
      recovery: true,
      expectedAttemptId: first.attemptId,
      sourceAttemptId: first.attemptId!,
    });
    expect(plan.attemptId).not.toBe(first.attemptId);
    expect(plan.approvedQuantity).toBeLessThanOrEqual(first.approvedQuantity);
    expect(store.reservations()[0]).toEqual({
      ...previousReservation,
      attemptId: plan.attemptId,
    });
    expect(
      store.db
        .prepare("SELECT * FROM attempts WHERE id=?")
        .get(first.attemptId),
    ).toEqual(previousAttempt);
    const current = store.db
      .prepare("SELECT json FROM attempts WHERE id=?")
      .get(plan.attemptId) as { json: string };
    expect(JSON.parse(current.json)).toMatchObject({
      template: "RECOVERY",
      parentAttemptId: first.attemptId,
      approvedQuantity: plan.approvedQuantity,
    });
  });

  it("recovers an edited draft from its original allocation and refuses foreign or consumed sources", () => {
    const store = setup();
    const original = activate(store);
    const foreign = activate(store);
    const originalReservation = store.reservations()[0];
    const edited = store.updatePlan(
      original.id,
      { ...input, reason: "修订后显式恢复" },
      1,
      now,
    );
    expect(() =>
      store.activate(edited.id, edited.version, now, {
        recovery: true,
        expectedAttemptId: null,
        sourceAttemptId: foreign.attemptId!,
      }),
    ).toThrow(/尚未消费且已暂停/);
    const recovered = store.activate(edited.id, edited.version, now, {
      recovery: true,
      expectedAttemptId: null,
      sourceAttemptId: original.attemptId!,
    }).plan;
    expect(recovered.version).toBe(2);
    expect(recovered.approvedQuantity).toBeLessThanOrEqual(
      original.approvedQuantity,
    );
    expect(store.reservations()[0]).toMatchObject({
      state: "ACTIVE",
      allocationOrder: originalReservation.allocationOrder,
      attemptId: recovered.attemptId,
    });
    const event = trigger(store, recovered);
    store.feedback(event.id, { kind: "SKIPPED", note: "" }, now);
    const newer = store.updatePlan(edited.id, input, edited.version, now);
    expect(() =>
      store.activate(newer.id, newer.version, now, {
        recovery: true,
        expectedAttemptId: null,
        sourceAttemptId: recovered.attemptId!,
      }),
    ).toThrow(/尚未消费且已暂停/);
  });

  it("preserves the paused attempt and reservation when recovery risk checks or CAS fail", () => {
    const store = setup();
    const plan = activate(store);
    const traded = activate(store);
    const event = trigger(store, traded);
    store.feedback(event.id, { kind: "TAKEN", note: "" }, now);
    store.invalidateEvidence(input.instrumentId, "SYNTHETIC_GAP", now);
    const before = ["plans", "attempts", "reservations"].map((table) =>
      store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    expect(() =>
      store.activate(plan.id, plan.version, now, {
        recovery: true,
        expectedAttemptId: traded.attemptId,
        sourceAttemptId: plan.attemptId!,
      }),
    ).toThrow(/当前尝试已改变/);
    expect(() =>
      store.activate(plan.id, plan.version, now, {
        recovery: true,
        expectedAttemptId: plan.attemptId,
        sourceAttemptId: plan.attemptId!,
      }),
    ).toThrow(/FUNDS_SNAPSHOT_STALE/);
    expect(
      ["plans", "attempts", "reservations"].map((table) =>
        store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    ).toEqual(before);
  });
});
