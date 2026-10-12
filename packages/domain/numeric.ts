import Decimal from "decimal.js";

/** Local arithmetic context: never changes another package's Decimal configuration. */
export const D = Decimal.clone({
  precision: 64,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -100,
  toExpPos: 100,
});
export type Dec = Decimal;
const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Boundary parser. JSON numbers, exponents, whitespace, NaN and Infinity are rejected. */
export function decimal(value: unknown, field = "decimal"): Dec {
  if (
    typeof value !== "string" ||
    !PLAIN_DECIMAL.test(value) ||
    value.length > 192 ||
    value.replace(/[-.]/g, "").replace(/^0+/, "").length > 64
  ) {
    throw new Error(`INVALID_DECIMAL:${field}`);
  }
  return new D(value);
}
export function positive(value: unknown, field: string): Dec {
  const result = decimal(value, field);
  if (!result.gt(0)) throw new Error(`NON_POSITIVE:${field}`);
  return result;
}
export function nonNegative(value: unknown, field: string): Dec {
  const result = decimal(value, field);
  if (result.lt(0)) throw new Error(`NEGATIVE:${field}`);
  return result;
}
export function str(value: Decimal): string {
  return value.isZero() ? "0" : value.toFixed();
}
export function roundUpTick(value: string | Decimal, tick: string): string {
  const price = typeof value === "string" ? decimal(value, "price") : value;
  return str(price.div(positive(tick, "tick")).ceil().mul(tick));
}
export function roundDownTick(value: string | Decimal, tick: string): string {
  const price = typeof value === "string" ? decimal(value, "price") : value;
  return str(price.div(positive(tick, "tick")).floor().mul(tick));
}
export function moneyCeil(value: Decimal, places = 2): Dec {
  return value.toDecimalPlaces(places, D.ROUND_CEIL);
}
export function safeQuantity(value: Decimal): number {
  if (
    !value.isInteger() ||
    value.lt(0) ||
    value.gt(Number.MAX_SAFE_INTEGER.toString())
  )
    throw new Error("UNSAFE_QUANTITY");
  return value.toNumber(); // Counts only. Prices and money never cross the Number boundary.
}
