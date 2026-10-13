import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppOptions, type PullbackApp } from "../app.js";
import { emptyMarketWorkerStatus } from "../market-worker.js";
import type { OperationsStatus } from "../../../packages/contracts/operations.js";
import type { Funds } from "../../../packages/contracts/index.js";

const NOW = Date.parse("2026-10-12T13:00:00Z");
const PASSWORD = "private-password-canary";
const PRIVATE = "DO-NOT-EXPORT-private-canary";
const apps: PullbackApp[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

async function setup(options: AppOptions = {}) {
  const app = await createApp({
    password: PASSWORD,
    now: () => NOW,
    ...options,
  });
  apps.push(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-requested-with": "PullbackLab" },
    payload: { password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.headers["set-cookie"]!.toString().split(";")[0];
  const read = () =>
    app.inject({ url: "/api/operations/status", headers: { cookie } });
  return { app, cookie, read };
}

function databasePath() {
  const directory = mkdtempSync(
    join(tmpdir(), "pullback-private-diagnostics-"),
  );
  directories.push(directory);
  return join(directory, "private-database.sqlite");
}

const funds: Funds = {
  generation: 0,
  nav: "123456.78",
  baseCurrency: "USD",
  cash: { USD: "87654.32", CNY: "0" },
  existing: { "PRIVATE-SYMBOL.US": "12345.67" },
  riskBudget: "50",
  riskPool: "100",
  maxWeight: "0.2",
  fx: { USD: "1", CNY: "0.14" },
  fxAsOf: NOW,
  confirmedAt: NOW,
  stale: false,
  buyFee: "0",
  sellFee: "0",
  slippageIn: "0",
  slippageOut: "0",
  feesConfirmed: true,
};

describe("authenticated operations status", () => {
  it("requires authentication and reads a memory database without changing any rows", async () => {
    const { app, read } = await setup();
    const anonymous = await app.inject("/api/operations/status");
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe("UNAUTHENTICATED");
    const before = app.store.db.prepare("SELECT total_changes() changes").get();
    const response = await read();
    const report = response.json<OperationsStatus>();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(report).toMatchObject({
      reportVersion: 1,
      capturedAt: NOW,
      runtime: { schemaVersion: 11, journalMode: "memory", synchronous: "FULL" },
      disk: null,
      security: {
        secureCookiesConfigured: false,
        originConfigured: false,
        publicTls: "UNKNOWN",
      },
      funds: {
        present: false,
        generation: null,
        stale: null,
        confirmedAt: null,
      },
      counts: {
        plans: 0,
        activePlans: 0,
        reservations: 0,
        activeReservations: 0,
        takenPendingReservations: 0,
        pendingFeedback: 0,
        unreadEvents: 0,
      },
      worker: { enabled: false, state: "DISABLED", quarantinedCount: 0 },
      markets: { US: "UNKNOWN", CN: "UNKNOWN" },
      clock: { status: "UNKNOWN", checkedAt: null },
    });
    expect(report.runtime.nodeVersion).toBe(process.versions.node);
    expect(report.runtime.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await read()).json()).toEqual(report);
    expect(
      app.store.db.prepare("SELECT total_changes() changes").get(),
    ).toEqual(before);
  });

  it("exports only an allowlist even when stored records and worker fields contain secrets", async () => {
    const { app, cookie, read } = await setup({
      secureCookies: true,
      origin: `https://${PRIVATE}.invalid`,
      marketStatus: () => ({
        ...emptyMarketWorkerStatus(),
        enabled: true,
        state: "BACKOFF",
        reason: PRIVATE,
        minuteSymbols: [PRIVATE],
        source: PRIVATE,
        lastErrorCode: PRIVATE,
        lastQuarantineReason: PRIVATE,
        lastStartedAt: NOW - 1000,
        lastSuccessAt: NOW - 500,
        lastFailureAt: NOW - 100,
        nextPollAt: NOW + 1000,
        quarantinedCount: 7,
        watermarks: [
          {
            instrumentId: PRIVATE,
            period: "1D",
            providerTimestamp: NOW,
            receivedAt: NOW,
            connectionEpoch: 1,
            historical: true,
          },
        ],
      }),
    });
    const db = app.store.db;
    app.store.setSetting("private_environment", PRIVATE);
    app.store.putInstrument({
      instrument: {
        id: PRIVATE,
        symbol: PRIVATE,
        name: PRIVATE,
        market: "US",
        currency: "USD",
        tick: "0.01",
        qMin: 1,
        qStep: 1,
        sellSameDay: true,
        rulesVerified: false,
      },
      tags: [PRIVATE],
      note: PRIVATE,
      manual: true,
    });
    app.store.updateFunds(funds, 0, NOW);
    for (const [index, status] of ["ARMED", "TRIGGERED", "DRAFT"].entries()) {
      db.prepare("INSERT INTO plans VALUES(?,1,?)").run(
        `p${index}`,
        JSON.stringify({ id: `p${index}`, status, reason: PRIVATE }),
      );
    }
    for (const [index, state] of [
      "ACTIVE",
      "TAKEN_PENDING",
      "RELEASED",
    ].entries()) {
      db.prepare("INSERT INTO reservations VALUES(?,?,?)").run(
        `p${index}`,
        index,
        JSON.stringify({
          state,
          instrumentId: PRIVATE,
          cash: PRIVATE,
          riskBase: PRIVATE,
        }),
      );
    }
    db.prepare("INSERT INTO decision_inputs VALUES(?,?)").run(
      PRIVATE,
      JSON.stringify({ private: PRIVATE }),
    );
    for (const [index, type] of [
      "ENTRY_TRIGGERED",
      "ENTRY_TRIGGERED",
      "DATA_PAUSED",
    ].entries()) {
      const event = {
        id: `e${index}`,
        planId: PRIVATE,
        type,
        time: NOW,
        receivedAt: NOW,
        message: PRIVATE,
        reasons: [PRIVATE],
        historical: false,
        snapshot: { private: PRIVATE },
      };
      db.prepare(
        "INSERT INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES(?,?,?,?,?,?)",
      ).run(
        `e${index}`,
        `a${index}`,
        type,
        `k${index}`,
        PRIVATE,
        JSON.stringify(event),
      );
      db.prepare("INSERT INTO notifications VALUES(?,?)").run(`e${index}`, NOW);
    }
    db.prepare("INSERT INTO notification_ack VALUES('e0',?)").run(NOW);
    db.prepare("INSERT INTO record_revisions VALUES('r1','e1',?,?)").run(
      NOW,
      JSON.stringify({ kind: "SKIPPED", note: PRIVATE }),
    );
    db.prepare("INSERT INTO market_worker_epochs(started_at) VALUES(?)").run(
      NOW,
    );
    db.prepare(
      `INSERT INTO market_provider_receipts(epoch,instrument_id,source,received_at,observed_at,provider_timestamp,historical,payload_hash,payload_json,status,reason)
      VALUES(1,?,?,?,?,?,1,?,?,?,?)`,
    ).run(
      PRIVATE,
      PRIVATE,
      NOW,
      NOW,
      NOW,
      PRIVATE,
      JSON.stringify({ token: PRIVATE }),
      "QUARANTINED",
      PRIVATE,
    );
    const before = db.prepare("SELECT total_changes() changes").get();
    const response = await read();
    expect(response.statusCode).toBe(200);
    const report = response.json<OperationsStatus>();
    expect(report.counts).toEqual({
      plans: 3,
      activePlans: 2,
      reservations: 3,
      activeReservations: 1,
      takenPendingReservations: 1,
      pendingFeedback: 1,
      unreadEvents: 2,
    });
    expect(report.worker).toEqual({
      enabled: true,
      state: "BACKOFF",
      lastStartedAt: NOW - 1000,
      lastSuccessAt: NOW - 500,
      lastFailureAt: NOW - 100,
      nextPollAt: NOW + 1000,
      quarantinedCount: 7,
    });
    expect(report.security).toEqual({
      secureCookiesConfigured: true,
      originConfigured: true,
      publicTls: "UNKNOWN",
    });
    expect(Object.keys(report).sort()).toEqual([
      "capturedAt",
      "clock",
      "counts",
      "disk",
      "funds",
      "markets",
      "reportVersion",
      "runtime",
      "security",
      "worker",
    ]);
    for (const secret of [
      PRIVATE,
      PASSWORD,
      cookie.split("=")[1],
      app.store.setting("password_salt")!,
      app.store.setting("password_version")!,
      funds.nav,
      funds.cash.USD,
      Object.keys(funds.existing)[0],
    ])
      expect(response.body).not.toContain(secret);
    for (const forbidden of [
      "source",
      "reason",
      "lastErrorCode",
      "watermarks",
      "nav",
      "cash",
      "existing",
      "symbol",
      "note",
      "password",
      "path",
      "session",
      "payload",
    ])
      expect(response.body).not.toContain(`"${forbidden}"`);
    expect(db.prepare("SELECT total_changes() changes").get()).toEqual(before);
  });

  it("reports actual file capacity and stale funding metadata without account amounts", async () => {
    const path = databasePath();
    const { app, read } = await setup({ databasePath: path });
    app.store.updateFunds(funds, 0, NOW - 1000);
    let report = (await read()).json<OperationsStatus>();
    expect(report.runtime.journalMode).toBe("wal");
    expect(report.disk?.totalBytes).toBeGreaterThan(0);
    expect(report.disk?.availableBytes).toBeGreaterThanOrEqual(0);
    expect(report.disk!.availableBytes).toBeLessThanOrEqual(
      report.disk!.totalBytes,
    );
    expect(report.funds).toEqual({
      present: true,
      generation: 1,
      stale: false,
      confirmedAt: NOW - 1000,
    });
    app.store.db
      .prepare("INSERT INTO account_snapshots VALUES(2,?)")
      .run(
        JSON.stringify({ ...app.store.funds(), generation: 2, stale: true }),
      );
    app.store.setSetting("funds_generation", "2");
    const response = await read();
    report = response.json<OperationsStatus>();
    expect(report.funds).toEqual({
      present: true,
      generation: 2,
      stale: true,
      confirmedAt: NOW - 1000,
    });
    expect(response.body).not.toContain(path);
    expect(response.body).not.toContain(funds.nav);
  });

  it("does not turn a failing worker status callback into a leaked exception or a ready market", async () => {
    const { read } = await setup({
      marketStatus: () => {
        throw new Error(PRIVATE);
      },
    });
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(PRIVATE);
    expect(response.json<OperationsStatus>()).toMatchObject({
      worker: { state: "UNKNOWN", quarantinedCount: null },
      markets: { US: "UNKNOWN", CN: "UNKNOWN" },
      clock: { status: "UNKNOWN" },
    });
  });
});

describe("explicit restore compatibility", () => {
  it("invalidates sessions, old command results and event cursors together while preserving ordinary restart commands", async () => {
    const path = databasePath();
    const initial = await setup({ databasePath: path });
    const store = initial.app.store;
    store.updateFunds(funds, 0, NOW - 1000);
    store.db
      .prepare(
        "INSERT INTO command_results VALUES('old-operation','/api/funds','input','{\"old\":true}')",
      )
      .run();
    const epoch = store.setting("event_feed_epoch");
    await initial.app.close();
    apps.splice(apps.indexOf(initial.app), 1);

    const restarted = await createApp({
      password: PASSWORD,
      databasePath: path,
      now: () => NOW,
    });
    apps.push(restarted);
    expect(
      restarted.store.db
        .prepare("SELECT count(*) n FROM command_results")
        .get(),
    ).toEqual({ n: 1 });
    expect(restarted.store.setting("event_feed_epoch")).toBe(epoch);
    expect(restarted.store.funds()).toMatchObject({
      generation: 2,
      stale: true,
    });
    await restarted.close();
    apps.splice(apps.indexOf(restarted), 1);

    const restored = await createApp({
      password: PASSWORD,
      databasePath: path,
      now: () => NOW + 1000,
      restore: true,
    });
    apps.push(restored);
    expect(
      restored.store.db.prepare("SELECT count(*) n FROM command_results").get(),
    ).toEqual({ n: 0 });
    expect(
      restored.store.db.prepare("SELECT count(*) n FROM sessions").get(),
    ).toEqual({ n: 0 });
    expect(restored.store.setting("event_feed_epoch")).not.toBe(epoch);
    expect(restored.store.funds()).toMatchObject({
      generation: 3,
      stale: true,
    });
    expect(
      (
        await restored.inject({
          url: "/api/operations/status",
          headers: { cookie: initial.cookie },
        })
      ).statusCode,
    ).toBe(401);
  });
});
