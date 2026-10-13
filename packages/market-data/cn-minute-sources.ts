import Decimal from "decimal.js";
import { z } from "zod";
import type { ProviderBarSample } from "./longbridge.js";

export const CN_MINUTE_SOURCE = "longbridge-node-5.2.0";
export const CN_MINUTE_SEED_LIMIT = 60;
export const CN_MINUTE_PACKET_LIMIT = 512;
export const CN_MINUTE_TRADE_LIMIT = 4096;
export const CN_MINUTE_INTEGER_DIGITS = 100;
export const CN_MINUTE_SDK_COMMIT = "b2f749a3c68cc4f05642b37fc790fb711d2dfb13";
export type CnMinutePeriod = "1m" | "5m";
const D = Decimal.clone({ precision: 210 });
const MAX_TIMESTAMP = Date.UTC(9999, 11, 30, 23, 59, 59, 999);
const at = z.number().int().nonnegative().max(MAX_TIMESTAMP);
const integer = z.string().max(CN_MINUTE_INTEGER_DIGITS).regex(/^\d+$/);
const decimal = z
  .string()
  .max(100)
  .regex(/^\d+(?:\.\d+)?$/);
const positiveDecimal = decimal.refine(
  (value) =>
    value.length <= 100 && /^\d+(?:\.\d+)?$/.test(value) && new D(value).gt(0),
);
const symbol = z
  .string()
  .max(34)
  .regex(/^[A-Z0-9._-]{1,30}\.(SH|SZ)$/);
const period = z.enum(["1m", "5m"]);

export interface ProviderEndpointVolume {
  kind: "providerRaw";
  endpoint: "candlesticks" | "pushTrades" | "sdkMixedCandlesticks";
  volume: string;
  unit: "SHARE" | "LOT";
  /** Explicit endpoint interpretation, never a security's order lotSize. */
  sharesPerUnit: string;
}
export interface NormalizedEndpointVolume {
  kind: "normalizedShare";
  volume: string;
  unit: "SHARE";
  original: ProviderEndpointVolume;
  /** This function proves arithmetic only, not the endpoint's actual unit. */
  unitVerification: "UNVERIFIED";
}
const endpointVolumeSchema = z
  .object({
    kind: z.literal("providerRaw"),
    endpoint: z.enum(["candlesticks", "pushTrades", "sdkMixedCandlesticks"]),
    volume: integer,
    unit: z.enum(["SHARE", "LOT"]),
    sharesPerUnit: integer,
  })
  .strict();

/** Exact bounded arithmetic. Re-normalizing its output, even with an added factor, fails. */
export function normalizeEndpointVolume(
  input: ProviderEndpointVolume,
): NormalizedEndpointVolume {
  const parsed = endpointVolumeSchema.safeParse(input);
  if (!parsed.success) throw new Error("INVALID_ENDPOINT_VOLUME");
  const raw = parsed.data;
  if (raw.endpoint === "sdkMixedCandlesticks")
    throw new Error("SDK_MIXED_CANDLESTICK_REJECTED");
  const factor = new D(raw.sharesPerUnit);
  if (factor.lte(0) || (raw.unit === "SHARE" && !factor.eq(1)))
    throw new Error("INVALID_ENDPOINT_FACTOR");
  // At most 200 significant digits; precision 210 cannot round either operand's product.
  const volume = new D(raw.volume).mul(factor).toFixed(0);
  return {
    kind: "normalizedShare",
    volume,
    unit: "SHARE",
    original: { ...raw },
    unitVerification: "UNVERIFIED",
  };
}

export interface CnMinuteSourceTrade {
  timestamp: number;
  price: string;
  volume: string;
  tradeType: string;
  direction: number;
  tradeSession: number;
}
/** Structurally compatible with the raw observer; packet array indexes are not supplier sequence. */
export interface CnMinuteSourcePacket {
  symbol: string;
  receivedAt: number;
  providerSequence: null;
  trades: CnMinuteSourceTrade[];
}
export interface CnMinuteSourcesCapture {
  schema: "pullback-lab-cn-minute-sources-v1";
  source: typeof CN_MINUTE_SOURCE;
  startedAt: number;
  completedAt?: number;
  status: "COLLECTING" | "SAMPLED" | "INCOMPLETE";
  instruments: Array<{ symbol: string; securityBoard: number | null }>;
  seeds: Array<{
    symbol: string;
    period: CnMinutePeriod;
    endpoint: "candlesticks";
    receivedAt: number;
    samples: ProviderBarSample[];
  }>;
  /** pushTrades endpoint, all original volume units UNVERIFIED. */
  tradePackets: CnMinuteSourcePacket[];
}
export function createCnMinuteSourcesCapture(
  startedAt: number,
): CnMinuteSourcesCapture {
  if (!at.safeParse(startedAt).success) throw new Error("INVALID_CN_TIMESTAMP");
  return {
    schema: "pullback-lab-cn-minute-sources-v1",
    source: CN_MINUTE_SOURCE,
    startedAt,
    status: "COLLECTING",
    instruments: [],
    seeds: [],
    tradePackets: [],
  };
}
const sampleSchema = z
  .object({
    symbol,
    period,
    timestamp: at,
    receivedAt: at,
    open: positiveDecimal,
    high: positiveDecimal,
    low: positiveDecimal,
    close: positiveDecimal,
    volume: integer,
    turnover: decimal,
    tradeSession: z.number().int().min(0).max(3),
    adjustment: z.literal("RAW"),
    finality: z.literal("UNKNOWN"),
    volumeUnit: z.literal("UNVERIFIED"),
  })
  .strict();
const captureSchema = z
  .object({
    schema: z.literal("pullback-lab-cn-minute-sources-v1"),
    source: z.literal(CN_MINUTE_SOURCE),
    startedAt: at,
    completedAt: at.optional(),
    status: z.enum(["COLLECTING", "SAMPLED", "INCOMPLETE"]),
    instruments: z
      .array(
        z
          .object({
            symbol,
            securityBoard: z.number().int().nonnegative().max(26).nullable(),
          })
          .strict(),
      )
      .max(2),
    seeds: z
      .array(
        z
          .object({
            symbol,
            period,
            endpoint: z.literal("candlesticks"),
            receivedAt: at,
            samples: z.array(sampleSchema).max(CN_MINUTE_SEED_LIMIT),
          })
          .strict(),
      )
      .max(4),
    tradePackets: z
      .array(
        z
          .object({
            symbol,
            receivedAt: at,
            providerSequence: z.null(),
            trades: z
              .array(
                z
                  .object({
                    timestamp: at,
                    price: positiveDecimal,
                    volume: integer,
                    tradeType: z.string().max(32),
                    direction: z.number().int().min(0).max(2),
                    tradeSession: z.number().int().min(0).max(3),
                  })
                  .strict(),
              )
              .max(CN_MINUTE_TRADE_LIMIT),
          })
          .strict(),
      )
      .max(CN_MINUTE_PACKET_LIMIT),
  })
  .strict();

export type CnTimestampClassification =
  | "ORDINARY_CANDIDATE"
  | "CLOSE_BOUNDARY_LABEL"
  | "MIDDAY_BREAK"
  | "OUT_OF_SESSION";
export interface CnMinuteTimestampLabel {
  originalTimestamp: number;
  period: CnMinutePeriod;
  source: "seed" | "trade";
  localDate: string;
  localClock: string;
  classification: CnTimestampClassification;
  /** A clock-label comparison key only. Never the start of an accepted Bar. */
  candidateLabelAt: number | null;
  /** Trade-only interpretation of the pinned SDK algorithm. No historical inference. */
  sdkLabelAt: number | null;
  canonicalInterval: null;
  meaning: "UNKNOWN";
  calendar: "UNKNOWN";
  finality: "UNKNOWN";
}
const cnClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
/**
 * Clock labels, not a trading calendar or MarketSession. The pinned SDK's cn_time.rs
 * and market.rs map Trade event times [15:00,15:10) to 15:00. This is neither
 * a tradable extra session nor a 15:10 timer/finality rule. Seeds do not inherit it.
 */
export function labelCnMinuteTimestamp(
  timestamp: number,
  requestedPeriod: CnMinutePeriod,
  source: "seed" | "trade",
): CnMinuteTimestampLabel {
  if (
    !at.safeParse(timestamp).success ||
    !period.safeParse(requestedPeriod).success ||
    (source !== "seed" && source !== "trade")
  )
    throw new Error("INVALID_CN_TIMESTAMP");
  const parts = Object.fromEntries(
    cnClock
      .formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const milliseconds = timestamp % 1000;
  const clockMs =
    ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 +
      Number(parts.second)) *
      1000 +
    milliseconds;
  const duration = requestedPeriod === "1m" ? 60_000 : 300_000;
  const minute = 60_000;
  let classification: CnTimestampClassification = "OUT_OF_SESSION";
  let candidateLabelAt: number | null = null;
  let sdkLabelAt: number | null = null;
  if (
    (clockMs >= 570 * minute && clockMs < 690 * minute) ||
    (clockMs >= 780 * minute && clockMs < 900 * minute)
  ) {
    classification = "ORDINARY_CANDIDATE";
    const sessionStart = clockMs < 690 * minute ? 570 * minute : 780 * minute;
    const bucket = timestamp - ((clockMs - sessionStart) % duration);
    // A misaligned seed remains visible, but cannot be shifted into a bucket.
    candidateLabelAt =
      source === "trade" || bucket === timestamp ? bucket : null;
    if (source === "trade") sdkLabelAt = bucket;
  } else if (
    clockMs === 900 * minute ||
    (source === "trade" && clockMs >= 900 * minute && clockMs < 910 * minute)
  ) {
    classification = "CLOSE_BOUNDARY_LABEL";
    candidateLabelAt = timestamp - (clockMs - 900 * minute);
    if (source === "trade") sdkLabelAt = candidateLabelAt;
  } else if (clockMs >= 690 * minute && clockMs < 780 * minute) {
    classification = "MIDDAY_BREAK";
  }
  return {
    originalTimestamp: timestamp,
    period: requestedPeriod,
    source,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localClock: `${parts.hour}:${parts.minute}:${parts.second}.${String(milliseconds).padStart(3, "0")}`,
    classification,
    candidateLabelAt,
    sdkLabelAt,
    canonicalInterval: null,
    meaning: "UNKNOWN",
    calendar: "UNKNOWN",
    finality: "UNKNOWN",
  };
}

const BASE_REASONS = [
  "DIAGNOSTIC_ONLY",
  "UNITS_UNVERIFIED",
  "SDK_TICK_CONTINUITY_UNPROVEN",
  "CALENDAR_SESSION_UNVERIFIED",
  "FINALITY_UNVERIFIED",
  "CLOCK_UNVERIFIED",
  "SDK_MIXED_CANDLESTICK_REJECTED",
  "RECEIVE_ORDER_NOT_PROVIDER_SEQUENCE",
] as const;
const REASONS = [
  ...BASE_REASONS,
  "CAPTURE_NOT_COMPLETE",
  "NO_SOURCE_SAMPLES",
  "HISTORICAL_SEED_UNIT_AMBIGUOUS",
  "SDK_INTERPRETATION_NOT_VERIFIED",
  "INSTRUMENT_KIND_UNVERIFIED",
  "NON_ORDINARY_TRADE_UNINTERPRETED",
  "SOURCE_OVERLAP_MERGE_REJECTED",
  "NO_OVERLAP_DOES_NOT_PROVE_CONTINUITY",
  "CLOSING_BOUNDARY_NOT_REGULAR_INTERVAL",
  "OUTSIDE_ORDINARY_CLOCK_RANGE",
  "UNALIGNED_SEED_LABEL",
  "RECEIVE_ORDER_REGRESSION",
  "TRADE_EVENT_TIME_REGRESSION",
  "INVALID_DIAGNOSTIC",
] as const;
export type CnMinuteDiagnosticReason = (typeof REASONS)[number];
export interface CnMinuteDiagnosticCounts {
  seedReceipts: number;
  seedSamples: number;
  tradePackets: number;
  trades: number;
  /** These four counts count period labels: each trade has a 1m and a 5m label. */
  ordinaryCandidates: number;
  closingBoundaryLabels: number;
  middayBreakLabels: number;
  outOfSessionLabels: number;
  overlappingBuckets: number;
  receiveOrderRegressions: number;
}
interface SeedDiagnostic {
  seedIndex: number;
  sampleIndex: number;
  originalVolume: { volume: string; unit: "UNVERIFIED" };
  unitCandidates: {
    SHARE: NormalizedEndpointVolume;
    LOT_100_SHARES: NormalizedEndpointVolume;
  };
  selectedUnit: null;
  time: CnMinuteTimestampLabel;
}
interface TradeDiagnostic {
  packetIndex: number;
  tradeIndex: number;
  originalVolume: { volume: string; unit: "UNVERIFIED" };
  instrumentKind: "SDK_CN_EQUITY_BOARD" | "UNKNOWN";
  interpretation: "SDK_INTERPRETATION_NOT_VERIFIED" | "UNKNOWN";
  assumption: "SDK_CN_TRADE_BRANCH" | null;
  conditionalShareEquivalent: NormalizedEndpointVolume | null;
  times: CnMinuteTimestampLabel[];
}
interface SourceOverlap {
  symbol: string;
  period: CnMinutePeriod;
  labelAt: number;
  seedReferences: Array<{ seedIndex: number; sampleIndex: number }>;
  tradeReferences: Array<{ packetIndex: number; tradeIndex: number }>;
  decision: "REJECT_MERGE";
}
export interface CnMinuteSourcesDiagnostic {
  schema: "pullback-lab-cn-minute-sources-diagnostic-v1";
  status: CnMinuteSourcesCapture["status"];
  capability: "UNKNOWN";
  liveEligible: false;
  continuity: "UNKNOWN";
  coverage: "UNKNOWN";
  finality: "UNKNOWN";
  sdkSourceCommit: typeof CN_MINUTE_SDK_COMMIT;
  capture: CnMinuteSourcesCapture;
  seedDiagnostics: SeedDiagnostic[];
  tradeDiagnostics: TradeDiagnostic[];
  overlaps: SourceOverlap[];
  sourceMerge: "REJECTED";
  mixedSdkCandlesticks: "REJECTED";
  receiveOrder: {
    meaning: "LOCAL_RECEIPT_ARRAY_ONLY";
    providerSequence: null;
    regressions: Array<{
      packetIndex: number;
      previousReceivedAt: number;
      receivedAt: number;
    }>;
    eventTimeRegressions: Array<{
      packetIndex: number;
      tradeIndex: number;
      previousTimestamp: number;
      timestamp: number;
    }>;
  };
  counts: CnMinuteDiagnosticCounts;
  reasons: CnMinuteDiagnosticReason[];
}
function equityBoardFor(symbol: string, board: number | null | undefined) {
  return (
    board !== null &&
    board !== undefined &&
    (symbol.endsWith(".SH")
      ? [13, 14, 15].includes(board)
      : [18, 19, 20, 21].includes(board))
  );
}
function convert(
  volume: string,
  endpoint: "candlesticks" | "pushTrades",
  unit: "SHARE" | "LOT",
  sharesPerUnit: string,
) {
  return normalizeEndpointVolume({
    kind: "providerRaw",
    endpoint,
    volume,
    unit,
    sharesPerUnit,
  });
}

/** Full private, bounded diagnostic. It never emits normalized Bars, merges sources or grants capability. */
export function diagnoseCnMinuteSources(
  input: CnMinuteSourcesCapture,
): CnMinuteSourcesDiagnostic {
  // Reject oversized containers before a schema traversal or cloning any receipts.
  const raw = record(input);
  if (
    !Array.isArray(raw.instruments) ||
    raw.instruments.length > 2 ||
    !Array.isArray(raw.seeds) ||
    raw.seeds.length > 4 ||
    !Array.isArray(raw.tradePackets) ||
    raw.tradePackets.length > CN_MINUTE_PACKET_LIMIT ||
    raw.seeds.some(
      (seed) =>
        !Array.isArray(record(seed).samples) ||
        (record(seed).samples as unknown[]).length > CN_MINUTE_SEED_LIMIT,
    )
  )
    throw new Error("INVALID_CN_SOURCE_CAPTURE");
  let tradeCount = 0;
  for (const packet of raw.tradePackets) {
    const trades = record(packet).trades;
    if (
      !Array.isArray(trades) ||
      (tradeCount += trades.length) > CN_MINUTE_TRADE_LIMIT
    )
      throw new Error("INVALID_CN_SOURCE_CAPTURE");
  }
  const parsed = captureSchema.safeParse(input);
  if (!parsed.success) throw new Error("INVALID_CN_SOURCE_CAPTURE");
  const capture = parsed.data;
  const symbols = new Set([
    ...capture.instruments.map((item) => item.symbol),
    ...capture.seeds.map((item) => item.symbol),
    ...capture.tradePackets.map((item) => item.symbol),
  ]);
  if (
    symbols.size > 2 ||
    new Set(capture.instruments.map((item) => item.symbol)).size !==
      capture.instruments.length ||
    capture.tradePackets.reduce(
      (sum, packet) => sum + packet.trades.length,
      0,
    ) > CN_MINUTE_TRADE_LIMIT ||
    (capture.completedAt !== undefined &&
      capture.completedAt < capture.startedAt) ||
    (capture.status !== "COLLECTING" && capture.completedAt === undefined) ||
    capture.seeds.some((seed) =>
      seed.samples.some(
        (sample) =>
          sample.symbol !== seed.symbol || sample.period !== seed.period,
      ),
    )
  )
    throw new Error("INVALID_CN_SOURCE_CAPTURE");
  if (
    capture.seeds.some((seed) =>
      seed.samples.some(
        (sample) =>
          new D(sample.high).lt(D.max(sample.open, sample.close, sample.low)) ||
          new D(sample.low).gt(D.min(sample.open, sample.close, sample.high)),
      ),
    )
  )
    throw new Error("INVALID_CN_SOURCE_CAPTURE");
  const counts: CnMinuteDiagnosticCounts = {
    seedReceipts: capture.seeds.length,
    seedSamples: 0,
    tradePackets: capture.tradePackets.length,
    trades: 0,
    ordinaryCandidates: 0,
    closingBoundaryLabels: 0,
    middayBreakLabels: 0,
    outOfSessionLabels: 0,
    overlappingBuckets: 0,
    receiveOrderRegressions: 0,
  };
  const reasons = new Set<CnMinuteDiagnosticReason>(BASE_REASONS);
  if (capture.status !== "SAMPLED") reasons.add("CAPTURE_NOT_COMPLETE");
  const label = (
    timestamp: number,
    period: CnMinutePeriod,
    source: "seed" | "trade",
  ) => {
    const result = labelCnMinuteTimestamp(timestamp, period, source);
    switch (result.classification) {
      case "ORDINARY_CANDIDATE":
        counts.ordinaryCandidates++;
        if (result.candidateLabelAt === null)
          reasons.add("UNALIGNED_SEED_LABEL");
        break;
      case "CLOSE_BOUNDARY_LABEL":
        counts.closingBoundaryLabels++;
        reasons.add("CLOSING_BOUNDARY_NOT_REGULAR_INTERVAL");
        break;
      case "MIDDAY_BREAK":
        counts.middayBreakLabels++;
        reasons.add("OUTSIDE_ORDINARY_CLOCK_RANGE");
        break;
      case "OUT_OF_SESSION":
        counts.outOfSessionLabels++;
        reasons.add("OUTSIDE_ORDINARY_CLOCK_RANGE");
        break;
    }
    return result;
  };
  const buckets = new Map<string, SourceOverlap>();
  const bucket = (symbol: string, time: CnMinuteTimestampLabel) => {
    if (time.candidateLabelAt === null) return;
    const key = JSON.stringify([symbol, time.period, time.candidateLabelAt]);
    let result = buckets.get(key);
    if (!result) {
      result = {
        symbol,
        period: time.period,
        labelAt: time.candidateLabelAt,
        seedReferences: [],
        tradeReferences: [],
        decision: "REJECT_MERGE",
      };
      buckets.set(key, result);
    }
    return result;
  };
  const seedDiagnostics: SeedDiagnostic[] = [];
  capture.seeds.forEach((seed, seedIndex) => {
    seed.samples.forEach((sample, sampleIndex) => {
      counts.seedSamples++;
      reasons.add("HISTORICAL_SEED_UNIT_AMBIGUOUS");
      const time = label(sample.timestamp, seed.period, "seed");
      seedDiagnostics.push({
        seedIndex,
        sampleIndex,
        originalVolume: { volume: sample.volume, unit: "UNVERIFIED" },
        unitCandidates: {
          SHARE: convert(sample.volume, "candlesticks", "SHARE", "1"),
          LOT_100_SHARES: convert(sample.volume, "candlesticks", "LOT", "100"),
        },
        selectedUnit: null,
        time,
      });
      bucket(seed.symbol, time)?.seedReferences.push({
        seedIndex,
        sampleIndex,
      });
    });
  });
  const tradeDiagnostics: TradeDiagnostic[] = [];
  const receiveOrder: CnMinuteSourcesDiagnostic["receiveOrder"] = {
    meaning: "LOCAL_RECEIPT_ARRAY_ONLY",
    providerSequence: null,
    regressions: [],
    eventTimeRegressions: [],
  };
  const previousEvent = new Map<string, number>();
  capture.tradePackets.forEach((packet, packetIndex) => {
    const previous = capture.tradePackets[packetIndex - 1];
    if (previous && packet.receivedAt < previous.receivedAt) {
      receiveOrder.regressions.push({
        packetIndex,
        previousReceivedAt: previous.receivedAt,
        receivedAt: packet.receivedAt,
      });
      reasons.add("RECEIVE_ORDER_REGRESSION");
    }
    const board = capture.instruments.find(
      (item) => item.symbol === packet.symbol,
    )?.securityBoard;
    const equity = equityBoardFor(packet.symbol, board);
    packet.trades.forEach((trade, tradeIndex) => {
      counts.trades++;
      const oldTimestamp = previousEvent.get(packet.symbol);
      if (oldTimestamp !== undefined && trade.timestamp < oldTimestamp) {
        receiveOrder.eventTimeRegressions.push({
          packetIndex,
          tradeIndex,
          previousTimestamp: oldTimestamp,
          timestamp: trade.timestamp,
        });
        reasons.add("TRADE_EVENT_TIME_REGRESSION");
      }
      previousEvent.set(packet.symbol, trade.timestamp);
      const ordinary = trade.tradeType === "" && trade.tradeSession === 0;
      if (!equity) reasons.add("INSTRUMENT_KIND_UNVERIFIED");
      if (!ordinary) reasons.add("NON_ORDINARY_TRADE_UNINTERPRETED");
      const interpreted = equity && ordinary;
      if (interpreted) reasons.add("SDK_INTERPRETATION_NOT_VERIFIED");
      const times = (["1m", "5m"] as const).map((period) => {
        const time = label(trade.timestamp, period, "trade");
        // Unknown boards and nonordinary sessions/types do not establish the SDK Trade branch.
        return interpreted ? time : { ...time, sdkLabelAt: null };
      });
      // Non-intraday/type events remain visible, but cannot supply a comparable ordinary Trade bucket.
      if (ordinary && equity)
        times.forEach((time) =>
          bucket(packet.symbol, time)?.tradeReferences.push({
            packetIndex,
            tradeIndex,
          }),
        );
      tradeDiagnostics.push({
        packetIndex,
        tradeIndex,
        originalVolume: { volume: trade.volume, unit: "UNVERIFIED" },
        instrumentKind: equity ? "SDK_CN_EQUITY_BOARD" : "UNKNOWN",
        interpretation: interpreted
          ? "SDK_INTERPRETATION_NOT_VERIFIED"
          : "UNKNOWN",
        assumption: interpreted ? "SDK_CN_TRADE_BRANCH" : null,
        conditionalShareEquivalent: interpreted
          ? convert(trade.volume, "pushTrades", "LOT", "100")
          : null,
        times,
      });
    });
  });
  const overlaps = [...buckets.values()].filter(
    (item) => item.seedReferences.length && item.tradeReferences.length,
  );
  counts.overlappingBuckets = overlaps.length;
  counts.receiveOrderRegressions = receiveOrder.regressions.length;
  if (overlaps.length) reasons.add("SOURCE_OVERLAP_MERGE_REJECTED");
  else if (counts.seedSamples && counts.trades)
    reasons.add("NO_OVERLAP_DOES_NOT_PROVE_CONTINUITY");
  if (!counts.seedSamples && !counts.trades) reasons.add("NO_SOURCE_SAMPLES");
  return {
    schema: "pullback-lab-cn-minute-sources-diagnostic-v1",
    status: capture.status,
    capability: "UNKNOWN",
    liveEligible: false,
    continuity: "UNKNOWN",
    coverage: "UNKNOWN",
    finality: "UNKNOWN",
    sdkSourceCommit: CN_MINUTE_SDK_COMMIT,
    capture,
    seedDiagnostics,
    tradeDiagnostics,
    overlaps,
    sourceMerge: "REJECTED",
    mixedSdkCandlesticks: "REJECTED",
    receiveOrder,
    counts,
    reasons: [...reasons],
  };
}
const countLimits: Record<keyof CnMinuteDiagnosticCounts, number> = {
  seedReceipts: 4,
  seedSamples: 4 * CN_MINUTE_SEED_LIMIT,
  tradePackets: CN_MINUTE_PACKET_LIMIT,
  trades: CN_MINUTE_TRADE_LIMIT,
  ordinaryCandidates: 4 * CN_MINUTE_SEED_LIMIT + 2 * CN_MINUTE_TRADE_LIMIT,
  closingBoundaryLabels: 4 * CN_MINUTE_SEED_LIMIT + 2 * CN_MINUTE_TRADE_LIMIT,
  middayBreakLabels: 4 * CN_MINUTE_SEED_LIMIT + 2 * CN_MINUTE_TRADE_LIMIT,
  outOfSessionLabels: 4 * CN_MINUTE_SEED_LIMIT + 2 * CN_MINUTE_TRADE_LIMIT,
  overlappingBuckets: 4 * CN_MINUTE_SEED_LIMIT,
  receiveOrderRegressions: CN_MINUTE_PACKET_LIMIT - 1,
};
function record(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
/** Counts and local reason-code allowlists only: no symbols, dates, prices, quantities or free text. */
export function summarizeCnMinuteSources(input: CnMinuteSourcesDiagnostic) {
  const diagnostic = record(input);
  const sourceCounts = record(diagnostic.counts);
  const counts = Object.fromEntries(
    Object.entries(countLimits).map(([key, maximum]) => {
      const value = sourceCounts[key];
      return [
        key,
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= maximum
          ? value
          : 0,
      ];
    }),
  ) as unknown as CnMinuteDiagnosticCounts;
  const reasons = new Set<CnMinuteDiagnosticReason>(BASE_REASONS);
  if (Array.isArray(diagnostic.reasons))
    for (const reason of diagnostic.reasons.slice(0, REASONS.length))
      if (
        typeof reason === "string" &&
        (REASONS as readonly string[]).includes(reason)
      )
        reasons.add(reason as CnMinuteDiagnosticReason);
  const status =
    diagnostic.status === "SAMPLED" ||
    diagnostic.status === "COLLECTING" ||
    diagnostic.status === "INCOMPLETE"
      ? diagnostic.status
      : "INCOMPLETE";
  if (diagnostic.schema !== "pullback-lab-cn-minute-sources-diagnostic-v1")
    reasons.add("INVALID_DIAGNOSTIC");
  return {
    schema: "pullback-lab-cn-minute-sources-summary-v1" as const,
    status,
    capability: "UNKNOWN" as const,
    liveEligible: false as const,
    continuity: "UNKNOWN" as const,
    coverage: "UNKNOWN" as const,
    finality: "UNKNOWN" as const,
    counts,
    reasons: [...reasons],
  };
}
