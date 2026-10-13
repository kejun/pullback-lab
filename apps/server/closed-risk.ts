import Decimal from "decimal.js";
import type {
  Funds,
  Instrument,
  Plan,
  RiskResult,
} from "../../packages/contracts/index.js";
import { solveRisk } from "../../packages/domain/risk.js";
import type { Reservation } from "./store.js";
export interface ClosedRiskInput {
  plan: Plan;
  instrument: Instrument;
  funds: Funds | null;
  reservations: Reservation[];
  quote?: { price: string; at: number };
  sessionOpenAt: number;
  decisionAt: number;
}
/** Pure live-time assessment shared by the transaction and its read-only frozen-input audit. */
export function calculateClosedRisk(input: ClosedRiskInput): RiskResult {
  const { plan, funds, instrument } = input;
  const blocked = (reason: string): RiskResult => ({
    quantity: 0,
    entry: input.quote?.price ?? plan.entryMax,
    stopExec: plan.stop,
    cashUse: "0",
    riskBase: "0",
    exposureBase: "0",
    reasons: [reason],
    passed: false,
  });
  if (!funds) return blocked("FUNDS_NOT_CONFIRMED");
  if (
    input.reservations.some(
      (r) => r.planId === plan.id && r.state === "TAKEN_PENDING",
    )
  )
    return blocked("TAKEN_RECONCILIATION_REQUIRED");
  if (funds.stale) return blocked("FUNDS_SNAPSHOT_STALE");
  const own = input.reservations.find(
    (r) =>
      r.planId === plan.id &&
      r.attemptId === plan.attemptId &&
      r.state === "ACTIVE",
  );
  if (!own || own.generation !== funds.generation)
    return blocked("RESERVATION_GENERATION_CHANGED");
  const others = input.reservations.filter(
    (r) => r.planId !== plan.id && r.state !== "RELEASED",
  );
  const sum = (
    rows: Reservation[],
    key: "cash" | "riskBase" | "exposureBase",
  ) => rows.reduce((n, r) => n.plus(r[key]), new Decimal(0)).toFixed();
  const reservations = {
    cash: sum(
      others.filter((r) => r.currency === instrument.currency),
      "cash",
    ),
    riskBase: sum(others, "riskBase"),
    exposureBase: sum(
      others.filter((r) => r.instrumentId === instrument.id),
      "exposureBase",
    ),
  };
  return solveRisk({
    feeSchedule: plan.feeSchedule,
    instrument,
    funds,
    entryCheck: input.quote?.price ?? plan.entryMax,
    entryMin: plan.entryMin,
    entryMax: plan.entryMax,
    stop: plan.stop,
    now: input.decisionAt,
    quoteAsOf: input.quote?.at,
    sessionStartedAt: input.sessionOpenAt,
    approvedQuantity: Math.min(plan.approvedQuantity, own.quantity),
    phase: "TRIGGER",
    reservations,
  });
}
