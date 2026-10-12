import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../store.js";
import { ScreeningService } from "../screening-service.js";
import { createApp, type PullbackApp } from "../app.js";
import { DATABASE_MIGRATIONS, runMigrations } from "../migrations.js";
import { DEFAULT_SCREENING_PARAMETERS } from "../../../packages/domain/screening-rules.js";
import {
  demoInstruments,
  generateDemoBars,
} from "../../../packages/market-data/fixtures.js";
import { emptyMarketWorkerStatus } from "../market-worker.js";
import type {
  CandidatePage,
  PlanInput,
  ScreeningSettings,
} from "../../../packages/contracts/index.js";
const NOW = Date.parse("2026-10-12T10:00:00Z");
const stores: Store[] = [];
const apps: PullbackApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const store = new Store();
  stores.push(store);
  for (const instrument of demoInstruments) {
    store.putInstrument({ instrument, manual: false, tags: [], note: "" });
    store.putBars(instrument.id, "1D", generateDemoBars(instrument.id));
  }
  return store;
}
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
  reason: "Synthetic testing",
  backgroundConfirmed: true,
};

describe("versioned screening settings", () => {
  it("freezes rules only into explicitly created plan versions and retains prior bytes", () => {
    const store = setup();
    const draft = store.createPlan(planInput, NOW);
    expect(draft.screeningRuleSnapshot).toBeNull();
    const firstBytes = store.db
      .prepare("SELECT json FROM plan_versions WHERE plan_id=? AND version=1")
      .get(draft.id);
    const settings = store.confirmScreening(
      DEFAULT_SCREENING_PARAMETERS,
      0,
      NOW,
    );
    expect(settings.current).toMatchObject({
      version: 1,
      confirmedAt: NOW,
      confirmationBasis: "USER_CONFIRMED",
    });
    expect(store.plan(draft.id).screeningRuleSnapshot).toBeNull();
    const updated = store.updatePlan(draft.id, planInput, 1, NOW + 1);
    expect(updated.screeningRuleSnapshot).toEqual(settings.current);
    const secondBytes = store.db
      .prepare("SELECT json FROM plan_versions WHERE plan_id=? AND version=2")
      .get(draft.id);
    store.confirmScreening(
      { ...DEFAULT_SCREENING_PARAMETERS, adrMinPct: "3" },
      1,
      NOW + 2,
    );
    expect(
      store.db
        .prepare("SELECT json FROM plan_versions WHERE plan_id=? AND version=1")
        .get(draft.id),
    ).toEqual(firstBytes);
    expect(
      store.db
        .prepare("SELECT json FROM plan_versions WHERE plan_id=? AND version=2")
        .get(draft.id),
    ).toEqual(secondBytes);
    expect(store.plan(draft.id).screeningRuleSnapshot).toEqual(
      settings.current,
    );
    expect(() =>
      store.db
        .prepare("UPDATE screening_rule_versions SET json='{}' WHERE version=1")
        .run(),
    ).toThrow("IMMUTABLE_SCREENING_RULE");
    expect(() =>
      store.db
        .prepare("DELETE FROM screening_rule_versions WHERE version=1")
        .run(),
    ).toThrow("IMMUTABLE_SCREENING_RULE");
    expect(() =>
      store.db
        .prepare(
          "INSERT OR REPLACE INTO screening_rule_versions SELECT * FROM screening_rule_versions WHERE version=1",
        )
        .run(),
    ).toThrow("IMMUTABLE_SCREENING_RULE");
  });

  it("migrates only legacy confirmation and does not rewrite a pre-existing plan archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "pullback-screening-"));
    dirs.push(dir);
    const path = join(dir, "old.db");
    const db = new Database(path);
    runMigrations(db, DATABASE_MIGRATIONS.slice(0, 4));
    db.prepare(
      "INSERT INTO settings VALUES('screening_confirmed','true')",
    ).run();
    const old = '{"id":"legacy-plan","version":1,"old":true}';
    db.prepare("INSERT INTO plan_versions VALUES('legacy-plan',1,?)").run(old);
    db.close();
    const store = new Store(path);
    stores.push(store);
    expect(store.screeningSettings().current).toMatchObject({
      version: 1,
      confirmedAt: null,
      confirmationBasis: "LEGACY_CONFIRMED_FLAG",
      parameters: DEFAULT_SCREENING_PARAMETERS,
    });
    expect(store.db.prepare("SELECT json FROM plan_versions").get()).toEqual({
      json: old,
    });
    const second = new Store(path);
    stores.push(second);
    expect(second.screeningSettings()).toEqual(store.screeningSettings());
    store.confirmScreening(
      { ...DEFAULT_SCREENING_PARAMETERS, limitPerMarket: 5 },
      1,
      NOW,
    );
    expect(() =>
      second.confirmScreening(DEFAULT_SCREENING_PARAMETERS, 1, NOW),
    ).toThrow("筛选参数已有新版本");
    expect(
      second.confirmScreening(undefined, undefined, NOW).current?.parameters
        .limitPerMarket,
    ).toBe(5);
  });

  it("serves authenticated strict CAS settings and preserves command idempotency", async () => {
    const app = await createApp({
      password: "test-private-password",
      demo: true,
      now: () => NOW,
    });
    apps.push(app);
    expect((await app.inject("/api/settings/screening")).statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { "x-requested-with": "PullbackLab" },
      payload: { password: "test-private-password" },
    });
    const headers = {
      cookie: login.headers["set-cookie"]!.toString().split(";")[0],
      "x-requested-with": "PullbackLab",
    };
    const post = (payload: unknown, extra = {}) =>
      app.inject({
        method: "POST",
        url: "/api/settings/screening",
        headers: { ...headers, ...extra },
        payload: payload as object,
      });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/settings/screening",
          headers: { cookie: headers.cookie },
          payload: { confirmed: true },
        })
      ).statusCode,
    ).toBe(403);
    const initial = (
      await app.inject({ url: "/api/settings/screening", headers })
    ).json<ScreeningSettings>();
    expect(initial).toMatchObject({ version: 0, current: null });
    for (const payload of [
      { confirmed: true, expectedVersion: 0 },
      { confirmed: true, expectedVersion: 0, parameters: null },
      {
        confirmed: true,
        expectedVersion: 0,
        parameters: { ...DEFAULT_SCREENING_PARAMETERS, adrMinPct: "1e-1" },
      },
      {
        confirmed: true,
        expectedVersion: 0,
        parameters: { ...DEFAULT_SCREENING_PARAMETERS, bad: "ignored?" },
      },
      { confirmed: true, extra: true },
    ])
      expect((await post(payload)).statusCode).toBe(400);
    const payload = {
      confirmed: true,
      expectedVersion: 0,
      parameters: DEFAULT_SCREENING_PARAMETERS,
    };
    const first = await post(payload, {
      "idempotency-key": "screening-confirm-1",
    });
    expect(first.statusCode).toBe(200);
    expect(
      (
        await post(payload, { "idempotency-key": "screening-confirm-1" })
      ).json(),
    ).toEqual(first.json());
    expect((await post(payload)).statusCode).toBe(409);
    const next = await post({
      ...payload,
      expectedVersion: 1,
      parameters: { ...DEFAULT_SCREENING_PARAMETERS, limitPerMarket: 2 },
    });
    expect(next.statusCode).toBe(200);
    expect((await post({ confirmed: true })).json()).toEqual(next.json());
    expect(
      app.store.db
        .prepare("SELECT count(*) AS count FROM screening_rule_versions")
        .get(),
    ).toEqual({ count: 2 });
  });
});

describe("candidate snapshot and health", () => {
  it("keeps manual identity and rank separate from computed eligibility", () => {
    const store = setup();
    const row = store.instrument("DEMO-US-A");
    store.putInstrument({ ...row, manual: true });
    store.confirmScreening(DEFAULT_SCREENING_PARAMETERS, 0, NOW);
    const page = new ScreeningService(store).candidates(NOW);
    const manual = page.candidates.find(
      (candidate) => candidate.instrument.id === row.instrument.id,
    )!;
    expect(manual).toMatchObject({
      manual: true,
      origin: "MANUAL",
      status: "MANUAL",
      screeningStatus: "PASS",
      rank: null,
    });
    expect(page.marketCoverage.US).toMatchObject({
      total: 2,
      manual: 1,
      passed: 2,
      ranked: 1,
    });
    const real = {
      ...row.instrument,
      id: "US:REAL.US",
      symbol: "REAL.US",
      rulesVerified: false,
    };
    store.putInstrument({ instrument: real, manual: true, tags: [], note: "" });
    const other = new ScreeningService(store)
      .candidates(NOW)
      .candidates.find((candidate) => candidate.instrument.id === real.id)!;
    expect(other).toMatchObject({
      status: "MANUAL",
      screeningStatus: "UNKNOWN",
      rank: null,
      dataCutoff: null,
      knownAt: null,
      turnoverBasis: "MISSING",
      health: { state: "MISSING" },
    });
    expect(other.health.reasons).toContain("INSTRUMENT_RULES_UNVERIFIED");
  });

  it("excludes incomplete, future receipts and future timestamps without pretending the cutoff is fresh", () => {
    const store = setup();
    store.confirmScreening(DEFAULT_SCREENING_PARAMETERS, 0, NOW);
    const last = generateDemoBars("DEMO-US-A").at(-1)!;
    const additions = [
      {
        ...last,
        id: "synthetic:unfinished",
        time: last.time + 86400,
        final: false,
        receivedAt: NOW - 1,
      },
      {
        ...last,
        id: "synthetic:future-receipt",
        time: last.time + 2 * 86400,
        receivedAt: NOW + 1,
      },
      {
        ...last,
        id: "synthetic:future-time",
        time: NOW / 1000 + 86400,
        receivedAt: NOW - 1,
      },
    ];
    store.putBars("DEMO-US-A", "1D", additions);
    const service = new ScreeningService(store);
    const page = service.candidates(NOW);
    const row = page.candidates.find(
      (candidate) => candidate.instrument.id === "DEMO-US-A",
    )!;
    expect(row).toMatchObject({
      dataCutoff: last.time,
      knownAt: last.receivedAt,
      date: "2026-10-08",
      health: { ignoredUnfinished: 1, ignoredFuture: 2 },
    });
    const later = service.candidates(NOW + 2);
    expect(later.cacheHit).toBe(false);
    expect(
      later.candidates.find(
        (candidate) => candidate.instrument.id === "DEMO-US-A",
      )?.dataCutoff,
    ).toBe(additions[1].time);
  });

  it("reuses calculations but invalidates on old bar contents, metadata and rules while refreshing worker state", () => {
    const store = setup();
    store.confirmScreening(DEFAULT_SCREENING_PARAMETERS, 0, NOW);
    const service = new ScreeningService(store);
    const first = service.candidates(NOW);
    expect(first.cacheHit).toBe(false);
    const worker = {
      ...emptyMarketWorkerStatus(),
      state: "BACKOFF" as const,
      lastFailureAt: NOW + 1,
      lastErrorCode: "PROVIDER_TIMEOUT",
    };
    const cached = service.candidates(NOW + 1, worker);
    expect(cached).toMatchObject({
      cacheHit: true,
      computedAt: NOW,
      evaluatedAt: NOW + 1,
      workerHealth: { state: "BACKOFF", lastErrorCode: "PROVIDER_TIMEOUT" },
    });
    expect(cached.candidates[0].health).toEqual(first.candidates[0].health);
    // An old EMA seed changes while series length and latest time stay identical.
    const old = store.bars("DEMO-US-A", "1D")[0];
    store.db
      .prepare(
        "UPDATE bars SET json=? WHERE instrument_id=? AND period='1D' AND bar_id=?",
      )
      .run(JSON.stringify({ ...old, close: old.high }), "DEMO-US-A", old.id);
    expect(service.candidates(NOW + 2).cacheHit).toBe(false);
    expect(service.candidates(NOW + 3).cacheHit).toBe(true);
    store.putInstrument({
      ...store.instrument("DEMO-US-A"),
      tags: ["updated"],
      note: "new note",
    });
    const metadata = service.candidates(NOW + 4);
    expect(metadata.cacheHit).toBe(false);
    expect(metadata.universeRevision).not.toBe(first.universeRevision);
    store.confirmScreening(
      {
        ...DEFAULT_SCREENING_PARAMETERS,
        minimumAdv20: { US: "999999999999", CN: "999999999999" },
      },
      1,
      NOW + 5,
    );
    const changed = service.candidates(NOW + 6);
    expect(changed.cacheHit).toBe(false);
    expect(
      changed.candidates.every(
        (candidate) =>
          candidate.screeningStatus === "FAIL" && candidate.rank === null,
      ),
    ).toBe(true);
    changed.candidates[0].note = "must not mutate cache";
    expect(service.candidates(NOW + 7).candidates[0].note).not.toBe(
      "must not mutate cache",
    );
  });
});
