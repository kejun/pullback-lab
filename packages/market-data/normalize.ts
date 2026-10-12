import Decimal from "decimal.js";
import type { Bar, Market } from "../contracts/index.js";
import type { MarketSession } from "./calendar.js";
import { isRegularInterval } from "./calendar.js";
const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });
export interface RawBar {
  id: string;
  instrumentId: string;
  market: Market;
  period: "1D" | "1m" | "5m";
  start: number;
  end: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover?: string;
  volumeUnit: "SHARE" | "LOT" | "UNKNOWN";
  lotSize?: number;
  final: boolean;
  receivedAt: number;
  source: string;
  providerRevision: string;
  sessionId: string;
  providerSequence?: string;
  adjustment: "RAW" | "UNKNOWN" | "FORWARD";
  synthetic?: boolean;
}
export interface NormalizedBar extends Bar {
  instrumentId: string;
  market: Market;
  period: RawBar["period"];
  start: number;
  end: number;
  source: string;
  revision: string;
  sessionId: string;
  providerSequence: string | null;
  volumeUnit: "SHARE";
  rawVolume: string;
  rawVolumeUnit: RawBar["volumeUnit"];
  historical: boolean;
  synthetic: boolean;
}
export class MarketDataError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "MarketDataError";
  }
}
function decimal(value: string, zero: boolean): string {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value))
    throw new MarketDataError("INVALID_DECIMAL");
  const n = new D(value);
  if (!n.isFinite() || n.lt(0) || (!zero && n.eq(0)))
    throw new MarketDataError("INVALID_DECIMAL");
  return n.toFixed();
}
export function normalizeBar(
  raw: RawBar,
  session: MarketSession,
): NormalizedBar {
  if (!raw.id || !raw.instrumentId || !raw.providerRevision || !raw.source)
    throw new MarketDataError("PROVENANCE_REQUIRED");
  if (raw.adjustment !== "RAW")
    throw new MarketDataError("PRICE_BASIS_UNVERIFIED");
  if (raw.volumeUnit === "UNKNOWN")
    throw new MarketDataError("VOLUME_UNIT_UNKNOWN");
  if (
    !Number.isSafeInteger(raw.start) ||
    !Number.isSafeInteger(raw.end) ||
    !Number.isSafeInteger(raw.receivedAt) ||
    raw.end <= raw.start
  )
    throw new MarketDataError("INVALID_TIME");
  if (session.id !== raw.sessionId || raw.market !== session.market)
    throw new MarketDataError("SESSION_MISMATCH");
  if (raw.period === "1D") {
    if (raw.start !== session.open || raw.end !== session.close)
      throw new MarketDataError("DAILY_SESSION_MISMATCH");
  } else {
    const duration = raw.period === "1m" ? 60_000 : 300_000;
    if (
      raw.end - raw.start !== duration ||
      !isRegularInterval(session, raw.start, raw.end) ||
      (raw.start - session.open) % duration !== 0
    )
      throw new MarketDataError("BAR_NOT_SESSION_ALIGNED");
  }
  if (raw.final && raw.receivedAt < raw.end)
    throw new MarketDataError("PREMATURE_FINAL_BAR");
  const open = decimal(raw.open, false),
    high = decimal(raw.high, false),
    low = decimal(raw.low, false),
    close = decimal(raw.close, false);
  if (
    new D(high).lt(D.max(open, close, low)) ||
    new D(low).gt(D.min(open, close, high))
  )
    throw new MarketDataError("INVALID_OHLC");
  let volume = new D(decimal(raw.volume, true));
  if (!volume.isInteger()) throw new MarketDataError("FRACTIONAL_RAW_VOLUME");
  if (raw.volumeUnit === "LOT") {
    if (!Number.isSafeInteger(raw.lotSize) || raw.lotSize! <= 0)
      throw new MarketDataError("LOT_SIZE_UNKNOWN");
    volume = volume.mul(raw.lotSize!);
  }
  return {
    id: raw.id,
    instrumentId: raw.instrumentId,
    market: raw.market,
    period: raw.period,
    start: raw.start,
    end: raw.end,
    time: raw.start / 1000,
    open,
    high,
    low,
    close,
    volume: volume.toFixed(),
    ...(raw.turnover === undefined
      ? {}
      : { turnover: decimal(raw.turnover, true) }),
    final: raw.final,
    receivedAt: raw.receivedAt,
    source: raw.source,
    revision: raw.providerRevision,
    sessionId: raw.sessionId,
    providerSequence: raw.providerSequence ?? null,
    volumeUnit: "SHARE",
    rawVolume: raw.volume,
    rawVolumeUnit: raw.volumeUnit,
    adjustmentVersion: "raw-v1",
    historical: raw.receivedAt > raw.end + 30_000,
    synthetic: raw.synthetic === true,
  };
}
export interface AggregationResult {
  bars: NormalizedBar[];
  gaps: Array<{ start: number; reason: string }>;
}
/** Never manufacture OHLC for missing/no-trade minutes; a verified native aggregate is a separate source. */
export function aggregateFiveMinuteBars(
  minutes: readonly NormalizedBar[],
  session: MarketSession,
): AggregationResult {
  const bars: NormalizedBar[] = [],
    gaps: AggregationResult["gaps"] = [];
  const byStart = new Map<number, NormalizedBar>();
  const duplicates = new Set<number>();
  for (const b of minutes) {
    if (byStart.has(b.start)) duplicates.add(b.start);
    byStart.set(b.start, b);
  }
  for (const interval of session.intervals) {
    for (
      let start = interval.start;
      start + 300_000 <= interval.end;
      start += 300_000
    ) {
      // No output for wholly future/unobserved buckets.
      if (!minutes.some((x) => x.start >= start && x.start < start + 300_000))
        continue;
      const children = Array.from({ length: 5 }, (_, i) =>
        byStart.get(start + i * 60_000),
      );
      let reason = "";
      if (children.some((x) => !x)) reason = "MISSING_MINUTE";
      else if (children.some((x) => duplicates.has(x!.start)))
        reason = "DUPLICATE_MINUTE_REVISION";
      else if (children.some((x) => !x!.final)) reason = "UNCONFIRMED_MINUTE";
      else if (
        children.some(
          (x) =>
            x!.period !== "1m" ||
            x!.end !== x!.start + 60_000 ||
            x!.sessionId !== session.id,
        )
      )
        reason = "MINUTE_SESSION_MISMATCH";
      else if (
        new Set(
          children.map(
            (x) =>
              `${x!.instrumentId}:${x!.source}:${x!.adjustmentVersion}:${x!.synthetic}`,
          ),
        ).size !== 1
      )
        reason = "MIXED_BAR_BASIS";
      if (reason) {
        gaps.push({ start, reason });
        continue;
      }
      const a = children as NormalizedBar[];
      const receivedAt = Math.max(...a.map((x) => x.receivedAt));
      bars.push({
        ...a[0],
        id: `agg5:${session.id}:${start}`,
        period: "5m",
        start,
        end: start + 300_000,
        time: start / 1000,
        open: a[0].open,
        close: a[4].close,
        high: D.max(...a.map((x) => new D(x.high))).toFixed(),
        low: D.min(...a.map((x) => new D(x.low))).toFixed(),
        volume: a.reduce((n, x) => n.add(x.volume), new D(0)).toFixed(),
        rawVolume: a.reduce((n, x) => n.add(x.volume), new D(0)).toFixed(),
        rawVolumeUnit: "SHARE",
        turnover: a.every((x) => x.turnover !== undefined)
          ? a.reduce((n, x) => n.add(x.turnover!), new D(0)).toFixed()
          : undefined,
        receivedAt,
        historical: a.some((x) => x.historical) || receivedAt > start + 330_000,
        revision: a.map((x) => x.revision).join("|"),
        providerSequence: null,
      });
    }
  }
  return { bars, gaps };
}
