import { describe, expect, it } from "vitest";
import {
  chartSafePrice,
  dragCoordinate,
  pointPriceProposal,
} from "../apps/web/src/chart-price";

describe("chart price proposals", () => {
  it("preserves chart proposals without pretending to normalize their tick", () => {
    expect(pointPriceProposal(100.123456789, "0.01")).toEqual({
      kind: "POINT",
      displayPrice: "100.123456789",
    });
    expect(chartSafePrice("100.123456789", "0.01")).toBe(100.123456789);
    expect(pointPriceProposal(0.00000012, "0.00000001")).toEqual({
      kind: "POINT",
      displayPrice: "0.00000012",
    });
  });
  it("rejects non-positive, non-finite, and sub-tick floating point distortion", () => {
    for (const price of [
      "0",
      "-1",
      "NaN",
      "Infinity",
      "no-price",
      "9007199254740993",
      "1000000000000.00000001",
    ]) {
      expect(chartSafePrice(price, "0.00000001")).toBeNull();
    }
    for (const tick of ["0", "-0.01", "NaN", "no-tick"])
      expect(chartSafePrice("100", tick)).toBeNull();
    expect(pointPriceProposal(Infinity, "0.01")).toBeNull();
    expect(pointPriceProposal(null, "0.01")).toBeNull();
    expect(pointPriceProposal(1e300, "0.01")).toBeNull();
  });
  it("retains the grab offset and rejects pointer escape rather than clamping a new price", () => {
    expect(dragCoordinate(200, 100, 10, 400)).toBe(90);
    expect(dragCoordinate(190, 100, 10, 400)).toBe(80);
    expect(dragCoordinate(109, 100, 10, 400)).toBeNull();
    expect(dragCoordinate(511, 100, 10, 400)).toBeNull();
    expect(dragCoordinate(110, 100, 10, 400)).toBe(0);
    expect(dragCoordinate(510, 100, 10, 400)).toBe(400);
    expect(dragCoordinate(NaN, 100, 10, 400)).toBeNull();
  });
});
