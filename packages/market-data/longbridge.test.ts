import { afterEach, describe, it, expect, vi } from "vitest";
import type { QuoteContext } from "longbridge";
vi.mock("longbridge", () => ({
  AdjustType: { NoAdjust: 0 },
  Config: { fromApikey: vi.fn() },
  Market: { US: 1, CN: 3 },
  Period: { Day: 1000, Min_1: 1, Min_5: 4 },
  PushCandlestickMode: { Confirmed: 1 },
  QuoteContext: { new: vi.fn() },
  TradeSessions: { Intraday: 0 },
  NaiveDate: class {
    constructor(
      public year: number,
      public month: number,
      public day: number,
    ) {}
  },
}));
import { LongbridgeReadOnlyAdapter } from "./longbridge.js";
function candle(timestamp = Date.parse("2026-10-09T13:30:00Z")) {
  return {
    timestamp: new Date(timestamp),
    open: { toString: () => "100" },
    high: { toString: () => "102" },
    low: { toString: () => "99" },
    close: { toString: () => "101" },
    turnover: { toString: () => "10050" },
    volume: 100,
    tradeSession: 0,
  };
}
describe("SDK adapter read-only boundary", () => {
  it("requests raw regular-session candles, caches evidence without restamping, never infers finality", async () => {
    const candlesticks = vi.fn().mockResolvedValue([candle()]);
    let now = Date.parse("2026-10-09T13:31:01Z");
    const adapter = new LongbridgeReadOnlyAdapter(
      { candlesticks } as unknown as QuoteContext,
      () => now,
    );
    const first = await adapter.fetchBars("AAPL.US", "1m", 60);
    now += 1000;
    const second = await adapter.fetchBars("AAPL.US", "1m", 60);
    expect(candlesticks).toHaveBeenCalledWith("AAPL.US", 1, 60, 0, 0);
    expect(candlesticks).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      adjustment: "RAW",
      finality: "UNKNOWN",
      volumeUnit: "UNVERIFIED",
    });
    expect(adapter.capabilities().every((x) => x.level === "UNKNOWN")).toBe(
      true,
    );
  });
  it("rejects imprecise provider integer volumes and unsafely broad requests", async () => {
    const adapter = new LongbridgeReadOnlyAdapter({
      candlesticks: vi
        .fn()
        .mockResolvedValue([
          { ...candle(), volume: Number.MAX_SAFE_INTEGER + 1 },
        ]),
    } as unknown as QuoteContext);
    await expect(adapter.fetchBars("AAPL.US", "1m", 1001)).rejects.toThrow(
      "BAR_COUNT_OUT_OF_RANGE",
    );
    await expect(adapter.fetchBars("AAPL.US", "1m", 1)).rejects.toThrow(
      "PROVIDER_VOLUME_PRECISION_UNSAFE",
    );
    await expect(
      adapter.fetchQuotes(Array(11).fill("AAPL.US")),
    ).rejects.toThrow("QUOTE_SYMBOL_LIMIT");
  });
  it("pages daily history, requiring admission before every page", async () => {
    const historyCandlesticksByDate = vi.fn().mockResolvedValue([]),
      admit = vi.fn().mockResolvedValue(undefined);
    const adapter = new LongbridgeReadOnlyAdapter({
      historyCandlesticksByDate,
    } as unknown as QuoteContext);
    await adapter.fetchDailyHistory(
      "AAPL.US",
      "2026-01-01",
      "2026-04-10",
      admit,
    );
    expect(admit).toHaveBeenCalledTimes(2);
    expect(historyCandlesticksByDate).toHaveBeenCalledTimes(2);
    await expect(
      adapter.fetchDailyHistory("AAPL.US", "2026-02-30", "2026-04-10", admit),
    ).rejects.toThrow("INVALID_DATE");
  });
  it("preserves repeated and conflicting raw history payloads instead of timestamp overwrite", async () => {
    const first = candle(),
      changed = { ...candle(), volume: 101 };
    const historyCandlesticksByDate = vi
      .fn()
      .mockResolvedValueOnce([first, first])
      .mockResolvedValueOnce([changed]);
    const adapter = new LongbridgeReadOnlyAdapter(
      { historyCandlesticksByDate } as unknown as QuoteContext,
      () => 12345678900000,
    );
    const samples = await adapter.fetchDailyHistory(
      "AAPL.US",
      "2026-01-01",
      "2026-04-10",
      async () => {},
    );
    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.volume)).toEqual(["100", "100", "101"]);
    expect(
      samples.every(
        (s) => s.finality === "UNKNOWN" && s.volumeUnit === "UNVERIFIED",
      ),
    ).toBe(true);
    expect(
      historyCandlesticksByDate.mock.calls.every(
        (args) => args[1] === 1000 && args[2] === 0 && args[5] === 0,
      ),
    ).toBe(true);
  });
  it("bounds a single history page and rejects oversized provider responses", async () => {
    const historyCandlesticksByDate = vi
      .fn()
      .mockResolvedValue(Array(1001).fill(candle()));
    const adapter = new LongbridgeReadOnlyAdapter({
      historyCandlesticksByDate,
    } as unknown as QuoteContext);
    await expect(
      adapter.fetchDailyHistoryPage("AAPL.US", "2026-01-01", "2026-04-01"),
    ).rejects.toThrow("HISTORY_PAGE_OUT_OF_BOUNDS");
    expect(historyCandlesticksByDate).not.toHaveBeenCalled();
    await expect(
      adapter.fetchDailyHistoryPage("AAPL.US", "2026-01-01", "2026-03-31"),
    ).rejects.toThrow("HISTORY_PAGE_SAMPLE_LIMIT");
  });
  it("does not infer same-day selling or price tick rules from provider lot size", async () => {
    const adapter = new LongbridgeReadOnlyAdapter({
      staticInfo: vi.fn().mockResolvedValue([
        {
          symbol: "600519.SH",
          exchange: "SSE",
          currency: "CNY",
          lotSize: 100,
        },
      ]),
    } as unknown as QuoteContext);
    expect(await adapter.instrumentEvidence(["600519.SH"])).toEqual([
      {
        symbol: "600519.SH",
        exchange: "SSE",
        currency: "CNY",
        lotSize: 100,
        rulesVerified: false,
        securityBoard: null,
      },
    ]);
  });
});

afterEach(() => vi.useRealTimers());
function streamFixture() {
  let callback: Parameters<QuoteContext["setOnCandlestick"]>[0] = () => {};
  const subscribeCandlesticks = vi.fn(async () => []);
  const unsubscribeCandlesticks = vi.fn(async () => {});
  const ctx = {
    setOnCandlestick: vi.fn((next: typeof callback) => {
      callback = next;
    }),
    subscribeCandlesticks,
    unsubscribeCandlesticks,
  };
  const adapter = new LongbridgeReadOnlyAdapter(ctx as unknown as QuoteContext);
  const emit = (confirmed = true) =>
    callback(null, {
      symbol: "AAPL.US",
      data: { period: 1, candlestick: candle(), isConfirmed: confirmed },
    } as Parameters<typeof callback>[1]);
  return { adapter, ctx, emit, callback: () => callback };
}
describe("confirmed subscription lifecycle", () => {
  it("detaches callbacks, releases every subscription and freezes returned evidence", async () => {
    vi.useFakeTimers();
    const f = streamFixture();
    const result = f.adapter.observeConfirmed(
      ["AAPL.US", "600519.SH"],
      1000,
      20,
    );
    await vi.advanceTimersByTimeAsync(0);
    const oldCallback = f.callback();
    f.emit(true);
    f.emit(false);
    await vi.advanceTimersByTimeAsync(1000);
    const samples = await result;
    expect(samples.map((s) => s.finality)).toEqual(["CONFIRMED", "UNKNOWN"]);
    expect(f.ctx.unsubscribeCandlesticks.mock.calls).toEqual([
      ["AAPL.US", 1],
      ["600519.SH", 1],
    ]);
    oldCallback(null, {
      symbol: "AAPL.US",
      data: { period: 1, candlestick: candle(), isConfirmed: true },
    } as Parameters<typeof oldCallback>[1]);
    expect(samples).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up both confirmed and ambiguously failed subscriptions", async () => {
    const f = streamFixture();
    f.ctx.subscribeCandlesticks.mockRejectedValueOnce(
      new Error("provider failure"),
    );
    await expect(
      f.adapter.observeConfirmed(["AAPL.US"], 1000, 20),
    ).rejects.toThrow("provider failure");
    expect(f.ctx.unsubscribeCandlesticks).toHaveBeenCalledWith("AAPL.US", 1);
  });
  it("tries all cleanup calls even if one fails and does not report successful evidence", async () => {
    vi.useFakeTimers();
    const f = streamFixture();
    f.ctx.unsubscribeCandlesticks.mockRejectedValueOnce(
      new Error("cleanup private error"),
    );
    const assertion = expect(
      f.adapter.observeConfirmed(["AAPL.US", "600519.SH"], 1000, 20),
    ).rejects.toThrow("CANDLESTICK_CLEANUP_FAILED");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(f.ctx.unsubscribeCandlesticks).toHaveBeenCalledTimes(2);
    await expect(
      f.adapter.observeConfirmed(["AAPL.US"], 1000, 20),
    ).rejects.toThrow("OBSERVATION_ALREADY_RUNNING");
  });
  it("bounds subscribe timeout and compensates for a late acknowledgement", async () => {
    vi.useFakeTimers();
    const f = streamFixture();
    let complete!: (value: never[]) => void;
    f.ctx.subscribeCandlesticks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const assertion = expect(
      f.adapter.observeConfirmed(["AAPL.US", "600519.SH"], 1000, 20),
    ).rejects.toThrow("OPERATION_TIMEOUT");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(f.ctx.subscribeCandlesticks).toHaveBeenCalledTimes(1);
    expect(f.ctx.unsubscribeCandlesticks).toHaveBeenCalledTimes(1);
    complete([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.ctx.unsubscribeCandlesticks).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds hanging unsubscribe calls and ignores callback errors after cleanup", async () => {
    vi.useFakeTimers();
    const f = streamFixture();
    f.ctx.unsubscribeCandlesticks.mockImplementation(
      () => new Promise(() => {}),
    );
    const assertion = expect(
      f.adapter.observeConfirmed(["AAPL.US", "600519.SH"], 1000, 20),
    ).rejects.toThrow("CANDLESTICK_CLEANUP_FAILED");
    await vi.advanceTimersByTimeAsync(1020);
    await assertion;
    expect(f.ctx.unsubscribeCandlesticks).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not allow a second observer to overwrite the active callback", async () => {
    vi.useFakeTimers();
    const f = streamFixture();
    const first = f.adapter.observeConfirmed(["AAPL.US"], 1000, 20);
    await expect(
      f.adapter.observeConfirmed(["600519.SH"], 1000, 20),
    ).rejects.toThrow("OBSERVATION_ALREADY_RUNNING");
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(f.ctx.subscribeCandlesticks).toHaveBeenCalledTimes(1);
  });
  it("reports stream errors and rejects fractional or NaN observation bounds before subscribing", async () => {
    vi.useFakeTimers();
    const f = streamFixture();
    for (const duration of [NaN, 1000.5, Infinity])
      await expect(
        f.adapter.observeConfirmed(["AAPL.US"], duration),
      ).rejects.toThrow("OBSERVATION_BOUNDS_INVALID");
    const assertion = expect(
      f.adapter.observeConfirmed(["AAPL.US"], 1000, 20),
    ).rejects.toThrow("CANDLESTICK_STREAM_ERROR");
    await vi.advanceTimersByTimeAsync(0);
    f.callback()(new Error("stream private error"), undefined as never);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(f.ctx.unsubscribeCandlesticks).toHaveBeenCalledTimes(1);
  });
});

describe("unmixed minute endpoint requests", () => {
  it("fetches a fresh remote RAW minute seed without the fetchBars cache or SDK subscriber tail", async () => {
    const ctx = {
      candlesticks: vi.fn(async () => [candle()]),
      subscribeCandlesticks: vi.fn(),
    };
    const adapter = new LongbridgeReadOnlyAdapter(
      ctx as unknown as QuoteContext,
    );
    await adapter.fetchMinuteSeed("688008.SH", "1m", 60);
    await adapter.fetchMinuteSeed("688008.SH", "1m", 60);
    expect(ctx.candlesticks).toHaveBeenCalledTimes(2);
    expect(ctx.candlesticks).toHaveBeenCalledWith("688008.SH", 1, 60, 0, 0);
    expect(ctx.subscribeCandlesticks).not.toHaveBeenCalled();
    await expect(adapter.fetchMinuteSeed("NVDA.US", "1m", 60)).rejects.toThrow(
      "MINUTE_SEED_BOUNDS_INVALID",
    );
    await expect(
      adapter.fetchMinuteSeed("688008.SH", "1m", 61),
    ).rejects.toThrow("MINUTE_SEED_BOUNDS_INVALID");
  });
  it("retains static security board independently from order lot size", async () => {
    const adapter = new LongbridgeReadOnlyAdapter({
      staticInfo: vi.fn(async () => [
        {
          symbol: "688008.SH",
          exchange: "SSE",
          currency: "CNY",
          lotSize: 100,
          board: 15,
        },
      ]),
    } as unknown as QuoteContext);
    expect(await adapter.instrumentEvidence(["688008.SH"])).toMatchObject([
      { securityBoard: 15, lotSize: 100, rulesVerified: false },
    ]);
  });
});

describe("CN source probe through the production read-only SDK adapter", () => {
  it("keeps seed and trade quantities separate all the way to private diagnostics", async () => {
    vi.useFakeTimers();
    const { runMarketProbe } = await import("./probe.js");
    const { summarizeMarketProbe } = await import("./probe-summary.js");
    const at = Date.parse("2026-10-13T07:00:01Z");
    let tradeCallback: Parameters<QuoteContext["setOnTrades"]>[0] = () => {};
    const ctx = {
      quoteLevel: () => "LV1",
      quotePackageDetails: async () => [],
      staticInfo: async () => [
        {
          symbol: "688008.SH",
          exchange: "SSE",
          currency: "CNY",
          lotSize: 100,
          board: 15,
        },
      ],
      quote: async () => [
        {
          symbol: "688008.SH",
          lastDone: { toString: () => "101" },
          timestamp: new Date(at),
        },
      ],
      candlesticks: vi.fn(async () => [{ ...candle(at - 1000), volume: 1000 }]),
      tradingDays: async () => ({
        tradingDays: [{ toString: () => "2026-10-13" }],
        halfTradingDays: [],
      }),
      setOnTrades: (next: typeof tradeCallback) => {
        tradeCallback = next;
      },
      subscribe: vi.fn(async () => {
        tradeCallback(null, {
          symbol: "688008.SH",
          data: {
            trades: [
              {
                timestamp: new Date(at - 1000),
                price: { toString: () => "101" },
                volume: 2,
                tradeType: "",
                direction: 0,
                tradeSession: 0,
              },
            ],
          },
        } as Parameters<typeof tradeCallback>[1]);
      }),
      unsubscribe: vi.fn(async () => {}),
      subscribeCandlesticks: vi.fn(),
    };
    const adapter = new LongbridgeReadOnlyAdapter(
      ctx as unknown as QuoteContext,
      () => at,
    );
    const pending = runMarketProbe({
      symbols: ["688008.SH"],
      minuteSources: true,
      observeSeconds: 1,
      env: {
        LONGBRIDGE_APP_KEY: "fixture-only",
        LONGBRIDGE_APP_SECRET: "fixture-only",
        LONGBRIDGE_ACCESS_TOKEN: "fixture-only",
      },
      runtime: "v24.0.0",
      sdk: "5.2.0",
      platform: "linux",
      architecture: "x64",
      now: () => at,
      requestSpacingMs: 0,
      requestTimeoutMs: 20,
      checkpoint: () => {},
      adapterFactory: () => adapter,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const { report, exitCode } = await pending,
      diagnostic = report.minuteSourceDiagnostic!;
    expect(exitCode).toBe(2);
    expect(diagnostic.sourceMerge).toBe("REJECTED");
    expect(diagnostic.seedDiagnostics[0].unitCandidates.SHARE.volume).toBe(
      "1000",
    );
    expect(
      diagnostic.tradeDiagnostics[0].conditionalShareEquivalent?.volume,
    ).toBe("200");
    expect(diagnostic.overlaps).toHaveLength(2);
    expect(
      diagnostic.seedDiagnostics.every(
        (s) =>
          s.time.canonicalInterval === null && s.time.finality === "UNKNOWN",
      ),
    ).toBe(true);
    expect(diagnostic.counts.closingBoundaryLabels).toBe(4);
    expect(ctx.candlesticks).toHaveBeenCalledTimes(2);
    expect(ctx.subscribeCandlesticks).not.toHaveBeenCalled();
    expect(ctx.unsubscribe).toHaveBeenCalledWith(["688008.SH"], [3]);
    const summary = summarizeMarketProbe(report, exitCode, true);
    expect(summary.minuteSources).toMatchObject({
      liveEligible: false,
      counts: { overlappingBuckets: 2 },
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /conditionalShareEquivalent|"tradePackets":\[|originalVolume|fixture-only/,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("shares the observation ownership gate with confirmed mode and fences unsettled raw subscription", async () => {
  vi.useFakeTimers();
  const ctx = {
    setOnTrades: vi.fn(),
    subscribe: vi.fn(() => new Promise<void>(() => {})),
    unsubscribe: vi.fn(async () => {}),
    setOnCandlestick: vi.fn(),
    subscribeCandlesticks: vi.fn(),
  };
  const adapter = new LongbridgeReadOnlyAdapter(ctx as unknown as QuoteContext);
  const pending = adapter.observeTradeSources(["688008.SH"], 1000, 20);
  await expect(
    adapter.observeConfirmed(["688008.SH"], 1000, 20),
  ).rejects.toThrow("OBSERVATION_ALREADY_RUNNING");
  await vi.advanceTimersByTimeAsync(20);
  expect((await pending).reusable).toBe(false);
  await expect(
    adapter.observeTradeSources(["688008.SH"], 1000, 20),
  ).rejects.toThrow("OBSERVATION_ALREADY_RUNNING");
  expect(ctx.setOnCandlestick).not.toHaveBeenCalled();
  expect(ctx.subscribe).toHaveBeenCalledOnce();
});
