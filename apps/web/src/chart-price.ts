import Decimal from "decimal.js";

export const planPriceFields = [
  { field: "primarySupport", label: "主支撑" },
  { field: "lower", label: "支撑下沿" },
  { field: "upper", label: "支撑上沿" },
  { field: "stop", label: "止损" },
  { field: "entryMin", label: "入场下限" },
  { field: "entryMax", label: "入场上限" },
] as const;
export type PlanPriceField = (typeof planPriceFields)[number]["field"];
export type ChartPriceProposal =
  | { kind: "POINT"; displayPrice: string }
  | { kind: "STEP"; price: string; steps: number };

/** Chart coordinates use doubles; reject scales unable to distinguish a tick. */
export function chartSafePrice(price: string, tick: string): number | null {
  try {
    const exact = new Decimal(price);
    const increment = new Decimal(tick);
    if (
      !exact.isFinite() ||
      !exact.isPositive() ||
      !increment.isFinite() ||
      !increment.isPositive()
    )
      return null;
    const display = exact.toNumber();
    if (!Number.isFinite(display) || display <= 0) return null;
    // Leave ample room for the coordinate conversion and nearest-tick rounding.
    if (exact.div(increment).gt(2 ** 44)) return null;
    if (
      new Decimal(display.toString()).minus(exact).abs().gt(increment.div(100))
    )
      return null;
    return display;
  } catch {
    return null;
  }
}

/** A display proposal is not an authoritative price and must go to the server. */
export function pointPriceProposal(
  price: number | null,
  tick: string,
): ChartPriceProposal | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  const displayPrice = new Decimal(price.toString()).toFixed();
  return chartSafePrice(displayPrice, tick) === null
    ? null
    : { kind: "POINT", displayPrice };
}

export function dragCoordinate(
  clientY: number,
  chartTop: number,
  grabOffset: number,
  paneHeight: number,
): number | null {
  const y = clientY - chartTop - grabOffset;
  return [clientY, chartTop, grabOffset, paneHeight].every(Number.isFinite) &&
    paneHeight > 0 &&
    y >= 0 &&
    y <= paneHeight
    ? y
    : null;
}
