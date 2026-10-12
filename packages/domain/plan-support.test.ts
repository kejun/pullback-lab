import { describe, expect, it } from "vitest";
import { freezeSupport, type SupportEvidence } from "./plan-support.js";
import { demoInstruments, generateDemoBars } from "../market-data/fixtures.js";
import type { SupportPreviewInput } from "../contracts/index.js";

const now = Date.parse("2026-10-12T10:00:00Z");
const instrument = demoInstruments[0];
const bars = generateDemoBars(instrument.id);
const input: SupportPreviewInput = {
  instrumentId: instrument.id,
  anchorTime: null,
  primarySupport: "100",
  supportSelections: [
    { source: "EMA9" },
    { source: "HORIZONTAL", id: "main", label: "人工支撑", price: "100" },
  ],
};
const evidence: SupportEvidence = {
  bars,
  synthetic: true,
  historyComplete: true,
  adjustmentVerified: true,
  dataRevision: "daily-revision",
  instrumentRevision: "rules-revision",
};
describe("frozen daily support evidence", () => {
  it("computes the server selected EMA and freezes decimal distances plus provenance", () => {
    const result = freezeSupport(
      input,
      instrument,
      evidence,
      now,
      "日线背景已确认",
    );
    expect(result.ready).toBe(true);
    expect(result.matchedFamilies).toEqual(["EMA", "HORIZONTAL"]);
    expect(result.lines[0].price).toMatch(/^99\.7/);
    expect(result.reference.close).toBe("101.00");
    expect(result.lines.every((line) => line.withinTolerance)).toBe(true);
    expect(result).toMatchObject({
      selectedAt: now,
      selectionReason: "日线背景已确认",
      baseInterval: "1D",
      priceFormula: "HLC3",
      priceBasis: "SPLIT_ADJUSTED",
      dataRevision: "daily-revision",
    });
  });
  it("counts three nearby EMAs as one family and never expands through adjacent lines", () => {
    const flat = bars.map((b) => ({
      ...b,
      open: "100",
      high: "101",
      low: "99",
      close: "100",
    }));
    const result = freezeSupport(
      {
        ...input,
        supportSelections: [
          { source: "EMA9" },
          { source: "EMA21" },
          { source: "EMA50" },
        ],
      },
      instrument,
      { ...evidence, bars: flat },
      now,
    );
    expect(result.matchedFamilies).toEqual(["EMA"]);
    expect(result.reasons).toContain("INSUFFICIENT_SUPPORT_FAMILIES");
    const chain = freezeSupport(
      {
        ...input,
        supportSelections: [
          { source: "EMA9" },
          { source: "HORIZONTAL", id: "far", price: "100.26", label: "far" },
        ],
      },
      instrument,
      { ...evidence, bars: flat },
      now,
    );
    expect(chain.lines[1].withinTolerance).toBe(false);
  });
  it("permits an incomplete preview but blocks missing ATR, unknown history and unknown adjustment evidence", () => {
    const short = freezeSupport(
      input,
      instrument,
      { ...evidence, bars: bars.slice(-10) },
      now,
    );
    expect(short.tolerance).not.toBeNull();
    expect(short.ready).toBe(false);
    expect(short.reasons).toContain("ATR_NOT_READY");
    const unknown = freezeSupport(
      input,
      instrument,
      { ...evidence, historyComplete: false, adjustmentVerified: false },
      now,
    );
    expect(unknown.reasons).toEqual(
      expect.arrayContaining([
        "DAILY_HISTORY_INCOMPLETE",
        "ADJUSTMENT_EVIDENCE_UNVERIFIED",
      ]),
    );
  });
  it("requires the chosen AVWAP anchor and keeps its daily HLC3 provenance", () => {
    const selected = {
      ...input,
      supportSelections: [
        { source: "AVWAP" as const },
        input.supportSelections[1],
      ],
    };
    expect(
      freezeSupport(selected, instrument, evidence, now).reasons,
    ).toContain("AVWAP_NOT_READY");
    const result = freezeSupport(
      { ...selected, anchorTime: bars.at(-2)!.time },
      instrument,
      evidence,
      now,
    );
    expect(result.anchorBarId).toBe(bars.at(-2)!.id);
    expect(result.lines[0].price).not.toBeNull();
    expect(result.lines[0].dataCutoff).toBe(bars.at(-1)!.receivedAt);
  });
  it("does not use an unfinished or not-yet-received daily candle", () => {
    const result = freezeSupport(
      input,
      instrument,
      {
        ...evidence,
        bars: [
          ...bars,
          {
            ...bars.at(-1)!,
            id: "future",
            time: bars.at(-1)!.time + 86400,
            receivedAt: now + 1,
            close: "1000",
          },
        ],
      },
      now,
    );
    expect(result.reference.close).toBe("101.00");
    expect(result.knownAt).toBeLessThan(now);
  });
  it("rejects duplicate selections instead of making them additional evidence", () => {
    expect(
      freezeSupport(
        {
          ...input,
          supportSelections: [
            ...input.supportSelections,
            input.supportSelections[0],
          ],
        },
        instrument,
        evidence,
        now,
      ).reasons,
    ).toContain("DUPLICATE_SUPPORT_SELECTION");
  });
});
