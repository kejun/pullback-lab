import { describe, expect, it } from "vitest";
import {
  CN_MINUTE_INTEGER_DIGITS,
  CN_MINUTE_PACKET_LIMIT,
  CN_MINUTE_TRADE_LIMIT,
  createCnMinuteSourcesCapture,
  diagnoseCnMinuteSources,
  labelCnMinuteTimestamp,
  normalizeEndpointVolume,
  summarizeCnMinuteSources,
  type CnMinuteSourcesCapture,
  type CnMinuteSourcesDiagnostic,
  type ProviderEndpointVolume,
} from "./cn-minute-sources.js";
import type { ProviderBarSample } from "./longbridge.js";

const time = (clock: string, day = "2026-10-13") =>
  Date.parse(`${day}T${clock}+08:00`);
function sample(overrides: Partial<ProviderBarSample> = {}): ProviderBarSample {
  return {
    symbol: "600519.SH",
    period: "1m",
    timestamp: time("09:30:00"),
    receivedAt: time("09:32:00"),
    open: "10",
    high: "11",
    low: "9",
    close: "10",
    volume: "1000",
    turnover: "10000",
    tradeSession: 0,
    adjustment: "RAW",
    finality: "UNKNOWN",
    volumeUnit: "UNVERIFIED",
    ...overrides,
  };
}
function capture(): CnMinuteSourcesCapture {
  return {
    ...createCnMinuteSourcesCapture(time("09:29:00")),
    status: "SAMPLED",
    completedAt: time("09:32:00"),
    instruments: [{ symbol: "600519.SH", securityBoard: 13 }],
    seeds: [
      {
        symbol: "600519.SH",
        period: "1m",
        endpoint: "candlesticks",
        receivedAt: time("09:32:00"),
        samples: [sample()],
      },
    ],
    tradePackets: [
      {
        symbol: "600519.SH",
        receivedAt: time("09:30:20"),
        providerSequence: null,
        trades: [
          {
            timestamp: time("09:30:10"),
            price: "10",
            volume: "2",
            tradeType: "",
            direction: 0,
            tradeSession: 0,
          },
        ],
      },
    ],
  };
}
const raw = (
  overrides: Partial<ProviderEndpointVolume> = {},
): ProviderEndpointVolume => ({
  kind: "providerRaw",
  endpoint: "pushTrades",
  volume: "2",
  unit: "LOT",
  sharesPerUnit: "100",
  ...overrides,
});
const assertUnknown = (
  value:
    ReturnType<typeof summarizeCnMinuteSources> | CnMinuteSourcesDiagnostic,
) => {
  expect(value).toMatchObject({
    capability: "UNKNOWN",
    liveEligible: false,
    continuity: "UNKNOWN",
    coverage: "UNKNOWN",
    finality: "UNKNOWN",
  });
};

describe("endpoint-specific exact volume arithmetic", () => {
  it("keeps SHARE seeds and LOT Trades separate without scaling a mixed 1002 total", () => {
    const seed = normalizeEndpointVolume(
      raw({
        endpoint: "candlesticks",
        volume: "1000",
        unit: "SHARE",
        sharesPerUnit: "1",
      }),
    );
    const trade = normalizeEndpointVolume(raw());
    expect(seed.volume).toBe("1000");
    expect(trade.volume).toBe("200");
    expect(trade).toMatchObject({
      kind: "normalizedShare",
      unit: "SHARE",
      unitVerification: "UNVERIFIED",
      original: raw(),
    });
    expect(() =>
      normalizeEndpointVolume(
        raw({ endpoint: "sdkMixedCandlesticks", volume: "1002" }),
      ),
    ).toThrow("SDK_MIXED_CANDLESTICK_REJECTED");
  });
  it("rejects any attempt to normalize tagged output again", () => {
    const value = normalizeEndpointVolume(raw());
    expect(() =>
      normalizeEndpointVolume(value as unknown as ProviderEndpointVolume),
    ).toThrow("INVALID_ENDPOINT_VOLUME");
    expect(() =>
      normalizeEndpointVolume({
        ...value,
        endpoint: "pushTrades",
        sharesPerUnit: "100",
      } as unknown as ProviderEndpointVolume),
    ).toThrow("INVALID_ENDPOINT_VOLUME");
    expect(() =>
      normalizeEndpointVolume({
        ...raw(),
        original: value.original,
      } as ProviderEndpointVolume),
    ).toThrow("INVALID_ENDPOINT_VOLUME");
  });
  it("preserves original formatting and stays exact beyond binary integer and default Decimal precision", () => {
    const volume = "00900719925474099312345678901234567890";
    const result = normalizeEndpointVolume(raw({ volume }));
    expect(result.volume).toBe("90071992547409931234567890123456789000");
    expect(result.original.volume).toBe(volume);
    const largest = "9".repeat(CN_MINUTE_INTEGER_DIGITS);
    expect(
      normalizeEndpointVolume(raw({ volume: largest, sharesPerUnit: largest }))
        .volume,
    ).toBe((BigInt(largest) ** 2n).toString());
  });
  it("takes an explicit endpoint factor without falling back to an instrument order lot", () => {
    expect(normalizeEndpointVolume(raw({ sharesPerUnit: "200" })).volume).toBe(
      "400",
    );
    expect(normalizeEndpointVolume(raw({ volume: "0" })).volume).toBe("0");
    const { sharesPerUnit: _factor, ...missing } = raw();
    expect(() =>
      normalizeEndpointVolume(missing as ProviderEndpointVolume),
    ).toThrow("INVALID_ENDPOINT_VOLUME");
    expect(() =>
      normalizeEndpointVolume({
        ...missing,
        lotSize: 100,
      } as unknown as ProviderEndpointVolume),
    ).toThrow("INVALID_ENDPOINT_VOLUME");
  });
  it.each([
    { volume: 9007199254740992 },
    { volume: NaN },
    { volume: Infinity },
    { volume: "-1" },
    { volume: "2.5" },
    { volume: "1e10" },
    { volume: "" },
    { volume: " 2" },
    { volume: "9".repeat(CN_MINUTE_INTEGER_DIGITS + 1) },
    { sharesPerUnit: "100.0" },
    { sharesPerUnit: 100 },
    { sharesPerUnit: "9".repeat(CN_MINUTE_INTEGER_DIGITS + 1) },
    { kind: "normalizedShare" },
    { endpoint: "unknown" },
    { unit: "UNVERIFIED" },
  ])(
    "fails closed for malformed, unsafe or oversized input %#",
    (overrides) => {
      expect(() =>
        normalizeEndpointVolume({
          ...raw(),
          ...overrides,
        } as ProviderEndpointVolume),
      ).toThrow("INVALID_ENDPOINT_VOLUME");
    },
  );
  it.each([
    { sharesPerUnit: "0" },
    { unit: "SHARE", sharesPerUnit: "100" },
  ] as const)("rejects a contradictory factor %#", (overrides) => {
    expect(() => normalizeEndpointVolume(raw(overrides))).toThrow(
      "INVALID_ENDPOINT_FACTOR",
    );
  });
});

describe("CN clock labels, never accepted intervals", () => {
  it.each(["1m", "5m"] as const)(
    "preserves 15:00 seed and Trade closing labels at %s without creating a future bar",
    (period) => {
      for (const source of ["seed", "trade"] as const) {
        const label = labelCnMinuteTimestamp(time("15:00:00"), period, source);
        expect(label).toMatchObject({
          originalTimestamp: time("15:00:00"),
          classification: "CLOSE_BOUNDARY_LABEL",
          candidateLabelAt: time("15:00:00"),
          canonicalInterval: null,
          meaning: "UNKNOWN",
          finality: "UNKNOWN",
          calendar: "UNKNOWN",
        });
        expect(label.sdkLabelAt).toBe(
          source === "trade" ? time("15:00:00") : null,
        );
        expect(label).not.toHaveProperty("start");
        expect(label).not.toHaveProperty("end");
        expect(label).not.toHaveProperty("final");
      }
    },
  );
  it.each(["1m", "5m"] as const)(
    "uses only the Trade event-time timeout branch for %s",
    (period) => {
      for (const clock of [
        "15:00:00.001",
        "15:01:00",
        "15:05:00",
        "15:09:59.999",
      ]) {
        const trade = labelCnMinuteTimestamp(time(clock), period, "trade");
        expect(trade.originalTimestamp).toBe(time(clock));
        expect(trade.sdkLabelAt).toBe(time("15:00:00"));
        expect(trade.canonicalInterval).toBeNull();
        const seed = labelCnMinuteTimestamp(time(clock), period, "seed");
        expect(seed.classification).toBe("OUT_OF_SESSION");
        expect(seed.candidateLabelAt).toBeNull();
        expect(seed.sdkLabelAt).toBeNull();
      }
      expect(
        labelCnMinuteTimestamp(time("15:10:00"), period, "trade"),
      ).toMatchObject({ classification: "OUT_OF_SESSION", sdkLabelAt: null });
    },
  );
  it.each(["1m", "5m"] as const)(
    "11:30 and lunch never create a next bucket for %s",
    (period) => {
      for (const clock of [
        "11:30:00",
        "11:59:59",
        "12:00:00",
        "12:59:59.999",
      ]) {
        for (const source of ["seed", "trade"] as const)
          expect(
            labelCnMinuteTimestamp(time(clock), period, source),
          ).toMatchObject({
            classification: "MIDDAY_BREAK",
            candidateLabelAt: null,
            sdkLabelAt: null,
            canonicalInterval: null,
          });
      }
      expect(
        labelCnMinuteTimestamp(time("11:29:59"), period, "trade").sdkLabelAt,
      ).toBe(time(period === "1m" ? "11:29:00" : "11:25:00"));
      expect(
        labelCnMinuteTimestamp(time("13:00:00"), period, "trade").sdkLabelAt,
      ).toBe(time("13:00:00"));
    },
  );
  it("retains unaligned seed labels and classifies using Shanghai time without assuming trading dates", () => {
    expect(
      labelCnMinuteTimestamp(time("09:34:59"), "5m", "seed"),
    ).toMatchObject({
      originalTimestamp: time("09:34:59"),
      classification: "ORDINARY_CANDIDATE",
      candidateLabelAt: null,
      sdkLabelAt: null,
    });
    expect(
      labelCnMinuteTimestamp(time("09:34:59"), "5m", "trade").sdkLabelAt,
    ).toBe(time("09:30:00"));
    expect(
      labelCnMinuteTimestamp(time("09:30:00", "2026-10-11"), "1m", "trade"),
    ).toMatchObject({
      localDate: "2026-10-11",
      localClock: "09:30:00.000",
      classification: "ORDINARY_CANDIDATE",
      calendar: "UNKNOWN",
      canonicalInterval: null,
    });
    expect(
      labelCnMinuteTimestamp(time("00:01:00"), "1m", "trade"),
    ).toMatchObject({
      localDate: "2026-10-13",
      classification: "OUT_OF_SESSION",
    });
  });
  it.each([
    NaN,
    Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    8640000000000000,
  ])("rejects invalid/unsafe time %s", (timestamp) => {
    expect(() => labelCnMinuteTimestamp(timestamp, "1m", "seed")).toThrow(
      "INVALID_CN_TIMESTAMP",
    );
    expect(() => createCnMinuteSourcesCapture(timestamp)).toThrow(
      "INVALID_CN_TIMESTAMP",
    );
  });
  it("rejects unsupported period and source", () => {
    expect(() =>
      labelCnMinuteTimestamp(time("09:30:00"), "1D" as "1m", "seed"),
    ).toThrow("INVALID_CN_TIMESTAMP");
    expect(() =>
      labelCnMinuteTimestamp(time("09:30:00"), "1m", "mixed" as "seed"),
    ).toThrow("INVALID_CN_TIMESTAMP");
  });
});

describe("private source diagnostics", () => {
  it("keeps raw sources and independent unit candidates, rejects same-period overlap without deduplication", () => {
    const original = capture();
    original.seeds[0].samples.push(sample());
    const before = structuredClone(original);
    const result = diagnoseCnMinuteSources(original);
    assertUnknown(result);
    expect(result.capture).toEqual(before);
    expect(result.seedDiagnostics).toHaveLength(2);
    expect(result.seedDiagnostics[0]).toMatchObject({
      originalVolume: { volume: "1000", unit: "UNVERIFIED" },
      selectedUnit: null,
    });
    expect(result.seedDiagnostics[0].unitCandidates.SHARE.volume).toBe("1000");
    expect(result.seedDiagnostics[0].unitCandidates.LOT_100_SHARES.volume).toBe(
      "100000",
    );
    expect(result.tradeDiagnostics[0]).toMatchObject({
      originalVolume: { volume: "2", unit: "UNVERIFIED" },
      interpretation: "SDK_INTERPRETATION_NOT_VERIFIED",
      assumption: "SDK_CN_TRADE_BRANCH",
      conditionalShareEquivalent: { volume: "200" },
    });
    expect(result.overlaps).toEqual([
      {
        symbol: "600519.SH",
        period: "1m",
        labelAt: time("09:30:00"),
        seedReferences: [
          { seedIndex: 0, sampleIndex: 0 },
          { seedIndex: 0, sampleIndex: 1 },
        ],
        tradeReferences: [{ packetIndex: 0, tradeIndex: 0 }],
        decision: "REJECT_MERGE",
      },
    ]);
    expect(result.sourceMerge).toBe("REJECTED");
    expect(result.mixedSdkCandlesticks).toBe("REJECTED");
    expect(result.reasons).toContain("SOURCE_OVERLAP_MERGE_REJECTED");
    expect(result).not.toHaveProperty("bars");
    expect(original).toEqual(before);
    original.seeds[0].samples[0].volume = "1";
    expect(result.capture.seeds[0].samples[0].volume).toBe("1000");
  });
  it("cannot infer continuity when different sources do not overlap", () => {
    const input = capture();
    input.tradePackets[0].trades[0].timestamp = time("09:31:10");
    const result = diagnoseCnMinuteSources(input);
    expect(result.overlaps).toEqual([]);
    expect(result.reasons).toContain("NO_OVERLAP_DOES_NOT_PROVE_CONTINUITY");
    expect(result.sourceMerge).toBe("REJECTED");
    assertUnknown(result);
  });
  it("compares each requested period separately and keeps closing labels out of canonical intervals", () => {
    const input = capture();
    input.seeds = (["1m", "5m"] as const).map((period) => ({
      ...input.seeds[0],
      period,
      samples: [sample({ period, timestamp: time("15:00:00") })],
    }));
    input.tradePackets[0].trades[0].timestamp = time("15:09:59");
    input.tradePackets[0].receivedAt = time("16:00:00");
    const result = diagnoseCnMinuteSources(input);
    expect(result.counts.closingBoundaryLabels).toBe(4);
    expect(result.overlaps.map((item) => item.period)).toEqual(["1m", "5m"]);
    expect(
      result.seedDiagnostics.every(
        (item) => item.time.canonicalInterval === null,
      ),
    ).toBe(true);
    expect(
      result.tradeDiagnostics[0].times.every(
        (item) =>
          item.sdkLabelAt === time("15:00:00") &&
          item.canonicalInterval === null,
      ),
    ).toBe(true);
    expect(result.capture.tradePackets[0].trades[0].timestamp).toBe(
      time("15:09:59"),
    );
    assertUnknown(result);
  });
  it.each([
    ["600519.SH", 13],
    ["600519.SH", 14],
    ["688001.SH", 15],
    ["000001.SZ", 18],
    ["000001.SZ", 19],
    ["300001.SZ", 20],
    ["300001.SZ", 21],
  ] as const)(
    "permits only a conditional SDK interpretation for %s board %s",
    (symbol, securityBoard) => {
      const input = capture();
      input.seeds = [];
      input.instruments = [{ symbol, securityBoard }];
      input.tradePackets[0].symbol = symbol;
      const result = diagnoseCnMinuteSources(input);
      expect(
        result.tradeDiagnostics[0].conditionalShareEquivalent?.volume,
      ).toBe("200");
      expect(
        result.tradeDiagnostics[0].conditionalShareEquivalent?.unitVerification,
      ).toBe("UNVERIFIED");
      assertUnknown(result);
    },
  );
  it.each([null, 0, 16, 17, 18, 21, 26])(
    "does not infer a CN equity or scale volume from SH suffix with board %s",
    (securityBoard) => {
      const input = capture();
      input.instruments[0].securityBoard = securityBoard;
      const result = diagnoseCnMinuteSources(input);
      expect(result.tradeDiagnostics[0]).toMatchObject({
        instrumentKind: "UNKNOWN",
        interpretation: "UNKNOWN",
        assumption: null,
        conditionalShareEquivalent: null,
      });
      expect(result.reasons).toContain("INSTRUMENT_KIND_UNVERIFIED");
      expect(
        result.tradeDiagnostics[0].times.every(
          (time) => time.sdkLabelAt === null,
        ),
      ).toBe(true);
      expect(result.capture.tradePackets[0].trades[0].volume).toBe("2");
    },
  );
  it("does not infer a board when instrument metadata is absent", () => {
    const input = capture();
    input.instruments = [];
    expect(
      diagnoseCnMinuteSources(input).tradeDiagnostics[0]
        .conditionalShareEquivalent,
    ).toBeNull();
  });
  it.each([
    { tradeType: "U" },
    { tradeType: "correction" },
    { tradeSession: 1 },
    { tradeSession: 2 },
    { tradeSession: 3 },
  ])("preserves but does not interpret nonordinary Trade %#", (fields) => {
    const input = capture();
    Object.assign(input.tradePackets[0].trades[0], fields);
    const result = diagnoseCnMinuteSources(input);
    expect(result.tradeDiagnostics[0].conditionalShareEquivalent).toBeNull();
    expect(result.reasons).toContain("NON_ORDINARY_TRADE_UNINTERPRETED");
    expect(
      result.tradeDiagnostics[0].times.every(
        (time) => time.sdkLabelAt === null,
      ),
    ).toBe(true);
    expect(result.capture).toEqual(input);
  });
  it("retains receive order and event-time regressions without sorting or fabricating provider sequence", () => {
    const input = capture();
    input.tradePackets.push(structuredClone(input.tradePackets[0]));
    input.tradePackets[1].receivedAt = time("09:30:19");
    input.tradePackets[1].trades[0].timestamp = time("09:30:09");
    const result = diagnoseCnMinuteSources(input);
    expect(result.counts.receiveOrderRegressions).toBe(1);
    expect(result.receiveOrder).toMatchObject({
      meaning: "LOCAL_RECEIPT_ARRAY_ONLY",
      providerSequence: null,
      regressions: [
        {
          packetIndex: 1,
          previousReceivedAt: time("09:30:20"),
          receivedAt: time("09:30:19"),
        },
      ],
      eventTimeRegressions: [
        {
          packetIndex: 1,
          tradeIndex: 0,
          previousTimestamp: time("09:30:10"),
          timestamp: time("09:30:09"),
        },
      ],
    });
    expect(result.capture).toEqual(input);
    expect(result.tradeDiagnostics.map((entry) => entry.packetIndex)).toEqual([
      0, 1,
    ]);
    assertUnknown(result);
  });
  it("keeps future provider timestamps and raw prices without implying verified clock or finality", () => {
    const input = capture();
    input.tradePackets[0].trades[0].timestamp = time("15:01:00");
    const result = diagnoseCnMinuteSources(input);
    expect(result.capture).toEqual(input);
    expect(result.tradeDiagnostics[0].times[0].sdkLabelAt).toBe(
      time("15:00:00"),
    );
    expect(result.reasons).toContain("CLOCK_UNVERIFIED");
    assertUnknown(result);
  });
  it("reports empty and still-collecting evidence without manufacturing coverage", () => {
    const result = diagnoseCnMinuteSources(
      createCnMinuteSourcesCapture(time("09:00:00")),
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining(["CAPTURE_NOT_COMPLETE", "NO_SOURCE_SAMPLES"]),
    );
    expect(result.counts.trades).toBe(0);
    expect(result.capture.instruments).toEqual([]);
    assertUnknown(result);
  });
});

describe("capture validation and redacted summary", () => {
  it.each([
    (x: CnMinuteSourcesCapture) => {
      x.source = "unknown" as typeof x.source;
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].endpoint = "sdkMixedCandlesticks" as "candlesticks";
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples[0].period = "5m";
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples[0].symbol = "000001.SZ";
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples[0].finality = "CONFIRMED";
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples[0].volumeUnit = "SHARE" as "UNVERIFIED";
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples[0].adjustment = "FORWARD" as "RAW";
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples[0].high = "8";
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples[0].low = "11";
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples[0].volume = "2.5";
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples[0].close = "secret invalid price";
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets[0].providerSequence = "1" as unknown as null;
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets[0].trades[0].price = "0";
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets[0].trades[0].volume = "9".repeat(101);
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets[0].trades[0].volume =
        9007199254740992 as unknown as string;
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets[0].trades[0].timestamp = Number.MAX_SAFE_INTEGER + 1;
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets[0].trades[0].direction = 9;
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets[0].trades[0].tradeSession = 9;
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets[0].trades[0].tradeType = "x".repeat(33);
    },
    (x: CnMinuteSourcesCapture) => {
      x.instruments.push({ ...x.instruments[0] });
    },
    (x: CnMinuteSourcesCapture) => {
      delete x.completedAt;
    },
    (x: CnMinuteSourcesCapture) => {
      x.completedAt = x.startedAt - 1;
    },
    (x: CnMinuteSourcesCapture) => {
      Object.assign(x, { capability: "LIVE" });
    },
    (x: CnMinuteSourcesCapture) => {
      x.seeds[0].samples.push(...Array.from({ length: 60 }, () => sample()));
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets = Array.from(
        { length: CN_MINUTE_PACKET_LIMIT + 1 },
        () => x.tradePackets[0],
      );
    },
    (x: CnMinuteSourcesCapture) => {
      x.tradePackets[0].trades = Array.from(
        { length: CN_MINUTE_TRADE_LIMIT + 1 },
        () => x.tradePackets[0].trades[0],
      );
    },
    (x: CnMinuteSourcesCapture) => {
      const trades = Array.from(
        { length: CN_MINUTE_TRADE_LIMIT / 2 + 1 },
        () => x.tradePackets[0].trades[0],
      );
      x.tradePackets = [
        { ...x.tradePackets[0], trades },
        { ...x.tradePackets[0], trades },
      ];
    },
  ])("fails closed for invalid source capture %#", (mutate) => {
    const input = capture();
    mutate(input);
    expect(() => diagnoseCnMinuteSources(input)).toThrow(
      "INVALID_CN_SOURCE_CAPTURE",
    );
  });
  it("rejects missing arrays and unsupported symbols before iterating", () => {
    expect(() =>
      diagnoseCnMinuteSources(null as unknown as CnMinuteSourcesCapture),
    ).toThrow("INVALID_CN_SOURCE_CAPTURE");
    const input = capture();
    input.tradePackets[0].symbol = "AAPL.US";
    expect(() => diagnoseCnMinuteSources(input)).toThrow(
      "INVALID_CN_SOURCE_CAPTURE",
    );
  });
  it("projects only bounded counts and whitelisted reasons, irrespective of tampered private fields", () => {
    const result = diagnoseCnMinuteSources(capture());
    Object.assign(result, {
      liveEligible: true,
      capability: "LIVE_TICK",
      continuity: "VERIFIED",
      coverage: "VERIFIED",
      finality: "CONFIRMED",
      secret: "private-marker",
    });
    Object.assign(result.counts, {
      trades: Number.MAX_SAFE_INTEGER + 1,
      seedSamples: -1,
      tradePackets: Infinity,
      price: "private-marker",
    });
    result.reasons.push("private-marker" as (typeof result.reasons)[number]);
    const summary = summarizeCnMinuteSources(result);
    assertUnknown(summary);
    expect(summary.counts).toMatchObject({
      trades: 0,
      seedSamples: 0,
      tradePackets: 0,
      overlappingBuckets: 1,
    });
    const text = JSON.stringify(summary);
    for (const forbidden of [
      "600519",
      "09:30",
      "private-marker",
      "1000",
      "providerSequence",
      "originalVolume",
      "capture",
      "seedDiagnostics",
      "price",
    ])
      expect(text).not.toContain(forbidden);
    expect(summary.reasons).toContain("SOURCE_OVERLAP_MERGE_REJECTED");
  });
  it("keeps unknown statuses and malformed count containers fail-closed", () => {
    const result = {
      status: "private-marker",
      counts: "private-marker",
      reasons: ["private-marker"],
      schema: "private-marker",
    } as unknown as CnMinuteSourcesDiagnostic;
    const summary = summarizeCnMinuteSources(result);
    assertUnknown(summary);
    expect(summary.status).toBe("INCOMPLETE");
    expect(summary.reasons).toContain("INVALID_DIAGNOSTIC");
    expect(JSON.stringify(summary)).not.toContain("private-marker");
    expect(Object.values(summary.counts).every((value) => value === 0)).toBe(
      true,
    );
  });
});
