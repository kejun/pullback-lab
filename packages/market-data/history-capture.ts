import { z } from "zod";
import type { Market } from "../contracts/index.js";
import type { ProviderBarSample } from "./longbridge.js";

export const HISTORY_DAY_MS = 86_400_000;
export const HISTORY_PAGE_DAYS = 90;
export const HISTORY_MAX_DAYS = 1096;
export const HISTORY_PAGE_SAMPLE_LIMIT = 1000;
export const LONGBRIDGE_HISTORY_SOURCE = "longbridge-node-5.2.0";
export interface HistoryWindow {
  from: string;
  through: string;
}
export interface DailyHistoryPage extends HistoryWindow {
  receivedAt: number;
  samples: ProviderBarSample[];
}
export interface HistoryCalendarPage extends HistoryWindow {
  receivedAt: number;
  tradingDays: string[];
  halfDays: string[];
  sessionHoursVerified: false;
}
/** Private, quarantined adapter receipts. SAMPLED means requests finished, never verified coverage. */
export interface LongbridgeHistoryCapture extends HistoryWindow {
  schema: "pullback-lab-longbridge-history-v1";
  source: string;
  sdk: "5.2.0";
  symbol: string;
  market: Market;
  endpoint: "historyCandlesticksByDate";
  adjustment: "RAW";
  startedAt: number;
  completedAt?: number;
  status: "COLLECTING" | "SAMPLED" | "INCOMPLETE";
  pages: DailyHistoryPage[];
  calendarPages: HistoryCalendarPage[];
  capability: "UNKNOWN";
  coverage: "UNKNOWN";
  timestampAnchor: "UNKNOWN";
}
export function historyDateAt(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("INVALID_DATE");
  const at = Date.parse(`${day}T00:00:00Z`);
  if (
    !Number.isSafeInteger(at) ||
    at < 0 ||
    new Date(at).toISOString().slice(0, 10) !== day
  )
    throw new Error("INVALID_DATE");
  return at;
}
export function dailyHistoryWindows(
  from: string,
  through: string,
): HistoryWindow[] {
  const first = historyDateAt(from),
    last = historyDateAt(through);
  if (last < first || last - first >= HISTORY_MAX_DAYS * HISTORY_DAY_MS)
    throw new Error("HISTORY_RANGE_OUT_OF_BOUNDS");
  const windows: HistoryWindow[] = [];
  for (let at = first; at <= last; at += HISTORY_PAGE_DAYS * HISTORY_DAY_MS)
    windows.push({
      from: new Date(at).toISOString().slice(0, 10),
      through: new Date(
        Math.min(last, at + (HISTORY_PAGE_DAYS - 1) * HISTORY_DAY_MS),
      )
        .toISOString()
        .slice(0, 10),
    });
  return windows;
}
export function createHistoryCapture(
  symbol: string,
  window: HistoryWindow,
  startedAt: number,
): LongbridgeHistoryCapture {
  dailyHistoryWindows(window.from, window.through);
  if (!/^[A-Z0-9._-]+\.(US|SH|SZ)$/.test(symbol))
    throw new Error("UNSUPPORTED_SYMBOL_FORMAT");
  return {
    schema: "pullback-lab-longbridge-history-v1",
    source: LONGBRIDGE_HISTORY_SOURCE,
    sdk: "5.2.0",
    symbol,
    market: symbol.endsWith(".US") ? "US" : "CN",
    ...window,
    endpoint: "historyCandlesticksByDate",
    adjustment: "RAW",
    startedAt,
    status: "COLLECTING",
    pages: [],
    calendarPages: [],
    capability: "UNKNOWN",
    coverage: "UNKNOWN",
    timestampAnchor: "UNKNOWN",
  };
}
const at = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      historyDateAt(value);
      return true;
    } catch {
      return false;
    }
  });
const decimal = z
  .string()
  .max(100)
  .regex(/^\d+(?:\.\d+)?$/);
const windowShape = { from: date, through: date };
// This is a raw isolation schema, never an evidence-upload or trust-granting API.
export const historyCaptureSchema = z
  .object({
    schema: z.literal("pullback-lab-longbridge-history-v1"),
    source: z.literal(LONGBRIDGE_HISTORY_SOURCE),
    sdk: z.literal("5.2.0"),
    symbol: z
      .string()
      .max(64)
      .regex(/^[A-Z0-9._-]+\.(US|SH|SZ)$/),
    market: z.enum(["US", "CN"]),
    ...windowShape,
    endpoint: z.literal("historyCandlesticksByDate"),
    adjustment: z.literal("RAW"),
    startedAt: at,
    completedAt: at.optional(),
    status: z.enum(["COLLECTING", "SAMPLED", "INCOMPLETE"]),
    pages: z
      .array(
        z
          .object({
            ...windowShape,
            receivedAt: at,
            samples: z
              .array(
                z
                  .object({
                    symbol: z.string().max(64),
                    period: z.literal("1D"),
                    timestamp: at,
                    receivedAt: at,
                    open: decimal,
                    high: decimal,
                    low: decimal,
                    close: decimal,
                    volume: decimal,
                    turnover: decimal,
                    tradeSession: z.number().int(),
                    adjustment: z.literal("RAW"),
                    finality: z.literal("UNKNOWN"),
                    volumeUnit: z.literal("UNVERIFIED"),
                  })
                  .strict(),
              )
              .max(HISTORY_PAGE_SAMPLE_LIMIT),
          })
          .strict(),
      )
      .max(13),
    calendarPages: z
      .array(
        z
          .object({
            ...windowShape,
            receivedAt: at,
            tradingDays: z.array(date).max(HISTORY_PAGE_SAMPLE_LIMIT),
            halfDays: z.array(date).max(HISTORY_PAGE_SAMPLE_LIMIT),
            sessionHoursVerified: z.literal(false),
          })
          .strict(),
      )
      .max(13),
    capability: z.literal("UNKNOWN"),
    coverage: z.literal("UNKNOWN"),
    timestampAnchor: z.literal("UNKNOWN"),
  })
  .strict();

/** Detect every duplicate and conflicting adapter payload without discarding either receipt. */
export function inspectHistorySamples(samples: readonly ProviderBarSample[]) {
  const identities = new Map<
    string,
    { timestamp: number; payloads: Set<string>; count: number }
  >();
  for (const sample of samples) {
    const key = JSON.stringify([
      sample.symbol,
      sample.period,
      sample.timestamp,
    ]);
    const { receivedAt: _receivedAt, ...payload } = sample;
    const fingerprint = JSON.stringify(
      Object.fromEntries(
        Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    const record = identities.get(key) ?? {
      timestamp: sample.timestamp,
      payloads: new Set<string>(),
      count: 0,
    };
    record.payloads.add(fingerprint);
    record.count++;
    identities.set(key, record);
  }
  return {
    duplicateTimestamps: [...identities.values()]
      .filter((x) => x.count > 1)
      .map((x) => x.timestamp),
    conflictTimestamps: [...identities.values()]
      .filter((x) => x.payloads.size > 1)
      .map((x) => x.timestamp),
  };
}
