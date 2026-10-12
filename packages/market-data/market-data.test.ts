import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import type { Bar } from "../contracts/index.js";
import {
  resolveSession,
  type CalendarDay,
  type MarketSession,
} from "./calendar.js";
import {
  normalizeBar,
  aggregateFiveMinuteBars,
  type RawBar,
} from "./normalize.js";
import { adjustForSplits, type AdjustmentDataset } from "./adjustments.js";
import {
  assessCapability,
  monitoringGate,
  type CapabilityEvidence,
} from "./capabilities.js";
import { reserveQuota, type QuotaState, type ProviderQuota } from "./quota.js";
import { BarRepository } from "./ingestion.js";
import { demoInstruments, generateDemoBars } from "./fixtures.js";
const known = Date.parse("2026-01-01T00:00:00Z");
function day(
  date: string,
  market: "US" | "CN" = "US",
  close = "16:00",
): CalendarDay {
  return {
    market,
    date,
    status: "OPEN",
    intervals:
      market === "US"
        ? [{ open: "09:30", close }]
        : [
            { open: "09:30", close: "11:30" },
            { open: "13:00", close: "15:00" },
          ],
    source: "synthetic-calendar-fixture",
    version: "v1",
    knownAt: known,
    verified: true,
  };
}
function session(
  date = "2026-10-09",
  market: "US" | "CN" = "US",
  close = "16:00",
): MarketSession {
  const r = resolveSession(
    [day(date, market, close)],
    market,
    date,
    Date.parse(date) + 86400000,
  );
  if (!r.ok || !r.session) throw Error("fixture");
  return r.session;
}
function raw(at: number, s = session()): RawBar {
  return {
    id: `bar:${at}`,
    instrumentId: "TEST.US",
    market: s.market,
    period: "1m",
    start: at,
    end: at + 60000,
    open: "100",
    high: "102",
    low: "99",
    close: "101",
    volume: "100",
    turnover: "10050",
    volumeUnit: "SHARE",
    final: true,
    receivedAt: at + 61000,
    source: "fixture",
    providerRevision: "1",
    sessionId: s.id,
    adjustment: "RAW",
  };
}
const s = session();
describe("explicit calendar and normalization", () => {
  it("uses DST but never infers a trading holiday", () => {
    expect(new Date(session("2026-03-06").open).toISOString()).toBe(
      "2026-03-06T14:30:00.000Z",
    );
    expect(new Date(session("2026-03-09").open).toISOString()).toBe(
      "2026-03-09T13:30:00.000Z",
    );
    expect(resolveSession([], "US", "2026-03-09", known)).toEqual({
      ok: false,
      reason: "CALENDAR_UNKNOWN",
    });
    const d = day("2026-12-25");
    d.status = "CLOSED";
    d.intervals = [];
    expect(resolveSession([d], "US", d.date, Date.parse(d.date))).toEqual({
      ok: true,
      session: null,
    });
    expect(
      session("2026-11-27", "US", "13:00").close -
        session("2026-11-27", "US", "13:00").open,
    ).toBe(210 * 60000);
  });
  it("rejects premature finality, unknown units, and premarket/lunch bars", () => {
    expect(() =>
      normalizeBar({ ...raw(s.open), receivedAt: s.open + 59000 }, s),
    ).toThrow("PREMATURE_FINAL_BAR");
    expect(() =>
      normalizeBar({ ...raw(s.open), volumeUnit: "UNKNOWN" }, s),
    ).toThrow("VOLUME_UNIT_UNKNOWN");
    expect(() => normalizeBar(raw(s.open - 60000), s)).toThrow(
      "BAR_NOT_SESSION_ALIGNED",
    );
    const cn = session("2026-10-09", "CN");
    expect(() => normalizeBar(raw(cn.open + 150 * 60000, cn), cn)).toThrow(
      "BAR_NOT_SESSION_ALIGNED",
    );
    const lots = normalizeBar(
      { ...raw(s.open), volumeUnit: "LOT", lotSize: 100 },
      s,
    );
    expect(lots.volume).toBe("10000");
    expect(lots.turnover).toBe("10050");
  });
  it("keeps end+30s valid, flags later arrivals historical", () => {
    expect(
      normalizeBar({ ...raw(s.open), receivedAt: s.open + 90000 }, s)
        .historical,
    ).toBe(false);
    expect(
      normalizeBar({ ...raw(s.open), receivedAt: s.open + 90001 }, s)
        .historical,
    ).toBe(true);
  });
  it("aggregates complete aligned minutes only, keeps actual turnover", () => {
    const minutes = Array.from({ length: 5 }, (_, i) =>
      normalizeBar(raw(s.open + i * 60000), s),
    );
    const result = aggregateFiveMinuteBars(minutes, s);
    expect(result.bars).toHaveLength(1);
    expect(result.bars[0]).toMatchObject({
      time: s.open / 1000,
      volume: "500",
      turnover: "50250",
      end: s.open + 300000,
    });
    expect(
      aggregateFiveMinuteBars(
        minutes.filter((_, i) => i !== 2),
        s,
      ),
    ).toMatchObject({ bars: [], gaps: [{ reason: "MISSING_MINUTE" }] });
    expect(
      aggregateFiveMinuteBars([...minutes, minutes[0]], s).gaps[0].reason,
    ).toBe("DUPLICATE_MINUTE_REVISION");
    expect(
      aggregateFiveMinuteBars(
        minutes.map((x, i) => (i === 2 ? { ...x, source: "other" } : x)),
        s,
      ).gaps[0].reason,
    ).toBe("MIXED_BAR_BASIS");
  });
});
describe("point-in-time split-only adjustments", () => {
  const bar: Bar = {
    id: "raw1",
    time: 1000,
    open: "100",
    high: "120",
    low: "90",
    close: "110",
    volume: "20",
    turnover: "2200",
    final: true,
    receivedAt: 1_010_000,
    adjustmentVersion: "raw-v1",
  };
  const data: AdjustmentDataset = {
    coverage: {
      from: 0,
      through: 4_000_000,
      knownAt: 1,
      verified: true,
      source: "fixture-verified",
      version: "coverage1",
    },
    actions: [
      {
        id: "split",
        revision: 1,
        kind: "SPLIT",
        effectiveAt: 2_000_000,
        publishedAt: 1_500_000,
        receivedAt: 1_500_100,
        source: "fixture",
        sharesBefore: "1",
        sharesAfter: "2",
      },
      {
        id: "dividend",
        revision: 1,
        kind: "CASH_DIVIDEND",
        effectiveAt: 2_100_000,
        publishedAt: 1_500_000,
        receivedAt: 1_500_100,
        source: "fixture",
      },
    ],
  };
  it("halves prices, doubles shares, never changes turnover or raw evidence", () => {
    const result = adjustForSplits([bar], data, 3_000_000, 3_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars[0]).toMatchObject({
      open: "50",
      high: "60",
      low: "45",
      close: "55",
      volume: "40",
      turnover: "2200",
      raw: bar,
    });
    expect(result.ignoredCashDividends).toBe(1);
  });
  it("does not apply future effective actions or later-known revisions to replay", () => {
    const before = adjustForSplits([bar], data, 1_900_000, 1_900_000);
    expect(before.ok && before.bars[0].close).toBe("110");
    const revised = {
      ...data,
      actions: [
        ...data.actions,
        {
          ...data.actions[0],
          revision: 2,
          sharesAfter: "3",
          publishedAt: 3_500_000,
          receivedAt: 3_600_000,
        },
      ],
    };
    const old = adjustForSplits([bar], revised, 3_000_000, 3_000_000),
      now = adjustForSplits([bar], revised, 4_000_000, 4_000_000);
    expect(old.ok && old.bars[0].volume).toBe("40");
    expect(now.ok && now.bars[0].volume).toBe("60");
    expect(old.ok && now.ok && old.version === now.version).toBe(false);
  });
  it("blocks missing action coverage, adjusted input, and future received data", () => {
    expect(
      adjustForSplits(
        [bar],
        { ...data, coverage: { ...data.coverage, verified: false } },
        3_000_000,
        3_000_000,
      ),
    ).toMatchObject({ ok: false, reason: "CORPORATE_ACTION_COVERAGE_UNKNOWN" });
    expect(
      adjustForSplits(
        [{ ...bar, adjustmentVersion: "forward" }],
        data,
        3_000_000,
        3_000_000,
      ),
    ).toMatchObject({ ok: false, reason: "RAW_PRICE_VOLUME_REQUIRED" });
    expect(
      adjustForSplits(
        [{ ...bar, receivedAt: 3_000_001 }],
        data,
        3_000_000,
        3_000_000,
      ),
    ).toMatchObject({ ok: false, reason: "BAR_NOT_KNOWN_AT_CUTOFF" });
  });
});
describe("capability and quota gates", () => {
  const evidence: CapabilityEvidence = {
    market: "US",
    source: "fixture-probe",
    checkedAt: 100,
    validUntil: 1000,
    deploymentRegion: "OTHER",
    apiEntitlementVerified: true,
    historicalReadVerified: true,
    realtimeEntitlementVerified: true,
    unitsVerified: true,
    calendarVerified: true,
    completeMinutes: true,
    finalityContractVerified: true,
    maxClosedBarDelayMs: 30000,
    quoteAgeMs: 3000,
    sequenceContractVerified: false,
    continuousTradesVerified: false,
    clockSkewMs: 0,
    delayMinutes: 0,
  };
  it("requires independent continuity evidence and rejects delayed mainland/offshore confusion", () => {
    expect(assessCapability(evidence, 500).level).toBe("LIVE_CLOSED_BAR");
    expect(assessCapability({ ...evidence, market: "CN" }, 500).level).toBe(
      "DELAYED",
    );
    expect(
      assessCapability({ ...evidence, maxClosedBarDelayMs: 30001 }, 500).level,
    ).toBe("EOD_ONLY");
    expect(assessCapability(evidence, 1001).level).toBe("UNKNOWN");
    expect(
      assessCapability({ ...evidence, delayMinutes: null }, 500).level,
    ).toBe("EOD_ONLY");
    expect(assessCapability({ ...evidence, quoteAgeMs: NaN }, 500).level).toBe(
      "EOD_ONLY",
    );
    expect(
      monitoringGate(
        assessCapability(evidence, 500),
        { ...demoInstruments[0], rulesVerified: false },
        "INTRABAR_CROSS",
      ),
    ).toEqual(["INSTRUMENT_RULES_UNKNOWN", "REALTIME_CAPABILITY_UNAVAILABLE"]);
  });
  it("shares pool and subscription limits, leaves failed reservation state unchanged", () => {
    const state: QuotaState = {
      researchSymbols: ["A.US", "B.SH"],
      monitoringSymbols: ["A.US"],
      monthlySymbols: ["A.US", "B.SH"],
      requestTimes: [],
    };
    const q: ProviderQuota = {
      verified: true,
      researchSymbols: 100,
      simultaneousSubscriptions: 1,
      monthlyUniqueSymbols: 2,
      requestsPerSecond: 1,
    };
    expect(reserveQuota(state, q, "MONITOR", "B.SH", 1000)).toMatchObject({
      ok: false,
      reason: "MONITORING_LIMIT",
    });
    expect(reserveQuota(state, q, "RESEARCH", "C.US", 1000)).toMatchObject({
      ok: false,
      reason: "MONTHLY_SYMBOL_LIMIT",
    });
    expect(state.monthlySymbols).toHaveLength(2);
    const r = reserveQuota(state, q, "REQUEST", "", 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(reserveQuota(r.state, q, "REQUEST", "", 1999)).toMatchObject({
      ok: false,
      reason: "REQUEST_RATE_LIMIT",
    });
    expect(reserveQuota(r.state, q, "REQUEST", "", 2000).ok).toBe(true);
    expect(
      reserveQuota(state, { ...q, verified: false }, "REQUEST", "", 1000).ok,
    ).toBe(false);
  });
});
describe("immutable receipt and revision persistence", () => {
  it("detects repetition/conflict/revision, preserves every receipt and original input", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys=ON");
    const repo = new BarRepository(db);
    const bar = normalizeBar(raw(s.open), s);
    const a = repo.ingest(bar),
      b = repo.ingest({ ...bar, receivedAt: bar.receivedAt + 1 }),
      c = repo.ingest({ ...bar, close: "100" }),
      d = repo.ingest({ ...bar, close: "100", revision: "2" });
    expect([a.status, b.status, c.status, d.status]).toEqual([
      "INSERTED",
      "DUPLICATE",
      "CONFLICT",
      "REVISION",
    ]);
    expect(c.invalidatesActivePlans && d.invalidatesActivePlans).toBe(true);
    expect(repo.readEvidence([a.ingestSequence])[0].close).toBe("101");
    expect(repo.receiptsKnownAt(bar.receivedAt)).toHaveLength(3);
    db.close();
  });
});
it("demo fixtures are explicit synthetic data with adequate warmup and aligned minutes", () => {
  const bars = generateDemoBars("DEMO-US-A");
  expect(bars).toHaveLength(300);
  expect(bars.at(-1)!.close).toBe("101.00");
  expect(bars.every((x) => x.id.startsWith("synthetic:"))).toBe(true);
  expect(generateDemoBars("DEMO-US-A", "1m")[1].close).toBe("100.61");
  expect(generateDemoBars("DEMO-US-A", "5m")).toHaveLength(12);
});
