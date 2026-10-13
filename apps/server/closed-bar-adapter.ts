import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import Decimal from "decimal.js";
import type { Bar, Instrument } from "../../packages/contracts/index.js";
import {
  assessCapability,
  type CapabilityEvidence,
} from "../../packages/market-data/capabilities.js";
import {
  resolveSession,
  type CalendarDay,
  type MarketSession,
} from "../../packages/market-data/calendar.js";
import type { RawBar } from "../../packages/market-data/normalize.js";

/** In-process dependency supplied by an audited server adapter, NEVER deserialized from HTTP or an upload. */
export interface ClosedBarContext {
  source: string;
  probeReportId: string;
  instrumentRulesId: string;
  dailyHistoryId: string;
  adjustmentEvidenceId: string;
  capability: CapabilityEvidence;
  instrument: Instrument;
  calendar: CalendarDay;
  /** Complete, split-only adjusted daily history on the target session's raw price basis. */
  daily: (Bar & { adjustmentVerified: true; synthetic?: false })[];
  basisDate: string;
  basisKnownAt: number;
}
export type ClosedMinute = Omit<
  RawBar,
  "receivedAt" | "synthetic" | "period"
> & { period: "1m" };
export interface ClosedQuote {
  instrumentId: string;
  sessionId: string;
  source: string;
  id: string;
  /** Last regular-session trade, used as an estimate, never represented as an executable ask. */
  price: string;
  at: number;
}
export interface ClosedBarSink {
  minute(value: ClosedMinute): void;
  quote(value: ClosedQuote): void;
  /** Explicit no-trade coverage is preserved, but never fabricated into OHLC. */
  noTrade(value: {
    instrumentId: string;
    sessionId: string;
    source: string;
    start: number;
    end: number;
    evidenceId: string;
  }): void;
  disconnect(reason: string): void;
}
export interface ClosedBarAdapter {
  contexts(): readonly ClosedBarContext[];
  /** Establish a read-only context and retain this connection's sink; subscribe only via setSubscriptions. */
  start(sink: ClosedBarSink): Promise<void>;
  setSubscriptions(instrumentIds: readonly string[]): Promise<void>;
  stop(): Promise<void>;
}
export interface StoredClosedContext extends ClosedBarContext {
  id: string;
  session: MarketSession;
  dailyHash: string;
  instrumentHash: string;
}
export const closedHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function validateClosedContext(
  input: ClosedBarContext,
  now: number,
): StoredClosedContext {
  const c = structuredClone(input);
  const fail = (code: string): never => {
    throw new Error(code);
  };
  if (
    ![
      c.source,
      c.probeReportId,
      c.instrumentRulesId,
      c.dailyHistoryId,
      c.adjustmentEvidenceId,
    ].every(
      (x) => typeof x === "string" && x.trim().length > 0 && x.length <= 500,
    )
  )
    fail("CLOSED_PROVENANCE_MISSING");
  if (
    c.instrument.id.startsWith("DEMO-") ||
    c.instrument.rulesVerified !== true ||
    c.instrument.market !== c.capability.market ||
    c.source !== c.capability.source
  )
    fail("CLOSED_INSTRUMENT_UNVERIFIED");
  if (
    !Number.isSafeInteger(c.instrument.qMin) ||
    c.instrument.qMin < 1 ||
    !Number.isSafeInteger(c.instrument.qStep) ||
    c.instrument.qStep < 1 ||
    !new Decimal(c.instrument.tick).gt(0)
  )
    fail("CLOSED_INSTRUMENT_UNVERIFIED");
  if (
    typeof c.instrument.sellSameDay !== "boolean" ||
    c.instrument.currency !== (c.instrument.market === "US" ? "USD" : "CNY")
  )
    fail("CLOSED_INSTRUMENT_UNVERIFIED");
  if (
    ![
      "apiEntitlementVerified",
      "historicalReadVerified",
      "realtimeEntitlementVerified",
      "unitsVerified",
      "calendarVerified",
      "completeMinutes",
      "finalityContractVerified",
      "sequenceContractVerified",
      "continuousTradesVerified",
    ].every(
      (k) =>
        typeof (c.capability as unknown as Record<string, unknown>)[k] ===
        "boolean",
    ) ||
    c.calendar.verified !== true
  )
    fail("CLOSED_VERIFICATION_INVALID");
  if (
    !["LIVE_CLOSED_BAR", "LIVE_TICK"].includes(
      assessCapability(c.capability, now).level,
    )
  )
    fail("LIVE_CAPABILITY_UNVERIFIED");
  const resolved = resolveSession(
    [c.calendar],
    c.instrument.market,
    c.basisDate,
    now,
  );
  if (!resolved.ok || !resolved.session) fail("CLOSED_SESSION_UNVERIFIED");
  const session = (resolved as { ok: true; session: MarketSession }).session;
  if (
    !Number.isSafeInteger(c.basisKnownAt) ||
    c.basisKnownAt > now ||
    c.basisDate !== c.calendar.date ||
    c.daily.length < 250 ||
    c.daily.length > 10000
  )
    fail("CLOSED_DAILY_INCOMPLETE");
  const ids = new Set<string>();
  for (let i = 0; i < c.daily.length; i++) {
    const b = c.daily[i];
    if (
      !b.final ||
      b.adjustmentVerified !== true ||
      b.synthetic ||
      b.id.startsWith("synthetic:") ||
      ids.has(b.id) ||
      !Number.isSafeInteger(b.time) ||
      !Number.isSafeInteger(b.receivedAt) ||
      b.receivedAt > c.basisKnownAt ||
      b.receivedAt < b.time * 1000 ||
      b.time * 1000 >= session.open ||
      (i > 0 && c.daily[i - 1].time >= b.time) ||
      !b.adjustmentVersion
    )
      fail("CLOSED_DAILY_UNVERIFIED");
    ids.add(b.id);
    if (
      ![b.open, b.high, b.low, b.close, b.volume].every(
        (x) => typeof x === "string" && /^\d+(\.\d+)?$/.test(x),
      )
    )
      fail("CLOSED_DAILY_INVALID");
    const [o, h, l, cl, v] = [b.open, b.high, b.low, b.close, b.volume].map(
      (x) => new Decimal(x),
    );
    if (
      ![o, h, l, cl].every((x) => x.isFinite() && x.gt(0)) ||
      !v.isFinite() ||
      v.lt(0) ||
      l.gt(Decimal.min(o, cl, h)) ||
      h.lt(Decimal.max(o, cl, l))
    )
      fail("CLOSED_DAILY_INVALID");
  }
  if (new Set(c.daily.map((b) => b.adjustmentVersion)).size !== 1)
    fail("CLOSED_DAILY_MIXED_BASIS");
  return {
    ...c,
    id: `closed-context:${closedHash(c)}`,
    session,
    dailyHash: closedHash(c.daily),
    instrumentHash: closedHash(c.instrument),
  };
}
/** Exact server-installed history only; manual research and old snapshots cannot grant this capability. */
export function trustedClosedSupport(
  db: Database.Database,
  instrument: Instrument,
  bars: readonly Bar[],
  now: number,
  sessionDate?: string,
): StoredClosedContext | null {
  const row = db
    .prepare(
      "SELECT c.json FROM closed_sources s JOIN closed_contexts c ON c.id=s.context_id WHERE s.instrument_id=?",
    )
    .get(instrument.id) as { json: string } | undefined;
  if (!row) return null;
  const c = JSON.parse(row.json) as StoredClosedContext;
  if (
    c.instrumentHash !== closedHash(instrument) ||
    c.dailyHash !== closedHash(bars) ||
    (sessionDate && c.session.date !== sessionDate) ||
    !["LIVE_CLOSED_BAR", "LIVE_TICK"].includes(
      assessCapability(c.capability, now).level,
    )
  )
    return null;
  return c;
}
