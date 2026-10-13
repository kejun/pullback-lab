import type {
  FeeSchedule,
  FeeSide,
  Funds,
  Instrument,
  RiskResult,
} from "../contracts/index.js";
import {
  D,
  decimal,
  moneyCeil,
  nonNegative,
  positive,
  roundDownTick,
  roundUpTick,
  safeQuantity,
  str,
  type Dec,
} from "./numeric.js";

export interface Reservations {
  cash: string;
  riskBase: string;
  exposureBase: string;
}
export type { FeeSchedule, FeeSide } from "../contracts/index.js";
export interface RiskInput {
  instrument: Instrument;
  funds: Funds;
  entryCheck: string;
  entryMin?: string;
  entryMax: string;
  stop: string;
  now: number;
  quoteAsOf?: number;
  ask?: string;
  /** PLAN reserves at entryMax, including its slippage allowance. TRIGGER requires a fresh quote and stored approval. */
  phase?: "PLAN" | "TRIGGER";
  approvedQuantity?: number;
  reservations?: Reservations;
  feeSchedule?: FeeSchedule;
  sessionStartedAt?: number;
  /** Defaults implement the engineering presets, not a permission to consume delayed feeds. */
  maxQuoteAgeMs?: number;
  maxFxAgeMs?: number;
  maxFundsAgeMs?: number;
}
export interface RiskCheck {
  actual: string;
  limit: string;
  passed: boolean;
}
export interface RiskEvaluation extends RiskResult {
  buyFee: string;
  sellFee: string;
  checks: Record<
    "singleRisk" | "poolRisk" | "cash" | "exposure",
    RiskCheck
  > | null;
  headroom: Record<
    "singleRisk" | "poolRisk" | "cash" | "exposure",
    string
  > | null;
  nextQuantity: number | null;
  nextQuantityFeasible: boolean;
  warnings: string[];
  fx: string | null;
  feeVersion: string | null;
  referencePrices: { r1: string; r3: string; r5: string } | null;
}
const zeroResult = (): RiskEvaluation => ({
  quantity: 0,
  entry: "0",
  stopExec: "0",
  cashUse: "0",
  riskBase: "0",
  exposureBase: "0",
  reasons: [],
  passed: false,
  buyFee: "0",
  sellFee: "0",
  checks: null,
  headroom: null,
  nextQuantity: null,
  nextQuantityFeasible: false,
  warnings: [],
  fx: null,
  feeVersion: null,
  referencePrices: null,
});
function assertQuantity(value: number, name: string, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new Error(`INVALID_QUANTITY:${name}`);
}
function timestampFresh(
  value: number,
  now: number,
  maxAge: number,
  code: string,
) {
  if (
    !Number.isSafeInteger(value) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(maxAge) ||
    maxAge < 0 ||
    value > now ||
    now - value > maxAge
  )
    throw new Error(code);
}
function prepareFee(side: FeeSide) {
  const min = nonNegative(side.minimum, "fee.minimum"),
    fixed = nonNegative(side.fixed ?? "0", "fee.fixed"),
    perShare = nonNegative(side.perShare ?? "0", "fee.perShare"),
    rate = nonNegative(side.notionalRate ?? "0", "fee.notionalRate");
  return (quantity: Dec, price: Dec) =>
    quantity.isZero()
      ? new D(0)
      : moneyCeil(
          D.max(
            min,
            fixed
              .plus(perShare.mul(quantity))
              .plus(rate.mul(quantity).mul(price)),
          ),
        );
}
/**
 * Maximum lawful whole-share quantity. Monetary calculations are decimal only.
 * Backend must aggregate reservations inside its transaction and exclude this plan.
 */
export function solveRisk(input: RiskInput): RiskEvaluation {
  const result = zeroResult();
  try {
    const { instrument, funds } = input;
    if (!instrument.rulesVerified)
      throw new Error("INSTRUMENT_RULES_UNVERIFIED");
    assertQuantity(instrument.qMin, "qMin");
    assertQuantity(instrument.qStep, "qStep");
    if (input.approvedQuantity !== undefined)
      assertQuantity(input.approvedQuantity, "approvedQuantity", true);
    if (input.phase === "TRIGGER" && input.approvedQuantity === undefined)
      throw new Error("APPROVED_QUANTITY_REQUIRED");
    if (funds.stale) throw new Error("FUNDS_SNAPSHOT_STALE");
    timestampFresh(
      funds.confirmedAt,
      input.now,
      input.maxFundsAgeMs ?? 86400000,
      "FUNDS_SNAPSHOT_EXPIRED",
    );
    if (
      input.sessionStartedAt !== undefined &&
      funds.confirmedAt < input.sessionStartedAt
    )
      throw new Error("FUNDS_SESSION_CONFIRMATION_REQUIRED");
    if (input.phase === "TRIGGER" && input.quoteAsOf === undefined)
      throw new Error("FRESH_QUOTE_REQUIRED");
    if (input.quoteAsOf !== undefined)
      timestampFresh(
        input.quoteAsOf,
        input.now,
        input.maxQuoteAgeMs ?? 3000,
        "QUOTE_STALE",
      );
    // A versioned plan schedule owns its confirmation; the legacy checkbox applies only to legacy fixed fees.
    if (!input.feeSchedule && !funds.feesConfirmed)
      throw new Error("FEES_UNCONFIRMED");
    const nav = positive(funds.nav, "nav"),
      budget = positive(funds.riskBudget, "riskBudget"),
      pool = positive(funds.riskPool, "riskPool"),
      weight = positive(funds.maxWeight, "maxWeight");
    if (weight.gt(1)) throw new Error("LEVERAGE_NOT_SUPPORTED");
    const cash = nonNegative(funds.cash[instrument.currency], "cash"),
      existing = nonNegative(funds.existing[instrument.id] ?? "0", "existing");
    const res = input.reservations ?? {
      cash: "0",
      riskBase: "0",
      exposureBase: "0",
    };
    const cashReserved = nonNegative(res.cash, "reservedCash"),
      riskReserved = nonNegative(res.riskBase, "reservedRisk"),
      exposureReserved = nonNegative(res.exposureBase, "reservedExposure");
    let fx = new D(1);
    if (funds.baseCurrency !== instrument.currency) {
      fx = positive(funds.fx[instrument.currency], "fx");
      timestampFresh(
        funds.fxAsOf,
        input.now,
        input.maxFxAgeMs ?? 900000,
        "FX_STALE",
      );
    }
    result.fx = str(fx);
    const tick = positive(instrument.tick, "tick");
    const entryCheck = positive(input.entryCheck, "entryCheck"),
      stop = positive(input.stop, "stop"),
      max = positive(input.entryMax, "entryMax");
    const min =
      input.entryMin === undefined
        ? stop
        : positive(input.entryMin, "entryMin");
    if (input.entryMin !== undefined && (min.lte(stop) || !max.gt(min)))
      throw new Error("INVALID_ENTRY_RANGE");
    const slippageIn = nonNegative(funds.slippageIn, "slippageIn");
    // PLAN reserves at the final executable ceiling. TRIGGER uses a fresh market quote.
    const executionBase =
      input.phase === "PLAN"
        ? max
        : D.max(
            entryCheck.plus(slippageIn),
            input.ask === undefined ? entryCheck : positive(input.ask, "ask"),
          );
    const entry = decimal(roundUpTick(executionBase, str(tick)));
    const stopExec = decimal(
      roundDownTick(
        stop.minus(nonNegative(funds.slippageOut, "slippageOut")),
        str(tick),
      ),
    );
    result.entry = str(entry);
    result.stopExec = str(stopExec);
    if (entry.gt(max) || entryCheck.gt(max) || entryCheck.lt(min))
      throw new Error("ENTRY_OUTSIDE_RANGE");
    if (stopExec.lte(0) || entry.lte(stopExec))
      throw new Error("INVALID_EXECUTION_PRICES");
    if (!instrument.sellSameDay)
      result.warnings.push("SAME_DAY_STOP_SALE_UNAVAILABLE");
    result.warnings.push(
      "STOP_NOT_MAXIMUM_LOSS_GUARANTEE",
      "BASED_ON_MANUAL_FUNDS_SNAPSHOT",
    );
    if (input.ask === undefined)
      result.warnings.push("EXECUTION_PRICE_ESTIMATE");
    let schedule = input.feeSchedule;
    if (
      schedule &&
      (!schedule.confirmed ||
        schedule.currency !== instrument.currency ||
        !schedule.version)
    )
      throw new Error("FEE_SCHEDULE_UNVERIFIED");
    schedule ??= {
      buy: { minimum: funds.buyFee },
      sell: { minimum: funds.sellFee },
      currency: instrument.currency,
      version: "manual-fixed-minimum-v1",
      confirmed: true,
    };
    result.feeVersion = schedule.version;
    const buy = prepareFee(schedule.buy),
      sell = prepareFee(schedule.sell);
    const limits = {
      singleRisk: budget,
      poolRisk: pool.minus(riskReserved),
      cash: cash.minus(cashReserved),
      exposure: weight.mul(nav).minus(existing).minus(exposureReserved),
    };
    const unitRisk = entry.minus(stopExec).mul(fx),
      unitExposure = entry.mul(fx);
    const evaluation = (quantity: Dec) => {
      const buyFee = buy(quantity, entry),
        sellFee = sell(quantity, stopExec);
      // Round required amounts up to minor currency units, never down in a risk gate.
      const risk = moneyCeil(
        quantity.mul(entry.minus(stopExec)).plus(buyFee).plus(sellFee).mul(fx),
      );
      const used = moneyCeil(quantity.mul(entry).plus(buyFee)),
        exposure = moneyCeil(quantity.mul(entry).mul(fx));
      return {
        risk,
        used,
        exposure,
        buyFee,
        sellFee,
        feasible:
          risk.lte(limits.singleRisk) &&
          risk.lte(limits.poolRisk) &&
          used.lte(limits.cash) &&
          exposure.lte(limits.exposure),
      };
    };
    // These fee schedules are provably nondecreasing (every coefficient is nonnegative).
    let upper = D.min(
      budget.div(unitRisk),
      limits.poolRisk.div(unitRisk),
      limits.cash.div(entry),
      limits.exposure.div(unitExposure),
      Number.MAX_SAFE_INTEGER.toString(),
    ).floor();
    if (input.approvedQuantity !== undefined)
      upper = D.min(upper, input.approvedQuantity.toString());
    const qMin = new D(instrument.qMin.toString()),
      qStep = new D(instrument.qStep.toString());
    let best = new D(0);
    if (upper.gte(qMin)) {
      let low = 0n,
        high = BigInt(upper.minus(qMin).div(qStep).floor().toFixed(0));
      while (low <= high) {
        const middle = (low + high) / 2n,
          quantity = qMin.plus(qStep.mul(middle.toString()));
        if (evaluation(quantity).feasible) {
          best = quantity;
          low = middle + 1n;
        } else high = middle - 1n;
      }
    }
    const values = evaluation(best);
    const next = best.isZero() ? qMin : best.plus(qStep);
    const belowApproved =
      input.approvedQuantity === undefined ||
      next.lte(input.approvedQuantity.toString());
    const nextSafe = next.lte(Number.MAX_SAFE_INTEGER.toString());
    result.nextQuantity = nextSafe ? safeQuantity(next) : null;
    result.nextQuantityFeasible =
      nextSafe && belowApproved && evaluation(next).feasible;
    if (!best.isZero() && (!values.feasible || result.nextQuantityFeasible))
      throw new Error("RISK_SOLVER_POSTCONDITION_FAILED");
    const actual = {
      singleRisk: values.risk,
      poolRisk: values.risk,
      cash: values.used,
      exposure: values.exposure,
    };
    result.checks = Object.fromEntries(
      Object.keys(actual).map((key) => {
        const k = key as keyof typeof actual;
        return [
          k,
          {
            actual: str(actual[k]),
            limit: str(limits[k]),
            passed: actual[k].lte(limits[k]),
          },
        ];
      }),
    ) as RiskEvaluation["checks"];
    result.headroom = Object.fromEntries(
      Object.keys(actual).map((key) => {
        const k = key as keyof typeof actual;
        return [k, str(limits[k].minus(actual[k]))];
      }),
    ) as RiskEvaluation["headroom"];
    result.quantity = safeQuantity(best);
    result.cashUse = str(values.used);
    result.riskBase = str(values.risk);
    result.exposureBase = str(values.exposure);
    result.buyFee = str(values.buyFee);
    result.sellFee = str(values.sellFee);
    result.referencePrices = {
      r1: str(entry.plus(entry.minus(stop))),
      r3: str(entry.plus(entry.minus(stop).mul(3))),
      r5: str(entry.plus(entry.minus(stop).mul(5))),
    };
    if (best.isZero()) {
      result.reasons.push("NO_LEGAL_QUANTITY");
      const minimum = evaluation(qMin);
      if (minimum.risk.gt(limits.singleRisk))
        result.reasons.push("SINGLE_RISK_LIMIT");
      if (minimum.risk.gt(limits.poolRisk))
        result.reasons.push("RISK_POOL_LIMIT");
      if (minimum.used.gt(limits.cash)) result.reasons.push("CASH_LIMIT");
      if (minimum.exposure.gt(limits.exposure))
        result.reasons.push("EXPOSURE_LIMIT");
      if (
        input.approvedQuantity !== undefined &&
        qMin.gt(input.approvedQuantity.toString())
      )
        result.reasons.push("APPROVED_QUANTITY_LIMIT");
    } else result.passed = true;
    return result;
  } catch (error) {
    result.reasons.push(
      error instanceof Error ? error.message : "INVALID_RISK_INPUT",
    );
    return result;
  }
}
/** A scenario loss is explicitly not a guaranteed maximum and never creates a trade record. */
export function stressLoss(
  quantity: number,
  entry: string,
  exitScenario: string,
  fx = "1",
): string {
  assertQuantity(quantity, "quantity", true);
  return str(
    D.max(
      0,
      positive(entry, "entry").minus(nonNegative(exitScenario, "exitScenario")),
    )
      .mul(quantity.toString())
      .mul(positive(fx, "fx")),
  );
}
