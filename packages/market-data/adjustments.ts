import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { Bar } from "../contracts/index.js";
const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });
export interface CorporateAction {
  id: string;
  revision: number;
  kind: "SPLIT" | "CASH_DIVIDEND";
  effectiveAt: number;
  publishedAt: number;
  receivedAt: number;
  source: string;
  sharesAfter?: string;
  sharesBefore?: string;
}
export interface ActionCoverage {
  from: number;
  through: number;
  knownAt: number;
  verified: boolean;
  source: string;
  version: string;
}
export interface AdjustmentDataset {
  actions: CorporateAction[];
  coverage: ActionCoverage;
}
export interface SplitAdjustedBar extends Bar {
  raw: Bar;
  priceFactor: string;
  volumeFactor: string;
  adjustmentVerified: true;
  rawClose: string;
  rawVolume: string;
  rawTurnover?: string;
}
export type AdjustmentResult =
  | {
      ok: true;
      bars: SplitAdjustedBar[];
      version: string;
      knownAt: number;
      ignoredCashDividends: number;
    }
  | { ok: false; bars: []; reason: string };
/** The caller supplies both knowledge cutoff and price basis cutoff. Later received revisions cannot leak into replay. */
export function adjustForSplits(
  bars: readonly Bar[],
  dataset: AdjustmentDataset,
  asOf: number,
  basisAt: number,
): AdjustmentResult {
  const bad = (reason: string): AdjustmentResult => ({
    ok: false,
    bars: [],
    reason,
  });
  if (
    !Number.isSafeInteger(asOf) ||
    !Number.isSafeInteger(basisAt) ||
    basisAt > asOf
  )
    return bad("ADJUSTMENT_CUTOFF_INVALID");
  const c = dataset.coverage;
  const first = bars.length
    ? Math.min(...bars.map((x) => x.time * 1000))
    : basisAt;
  if (
    !c.verified ||
    !c.source ||
    !c.version ||
    c.knownAt > asOf ||
    c.from > first ||
    c.through < basisAt
  )
    return bad("CORPORATE_ACTION_COVERAGE_UNKNOWN");
  if (bars.some((x) => x.receivedAt > asOf || x.time * 1000 > basisAt))
    return bad("BAR_NOT_KNOWN_AT_CUTOFF");
  if (bars.some((x) => x.adjustmentVersion !== "raw-v1"))
    return bad("RAW_PRICE_VOLUME_REQUIRED");
  const latest = new Map<string, CorporateAction>();
  for (const a of dataset.actions) {
    if (a.publishedAt > asOf || a.receivedAt > asOf) continue;
    if (
      !a.source ||
      !a.id ||
      !Number.isSafeInteger(a.revision) ||
      a.revision < 1
    )
      return bad("ACTION_PROVENANCE_INVALID");
    const p = latest.get(a.id);
    if (p?.revision === a.revision && JSON.stringify(p) !== JSON.stringify(a))
      return bad("ACTION_REVISION_CONFLICT");
    if (!p || a.revision > p.revision) latest.set(a.id, a);
  }
  const eligible = [...latest.values()]
    .filter((x) => x.effectiveAt <= basisAt)
    .sort((a, b) => a.effectiveAt - b.effectiveAt || a.id.localeCompare(b.id));
  for (const a of eligible.filter((x) => x.kind === "SPLIT")) {
    if (
      !a.sharesAfter ||
      !a.sharesBefore ||
      !/^\d+(\.\d+)?$/.test(a.sharesAfter) ||
      !/^\d+(\.\d+)?$/.test(a.sharesBefore) ||
      new D(a.sharesAfter).lte(0) ||
      new D(a.sharesBefore).lte(0)
    )
      return bad("SPLIT_FACTOR_INVALID");
  }
  const version =
    "split-only-v1:" +
    createHash("sha256")
      .update(
        JSON.stringify({ coverage: c.version, basisAt, actions: eligible }),
      )
      .digest("hex")
      .slice(0, 20);
  const output = bars.map((raw) => {
    let ratio = new D(1);
    for (const a of eligible)
      if (a.kind === "SPLIT" && raw.time * 1000 < a.effectiveAt)
        ratio = ratio.mul(a.sharesAfter!).div(a.sharesBefore!);
    return {
      ...raw,
      open: new D(raw.open).div(ratio).toFixed(),
      high: new D(raw.high).div(ratio).toFixed(),
      low: new D(raw.low).div(ratio).toFixed(),
      close: new D(raw.close).div(ratio).toFixed(),
      volume: new D(raw.volume).mul(ratio).toFixed(),
      adjustmentVersion: version,
      raw: { ...raw },
      adjustmentVerified: true as const,
      rawClose: raw.close,
      rawVolume: raw.volume,
      rawTurnover: raw.turnover,
      priceFactor: new D(1).div(ratio).toFixed(),
      volumeFactor: ratio.toFixed(),
    };
  });
  return {
    ok: true,
    bars: output,
    version,
    knownAt: Math.max(
      c.knownAt,
      ...eligible.map((x) => Math.max(x.publishedAt, x.receivedAt)),
    ),
    ignoredCashDividends: eligible.filter((x) => x.kind === "CASH_DIVIDEND")
      .length,
  };
}
