import { afterEach, describe, expect, it } from "vitest";
import { setupClosed, OPEN } from "./closed-bar-fixture.js";
const opened: Awaited<ReturnType<typeof setupClosed>>[] = [];
async function setup(options: Parameters<typeof setupClosed>[0] = {}) {
  const x = await setupClosed(options);
  opened.push(x);
  return x;
}
afterEach(async () => {
  for (const x of opened.splice(0)) await x.close();
});
describe("formal closed-bar runtime", () => {
  it("uses the server adapter path to persist a real-clock entry and SSE event", async () => {
    const x = await setup();
    x.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
    expect(x.runner.status(x.plan.id)?.status).toBe("ARMED");
    x.minute(1, { open: "100.5", high: "101.2", low: "100.4", close: "101" });
    const events = x.store.eventsForAttempt(x.plan.attemptId!);
    expect(events.filter((e) => e.type === "ENTRY_TRIGGERED")).toHaveLength(1);
    expect(events.find((e) => e.type === "ENTRY_TRIGGERED")).toMatchObject({
      historical: false,
    });
    expect(x.store.plan(x.plan.id).status).toBe("TRIGGERED");
    expect(
      x.store.db
        .prepare("SELECT consumed FROM attempts WHERE id=?")
        .get(x.plan.attemptId),
    ).toEqual({ consumed: 1 });
    expect(x.store.eventFeed()).toBeDefined();
  });
});

describe("formal trust, archive and clock contracts", () => {
  it("audits formal trigger and risk snapshots without rewriting historical clocks", async () => {
    const x = await setup();
    x.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
    x.minute(1, { open: "100.5", high: "101.2", low: "100.4", close: "101" });
    const { auditDecisionInput } = await import("../audit-replay.js");
    for (const event of x.store.events()) {
      const snapshot = x.store.decisionInput(event.id);
      const result = auditDecisionInput({
        snapshot,
        expectedInputHash: event.snapshot.inputHash as string,
      });
      expect(result.status, `${event.type}: ${JSON.stringify(result)}`).toBe(
        "MATCH",
      );
    }
    const entry = x.store.events().find((e) => e.type === "ENTRY_TRIGGERED")!;
    expect(entry.snapshot).not.toHaveProperty("scenarioFunds");
    expect(entry.snapshot.funds).toMatchObject({
      confirmedAt: OPEN,
      fxAsOf: OPEN,
    });
  });
  it("does not consume a queued opportunity when the server clock moves backwards", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
    x.runner.drain();
    x.setNow(OPEN + 119000);
    x.adapter.quote(x.now(), "101");
    x.setNow(OPEN + 120000);
    x.adapter.sink.minute(
      x.adapter.bar(1, {
        open: "100.5",
        high: "101.2",
        low: "100.4",
        close: "101",
      }),
    );
    x.setNow(OPEN + 119999);
    x.runner.flush();
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      reason: "SERVER_CLOCK_REGRESSED",
    });
    expect(
      x.store
        .events()
        .some((e) =>
          ["TECHNICAL_TRIGGERED", "ENTRY_TRIGGERED"].includes(e.type),
        ),
    ).toBe(false);
    expect(
      x.store.db
        .prepare("SELECT consumed FROM attempts WHERE id=?")
        .get(x.plan.attemptId),
    ).toEqual({ consumed: 0 });
  });
  it("protects immutable input, context, outcome and checkpoint identities from replacement", async () => {
    const x = await setup();
    x.minute(0);
    for (const table of [
      "closed_contexts",
      "closed_receipts",
      "closed_receipt_results",
      "closed_minutes",
      "closed_inputs",
      "closed_attempts",
    ]) {
      expect(
        () =>
          x.store.db.exec(
            `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`,
          ),
        table,
      ).toThrow(/IMMUTABLE|FROZEN/);
      expect(() => x.store.db.exec(`DELETE FROM ${table}`), table).toThrow(
        /IMMUTABLE|FROZEN/,
      );
    }
  });
  it("keeps duplicate no-trade coverage idempotent without manufacturing an OHLC bar", async () => {
    const x = await setup();
    x.setNow(OPEN + 60000);
    const frame = {
      instrumentId: x.plan.instrumentId,
      sessionId: x.adapter.session.id,
      source: x.adapter.context.source,
      start: OPEN,
      end: OPEN + 60000,
      evidenceId: "verified-no-trade-test",
    };
    x.adapter.sink.noTrade(frame);
    x.setNow(OPEN + 60001);
    x.adapter.sink.noTrade(frame);
    expect(x.runner.status(x.plan.id)?.status).toBe("WAIT_RETEST");
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM closed_minutes").get(),
    ).toEqual({ n: 1 });
  });
});

it("releases subscriptions after an authoritative pause and remains bounded on adapter shutdown", async () => {
  const x = await setup();
  await new Promise((resolve) => setImmediate(resolve));
  expect(x.adapter.subscriptions).toEqual([x.plan.instrumentId]);
  x.store.pause(x.plan.id, x.plan.version, x.now());
  x.runner.flush();
  await new Promise((resolve) => setImmediate(resolve));
  expect(x.adapter.subscriptions).toEqual([]);
});

it("exposes authenticated formal activation without any market-input or proof upload route", async () => {
  const { createApp } = await import("../app.js");
  const { ContractAdapter, INSTRUMENT, planInput, testFunds } =
    await import("./closed-bar-fixture.js");
  let now = OPEN - 1;
  const adapter = new ContractAdapter();
  const app = await createApp({
    password: "formal-api-test-password",
    now: () => now,
    closedBarAdapter: adapter,
  });
  try {
    app.store.putInstrument({
      instrument: adapter.context.instrument,
      manual: true,
      note: "test",
      tags: [],
    });
    await app.monitor.start();
    app.store.confirmScreening(undefined, 0, now);
    app.store.updateFunds({ ...testFunds, fxAsOf: now }, 0, now);
    const plan = app.store.createPlan(planInput, now);
    expect((await app.inject(`/api/plans/${plan.id}/monitor`)).statusCode).toBe(
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { "x-requested-with": "PullbackLab" },
      payload: { password: "formal-api-test-password" },
    });
    const headers = {
      "x-requested-with": "PullbackLab",
      cookie: login.headers["set-cookie"]!.toString().split(";")[0],
      "idempotency-key": "formal-activate-once",
    };
    const activation = {
      method: "POST" as const,
      url: `/api/plans/${plan.id}/activate`,
      headers,
      payload: { expectedVersion: 1, expectedAttemptId: null },
    };
    const response = await app.inject(activation);
    expect(response.statusCode, response.body).toBe(200);
    const attempt = response.json().plan.attemptId;
    expect((await app.inject(activation)).json().plan.attemptId).toBe(attempt);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/plans/${plan.id}/monitor/ingest`,
          headers,
          payload: { capability: "LIVE_CLOSED_BAR", final: true },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/%61pi/plans/${plan.id}/monitor` })).statusCode,
    ).toBe(401);
    now = OPEN;
    app.store.updateFunds(testFunds, app.store.funds()!.generation, now);
    for (const [index, values] of [
      [0, { open: "100.5", high: "100.6", low: "100", close: "100.5" }],
      [1, { open: "100.5", high: "101.2", low: "100.4", close: "101" }],
    ] as const) {
      now = OPEN + (index + 1) * 60000;
      adapter.quote(now, values.close);
      adapter.sink.minute(adapter.bar(index, values));
    }
    const events = await app.inject({ url: "/api/events", headers });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain("ENTRY_TRIGGERED");
    const progress = await app.inject({
      url: `/api/plans/${plan.id}/monitor`,
      headers,
    });
    expect(progress.json().progress).toMatchObject({
      attemptId: attempt,
      status: "TRIGGERED",
    });
  } finally {
    await app.close();
  }
});

it("keeps the public entry fail-closed when clients claim verified capability", async () => {
  const { createApp } = await import("../app.js");
  const { ContractAdapter, planInput, testFunds } =
    await import("./closed-bar-fixture.js");
  const adapter = new ContractAdapter();
  const app = await createApp({
    password: "formal-default-off-password",
    now: () => OPEN,
  });
  try {
    app.store.putInstrument({
      instrument: adapter.context.instrument,
      manual: true,
      note: "test",
      tags: [],
    });
    app.store.updateFunds(testFunds, 0, OPEN);
    const plan = app.store.createPlan(planInput, OPEN);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { "x-requested-with": "PullbackLab" },
      payload: { password: "formal-default-off-password" },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/activate`,
      headers: {
        "x-requested-with": "PullbackLab",
        cookie: login.headers["set-cookie"]!.toString().split(";")[0],
      },
      payload: {
        expectedVersion: 1,
        expectedAttemptId: null,
        capability: "LIVE_CLOSED_BAR",
        verified: true,
        adapter: adapter.context,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("LIVE_CAPABILITY_UNVERIFIED");
    expect(app.store.reservations()).toHaveLength(0);
    expect(app.store.events()).toHaveLength(0);
  } finally {
    await app.close();
  }
});

it("preserves archived v1 pause behavior while reconciling formal feedback corrections", async () => {
  const x = await setup();
  const { createAttempt, reduceAttempt } =
    await import("../../../packages/domain/trigger.js");
  const row = x.store.db
    .prepare("SELECT config_json FROM closed_attempts")
    .get() as { config_json: string };
  const old = JSON.parse(row.config_json);
  delete old.allowPausedCancellation;
  delete old.allowFeedbackCorrections;
  let state = createAttempt(old);
  state = reduceAttempt(
    state,
    {
      type: "DATA_GAP",
      id: "gap",
      receivedAt: OPEN,
      ingestSeq: 1,
      reason: "TEST",
    },
    old,
  ).state;
  expect(
    reduceAttempt(
      state,
      { type: "PAUSE", id: "pause", receivedAt: OPEN + 1, ingestSeq: 2 },
      old,
    ).state.status,
  ).toBe("DATA_PAUSED");
  x.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
  x.minute(1, { open: "100.5", high: "101.2", low: "100.4", close: "101" });
  const entry = x.store.events().find((e) => e.type === "ENTRY_TRIGGERED")!;
  x.store.feedback(entry.id, { kind: "SKIPPED", note: "test" }, x.now());
  x.runner.flush();
  expect(x.runner.status(x.plan.id)).toMatchObject({
    status: "SKIPPED",
    phase: "COMPLETE",
  });
  const feedback = x.store.feedbackHistory(entry.id).at(-1);
  x.store.feedback(
    entry.id,
    { kind: "TAKEN", note: "correction", expectedRevisionId: feedback!.id },
    x.now() + 1,
  );
  x.setNow(x.now() + 1);
  x.runner.flush();
  expect(x.runner.status(x.plan.id)).toMatchObject({
    status: "TAKEN",
    phase: "COMPLETE",
  });
  const count = x.runner.status(x.plan.id)!.inputCount;
  x.runner.flush();
  expect(x.runner.status(x.plan.id)!.inputCount).toBe(count);
});

it("bounds adapter startup, rejects overlap after timeout, and fences late callbacks", async () => {
  const { ContractAdapter } = await import("./closed-bar-fixture.js");
  const { Store } = await import("../store.js");
  const { ClosedBarRuntime } = await import("../closed-bar-runtime.js");
  const adapter = new ContractAdapter();
  const store = new Store();
  store.putInstrument({
    instrument: adapter.context.instrument,
    manual: true,
    note: "test",
    tags: [],
  });
  let finish!: () => void;
  adapter.start = async (sink) => {
    adapter.sinks.push(sink);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  const runner = new ClosedBarRuntime(store, {
    adapter,
    now: () => OPEN - 1,
    adapterTimeoutMs: 10,
  });
  try {
    const starting = runner.start();
    expect(runner.availability().connected).toBe(false);
    await expect(starting).rejects.toThrow("ADAPTER_START_FAILED");
    await expect(runner.start()).rejects.toThrow("ADAPTER_START_IN_FLIGHT");
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    adapter.sink.minute(adapter.bar(0));
    expect(
      store.db.prepare("SELECT COUNT(*) n FROM closed_receipts").get(),
    ).toEqual({ n: 0 });
    adapter.stop = () => new Promise(() => {});
    await runner.stop();
    expect(runner.availability().connected).toBe(false);
  } finally {
    await runner.stop();
    store.close();
  }
});

it("keeps the entire startup handshake single-flight and cleans up resources opened after stop", async () => {
  const { ContractAdapter } = await import("./closed-bar-fixture.js");
  const { Store } = await import("../store.js");
  const { ClosedBarRuntime } = await import("../closed-bar-runtime.js");
  const adapter = new ContractAdapter(),
    store = new Store();
  store.putInstrument({
    instrument: adapter.context.instrument,
    manual: true,
    note: "test",
    tags: [],
  });
  let resolveSubscriptions!: () => void,
    starts = 0,
    stops = 0,
    resourceOpen = false;
  adapter.start = async (sink) => {
    adapter.sinks.push(sink);
    starts++;
    resourceOpen = true;
  };
  adapter.setSubscriptions = () =>
    new Promise<void>((resolve) => {
      resolveSubscriptions = resolve;
    });
  adapter.stop = async () => {
    stops++;
    resourceOpen = false;
  };
  const runner = new ClosedBarRuntime(store, {
    adapter,
    now: () => OPEN - 1,
    adapterTimeoutMs: 100,
  });
  try {
    const first = runner.start();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(runner.start()).rejects.toThrow("ADAPTER_START_IN_FLIGHT");
    expect(starts).toBe(1);
    expect(stops).toBe(0);
    const result = expect(first).rejects.toThrow("ADAPTER_START_FAILED");
    await runner.stop();
    resourceOpen = true;
    resolveSubscriptions();
    await result;
    await new Promise((resolve) => setImmediate(resolve));
    expect(resourceOpen).toBe(false);
    expect(stops).toBeGreaterThanOrEqual(2);
  } finally {
    await runner.stop();
    store.close();
  }
});

it("releases an unhealthy stream after entry without releasing the pending-feedback reservation", async () => {
  const x = await setup();
  x.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
  x.minute(1, { open: "100.5", high: "101.2", low: "100.4", close: "101" });
  await new Promise((resolve) => setImmediate(resolve));
  expect(x.adapter.subscriptions).toEqual([x.plan.instrumentId]);
  const reservations = x.store.db.prepare("SELECT * FROM reservations").all();
  expect(reservations).not.toHaveLength(0);
  x.setNow(OPEN + 210001);
  x.runner.flush();
  await new Promise((resolve) => setImmediate(resolve));
  expect(x.adapter.subscriptions).toEqual([]);
  expect(x.store.plan(x.plan.id).status).toBe("TRIGGERED");
  expect(x.store.db.prepare("SELECT * FROM reservations").all()).toEqual(
    reservations,
  );
  expect(
    x.store.events().filter((e) => e.type === "ENTRY_TRIGGERED"),
  ).toHaveLength(1);
});

it("always closes the provider and fences callbacks when persisting shutdown fails", async () => {
  const x = await setup();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = 0;
  x.adapter.stop = async () => {
    stopped++;
  };
  x.runner.startScheduler(10);
  x.store.db.exec(`CREATE TRIGGER fail_shutdown BEFORE UPDATE ON closed_streams
    BEGIN SELECT RAISE(ABORT, 'TEST_STORAGE_FAILURE'); END`);
  await expect(x.runner.stop()).rejects.toThrow("TEST_STORAGE_FAILURE");
  expect(stopped).toBe(1);
  x.store.db.exec("DROP TRIGGER fail_shutdown");
  const before = x.store.db
    .prepare("SELECT COUNT(*) n FROM closed_receipts")
    .get();
  x.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
  x.minute(1, { open: "100.5", high: "101.2", low: "100.4", close: "101" });
  x.runner.flush();
  expect(
    x.store.db.prepare("SELECT COUNT(*) n FROM closed_receipts").get(),
  ).toEqual(before);
  expect(x.store.events().some((e) => e.type === "ENTRY_TRIGGERED")).toBe(
    false,
  );
  await expect(x.runner.start()).rejects.toThrow();
});

it("rejects a provider quote outside its verified regular-session intervals", async () => {
  const x = await setup();
  x.setNow(x.adapter.session.close + 1);
  x.adapter.quote(x.now(), "101");
  expect(
    x.store.db
      .prepare(
        "SELECT status FROM closed_receipt_results ORDER BY seq DESC LIMIT 1",
      )
      .get(),
  ).toEqual({ status: "INVALID_QUOTE" });
  expect(x.runner.availability().liveEligible).toBe(false);
  expect(x.store.events().some((e) => e.type === "ENTRY_TRIGGERED")).toBe(
    false,
  );
});
