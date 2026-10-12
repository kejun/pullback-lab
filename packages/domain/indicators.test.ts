import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Bar, Candidate, Instrument } from "../contracts/index.js";
import { D } from "./numeric.js";
import {
  DEFAULT_SCREENING_PARAMETERS,
  normalizeScreeningParameters,
} from "./screening-rules.js";
import {
  adr,
  atr,
  avwap,
  averageTurnover,
  calculateIndicators,
  ema,
  rankCandidates,
  returnOver,
  screenInstrument,
  supportSnapshot,
  trueRanges,
  type IndicatorBar,
} from "./indicators.js";

const instrument: Instrument = {
  id: "XNAS:TEST",
  symbol: "TEST",
  name: "Synthetic",
  market: "US",
  currency: "USD",
  tick: "0.01",
  qMin: 1,
  qStep: 1,
  sellSameDay: true,
  rulesVerified: true,
};
function bar(
  close: string,
  index: number,
  extra: Partial<IndicatorBar> = {},
): IndicatorBar {
  return {
    id: `bar-${index}`,
    time: Date.UTC(2025, 0, index + 1) / 1000,
    open: close,
    high: close,
    low: close,
    close,
    volume: "100",
    final: true,
    receivedAt: Date.UTC(2025, 0, index + 1) + 1,
    adjustmentVersion: "split-v1",
    adjustmentVerified: true,
    ...extra,
  };
}
function rising(count = 250): IndicatorBar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = new D(100).plus(new D(i).mul("0.5"));
    return bar(close.toFixed(), i, {
      high: close.mul("1.02").toFixed(),
      low: close.mul("0.98").toFixed(),
      turnover: "12000000",
    });
  });
}

describe("fixed indicator samples T01–T07", () => {
  it("T01 uses exact session lookback and actual turnover", () => {
    expect(
      returnOver(
        Array.from({ length: 31 }, (_, i) => (100 + i).toString()),
        30,
      ),
    ).toBe("0.3");
    expect(
      returnOver(
        Array.from({ length: 30 }, (_, i) => (101 + i).toString()),
        30,
      ),
    ).toBeNull();
    expect(averageTurnover(rising(20)).value).toBe("12000000");
    const candidate = screenInstrument(instrument, rising());
    expect(candidate.status).toBe("PASS");
    expect(candidate.reasons).toEqual([]);
  });
  it("T02 ranks within each market and uses code as a final stable key", () => {
    const base = screenInstrument(instrument, rising());
    const candidate = (
      name: string,
      r3: string,
      tight3: string,
      market: "CN" | "US" = "US",
    ): Candidate => ({
      ...base,
      instrument: { ...instrument, id: `X:${name}`, market },
      indicators: { ...base.indicators, r30: "0.3", r3, tight3 },
    });
    const output = rankCandidates([
      candidate("A", "0.04", "0.06"),
      candidate("B", "0.05", "0.07"),
      candidate("C", "0.05", "0.04"),
    ]);
    expect(output.map((c) => c.instrument.id)).toEqual(["X:C", "X:B", "X:A"]);
    const separate = rankCandidates(
      [
        candidate("Z", "0.05", "0.04"),
        candidate("Y", "0.05", "0.04"),
        candidate("CN", "0.01", "0.04", "CN"),
      ],
      1,
    );
    expect(separate.find((c) => c.instrument.id === "X:Y")?.rank).toBe(1);
    expect(separate.find((c) => c.instrument.id === "X:Z")?.rank).toBeNull();
    expect(separate.find((c) => c.instrument.id === "X:CN")?.rank).toBe(1);
    expect(base.rank).toBeNull();
  });
  it("T03 distinguishes ADR percent, true range and Wilder ATR seed", () => {
    expect(
      adr(
        [
          bar("11", 0, { high: "12", low: "10" }),
          bar("21", 1, { high: "22", low: "20" }),
        ],
        2,
      ),
    ).toBe("15");
    expect(
      trueRanges([bar("10", 0), bar("12", 1, { high: "13", low: "12" })]),
    ).toEqual([null, "3"]);
    const series = Array.from({ length: 15 }, (_, i) =>
      bar("10", i, { high: "11", low: "9" }),
    );
    series.push(bar("13", 15, { high: "14", low: "12" }));
    expect(atr(series)[13]).toBeNull();
    expect(atr(series)[14]).toBe("2");
    expect(
      new D(atr(series)[15]!).minus(new D(30).div(14)).abs().lt("1e-60"),
    ).toBe(true);
  });
  it("T04 preserves seed across display slicing and enforces 250 bars", () => {
    const all = ema(["1", "2", "3", "4", "5"], 3);
    expect(all).toEqual([null, null, "2", "3", "4"]);
    expect(all.slice(-2)).toEqual(["3", "4"]);
    expect(calculateIndicators(rising(50)).screeningReady).toBe(false);
    expect(calculateIndicators(rising(250)).screeningReady).toBe(true);
  });
  it("T05 volume-zero points carry the previous AVWAP but do not invent a seed", () => {
    const daily = [
      bar("10", 0, { volume: "100" }),
      bar("20", 1, { volume: "300" }),
      bar("30", 2, { volume: "0" }),
    ];
    expect(avwap(daily)).toEqual(["10", "17.5", "17.5"]);
    expect(avwap(daily.map((b) => ({ ...b, volume: "0" })))).toEqual([
      null,
      null,
      null,
    ]);
    expect(avwap(daily, 1)).toEqual([null, "20", "20"]);
    // The same DAILY result is projected into both minute chart views, never recomputed.
    const projection = {
      baseInterval: "1D",
      oneMinute: avwap(daily).at(-1),
      fiveMinute: avwap(daily).at(-1),
    };
    expect(projection).toEqual({
      baseInterval: "1D",
      oneMinute: "17.5",
      fiveMinute: "17.5",
    });
  });
  it("T06 requires one coherent adjustment version and uses inverse volume for split-normalized input", () => {
    const normalized = [
      bar("50", 0, { volume: "20", rawClose: "100", rawVolume: "10" }),
      bar("50", 1, { volume: "20", rawClose: "50", rawVolume: "20" }),
    ];
    expect(avwap(normalized).at(-1)).toBe("50");
    expect(averageTurnover(normalized, 2).value).toBe("1000");
    expect(new D(averageTurnover(normalized, 2).value!).mul(2).toFixed()).toBe(
      "2000",
    );
    expect(() =>
      avwap([
        normalized[0],
        { ...normalized[1], adjustmentVersion: "another" },
      ]),
    ).toThrow("MIXED_ADJUSTMENT_VERSION");
    expect(() =>
      avwap(normalized.map((b) => ({ ...b, adjustmentVerified: false }))),
    ).toThrow("UNVERIFIED_AVWAP_INPUT");
    expect(() =>
      avwap(normalized.map((b) => ({ ...b, adjustmentVerified: undefined }))),
    ).toThrow("UNVERIFIED_AVWAP_INPUT");
  });
  it("T07 freezes support tolerance and deduplicates indicator families", () => {
    const snapshot = supportSnapshot({
      primary: "100",
      previousClose: "100",
      tick: "0.01",
      atr14: "2",
      supports: [
        { id: "e9", family: "EMA", price: "100.2" },
        { id: "e21", family: "EMA", price: "100.1" },
        { id: "v", family: "AVWAP", price: "99.8" },
        { id: "outside", family: "HORIZONTAL", price: "100.26" },
      ],
    });
    expect(snapshot.tau).toBe("0.25");
    expect(snapshot.lower).toBe("99.75");
    expect(snapshot.upper).toBe("100.25");
    expect(snapshot.families).toEqual(["EMA", "AVWAP"]);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.distances.at(-1)?.within).toBe(false);
    expect(
      supportSnapshot({
        primary: "100",
        previousClose: "100",
        tick: "0.01",
        atr14: null,
        supports: [],
      }).reasons,
    ).toContain("ATR_NOT_READY");
  });
});

describe("indicator safety boundaries", () => {
  it("normalizes the whole ADV window when one turnover is absent", () => {
    const input = rising(20).map((b, i) => ({
      ...b,
      rawClose: "10",
      rawVolume: "100",
      turnover: i === 10 ? undefined : "9000",
    }));
    expect(averageTurnover(input)).toEqual({ value: "1000", estimated: true });
    expect(
      averageTurnover(input.map((b) => ({ ...b, rawClose: undefined }))),
    ).toMatchObject({ value: null, estimated: true });
    expect(
      averageTurnover(
        input.map((b) => ({ ...b, rawVolume: "1", sharesPerUnit: "100" })),
      ),
    ).toEqual({ value: "1000", estimated: true });
  });
  it("ignores an unfinished daily bar and rejects gaps, mixed revisions, invalid OHLC", () => {
    const input = rising();
    expect(
      calculateIndicators([...input, bar("1000", 251, { final: false })]),
    ).toEqual(calculateIndicators(input));
    expect(
      screenInstrument(instrument, input, { historyComplete: false }),
    ).toMatchObject({ status: "UNKNOWN", rank: null });
    expect(
      screenInstrument(instrument, [
        ...input.slice(0, -1),
        { ...input.at(-1)!, high: "1" },
      ]).status,
    ).toBe("UNKNOWN");
    expect(
      screenInstrument(instrument, [
        ...input.slice(0, -1),
        { ...input.at(-1)!, adjustmentVersion: "changed" },
      ]).status,
    ).toBe("UNKNOWN");
    expect(
      screenInstrument(instrument, input, { ordinaryShare: false }).reasons,
    ).toContain("NOT_ORDINARY_SHARE");
    const unknownBasis = screenInstrument(
      instrument,
      input.map((b) => ({ ...b, adjustmentVerified: undefined })),
    );
    expect(unknownBasis.status).toBe("UNKNOWN");
    expect(unknownBasis.reasons).toContain("ADJUSTMENT_PROVENANCE_UNVERIFIED");
    expect(unknownBasis.indicators.ema9).not.toBeNull();
    expect(unknownBasis.indicators.screeningReady).toBe(false);
  });
  it("treats equal EMAs as failing strict trend, never as a strong-stock match", () => {
    const flat = Array.from({ length: 250 }, (_, i) =>
      bar("100", i, { high: "102", low: "98", turnover: "12000000" }),
    );
    expect(screenInstrument(instrument, flat).reasons).toContain(
      "EMA_ORDER_NOT_STRICT",
    );
  });
  it("does not chain support matches through neighboring lines", () => {
    const snapshot = supportSnapshot({
      primary: "100",
      previousClose: "100",
      tick: "0.01",
      atr14: "2",
      supports: [
        { id: "a", family: "EMA", price: "100.2" },
        { id: "b", family: "AVWAP", price: "100.4" },
      ],
    });
    expect(snapshot.ready).toBe(false);
    expect(snapshot.families).toEqual(["EMA"]);
  });
  it("EMA of a constant positive sequence is constant after its seed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 2, max: 50 }),
        (value, period) => {
          const output = ema(
            Array.from({ length: period + 5 }, () => value.toString()),
            period,
          );
          expect(output.slice(0, period - 1).every((x) => x === null)).toBe(
            true,
          );
          expect(
            output.slice(period - 1).every((x) => new D(x!).eq(value)),
          ).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("versioned screening thresholds", () => {
  it("normalizes decimal text and accepts inclusive ADR and rank bounds", () => {
    expect(
      normalizeScreeningParameters({
        minimumAdv20: { US: "10000000.00", CN: "100000000.000" },
        adrMinPct: "-0.00",
        adrMaxPct: "100.000",
        limitPerMarket: 1,
      }),
    ).toEqual({
      minimumAdv20: { US: "10000000", CN: "100000000" },
      adrMinPct: "0",
      adrMaxPct: "100",
      limitPerMarket: 1,
    });
    expect(normalizeScreeningParameters(DEFAULT_SCREENING_PARAMETERS)).toEqual(
      DEFAULT_SCREENING_PARAMETERS,
    );
    const copy = normalizeScreeningParameters(DEFAULT_SCREENING_PARAMETERS);
    copy.minimumAdv20.US = "1";
    expect(DEFAULT_SCREENING_PARAMETERS.minimumAdv20.US).toBe("10000000");
  });

  it("rejects unsafe decimals, invalid ranges and limits before screening", () => {
    for (const invalid of [
      10,
      "1e7",
      " 10",
      "NaN",
      "Infinity",
      "01",
      "-1",
      "0",
    ])
      expect(() =>
        normalizeScreeningParameters({
          ...DEFAULT_SCREENING_PARAMETERS,
          minimumAdv20: { US: invalid, CN: "100000000" },
        }),
      ).toThrow();
    for (const invalid of [
      null,
      [],
      {},
      { ...DEFAULT_SCREENING_PARAMETERS, minimumHistory: 1 },
      { ...DEFAULT_SCREENING_PARAMETERS, minimumAdv20: { US: "1" } },
      {
        ...DEFAULT_SCREENING_PARAMETERS,
        minimumAdv20: { US: "1", CN: "1", HK: "1" },
      },
      { ...DEFAULT_SCREENING_PARAMETERS, adrMinPct: "-0.01" },
      { ...DEFAULT_SCREENING_PARAMETERS, adrMinPct: 2 },
      { ...DEFAULT_SCREENING_PARAMETERS, adrMinPct: "16" },
      { ...DEFAULT_SCREENING_PARAMETERS, adrMaxPct: "100.0000000000000001" },
      ...[0, 31, 1.5, "3", NaN, Infinity].map((limitPerMarket) => ({
        ...DEFAULT_SCREENING_PARAMETERS,
        limitPerMarket,
      })),
    ])
      expect(() => normalizeScreeningParameters(invalid)).toThrow();
    expect(() =>
      screenInstrument(instrument, rising(), {
        parameters: { ...DEFAULT_SCREENING_PARAMETERS, adrMinPct: "16" },
      }),
    ).toThrow("INVALID_ADR_RANGE");
  });

  it("preserves the original defaults, indicator formulas and required history", () => {
    const bars = rising();
    const original = screenInstrument(instrument, bars);
    expect(
      screenInstrument(instrument, bars, {
        parameters: DEFAULT_SCREENING_PARAMETERS,
      }),
    ).toEqual(original);
    const relaxed = {
      minimumAdv20: { US: "1", CN: "1" },
      adrMinPct: "0",
      adrMaxPct: "100",
      limitPerMarket: 10,
    };
    expect(
      screenInstrument(instrument, bars, { parameters: relaxed }).indicators,
    ).toEqual(original.indicators);
    expect(
      screenInstrument(instrument, bars.slice(1), {
        parameters: relaxed,
        requiredHistory: 1,
      }),
    ).toMatchObject({ status: "UNKNOWN", reasons: ["INSUFFICIENT_HISTORY"] });
    const flat = Array.from({ length: 250 }, (_, i) =>
      bar("100", i, { turnover: "100000000" }),
    );
    expect(
      screenInstrument(instrument, flat, { parameters: relaxed }).reasons,
    ).toEqual(["EMA_ORDER_NOT_STRICT", "EMA21_NOT_RISING", "R30_NOT_POSITIVE"]);
  });

  it("uses exact inclusive thresholds and independent market liquidity limits", () => {
    const bars = rising().map((b) => ({
      ...b,
      low: b.close,
      high: new D(b.close).mul("1.03").toFixed(),
    }));
    const parameters = {
      minimumAdv20: { US: "12000000", CN: "12000000.0000000000000001" },
      adrMinPct: "3",
      adrMaxPct: "3",
      limitPerMarket: 30,
    };
    expect(screenInstrument(instrument, bars, { parameters }).status).toBe(
      "PASS",
    );
    expect(
      screenInstrument({ ...instrument, market: "CN", currency: "CNY" }, bars, {
        parameters,
      }).reasons,
    ).toEqual(["LOW_LIQUIDITY"]);
    expect(
      screenInstrument(instrument, bars, {
        parameters: {
          ...parameters,
          adrMinPct: "3.0000000000000001",
          adrMaxPct: "4",
        },
      }).reasons,
    ).toEqual(["ADR_OUTSIDE_RANGE"]);
    expect(
      screenInstrument(instrument, bars, {
        parameters: {
          ...parameters,
          adrMinPct: "2",
          adrMaxPct: "2.9999999999999999",
        },
      }).reasons,
    ).toEqual(["ADR_OUTSIDE_RANGE"]);
  });

  it("retains over-cap rows and applies the confirmed cap separately per market", () => {
    const base = screenInstrument(instrument, rising());
    const candidates = (["US", "CN"] as const).flatMap((market) =>
      Array.from({ length: 32 }, (_, i): Candidate => ({
        ...base,
        instrument: {
          ...instrument,
          market,
          id: `${market}:${i.toString().padStart(2, "0")}`,
        },
      })),
    );
    for (const limitPerMarket of [1, 7, 30]) {
      const parameters = normalizeScreeningParameters({
        ...DEFAULT_SCREENING_PARAMETERS,
        limitPerMarket,
      });
      const ranked = rankCandidates(candidates, parameters.limitPerMarket);
      expect(ranked).toHaveLength(64);
      for (const market of ["US", "CN"]) {
        const rows = ranked.filter((row) => row.instrument.market === market);
        expect(rows.filter((row) => row.rank !== null)).toHaveLength(
          limitPerMarket,
        );
        expect(rows.at(limitPerMarket)?.reasons).toContain(
          "BEYOND_MARKET_LIMIT",
        );
        expect(rows[0].instrument.id).toBe(`${market}:00`);
      }
    }
    expect(
      candidates.every((row) => row.rank === null && row.reasons.length === 0),
    ).toBe(true);
  });
});
