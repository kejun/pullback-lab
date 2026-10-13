import { describe, expect, it } from "vitest";
import type { Bar } from "../contracts/index.js";
import { adjustForSplits, type AdjustmentDataset } from "./adjustments.js";

// Arithmetic vectors based on documented corporate-action ratios, not actual provider/host acceptance.
// Sources and legal/trading dates: docs/production-market.md. OHLC here is deliberately illustrative.
const raw: Bar = {
  id: "arithmetic-only",
  time: 1,
  open: "100",
  high: "110",
  low: "90",
  close: "100",
  volume: "57603989",
  turnover: "123456789",
  final: true,
  receivedAt: 2000,
  adjustmentVersion: "raw-v1",
};
function dataset(after: string, before: string): AdjustmentDataset {
  return {
    coverage: {
      from: 0,
      through: 4000,
      knownAt: 2000,
      verified: true,
      source: "isolated-arithmetic",
      version: "fixture",
    },
    actions: [
      {
        id: "documented-ratio-arithmetic",
        revision: 1,
        kind: "SPLIT",
        effectiveAt: 3000,
        publishedAt: 1900,
        receivedAt: 2000,
        source: "isolated-arithmetic",
        sharesAfter: after,
        sharesBefore: before,
      },
    ],
  };
}
describe("documented action ratio arithmetic, not source acceptance", () => {
  it("NVDA 10:1 preserves turnover and multiplies original shares by ten", () => {
    const result = adjustForSplits([raw], dataset("10", "1"), 4000, 4000);
    expect(result.ok).toBe(true);
    expect(result.bars[0]).toMatchObject({
      open: "10",
      volume: "576039890",
      turnover: "123456789",
    });
  });
  it("SPCE 1:20 preserves fractional adjusted share volume without rounding to the vendor ForwardAdjust integer", () => {
    const result = adjustForSplits([raw], dataset("1", "20"), 4000, 4000);
    expect(result.ok).toBe(true);
    expect(result.bars[0]).toMatchObject({
      open: "2000",
      volume: "2880199.45",
      turnover: "123456789",
    });
  });
  it("CATL 10-to-18 splits shares without mixing the cash distribution into the ratio", () => {
    const d = dataset("18", "10");
    d.actions.push({
      id: "cash",
      revision: 1,
      kind: "CASH_DIVIDEND",
      effectiveAt: 3000,
      publishedAt: 1900,
      receivedAt: 2000,
      source: "isolated-arithmetic",
    });
    const result = adjustForSplits(
      [
        {
          ...raw,
          open: "180",
          high: "198",
          low: "162",
          close: "180",
          volume: "10000",
        },
      ],
      d,
      4000,
      4000,
    );
    expect(result.ok).toBe(true);
    expect(result.bars[0]).toMatchObject({
      open: "100",
      volume: "18000",
      turnover: "123456789",
    });
  });
  it("a Moutai-style cash-only distribution changes neither split-only prices, shares nor actual turnover", () => {
    const d = dataset("1", "1");
    d.actions = [
      {
        id: "cash-only",
        revision: 1,
        kind: "CASH_DIVIDEND",
        effectiveAt: 3000,
        publishedAt: 1900,
        receivedAt: 2000,
        source: "isolated-arithmetic",
      },
    ];
    const result = adjustForSplits([raw], d, 4000, 4000);
    expect(result.ok).toBe(true);
    expect(result.bars[0]).toMatchObject({
      open: raw.open,
      volume: raw.volume,
      turnover: raw.turnover,
    });
  });
});
