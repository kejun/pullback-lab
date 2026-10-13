import { afterEach, describe, expect, it } from "vitest";
import type { FeeSchedule, Plan } from "../../../packages/contracts/index.js";
import { createApp, type PullbackApp } from "../app.js";
import {
  planInput,
  testFunds,
  setupClosed,
  OPEN,
} from "./closed-bar-fixture.js";
import { auditDecisionInput } from "../audit-replay.js";

const now = Date.parse("2026-10-12T10:00:00Z");
const input = {
  ...planInput,
  instrumentId: "DEMO-US-A",
  chaseLimit: { enabled: false },
};
const schedule: FeeSchedule = {
  buy: { minimum: "1", fixed: "0.2", perShare: "0.01", notionalRate: "0.001" },
  sell: {
    minimum: "1",
    fixed: "0.3",
    perShare: "0.02",
    notionalRate: "0.0005",
  },
  currency: "USD",
  version: "synthetic-fees-2026-10-09",
  ruleDate: "2026-10-09",
  confirmed: true,
};
const accounts = {
  ...testFunds,
  nav: "100000",
  cash: { USD: "100000", CNY: "0" },
  maxWeight: "1",
  riskPool: "1000",
  fxAsOf: now,
};
const apps: PullbackApp[] = [];
const closed: Awaited<ReturnType<typeof setupClosed>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const x of closed.splice(0)) await x.close();
});
async function setup(at = now) {
  const app = await createApp({
    password: "private-test-password",
    demo: true,
    now: () => at,
  });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-requested-with": "PullbackLab" },
    payload: { password: "private-test-password" },
  });
  const headers = {
    "x-requested-with": "PullbackLab",
    cookie: login.headers["set-cookie"]!.toString().split(";")[0],
  };
  const post = (url: string, payload?: object) =>
    app.inject({ method: "POST", url, headers, payload });
  expect((await post("/api/demo/seed")).statusCode).toBe(200);
  expect(
    (await post("/api/settings/screening", { confirmed: true })).statusCode,
  ).toBe(200);
  expect(
    (await post("/api/funds", { ...accounts, expectedGeneration: 0 }))
      .statusCode,
  ).toBe(200);
  return { app, post };
}
function audit(app: { store: PullbackApp["store"] }) {
  for (const event of app.store.events()) {
    const result = auditDecisionInput({
      snapshot: app.store.decisionInput(event.id),
      expectedInputHash: event.snapshot.inputHash as string,
    });
    expect(result.status, `${event.type}: ${JSON.stringify(result)}`).toBe(
      "MATCH",
    );
  }
}

describe("immutable plan fees and controls at API boundaries", () => {
  it.each(["quick", "persistent"])(
    "saves full fees and reserves quantity-dependent fees with %s runtime",
    async (runtime) => {
      const { app, post } = await setup();
      // Full plan fees have their own confirmation; legacy settings are not an extra permission.
      app.store.updateFunds({ ...accounts, feesConfirmed: false }, 1, now);
      const response = await post("/api/plans", {
        ...input,
        feeSchedule: schedule,
      });
      expect(response.statusCode).toBe(200);
      const plan = response.json<Plan>();
      expect(plan.feeSchedule).toEqual(schedule);
      expect(app.store.planVersion(plan).feeSchedule).toEqual(schedule);
      const risk = (await post(`/api/plans/${plan.id}/risk`)).json();
      expect(risk).toMatchObject({
        quantity: 21,
        buyFee: "2.55",
        sellFee: "1.77",
        riskBase: "48.42",
        cashUse: "2134.05",
        feeVersion: schedule.version,
        passed: true,
      });
      const activated = await post(`/api/plans/${plan.id}/activate`, {
        expectedVersion: plan.version,
        expectedAttemptId: null,
      });
      expect(activated.statusCode).toBe(200);
      expect(app.store.reservations()[0]).toMatchObject({
        quantity: 21,
        cash: "2134.05",
        riskBase: "48.42",
      });
      const p = app.store.plan(plan.id);
      const command = {
        expectedVersion: p.version,
        expectedAttemptId: p.attemptId,
      };
      if (runtime === "quick") {
        expect(
          (await post(`/api/demo/plans/${plan.id}/replay`, command)).statusCode,
        ).toBe(200);
      } else {
        expect(
          (await post(`/api/demo/plans/${plan.id}/runtime/start`, command))
            .statusCode,
        ).toBe(200);
        expect(
          (
            await post(`/api/demo/plans/${plan.id}/runtime/step`, {
              ...command,
              expectedStep: 0,
              count: 3,
            })
          ).statusCode,
        ).toBe(200);
      }
      const decision = app.store
        .events()
        .find((e) => e.type === "HISTORICAL_TRIGGERED")!;
      expect(decision.snapshot.risk).toMatchObject({
        quantity: 21,
        feeVersion: schedule.version,
      });
      expect(decision.snapshot.plan).toMatchObject({ feeSchedule: schedule });
      audit(app);
    },
  );
  it("recomputes minima at the reduced legal quantity on a funds rebuild", async () => {
    const { app, post } = await setup();
    const p = (
      await post("/api/plans", { ...input, feeSchedule: schedule })
    ).json<Plan>();
    await post(`/api/plans/${p.id}/activate`, {
      expectedVersion: p.version,
      expectedAttemptId: null,
    });
    app.store.updateFunds({ ...accounts, riskBudget: "5" }, 1, now);
    expect(app.store.reservations()[0]).toMatchObject({
      quantity: 1,
      cash: "102.5",
      riskBase: "4.1",
    });
    expect(app.store.risk(app.store.plan(p.id), now)).toMatchObject({
      quantity: 1,
      buyFee: "1",
      sellFee: "1",
    });
  });
  it.each([
    ["unconfirmed", { ...schedule, confirmed: false }],
    ["wrong currency", { ...schedule, currency: "CNY" as const }],
  ])(
    "saves %s research estimates but blocks reservation and entry",
    async (_label, fees) => {
      const { app, post } = await setup();
      const response = await post("/api/plans", {
        ...input,
        feeSchedule: fees,
      });
      expect(response.statusCode).toBe(200);
      const p = response.json<Plan>();
      expect((await post(`/api/plans/${p.id}/risk`)).json()).toMatchObject({
        passed: false,
        quantity: 0,
        reasons: ["FEE_SCHEDULE_UNVERIFIED"],
      });
      expect(
        (
          await post(`/api/plans/${p.id}/activate`, {
            expectedVersion: p.version,
            expectedAttemptId: null,
          })
        ).statusCode,
      ).toBe(422);
      expect(app.store.reservations()).toEqual([]);
    },
  );
  it("rejects future fee provenance dates against the server market day on save and edit", async () => {
    const { app, post } = await setup(Date.parse("2026-10-13T01:00:00Z"));
    // It is October 12 in New York, even though the UTC date is October 13.
    const source = {
      ...input,
      feeSchedule: { ...schedule, ruleDate: "2026-10-12" },
    };
    const created = await post("/api/plans", source);
    expect(created.statusCode).toBe(200);
    const plan = created.json<Plan>();
    const future = {
      ...source,
      sessionDate: "2026-10-30",
      feeSchedule: { ...schedule, ruleDate: "2026-10-13" },
    };
    expect((await post("/api/plans", future)).json()).toMatchObject({
      code: "FEE_RULE_DATE_IN_FUTURE",
    });
    const before = app.store.planVersion(plan);
    const edited = await post(`/api/plans/${plan.id}/versions`, {
      ...future,
      expectedVersion: plan.version,
      expectedAttemptId: null,
    });
    expect(edited.statusCode).toBe(400);
    expect(edited.json().code).toBe("FEE_RULE_DATE_IN_FUTURE");
    expect(app.store.planVersion(plan)).toEqual(before);
    expect(app.store.plan(plan.id).version).toBe(1);
  });
  it("uses Shanghai's market day for fee provenance dates", async () => {
    const { post } = await setup(Date.parse("2026-10-12T17:00:00Z"));
    const response = await post("/api/plans", {
      ...input,
      instrumentId: "DEMO-CN-A",
      feeSchedule: { ...schedule, currency: "CNY", ruleDate: "2026-10-13" },
    });
    expect(response.statusCode, response.body).toBe(200);
  });
  it.each([
    { buy: { ...schedule.buy, perShare: undefined } },
    { sell: { ...schedule.sell, notionalRate: "-0.1" } },
    { currency: "EUR" },
    { version: " " },
    { ruleDate: "2026-02-30" },
    { buy: { ...schedule.buy, unknownFee: "1" } },
  ])(
    "rejects incomplete or malformed fee fields rather than inventing components: %j",
    async (change) => {
      const { post } = await setup();
      expect(
        (
          await post("/api/plans", {
            ...input,
            feeSchedule: { ...schedule, ...change },
          })
        ).statusCode,
      ).toBe(400);
    },
  );
  it.each([
    { enabled: true },
    { enabled: true, maxPercent: "-1" },
    { enabled: true, maxPercent: "NaN" },
    { enabled: true, maxPercent: "1".repeat(65) },
    { enabled: true, maxPercent: 3 },
  ])("rejects invalid chase controls: %j", async (chaseLimit) => {
    const { post } = await setup();
    expect(
      (await post("/api/plans", { ...input, chaseLimit })).statusCode,
    ).toBe(400);
  });
  it("preserves legacy fixed-fee events and CAS-protects their explicit upgrade", async () => {
    const { app, post } = await setup();
    app.store.updateFunds({ ...accounts, buyFee: "1", sellFee: "1" }, 1, now);
    const old = (await post("/api/plans", input)).json<Plan>();
    const p = (
      await post(`/api/plans/${old.id}/activate`, {
        expectedVersion: 1,
        expectedAttemptId: null,
      })
    ).json<{ plan: Plan }>().plan;
    expect(app.store.risk(p, now)).toMatchObject({
      quantity: 22,
      buyFee: "1",
      sellFee: "1",
      feeVersion: "manual-fixed-minimum-v1",
    });
    await post(`/api/demo/plans/${p.id}/replay`, {
      expectedVersion: 1,
      expectedAttemptId: p.attemptId,
    });
    const event = app.store
      .events()
      .find((e) => e.type === "HISTORICAL_TRIGGERED")!;
    const frozen = JSON.stringify(app.store.decisionInput(event.id));
    expect(
      (
        await post(`/api/events/${event.id}/feedback`, {
          kind: "SKIPPED",
          note: "synthetic upgrade",
          expectedRevisionId: null,
        })
      ).statusCode,
    ).toBe(200);
    const next = {
      ...input,
      feeSchedule: schedule,
      chaseLimit: { enabled: true, maxPercent: "3" },
      expectedVersion: 1,
      expectedAttemptId: p.attemptId,
    };
    expect((await post(`/api/plans/${p.id}/versions`, next)).statusCode).toBe(
      200,
    );
    expect(
      (
        await post(`/api/plans/${p.id}/versions`, {
          ...next,
          feeSchedule: { ...schedule, version: "stale-tab" },
        })
      ).statusCode,
    ).toBe(409);
    expect(app.store.plan(p.id)).toMatchObject({
      version: 2,
      feeSchedule: schedule,
      chaseLimit: { enabled: true, maxPercent: "3" },
    });
    expect(app.store.planVersion(old)).not.toHaveProperty("feeSchedule");
    expect(JSON.stringify(app.store.decisionInput(event.id))).toBe(frozen);
    audit(app);
  });
});

describe("formal schedule and frozen risk audit", () => {
  it("uses the saved full schedule at activation, fresh trigger price, and read-only audit", async () => {
    const x = await setupClosed({ planInput: { feeSchedule: schedule } });
    closed.push(x);
    expect(x.store.reservations()[0].quantity).toBe(19); // initial 20% NAV exposure ceiling
    x.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
    x.minute(1, { open: "100.5", high: "101.2", low: "100.4", close: "101" });
    const event = x.store.events().find((e) => e.type === "ENTRY_TRIGGERED")!;
    expect(event).toBeDefined();
    expect(event.snapshot.risk).toMatchObject({
      quantity: 19,
      buyFee: "2.31",
      sellFee: "1.63",
      cashUse: "1921.31",
      riskBase: "34.34",
      feeVersion: schedule.version,
    });
    expect(event.snapshot.planVersion).toMatchObject({ feeSchedule: schedule });
    audit(x);
    const frozen = JSON.stringify(x.store.decisionInput(event.id));
    x.setNow(OPEN + 180000);
    x.store.updateFunds(
      { ...testFunds, buyFee: "999", sellFee: "999", feesConfirmed: false },
      x.store.funds()!.generation,
      x.now(),
    );
    expect(JSON.stringify(x.store.decisionInput(event.id))).toBe(frozen);
    audit(x);
  });
});
