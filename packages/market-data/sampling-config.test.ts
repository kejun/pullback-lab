import { describe, expect, it } from "vitest";
import { parseMinuteSymbols } from "./sampling-config.js";

describe("explicit minute symbol selection", () => {
  it("defaults to disabled and normalizes a bounded mixed-market selection", () => {
    expect(parseMinuteSymbols(undefined)).toEqual([]);
    expect(parseMinuteSymbols("  ")).toEqual([]);
    expect(parseMinuteSymbols(" aapl.us, 600519.sh,000001.SZ ")).toEqual([
      "000001.SZ",
      "600519.SH",
      "AAPL.US",
    ]);
  });
  it.each([
    "AAPL",
    "AAPL.US,",
    "AAPL.US,aapl.us",
    "DEMO-A.US",
    "700.HK",
    "1.SH",
    "private-token=value",
    "A".repeat(513),
    Array.from({ length: 11 }, (_, i) => `A${i}.US`).join(","),
  ])("rejects invalid selection without echoing it", (value) => {
    expect(() => parseMinuteSymbols(value)).toThrow(/^INVALID_MINUTE_SYMBOLS$/);
  });
});
