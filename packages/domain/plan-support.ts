import type {
  Instrument,
  SupportPreviewInput,
  SupportSnapshot,
} from "../contracts/index.js";
import {
  atr,
  avwap,
  ema,
  supportSnapshot,
  type IndicatorBar,
} from "./indicators.js";

/** Evidence is supplied by the server's data adapter, never by a plan request. */
export interface SupportEvidence {
  bars: readonly IndicatorBar[];
  historyComplete: boolean;
  adjustmentVerified: boolean;
  synthetic: boolean;
  dataRevision: string;
  instrumentRevision: string;
}

/** Freeze the exact selected supports against completed daily bars known at selection. */
export function freezeSupport(
  input: SupportPreviewInput,
  instrument: Instrument,
  evidence: SupportEvidence,
  selectedAt: number,
  reason = "",
): SupportSnapshot {
  const bars = evidence.bars.filter(
    (b) => b.final && b.receivedAt <= selectedAt,
  );
  const last = bars.at(-1);
  const reasons: string[] = [];
  if (!evidence.historyComplete || bars.length < 250)
    reasons.push("DAILY_HISTORY_INCOMPLETE");
  if (
    !evidence.adjustmentVerified ||
    bars.some((b) => b.adjustmentVerified !== true)
  )
    reasons.push("ADJUSTMENT_EVIDENCE_UNVERIFIED");
  if (!instrument.rulesVerified) reasons.push("INSTRUMENT_RULES_UNVERIFIED");
  const anchorIndex = bars.findIndex((b) => b.time === input.anchorTime);
  let atr14: string | null = null;
  const values: Record<string, string | null> = {};
  try {
    atr14 = atr(bars).at(-1) ?? null;
    for (const period of [9, 21, 50])
      values[`EMA${period}`] =
        ema(
          bars.map((b) => b.close),
          period,
        ).at(-1) ?? null;
    // AVWAP requires explicit price/volume provenance; unknown data is not a price.
    values.AVWAP =
      anchorIndex >= 0 && evidence.adjustmentVerified
        ? (avwap(bars, anchorIndex).at(-1) ?? null)
        : null;
  } catch {
    reasons.push("DAILY_SERIES_INVALID");
  }
  const identities = input.supportSelections.map((s) =>
    s.source === "HORIZONTAL" ? `HORIZONTAL:${s.id}` : s.source,
  );
  if (new Set(identities).size !== identities.length)
    reasons.push("DUPLICATE_SUPPORT_SELECTION");
  const lines: SupportSnapshot["lines"] = input.supportSelections.map(
    (selection, i) => {
      const horizontal = selection.source === "HORIZONTAL";
      const price = horizontal
        ? selection.price
        : (values[selection.source] ?? null);
      if (price === null) reasons.push(`${selection.source}_NOT_READY`);
      return {
        id: identities[i],
        source: selection.source,
        family: horizontal
          ? "HORIZONTAL"
          : selection.source === "AVWAP"
            ? "AVWAP"
            : "EMA",
        label: horizontal ? selection.label : selection.source,
        price,
        distance: null,
        withinTolerance: false,
        reasons: price === null ? [`${selection.source}_NOT_READY`] : [],
        dataCutoff: horizontal ? selectedAt : (last?.receivedAt ?? null),
      };
    },
  );
  let tolerance: string | null = null,
    suggestedLower: string | null = null,
    suggestedUpper: string | null = null;
  let matchedFamilies: SupportSnapshot["matchedFamilies"] = [];
  if (last) {
    try {
      const preview = supportSnapshot({
        primary: input.primarySupport,
        previousClose: last.close,
        tick: instrument.tick,
        atr14,
        supports: lines
          .filter((s) => s.price !== null)
          .map((s) => ({ id: s.id, price: s.price!, family: s.family })),
      });
      tolerance = preview.tau;
      suggestedLower = preview.lower;
      suggestedUpper = preview.upper;
      matchedFamilies = preview.families;
      reasons.push(...preview.reasons);
      for (const line of lines) {
        const distance = preview.distances.find((d) => d.id === line.id);
        if (distance) {
          line.distance = distance.distance;
          line.withinTolerance = distance.within;
        }
      }
    } catch {
      reasons.push("SUPPORT_INPUT_INVALID");
    }
  } else reasons.push("PREVIOUS_DAILY_BAR_MISSING", "ATR_NOT_READY");
  const uniqueReasons = [...new Set(reasons)];
  return {
    schemaVersion: 2,
    status: uniqueReasons.length ? "INCOMPLETE" : "READY",
    ready: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    selectedAt,
    selectionReason: reason,
    primarySupport: input.primarySupport,
    anchorTime: input.anchorTime,
    anchorBarId: anchorIndex >= 0 ? bars[anchorIndex].id : null,
    baseInterval: "1D",
    priceFormula: "HLC3",
    priceBasis: "SPLIT_ADJUSTED",
    session: "REGULAR",
    reference: {
      previousDailyBarId: last?.id ?? null,
      previousDailyTime: last?.time ?? null,
      close: last?.close ?? null,
      atr14,
      tick: instrument.tick,
    },
    tolerance,
    suggestedLower,
    suggestedUpper,
    lines,
    matchedFamilies,
    adjustmentVersion: last?.adjustmentVersion ?? null,
    dataRevision: evidence.dataRevision,
    instrumentRevision: evidence.instrumentRevision,
    seedStart: bars[0]?.time ?? null,
    knownAt: bars.length ? Math.max(...bars.map((b) => b.receivedAt)) : null,
    synthetic: evidence.synthetic,
  };
}
