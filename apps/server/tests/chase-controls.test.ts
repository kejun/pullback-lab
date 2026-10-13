/** Isolated contract fixtures only; these tests never install a production adapter. */
import { afterEach, describe, expect, it } from "vitest";
import type {
  DecisionEvent,
  Plan,
  PlanInput,
} from "../../../packages/contracts/index.js";
import type {
  AttemptConfig,
  TriggerEvent,
} from "../../../packages/domain/trigger.js";
import {
  demoInstruments,
  generateDemoBars,
} from "../../../packages/market-data/fixtures.js";
import { createApp } from "../app.js";
import { AttemptRuntime, type RuntimeInput } from "../attempt-runtime.js";
import { auditDecisionInput } from "../audit-replay.js";
import { replayPlan } from "../replay.js";
import { Store } from "../store.js";
import {
  ContractAdapter,
  OPEN,
  planInput,
  setupClosed,
  testFunds,
} from "./closed-bar-fixture.js";

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-12T10:00:00Z");
const enabled = { enabled: true, maxPercent: "3" };
const touch = { open: "100.5", high: "100.6", low: "100", close: "100.5" };
const breakout = (price = "103") => ({
  open: "100.5",
  high: "103.2",
  low: "100.4",
  close: price,
});
const closes: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
function config(
  store: Store,
  table: "runtime_attempts" | "closed_attempts",
  attemptId: string,
): AttemptConfig {
  return JSON.parse(
    (
      store.db
        .prepare(`SELECT config_json FROM ${table} WHERE attempt_id=?`)
        .get(attemptId) as { config_json: string }
    ).config_json,
  );
}
function assessment(event: DecisionEvent) {
  return (event.snapshot.emitted as TriggerEvent[]).findLast((e) =>
    ["ENTRY_TRIGGERED", "ENTRY_BLOCKED", "HISTORICAL_TRIGGERED"].includes(
      e.type,
    ),
  )!.snapshot;
}
function audit(store: Store, event: DecisionEvent) {
  const result = auditDecisionInput({
    snapshot: store.decisionInput(event.id),
    expectedInputHash: event.snapshot.inputHash as string,
  });
  expect(result.status, JSON.stringify(result)).toBe("MATCH");
}
async function formal(
  chaseLimit: PlanInput["chaseLimit"] = enabled,
  autoDrain = true,
) {
  const x = await setupClosed({ activate: false, autoDrain });
  closes.push(x.close);
  const updated = x.store.updatePlan(
    x.plan.id,
    { ...planInput, entryMax: "104", chaseLimit },
    x.plan.version,
    x.now(),
  );
  const plan = x.runner.activate(updated.id, {
    expectedVersion: updated.version,
    expectedAttemptId: null,
  }).plan;
  return { ...x, plan };
}
function synthetic(
  chaseLimit: PlanInput["chaseLimit"] = enabled,
  price = "103",
) {
  const store = new Store();
  closes.push(() => store.close());
  store.putInstrument({
    instrument: demoInstruments[0],
    manual: false,
    note: "synthetic chase test",
    tags: [],
  });
  for (const period of ["1D", "1m", "5m"] as const) {
    const bars = generateDemoBars("DEMO-US-A", period);
    if (period === "1m") Object.assign(bars[1], breakout(price));
    store.putBars("DEMO-US-A", period, bars);
  }
  store.confirmScreening(undefined, 0, NOW);
  store.updateFunds({ ...testFunds, fxAsOf: NOW, confirmedAt: NOW }, 0, NOW);
  const input: PlanInput = {
    ...planInput,
    instrumentId: "DEMO-US-A",
    entryMax: "104",
    chaseLimit,
  };
  const created = store.createPlan(input, NOW);
  const plan = store.activate(created.id, created.version, NOW).plan;
  const runner = new AttemptRuntime(store, { now: () => NOW });
  closes.push(() => runner.close());
  return {
    store,
    plan,
    runner,
    input,
    command: {
      expectedVersion: plan.version,
      expectedAttemptId: plan.attemptId!,
    },
  };
}

describe("chase control through the authenticated plan and formal activation APIs", () => {
  it.each([
    {
      price: "103",
      chaseLimit: enabled,
      ratio: "0.03",
      expected: "ENTRY_TRIGGERED",
      check: "PASS",
    },
    {
      price: "103.01",
      chaseLimit: enabled,
      ratio: "0.03",
      expected: "ENTRY_BLOCKED",
      check: "BLOCKED",
    },
    {
      price: "103",
      chaseLimit: { enabled: true, maxPercent: "2.9999999999999999999999" },
      ratio: "0.029999999999999999999999",
      expected: "ENTRY_BLOCKED",
      check: "BLOCKED",
    },
    {
      price: "103",
      chaseLimit: { enabled: true, maxPercent: "0" },
      ratio: "0",
      expected: "ENTRY_BLOCKED",
      check: "BLOCKED",
    },
    {
      price: "103.01",
      chaseLimit: { enabled: false },
      expected: "ENTRY_TRIGGERED",
      check: undefined,
    },
    {
      price: "103.01",
      chaseLimit: undefined,
      expected: "ENTRY_TRIGGERED",
      check: undefined,
    },
  ])(
    "uses percent units and an inclusive boundary: $price, $expected, $chaseLimit",
    async ({ price, chaseLimit, ratio, expected, check }) => {
      let now = OPEN - 1;
      const adapter = new ContractAdapter();
      const app = await createApp({
        password: "chase-api-contract-password",
        now: () => now,
        closedBarAdapter: adapter,
      });
      closes.push(() => app.close());
      app.store.putInstrument({
        instrument: adapter.context.instrument,
        manual: true,
        note: "isolated test",
        tags: [],
      });
      await app.monitor.start();
      app.store.confirmScreening(undefined, 0, now);
      app.store.updateFunds({ ...testFunds, fxAsOf: now }, 0, now);
      const login = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "x-requested-with": "PullbackLab" },
        payload: { password: "chase-api-contract-password" },
      });
      const headers = {
        "x-requested-with": "PullbackLab",
        cookie: login.headers["set-cookie"]!.toString().split(";")[0],
      };
      const created = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers,
        payload: {
          ...planInput,
          entryMax: "104",
          ...(chaseLimit ? { chaseLimit } : {}),
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      const draft = created.json<Plan>();
      const activated = await app.inject({
        method: "POST",
        url: `/api/plans/${draft.id}/activate`,
        headers,
        payload: { expectedVersion: draft.version, expectedAttemptId: null },
      });
      expect(activated.statusCode, activated.body).toBe(200);
      const plan = activated.json().plan as Plan;
      const frozen = config(app.store, "closed_attempts", plan.attemptId!);
      if (chaseLimit?.enabled) expect(frozen.chaseFromLowMax).toBe(ratio);
      else expect(frozen).not.toHaveProperty("chaseFromLowMax");
      now = OPEN;
      app.store.updateFunds(testFunds, app.store.funds()!.generation, now);
      for (const [index, values] of [touch, breakout(price)].entries()) {
        now = OPEN + (index + 1) * MINUTE;
        adapter.quote(now, values.close);
        adapter.sink.minute(adapter.bar(index, values));
      }
      const events = app.store.eventsForAttempt(plan.attemptId!);
      expect(
        events.filter((e) => e.type === "TECHNICAL_TRIGGERED"),
      ).toHaveLength(1);
      const decision = events.find((e) => e.type === expected)!;
      expect(decision).toBeDefined();
      const checks = assessment(decision).checks as Record<
        string,
        { status: string }
      >;
      if (check) expect(checks.chase.status).toBe(check);
      else expect(checks).not.toHaveProperty("chase");
      if (expected === "ENTRY_BLOCKED") {
        expect(decision.reasons).toContain("CHASE_FROM_LOW_EXCEEDED");
        expect(events.some((e) => e.type === "ENTRY_TRIGGERED")).toBe(false);
      }
      audit(app.store, decision);
    },
  );
});

describe("decision-time session low and frozen audit evidence", () => {
  it("does not use a fresh quote to fill missing minute coverage", async () => {
    const x = await formal(enabled, false);
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout());
    x.setNow(OPEN + 3 * MINUTE);
    x.adapter.quote(x.now(), "103");
    x.runner.drain();
    const events = x.store.eventsForAttempt(x.plan.attemptId!);
    const decision = events.find((e) => e.type === "ENTRY_BLOCKED")!;
    expect(decision.reasons).toContain("SESSION_LOW_INCOMPLETE");
    expect(assessment(decision)).toMatchObject({
      lod: { from: OPEN, through: OPEN + 2 * MINUTE },
      gates: { quote: { at: OPEN + 3 * MINUTE } },
    });
    expect(events.some((e) => e.type === "ENTRY_TRIGGERED")).toBe(false);
    audit(x.store, decision);
  });

  it("blocks partial-session recovery even with a fresh quote and a passing percent", async () => {
    const x = await formal();
    x.minute(0, touch);
    x.setNow(OPEN + 2 * MINUTE);
    x.adapter.sink.disconnect("TEST_DISCONNECTED");
    const watermark = x.runner.status(x.plan.id)!.watermark;
    await new Promise((resolve) => setImmediate(resolve));
    await x.runner.start();
    const recovered = x.runner.activate(
      x.plan.id,
      { expectedVersion: x.plan.version, expectedAttemptId: x.plan.attemptId },
      { sourceAttemptId: x.plan.attemptId!, expectedWatermark: watermark },
    ).plan;
    expect(
      config(x.store, "closed_attempts", recovered.attemptId!),
    ).toMatchObject({ template: "RECOVERY", chaseFromLowMax: "0.03" });
    x.minute(2, { open: "100.5", high: "100.6", low: "100.4", close: "100.5" });
    x.minute(3, touch);
    x.minute(4, breakout("101"));
    const events = x.store.eventsForAttempt(recovered.attemptId!);
    const decision = events.find((e) => e.type === "ENTRY_BLOCKED")!;
    expect(decision.reasons).toContain("SESSION_LOW_INCOMPLETE");
    expect(assessment(decision).lod).toMatchObject({
      from: OPEN + 2 * MINUTE,
      complete: false,
    });
    expect(events.some((e) => e.type === "ENTRY_TRIGGERED")).toBe(false);
    audit(x.store, decision);
  });

  it("keeps the decision low and old plan setting unchanged after a later low and a version edit", async () => {
    const x = await formal();
    x.minute(0, touch);
    x.minute(1, breakout());
    const entry = x.store
      .eventsForAttempt(x.plan.attemptId!)
      .find((e) => e.type === "ENTRY_TRIGGERED")!;
    const before = x.store.decisionInput(entry.id);
    expect(assessment(entry).lod).toMatchObject({
      price: "100",
      through: OPEN + 2 * MINUTE,
      complete: true,
    });
    x.minute(2, { open: "103", high: "103.2", low: "99.8", close: "101" });
    x.store.feedback(
      entry.id,
      { kind: "SKIPPED", note: "test version edit" },
      x.now(),
    );
    const updated = x.store.updatePlan(
      x.plan.id,
      { ...planInput, entryMax: "104", chaseLimit: { enabled: false } },
      x.plan.version,
      x.now(),
    );
    expect(updated.version).toBe(x.plan.version + 1);
    expect(x.store.decisionInput(entry.id)).toEqual(before);
    expect(before).toMatchObject({
      config: { planVersion: x.plan.version, chaseFromLowMax: "0.03" },
      planVersion: { version: x.plan.version, chaseLimit: enabled },
    });
    audit(x.store, entry);
  });

  it("uses the newly reviewed frozen version on formal recovery without mutating the previous attempt", async () => {
    const x = await formal();
    x.minute(0, touch);
    x.store.pause(x.plan.id, x.plan.version, x.now());
    x.runner.flush();
    const source = x.runner.status(x.plan.id)!;
    const before = config(x.store, "closed_attempts", x.plan.attemptId!);
    const updated = x.store.updatePlan(
      x.plan.id,
      { ...planInput, entryMax: "104", chaseLimit: { enabled: false } },
      x.plan.version,
      x.now(),
    );
    const recovered = x.runner.activate(
      x.plan.id,
      { expectedVersion: updated.version, expectedAttemptId: null },
      {
        sourceAttemptId: x.plan.attemptId!,
        expectedWatermark: source.watermark,
      },
    ).plan;
    expect(
      config(x.store, "closed_attempts", recovered.attemptId!),
    ).not.toHaveProperty("chaseFromLowMax");
    expect(config(x.store, "closed_attempts", x.plan.attemptId!)).toEqual(
      before,
    );
    expect(before.chaseFromLowMax).toBe("0.03");
  });
});

describe("synthetic quick and persistent runtime chase controls", () => {
  it.each(["quick", "persistent"] as const)(
    "freezes percent conversion and audits a blocked %s replay",
    (kind) => {
      const x = synthetic(enabled, "103.01");
      if (kind === "quick") replayPlan(x.store, x.plan.id, NOW);
      else {
        x.runner.start(x.plan.id, x.command);
        x.runner.step(x.plan.id, { ...x.command, expectedStep: 0, count: 3 });
      }
      const blocked = x.store
        .eventsForAttempt(x.plan.attemptId!)
        .find((e) => e.type === "RISK_BLOCKED")!;
      expect(blocked.reasons).toContain("CHASE_FROM_LOW_EXCEEDED");
      expect(blocked.snapshot).toMatchObject({
        config: { chaseFromLowMax: "0.03" },
        planVersion: { chaseLimit: enabled },
      });
      expect(assessment(blocked)).toMatchObject({
        lod: {
          price: "100",
          from: OPEN,
          through: OPEN + 2 * MINUTE,
          complete: true,
        },
        checks: { chase: { status: "BLOCKED" } },
      });
      audit(x.store, blocked);
    },
  );

  it.each(["quick", "persistent"] as const)(
    "keeps disabled chase absent from %s replay checks",
    (kind) => {
      const x = synthetic({ enabled: false }, "103.01");
      if (kind === "quick") replayPlan(x.store, x.plan.id, NOW);
      else {
        x.runner.start(x.plan.id, x.command);
        x.runner.step(x.plan.id, { ...x.command, expectedStep: 0, count: 3 });
      }
      const entry = x.store
        .eventsForAttempt(x.plan.attemptId!)
        .find((e) => e.type === "HISTORICAL_TRIGGERED")!;
      expect(entry).toBeDefined();
      expect(entry.snapshot.config).not.toHaveProperty("chaseFromLowMax");
      expect(assessment(entry).checks).not.toHaveProperty("chase");
      audit(x.store, entry);
    },
  );

  it("clears an old enabled value when the frozen recovery version disables it", () => {
    const x = synthetic();
    x.runner.start(x.plan.id, x.command);
    x.runner.step(x.plan.id, { ...x.command, expectedStep: 0 });
    x.store.pause(x.plan.id, x.plan.version, NOW);
    const old = config(x.store, "runtime_attempts", x.plan.attemptId!);
    const updated = x.store.updatePlan(
      x.plan.id,
      { ...x.input, chaseLimit: { enabled: false } },
      x.plan.version,
      NOW,
    );
    const recovered = x.runner.recover(x.plan.id, {
      expectedVersion: updated.version,
      expectedAttemptId: null,
      sourceAttemptId: x.plan.attemptId!,
      expectedStep: 1,
    });
    expect(
      config(x.store, "runtime_attempts", recovered.attemptId),
    ).not.toHaveProperty("chaseFromLowMax");
    expect(config(x.store, "runtime_attempts", x.plan.attemptId!)).toEqual(old);
    expect(old.chaseFromLowMax).toBe("0.03");
  });

  it("rejects recovery-only LOD instead of borrowing the original fixture's whole-session low", () => {
    const x = synthetic();
    x.runner.start(x.plan.id, x.command);
    x.runner.step(x.plan.id, { ...x.command, expectedStep: 0 });
    x.store.pause(x.plan.id, x.plan.version, NOW);
    const recovered = x.runner.recover(x.plan.id, {
      ...x.command,
      sourceAttemptId: x.plan.attemptId!,
      expectedStep: 1,
    });
    const c = config(x.store, "runtime_attempts", recovered.attemptId);
    const bar = (
      i: number,
      values: ReturnType<typeof breakout>,
    ): Extract<RuntimeInput, { type: "BAR" }> => ({
      type: "BAR",
      id: `synthetic:recovery:${i}`,
      receivedAt: OPEN + (i + 1) * MINUTE,
      bar: {
        id: `synthetic:recovery:bar:${i}`,
        sessionId: c.sessionId,
        period: "1m",
        start: OPEN + i * MINUTE,
        end: OPEN + (i + 1) * MINUTE,
        receivedAt: OPEN + (i + 1) * MINUTE,
        final: true,
        revision: "synthetic-test",
        ...values,
      },
    });
    x.runner.ingest(
      recovered.attemptId,
      bar(2, { open: "100.5", high: "100.6", low: "100.4", close: "100.5" }),
    );
    const retest = bar(3, touch);
    x.runner.ingest(recovered.attemptId, retest);
    x.runner.ingest(recovered.attemptId, {
      type: "REFERENCE",
      id: "synthetic:recovery:ref",
      receivedAt: retest.receivedAt,
      candidate: {
        start: OPEN + 4 * MINUTE,
        end: OPEN + 5 * MINUTE,
        period: "1m",
      },
      bar: retest.bar,
    });
    x.runner.ingest(recovered.attemptId, bar(4, breakout("101")));
    const blocked = x.store
      .eventsForAttempt(recovered.attemptId)
      .find((e) => e.type === "RISK_BLOCKED")!;
    expect(blocked.reasons).toContain("SESSION_LOW_INCOMPLETE");
    expect(assessment(blocked).lod).toMatchObject({
      from: recovered.activatedAt,
      complete: false,
    });
    audit(x.store, blocked);
  });
});
