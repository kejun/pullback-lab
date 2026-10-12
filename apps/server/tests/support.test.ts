import { afterEach, describe, expect, it } from "vitest";
import { createApp, type PullbackApp } from "../app.js";
import type {
  Bar,
  DecisionEvent,
  FeedbackRevision,
  Plan,
  PlanInput,
  SupportSnapshot,
} from "../../../packages/contracts/index.js";

const now = Date.parse("2026-10-12T10:00:00Z");
const planInput: PlanInput = {
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
  reason: "人工确认的合成研究背景",
  backgroundConfirmed: true,
  supportSelections: [
    { source: "EMA9" },
    { source: "HORIZONTAL", id: "manual", price: "100", label: "水平支撑" },
  ],
};
const apps: PullbackApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture() {
  const app = await createApp({
    demo: true,
    password: "private-support-test",
    now: () => now,
  });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-requested-with": "PullbackLab" },
    payload: { password: "private-support-test" },
  });
  const headers = {
    "x-requested-with": "PullbackLab",
    cookie: login.headers["set-cookie"]!.toString().split(";")[0],
  };
  const post = (url: string, payload?: object) =>
    app.inject({ method: "POST", url, headers, payload });
  const get = (url: string) => app.inject({ url, headers });
  await post("/api/demo/seed");
  await post("/api/settings/screening", { confirmed: true });
  await post("/api/funds", {
    expectedGeneration: 0,
    nav: "10000",
    baseCurrency: "USD",
    cash: { USD: "10000", CNY: "0" },
    existing: {},
    riskBudget: "50",
    riskPool: "100",
    maxWeight: "0.2",
    fx: { USD: "1", CNY: "0.14" },
    fxAsOf: now,
    buyFee: "0",
    sellFee: "0",
    slippageIn: "0",
    slippageOut: "0",
    feesConfirmed: true,
  });
  const create = async (input: object = planInput) => {
    const response = await post("/api/plans", input);
    expect(response.statusCode).toBe(200);
    return response.json<Plan>();
  };
  const activate = async (p: Plan) =>
    post(`/api/plans/${p.id}/activate`, { expectedVersion: p.version });
  return { app, post, get, create, activate };
}
describe("trusted support snapshots and feedback evidence", () => {
  it("previews with only minimal fields; no client can supply EMA prices or readiness", async () => {
    const f = await fixture();
    const result = await f.post("/api/plans/support-preview", {
      instrumentId: planInput.instrumentId,
      anchorTime: null,
      primarySupport: "100",
      supportSelections: planInput.supportSelections,
    });
    expect(result.statusCode).toBe(200);
    const snapshot = result.json<SupportSnapshot>();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.lines[0].price).toMatch(/^99\.7/);
    expect(snapshot.reference.previousDailyTime).toBe(
      Date.parse("2026-10-08T00:00:00Z") / 1000,
    );
    const forged = await f.post("/api/plans/support-preview", {
      instrumentId: planInput.instrumentId,
      anchorTime: null,
      primarySupport: "100",
      supportSelections: [{ source: "EMA9", price: "100" }],
    });
    expect(forged.statusCode).toBe(400);
    const draft = await f.create({
      ...planInput,
      supportSelections: [],
      supportSnapshot: { ready: true },
    });
    expect(draft.supportSnapshot?.ready).toBe(false);
    expect((await f.activate(draft)).json().code).toBe("SUPPORT_NOT_READY");
  });
  it("saves incomplete drafts and freezes complete snapshots only on explicit version creation", async () => {
    const f = await fixture();
    const incomplete = await f.create({
      ...planInput,
      supportSelections: undefined,
    });
    expect(incomplete.status).toBe("DRAFT");
    expect(incomplete.supportSnapshot?.reasons).toContain(
      "INSUFFICIENT_SUPPORT_FAMILIES",
    );
    expect((await f.activate(incomplete)).statusCode).toBe(422);
    const response = await f.post(`/api/plans/${incomplete.id}/versions`, {
      ...planInput,
      expectedVersion: 1,
    });
    const ready = response.json<Plan>();
    expect(ready.supportSnapshot).toMatchObject({
      ready: true,
      selectionReason: planInput.reason,
      selectedAt: now,
    });
    expect(f.app.store.planVersion(incomplete).supportSnapshot?.ready).toBe(
      false,
    );
    expect((await f.activate(ready)).statusCode).toBe(200);
  });
  it("keeps a legacy v1 plan readable but activation requires an explicit new version", async () => {
    const f = await fixture();
    const p = await f.create();
    const {
      supportSnapshot: _snapshot,
      supportSelections: _selections,
      ...legacy
    } = { ...p, id: "legacy-v1" };
    f.app.store.db
      .prepare("INSERT INTO plans VALUES(?,?,?)")
      .run(legacy.id, 1, JSON.stringify(legacy));
    f.app.store.db
      .prepare("INSERT INTO plan_versions VALUES(?,?,?)")
      .run(legacy.id, 1, JSON.stringify(legacy));
    expect(
      (await f.get("/api/bootstrap"))
        .json()
        .plans.find((row: Plan) => row.id === legacy.id).supportSnapshot,
    ).toBeUndefined();
    expect((await f.activate(legacy)).json().code).toBe(
      "SUPPORT_SNAPSHOT_REQUIRED",
    );
    const updated = (
      await f.post(`/api/plans/${legacy.id}/versions`, {
        ...planInput,
        expectedVersion: 1,
      })
    ).json<Plan>();
    expect(updated.version).toBe(2);
    expect((await f.activate(updated)).statusCode).toBe(200);
    expect(f.app.store.planVersion(legacy).supportSnapshot).toBeUndefined();
  });
  it("detects an EMA seed revision even when the most recent bar and anchor are unchanged", async () => {
    const f = await fixture();
    const p = await f.create();
    expect((await f.activate(p)).statusCode).toBe(200);
    const seed = f.app.store.bars(p.instrumentId, "1D")[0];
    const revised: Bar = { ...seed, high: "45.00" };
    f.app.store.db
      .prepare("UPDATE bars SET json=? WHERE instrument_id=? AND bar_id=?")
      .run(JSON.stringify(revised), p.instrumentId, seed.id);
    const events = (await f.post(`/api/demo/plans/${p.id}/replay`)).json<{
      events: DecisionEvent[];
    }>().events;
    expect(events[0].reasons).toContain("PLAN_DATA_REVISION_CHANGED");
    expect(f.app.store.plan(p.id).status).toBe("DATA_PAUSED");
    expect(f.app.store.planVersion(p).supportSnapshot?.dataRevision).toBe(
      p.supportSnapshot?.dataRevision,
    );
    expect((await f.activate(p)).json().code).toBe(
      "PLAN_DATA_REVISION_CHANGED",
    );
  });
  it("keeps unknown real history incomplete even if users pick enough horizontal and EMA lines", async () => {
    const f = await fixture();
    const instrument = (
      await f.post("/api/universe", { symbol: "AAPL.US", market: "US" })
    ).json();
    const p = await f.create({ ...planInput, instrumentId: instrument.id });
    expect(p.supportSnapshot?.ready).toBe(false);
    expect(p.supportSnapshot?.synthetic).toBe(false);
    expect((await f.activate(p)).json().code).toBe(
      "LIVE_CAPABILITY_UNVERIFIED",
    );
  });
  it("does not pause a newer valid plan when an old plan for the same symbol has stale evidence", async () => {
    const f = await fixture();
    const old = await f.create();
    const seed = f.app.store.bars(old.instrumentId, "1D")[0];
    f.app.store.db
      .prepare("UPDATE bars SET json=? WHERE bar_id=?")
      .run(JSON.stringify({ ...seed, high: "45.00" }), seed.id);
    const current = await f.create();
    expect((await f.activate(current)).statusCode).toBe(200);
    expect((await f.activate(old)).json().code).toBe(
      "PLAN_DATA_REVISION_CHANGED",
    );
    expect(f.app.store.plan(current.id).status).toBe("WAIT_RETEST");
    expect(
      f.app.store.eventsForAttempt(f.app.store.plan(current.id).attemptId!),
    ).toEqual([]);
  });
  it("ignores unfinished or future-received inputs consistently, then invalidates evidence when a newly known old bar becomes final", async () => {
    const f = await fixture();
    const first = f.app.store.bars(planInput.instrumentId, "1D")[0];
    const invisible = {
      ...first,
      id: "synthetic:invisible",
      time: first.time - 86400,
      final: false,
      receivedAt: now + 1000,
    };
    f.app.store.putBars(planInput.instrumentId, "1D", [invisible]);
    const p = await f.create();
    expect(p.supportSnapshot?.ready).toBe(true);
    expect(f.app.store.supportRevisionReasons(p, now)).toEqual([]);
    expect((await f.activate(p)).statusCode).toBe(200);
    const finalized = { ...invisible, final: true };
    f.app.store.db
      .prepare("UPDATE bars SET json=? WHERE bar_id=?")
      .run(JSON.stringify(finalized), invisible.id);
    expect(f.app.store.supportRevisionReasons(p, now)).toEqual([]);
    expect(f.app.store.supportRevisionReasons(p, now + 2000)).toEqual([
      "PLAN_DATA_REVISION_CHANGED",
    ]);
  });
  it("retains actual price/quantity/time with deviation flags and immutable correction history", async () => {
    const f = await fixture();
    const p = await f.create();
    await f.activate(p);
    const events = (await f.post(`/api/demo/plans/${p.id}/replay`)).json<{
      events: DecisionEvent[];
    }>().events;
    const event = events.find((e) => e.type === "HISTORICAL_TRIGGERED")!;
    const immutableBefore = f.app.store.db
      .prepare("SELECT json FROM decision_events WHERE id=?")
      .get(event.id);
    const inputBefore = f.app.store.decisionInput(event.id);
    const actual = {
      kind: "TAKEN",
      note: "原始成交值",
      actualPrice: "102.0000",
      actualQuantity: event.quantity! + 1,
      actualTime: event.time - 1,
    };
    expect(
      (await f.post(`/api/events/${event.id}/feedback`, actual)).statusCode,
    ).toBe(200);
    await f.post(`/api/events/${event.id}/feedback`, actual);
    let history = (await f.get(`/api/events/${event.id}/feedback`)).json<{
      revisions: FeedbackRevision[];
    }>().revisions;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      ...actual,
      deviationCodes: [
        "ACTUAL_PRICE_OUTSIDE_ENTRY_RANGE",
        "ACTUAL_QUANTITY_ABOVE_APPROVED",
        "ACTUAL_TIME_BEFORE_SIGNAL",
      ],
    });
    await f.post(`/api/events/${event.id}/feedback`, {
      ...actual,
      note: "修正人工录入",
      actualPrice: "100.61",
      actualQuantity: event.quantity,
      actualTime: event.time,
    });
    history = (await f.get(`/api/events/${event.id}/feedback`)).json()
      .revisions;
    expect(history).toHaveLength(2);
    expect(history[0].actualPrice).toBe("102.0000");
    expect(history[1].deviationCodes).toEqual([]);
    expect(f.app.store.funds()?.generation).toBe(2);
    expect(f.app.store.decisionInput(event.id)).toEqual(inputBefore);
    expect(
      f.app.store.db
        .prepare("SELECT json FROM decision_events WHERE id=?")
        .get(event.id),
    ).toEqual(immutableBefore);
  });
  it("rejects divergent feedback from a stale page while allowing an identical retry", async () => {
    const f = await fixture();
    const p = await f.create();
    await f.activate(p);
    const event = (await f.post(`/api/demo/plans/${p.id}/replay`))
      .json<{ events: DecisionEvent[] }>()
      .events.find((e) => e.type === "HISTORICAL_TRIGGERED")!;
    const url = `/api/events/${event.id}/feedback`;
    const first = { kind: "SKIPPED", note: "页面一", expectedRevisionId: null };
    expect((await f.post(url, first)).statusCode).toBe(200);
    expect((await f.post(url, first)).statusCode).toBe(200);
    const stale = await f.post(url, {
      kind: "TAKEN",
      note: "页面二仍显示无记录",
      expectedRevisionId: null,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("FEEDBACK_REVISION_CONFLICT");
    expect(f.app.store.funds()?.stale).toBe(false);
    const history = (await f.get(url)).json<{ revisions: FeedbackRevision[] }>()
      .revisions;
    expect(history).toHaveLength(1);
    expect(
      (
        await f.post(url, {
          kind: "TAKEN",
          note: "重读后确认",
          expectedRevisionId: history[0].id,
        })
      ).statusCode,
    ).toBe(200);
    const latest = (await f.get(url)).json<{ revisions: FeedbackRevision[] }>()
      .revisions;
    expect(latest).toHaveLength(2);
    expect(latest[0]).toEqual(history[0]);
    expect(latest[1]).not.toHaveProperty("expectedRevisionId");
    expect(f.app.store.funds()?.generation).toBe(2);
  });
  it("checks recorded quantities against the qMin + n*qStep grid from the frozen instrument", async () => {
    const f = await fixture();
    const row = f.app.store.instrument(planInput.instrumentId);
    f.app.store.putInstrument({
      ...row,
      instrument: { ...row.instrument, qMin: 150, qStep: 100 },
    });
    const funds = f.app.store.funds()!;
    f.app.store.updateFunds(
      {
        ...funds,
        nav: "100000",
        cash: { USD: "100000", CNY: "0" },
        maxWeight: "1",
        riskBudget: "1000",
        riskPool: "1000",
      },
      funds.generation,
      now,
    );
    const p = await f.create();
    expect((await f.activate(p)).statusCode).toBe(200);
    const event = (await f.post(`/api/demo/plans/${p.id}/replay`))
      .json<{ events: DecisionEvent[] }>()
      .events.find((e) => e.type === "HISTORICAL_TRIGGERED")!;
    expect(event.quantity).toBeGreaterThanOrEqual(250);
    const url = `/api/events/${event.id}/feedback`;
    await f.post(url, { kind: "TAKEN", note: "合法250", actualQuantity: 250 });
    await f.post(url, {
      kind: "TAKEN",
      note: "原样保留不合法200",
      actualQuantity: 200,
    });
    const history = (await f.get(url)).json<{ revisions: FeedbackRevision[] }>()
      .revisions;
    expect(history[0].deviationCodes).not.toContain(
      "ACTUAL_QUANTITY_RULE_MISMATCH",
    );
    expect(history[1].deviationCodes).toContain(
      "ACTUAL_QUANTITY_RULE_MISMATCH",
    );
    expect(history[1].actualQuantity).toBe(200);
  });
  it("audits archived inputs without mutating a plan, reservation or event and authenticates new read routes", async () => {
    const f = await fixture();
    const p = await f.create();
    await f.activate(p);
    const events = (await f.post(`/api/demo/plans/${p.id}/replay`)).json<{
      events: DecisionEvent[];
    }>().events;
    const event = events.find((e) => e.type === "HISTORICAL_TRIGGERED")!;
    const before = {
      plans: f.app.store.plans(),
      reservations: f.app.store.reservations(),
      events: f.app.store.events(),
    };
    const result = await f.get(`/api/events/${event.id}/replay`);
    expect(result.statusCode).toBe(200);
    expect(result.json().status).toBe("MATCH");
    expect({
      plans: f.app.store.plans(),
      reservations: f.app.store.reservations(),
      events: f.app.store.events(),
    }).toEqual(before);
    expect(
      (await f.app.inject(`/api/events/${event.id}/replay`)).statusCode,
    ).toBe(401);
    expect((await f.app.inject("/api/market/status")).statusCode).toBe(401);
    expect((await f.get("/api/market/status")).statusCode).toBe(200);
  });
});
