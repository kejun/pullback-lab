import type { PlanInput } from "../contracts/index.js";
import { nonNegative } from "./numeric.js";

/** User-facing percentage points become an exact ratio in the isolated domain decimal context. */
export function chaseRatio(
  plan: Pick<PlanInput, "chaseLimit">,
): string | undefined {
  return plan.chaseLimit?.enabled
    ? nonNegative(plan.chaseLimit.maxPercent, "chaseLimit.maxPercent")
        .div(100)
        .toFixed()
    : undefined;
}
