import { describe, it, expect, vi } from "vitest";
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
  it("does not infer same-day selling or price tick rules from provider lot size", async () => {
    const adapter = new LongbridgeReadOnlyAdapter({
      staticInfo: vi
        .fn()
        .mockResolvedValue([
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
      },
    ]);
  });
});
