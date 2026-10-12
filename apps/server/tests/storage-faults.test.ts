import { afterEach, describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../store.js";
import { replayPlan } from "../replay.js";
import {
  demoInstruments,
  generateDemoBars,
} from "../../../packages/market-data/fixtures.js";

const now = Date.parse("2026-10-12T10:00:00Z");
const dirs: string[] = [];
const connections: Store[] = [];
afterEach(() => {
  for (const store of connections.splice(0)) if (store.db.open) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function open(path: string) {
  const store = new Store(path);
  connections.push(store);
  return store;
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pullback-fault-"));
  dirs.push(dir);
  const path = join(dir, "research.sqlite");
  const store = open(path);
  const instrument = demoInstruments[0];
  store.putInstrument({
    instrument,
    tags: [],
    note: "synthetic fault fixture",
    manual: false,
  });
  store.transaction(() => {
    for (const period of ["1D", "1m", "5m"] as const)
      store.putBars(
        instrument.id,
        period,
        generateDemoBars(instrument.id, period),
      );
  });
  store.updateFunds(
    {
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
    },
    0,
    now,
  );
  const draft = store.createPlan(
    {
      instrumentId: instrument.id,
      anchorTime: null,
      primarySupport: "100",
      lower: "99.75",
      upper: "100.25",
      stop: "99.4",
      entryMin: "100.61",
      entryMax: "101.5",
      mode: "CLOSE_CONFIRM",
      sessionDate: "2026-10-09",
      reason: "合成故障注入夹具",
      backgroundConfirmed: true,
      supportSelections: [
        { source: "EMA9" },
        { source: "HORIZONTAL", id: "base", price: "100", label: "合成水平位" },
      ],
    },
    now,
  );
  const plan = store.activate(draft.id, 1, now).plan;
  return { path, store, plan };
}
function facts(store: Store, planId: string) {
  return {
    plan: store.plan(planId),
    reservations: store.reservations(),
    attempts: store.db.prepare("SELECT * FROM attempts ORDER BY id").all(),
    inputs: store.db
      .prepare("SELECT * FROM decision_inputs ORDER BY hash")
      .all(),
    events: store.db
      .prepare("SELECT * FROM decision_events ORDER BY seq")
      .all(),
    notifications: store.db
      .prepare("SELECT * FROM notifications ORDER BY event_id")
      .all(),
  };
}
describe("SQLite failure and process crash boundaries", () => {
  it("times out on a competing writer without consuming an attempt or publishing partial facts", () => {
    const { path, store, plan } = setup();
    const contender = open(path);
    const before = facts(store, plan.id);
    contender.db.pragma("busy_timeout = 20");
    store.db.exec("BEGIN IMMEDIATE");
    try {
      expect(() => replayPlan(contender, plan.id, now)).toThrowError(
        expect.objectContaining({ code: "SQLITE_BUSY" }),
      );
    } finally {
      store.db.exec("ROLLBACK");
    }
    expect(facts(contender, plan.id)).toEqual(before);
    expect(replayPlan(contender, plan.id, now).map((e) => e.type)).toEqual([
      "TECHNICAL_TRIGGERED",
      "HISTORICAL_TRIGGERED",
    ]);
  });
  it("rolls back the complete publication on a real SQLITE_FULL page quota error", () => {
    const { store, plan } = setup();
    store.db.exec("CREATE TABLE quota_probe(payload BLOB)");
    const before = facts(store, plan.id);
    const pages = store.db.pragma("page_count", { simple: true }) as number;
    store.db.pragma(`max_page_count = ${pages + 128}`);
    expect(() =>
      store.transaction(() => {
        replayPlan(store, plan.id, now);
        // This is SQLite's real file-size limit, not a mocked exception or host ENOSPC.
        store.db
          .prepare("INSERT INTO quota_probe VALUES(zeroblob(?))")
          .run(8 * 1024 * 1024);
      }),
    ).toThrowError(expect.objectContaining({ code: "SQLITE_FULL" }));
    expect(facts(store, plan.id)).toEqual(before);
    expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
    store.db.pragma("max_page_count = 1073741823");
    expect(replayPlan(store, plan.id, now)).toHaveLength(2);
  });
  it.each(["before", "after"] as const)(
    "recovers an abrupt SIGKILL %s the notification transaction commits",
    async (boundary) => {
      const { path, store, plan } = setup();
      const before = facts(store, plan.id);
      store.close();
      const child = fork(
        resolve("apps/server/tests/storage-fault-worker.ts"),
        [path, plan.id, String(now), boundary],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      const exit = await new Promise<{
        code: number | null;
        signal: string | null;
      }>((done, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => done({ code, signal }));
      });
      expect(exit, stderr).toEqual({ code: null, signal: "SIGKILL" });
      const restored = open(path);
      expect(restored.db.pragma("integrity_check", { simple: true })).toBe(
        "ok",
      );
      if (boundary === "before")
        expect(facts(restored, plan.id)).toEqual(before);
      else {
        expect(restored.plan(plan.id).status).toBe("TRIGGERED");
        expect(restored.events()).toHaveLength(2);
        expect(
          restored.db.prepare("SELECT count(*) n FROM notifications").get(),
        ).toEqual({ n: 2 });
      }
      const events = replayPlan(restored, plan.id, now);
      expect(events.map((e) => e.type)).toEqual([
        "TECHNICAL_TRIGGERED",
        "HISTORICAL_TRIGGERED",
      ]);
      expect(replayPlan(restored, plan.id, now).map((e) => e.id)).toEqual(
        events.map((e) => e.id),
      );
      expect(restored.events()).toHaveLength(2);
      expect(
        restored.db.prepare("SELECT count(*) n FROM notifications").get(),
      ).toEqual({ n: 2 });
    },
    15_000,
  );
});
