import type { ScreeningParameters, ScreeningRuleVersion } from "./screening.js";
export type { ScreeningParameters, ScreeningRuleVersion } from "./screening.js";
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
export interface ScreeningSettings {
  version: number;
  current: ScreeningRuleVersion | null;
  defaultParameters: ScreeningParameters;
}
export interface CandidateRow extends Candidate {
  manual: boolean;
  origin: "MANUAL" | "SYNTHETIC" | "IMPORTED";
  screeningStatus: "PASS" | "FAIL" | "UNKNOWN";
  /** Last completed bar used in the calculation, UTC seconds. */
  dataCutoff: number | null;
  /** Latest receipt time of the inputs used, UTC milliseconds. */
  knownAt: number | null;
  turnoverBasis: "PROVIDER" | "ESTIMATED" | "MISSING";
  health: {
    state: "SYNTHETIC" | "UNKNOWN" | "MISSING";
    reasons: string[];
    ignoredUnfinished: number;
    ignoredFuture: number;
  };
}
export interface CandidateMarketCoverage {
  total: number;
  manual: number;
  ready: number;
  passed: number;
  failed: number;
  unknown: number;
  ranked: number;
}
export interface CandidatePage {
  candidates: CandidateRow[];
  coverage: number;
  asOf: string;
  rules: ScreeningSettings;
  universeRevision: string;
  /** UTC milliseconds at which this result was computed. */
  computedAt: number;
  /** Always the current request time, including cache hits. */
  evaluatedAt: number;
  cacheHit: boolean;
  workerHealth: {
    state: "DISABLED" | "IDLE" | "POLLING" | "BACKOFF" | "STOPPED";
    reason: string;
    source: string | null;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    lastErrorCode: string | null;
    lastQuarantineReason: string | null;
    providerQuotaVerified: false;
    liveEligible: false;
  };
  marketCoverage: Record<Market, CandidateMarketCoverage>;
}
export interface Capability {
  market: Market;
  level: "UNKNOWN" | "EOD_ONLY" | "DELAYED" | "LIVE_CLOSED_BAR" | "LIVE_TICK";
  reason: string;
  source: string;
  checkedAt: number | null;
}
export type SupportSelection =
  | { source: "EMA9" | "EMA21" | "EMA50" | "AVWAP" }
  | { source: "HORIZONTAL"; id: string; price: string; label: string };
export type SupportFamily = "EMA" | "AVWAP" | "HORIZONTAL";
export interface SupportSnapshot {
  /** Installed server proof identity, absent from uploads and synthetic history. */
  providerContextId?: string;
  schemaVersion: 2;
  status: "READY" | "INCOMPLETE";
  ready: boolean;
  reasons: string[];
  selectedAt: number;
  selectionReason: string;
  primarySupport: string;
  anchorTime: number | null;
  anchorBarId: string | null;
  baseInterval: "1D";
  priceFormula: "HLC3";
  priceBasis: "SPLIT_ADJUSTED";
  session: "REGULAR";
  reference: {
    previousDailyBarId: string | null;
    previousDailyTime: number | null;
    close: string | null;
    atr14: string | null;
    tick: string;
  };
  tolerance: string | null;
  suggestedLower: string | null;
  suggestedUpper: string | null;
  lines: {
    id: string;
    source: SupportSelection["source"];
    family: SupportFamily;
    label: string;
    price: string | null;
    distance: string | null;
    withinTolerance: boolean;
    reasons: string[];
    /** Time the supporting input became known, UTC milliseconds. */
    dataCutoff: number | null;
  }[];
  matchedFamilies: SupportFamily[];
  adjustmentVersion: string | null;
  dataRevision: string;
  instrumentRevision: string;
  seedStart: number | null;
  knownAt: number | null;
  synthetic: boolean;
}
export interface SupportPreviewInput {
  /** Explicit immutable manual research dataset; never grants live capability. */
  researchHistoryId?: string;
  instrumentId: string;
  anchorTime: number | null;
  primarySupport: string;
  supportSelections: SupportSelection[];
  sessionDate?: string;
}
export interface PlanInput {
  /** Explicit immutable manual research dataset; never grants live capability. */
  researchHistoryId?: string;
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
  supportSelections?: SupportSelection[];
}
export interface Plan extends PlanInput {
  /** Only newly created versions carry this immutable rule snapshot. */
  screeningRuleSnapshot?: ScreeningRuleVersion | null;
  supportSnapshot?: SupportSnapshot;
  id: string;
  version: number;
  status: string;
  attemptId: string | null;
  approvedQuantity: number;
  createdAt: number;
  updatedAt: number;
}
export type FeedbackDeviationCode =
  | "ACTUAL_PRICE_OUTSIDE_ENTRY_RANGE"
  | "ACTUAL_QUANTITY_ABOVE_APPROVED"
  | "ACTUAL_QUANTITY_RULE_MISMATCH"
  | "ACTUAL_TIME_BEFORE_SIGNAL";
export interface FeedbackInput {
  kind: "TAKEN" | "SKIPPED";
  note: string;
  actualPrice?: string;
  actualQuantity?: number;
  actualTime?: number;
  expectedRevisionId?: string | null;
}
export interface FeedbackRevision extends Omit<
  FeedbackInput,
  "expectedRevisionId"
> {
  id: string;
  recordedAt: number;
  deviationCodes: FeedbackDeviationCode[];
  assessmentVersion: "feedback-v1" | "legacy-unassessed";
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
/** Bounded event list item. Frozen evidence is available only through event detail. */
export interface DecisionEventSummary extends Omit<DecisionEvent, "snapshot"> {
  seq: number;
  changeSeq: number;
  synthetic: boolean;
  recordable: boolean;
  feedbackRevisionId: string | null;
}
export interface EventCounts {
  total: number;
  unread: number;
  pending: number;
  taken: number;
  skipped: number;
}
export interface EventFeedBatch {
  events: DecisionEventSummary[];
  feedCursor: string;
  feedEpoch: string;
  feedRevision: number;
  hasMore: boolean;
  counts: EventCounts;
}
export interface EventPage extends EventFeedBatch {
  beforeCursor: string | null;
  afterCursor: string | null;
}
export interface Bootstrap {
  demo: boolean;
  capabilities: Capability[];
  instruments: Instrument[];
  plans: Plan[];
  funds: Funds | null;
  events: DecisionEventSummary[];
  eventPage: EventPage;
  screeningConfirmed: boolean;
  screeningRules: ScreeningSettings;
  universeRevision: string;
}
