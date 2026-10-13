import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("longbridge", () => ({
  Config: { fromApikey: vi.fn(() => ({})) },
  QuoteContext: { new: vi.fn() },
  Period: { Min_1: 1 },
  PushCandlestickMode: { Confirmed: 1 },
  SubType: { Quote: 1 },
  TradeSession: { Intraday: 0 },
  TradeSessions: { Intraday: 0 },
  TradeStatus: { Normal: 0 },
}));
import { QuoteContext } from "longbridge";
import { ClosedBarRuntime } from "../closed-bar-runtime.js";
import { planInput, testFunds } from "./closed-bar-fixture.js";
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
import type { Market } from "../../../packages/contracts/index.js";
import {
  resolveSession,
  type CalendarDay,
} from "../../../packages/market-data/calendar.js";
import { Store } from "../store.js";
import { ActionEvidenceRepository } from "../../../packages/market-data/action-evidence.js";
import { actionTestManifest } from "../../../packages/market-data/action-evidence-fixture.js";
import {
  buildLongbridgeContext,
  type LongbridgeContextInput,
} from "../longbridge-context-builder.js";
import { prepareProductionMarket } from "../production-market.js";
import { LONGBRIDGE_SOURCE } from "../longbridge-closed-bar-adapter.js";
import { ContractAdapter } from "./closed-bar-fixture.js";

const quota = {
  researchSymbols: 100,
  simultaneousSubscriptions: 10,
  monthlyUniqueSymbols: 100,
  requestsPerSecond: 2,
  verified: true,
};
function fixture(market: Market = "US") {
  const base = new ContractAdapter().context;
  const now = Date.parse(
    market === "US" ? "2026-10-09T13:30:00Z" : "2026-10-09T01:30:00Z",
  );
  const input: LongbridgeContextInput = {
    probeReportId: "isolated-probe",
    instrumentRulesId: "isolated-rules",
    adjustmentEvidenceId: "isolated-action-review",
    instrument: {
      ...base.instrument,
      id: `TEST-${market}`,
      symbol: market === "US" ? "TEST.US" : "600000.SH",
      market,
      currency: market === "US" ? "USD" : "CNY",
      sellSameDay: market === "US",
    },
    capability: {
      ...base.capability,
      source: LONGBRIDGE_SOURCE,
      market,
      deploymentRegion: market === "US" ? "OTHER" : "CN_MAINLAND",
      checkedAt: now - 1,
      validUntil: now + 8 * 3600000,
    },
    historyStartDate: "2025-10-01",
    basisDate: "2026-10-09",
    calendarDays: [],
    rawDaily: [],
    adjustments: {
      actions: [],
      coverage: {
        from: 0,
        through: now + 8 * 3600000,
        knownAt: now - 1,
        verified: true,
        source: "isolated-test-only",
        version: "isolated-no-actions",
      },
    },
  };
  const calendars: CalendarDay[] = [],
    raw: LongbridgeContextInput["rawDaily"][number][] = [];
  for (
    let at = Date.parse("2025-10-01T00:00:00Z");
    at <= Date.parse("2026-10-09T00:00:00Z");
    at += 86400000
  ) {
    const date = new Date(at).toISOString().slice(0, 10),
      weekday = new Date(at).getUTCDay();
    const open = weekday !== 0 && weekday !== 6;
    const day: CalendarDay = {
      market,
      date,
      status: open ? "OPEN" : "CLOSED",
      intervals: !open
        ? []
        : market === "US"
          ? [
              {
                open: "09:30",
                close: date === "2025-11-28" ? "13:00" : "16:00",
              },
            ]
          : [
              { open: "09:30", close: "11:30" },
              { open: "13:00", close: "15:00" },
            ],
      source: "isolated-calendar-not-real-exchange-validation",
      version: "fixture-v1",
      knownAt: now - 1,
      verified: true,
    };
    calendars.push(day);
    const result = resolveSession([day], market, date, now);
    if (date !== input.basisDate && result.ok && result.session) {
      const s = result.session;
      raw.push({
        id: `raw:${market}:${date}`,
        instrumentId: input.instrument.id,
        market,
        period: "1D",
        start: s.open,
        end: s.close,
        sessionId: s.id,
        open: "100",
        high: "102",
        low: "99",
        close: "101",
        volume: "1000",
        turnover: "100500",
        volumeUnit: "SHARE",
        adjustment: "RAW",
        final: true,
        receivedAt: s.close + 1000,
        source: LONGBRIDGE_SOURCE,
        providerRevision: "reviewed-1",
      });
    }
  }
  input.calendarDays = calendars;
  input.rawDaily = raw;
  return { input, now };
}

describe("audited production history assembly", () => {
  it.each(["US", "CN"] as const)(
    "builds %s complete explicit sessions and exact raw/split lineage",
    (market) => {
      const { input, now } = fixture(market),
        context = buildLongbridgeContext(input, now);
      expect(context.daily).toHaveLength(input.rawDaily.length);
      expect(context.daily.length).toBeGreaterThan(250);
      expect(context.source).toBe(LONGBRIDGE_SOURCE);
      expect(context.dailyHistoryId).toMatch(/^longbridge-daily:[a-f0-9]{64}$/);
      expect(context.daily[0]).toMatchObject({
        open: "100",
        volume: "1000",
        turnover: "100500",
        adjustmentVerified: true,
        synthetic: false,
        raw: { adjustmentVersion: "raw-v1", source: LONGBRIDGE_SOURCE },
      });
      expect(context.capability.sequenceContractVerified).toBe(false);
      expect(buildLongbridgeContext(structuredClone(input), now)).toEqual(
        context,
      );
      expect(input.rawDaily[0].adjustment).toBe("RAW");
    },
  );
  it("preserves explicit historical half-day hours and DST, never extrapolating today's interval", () => {
    const { input, now } = fixture();
    const c = buildLongbridgeContext(input, now);
    const half = c.daily.find((b) =>
      b.id.endsWith("2025-11-28"),
    )! as (typeof c.daily)[number] & { raw: { end: number } };
    expect(new Date(half.raw.end).toISOString()).toBe(
      "2025-11-28T18:00:00.000Z",
    );
    expect(
      new Date(
        c.daily.find((b) => b.id.endsWith("2026-03-06"))!.time * 1000,
      ).getUTCHours(),
    ).toBe(14);
    expect(
      new Date(
        c.daily.find((b) => b.id.endsWith("2026-03-09"))!.time * 1000,
      ).getUTCHours(),
    ).toBe(13);
  });
  it.each([
    [
      "missing open calendar day",
      (i: LongbridgeContextInput) => {
        i.calendarDays = i.calendarDays.filter((d) => d.date !== "2026-10-08");
      },
    ],
    [
      "missing closure calendar day",
      (i: LongbridgeContextInput) => {
        i.calendarDays = i.calendarDays.filter((d) => d.date !== "2026-10-04");
      },
    ],
    [
      "missing daily session despite >250 bars",
      (i: LongbridgeContextInput) => {
        i.rawDaily = i.rawDaily.slice(1);
      },
    ],
    [
      "duplicate session",
      (i: LongbridgeContextInput) => {
        const a = [...i.rawDaily];
        a[0] = a[1];
        i.rawDaily = a;
      },
    ],
    [
      "unverified calendar",
      (i: LongbridgeContextInput) => {
        i.calendarDays[0].verified = false;
      },
    ],
    [
      "conflicting calendar",
      (i: LongbridgeContextInput) => {
        i.calendarDays = [
          ...i.calendarDays,
          { ...i.calendarDays[0], version: "conflict" },
        ];
      },
    ],
    [
      "future calendar",
      (i: LongbridgeContextInput) => {
        i.calendarDays[0].knownAt = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      "bad historical close",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].end -= 60000;
      },
    ],
    [
      "premature final",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].receivedAt = i.rawDaily[0].end - 1;
      },
    ],
    [
      "future receipt",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].receivedAt = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      "synthetic input",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].synthetic = true;
      },
    ],
    [
      "wrong source",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].source = "other";
      },
    ],
    [
      "wrong instrument",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].instrumentId = "other";
      },
    ],
    [
      "unknown volume",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].volumeUnit = "UNKNOWN";
      },
    ],
    [
      "forward-adjusted input",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].adjustment = "FORWARD";
      },
    ],
    [
      "fractional raw volume",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].volume = "0.5";
      },
    ],
    [
      "unconfirmed daily",
      (i: LongbridgeContextInput) => {
        i.rawDaily[0].final = false;
      },
    ],
    [
      "missing action coverage",
      (i: LongbridgeContextInput) => {
        i.adjustments.coverage.verified = false;
      },
    ],
    [
      "coverage short of target close",
      (i: LongbridgeContextInput) => {
        i.adjustments.coverage.through = Date.parse("2026-10-09T13:30:00Z");
      },
    ],
    [
      "future action coverage knowledge",
      (i: LongbridgeContextInput) => {
        i.adjustments.coverage.knownAt = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      "expired capability",
      (i: LongbridgeContextInput) => {
        i.capability.validUntil = 0;
      },
    ],
  ] as const)(
    "rejects %s without certifying external facts",
    (_name, change) => {
      const { input, now } = fixture();
      change(input);
      expect(() => buildLongbridgeContext(input, now)).toThrow();
    },
  );
  it("applies forward/reverse splits to prices and shares while cash/turnover remain unchanged", () => {
    for (const [after, before, price, volume] of [
      ["2", "1", "50", "2000"],
      ["1", "2", "200", "500"],
    ]) {
      const { input, now } = fixture();
      input.adjustments.actions = [
        {
          id: "split",
          revision: 1,
          kind: "SPLIT",
          effectiveAt: now,
          publishedAt: now - 1000,
          receivedAt: now - 1,
          source: "isolated",
          sharesAfter: after,
          sharesBefore: before,
        },
        {
          id: "cash",
          revision: 1,
          kind: "CASH_DIVIDEND",
          effectiveAt: now,
          publishedAt: now - 1000,
          receivedAt: now - 1,
          source: "isolated",
        },
      ];
      const c = buildLongbridgeContext(input, now);
      expect(c.daily[0]).toMatchObject({
        open: price,
        volume,
        turnover: "100500",
      });
      input.adjustments.actions.push({
        ...input.adjustments.actions[0],
        revision: 2,
        sharesAfter: "100",
        receivedAt: now + 1,
        publishedAt: now + 1,
      });
      expect(buildLongbridgeContext(input, now).daily[0]).toEqual(c.daily[0]);
    }
  });
  it("blocks a split inside a daily candle or later in the target session", () => {
    for (const where of ["daily", "target"]) {
      const { input, now } = fixture();
      input.adjustments.actions = [
        {
          id: "split",
          revision: 1,
          kind: "SPLIT",
          effectiveAt:
            where === "daily" ? input.rawDaily[0].start + 60000 : now + 60000,
          publishedAt: now - 2,
          receivedAt: now - 1,
          source: "isolated",
          sharesAfter: "2",
          sharesBefore: "1",
        },
      ];
      expect(() => buildLongbridgeContext(input, now)).toThrow(
        /HISTORY_(ACTION_INSIDE_DAILY_BAR|TARGET_SCALE_CHANGED)/,
      );
    }
  });
  it("can project pre-open with only already-known data", () => {
    const { input, now } = fixture();
    expect(buildLongbridgeContext(input, now - 1).basisDate).toBe("2026-10-09");
  });
});

it("projects a known scheduled split without borrowing future publications or receipts", () => {
  const { input, now: open } = fixture(),
    at = open - 1;
  input.adjustments.actions = [
    {
      id: "scheduled",
      revision: 1,
      kind: "SPLIT",
      effectiveAt: open,
      publishedAt: at - 1000,
      receivedAt: at,
      source: "isolated",
      sharesAfter: "2",
      sharesBefore: "1",
    },
    {
      id: "scheduled",
      revision: 2,
      kind: "SPLIT",
      effectiveAt: open,
      publishedAt: at,
      receivedAt: open,
      source: "isolated",
      sharesAfter: "100",
      sharesBefore: "1",
    },
    {
      id: "unpublished",
      revision: 1,
      kind: "SPLIT",
      effectiveAt: open,
      publishedAt: open,
      receivedAt: open,
      source: "isolated",
      sharesAfter: "100",
      sharesBefore: "1",
    },
  ];
  expect(buildLongbridgeContext(input, at).daily[0]).toMatchObject({
    open: "50",
    volume: "2000",
  });
});

it("starts and activates before open with advancing clock, then persists the first actual closed callback", async () => {
  const { input, now: open } = fixture();
  const start = open - 30000;
  input.capability.checkedAt = start - 1000;
  input.adjustments.coverage.knownAt = start - 1000;
  input.calendarDays.forEach((d) => {
    d.knownAt = start - 1000;
  });
  vi.useFakeTimers();
  vi.setSystemTime(start);
  let onCandle: (error: null, event: unknown) => void = () => {};
  const port = {
    setOnCandlestick: (cb: typeof onCandle) => {
      onCandle = cb;
    },
    setOnQuote: () => {},
    subscribe: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
    }),
    subscribeCandlesticks: vi.fn(async () => []),
    unsubscribe: vi.fn(async () => {}),
    unsubscribeCandlesticks: vi.fn(async () => {}),
  };
  vi.mocked(QuoteContext.new).mockImplementation(
    (() => new Promise((r) => setTimeout(() => r(port), 100))) as never,
  );
  const prepared = prepareProductionMarket(
    { histories: [input], quota },
    {
      PULLBACK_CLOSED_BAR_MODE: "longbridge-close-confirm",
      LONGBRIDGE_APP_KEY: "test",
      LONGBRIDGE_APP_SECRET: "test",
      LONGBRIDGE_ACCESS_TOKEN: "test",
    },
    Date.now,
  );
  const store = new Store(":memory:");
  store.putInstrument({
    instrument: input.instrument,
    manual: false,
    note: "isolated",
    tags: [],
  });
  const runner = new ClosedBarRuntime(store, {
    adapter: prepared.factory!(store),
    now: Date.now,
  });
  try {
    const starting = runner.start();
    await vi.advanceTimersByTimeAsync(500);
    await starting;
    expect(Date.now()).toBe(start + 500);
    store.confirmScreening(undefined, 0, Date.now());
    store.updateFunds({ ...testFunds, fxAsOf: Date.now() }, 0, Date.now());
    const plan = store.createPlan(
      {
        ...planInput,
        instrumentId: input.instrument.id,
        primarySupport: "100.8",
        lower: "100.55",
        upper: "100.99",
        stop: "100.07",
        entryMin: "101.28",
        entryMax: "102.5",
        supportSelections: [
          { source: "EMA9" },
          {
            source: "HORIZONTAL",
            id: "main",
            price: "100.8",
            label: "support",
          },
        ],
      },
      Date.now(),
    );
    runner.activate(plan.id, {
      expectedVersion: plan.version,
      expectedAttemptId: null,
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(Date.now()).toBeLessThan(open);
    expect(port.subscribeCandlesticks).toHaveBeenCalledOnce();
    expect(
      store.db.prepare("SELECT from_at,through_at FROM closed_streams").get(),
    ).toMatchObject({ from_at: open, through_at: open });
    await vi.advanceTimersByTimeAsync(open + 60000 - Date.now());
    onCandle(null, {
      symbol: input.instrument.symbol,
      data: {
        period: 1,
        isConfirmed: true,
        candlestick: {
          timestamp: new Date(open),
          open: "101",
          high: "102",
          low: "100.8",
          close: "101.5",
          volume: 1000,
          turnover: "101000",
          tradeSession: 0,
        },
      },
    });
    expect(
      store.db.prepare("SELECT through_at FROM closed_streams").get(),
    ).toMatchObject({ through_at: open + 60000 });
    expect(
      store.db
        .prepare("SELECT received_at FROM closed_receipts WHERE kind='MINUTE'")
        .get(),
    ).toMatchObject({ received_at: open + 60000 });
  } finally {
    const stopping = runner.stop();
    await vi.runAllTimersAsync();
    await stopping;
    store.close();
  }
});

describe("production startup installation", () => {
  it("defaults off; an environment flag or uploaded-shaped JSON cannot supply trusted server configuration", () => {
    expect(prepareProductionMarket(undefined, {}).report).toMatchObject({
      configured: false,
      liveEnabled: false,
      mode: "off",
    });
    expect(() =>
      prepareProductionMarket(undefined, {
        PULLBACK_CLOSED_BAR_MODE: "longbridge-close-confirm",
        PULLBACK_VERIFIED: "true",
        PULLBACK_CLOSED_CONTEXTS: '{"verified":true}',
      }),
    ).toThrow("AUDITED_SERVER_CONFIGURATION_REQUIRED");
    expect(() =>
      prepareProductionMarket(undefined, { PULLBACK_CLOSED_BAR_MODE: "live" }),
    ).toThrow("MARKET_MODE_INVALID");
  });
  it("prepares the actual lazy production factory without credentials or a provider request", () => {
    const { input, now } = fixture();
    const prepared = prepareProductionMarket(
      { histories: [input], quota },
      { PULLBACK_CLOSED_BAR_MODE: "longbridge-close-confirm" },
      () => now,
    );
    expect(prepared.report).toMatchObject({
      configured: true,
      contextCount: 1,
      liveEnabled: false,
    });
    const store = new Store(":memory:");
    try {
      store.putInstrument({
        instrument: input.instrument,
        manual: false,
        note: "isolated",
        tags: [],
      });
      const adapter = prepared.factory!(store);
      expect(adapter.contexts()).toHaveLength(1);
      expect(adapter.contexts()[0].dailyHistoryId).toMatch(
        /^longbridge-daily:/,
      );
    } finally {
      store.close();
    }
  });
  it.each([{ PULLBACK_MARKET_WORKER: "1" }, { PULLBACK_DEMO: "1" }])(
    "rejects incompatible mode %j before preparing a factory",
    (flags) => {
      expect(() =>
        prepareProductionMarket(undefined, {
          PULLBACK_CLOSED_BAR_MODE: "longbridge-close-confirm",
          ...flags,
        }),
      ).toThrow();
    },
  );
  it("enforces lower provider capacities and duplicate identities at preflight", () => {
    const { input, now } = fixture(),
      env = { PULLBACK_CLOSED_BAR_MODE: "longbridge-close-confirm" };
    expect(() =>
      prepareProductionMarket(
        { histories: [input], quota: { ...quota, verified: false } },
        env,
        () => now,
      ),
    ).toThrow("PROVIDER_QUOTA_UNKNOWN");
    expect(() =>
      prepareProductionMarket(
        {
          histories: [input],
          quota: { ...quota, simultaneousSubscriptions: 0 },
        },
        env,
        () => now,
      ),
    ).toThrow("PROVIDER_QUOTA_UNKNOWN");
    for (const limits of [
      { researchSymbols: 0 },
      { monthlyUniqueSymbols: 0 },
    ]) {
      expect(() =>
        prepareProductionMarket(
          { histories: [input], quota: { ...quota, ...limits } },
          env,
          () => now,
        ),
      ).toThrow("PROVIDER_QUOTA_UNKNOWN");
    }
    expect(() =>
      prepareProductionMarket(
        { histories: [input, input], quota },
        env,
        () => now,
      ),
    ).toThrow("CLOSED_SUBSCRIPTION_LIMIT");
  });
  it("market:check and main reject an uninstalled mode without secrets, database or lock writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pullback-production-check-")),
      db = join(dir, "new.sqlite");
    try {
      for (const entry of [
        "scripts/check-production-market.ts",
        "apps/server/main.ts",
      ]) {
        const result = spawnSync(process.execPath, ["--import", "tsx", entry], {
          env: {
            ...process.env,
            NODE_ENV: "test",
            PULLBACK_PASSWORD: "test-password",
            PULLBACK_DB: db,
            PULLBACK_DEMO: "0",
            PULLBACK_MARKET_WORKER: "0",
            PULLBACK_CLOSED_BAR_MODE: "longbridge-close-confirm",
            LONGBRIDGE_ACCESS_TOKEN: "never-echo-this-private-test-value",
          },
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 100000,
        });
        expect(result.status).toBe(entry.startsWith("scripts/") ? 2 : 1);
        expect(result.stderr).toContain(
          "AUDITED_SERVER_CONFIGURATION_REQUIRED",
        );
        expect(result.stdout + result.stderr).not.toContain("never-echo");
        expect(existsSync(db)).toBe(false);
        expect(existsSync(db + ".lock")).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("production factory requires explicitly reviewed persistent action binding and consistent facts, never auto-binds current", () => {
  const { input, now } = fixture();
  const store = new Store(":memory:");
  try {
    store.putInstrument({
      instrument: input.instrument,
      manual: false,
      note: "isolated",
      tags: [],
    });
    const manifest = actionTestManifest();
    manifest.instrumentId = input.instrument.id;
    manifest.actions[0].effectiveAt = input.rawDaily[1].start;
    manifest.coverage.through = now;
    const version = store.importActionEvidence(manifest, now).version;
    const env = { PULLBACK_CLOSED_BAR_MODE: "longbridge-close-confirm" };
    const old = prepareProductionMarket(
      { histories: [input], quota },
      env,
      () => now,
    );
    expect(() => old.factory!(store)).toThrow(
      "CORPORATE_ACTION_CONTEXT_REVOKED",
    );
    input.actionEvidenceVersion = version;
    input.adjustmentEvidenceId = version;
    input.adjustments.actions = new ActionEvidenceRepository(store.db).dataset(
      input.instrument.id,
      now,
      version,
    )!.actions;
    input.adjustments.coverage.knownAt = now;
    const valid = prepareProductionMarket(
      { histories: [input], quota },
      env,
      () => now,
    );
    expect(valid.factory!(store).contexts()[0].actionEvidenceVersion).toBe(
      version,
    );
    const mismatch = structuredClone(input);
    mismatch.adjustments.actions[0].sharesAfter = "3";
    const bad = prepareProductionMarket(
      { histories: [mismatch], quota },
      env,
      () => now,
    );
    expect(() => bad.factory!(store)).toThrow(
      "HISTORY_ACTION_BINDING_MISMATCH",
    );
    manifest.expectedVersion = version;
    manifest.coverage.status = "UNKNOWN";
    store.importActionEvidence(manifest, now);
    expect(() => valid.factory!(store)).toThrow(
      "CORPORATE_ACTION_CONTEXT_REVOKED",
    );
  } finally {
    store.close();
  }
});

it("keeps withdrawn actions revoked through later snapshots and allows explicit reintroduction", () => {
  const { input, now } = fixture();
  const store = new Store(":memory:");
  try {
    store.putInstrument({
      instrument: input.instrument,
      manual: false,
      note: "isolated",
      tags: [],
    });
    const manifest = actionTestManifest();
    manifest.instrumentId = input.instrument.id;
    manifest.actions[0].effectiveAt = input.rawDaily[1].start;
    manifest.coverage.through = now;
    const original = structuredClone(manifest.actions);
    const v1 = store.importActionEvidence(manifest, now).version;
    input.adjustments.actions = new ActionEvidenceRepository(store.db).dataset(
      input.instrument.id,
      now,
      v1,
    )!.actions;
    input.adjustments.coverage.knownAt = now;
    const build = () =>
      prepareProductionMarket(
        { histories: [input], quota },
        { PULLBACK_CLOSED_BAR_MODE: "longbridge-close-confirm" },
        () => now,
      ).factory!(store);
    manifest.expectedVersion = v1;
    manifest.actions = [];
    manifest.removedActionIds = original.map((a) => a.id);
    input.actionEvidenceVersion = store.importActionEvidence(
      manifest,
      now,
    ).version;
    expect(build).toThrow("HISTORY_ACTION_BINDING_MISMATCH");
    manifest.expectedVersion = input.actionEvidenceVersion;
    manifest.removedActionIds = [];
    manifest.coverage.reason = "isolated unrelated later review";
    input.actionEvidenceVersion = store.importActionEvidence(
      manifest,
      now,
    ).version;
    expect(build).toThrow("HISTORY_ACTION_BINDING_MISMATCH");
    manifest.expectedVersion = input.actionEvidenceVersion;
    manifest.actions = original;
    input.actionEvidenceVersion = store.importActionEvidence(
      manifest,
      now,
    ).version;
    expect(build().contexts()[0].actionEvidenceVersion).toBe(
      input.actionEvidenceVersion,
    );
  } finally {
    store.close();
  }
});
