import { describe, expect, it } from "vitest";
import { auditPriceBasis } from "./price-basis-audit.js";
import { priceBasisFixture } from "./price-basis-fixture.js";

describe("cross-period price basis audit", () => {
  it.each(["US", "CN"] as const)(
    "adjusts daily shares and prices to unchanged target minutes in %s",
    (market) => {
      const f = priceBasisFixture(market),
        before = structuredClone(f);
      const r = auditPriceBasis(f);
      expect(r.status).toBe("CONSISTENT");
      if (r.status !== "CONSISTENT") return;
      expect(r).toMatchObject({
        comparedWindows: 1,
        synthetic: true,
        liveEligible: false,
        scope: "SELECTED_WINDOWS",
        basisAt: f.target.close,
      });
      expect(r.bars[0]).toMatchObject({
        open: "50",
        high: "52",
        low: "49",
        close: "51",
        volume: "2000",
        turnover: "101000",
        priceFactor: "0.5",
        volumeFactor: "2",
        rawClose: "102",
        rawVolume: "1000",
      });
      expect(
        r.bars
          .slice(1)
          .every((b) => b.priceFactor === "1" && b.volumeFactor === "1"),
      ).toBe(true);
      expect(new Set(r.bars.map((b) => b.adjustmentVersion)).size).toBe(1);
      expect(f).toEqual(before);
    },
  );
  it("handles reverse splits and leaves cash dividends and actual turnover unchanged", () => {
    const f = priceBasisFixture();
    f.dataset.actions[0].sharesAfter = "1";
    f.dataset.actions[0].sharesBefore = "5";
    f.dataset.actions.push({
      ...f.dataset.actions[0],
      id: "cash",
      kind: "CASH_DIVIDEND",
      sharesAfter: undefined,
      sharesBefore: undefined,
    });
    const r = auditPriceBasis(f);
    expect(r.status).toBe("CONSISTENT");
    expect(r.bars[0]).toMatchObject({
      close: "510",
      volume: "200",
      turnover: "101000",
      priceFactor: "5",
      volumeFactor: "0.2",
    });
  });
  it.each([
    ["coverage", "CORPORATE_ACTION_COVERAGE_UNKNOWN"],
    ["calendar", "CALENDAR_UNVERIFIED"],
    ["unfinished", "BAR_NOT_KNOWN_AT_CUTOFF"],
    ["late", "BAR_NOT_KNOWN_AT_CUTOFF"],
    ["units", "RAW_PRICE_VOLUME_REQUIRED"],
    ["adjusted", "RAW_PRICE_VOLUME_REQUIRED"],
    ["instrument", "BAR_INSTRUMENT_MISMATCH"],
    ["source", "MIXED_BAR_SOURCE"],
    ["synthetic", "MIXED_BAR_SOURCE"],
    ["duplicate", "DUPLICATE_BAR_WINDOW"],
    ["ohlc", "RAW_BAR_INVALID"],
    ["time", "RAW_BAR_INVALID"],
  ])("refuses %s without outputting partial adjusted bars", (kind, reason) => {
    const f = priceBasisFixture();
    if (kind === "coverage") f.dataset.coverage.through = f.target.close - 1;
    if (kind === "calendar") f.calendarDays[1].verified = false;
    if (kind === "unfinished") f.bars[1].final = false;
    if (kind === "late") f.bars[1].receivedAt = f.asOf + 1;
    if (kind === "units") f.bars[1].volumeUnit = "LOT" as "SHARE";
    if (kind === "adjusted") f.bars[1].adjustmentVersion = "adjusted";
    if (kind === "instrument") f.bars[1].instrumentId = "OTHER.US";
    if (kind === "source") f.bars[1].source = "other";
    if (kind === "synthetic") f.bars[1].synthetic = false;
    if (kind === "duplicate") f.bars.push({ ...f.bars[1] });
    if (kind === "ohlc") f.bars[1].low = "70";
    if (kind === "time") f.bars[1].time += 60;
    expect(auditPriceBasis(f)).toMatchObject({
      status: "UNKNOWN",
      reason,
      bars: [],
      liveEligible: false,
    });
  });
  it("rejects incomplete, shifted, mismatched or missing-turnover five-minute windows", () => {
    const f = priceBasisFixture();
    f.bars.splice(2, 1);
    expect(auditPriceBasis(f)).toMatchObject({ reason: "MISSING_MINUTE" });
    const g = priceBasisFixture();
    g.bars.at(-1)!.volume = "501";
    expect(auditPriceBasis(g)).toMatchObject({
      reason: "CROSS_PERIOD_VALUE_MISMATCH",
    });
    const h = priceBasisFixture();
    delete h.bars[1].turnover;
    expect(auditPriceBasis(h)).toMatchObject({
      reason: "TURNOVER_COMPARISON_UNAVAILABLE",
    });
    const j = priceBasisFixture();
    const b = j.bars.at(-1)!;
    b.start += 300000;
    b.end += 300000;
    b.time += 300;
    b.receivedAt += 300000;
    expect(auditPriceBasis(j)).toMatchObject({
      reason: "CROSS_PERIOD_WINDOW_MISMATCH",
    });
  });
  it("does not infer a scale for a future target or an action inside a historical bar/target session", () => {
    const f = priceBasisFixture();
    expect(auditPriceBasis({ ...f, asOf: f.target.close - 1 })).toMatchObject({
      reason: "TARGET_SESSION_NOT_COMPLETED",
    });
    f.dataset.actions[0].effectiveAt = f.previous.open + 60000;
    expect(auditPriceBasis(f)).toMatchObject({ reason: "ACTION_INSIDE_BAR" });
    f.dataset.actions[0].effectiveAt = f.target.open + 60000;
    expect(auditPriceBasis(f)).toMatchObject({
      reason: "TARGET_SESSION_SCALE_CHANGED",
    });
    f.dataset.actions[0].effectiveAt = f.target.close;
    expect(auditPriceBasis(f)).toMatchObject({
      reason: "TARGET_SESSION_SCALE_CHANGED",
    });
  });
  it("never lets a later action revision leak into the frozen audit", () => {
    const f = priceBasisFixture(),
      old = auditPriceBasis(f);
    f.dataset.actions.push({
      ...f.dataset.actions[0],
      revision: 2,
      sharesAfter: "4",
      receivedAt: f.asOf + 1,
    });
    expect(auditPriceBasis(f)).toEqual(old);
    f.dataset.actions.at(-1)!.receivedAt = f.asOf;
    const updated = auditPriceBasis(f);
    expect(updated.bars[0]).toMatchObject({ close: "25.5", volume: "4000" });
    expect(updated).not.toEqual(old);
  });
});
