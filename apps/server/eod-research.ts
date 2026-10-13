import Decimal from "decimal.js";
import { prepareLongbridgeHistoryCandidates } from "./longbridge-history-input.js";
import {
  localSessionTime,
  resolveSession,
} from "../../packages/market-data/calendar.js";
import type Database from "better-sqlite3";
import type { Bar, Instrument } from "../../packages/contracts/index.js";
import {
  closedHash,
  trustedClosedSupport,
  validateDailyProvenance,
  type StoredClosedContext,
} from "./closed-bar-adapter.js";
import { closedActionEvidenceCurrent } from "./closed-action-binding.js";
import { assertReviewedActionDataset } from "./reviewed-action-dataset.js";
import {
  buildLongbridgeDailyHistory,
  ProductionMarketError,
  type LongbridgeContextInput,
} from "./longbridge-context-builder.js";
import type { Store } from "./store.js";

/** This review is an audited static server dependency, never inferred from a capture or HTTP. */
export interface EodEndpointReview {
  evidenceId: string;
  sdk: "5.2.0";
  endpoint: "historyCandlesticksByDate";
  period: "1D";
  adjustment: "RAW";
  volumeUnit: "SHARE" | "LOT";
  /** Endpoint volume scale, not a security's minimum order quantity. */
  sharesPerLot?: number;
  timestampAnchor: "MARKET_LOCAL_MIDNIGHT";
  finality: "COMPLETED_SESSION_HISTORY";
}
export interface EodResearchInput {
  /** Untrusted full raw capture. Its hash and scope are recomputed, never supplied as approval. */
  capture: unknown;
  review: {
    /** Frozen during independent review. Never copy the latest file hash at startup. */
    expectedCaptureHash: string;
    history: Omit<
      LongbridgeContextInput,
      "rawDaily" | "dailyTimestampAnchor" | "probeReportId"
    >;
    endpoint: EodEndpointReview;
    /** Explicitly reviewed supplier half-day list; do not extrapolate present session hours. */
    halfTradingDates: readonly string[];
  };
}
export interface EodResearchContext extends StoredClosedContext {
  kind: "EOD_RESEARCH";
  captureHash: string;
  endpointReview: EodEndpointReview;
}
const D = Decimal.clone({ precision: 50 });
const fail = (code: string): never => {
  throw new ProductionMarketError(code);
};
function evidenceValid(c: StoredClosedContext, now: number): boolean {
  const e = c.capability;
  return (
    Number.isSafeInteger(now) &&
    Number.isSafeInteger(e.checkedAt) &&
    e.checkedAt >= 0 &&
    e.checkedAt <= now &&
    Number.isSafeInteger(e.validUntil) &&
    e.validUntil >= now &&
    e.validUntil >= e.checkedAt &&
    e.apiEntitlementVerified === true &&
    e.historicalReadVerified === true &&
    e.unitsVerified === true &&
    e.calendarVerified === true &&
    e.finalityContractVerified === true &&
    c.basisKnownAt <= now &&
    e.checkedAt >= c.basisKnownAt
  );
}
export function validateEodEndpoint(review: EodEndpointReview): void {
  if (
    !review ||
    typeof review.evidenceId !== "string" ||
    !review.evidenceId.trim() ||
    review.evidenceId.length > 500 ||
    review.sdk !== "5.2.0" ||
    review.endpoint !== "historyCandlesticksByDate" ||
    review.period !== "1D" ||
    review.adjustment !== "RAW" ||
    review.timestampAnchor !== "MARKET_LOCAL_MIDNIGHT" ||
    review.finality !== "COMPLETED_SESSION_HISTORY" ||
    !(
      (review.volumeUnit === "SHARE" && review.sharesPerLot === undefined) ||
      (review.volumeUnit === "LOT" &&
        Number.isSafeInteger(review.sharesPerLot) &&
        review.sharesPerLot! > 0 &&
        review.sharesPerLot! <= 10000)
    )
  )
    fail("EOD_ENDPOINT_REVIEW_REQUIRED");
}
/** Both markets share daily research validation; no minute/tick capability is inherited. */
export function buildEodResearchContext(
  input: EodResearchInput,
  now: number,
): EodResearchContext {
  const { history, captureHash } = reviewedEodHistory(input, now);
  history.capability = {
    ...history.capability,
    realtimeEntitlementVerified: false,
    completeMinutes: false,
    sequenceContractVerified: false,
    continuousTradesVerified: false,
    maxClosedBarDelayMs: null,
    quoteAgeMs: null,
    clockSkewMs: null,
    delayMinutes: null,
  };
  const c = validateDailyProvenance(
    buildLongbridgeDailyHistory(history, now, true),
    now,
    "SESSION_CLOSE",
  );
  if (!evidenceValid(c, now)) fail("EOD_CAPABILITY_UNVERIFIED");
  const { id: _id, ...base } = c;
  const value = {
    ...base,
    kind: "EOD_RESEARCH" as const,
    captureHash,
    endpointReview: structuredClone(input.review.endpoint),
  };
  return { ...value, id: `eod-context:${closedHash(value)}` };
}
/** Rebuilt on every process start. Previous persisted sources cannot activate themselves. */
export function installEodResearch(
  store: Store,
  inputs: readonly EodResearchInput[],
  now: number,
): void {
  if (inputs.length > 100) fail("EOD_RESEARCH_LIMIT");
  const contexts = inputs.map((input) => buildEodResearchContext(input, now));
  if (
    new Set(contexts.map((c) => c.instrument.id)).size !== contexts.length ||
    new Set(contexts.map((c) => c.instrument.symbol)).size !== contexts.length
  )
    fail("EOD_RESEARCH_DUPLICATE");
  store.transaction(() => {
    store.db.prepare("DELETE FROM eod_sources").run();
    contexts.forEach((c, i) => {
      assertReviewedActionDataset(
        store.db,
        c,
        inputs[i].review.history.adjustments,
      );
      const existing = store.instrument(c.instrument.id);
      if (
        existing.instrument.symbol !== c.instrument.symbol ||
        existing.instrument.market !== c.instrument.market ||
        existing.instrument.currency !== c.instrument.currency ||
        (existing.instrument.rulesVerified &&
          closedHash(existing.instrument) !== c.instrumentHash)
      )
        fail("EOD_INSTRUMENT_RULES_CHANGED");
      store.putInstrument({ ...existing, instrument: c.instrument });
      store.db
        .prepare(
          "INSERT INTO eod_contexts SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM eod_contexts WHERE id=?)",
        )
        .run(c.id, c.instrument.id, JSON.stringify(c), c.id);
      store.db
        .prepare("INSERT INTO eod_sources VALUES(?,?)")
        .run(c.instrument.id, c.id);
    });
  });
}
export function trustedEodResearch(
  db: Database.Database,
  instrument: Instrument,
  bars: readonly Bar[],
  now: number,
): EodResearchContext | null {
  const row = db
    .prepare(
      "SELECT c.json FROM eod_sources s JOIN eod_contexts c ON c.id=s.context_id WHERE s.instrument_id=?",
    )
    .get(instrument.id) as { json: string } | undefined;
  if (!row) return null;
  const c = JSON.parse(row.json) as EodResearchContext;
  const { id, ...content } = c;
  if (
    c.kind !== "EOD_RESEARCH" ||
    id !== `eod-context:${closedHash(content)}` ||
    !evidenceValid(c, now) ||
    !closedActionEvidenceCurrent(db, c) ||
    c.instrumentHash !== closedHash(instrument) ||
    c.dailyHash !== closedHash(bars)
  )
    return null;
  return c;
}
/** Research only. Formal readiness and activation deliberately keep trustedClosedSupport. */
export function trustedDailyResearch(
  db: Database.Database,
  instrument: Instrument,
  bars: readonly Bar[],
  now: number,
) {
  return (
    trustedClosedSupport(db, instrument, bars, now) ??
    trustedEodResearch(db, instrument, bars, now)
  );
}

/** The only conversion from captured provider samples to research input; no I/O or capability issuance. */
export function reviewedEodHistory(
  input: EodResearchInput,
  now: number,
): { history: LongbridgeContextInput; captureHash: string } {
  const review = structuredClone(input.review);
  validateEodEndpoint(review.endpoint);
  const candidate = prepareLongbridgeHistoryCandidates(
    input.capture,
    review.history.instrument,
  );
  const { scope, captureHash, capture } = candidate;
  if (
    review.expectedCaptureHash !== captureHash ||
    candidate.duplicateTimestamps.length ||
    scope.from !== review.history.historyStartDate ||
    scope.through !== review.history.basisDate ||
    scope.source !== review.history.capability.source ||
    scope.sdk !== review.endpoint.sdk ||
    scope.endpoint !== review.endpoint.endpoint ||
    capture.completedAt! > review.history.capability.checkedAt ||
    capture.completedAt! > now
  )
    fail("EOD_CAPTURE_REVIEW_MISMATCH");
  const starts = new Map<number, { id: string; close: number }>();
  const tradingDates = new Set(
    candidate.calendarPages.flatMap((p) => p.tradingDays),
  );
  const halfDates = [
    ...new Set(candidate.calendarPages.flatMap((p) => p.halfDays)),
  ].sort();
  if (
    new Set(review.halfTradingDates).size !== review.halfTradingDates.length ||
    JSON.stringify(halfDates) !==
      JSON.stringify([...review.halfTradingDates].sort())
  )
    fail("EOD_CAPTURE_CALENDAR_MISMATCH");
  for (
    let at = Date.parse(`${scope.from}T00:00:00Z`);
    at <= Date.parse(`${scope.through}T00:00:00Z`);
    at += 86400000
  ) {
    const date = new Date(at).toISOString().slice(0, 10);
    const result = resolveSession(
      review.history.calendarDays,
      scope.market,
      date,
      now,
    );
    if (
      !result.ok ||
      Boolean(result.session) !== tradingDates.has(date) ||
      (halfDates.includes(date) && !result.session)
    )
      fail("EOD_CAPTURE_CALENDAR_MISMATCH");
    if (result.ok && result.session) {
      const session = result.session;
      starts.set(localSessionTime(date, "00:00", session.timezone), {
        id: session.id,
        close: session.close,
      });
    }
  }
  const rawDaily: LongbridgeContextInput["rawDaily"] = candidate.samples.map(
    (sample) => {
      const session = starts.get(sample.timestamp);
      if (
        !session ||
        sample.period !== "1D" ||
        sample.adjustment !== "RAW" ||
        sample.tradeSession !== 0 ||
        sample.receivedAt < session.close ||
        sample.receivedAt > now
      )
        fail("EOD_CAPTURE_SAMPLE_UNVERIFIED");
      const nativeVolume = new D(sample.volume);
      if (
        !nativeVolume.isInteger() ||
        nativeVolume.isNegative() ||
        nativeVolume.gt(Number.MAX_SAFE_INTEGER)
      )
        fail("EOD_CAPTURE_VOLUME_INVALID");
      const volume = nativeVolume.mul(
        review.endpoint.volumeUnit === "LOT"
          ? review.endpoint.sharesPerLot!
          : 1,
      );
      if (!volume.isFinite() || !volume.isInteger() || volume.isNegative())
        fail("EOD_CAPTURE_VOLUME_INVALID");
      return {
        id: `longbridge:eod:${scope.symbol}:${sample.timestamp}`,
        instrumentId: review.history.instrument.id,
        market: scope.market,
        period: "1D",
        start: sample.timestamp,
        end: session!.close,
        open: sample.open,
        high: sample.high,
        low: sample.low,
        close: sample.close,
        volume: volume.toFixed(),
        turnover: sample.turnover,
        volumeUnit: "SHARE",
        adjustment: "RAW",
        final: true,
        receivedAt: sample.receivedAt,
        source: scope.source,
        providerRevision: `capture:${captureHash}`,
        sessionId: session!.id,
        providerOrigin: {
          captureHash,
          endpoint: scope.endpoint,
          rawVolume: sample.volume,
          rawVolumeUnit: sample.volumeUnit,
          reviewedVolumeUnit: review.endpoint.volumeUnit,
          ...(review.endpoint.sharesPerLot !== undefined
            ? { sharesPerLot: review.endpoint.sharesPerLot }
            : {}),
          endpointReviewId: review.endpoint.evidenceId,
          rawFinality: sample.finality,
        },
      };
    },
  );
  return {
    captureHash,
    history: {
      ...review.history,
      rawDaily,
      probeReportId: `history-capture:${captureHash}`,
      dailyTimestampAnchor: "MARKET_LOCAL_MIDNIGHT",
    },
  };
}
