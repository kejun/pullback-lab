import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Instrument,
  Plan,
  PlanInput,
  SupportSnapshot,
} from "../../../packages/contracts/index.js";
import type {
  ResearchChartData,
  ResearchHistoryPreview,
  ResearchHistoryStatus,
} from "../../../packages/contracts/research-history.js";
import {
  ActionEvidenceRepository,
  evidenceHash,
  type ActionManifest,
} from "../../../packages/market-data/action-evidence.js";
import { researchHistoryFixture } from "../../../packages/market-data/research-history-fixture.js";
import { demoInstruments } from "../../../packages/market-data/fixtures.js";
import { createApp, type PullbackApp } from "../app.js";
import { Store } from "../store.js";
import {
  HISTORY_MAX_BYTES,
  importResearchHistory,
  previewResearchHistory,
  readResearchHistory,
  researchHistoryBars,
  type ResearchHistoryManifest,
} from "../research-history.js";

const NOW = Date.parse("2026-10-12T10:00:00Z");
const apps: PullbackApp[] = [];
const stores: Store[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
});
function instrumentFor(market: "US" | "CN" = "US"): Instrument {
  return {
    ...demoInstruments[market === "US" ? 0 : 2],
    id: market === "US" ? "US:HISTORY.US" : "CN:600123.SH",
    symbol: market === "US" ? "HISTORY.US" : "600123.SH",
    name: "Synthetic offline historical import test",
  };
}
function addInstrument(store: Store, market: "US" | "CN" = "US") {
  const instrument = instrumentFor(market);
  store.putInstrument({
    instrument,
    manual: true,
    note: "Synthetic offline test only",
    tags: [],
  });
  return instrument;
}
function fixture(market: "US" | "CN" = "US") {
  const store = new Store();
  stores.push(store);
  const instrument = addInstrument(store, market);
  const manifest: ResearchHistoryManifest = researchHistoryFixture(market);
  return { store, instrument, manifest };
}
function confirm(
  preview: ResearchHistoryPreview,
  manifest: ResearchHistoryManifest,
) {
  return {
    manifest: structuredClone(manifest),
    token: preview.token,
    expectedHistoryId: preview.expectedHistoryId,
    expectedActionVersion: preview.expectedActionVersion,
    confirmed: true as const,
  };
}
function importFixture(f: ReturnType<typeof fixture>, now = NOW) {
  const preview = previewResearchHistory(
    f.store,
    f.instrument,
    f.manifest,
    now,
  );
  const request = confirm(preview, f.manifest);
  return {
    preview,
    request,
    result: importResearchHistory(f.store, f.instrument, request, now),
  };
}
function totalChanges(store: Store) {
  return (
    store.db.prepare("SELECT total_changes() AS n").get() as { n: number }
  ).n;
}
function count(store: Store, table: string) {
  return (
    store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}
function actionInput(
  manifest: ResearchHistoryManifest,
  expectedVersion: string | null = null,
): ActionManifest {
  return {
    ...manifest.corporateActions,
    schema: "pullback-lab-actions-v1",
    instrumentId: manifest.instrumentId,
    market: manifest.instrumentId.startsWith("CN:") ? "CN" : "US",
    expectedVersion,
    review: { reviewer: manifest.reviewer, confirmed: true },
    documents: manifest.corporateActions.documents.map((d) => ({
      ...d,
      sha256: evidenceHash(d.content),
    })),
  };
}
function planInput(
  manifest: ResearchHistoryManifest,
  researchHistoryId?: string,
): PlanInput {
  return {
    instrumentId: manifest.instrumentId,
    researchHistoryId,
    anchorTime: manifest.bars.find((b) => b.period === "1D")!.start / 1000,
    primarySupport: "50",
    lower: "49.75",
    upper: "50.25",
    stop: "49.4",
    entryMin: "50.61",
    entryMax: "51.5",
    mode: "CLOSE_CONFIRM",
    sessionDate: manifest.targetDate,
    reason: "Synthetic manual history research",
    backgroundConfirmed: true,
    supportSelections: [
      { source: "AVWAP" },
      {
        source: "HORIZONTAL",
        id: "manual",
        price: "50",
        label: "Research only",
      },
    ],
  };
}
async function appFixture(market: "US" | "CN" = "US") {
  let now = NOW;
  const app = await createApp({
    password: "research-history-test",
    demo: true,
    now: () => now,
  });
  apps.push(app);
  const instrument = addInstrument(app.store, market);
  const manifest: ResearchHistoryManifest = researchHistoryFixture(market);
  const base = `/api/instruments/${instrument.id}/research-history`;
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { "x-requested-with": "PullbackLab" },
    payload: { password: "research-history-test" },
  });
  expect(login.statusCode).toBe(200);
  const headers = {
    cookie: login.headers["set-cookie"]!.toString().split(";")[0],
    "x-requested-with": "PullbackLab",
  };
  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers, payload: payload as object });
  const get = (url: string) => app.inject({ url, headers });
  const preview = async (input: unknown = manifest) => {
    const response = await post(`${base}/preview`, { manifest: input });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ResearchHistoryPreview>();
  };
  return {
    app,
    store: app.store,
    instrument,
    manifest,
    base,
    headers,
    get,
    post,
    preview,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("manual research history validation and read-only preview", () => {
  it.each(["US", "CN"] as const)(
    "previews %s without even transient database writes or persistent preview state",
    (market) => {
      const f = fixture(market);
      const before = f.store.db.serialize(),
        changes = totalChanges(f.store);
      f.store.db.pragma("query_only = ON");
      const first = previewResearchHistory(
        f.store,
        f.instrument,
        f.manifest,
        NOW,
      );
      const second = previewResearchHistory(
        f.store,
        f.instrument,
        f.manifest,
        NOW + 1_000,
      );
      f.store.db.pragma("query_only = OFF");
      expect(first).toMatchObject({
        status: "PREVIEW",
        expectedHistoryId: null,
        expectedActionVersion: null,
        summary: {
          instrumentId: f.instrument.id,
          counts: { "1D": 1, "1m": 5, "5m": 1 },
          liveEligible: false,
        },
      });
      expect(first.token).toMatch(/^[a-f0-9]{64}$/);
      expect(second.token).toBe(first.token);
      expect(first.summary).not.toHaveProperty("id");
      expect(first.summary).not.toHaveProperty("importedAt");
      expect(first.warnings.join(" ")).toContain("不表示当时已知");
      expect(first.warnings.join(" ")).toContain("不生成历史入场提醒");
      expect(totalChanges(f.store)).toBe(changes);
      expect(f.store.db.serialize().equals(before)).toBe(true);
      for (const table of [
        "research_history",
        "corporate_action_snapshots",
        "corporate_action_facts",
        "plans",
        "decision_events",
      ])
        expect(count(f.store, table)).toBe(0);
    },
  );

  const invalid: {
    name: string;
    mutate: (m: ResearchHistoryManifest) => void;
    code: string;
    path?: string;
  }[] = [
    {
      name: "unknown top-level fields",
      mutate: (m) => Object.assign(m, { liveEligible: true }),
      code: "HISTORY_INVALID",
    },
    {
      name: "forged receipt times",
      mutate: (m) => Object.assign(m.bars[0], { receivedAt: 1 }),
      code: "HISTORY_INVALID",
      path: "bars.0",
    },
    {
      name: "missing turnover",
      mutate: (m) => {
        delete (m.bars[0] as Partial<(typeof m.bars)[number]>).turnover;
      },
      code: "HISTORY_INVALID",
      path: "bars.0.turnover",
    },
    {
      name: "scientific notation",
      mutate: (m) => {
        m.bars[0].open = "1e2";
      },
      code: "HISTORY_INVALID",
      path: "bars.0.open",
    },
    {
      name: "unbounded decimal precision",
      mutate: (m) => {
        m.bars[0].open = `1.${"0".repeat(21)}`;
      },
      code: "HISTORY_INVALID",
      path: "bars.0.open",
    },
    {
      name: "unbounded identifiers",
      mutate: (m) => {
        m.bars[0].id = "a".repeat(161);
      },
      code: "HISTORY_INVALID",
      path: "bars.0.id",
    },
    {
      name: "too many bars",
      mutate: (m) => {
        m.bars = Array.from({ length: 3001 }, () => ({ ...m.bars[0] }));
      },
      code: "HISTORY_INVALID",
      path: "bars",
    },
    {
      name: "too few bars",
      mutate: (m) => {
        m.bars.pop();
      },
      code: "HISTORY_INVALID",
      path: "bars",
    },
    {
      name: "unknown volume unit",
      mutate: (m) => Object.assign(m.bars[1], { volumeUnit: "UNKNOWN" }),
      code: "HISTORY_INVALID",
      path: "bars.1.volumeUnit",
    },
    {
      name: "unconfirmed final bar",
      mutate: (m) => Object.assign(m.bars[1], { final: false }),
      code: "HISTORY_INVALID",
      path: "bars.1.final",
    },
    {
      name: "pre-adjusted bar",
      mutate: (m) => Object.assign(m.bars[0], { adjustment: "FORWARD" }),
      code: "HISTORY_INVALID",
      path: "bars.0.adjustment",
    },
    {
      name: "unknown lot size",
      mutate: (m) => {
        m.bars[1].volumeUnit = "LOT";
      },
      code: "LOT_SIZE_UNKNOWN",
      path: "bars.1",
    },
    {
      name: "fractional raw volume",
      mutate: (m) => {
        m.bars[1].volume = "1.5";
      },
      code: "FRACTIONAL_RAW_VOLUME",
      path: "bars.1",
    },
    {
      name: "invalid OHLC",
      mutate: (m) => {
        m.bars[1].high = "40";
      },
      code: "INVALID_OHLC",
      path: "bars.1",
    },
    {
      name: "zero price",
      mutate: (m) => {
        m.bars[0].open = "0";
      },
      code: "INVALID_DECIMAL",
      path: "bars.0",
    },
    {
      name: "unverified calendar",
      mutate: (m) => {
        m.calendarDays[0].verified = false;
      },
      code: "HISTORY_CALENDAR_INVALID",
      path: "bars.0.sessionDate",
    },
    {
      name: "unknown session date",
      mutate: (m) => {
        m.bars[1].sessionDate = "2026-10-10";
      },
      code: "HISTORY_CALENDAR_INVALID",
      path: "bars.1.sessionDate",
    },
    {
      name: "daily session mismatch",
      mutate: (m) => {
        m.bars[0].end -= 60_000;
      },
      code: "DAILY_SESSION_MISMATCH",
    },
    {
      name: "minute session mismatch",
      mutate: (m) => {
        m.bars[1].start += 1_000;
        m.bars[1].end += 1_000;
      },
      code: "BAR_NOT_SESSION_ALIGNED",
    },
    {
      name: "duplicate bar IDs",
      mutate: (m) => {
        m.bars[2].id = m.bars[1].id;
      },
      code: "HISTORY_DUPLICATE_ID",
    },
    {
      name: "duplicate bar windows",
      mutate: (m) => {
        m.bars[2].start = m.bars[1].start;
        m.bars[2].end = m.bars[1].end;
      },
      code: "DUPLICATE_BAR_WINDOW",
    },
    {
      name: "missing minute in a five-minute window",
      mutate: (m) => {
        m.bars[5].start += 60_000;
        m.bars[5].end += 60_000;
      },
      code: "MISSING_MINUTE",
    },
    {
      name: "missing period",
      mutate: (m) => {
        const five = m.bars.at(-1)!;
        five.period = "1m";
        five.start += 300_000;
        five.end = five.start + 60_000;
      },
      code: "AUDIT_PERIOD_MISSING",
    },
    {
      name: "mismatched cross-period values",
      mutate: (m) => {
        m.bars.at(-1)!.turnover = "25251";
      },
      code: "CROSS_PERIOD_VALUE_MISMATCH",
    },
    {
      name: "mismatched cross-period windows",
      mutate: (m) => {
        m.bars.at(-1)!.start += 300_000;
        m.bars.at(-1)!.end += 300_000;
      },
      code: "CROSS_PERIOD_WINDOW_MISMATCH",
    },
    {
      name: "unknown action coverage",
      mutate: (m) => {
        m.corporateActions.coverage.status = "UNKNOWN";
      },
      code: "CORPORATE_ACTION_COVERAGE_UNKNOWN",
    },
    {
      name: "incomplete action coverage",
      mutate: (m) => {
        m.corporateActions.coverage.from += 60_000;
      },
      code: "CORPORATE_ACTION_COVERAGE_UNKNOWN",
    },
    {
      name: "zero split factor",
      mutate: (m) => {
        m.corporateActions.actions[0].sharesAfter = "0";
      },
      code: "HISTORY_INVALID",
      path: "corporateActions.actions.0.sharesAfter",
    },
    {
      name: "split inside target session",
      mutate: (m) => {
        m.corporateActions.actions[0].effectiveAt += 60_000;
      },
      code: "TARGET_SESSION_SCALE_CHANGED",
    },
    {
      name: "split inside historical daily bar",
      mutate: (m) => {
        m.corporateActions.actions[0].effectiveAt = m.bars[0].start + 60_000;
      },
      code: "ACTION_INSIDE_BAR",
    },
    {
      name: "unreferenced corporate-action document",
      mutate: (m) => {
        m.corporateActions.actions[0].documentIds = ["missing"];
      },
      code: "EVIDENCE_REFERENCE_INVALID",
    },
  ];
  it.each(invalid)(
    "rejects $name with a useful error and no writes",
    ({ mutate, code, path }) => {
      const f = fixture();
      mutate(f.manifest);
      const before = f.store.db.serialize(),
        changes = totalChanges(f.store);
      expect(() =>
        previewResearchHistory(f.store, f.instrument, f.manifest, NOW),
      ).toThrowError(
        expect.objectContaining({
          code,
          ...(path ? { message: expect.stringContaining(path) } : {}),
        }),
      );
      expect(totalChanges(f.store)).toBe(changes);
      expect(f.store.db.serialize().equals(before)).toBe(true);
    },
  );
  it("rejects cumulative split numerics outside domain precision before either preview or import can write", () => {
    const f = fixture();
    const split = f.manifest.corporateActions.actions[0];
    f.manifest.corporateActions.actions = [
      "extreme-split-1",
      "extreme-split-2",
    ].map((id) => ({
      ...split,
      id,
      sharesAfter: "0.00000000000000000001",
      sharesBefore: "100000000000000000000000000000",
    }));
    const before = f.store.db.serialize(),
      changes = totalChanges(f.store);
    const expectedError = expect.objectContaining({
      code: "HISTORY_NUMERIC_RANGE",
      statusCode: 422,
    });
    expect(() =>
      previewResearchHistory(f.store, f.instrument, f.manifest, NOW),
    ).toThrowError(expectedError);
    // A caller cannot bypass preview validation by submitting a well-shaped confirmation.
    expect(() =>
      importResearchHistory(
        f.store,
        f.instrument,
        {
          manifest: f.manifest,
          token: "f".repeat(64),
          expectedHistoryId: null,
          expectedActionVersion: null,
          confirmed: true,
        },
        NOW,
      ),
    ).toThrowError(expectedError);
    expect(totalChanges(f.store)).toBe(changes);
    expect(f.store.db.serialize().equals(before)).toBe(true);
    for (const table of [
      "research_history",
      "corporate_action_snapshots",
      "corporate_action_facts",
    ])
      expect(count(f.store, table)).toBe(0);
  });
  it("rejects a file over 2 MiB before field validation", () => {
    const f = fixture();
    f.manifest.source = "x".repeat(HISTORY_MAX_BYTES);
    expect(() =>
      previewResearchHistory(f.store, f.instrument, f.manifest, NOW),
    ).toThrowError(
      expect.objectContaining({ code: "HISTORY_TOO_LARGE", statusCode: 413 }),
    );
    expect(count(f.store, "research_history")).toBe(0);
  });
  it("rejects unfinished sessions even if the submitted minute itself has ended", () => {
    const f = fixture();
    const now = f.manifest.bars[1].start + 600_000;
    f.manifest.corporateActions.coverage.through = now;
    expect(() =>
      previewResearchHistory(f.store, f.instrument, f.manifest, now),
    ).toThrowError(
      expect.objectContaining({ code: "HISTORY_SESSION_NOT_COMPLETED" }),
    );
  });
  it("requires the matching non-DEMO instrument and normalizes declared CN lots to shares", () => {
    const f = fixture();
    expect(() =>
      previewResearchHistory(
        f.store,
        { ...f.instrument, id: "US:OTHER.US" },
        f.manifest,
        NOW,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "HISTORY_INSTRUMENT_MISMATCH" }),
    );
    f.manifest.instrumentId = demoInstruments[0].id;
    expect(() =>
      previewResearchHistory(f.store, demoInstruments[0], f.manifest, NOW),
    ).toThrowError(
      expect.objectContaining({ code: "HISTORY_INSTRUMENT_MISMATCH" }),
    );
    const cn = fixture("CN");
    for (const bar of cn.manifest.bars) {
      bar.volumeUnit = "LOT";
      bar.lotSize = 100;
      bar.volume = String(Number(bar.volume) / 100);
    }
    const imported = importFixture(cn);
    const snapshot = readResearchHistory(
      cn.store.db,
      cn.instrument.id,
      imported.result.history.id,
    )!;
    expect(snapshot.raw.find((b) => b.period === "1m")).toMatchObject({
      volume: "100",
      rawVolume: "1",
      rawVolumeUnit: "LOT",
      volumeUnit: "SHARE",
      historical: true,
      synthetic: false,
    });
    expect(
      researchHistoryBars(cn.store.db, cn.instrument.id, "1D")![0],
    ).toMatchObject({ close: "51", volume: "2000" });
  });
});

describe("atomic immutable history imports and precise draft references", () => {
  it("requires explicit confirmation and all optimistic preview fields before any write", () => {
    const f = fixture(),
      p = previewResearchHistory(f.store, f.instrument, f.manifest, NOW);
    const request = confirm(p, f.manifest),
      before = f.store.db.serialize();
    for (const key of [
      "confirmed",
      "token",
      "expectedHistoryId",
      "expectedActionVersion",
    ] as const) {
      const invalid: Record<string, unknown> = { ...request };
      delete invalid[key];
      expect(() =>
        importResearchHistory(f.store, f.instrument, invalid, NOW),
      ).toThrow();
    }
    expect(() =>
      importResearchHistory(
        f.store,
        f.instrument,
        { ...request, confirmed: false },
        NOW,
      ),
    ).toThrow();
    expect(f.store.db.serialize().equals(before)).toBe(true);
  });
  it("imports actual receipt time, raw and adjusted data, and source evidence atomically without creating alerts", () => {
    const f = fixture(),
      preview = previewResearchHistory(f.store, f.instrument, f.manifest, NOW);
    const importedAt = NOW + 7_000;
    const result = importResearchHistory(
      f.store,
      f.instrument,
      confirm(preview, f.manifest),
      importedAt,
    );
    expect(result).toMatchObject({
      status: "IMPORTED",
      history: { importedAt, current: true, reasons: [], liveEligible: false },
    });
    const snapshot = readResearchHistory(f.store.db, f.instrument.id)!;
    expect(snapshot.manifest).toEqual(f.manifest);
    expect(
      snapshot.raw.every(
        (b) => b.receivedAt === importedAt && b.historical && !b.synthetic,
      ),
    ).toBe(true);
    expect(snapshot.bars.every((b) => b.receivedAt === importedAt)).toBe(true);
    expect(snapshot.bars[0]).toMatchObject({
      close: "51",
      volume: "2000",
      turnover: "101000",
      priceFactor: "0.5",
      volumeFactor: "2",
      rawClose: "102",
      rawVolume: "1000",
      raw: { receivedAt: importedAt, close: "102", historical: true },
    });
    const actions = new ActionEvidenceRepository(f.store.db);
    expect(actions.latest(f.instrument.id)).toMatchObject({
      version: result.history.actionEvidenceVersion,
      recordedAt: importedAt,
    });
    expect(actions.latest(f.instrument.id)!.manifest.documents).toEqual(
      actionInput(f.manifest).documents,
    );
    expect(actions.dataset(f.instrument.id, importedAt - 1)).toBeNull();
    expect(actions.dataset(f.instrument.id, importedAt)).toMatchObject({
      coverage: { knownAt: importedAt },
      actions: [{ receivedAt: importedAt }],
    });
    for (const table of [
      "research_history",
      "corporate_action_snapshots",
      "corporate_action_facts",
    ])
      expect(count(f.store, table)).toBe(1);
    for (const table of [
      "bars",
      "plans",
      "attempts",
      "decision_events",
      "notifications",
    ])
      expect(count(f.store, table)).toBe(0);
  });
  it("retries exactly once in storage and detects a reused token with changed content", () => {
    const f = fixture(),
      first = importFixture(f),
      before = f.store.db.serialize(),
      changes = totalChanges(f.store);
    const retry = importResearchHistory(
      f.store,
      f.instrument,
      first.request,
      NOW + 10_000,
    );
    expect(retry).toEqual({
      status: "DUPLICATE",
      history: first.result.history,
    });
    const duplicatePreview = previewResearchHistory(
      f.store,
      f.instrument,
      f.manifest,
      NOW + 20_000,
    );
    expect(
      importResearchHistory(
        f.store,
        f.instrument,
        confirm(duplicatePreview, f.manifest),
        NOW + 20_000,
      ),
    ).toEqual(retry);
    expect(totalChanges(f.store)).toBe(changes);
    expect(f.store.db.serialize().equals(before)).toBe(true);
    const altered = structuredClone(first.request);
    altered.manifest.source = "Different source";
    expect(() =>
      importResearchHistory(f.store, f.instrument, altered, NOW + 30_000),
    ).toThrowError(
      expect.objectContaining({
        code: "HISTORY_TOKEN_MISMATCH",
        statusCode: 409,
      }),
    );
    expect(f.store.db.serialize().equals(before)).toBe(true);
  });
  it.each([false, true])(
    "requires a fresh preview after the restore epoch changes (already imported: %s)",
    (alreadyImported) => {
      const f = fixture(),
        preview = previewResearchHistory(
          f.store,
          f.instrument,
          f.manifest,
          NOW,
        );
      const request = confirm(preview, f.manifest);
      const first = alreadyImported
        ? importResearchHistory(f.store, f.instrument, request, NOW)
        : null;
      f.store.setSetting("event_feed_epoch", "restored-database-epoch");
      const before = f.store.db.serialize(),
        changes = totalChanges(f.store);
      expect(() =>
        importResearchHistory(f.store, f.instrument, request, NOW + 1),
      ).toThrowError(
        expect.objectContaining({
          code: alreadyImported
            ? "HISTORY_PREVIEW_EXPIRED"
            : "HISTORY_VERSION_CONFLICT",
          statusCode: 409,
        }),
      );
      expect(f.store.db.serialize().equals(before)).toBe(true);
      expect(totalChanges(f.store)).toBe(changes);
      const refreshed = previewResearchHistory(
        f.store,
        f.instrument,
        f.manifest,
        NOW + 2,
      );
      expect(refreshed.token).not.toBe(preview.token);
      const result = importResearchHistory(
        f.store,
        f.instrument,
        confirm(refreshed, f.manifest),
        NOW + 2,
      );
      expect(result.status).toBe(alreadyImported ? "DUPLICATE" : "IMPORTED");
      if (first) expect(result.history.id).toBe(first.history.id);
      expect(count(f.store, "research_history")).toBe(1);
    },
  );
  it("rejects forged valid-shaped optimistic fields and split corrections without a new revision", () => {
    const f = fixture(),
      preview = previewResearchHistory(f.store, f.instrument, f.manifest, NOW);
    const request = confirm(preview, f.manifest),
      before = f.store.db.serialize();
    for (const change of [
      { token: "f".repeat(64) },
      { expectedHistoryId: `history-v1:${"f".repeat(64)}` },
      { expectedActionVersion: `action-evidence-v1:${"f".repeat(64)}` },
    ]) {
      expect(() =>
        importResearchHistory(
          f.store,
          f.instrument,
          { ...request, ...change },
          NOW,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "HISTORY_VERSION_CONFLICT",
          statusCode: 409,
        }),
      );
    }
    expect(f.store.db.serialize().equals(before)).toBe(true);
    importResearchHistory(f.store, f.instrument, request, NOW);
    f.manifest.corporateActions.actions[0].sharesAfter = "3";
    const imported = f.store.db.serialize();
    expect(() =>
      previewResearchHistory(f.store, f.instrument, f.manifest, NOW + 1),
    ).toThrowError(
      expect.objectContaining({ code: "ACTION_REVISION_CONFLICT" }),
    );
    expect(f.store.db.serialize().equals(imported)).toBe(true);
  });
  it("rejects changed preview content and history/action races without overwriting either version", () => {
    const f = fixture(),
      preview = previewResearchHistory(f.store, f.instrument, f.manifest, NOW),
      request = confirm(preview, f.manifest);
    expect(() =>
      importResearchHistory(
        f.store,
        f.instrument,
        {
          ...request,
          manifest: { ...f.manifest, source: "changed after preview" },
        },
        NOW,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "HISTORY_VERSION_CONFLICT" }),
    );
    const other = { ...f.manifest, source: "another concurrent history" };
    const p2 = previewResearchHistory(f.store, f.instrument, other, NOW);
    importResearchHistory(f.store, f.instrument, confirm(p2, other), NOW);
    const before = f.store.db.serialize();
    expect(() =>
      importResearchHistory(f.store, f.instrument, request, NOW + 1),
    ).toThrowError(
      expect.objectContaining({ code: "HISTORY_VERSION_CONFLICT" }),
    );
    expect(f.store.db.serialize().equals(before)).toBe(true);
    const currentPreview = previewResearchHistory(
      f.store,
      f.instrument,
      f.manifest,
      NOW + 2,
    );
    const action = new ActionEvidenceRepository(f.store.db).latest(
      f.instrument.id,
    )!;
    const replacement = {
      ...action.manifest,
      expectedVersion: action.version,
      review: { reviewer: "second human review", confirmed: true as const },
    };
    f.store.importActionEvidence(replacement, NOW + 3);
    const afterActions = f.store.db.serialize();
    expect(() =>
      importResearchHistory(
        f.store,
        f.instrument,
        confirm(currentPreview, f.manifest),
        NOW + 4,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "HISTORY_VERSION_CONFLICT" }),
    );
    expect(f.store.db.serialize().equals(afterActions)).toBe(true);
    expect(
      readResearchHistory(f.store.db, f.instrument.id)!.summary,
    ).toMatchObject({ current: false, reasons: ["ACTION_EVIDENCE_CHANGED"] });
    expect(researchHistoryBars(f.store.db, f.instrument.id, "1D")).toEqual([]);
  });
  it.each(["history insertion", "post-insert invalidation"])(
    "rolls back actions, histories, plan invalidation and notifications after %s failure",
    (stage) => {
      const f = fixture();
      const p = f.store.createPlan(planInput(f.manifest), NOW);
      // Simulate a previously active plan to exercise the action-change pause transaction.
      const active = {
        ...p,
        status: "WAIT_RETEST",
        attemptId: "existing-test-attempt",
      };
      f.store.db
        .prepare("UPDATE plans SET json=? WHERE id=?")
        .run(JSON.stringify(active), p.id);
      const preview = previewResearchHistory(
        f.store,
        f.instrument,
        f.manifest,
        NOW,
      );
      if (stage === "history insertion")
        f.store.db.exec(
          "CREATE TRIGGER fail_history_insert BEFORE INSERT ON research_history BEGIN SELECT RAISE(ABORT,'injected history write failure'); END",
        );
      else {
        const original = f.store.invalidateEvidence.bind(f.store);
        vi.spyOn(f.store, "invalidateEvidence").mockImplementation(
          (...args) => {
            const result = original(...args);
            if (args[1] === "RESEARCH_HISTORY_CHANGED") {
              expect(count(f.store, "research_history")).toBe(1);
              expect(f.store.plan(p.id).status).toBe("DATA_PAUSED");
              throw new Error("injected history write failure");
            }
            return result;
          },
        );
      }
      const before = f.store.db.serialize();
      expect(() =>
        importResearchHistory(
          f.store,
          f.instrument,
          confirm(preview, f.manifest),
          NOW + 1,
        ),
      ).toThrow("injected history write failure");
      expect(f.store.db.serialize().equals(before)).toBe(true);
      expect(f.store.plan(p.id)).toEqual(active);
      expect(count(f.store, "plan_versions")).toBe(1);
      for (const table of [
        "research_history",
        "corporate_action_snapshots",
        "corporate_action_facts",
        "decision_inputs",
        "decision_events",
        "notifications",
      ])
        expect(count(f.store, table)).toBe(0);
    },
  );
  it("keeps old history and plan-version bytes unchanged and requires deliberate adoption of the current version", () => {
    const f = fixture(),
      first = importFixture(f),
      id1 = first.result.history.id;
    const plan = f.store.createPlan(planInput(f.manifest, id1), NOW + 1);
    const frozen = f.store.planVersion(plan),
      oldHistory = f.store.db
        .prepare("SELECT * FROM research_history WHERE id=?")
        .get(id1);
    expect(frozen).toMatchObject({
      researchHistoryId: id1,
      supportSnapshot: {
        ready: false,
        knownAt: NOW,
        reasons: expect.arrayContaining(["HISTORICAL_RESEARCH_ONLY"]),
      },
      previousDailyBar: { close: "51", receivedAt: NOW },
      anchorBar: { id: "synthetic-daily" },
    });
    f.manifest.source = "Second manually imported research version";
    f.manifest.bars[0].close = "100";
    const second = importFixture(f, NOW + 2),
      id2 = second.result.history.id;
    expect(id2).not.toBe(id1);
    expect(f.store.plan(plan.id)).toEqual(plan);
    expect(f.store.planVersion(plan)).toEqual(frozen);
    expect(
      f.store.db.prepare("SELECT * FROM research_history WHERE id=?").get(id1),
    ).toEqual(oldHistory);
    expect(
      readResearchHistory(f.store.db, f.instrument.id, id1)!.summary,
    ).toMatchObject({
      current: false,
      reasons: expect.arrayContaining(["HISTORY_SUPERSEDED"]),
    });
    expect(
      researchHistoryBars(f.store.db, f.instrument.id, "1D", id1)![0].close,
    ).toBe("51");
    expect(
      researchHistoryBars(f.store.db, f.instrument.id, "1D", id2)![0].close,
    ).toBe("50");
    expect(f.store.supportRevisionReasons(plan, NOW + 3)).toContain(
      "PLAN_DATA_REVISION_CHANGED",
    );
    const before = f.store.db.serialize();
    for (const chosen of [undefined, id1]) {
      expect(() =>
        f.store.createPlan(planInput(f.manifest, chosen), NOW + 3),
      ).toThrowError(
        expect.objectContaining({ code: "HISTORY_VERSION_CONFLICT" }),
      );
      expect(() =>
        f.store.updatePlan(
          plan.id,
          planInput(f.manifest, chosen),
          plan.version,
          NOW + 3,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "HISTORY_VERSION_CONFLICT" }),
      );
    }
    expect(f.store.db.serialize().equals(before)).toBe(true);
    const next = f.store.updatePlan(
      plan.id,
      planInput(f.manifest, id2),
      plan.version,
      NOW + 3,
    );
    expect(next).toMatchObject({
      version: 2,
      status: "DRAFT",
      researchHistoryId: id2,
      supportSnapshot: { reference: { close: "50" } },
    });
    expect(f.store.planVersion(plan)).toEqual(frozen);
    const retry = importResearchHistory(
      f.store,
      f.instrument,
      first.request,
      NOW + 4,
    );
    expect(retry).toMatchObject({
      status: "DUPLICATE",
      history: { id: id1, current: false },
    });
    expect(readResearchHistory(f.store.db, f.instrument.id)!.summary.id).toBe(
      id2,
    );
    expect(count(f.store, "research_history")).toBe(2);
  });
  it("enforces immutable SQL protections even for REPLACE and upsert conflict paths", () => {
    const f = fixture(),
      { result } = importFixture(f),
      id = result.history.id;
    const before = f.store.db.serialize();
    const statements = [
      "UPDATE research_history SET payload_json='{}' WHERE id=?",
      "DELETE FROM research_history WHERE id=?",
      "INSERT OR REPLACE INTO research_history SELECT * FROM research_history WHERE id=?",
      "INSERT INTO research_history SELECT * FROM research_history WHERE id=? ON CONFLICT(id) DO UPDATE SET payload_json='{}'",
    ];
    for (const sql of statements)
      expect(() => f.store.db.prepare(sql).run(id)).toThrow(
        "IMMUTABLE_RESEARCH_HISTORY",
      );
    expect(f.store.db.serialize().equals(before)).toBe(true);
    expect(readResearchHistory(f.store.db, f.instrument.id)!.summary.id).toBe(
      id,
    );
    expect(() => f.store.deleteInstrument(f.instrument.id)).toThrow();
    expect(f.store.db.pragma("foreign_key_check")).toEqual([]);
  });
  it.each(["invalid JSON", "changed payload", "changed identity"])(
    "fails closed on persisted %s corruption",
    (kind) => {
      const f = fixture(),
        { result } = importFixture(f);
      // Deliberately remove the protection only to simulate external storage corruption.
      f.store.db.exec("DROP TRIGGER research_history_no_update");
      if (kind === "invalid JSON")
        f.store.db
          .prepare("UPDATE research_history SET payload_json=? WHERE id=?")
          .run("{", result.history.id);
      else if (kind === "changed identity") {
        const snapshot = readResearchHistory(f.store.db, f.instrument.id)!;
        snapshot.summary.importedAt--;
        const encoded = JSON.stringify(snapshot);
        f.store.db
          .prepare(
            "UPDATE research_history SET payload_json=?,payload_hash=? WHERE id=?",
          )
          .run(
            encoded,
            createHash("sha256").update(encoded).digest("hex"),
            result.history.id,
          );
      } else
        f.store.db
          .prepare("UPDATE research_history SET payload_hash=? WHERE id=?")
          .run("0".repeat(64), result.history.id);
      const before = f.store.db.serialize();
      expect(() =>
        readResearchHistory(f.store.db, f.instrument.id),
      ).toThrowError(expect.objectContaining({ code: "HISTORY_CORRUPT" }));
      expect(() =>
        researchHistoryBars(f.store.db, f.instrument.id, "1D"),
      ).toThrowError(expect.objectContaining({ code: "HISTORY_CORRUPT" }));
      expect(f.store.db.serialize().equals(before)).toBe(true);
    },
  );
});

describe("private research history HTTP workflow", () => {
  it("requires authentication and CSRF on preview/import, serves an instrument-specific template and detailed validation errors", async () => {
    const f = await appFixture();
    for (const url of [f.base, `${f.base}/template`])
      expect((await f.app.inject(url)).statusCode).toBe(401);
    for (const url of [f.base, `${f.base}/preview`]) {
      expect(
        (
          await f.app.inject({
            method: "POST",
            url,
            headers: { "x-requested-with": "PullbackLab" },
            payload: { manifest: f.manifest },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url,
            headers: { cookie: f.headers.cookie },
            payload: { manifest: f.manifest },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect((await f.get(f.base)).json()).toEqual({
      current: null,
      history: [],
    });
    const template = await f.get(`${f.base}/template`);
    expect(template.statusCode).toBe(200);
    expect(template.json()).toMatchObject({
      schema: "pullback-lab-research-history-v1",
      instrumentId: f.instrument.id,
      calendarDays: [{ market: "US" }],
    });
    expect(template.headers["cache-control"]).toBe("no-store");
    expect(
      (await f.get("/api/instruments/missing/research-history")).statusCode,
    ).toBe(404);
    const invalid = structuredClone(f.manifest);
    invalid.bars[2].open = "NaN";
    const response = await f.post(`${f.base}/preview`, { manifest: invalid });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "HISTORY_INVALID",
      error: expect.stringContaining("bars.2.open"),
    });
    const preview = await f.preview(),
      request = confirm(preview, f.manifest);
    const { confirmed: _confirmed, ...unconfirmed } = request;
    expect((await f.post(f.base, unconfirmed)).statusCode).toBe(400);
    expect(
      (await f.post(f.base, { ...request, confirmed: false })).statusCode,
    ).toBe(400);
    expect(count(f.store, "research_history")).toBe(0);
  });
  it("keeps HTTP preview and all history/evidence/chart reads strictly read-only", async () => {
    const f = await appFixture();
    let before = f.store.db.serialize(),
      changes = totalChanges(f.store);
    f.store.db.pragma("query_only = ON");
    const preview = await f.preview();
    f.store.db.pragma("query_only = OFF");
    expect(totalChanges(f.store)).toBe(changes);
    expect(f.store.db.serialize().equals(before)).toBe(true);
    const result = await f.post(f.base, confirm(preview, f.manifest));
    expect(result.statusCode, result.body).toBe(200);
    const history = result.json().history;
    before = f.store.db.serialize();
    changes = totalChanges(f.store);
    f.store.db.pragma("query_only = ON");
    for (const url of [
      f.base,
      `${f.base}/template`,
      `/api/instruments/${f.instrument.id}/action-evidence`,
      `/api/instruments/${f.instrument.id}/action-evidence/${history.actionEvidenceVersion}`,
      ...["1D", "1m", "5m"].map(
        (period) =>
          `/api/instruments/${f.instrument.id}/bars?period=${period}&historyId=${history.id}`,
      ),
    ]) {
      const read = await f.get(url);
      expect(read.statusCode, read.body).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
    }
    f.store.db.pragma("query_only = OFF");
    expect(totalChanges(f.store)).toBe(changes);
    expect(f.store.db.serialize().equals(before)).toBe(true);
  });
  it.each(["US", "CN"] as const)(
    "uses identical precise daily AVWAP for %s daily/minute/five-minute charts and the frozen support",
    async (market) => {
      const f = await appFixture(market),
        preview = await f.preview();
      f.setNow(NOW + 4_000);
      const response = await f.post(f.base, confirm(preview, f.manifest));
      expect(response.statusCode, response.body).toBe(200);
      const history = response.json().history;
      const input = planInput(f.manifest, history.id),
        anchor = input.anchorTime!;
      const expectedAvwap =
        "50.66666666666666666666666666666666666666666666666666666666666665";
      for (const period of ["1D", "1m", "5m"] as const) {
        const response = await f.get(
          `/api/instruments/${f.instrument.id}/bars?period=${period}&anchorTime=${anchor}&historyId=${history.id}`,
        );
        expect(response.statusCode, response.body).toBe(200);
        const chart = response.json<ResearchChartData>();
        expect(chart.synthetic).toBe(false);
        expect(chart.researchHistory).toMatchObject({
          id: history.id,
          importedAt: NOW + 4_000,
          liveEligible: false,
        });
        expect(chart.bars).toHaveLength(period === "1m" ? 5 : 1);
        expect(chart.avwap).toEqual(
          Array(chart.bars.length).fill(expectedAvwap),
        );
        expect(chart.avwapCutoffs).toEqual(
          Array(chart.bars.length).fill(
            f.manifest.bars.find((b) => b.period === "1D")!.end / 1000,
          ),
        );
        expect(chart.bars.every((b) => b.receivedAt === NOW + 4_000)).toBe(
          true,
        );
        expect(
          chart.bars.every(
            (b) => b.adjustmentVersion === history.adjustmentVersion,
          ),
        ).toBe(true);
      }
      const {
        researchHistoryId,
        instrumentId,
        anchorTime,
        primarySupport,
        supportSelections,
        sessionDate,
      } = input;
      const support = await f.post("/api/plans/support-preview", {
        researchHistoryId,
        instrumentId,
        anchorTime,
        primarySupport,
        supportSelections,
        sessionDate,
      });
      expect(support.statusCode, support.body).toBe(200);
      const snapshot = support.json<SupportSnapshot>();
      expect(snapshot.lines.find((l) => l.source === "AVWAP")!.price).toBe(
        expectedAvwap,
      );
      expect(snapshot).toMatchObject({
        knownAt: NOW + 4_000,
        selectedAt: NOW + 4_000,
        synthetic: false,
        ready: false,
        reasons: expect.arrayContaining(["HISTORICAL_RESEARCH_ONLY"]),
        reference: { close: "51" },
      });
      const create = await f.post("/api/plans", input);
      expect(create.statusCode, create.body).toBe(200);
      const plan = create.json<Plan>();
      expect(
        plan.supportSnapshot?.lines.find((l) => l.source === "AVWAP")!.price,
      ).toBe(expectedAvwap);
      const activated = await f.post(`/api/plans/${plan.id}/activate`, {
        expectedVersion: plan.version,
        expectedAttemptId: null,
      });
      expect(activated.statusCode).toBe(422);
      expect(activated.json().code).toBe("LIVE_CAPABILITY_UNVERIFIED");
      expect(f.store.plan(plan.id).status).toBe("DRAFT");
      for (const table of [
        "attempts",
        "decision_events",
        "notifications",
        "reservations",
      ])
        expect(count(f.store, table)).toBe(0);
    },
  );
  it("keeps very small valid decimal prices and ordinary two-for-one splits importable and chartable", async () => {
    const f = await appFixture();
    for (const bar of f.manifest.bars) {
      for (const field of ["open", "high", "low", "close", "turnover"] as const)
        bar[field] = new Decimal(bar[field])
          .mul("0.000000000000000001")
          .toFixed();
    }
    const preview = await f.preview();
    const imported = await f.post(f.base, confirm(preview, f.manifest));
    expect(imported.statusCode, imported.body).toBe(200);
    const id = imported.json().history.id;
    const anchor = f.manifest.bars[0].start / 1000;
    let dailyAvwap: string | null = null;
    for (const period of ["1D", "1m", "5m"]) {
      const response = await f.get(
        `/api/instruments/${f.instrument.id}/bars?period=${period}&anchorTime=${anchor}&historyId=${id}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const chart = response.json<ResearchChartData>();
      expect(chart.bars[0].close).toBe("0.000000000000000051");
      if (period === "1D") {
        expect(chart.bars[0].volume).toBe("2000");
        dailyAvwap = chart.avwap[0];
        expect(dailyAvwap).toMatch(/^0\.000000000000000050666/);
      }
      expect(chart.avwap).toEqual(Array(chart.bars.length).fill(dailyAvwap));
    }
    expect(count(f.store, "research_history")).toBe(1);
  });
  it("rejects wrong or absent history selections over HTTP, returns bounded metadata, and scopes saved charts to the instrument", async () => {
    const f = await appFixture(),
      preview = await f.preview();
    const imported = await f.post(f.base, confirm(preview, f.manifest)),
      id = imported.json().history.id;
    const missingChoice = await f.post("/api/plans", planInput(f.manifest));
    expect(missingChoice.statusCode).toBe(409);
    expect(missingChoice.json().code).toBe("HISTORY_VERSION_CONFLICT");
    const other = addInstrument(f.store, "CN");
    const wrong = await f.get(
      `/api/instruments/${other.id}/bars?period=1D&historyId=${id}`,
    );
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json().code).toBe("HISTORY_NOT_FOUND");
    expect(
      (await f.get(`/api/instruments/${f.instrument.id}/bars?historyId=forged`))
        .statusCode,
    ).toBe(400);
    const status = await f.get(f.base),
      parsed = status.json<ResearchHistoryStatus>();
    expect(parsed.current?.id).toBe(id);
    expect(parsed.history).toHaveLength(1);
    expect(status.body).not.toContain('"bars"');
    expect(status.body).not.toContain('"documents"');
    expect(status.body).not.toContain(
      f.manifest.corporateActions.documents[0].content,
    );
    expect(status.body.length).toBeLessThan(5_000);
    expect(count(f.store, "plans")).toBe(0);
  });
  it("bounds history metadata to the latest twenty imports while older exact versions stay readable", async () => {
    const f = await appFixture();
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      f.manifest.source = `Synthetic version ${i}`;
      const p = previewResearchHistory(
        f.store,
        f.instrument,
        f.manifest,
        NOW + i,
      );
      ids.push(
        importResearchHistory(
          f.store,
          f.instrument,
          confirm(p, f.manifest),
          NOW + i,
        ).history.id,
      );
    }
    const before = f.store.db.serialize(),
      changes = totalChanges(f.store);
    const response = await f.get(f.base),
      status = response.json<ResearchHistoryStatus>();
    expect(response.statusCode).toBe(200);
    expect(status.current?.id).toBe(ids.at(-1));
    expect(status.history.map((h) => h.id)).toEqual(ids.slice(1).reverse());
    expect(status.history.filter((h) => h.current)).toHaveLength(1);
    const old = await f.get(
      `/api/instruments/${f.instrument.id}/bars?period=1D&historyId=${ids[0]}`,
    );
    expect(old.statusCode).toBe(200);
    expect(old.json().researchHistory).toMatchObject({
      id: ids[0],
      current: false,
      reasons: expect.arrayContaining(["HISTORY_SUPERSEDED"]),
    });
    expect(count(f.store, "research_history")).toBe(21);
    expect(totalChanges(f.store)).toBe(changes);
    expect(f.store.db.serialize().equals(before)).toBe(true);
  });
  it("requires replacement of template placeholders even when structural data is valid", async () => {
    const f = await appFixture();
    const response = await f.post(`${f.base}/preview`, {
      manifest: { ...f.manifest, source: "请填写历史量价的实际来源" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "HISTORY_TEMPLATE_INCOMPLETE",
      error: expect.stringContaining("source"),
    });
    expect(count(f.store, "research_history")).toBe(0);
  });
  it("rejects requests beyond Fastify bodyLimit as a stable HTTP 413 without writing", async () => {
    const f = await appFixture(),
      before = f.store.db.serialize(),
      changes = totalChanges(f.store);
    for (const url of [`${f.base}/preview`, f.base]) {
      const response = await f.post(url, {
        manifest: {
          ...f.manifest,
          source: "x".repeat(HISTORY_MAX_BYTES + 65_537),
        },
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({
        code: "REQUEST_BODY_TOO_LARGE",
        error: expect.stringContaining("请求内容过大"),
      });
    }
    expect(totalChanges(f.store)).toBe(changes);
    expect(f.store.db.serialize().equals(before)).toBe(true);
  });
  it("reuses current action evidence in a template without repeating an already acknowledged removal", async () => {
    const f = await appFixture();
    const first = await f.preview();
    expect((await f.post(f.base, confirm(first, f.manifest))).statusCode).toBe(
      200,
    );
    const removed = structuredClone(f.manifest);
    removed.source = "Second source with corrected no-split history";
    removed.corporateActions.removedActionIds =
      removed.corporateActions.actions.map((a) => a.id);
    removed.corporateActions.actions = [];
    Object.assign(removed.bars[0], {
      open: "50",
      high: "52",
      low: "49",
      close: "51",
      volume: "2000",
    });
    f.setNow(NOW + 1);
    const second = await f.preview(removed);
    const imported = await f.post(f.base, confirm(second, removed));
    expect(imported.statusCode, imported.body).toBe(200);
    const before = f.store.db.serialize();
    const templateResponse = await f.get(`${f.base}/template`);
    expect(templateResponse.statusCode).toBe(200);
    const template = templateResponse.json<ResearchHistoryManifest>();
    expect(template.corporateActions).toEqual({
      ...removed.corporateActions,
      removedActionIds: [],
    });
    expect(template.corporateActions.documents[0]).not.toHaveProperty("sha256");
    const next = {
      ...removed,
      source: "Third research dataset",
      corporateActions: template.corporateActions,
    };
    f.setNow(NOW + 2);
    const preview = await f.preview(next);
    expect(preview.expectedHistoryId).toBe(imported.json().history.id);
    expect(f.store.db.serialize().equals(before)).toBe(true);
  });
  it("rejects the HTTP byte cap and cross-instrument manifest before writing", async () => {
    const f = await appFixture(),
      before = f.store.db.serialize();
    const huge = await f.post(`${f.base}/preview`, {
      manifest: { ...f.manifest, source: "x".repeat(HISTORY_MAX_BYTES) },
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().code).toBe("HISTORY_TOO_LARGE");
    const mismatch = await f.post(`${f.base}/preview`, {
      manifest: { ...f.manifest, instrumentId: "US:OTHER.US" },
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().code).toBe("HISTORY_INSTRUMENT_MISMATCH");
    expect(f.store.db.serialize().equals(before)).toBe(true);
    f.store.putInstrument({
      instrument: demoInstruments[0],
      manual: false,
      note: "",
      tags: [],
    });
    const demo = await f.post(
      `/api/instruments/${demoInstruments[0].id}/research-history/preview`,
      { manifest: { ...f.manifest, instrumentId: demoInstruments[0].id } },
    );
    expect(demo.statusCode).toBe(422);
    expect(demo.json().code).toBe("HISTORY_INSTRUMENT_MISMATCH");
    expect(count(f.store, "research_history")).toBe(0);
    expect(count(f.store, "corporate_action_snapshots")).toBe(0);
    // The sole database change above is the deliberate test instrument, not a preview.
    expect(before.equals(f.store.db.serialize())).toBe(false);
  });
});
