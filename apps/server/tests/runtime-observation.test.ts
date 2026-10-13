import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeObservation } from "../runtime-observation.js";
import { OPEN, setupClosed } from "./closed-bar-fixture.js";
function clock() {
  let wall = 1_000_000,
    mono = 1000;
  return {
    wallNow: () => wall,
    monotonicNow: () => mono,
    advance: (w: number, m = w) => {
      wall += w;
      mono += m;
    },
  };
}
const opened: Awaited<ReturnType<typeof setupClosed>>[] = [];
async function setup(options: Parameters<typeof setupClosed>[0] = {}) {
  const observationClock = clock();
  const x = await setupClosed({ ...options, observationClock });
  opened.push(x);
  return { ...x, observationClock };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const x of opened.splice(0)) await x.close();
});
const touch = { open: "100.5", high: "100.6", low: "100", close: "100.5" };
const entry = { open: "100.5", high: "101.2", low: "100.4", close: "101" };
const noEntry = (x: Awaited<ReturnType<typeof setup>>) => {
  expect(x.store.events().some((e) => e.type === "ENTRY_TRIGGERED")).toBe(
    false,
  );
  expect(
    x.store.db
      .prepare("SELECT consumed FROM attempts WHERE id=?")
      .get(x.plan.attemptId),
  ).toEqual({ consumed: 0 });
  expect(x.runner.status(x.plan.id)).toMatchObject({
    status: "DATA_PAUSED",
    reason: "RUNTIME_OBSERVATION_GAP",
  });
};

describe("independent process observation clock", () => {
  it.each([
    [20000, 20000],
    [20000, 0],
    [0, 20000],
    [-1, 0],
    [0, -1],
    [1001, 0],
  ])("rejects lost observation or clock uncertainty (%s, %s)", (wall, mono) => {
    const c = clock(),
      observation = new RuntimeObservation(c);
    observation.reset();
    c.advance(wall, mono);
    expect(observation.healthy()).toBe(false);
    expect(observation.observe()).toBe(false);
    expect(observation.healthy()).toBe(false);
  });
  it("accepts the exact limits and read-only health never advances the baseline", () => {
    const c = clock(),
      observation = new RuntimeObservation(c);
    observation.reset();
    c.advance(4000, 5000);
    expect(observation.healthy()).toBe(true);
    c.advance(2, 2);
    expect(observation.healthy()).toBe(false);
    observation.reset();
    c.advance(5000);
    expect(observation.observe()).toBe(true);
    c.advance(5000);
    expect(observation.observe()).toBe(true);
  });
});

describe("formal observation interruptions", () => {
  it("pauses before a fresh post-gap quote and an otherwise eligible close; explicit recovery uses a new attempt", async () => {
    const x = await setup();
    x.minute(0, touch);
    expect(x.runner.status(x.plan.id)?.status).toBe("ARMED");
    x.observationClock.advance(20000);
    x.setNow(OPEN + 120000);
    expect(x.runner.availability().liveEligible).toBe(false);
    x.runner.status(x.plan.id); // UI polling cannot conceal the first callback gap.
    x.adapter.quote(x.now(), "101");
    x.adapter.sink.minute(x.adapter.bar(1, entry));
    noEntry(x);
    expect(
      x.store.db
        .prepare(
          "SELECT r.received_at,s.status FROM closed_receipts r JOIN closed_receipt_results s ON s.seq=r.seq ORDER BY r.seq DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      received_at: OPEN + 120000,
      status: "OBSERVATION_GAP_HISTORY_ONLY",
    });
    const watermark = x.runner.status(x.plan.id)!.watermark;
    await new Promise((resolve) => setImmediate(resolve));
    await x.runner.start();
    expect(x.runner.status(x.plan.id)?.status).toBe("DATA_PAUSED");
    expect(() =>
      x.runner.activate(x.plan.id, {
        expectedVersion: x.plan.version,
        expectedAttemptId: x.plan.attemptId,
      }),
    ).toThrowError(expect.objectContaining({ code: "RECOVERY_REQUIRED" }));
    const recovered = x.runner.activate(
      x.plan.id,
      { expectedVersion: x.plan.version, expectedAttemptId: x.plan.attemptId },
      { sourceAttemptId: x.plan.attemptId!, expectedWatermark: watermark },
    );
    expect(recovered.plan.attemptId).not.toBe(x.plan.attemptId);
    expect(recovered.monitor).toMatchObject({
      template: "RECOVERY",
      status: "WAIT_RETEST",
    });
  });
  it("pauses before draining timely receipts without changing their receipt time", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, entry);
    x.observationClock.advance(20000);
    x.setNow(OPEN + 140000);
    x.runner.drain();
    noEntry(x);
    expect(
      x.store.db
        .prepare(
          "SELECT received_at FROM closed_receipts ORDER BY seq DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ received_at: OPEN + 120000 });
  });
  it("commits the pause even when an activation request subsequently throws", async () => {
    const x = await setup();
    x.observationClock.advance(20000);
    expect(() =>
      x.runner.activate(x.plan.id, {
        expectedVersion: x.plan.version,
        expectedAttemptId: x.plan.attemptId,
      }),
    ).toThrow();
    noEntry(x);
  });
  it.each(["risk", "transition"] as const)(
    "rolls back a same-stack interruption during %s before publishing any entry or consuming the attempt",
    async (stage) => {
      const x = await setup();
      x.minute(0, touch);
      const before = x.store.reservations();
      if (stage === "risk") {
        const original = x.store.closedRisk.bind(x.store);
        vi.spyOn(x.store, "closedRisk").mockImplementationOnce((...args) => {
          const result = original(...args);
          x.observationClock.advance(20000);
          return result;
        });
      } else {
        const original = x.store.commitClosedTransition.bind(x.store);
        vi.spyOn(x.store, "commitClosedTransition").mockImplementationOnce(
          (...args) => {
            const result = original(...args);
            x.observationClock.advance(20000);
            return result;
          },
        );
      }
      x.minute(1, entry);
      noEntry(x);
      expect(x.store.reservations()).toEqual(before);
      expect(
        x.store.db
          .prepare(
            "SELECT COUNT(*) n FROM closed_inputs WHERE events_json LIKE '%ENTRY_TRIGGERED%'",
          )
          .get(),
      ).toEqual({ n: 0 });
    },
  );
  it("rolls back activation writes if observation is lost inside activation", async () => {
    const x = await setup({ activate: false });
    const original = x.store.activate.bind(x.store);
    vi.spyOn(x.store, "activate").mockImplementationOnce((...args) => {
      const result = original(...args);
      x.observationClock.advance(20000);
      return result;
    });
    expect(() =>
      x.runner.activate(x.plan.id, {
        expectedVersion: x.plan.version,
        expectedAttemptId: null,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUNTIME_OBSERVATION_GAP" }),
    );
    expect(x.store.plan(x.plan.id).attemptId).toBeNull();
    expect(x.store.reservations()).toEqual([]);
    expect(x.runner.status(x.plan.id)).toBeNull();
    expect(x.runner.availability().liveEligible).toBe(false);
  });
  it("holds reconnect while native cleanup is pending, then allows an explicit reconnect", async () => {
    const x = await setup();
    let finish!: () => void;
    vi.spyOn(x.adapter, "stop").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    x.observationClock.advance(20000);
    x.runner.flush();
    await Promise.resolve();
    await expect(x.runner.start()).rejects.toThrow("ADAPTER_STOP_IN_FLIGHT");
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    await x.runner.start();
    expect(x.runner.availability().connected).toBe(true);
    noEntry(x);
  });
  it("normal process heartbeats do not use the injected market clock as elapsed process time", async () => {
    const x = await setup();
    x.observationClock.advance(1000);
    x.minute(0, touch);
    x.observationClock.advance(1000);
    x.minute(1, entry);
    expect(
      x.store.events().filter((e) => e.type === "ENTRY_TRIGGERED"),
    ).toHaveLength(1);
  });
});

it.each(["activate", "monitor/recover"])(
  "persists a first-wake pause outside the HTTP %s command transaction",
  async (route) => {
    const { createApp } = await import("../app.js");
    const { ContractAdapter, planInput, testFunds } =
      await import("./closed-bar-fixture.js");
    for (const idempotent of [false, true]) {
      const observationClock = clock();
      const adapter = new ContractAdapter();
      let now = OPEN - 1;
      const app = await createApp({
        password: "observation-test-password",
        now: () => now,
        observationClock,
        closedBarAdapter: adapter,
      });
      try {
        app.store.putInstrument({
          instrument: adapter.context.instrument,
          manual: true,
          note: "isolated",
          tags: [],
        });
        await app.monitor.start();
        app.store.confirmScreening(undefined, 0, now);
        app.store.updateFunds({ ...testFunds, fxAsOf: now }, 0, now);
        const created = app.store.createPlan(planInput, now);
        const plan = app.monitor.activate(created.id, {
          expectedVersion: created.version,
          expectedAttemptId: null,
        }).plan;
        const status = app.monitor.status(plan.id)!;
        const login = await app.inject({
          method: "POST",
          url: "/api/login",
          headers: { "x-requested-with": "PullbackLab" },
          payload: { password: "observation-test-password" },
        });
        observationClock.advance(20000);
        now = OPEN + 20000;
        const response = await app.inject({
          method: "POST",
          url: `/api/plans/${plan.id}/${route}`,
          headers: {
            "x-requested-with": "PullbackLab",
            cookie: login.headers["set-cookie"]!.toString().split(";")[0],
            ...(idempotent
              ? { "idempotency-key": "observation-http-failure" }
              : {}),
          },
          payload: {
            expectedVersion: plan.version,
            expectedAttemptId: plan.attemptId,
            sourceAttemptId: plan.attemptId,
            expectedWatermark: status.watermark,
          },
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(app.store.plan(plan.id).status).toBe("DATA_PAUSED");
        expect(app.monitor.status(plan.id)).toMatchObject({
          status: "DATA_PAUSED",
          reason: "RUNTIME_OBSERVATION_GAP",
        });
        expect(
          app.store.events().some((e) => e.type === "ENTRY_TRIGGERED"),
        ).toBe(false);
        expect(
          app.store.db.prepare("SELECT COUNT(*) n FROM command_results").get(),
        ).toEqual({ n: 0 });
      } finally {
        await app.close();
      }
    }
  },
);

it("reapplies a gap pause after the HTTP command rolls back a mid-activation interruption", async () => {
  const { createApp } = await import("../app.js");
  const { ContractAdapter, planInput, testFunds } =
    await import("./closed-bar-fixture.js");
  const observationClock = clock(),
    adapter = new ContractAdapter();
  const now = OPEN - 1;
  const app = await createApp({
    password: "observation-test-password",
    now: () => now,
    observationClock,
    closedBarAdapter: adapter,
  });
  try {
    app.store.putInstrument({
      instrument: adapter.context.instrument,
      manual: true,
      note: "isolated",
      tags: [],
    });
    await app.monitor.start();
    app.store.confirmScreening(undefined, 0, now);
    app.store.updateFunds({ ...testFunds, fxAsOf: now }, 0, now);
    const plan = app.store.createPlan(planInput, now);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { "x-requested-with": "PullbackLab" },
      payload: { password: "observation-test-password" },
    });
    const original = app.store.activate.bind(app.store);
    vi.spyOn(app.store, "activate").mockImplementationOnce((...args) => {
      const result = original(...args);
      observationClock.advance(20000);
      return result;
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/activate`,
      headers: {
        "x-requested-with": "PullbackLab",
        cookie: login.headers["set-cookie"]!.toString().split(";")[0],
        "idempotency-key": "observation-mid-command",
      },
      payload: { expectedVersion: plan.version, expectedAttemptId: null },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("RUNTIME_OBSERVATION_GAP");
    expect(app.store.plan(plan.id).attemptId).toBeNull();
    expect(app.store.reservations()).toEqual([]);
    expect(
      app.store.db.prepare("SELECT healthy,reason FROM closed_streams").get(),
    ).toEqual({ healthy: 0, reason: "RUNTIME_OBSERVATION_GAP" });
    expect(app.monitor.availability().liveEligible).toBe(false);
  } finally {
    await app.close();
  }
});
