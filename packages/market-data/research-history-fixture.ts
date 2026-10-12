import { priceBasisFixture } from "./price-basis-fixture.js";
/** Synthetic offline test data submitted through the manual-history contract. Never shipped as real quotes. */
export function researchHistoryFixture(market: "US" | "CN" = "US") {
  const f = priceBasisFixture(market);
  const instrumentId = market === "US" ? "US:HISTORY.US" : "CN:600123.SH";
  const {
    schema: _schema,
    instrumentId: _instrument,
    market: _market,
    expectedVersion: _expected,
    review: _review,
    documents,
    ...actions
  } = f.manifest;
  return {
    schema: "pullback-lab-research-history-v1" as const,
    instrumentId,
    source: "SYNTHETIC OFFLINE TEST ONLY",
    reviewer: "synthetic test fixture",
    targetDate: f.targetDate,
    calendarDays: f.calendarDays,
    corporateActions: {
      ...actions,
      documents: documents.map(({ sha256: _hash, ...doc }) => doc),
    },
    bars: f.bars.map((b) => ({
      id: b.id,
      period: b.period,
      sessionDate: b.period === "1D" ? f.previous.date : f.target.date,
      revision: b.revision,
      start: b.start,
      end: b.end,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      turnover: b.turnover!,
      volumeUnit: "SHARE" as const,
      final: true as const,
      adjustment: "RAW" as const,
    })),
  };
}
