import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { Bar } from "../contracts/index.js";
import type { MarketSession } from "./calendar.js";
const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });
const timestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;
const decimal = (value: unknown) =>
  typeof value === "string" && /^\d{1,30}(\.\d{1,20})?$/.test(value);
/** Stable provider content excludes the local receipt time. */
export function actionContent(a: CorporateAction): string {
  return JSON.stringify({
    id: a.id,
    revision: a.revision,
    kind: a.kind,
    effectiveAt: a.effectiveAt,
    publishedAt: a.publishedAt,
    source: a.source,
    sharesAfter: a.sharesAfter,
    sharesBefore: a.sharesBefore,
  });
}
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
  return adjustKnownSplits(bars, dataset, asOf, basisAt, false);
}
/**
 * Explicit server calendar projection: prices may target a future session open,
 * but publication/receipt knowledge is still cut off at the real asOf. This does
 * not prove that unannounced future actions cannot occur; the caller must retain
 * the reviewed coverage and invalidate it on any new evidence.
 */
export function adjustForScheduledSession(
  bars: readonly Bar[],
  dataset: AdjustmentDataset,
  asOf: number,
  session: MarketSession,
): AdjustmentResult {
  if (
    !timestamp(session.open) ||
    !timestamp(session.close) ||
    session.close <= session.open ||
    !session.source ||
    !session.calendarVersion
  )
    return { ok: false, bars: [], reason: "TARGET_SESSION_UNVERIFIED" };
  return adjustKnownSplits(bars, dataset, asOf, session.open, true);
}
function adjustKnownSplits(
  bars: readonly Bar[],
  dataset: AdjustmentDataset,
  asOf: number,
  basisAt: number,
  scheduled: boolean,
): AdjustmentResult {
  const bad = (reason: string): AdjustmentResult => ({
    ok: false,
    bars: [],
    reason,
  });
  if (!timestamp(asOf) || !timestamp(basisAt) || (!scheduled && basisAt > asOf))
    return bad("ADJUSTMENT_CUTOFF_INVALID");
  const c = dataset.coverage;
  if (bars.length > 10000 || dataset.actions.length > 5000)
    return bad("ADJUSTMENT_INPUT_LIMIT");
  const first = bars.length
    ? Math.min(...bars.map((x) => x.time * 1000))
    : basisAt;
  if (
    !c.verified ||
    !c.source ||
    !c.version ||
    ![c.from, c.through, c.knownAt].every(timestamp) ||
    c.through < c.from ||
    c.knownAt > asOf ||
    c.from > first ||
    c.through < basisAt
  )
    return bad("CORPORATE_ACTION_COVERAGE_UNKNOWN");
  if (
    bars.some(
      (x) => x.receivedAt > asOf || x.time * 1000 > Math.min(asOf, basisAt),
    )
  )
    return bad("BAR_NOT_KNOWN_AT_CUTOFF");
  if (bars.some((x) => x.adjustmentVersion !== "raw-v1"))
    return bad("RAW_PRICE_VOLUME_REQUIRED");
  if (
    bars.some(
      (x) =>
        !timestamp(x.time * 1000) ||
        !timestamp(x.receivedAt) ||
        x.receivedAt < x.time * 1000 ||
        !x.final ||
        ![x.open, x.high, x.low, x.close, x.volume].every(decimal) ||
        (x.turnover !== undefined && !decimal(x.turnover)),
    )
  )
    return bad("RAW_BAR_INVALID");
  if (
    bars.some(
      (x) =>
        new D(x.low).lte(0) ||
        new D(x.high).lt(x.low) ||
        new D(x.open).lt(x.low) ||
        new D(x.open).gt(x.high) ||
        new D(x.close).lt(x.low) ||
        new D(x.close).gt(x.high),
    )
  )
    return bad("RAW_BAR_INVALID");
  const latest = new Map<string, CorporateAction>();
  const revisions = new Map<string, string>();
  for (const a of dataset.actions) {
    if (
      ![a.effectiveAt, a.publishedAt, a.receivedAt].every(timestamp) ||
      a.receivedAt < a.publishedAt
    )
      return bad("ACTION_PROVENANCE_INVALID");
    if (a.publishedAt > asOf || a.receivedAt > asOf) continue;
    if (
      !a.source ||
      !a.id ||
      !Number.isSafeInteger(a.revision) ||
      a.revision < 1 ||
      !["SPLIT", "CASH_DIVIDEND"].includes(a.kind)
    )
      return bad("ACTION_PROVENANCE_INVALID");
    const key = JSON.stringify([a.id, a.revision]);
    const content = actionContent(a);
    if (revisions.has(key) && revisions.get(key) !== content)
      return bad("ACTION_REVISION_CONFLICT");
    revisions.set(key, content);
    const p = latest.get(a.id);
    if (
      !p ||
      a.revision > p.revision ||
      (a.revision === p.revision && a.receivedAt < p.receivedAt)
    )
      latest.set(a.id, a);
  }
  const eligible = [...latest.values()]
    .filter((x) => x.effectiveAt <= basisAt)
    .sort((a, b) => a.effectiveAt - b.effectiveAt || a.id.localeCompare(b.id));
  for (const a of eligible.filter((x) => x.kind === "SPLIT")) {
    if (
      !a.sharesAfter ||
      !a.sharesBefore ||
      !decimal(a.sharesAfter) ||
      !decimal(a.sharesBefore) ||
      new D(a.sharesAfter).lte(0) ||
      new D(a.sharesBefore).lte(0)
    )
      return bad("SPLIT_FACTOR_INVALID");
  }
  const version =
    "split-only-v2:" +
    createHash("sha256")
      .update(
        JSON.stringify({
          coverage: c.version,
          basisAt,
          actions: eligible.map((a) => [actionContent(a), a.receivedAt]),
        }),
      )
      .digest("hex")
      .slice(0, 20);
  const output: SplitAdjustedBar[] = [];
  for (const raw of bars) {
    let ratio = new D(1);
    for (const a of eligible)
      if (a.kind === "SPLIT" && raw.time * 1000 < a.effectiveAt) {
        ratio = ratio.mul(a.sharesAfter!).div(a.sharesBefore!);
        if (!ratio.isFinite() || ratio.lte(0) || Math.abs(ratio.e) > 100)
          return bad("ADJUSTMENT_FACTOR_OUT_OF_RANGE");
      }
    output.push({
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
    });
  }
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
