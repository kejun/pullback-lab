import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Market } from "../contracts/index.js";
import {
  adjustForSplits,
  type AdjustmentDataset,
  type SplitAdjustedBar,
} from "./adjustments.js";
import {
  resolveSession,
  type CalendarDay,
  type MarketSession,
} from "./calendar.js";
import {
  aggregateFiveMinuteBars,
  normalizeBar,
  type NormalizedBar,
} from "./normalize.js";

const at = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const priceBasisRequestSchema = z
  .object({
    schema: z.literal("pullback-lab-price-basis-audit-v1"),
    instrumentId: id,
    market: z.enum(["US", "CN"]),
    asOf: at,
    evidenceVersion: z.string().regex(/^action-evidence-v1:[a-f0-9]{64}$/),
    receiptWatermark: at.refine((n) => n > 0),
    sequences: z
      .array(at.refine((n) => n > 0))
      .min(7)
      .max(10000),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    calendarDays: z
      .array(
        z
          .object({
            market: z.enum(["US", "CN"]),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            status: z.enum(["OPEN", "CLOSED"]),
            intervals: z
              .array(
                z
                  .object({
                    open: z.string().regex(/^\d{2}:\d{2}$/),
                    close: z.string().regex(/^\d{2}:\d{2}$/),
                  })
                  .strict(),
              )
              .max(4),
            source: z.string().trim().min(1).max(500),
            version: id,
            knownAt: at,
            verified: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict()
  .refine(
    (r) =>
      new Set(r.sequences).size === r.sequences.length &&
      r.sequences.every((n) => n <= r.receiptWatermark),
  );
export type PriceBasisRequest = z.infer<typeof priceBasisRequestSchema>;
export const PRICE_BASIS_AUDIT_VERSION =
  "price-basis-audit-v1/split-only-v2/decimal50";
export class PriceBasisAuditError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type PriceBasisResult =
  | {
      status: "CONSISTENT";
      scope: "SELECTED_WINDOWS";
      liveEligible: false;
      targetSession: MarketSession;
      basisAt: number;
      adjustmentVersion: string;
      knownAt: number;
      synthetic: boolean;
      comparedWindows: number;
      bars: SplitAdjustedBar[];
    }
  | {
      status: "UNKNOWN";
      scope: "SELECTED_WINDOWS";
      liveEligible: false;
      reason: string;
      bars: [];
    };
const bad = (reason: string): PriceBasisResult => ({
  status: "UNKNOWN",
  scope: "SELECTED_WINDOWS",
  liveEligible: false,
  reason,
  bars: [],
});
export const basisDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Algebraic audit of selected, completed windows. Never certifies source authenticity or live continuity. */
export function auditPriceBasis(input: {
  instrumentId: string;
  market: Market;
  asOf: number;
  targetDate: string;
  calendarDays: CalendarDay[];
  dataset: AdjustmentDataset;
  bars: NormalizedBar[];
}): PriceBasisResult {
  const { instrumentId, market, asOf, targetDate, calendarDays, dataset } =
    input;
  if (!Number.isSafeInteger(asOf) || asOf < 0)
    return bad("ADJUSTMENT_CUTOFF_INVALID");
  if (input.bars.length > 10000 || calendarDays.length > 1000)
    return bad("AUDIT_INPUT_LIMIT");
  const target = resolveSession(calendarDays, market, targetDate, asOf);
  if (!target.ok) return bad(target.reason);
  if (!target.session) return bad("TARGET_SESSION_CLOSED");
  const session = target.session;
  if (session.close > asOf) return bad("TARGET_SESSION_NOT_COMPLETED");
  const bars = [...input.bars].sort(
    (a, b) =>
      a.start - b.start ||
      (a.period < b.period ? -1 : a.period > b.period ? 1 : 0),
  );
  if (
    !bars.length ||
    new Set(bars.map((b) => b.source)).size !== 1 ||
    new Set(bars.map((b) => b.synthetic)).size !== 1
  )
    return bad("MIXED_BAR_SOURCE");
  if (bars.some((b) => b.instrumentId !== instrumentId || b.market !== market))
    return bad("BAR_INSTRUMENT_MISMATCH");
  if (new Set(bars.map((b) => `${b.period}:${b.start}`)).size !== bars.length)
    return bad("DUPLICATE_BAR_WINDOW");
  const sessions = new Map<string, MarketSession>();
  for (const date of new Set(
    calendarDays.filter((d) => d.market === market).map((d) => d.date),
  )) {
    const s = resolveSession(calendarDays, market, date, asOf);
    if (s.ok && s.session) sessions.set(s.session.id, s.session);
  }
  for (const b of bars) {
    const s = sessions.get(b.sessionId);
    if (!s) return bad("BAR_CALENDAR_UNVERIFIED");
    if (!b.final || b.receivedAt > asOf) return bad("BAR_NOT_KNOWN_AT_CUTOFF");
    if (b.adjustmentVersion !== "raw-v1" || b.volumeUnit !== "SHARE")
      return bad("RAW_PRICE_VOLUME_REQUIRED");
    if (b.time * 1000 !== b.start || !["1D", "1m", "5m"].includes(b.period))
      return bad("RAW_BAR_INVALID");
    if (b.period === "1D" ? b.end > session.open : b.sessionId !== session.id)
      return bad("BAR_OUTSIDE_AUDIT_WINDOW");
    try {
      // Revalidate persisted normalized prices, quantity units, finality and calendar alignment.
      normalizeBar(
        {
          ...b,
          providerRevision: b.revision,
          adjustment: "RAW",
          volumeUnit: "SHARE",
          providerSequence: b.providerSequence ?? undefined,
        },
        s,
      );
    } catch {
      return bad("RAW_BAR_INVALID");
    }
  }
  const adjusted = adjustForSplits(bars, dataset, asOf, session.close);
  if (!adjusted.ok) return bad(adjusted.reason);
  // Resolve only revisions that were actually known. A split inside a bar cannot be applied to its entire OHLC.
  const latest = new Map<string, AdjustmentDataset["actions"][number]>();
  for (const a of dataset.actions)
    if (
      a.receivedAt <= asOf &&
      a.publishedAt <= asOf &&
      (!latest.has(a.id) || a.revision > latest.get(a.id)!.revision)
    )
      latest.set(a.id, a);
  for (const a of latest.values())
    if (a.kind === "SPLIT") {
      if (a.effectiveAt > session.open && a.effectiveAt <= session.close)
        return bad("TARGET_SESSION_SCALE_CHANGED");
      if (bars.some((b) => b.start < a.effectiveAt && a.effectiveAt < b.end))
        return bad("ACTION_INSIDE_BAR");
    }
  const daily = bars.filter((b) => b.period === "1D");
  const minutes = bars.filter((b) => b.period === "1m");
  const five = bars.filter((b) => b.period === "5m");
  if (!daily.length || !minutes.length || !five.length)
    return bad("AUDIT_PERIOD_MISSING");
  const aggregate = aggregateFiveMinuteBars(minutes, session);
  if (aggregate.gaps.length) return bad(aggregate.gaps[0].reason);
  if (
    aggregate.bars.length !== five.length ||
    minutes.length !== five.length * 5
  )
    return bad("CROSS_PERIOD_WINDOW_MISMATCH");
  const fields = [
    "open",
    "high",
    "low",
    "close",
    "volume",
    "turnover",
  ] as const;
  for (const b of five) {
    const other = aggregate.bars.find((a) => a.start === b.start);
    if (!other) return bad("CROSS_PERIOD_WINDOW_MISMATCH");
    if (b.turnover === undefined || other.turnover === undefined)
      return bad("TURNOVER_COMPARISON_UNAVAILABLE");
    if (fields.some((f) => !new Decimal(b[f]!).eq(other[f]!)))
      return bad("CROSS_PERIOD_VALUE_MISMATCH");
  }
  return {
    status: "CONSISTENT",
    scope: "SELECTED_WINDOWS",
    liveEligible: false,
    targetSession: session,
    basisAt: session.close,
    adjustmentVersion: adjusted.version,
    knownAt: Math.max(
      adjusted.knownAt,
      ...bars.map((b) => b.receivedAt),
      ...calendarDays.filter((d) => d.knownAt <= asOf).map((d) => d.knownAt),
    ),
    synthetic: bars[0].synthetic,
    comparedWindows: five.length,
    bars: adjusted.bars,
  };
}
