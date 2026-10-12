import { afterEach, expect, it } from "vitest";
import { createApp, type PullbackApp } from "../app.js";
import type { Plan, PlanInput } from "../../../packages/contracts/index.js";

const now = Date.parse("2026-10-12T10:00:00Z");
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
  reason: "合成尝试并发验证",
  backgroundConfirmed: true,
  supportSelections: [
    { source: "EMA9" },
    { source: "HORIZONTAL", id: "main", price: "100", label: "人工支撑" },
  ],
};
const apps: PullbackApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup() {
  const app = await createApp({
    demo: true,
    password: "private-attempt-test",
    now: () => now,
  });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-requested-with": "PullbackLab" },
    payload: { password: "private-attempt-test" },
  });
  const headers = {
    "x-requested-with": "PullbackLab",
    cookie: login.headers["set-cookie"]!.toString().split(";")[0],
  };
  const post = (url: string, payload?: object, key?: string) =>
    app.inject({
      method: "POST",
      url,
      headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) },
      payload,
    });
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
  const draft = (await post("/api/plans", input)).json<Plan>();
  return { app, post, draft };
}
const controls = (p: Plan) => ({
  expectedVersion: p.version,
  expectedAttemptId: p.attemptId,
});
function snapshot(app: PullbackApp) {
  return JSON.stringify({
    plans: app.store.plans(),
    funds: app.store.funds(),
    reservations: app.store.reservations(),
    events: app.store.events(),
    attempts: app.store.db.prepare("SELECT * FROM attempts").all(),
    commands: app.store.db.prepare("SELECT * FROM command_results").all(),
  });
}

it("requires an explicit attempt snapshot and rejects stale same-version controls without writes", async () => {
  const { app, post, draft } = await setup();
  const active = (
    await post(`/api/plans/${draft.id}/activate`, controls(draft))
  ).json<{ plan: Plan }>().plan;
  expect(active.attemptId).not.toBeNull();
  const before = snapshot(app);
  for (const suffix of ["activate", "pause", "versions"]) {
    const response = await post(`/api/plans/${draft.id}/${suffix}`, {
      ...(suffix === "versions" ? input : {}),
      ...controls(draft),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("ATTEMPT_CONFLICT");
  }
  const staleReplay = await post(
    `/api/demo/plans/${draft.id}/replay`,
    controls(draft),
  );
  expect(staleReplay.statusCode).toBe(409);
  expect(staleReplay.json().code).toBe("ATTEMPT_CONFLICT");
  expect(
    (await post(`/api/plans/${draft.id}/pause`, { expectedVersion: 1 }))
      .statusCode,
  ).toBe(400);
  expect(snapshot(app)).toBe(before);
});

it("reads an acknowledged activation retry without controlling the newer attempt", async () => {
  const { app, post, draft } = await setup();
  const body = controls(draft),
    key = "activate-retry-key";
  const first = await post(`/api/plans/${draft.id}/activate`, body, key);
  expect(first.statusCode).toBe(200);
  const active = first.json<{ plan: Plan }>().plan;
  await post(`/api/plans/${active.id}/pause`, controls(active));
  // Internal creation simulates another consumer replacing the attempt; HTTP users
  // must use the explicit recovery path to obtain a new attempt in this session.
  const second = app.store.activate(active.id, active.version, now + 1).plan;
  expect(second.attemptId).not.toBe(active.attemptId);
  const before = snapshot(app);
  const retry = await post(`/api/plans/${draft.id}/activate`, body, key);
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toEqual(first.json());
  expect(
    (await post(`/api/plans/${draft.id}/pause`, controls(active))).json().code,
  ).toBe("ATTEMPT_CONFLICT");
  expect(snapshot(app)).toBe(before);
});

it("does not restart an interrupted session from its beginning after pause or plan editing", async () => {
  const { app, post, draft } = await setup();
  const active = (
    await post(`/api/plans/${draft.id}/activate`, controls(draft))
  ).json<{ plan: Plan }>().plan;
  const paused = (
    await post(`/api/plans/${draft.id}/pause`, controls(active))
  ).json<Plan>();
  expect(
    (await post(`/api/plans/${draft.id}/activate`, controls(paused))).json()
      .code,
  ).toBe("RECOVERY_REQUIRED");
  const edited = (
    await post(`/api/plans/${draft.id}/versions`, {
      ...input,
      reason: "新版本仍属于同一会话",
      ...controls(paused),
    })
  ).json<Plan>();
  expect(edited.version).toBe(2);
  expect(edited.attemptId).toBeNull();
  const before = snapshot(app);
  const rejected = await post(
    `/api/plans/${draft.id}/activate`,
    controls(edited),
  );
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json().code).toBe("RECOVERY_REQUIRED");
  expect(snapshot(app)).toBe(before);
});

it("publishes recovery and its retry result atomically while old controls cannot affect the new attempt", async () => {
  const { app, post, draft } = await setup();
  const active = (
    await post(`/api/plans/${draft.id}/activate`, controls(draft))
  ).json<{ plan: Plan }>().plan;
  const start = await post(
    `/api/demo/plans/${draft.id}/runtime/start`,
    controls(active),
  );
  expect(start.statusCode).toBe(200);
  const advanced = await post(`/api/demo/plans/${draft.id}/runtime/step`, {
    ...controls(active),
    expectedStep: 0,
    count: 2,
  });
  expect(advanced.statusCode).toBe(200);
  const source = advanced.json().runtime;
  const paused = (
    await post(`/api/plans/${draft.id}/pause`, controls(active))
  ).json<Plan>();
  const recovery = {
    ...controls(paused),
    sourceAttemptId: source.attemptId,
    expectedStep: source.step,
  };
  const key = "recover-stable-result";
  const result = await post(
    `/api/demo/plans/${draft.id}/runtime/recover`,
    recovery,
    key,
  );
  expect(result.statusCode).toBe(200);
  expect(result.json().runtime).toMatchObject({
    template: "RECOVERY",
    recoveredFromAttemptId: active.attemptId,
  });
  const current = app.store.plan(draft.id);
  expect(current.attemptId).not.toBe(active.attemptId);
  const before = snapshot(app);
  const duplicate = await post(
    `/api/demo/plans/${draft.id}/runtime/recover`,
    recovery,
    key,
  );
  expect(duplicate.statusCode).toBe(200);
  expect(duplicate.json()).toEqual(result.json());
  const stale = await post(`/api/plans/${draft.id}/pause`, controls(active));
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe("ATTEMPT_CONFLICT");
  expect(
    (await post(`/api/demo/plans/${draft.id}/replay`, controls(current))).json()
      .code,
  ).toBe("RUNTIME_ALREADY_STARTED");
  expect(snapshot(app)).toBe(before);
});
