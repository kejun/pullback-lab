import { describe, it, expect } from "vitest";
import {
  decimal,
  roundUpTick,
  roundDownTick,
  safeQuantity,
  D,
} from "./numeric.js";

describe("decimal boundary", () => {
  it("rejects binary floats, exponential notation and nonfinite values", () => {
    for (const value of [
      0.1,
      "1e3",
      "Infinity",
      "NaN",
      " 1",
      "1 ",
      "",
      "+1",
      "01",
      ".2",
      "1.",
    ])
      expect(() => decimal(value)).toThrow("INVALID_DECIMAL");
    expect(decimal("0.1").plus(decimal("0.2")).toFixed()).toBe("0.3");
  });
  it("rounds legal prices outward without binary drift", () => {
    expect(roundUpTick("0.300000000000000001", "0.01")).toBe("0.31");
    expect(roundDownTick("0.299999999999999999", "0.01")).toBe("0.29");
    expect(roundUpTick("99.75", "0.05")).toBe("99.75");
    expect(() => roundUpTick("1", "0")).toThrow();
  });
  it("allows Number only for safe whole-share counts", () => {
    expect(safeQuantity(new D("9007199254740991"))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => safeQuantity(new D("9007199254740992"))).toThrow(
      "UNSAFE_QUANTITY",
    );
    expect(() => safeQuantity(new D("0.5"))).toThrow("UNSAFE_QUANTITY");
  });
});
