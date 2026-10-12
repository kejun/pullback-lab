export type Market = "US" | "CN";
export type Currency = "USD" | "CNY";
export type Mode = "CLOSE_CONFIRM" | "INTRABAR_CROSS";
export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  tick: string;
  qMin: number;
  qStep: number;
  sellSameDay: boolean;
  rulesVerified: boolean;
}
export interface Bar {
  id: string;
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover?: string;
  final: boolean;
  receivedAt: number;
  adjustmentVersion: string;
}
export interface Indicators {
  r1: string | null;
  r3: string | null;
  r30: string | null;
  adv20: string | null;
  adr20: string | null;
  tight3: string | null;
  ema9: string | null;
  ema21: string | null;
  ema50: string | null;
  atr14: string | null;
  estimatedTurnover: boolean;
  screeningReady: boolean;
}
export interface Candidate {
  instrument: Instrument;
  indicators: Indicators;
  status: "PASS" | "FAIL" | "UNKNOWN" | "MANUAL";
  reasons: string[];
  rank: number | null;
  date: string;
  tags: string[];
  note: string;
}
export interface Capability {
  market: Market;
  level: "UNKNOWN" | "EOD_ONLY" | "DELAYED" | "LIVE_CLOSED_BAR" | "LIVE_TICK";
  reason: string;
  source: string;
  checkedAt: number | null;
}
export interface PlanInput {
  instrumentId: string;
  anchorTime: number | null;
  primarySupport: string;
  lower: string;
  upper: string;
  stop: string;
  entryMin: string;
  entryMax: string;
  mode: Mode;
  sessionDate: string;
  reason: string;
  backgroundConfirmed: boolean;
}
export interface Plan extends PlanInput {
  id: string;
  version: number;
  status: string;
  attemptId: string | null;
  approvedQuantity: number;
  createdAt: number;
  updatedAt: number;
}
export interface Funds {
  generation: number;
  nav: string;
  baseCurrency: Currency;
  cash: Record<Currency, string>;
  existing: Record<string, string>;
  riskBudget: string;
  riskPool: string;
  maxWeight: string;
  fx: Record<Currency, string>;
  fxAsOf: number;
  confirmedAt: number;
  stale: boolean;
  buyFee: string;
  sellFee: string;
  slippageIn: string;
  slippageOut: string;
  feesConfirmed: boolean;
}
export interface RiskResult {
  quantity: number;
  entry: string;
  stopExec: string;
  cashUse: string;
  riskBase: string;
  exposureBase: string;
  reasons: string[];
  passed: boolean;
}
export interface DecisionEvent {
  id: string;
  planId: string;
  attemptId: string;
  type: string;
  time: number;
  receivedAt: number;
  message: string;
  reasons: string[];
  quantity: number | null;
  historical: boolean;
  read: boolean;
  feedback: "TAKEN" | "SKIPPED" | null;
  snapshot: Record<string, unknown>;
}
export interface Bootstrap {
  demo: boolean;
  capabilities: Capability[];
  instruments: Instrument[];
  plans: Plan[];
  funds: Funds | null;
  events: DecisionEvent[];
  screeningConfirmed: boolean;
}
