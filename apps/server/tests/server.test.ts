import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { createApp, type PullbackApp } from "../app.js";
import { Store } from "../store.js";
import { generateDemoBars } from "../../../packages/market-data/fixtures.js";
import type {
  Funds,
  Plan,
  PlanInput,
} from "../../../packages/contracts/index.js";

const now = Date.parse("2026-10-12T10:00:00Z");
const password = "test-private-password";
const requestMarker = { "x-requested-with": "PullbackLab" };
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
  reason: "明确合成固定样本",
  backgroundConfirmed: true,
  supportSelections: [
    { source: "EMA9" },
    { source: "HORIZONTAL", id: "main", price: "100", label: "人工水平线" },
  ],
};
const funds: Funds = {
  generation: 0,
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
const apps: PullbackApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
async function setup(demo = true, databasePath?: string) {
  const app = await createApp({ password, demo, databasePath, now: () => now });
  apps.push(app);
  const logged = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: requestMarker,
    payload: { password },
  });
  expect(logged.statusCode).toBe(200);
  const cookie = logged.headers["set-cookie"]!.toString().split(";")[0];
  const headers = { ...requestMarker, cookie };
  const post = (
    url: string,
    payload?: object,
    extra?: Record<string, string>,
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: { ...headers, ...extra },
      payload,
    });
  if (demo) {
    expect((await post("/api/demo/seed")).statusCode).toBe(200);
    expect(
      (await post("/api/settings/screening", { confirmed: true })).statusCode,
    ).toBe(200);
    expect(
      (await post("/api/funds", { ...funds, expectedGeneration: 0 }))
        .statusCode,
    ).toBe(200);
  }
  return { app, cookie, headers, post };
}
async function activated(
  fixture: Awaited<ReturnType<typeof setup>>,
  data = input,
) {
  const created = await fixture.post("/api/plans", data);
  expect(created.statusCode).toBe(200);
  const plan = created.json<Plan>();
  const response = await fixture.post(`/api/plans/${plan.id}/activate`, {
    expectedVersion: plan.version,
    expectedAttemptId: plan.attemptId ?? null,
  });
  expect(response.json()).not.toHaveProperty("error");
  expect(response.statusCode).toBe(200);
  return response.json<{ plan: Plan }>().plan;
}
async function replay(fixture: Awaited<ReturnType<typeof setup>>, plan: Plan) {
  const result = await fixture.post(`/api/demo/plans/${plan.id}/replay`, {
    expectedVersion: plan.version,
    expectedAttemptId: plan.attemptId ?? null,
  });
  expect(result.statusCode).toBe(200);
  return result.json<{
    events: {
      id: string;
      type: string;
      historical: boolean;
      snapshot: Record<string, unknown>;
    }[];
  }>().events;
}

describe("private API and durable workflow", () => {
  it("allows tunnel origins while blocking unconfigured access, anonymous reads/SSE and missing CSRF markers", async () => {
    const noPassword = await createApp({ demo: true });
    apps.push(noPassword);
    expect((await noPassword.inject("/api/bootstrap")).statusCode).toBe(503);
    expect((await noPassword.inject("/api/session")).json()).toMatchObject({
      configured: false,
      authenticated: false,
    });
    const { app, headers } = await setup();
    expect((await app.inject("/api/bootstrap")).statusCode).toBe(401);
    expect((await app.inject("/api/events/stream")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/demo/seed",
          headers: { cookie: headers.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/demo/seed",
          headers: { ...headers, origin: "https://research.trycloudflare.com" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/events/stream",
          headers: { origin: "https://research.trycloudflare.com" },
        })
      ).statusCode,
    ).toBe(401);
    const stored = app.store.setting("password_version")!;
    expect(stored).not.toBe(
      createHash("sha256").update(password).digest("hex"),
    );
    expect(stored).not.toContain(password);
  });
  it("starts live mode with an empty pool and UNKNOWN capabilities, never enables a manually entered live symbol", async () => {
    const { app, post, headers } = await setup(false);
    const bootstrap = (
      await app.inject({ url: "/api/bootstrap", headers })
    ).json();
    expect(bootstrap.instruments).toEqual([]);
    expect(bootstrap.funds).toBeNull();
    expect(
      bootstrap.capabilities.every(
        (x: { level: string }) => x.level === "UNKNOWN",
      ),
    ).toBe(true);
    expect((await post("/api/demo/seed")).statusCode).toBe(404);
    const instrument = (
      await post("/api/universe", { symbol: "AAPL.US", market: "US" })
    ).json();
    expect(instrument.rulesVerified).toBe(false);
    const plan = (
      await post("/api/plans", { ...input, instrumentId: instrument.id })
    ).json();
    expect(
      (
        await post(`/api/plans/${plan.id}/activate`, {
          expectedVersion: plan.version,
          expectedAttemptId: plan.attemptId ?? null,
        })
      ).json().code,
    ).toBe("LIVE_CAPABILITY_UNVERIFIED");
  });
  it("invalidates persisted sessions after password rotation while retaining the salted scrypt verifier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pullback-password-"));
    dirs.push(dir);
    const path = join(dir, "private.db");
    const first = await setup(false, path);
    const salt = first.app.store.setting("password_salt");
    const verifier = first.app.store.setting("password_version");
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const second = await createApp({
      databasePath: path,
      password: "new-private-password",
      now: () => now,
    });
    apps.push(second);
    expect(second.store.setting("password_salt")).toBe(salt);
    expect(second.store.setting("password_version")).not.toBe(verifier);
    expect(
      (await second.inject({ url: "/api/bootstrap", headers: first.headers }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await second.inject({
          method: "POST",
          url: "/api/login",
          headers: requestMarker,
          payload: { password },
        })
      ).statusCode,
    ).toBe(401);
    const login = await second.inject({
      method: "POST",
      url: "/api/login",
      headers: requestMarker,
      payload: { password: "new-private-password" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Strict");
  });
  it("runs the three-page synthetic workflow with immutable inputs, read acknowledgement, correction history and no live entry", async () => {
    const f = await setup();
    const plan = await activated(f);
    const events = await replay(f, plan);
    expect(events.map((e) => e.type)).toEqual([
      "TECHNICAL_TRIGGERED",
      "HISTORICAL_TRIGGERED",
    ]);
    expect(events.every((e) => e.historical && e.snapshot.synthetic)).toBe(
      true,
    );
    const result = events[1];
    const snapshot = (
      await f.app.inject({
        url: `/api/events/${result.id}/input`,
        headers: f.headers,
      })
    ).json();
    expect(snapshot.inputs.length).toBe(3);
    expect(snapshot.scenarioFunds.confirmedAt).toBe(
      Date.parse("2026-10-09T13:30:00Z"),
    );
    expect(snapshot.funds.confirmedAt).toBe(now);
    expect(snapshot.risk.passed).toBe(true);
    const repeat = await replay(f, plan);
    expect(repeat.map((e) => e.id)).toEqual(events.map((e) => e.id));
    await f.post(`/api/events/${result.id}/read`);
    await f.post(`/api/events/${result.id}/feedback`, {
      kind: "SKIPPED",
      note: "仅演练",
    });
    await f.post(`/api/events/${result.id}/feedback`, {
      kind: "SKIPPED",
      note: "更正备注",
    });
    const bootstrap = (
      await f.app.inject({ url: "/api/bootstrap", headers: f.headers })
    ).json();
    expect(
      bootstrap.events.find((event: { id: string }) => event.id === result.id),
    ).toMatchObject({
      feedback: "SKIPPED",
      read: true,
    });
    expect(bootstrap.plans[0].status).toBe("SKIPPED");
    expect(f.app.store.reservations()[0].state).toBe("RELEASED");
    expect(
      (
        await f.app.inject({
          url: `/api/events/${result.id}/feedback`,
          headers: f.headers,
        })
      ).json().revisions,
    ).toHaveLength(2);
    expect(
      (
        await f.app.inject({
          url: `/api/events/${result.id}/input`,
          headers: f.headers,
        })
      ).json(),
    ).toEqual(snapshot);
  });
  it("preserves plan version history and rejects lost updates; idempotency keys cannot replay different inputs", async () => {
    const f = await setup();
    const extra = { "idempotency-key": "create-plan-0001" };
    const created = (await f.post("/api/plans", input, extra)).json();
    expect((await f.post("/api/plans", input, extra)).json().id).toBe(
      created.id,
    );
    expect(
      (await f.post("/api/plans", { ...input, reason: "different" }, extra))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await f.post(`/api/plans/${created.id}/versions`, {
          ...input,
          reason: "new version",
          expectedVersion: created.version,
          expectedAttemptId: created.attemptId ?? null,
        })
      ).json().version,
    ).toBe(2);
    expect(
      (
        await f.post(`/api/plans/${created.id}/versions`, {
          ...input,
          reason: "stale version",
          expectedVersion: created.version,
          expectedAttemptId: created.attemptId ?? null,
        })
      ).statusCode,
    ).toBe(409);
    const versions = f.app.store.db
      .prepare(
        "SELECT json FROM plan_versions WHERE plan_id=? ORDER BY version",
      )
      .all(created.id) as { json: string }[];
    expect(versions).toHaveLength(2);
    expect(JSON.parse(versions[0].json).reason).toBe(input.reason);
  });
  it("TAKEN dirties funds exactly once, rejects a stale form and rebuilds other reservations without deducting the trade twice", async () => {
    const f = await setup();
    await f.post("/api/funds", {
      ...funds,
      maxWeight: "1",
      expectedGeneration: 1,
    });
    const first = await activated(f);
    const second = await activated(f);
    const entry = (await replay(f, first))[1];
    await f.post(`/api/events/${entry.id}/feedback`, {
      kind: "TAKEN",
      note: "",
    });
    expect(f.app.store.funds()).toMatchObject({ generation: 3, stale: true });
    await f.post(`/api/events/${entry.id}/feedback`, {
      kind: "TAKEN",
      note: "",
    });
    expect(f.app.store.funds()!.generation).toBe(3);
    expect(
      (await f.post("/api/funds", { ...funds, expectedGeneration: 2 }))
        .statusCode,
    ).toBe(409);
    expect((await f.post(`/api/plans/${second.id}/risk`)).json().passed).toBe(
      false,
    );
    const before = f.app.store
      .reservations()
      .find((r) => r.planId === second.id)!;
    const newFunds = await f.post("/api/funds", {
      ...funds,
      cash: { USD: "8000", CNY: "0" },
      maxWeight: "1",
      existing: { "DEMO-US-A": "2000" },
      expectedGeneration: 3,
    });
    expect(newFunds.statusCode).toBe(200);
    expect(f.app.store.funds()).toMatchObject({
      generation: 4,
      stale: false,
      cash: { USD: "8000" },
    });
    expect(
      f.app.store.reservations().find((r) => r.planId === first.id)!.state,
    ).toBe("RELEASED");
    expect(
      f.app.store.reservations().find((r) => r.planId === second.id),
    ).toMatchObject({
      state: "ACTIVE",
      generation: 4,
      quantity: before.quantity,
    });
  });
  it("consumes a risk-blocked technical attempt and does not revive it when funds improve", async () => {
    const f = await setup();
    const plan = await activated(f);
    // User invalidates funds after activation; history may be researched, never reused for a fresh entry.
    const current = f.app.store.funds()!;
    f.app.store.db
      .prepare("INSERT INTO account_snapshots VALUES(?,?)")
      .run(2, JSON.stringify({ ...current, generation: 2, stale: true }));
    f.app.store.setSetting("funds_generation", "2");
    const events = await replay(f, plan);
    expect(events.map((e) => e.type)).toEqual([
      "TECHNICAL_TRIGGERED",
      "RISK_BLOCKED",
    ]);
    await f.post("/api/funds", { ...funds, expectedGeneration: 2 });
    expect((await replay(f, plan)).map((e) => e.id)).toEqual(
      events.map((e) => e.id),
    );
    expect(
      f.app.store.events().filter((e) => e.type === "HISTORICAL_TRIGGERED"),
    ).toHaveLength(0);
  });
  it("retains pending-entry locks and state even when a refreshed cash snapshot is insufficient", async () => {
    const f = await setup();
    const p = await activated(f);
    const entry = (await replay(f, p))[1];
    const reservation = f.app.store.reservations()[0];
    await f.post("/api/funds", {
      ...funds,
      cash: { USD: "0", CNY: "0" },
      expectedGeneration: 1,
    });
    expect(f.app.store.plan(p.id).status).toBe("TRIGGERED");
    expect(f.app.store.reservations()[0]).toMatchObject({
      state: "ACTIVE",
      cash: reservation.cash,
      quantity: reservation.quantity,
      generation: 2,
    });
    expect(
      (
        await f.post(`/api/plans/${p.id}/pause`, {
          expectedVersion: p.version,
          expectedAttemptId: p.attemptId ?? null,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.post(`/api/plans/${p.id}/versions`, {
          ...input,
          expectedVersion: p.version,
          expectedAttemptId: p.attemptId ?? null,
        })
      ).statusCode,
    ).toBe(409);
    await f.post(`/api/events/${entry.id}/feedback`, {
      kind: "SKIPPED",
      note: "",
    });
    expect(f.app.store.reservations()[0].state).toBe("RELEASED");
  });
  it("pauses on instrument or daily revision changes instead of mixing evidence into a frozen plan", async () => {
    const f = await setup();
    const p = await activated(f);
    const row = f.app.store.instrument(p.instrumentId);
    f.app.store.putInstrument({
      ...row,
      instrument: { ...row.instrument, tick: "0.05" },
    });
    const events = await replay(f, p);
    expect(events.map((e) => e.type)).toEqual(["REPLAY_RESULT"]);
    expect(f.app.store.plan(p.id).status).toBe("DATA_PAUSED");
    expect(f.app.store.planVersion(p).instrument.tick).toBe("0.01");
  });
  it("projects AVWAP from completed daily bars and rejects invalid anchors/ticks", async () => {
    const f = await setup();
    const daily = (
      await f.app.inject({
        url: "/api/instruments/DEMO-US-A/bars?period=1D",
        headers: f.headers,
      })
    ).json();
    const anchorTime = daily.bars.at(-8).time;
    const result = await f.post("/api/plans", { ...input, anchorTime });
    expect(result.statusCode).toBe(200);
    const projected = (
      await f.app.inject({
        url: "/api/instruments/DEMO-US-A/bars?period=1m",
        headers: f.headers,
      })
    ).json();
    expect(
      projected.avwap.every(
        (v: string | null) => v !== null && v === projected.avwap[0],
      ),
    ).toBe(true);
    expect(
      (await f.post("/api/plans", { ...input, anchorTime: 1234 })).statusCode,
    ).toBe(400);
    expect(
      (await f.post("/api/plans", { ...input, stop: "99.405" })).statusCode,
    ).toBe(400);
  });
  it("returns consistent runtime envelopes and isolates step execution from legacy replay", async () => {
    const f = await setup();
    const p = await activated(f);
    const command = {
      expectedVersion: p.version,
      expectedAttemptId: p.attemptId,
    };
    const start = await f.post(
      `/api/demo/plans/${p.id}/runtime/start`,
      command,
    );
    expect(start.statusCode).toBe(200);
    expect(start.json().runtime).toMatchObject({
      attemptId: p.attemptId,
      step: 0,
    });
    const next = await f.post(`/api/demo/plans/${p.id}/runtime/step`, {
      ...command,
      expectedStep: 0,
      count: 1,
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().runtime.step).toBeGreaterThan(0);
    const read = (
      await f.app.inject({
        url: `/api/demo/plans/${p.id}/runtime`,
        headers: f.headers,
      })
    ).json();
    expect(read.runtime.step).toBe(next.json().runtime.step);
    expect(
      (await f.post(`/api/demo/plans/${p.id}/replay`, command)).json().code,
    ).toBe("RUNTIME_ALREADY_STARTED");
    const live = await setup(false);
    expect(
      (await live.post(`/api/demo/plans/${p.id}/runtime/start`, command))
        .statusCode,
    ).toBe(404);
  });
  it("resumes SSE from a durable feed cursor, leaves it unread and reports unknown cursors", async () => {
    const f = await setup();
    const p = await activated(f);
    const cursor = f.app.store.eventPage().feedCursor;
    const events = await replay(f, p);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/events/stream`, {
      headers: { cookie: f.cookie, "last-event-id": cursor },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain(`"id":"${events[1].id}"`);
    expect(text).toContain(`"id":"${events[0].id}"`);
    expect(text).not.toContain("sourceBars");
    expect(f.app.store.event(events[1].id).read).toBe(false);
    expect(
      (
        await f.app.inject({
          url: "/api/events?after=missing",
          headers: f.headers,
        })
      ).json().code,
    ).toBe("CURSOR_EXPIRED");
  });
  it("keeps notifications and snapshots across backup, marks restored funds stale and requires a new login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pullback-backup-"));
    dirs.push(dir);
    const f = await setup(true, join(dir, "source.db"));
    const p = await activated(f);
    const events = await replay(f, p);
    const backup = join(dir, "backup.db");
    await f.app.store.backup(backup);
    const restored = await createApp({
      databasePath: backup,
      password,
      demo: true,
      now: () => now,
    });
    apps.push(restored);
    expect(restored.store.events().map((e) => e.id)).toEqual(
      events.map((e) => e.id),
    );
    expect(restored.store.funds()).toMatchObject({
      stale: true,
      generation: 2,
    });
    expect(
      (await restored.inject({ url: "/api/bootstrap", headers: f.headers }))
        .statusCode,
    ).toBe(401);
    expect(restored.store.db.pragma("integrity_check", { simple: true })).toBe(
      "ok",
    );
  });
});

describe("SQLite transaction boundary", () => {
  it("synchronizes independent processes at a barrier; only one can reserve the last available cash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pullback-race-"));
    dirs.push(dir);
    const path = join(dir, "race.db");
    const store = new Store(path);
    const instrument = {
      id: "DEMO-US-A",
      symbol: "RACE.US",
      name: "Synthetic concurrency fixture",
      market: "US" as const,
      currency: "USD" as const,
      tick: "0.01",
      qMin: 1,
      qStep: 1,
      sellSameDay: true,
      rulesVerified: true,
    };
    store.putInstrument({ instrument, manual: false, tags: [], note: "" });
    store.putBars(instrument.id, "1D", generateDemoBars(instrument.id));
    store.updateFunds(
      { ...funds, cash: { USD: "100", CNY: "0" }, maxWeight: "1" },
      0,
      now,
    );
    const raceInput = {
      ...input,
      instrumentId: instrument.id,
      stop: "90",
      entryMin: "99",
      entryMax: "100",
    };
    const plans = [
      store.createPlan(raceInput, now),
      store.createPlan(raceInput, now),
    ];
    const workers = plans.map((plan) =>
      fork(
        resolve("apps/server/tests/activate-worker.ts"),
        [path, plan.id, String(now)],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      ),
    );
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolveReady, reject) => {
            worker.once("message", () => resolveReady());
            worker.once("error", reject);
            worker.once("exit", (code) => {
              if (code) reject(new Error(`worker exited ${code}`));
            });
          }),
      ),
    );
    const resultsPromise = Promise.all(
      workers.map(
        (worker) =>
          new Promise<{ passed: boolean; code?: string }>(
            (resolveResult, reject) => {
              worker.once("message", (value) =>
                resolveResult(value as { passed: boolean; code?: string }),
              );
              worker.once("error", reject);
            },
          ),
      ),
    );
    workers.forEach((worker) => worker.send("start"));
    const results = await resultsPromise;
    expect(results.filter((r) => r.passed)).toHaveLength(1);
    expect(results.find((r) => !r.passed)!.code).toBe("RISK_BLOCKED");
    const allocated = store
      .reservations()
      .filter((r) => r.state === "ACTIVE")
      .reduce((n, r) => n.plus(r.cash), new Decimal(0));
    expect(allocated.toFixed()).toBe("100");
    expect(
      store.db.prepare("SELECT count(*) count FROM attempts").get(),
    ).toEqual({ count: 1 });
    store.close();
    await Promise.all(
      workers.map((worker) =>
        worker.exitCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolveExit) =>
              worker.once("exit", () => resolveExit()),
            ),
      ),
    );
  }, 15_000);
  it("rolls back state, reservation, input and event together if notification persistence fails", async () => {
    const f = await setup();
    const p = await activated(f);
    f.app.store.db.exec(
      "CREATE TRIGGER fail_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;",
    );
    expect(
      (
        await f.post(`/api/demo/plans/${p.id}/replay`, {
          expectedVersion: p.version,
          expectedAttemptId: p.attemptId ?? null,
        })
      ).statusCode,
    ).toBe(500);
    expect(f.app.store.events()).toHaveLength(0);
    expect(f.app.store.plan(p.id).status).toBe("WAIT_RETEST");
    expect(
      f.app.store.db
        .prepare("SELECT consumed FROM attempts WHERE id=?")
        .get(p.attemptId),
    ).toEqual({ consumed: 0 });
    expect(
      f.app.store.db
        .prepare("SELECT count(*) count FROM decision_inputs")
        .get(),
    ).toEqual({ count: 0 });
    f.app.store.db.exec("DROP TRIGGER fail_notification");
    expect((await replay(f, p)).map((e) => e.type)).toEqual([
      "TECHNICAL_TRIGGERED",
      "HISTORICAL_TRIGGERED",
    ]);
  });
});
