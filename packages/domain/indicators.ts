import type {
  Bar,
  Candidate,
  Indicators,
  Instrument,
} from "../contracts/index.js";
import {
  D,
  decimal,
  nonNegative,
  positive,
  roundDownTick,
  roundUpTick,
  str,
  type Dec,
} from "./numeric.js";

/** Raw quantities are shares. A lot-based source must explicitly supply sharesPerUnit. */
export interface IndicatorBar extends Bar {
  rawClose?: string;
  rawVolume?: string;
  raw?: Bar;
  sharesPerUnit?: string;
  adjustmentVerified?: boolean;
}
export interface IndicatorOptions {
  historyComplete?: boolean;
  ordinaryShare?: boolean;
  suspended?: boolean;
  requiredHistory?: number;
  date?: string;
  /** Only explicitly unadjusted data may use close/volume as raw turnover inputs. */
  unadjusted?: boolean;
}
export const INDICATOR_VERSION =
  "screening-v1/decimal64/ema-sma-seed/atr-wilder";
const empty = (): Indicators => ({
  r1: null,
  r3: null,
  r30: null,
  adv20: null,
  adr20: null,
  tight3: null,
  ema9: null,
  ema21: null,
  ema50: null,
  atr14: null,
  estimatedTurnover: false,
  screeningReady: false,
});
function periodCheck(period: number) {
  if (!Number.isSafeInteger(period) || period < 1)
    throw new Error("INVALID_PERIOD");
}
function barCheck(bar: Bar) {
  const h = positive(bar.high, "high"),
    l = positive(bar.low, "low"),
    c = positive(bar.close, "close"),
    o = positive(bar.open, "open");
  nonNegative(bar.volume, "volume");
  if (h.lt(l) || c.lt(l) || c.gt(h) || o.lt(l) || o.gt(h))
    throw new Error("INVALID_OHLC");
  if (!Number.isSafeInteger(bar.time)) throw new Error("INVALID_BAR_TIME");
}
function validateSeries(bars: readonly Bar[]) {
  let previous: number | undefined;
  const adjustment = bars[0]?.adjustmentVersion;
  for (const bar of bars) {
    barCheck(bar);
    if (previous !== undefined && bar.time <= previous)
      throw new Error("UNORDERED_OR_DUPLICATE_BARS");
    if (bar.adjustmentVersion !== adjustment)
      throw new Error("MIXED_ADJUSTMENT_VERSION");
    previous = bar.time;
  }
}
export function ema(
  closes: readonly string[],
  period: number,
): (string | null)[] {
  periodCheck(period);
  const values = closes.map((v) => positive(v, "close"));
  let current: Dec | undefined;
  const alpha = new D(2).div(period + 1);
  return values.map((value, index) => {
    if (index < period - 1) return null;
    current =
      index === period - 1
        ? values
            .slice(0, period)
            .reduce((a, b) => a.plus(b), new D(0))
            .div(period)
        : current!.plus(alpha.mul(value.minus(current!)));
    return str(current);
  });
}
export function trueRanges(bars: readonly Bar[]): (string | null)[] {
  validateSeries(bars);
  return bars.map((bar, index) =>
    index === 0
      ? null
      : str(
          D.max(
            decimal(bar.high).minus(bar.low),
            decimal(bar.high)
              .minus(bars[index - 1].close)
              .abs(),
            decimal(bar.low)
              .minus(bars[index - 1].close)
              .abs(),
          ),
        ),
  );
}
export function atr(bars: readonly Bar[], period = 14): (string | null)[] {
  periodCheck(period);
  const tr = trueRanges(bars);
  let current: Dec | undefined;
  return tr.map((value, index) => {
    if (index < period) return null;
    current =
      index === period
        ? tr
            .slice(1, period + 1)
            .reduce<Dec>((a, b) => a.plus(b!), new D(0))
            .div(period)
        : current!
            .mul(period - 1)
            .plus(value!)
            .div(period);
    return str(current);
  });
}
/** Percentage, unlike returns and Tight3 which are unit fractions. */
export function adr(bars: readonly Bar[], period = 20): string | null {
  periodCheck(period);
  if (bars.length < period) return null;
  const window = bars.slice(-period);
  validateSeries(window);
  return str(
    window
      .reduce(
        (a, b) => a.plus(decimal(b.high).minus(b.low).div(b.low)),
        new D(0),
      )
      .div(period)
      .mul(100),
  );
}
export function returnOver(
  closes: readonly string[],
  sessions: number,
): string | null {
  periodCheck(sessions);
  if (closes.length <= sessions) return null;
  return str(
    positive(closes.at(-1), "close")
      .div(positive(closes[closes.length - 1 - sessions], "priorClose"))
      .minus(1),
  );
}
export function averageTurnover(
  bars: readonly IndicatorBar[],
  period = 20,
  unadjusted = false,
): { value: string | null; estimated: boolean; reason?: string } {
  periodCheck(period);
  if (bars.length < period)
    return {
      value: null,
      estimated: false,
      reason: "INSUFFICIENT_TURNOVER_HISTORY",
    };
  const window = bars.slice(-period);
  validateSeries(window);
  const estimated = window.some((b) => b.turnover === undefined);
  try {
    const values = window.map((b) => {
      if (!estimated) return nonNegative(b.turnover, "turnover");
      // A partially missing window uses the same raw-price estimate for EVERY day.
      const close =
        b.rawClose ?? b.raw?.close ?? (unadjusted ? b.close : undefined);
      const volume =
        b.rawVolume ?? b.raw?.volume ?? (unadjusted ? b.volume : undefined);
      return positive(close, "rawClose")
        .mul(nonNegative(volume, "rawVolume"))
        .mul(positive(b.sharesPerUnit ?? "1", "sharesPerUnit"));
    });
    return {
      value: str(values.reduce((a, b) => a.plus(b), new D(0)).div(period)),
      estimated,
    };
  } catch {
    return {
      value: null,
      estimated,
      reason: "RAW_TURNOVER_INPUT_MISSING_OR_INVALID",
    };
  }
}
export function calculateIndicators(
  bars: readonly IndicatorBar[],
  options: IndicatorOptions = {},
): Indicators {
  const result = empty();
  const completed = bars.filter((b) => b.final);
  if (!completed.length || options.historyComplete === false) return result;
  try {
    validateSeries(completed);
    const closes = completed.map((b) => b.close),
      turnover = averageTurnover(completed, 20, options.unadjusted);
    Object.assign(result, {
      r1: returnOver(closes, 1),
      r3: returnOver(closes, 3),
      r30: returnOver(closes, 30),
      adv20: turnover.value,
      estimatedTurnover: turnover.estimated,
      adr20: adr(completed),
      ema9: ema(closes, 9).at(-1) ?? null,
      ema21: ema(closes, 21).at(-1) ?? null,
      ema50: ema(closes, 50).at(-1) ?? null,
      atr14: atr(completed).at(-1) ?? null,
    });
    if (completed.length >= 3)
      result.tight3 = str(
        D.max(...completed.slice(-3).map((b) => decimal(b.high)))
          .minus(D.min(...completed.slice(-3).map((b) => decimal(b.low))))
          .div(closes.at(-1)!),
      );
    result.screeningReady =
      completed.length >= Math.max(250, options.requiredHistory ?? 250) &&
      result.adv20 !== null &&
      completed.every((b) => b.adjustmentVerified === true);
    return result;
  } catch {
    return empty();
  }
}
export function screenInstrument(
  instrument: Instrument,
  bars: readonly IndicatorBar[],
  options: IndicatorOptions = {},
): Candidate {
  const completed = bars.filter((b) => b.final),
    indicators = calculateIndicators(bars, options),
    reasons: string[] = [];
  let unknown = false;
  if (options.historyComplete === false) {
    reasons.push("UNREPAIRED_HISTORY_GAP");
    unknown = true;
  }
  if (completed.some((b) => b.adjustmentVerified !== true)) {
    reasons.push("ADJUSTMENT_PROVENANCE_UNVERIFIED");
    unknown = true;
  }
  if (completed.length < Math.max(250, options.requiredHistory ?? 250)) {
    reasons.push("INSUFFICIENT_HISTORY");
    unknown = true;
  }
  try {
    validateSeries(completed);
  } catch (error) {
    reasons.push((error as Error).message);
    unknown = true;
  }
  if (options.ordinaryShare === false) reasons.push("NOT_ORDINARY_SHARE");
  if (options.suspended === true) reasons.push("SUSPENDED");
  if (
    Object.entries(indicators).some(
      ([key, value]) => value === null && key !== "estimatedTurnover",
    )
  ) {
    reasons.push("INDICATOR_INPUT_MISSING");
    unknown = true;
  }
  if (!unknown) {
    if (
      decimal(indicators.adv20!).lt(
        instrument.market === "US" ? "10000000" : "100000000",
      )
    )
      reasons.push("LOW_LIQUIDITY");
    const range = decimal(indicators.adr20!);
    if (range.lt(2) || range.gt(15)) reasons.push("ADR_OUTSIDE_RANGE");
    if (
      !decimal(indicators.ema9!).gt(indicators.ema21!) ||
      !decimal(indicators.ema21!).gt(indicators.ema50!)
    )
      reasons.push("EMA_ORDER_NOT_STRICT");
    const previousEma = ema(
      completed.map((b) => b.close),
      21,
    ).at(-6);
    if (!previousEma || !decimal(indicators.ema21!).gt(previousEma))
      reasons.push("EMA21_NOT_RISING");
    if (decimal(completed.at(-1)!.close).lt(indicators.ema21!))
      reasons.push("CLOSE_BELOW_EMA21");
    if (!decimal(indicators.r30!).gt(0)) reasons.push("R30_NOT_POSITIVE");
  }
  return {
    instrument,
    indicators,
    status: unknown ? "UNKNOWN" : reasons.length ? "FAIL" : "PASS",
    reasons,
    rank: null,
    date:
      options.date ??
      (completed.length
        ? new Date(completed.at(-1)!.time * 1000).toISOString().slice(0, 10)
        : ""),
    tags: [],
    note: "",
  };
}
/** Returns every candidate, with eligible ranks per market; beyond-cap rows remain visible. */
export function rankCandidates(
  candidates: readonly Candidate[],
  limitPerMarket = 30,
): Candidate[] {
  if (!Number.isSafeInteger(limitPerMarket) || limitPerMarket < 1)
    throw new Error("INVALID_CANDIDATE_LIMIT");
  const ranked = candidates.map((c) => ({
    ...c,
    reasons: [...c.reasons],
    rank: null as number | null,
  }));
  const compare = (a: Candidate, b: Candidate) => {
    for (const [field, direction] of [
      ["r30", -1],
      ["r3", -1],
      ["tight3", 1],
      ["adv20", -1],
    ] as const) {
      const av = a.indicators[field],
        bv = b.indicators[field];
      if (av === null || bv === null)
        return av === bv ? 0 : av === null ? 1 : -1;
      const difference = decimal(av).cmp(bv) * direction;
      if (difference) return difference;
    }
    return a.instrument.id < b.instrument.id
      ? -1
      : a.instrument.id > b.instrument.id
        ? 1
        : 0;
  };
  for (const market of ["US", "CN"] as const) {
    const passes = ranked
      .filter(
        (c) =>
          c.instrument.market === market &&
          c.status === "PASS" &&
          ["r30", "r3", "tight3", "adv20"].every(
            (field) => c.indicators[field as keyof Indicators] !== null,
          ),
      )
      .sort(compare);
    passes.forEach((candidate, index) => {
      if (index < limitPerMarket) candidate.rank = index + 1;
      else candidate.reasons.push("BEYOND_MARKET_LIMIT");
    });
  }
  return ranked.sort(
    (a, b) =>
      a.instrument.market.localeCompare(b.instrument.market) ||
      (a.rank ?? Number.MAX_SAFE_INTEGER) -
        (b.rank ?? Number.MAX_SAFE_INTEGER) ||
      compare(a, b),
  );
}
export function avwap(
  bars: readonly IndicatorBar[],
  anchorIndex = 0,
): (string | null)[] {
  if (
    !Number.isSafeInteger(anchorIndex) ||
    anchorIndex < 0 ||
    anchorIndex >= bars.length
  )
    return bars.map(() => null);
  validateSeries(bars);
  if (bars.some((b) => !b.final || b.adjustmentVerified !== true))
    throw new Error("UNVERIFIED_AVWAP_INPUT");
  let weighted = new D(0),
    total = new D(0);
  return bars.map((bar, index) => {
    if (index < anchorIndex) return null;
    const volume = nonNegative(bar.volume, "volume").mul(
      positive(bar.sharesPerUnit ?? "1", "sharesPerUnit"),
    );
    const typical = decimal(bar.high).plus(bar.low).plus(bar.close).div(3);
    weighted = weighted.plus(typical.mul(volume));
    total = total.plus(volume);
    return total.isZero() ? null : str(weighted.div(total));
  });
}
export type SupportFamily = "EMA" | "AVWAP" | "HORIZONTAL";
export interface Support {
  id: string;
  family: SupportFamily;
  price: string;
}
export interface SupportInput {
  primary: string;
  previousClose: string;
  tick: string;
  atr14: string | null;
  supports: readonly Support[];
}
export function supportSnapshot(input: SupportInput) {
  const primary = positive(input.primary, "primary"),
    price = positive(input.previousClose, "previousClose"),
    tick = positive(input.tick, "tick");
  const tau = D.max(
    tick.mul(2),
    price.mul("0.0025"),
    input.atr14 === null
      ? new D(0)
      : nonNegative(input.atr14, "atr14").mul("0.1"),
  );
  const distances = input.supports.map((s) => ({
    ...s,
    distance: str(positive(s.price, "support").minus(primary).abs().div(tau)),
    within: decimal(s.price).minus(primary).abs().lte(tau),
  }));
  const families = [
    ...new Set(distances.filter((s) => s.within).map((s) => s.family)),
  ];
  const reasons: string[] = [];
  if (input.atr14 === null) reasons.push("ATR_NOT_READY");
  if (
    families.length < 2 ||
    !families.some((f) => f === "EMA" || f === "AVWAP")
  )
    reasons.push("INSUFFICIENT_SUPPORT_FAMILIES");
  if (primary.minus(tau).lte(0)) reasons.push("NON_POSITIVE_SUPPORT_ZONE");
  return {
    tau: str(tau),
    lower: roundDownTick(primary.minus(tau), input.tick),
    upper: roundUpTick(primary.plus(tau), input.tick),
    distances,
    families,
    ready: reasons.length === 0,
    reasons,
  };
}
