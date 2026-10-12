import type { ScreeningParameters } from "../contracts/screening.js";
import { nonNegative, positive, str } from "./numeric.js";

export const DEFAULT_SCREENING_PARAMETERS: ScreeningParameters = Object.freeze({
  minimumAdv20: Object.freeze({ US: "10000000", CN: "100000000" }),
  adrMinPct: "2",
  adrMaxPct: "15",
  limitPerMarket: 30,
});

/** Validate an API or persisted boundary and return canonical decimal strings. */
export function normalizeScreeningParameters(
  input: unknown,
): ScreeningParameters {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("INVALID_SCREENING_PARAMETERS");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        !["minimumAdv20", "adrMinPct", "adrMaxPct", "limitPerMarket"].includes(
          key,
        ),
    )
  )
    throw new Error("UNKNOWN_SCREENING_PARAMETER");
  const minimum = value.minimumAdv20;
  if (!minimum || typeof minimum !== "object" || Array.isArray(minimum))
    throw new Error("INVALID_MINIMUM_ADV20");
  const adv = minimum as Record<string, unknown>;
  if (Object.keys(adv).some((key) => key !== "US" && key !== "CN"))
    throw new Error("UNKNOWN_MINIMUM_ADV20_MARKET");
  const us = positive(adv.US, "minimumAdv20.US");
  const cn = positive(adv.CN, "minimumAdv20.CN");
  const lower = nonNegative(value.adrMinPct, "adrMinPct");
  const upper = nonNegative(value.adrMaxPct, "adrMaxPct");
  if (lower.gt(upper) || upper.gt(100)) throw new Error("INVALID_ADR_RANGE");
  const limit = value.limitPerMarket;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 30
  )
    throw new Error("INVALID_CANDIDATE_LIMIT");
  return {
    minimumAdv20: { US: str(us), CN: str(cn) },
    adrMinPct: str(lower),
    adrMaxPct: str(upper),
    limitPerMarket: limit,
  };
}
