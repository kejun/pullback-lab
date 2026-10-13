import type { Instrument } from "../../packages/contracts/index.js";
import type { CapabilityEvidence } from "../../packages/market-data/capabilities.js";
import {
  adjustForScheduledSession,
  type AdjustmentDataset,
} from "../../packages/market-data/adjustments.js";
import {
  resolveSession,
  type CalendarDay,
  type MarketSession,
} from "../../packages/market-data/calendar.js";
import {
  normalizeBar,
  type RawBar,
} from "../../packages/market-data/normalize.js";
import {
  closedHash,
  validateClosedContext,
  type ClosedBarContext,
} from "./closed-bar-adapter.js";
import { LONGBRIDGE_SOURCE } from "./longbridge-closed-bar-adapter.js";

/** Server-code input only. Source authenticity and coverage declarations still need independent review. */
export interface LongbridgeContextInput {
  probeReportId: string;
  instrumentRulesId: string;
  adjustmentEvidenceId: string;
  /** Reviewed binding to the existing local immutable action snapshot; never copy automatically at startup. */
  actionEvidenceVersion?: string | null;
  instrument: Instrument;
  capability: CapabilityEvidence;
  historyStartDate: string;
  basisDate: string;
  /** Every civil date, including closures, from historyStartDate through basisDate. Never extrapolate today's hours. */
  calendarDays: readonly CalendarDay[];
  rawDaily: readonly RawBar[];
  adjustments: AdjustmentDataset;
}
export class ProductionMarketError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new ProductionMarketError(code);
}
function dateAt(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("HISTORY_DATE_INVALID");
  const at = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date)
    return fail("HISTORY_DATE_INVALID");
  return at;
}

/** Mechanical completeness/scale validation, NOT an attestation of external facts. No I/O. */
export function buildLongbridgeContext(
  input: LongbridgeContextInput,
  now: number,
): ClosedBarContext {
  const c = structuredClone(input);
  const actionVersion = c.actionEvidenceVersion ?? null;
  if (
    actionVersion !== null &&
    !/^action-evidence-v1:[a-f0-9]{64}$/.test(actionVersion)
  )
    fail("HISTORY_ACTION_BINDING_MISMATCH");
  if (!Number.isSafeInteger(now) || now < 0) fail("HISTORY_CUTOFF_INVALID");
  const from = dateAt(c.historyStartDate),
    through = dateAt(c.basisDate);
  const days = (through - from) / 86_400_000 + 1;
  if (
    days < 251 ||
    days > 15000 ||
    c.calendarDays.length > 30000 ||
    c.rawDaily.length < 250 ||
    c.rawDaily.length > 10000
  )
    fail("HISTORY_WINDOW_INVALID");
  if (
    c.capability.source !== LONGBRIDGE_SOURCE ||
    c.capability.market !== c.instrument.market ||
    !/^[A-Z0-9._-]+\.(US|SH|SZ)$/.test(c.instrument.symbol) ||
    (c.instrument.market === "US"
      ? !c.instrument.symbol.endsWith(".US")
      : !/\.(SH|SZ)$/.test(c.instrument.symbol))
  )
    fail("HISTORY_SOURCE_MISMATCH");
  const sessions = new Map<string, MarketSession>();
  const byDate = new Map<string, CalendarDay[]>();
  for (const day of c.calendarDays) {
    if (day.market !== c.instrument.market || day.knownAt > now) continue;
    const records = byDate.get(day.date) ?? [];
    records.push(day);
    byDate.set(day.date, records);
  }
  const selectedCalendar: CalendarDay[] = [];
  let target: MarketSession | undefined;
  for (let at = from; at <= through; at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    const records = (byDate.get(date) ?? []).sort(
      (a, b) => b.knownAt - a.knownAt,
    );
    if (
      !records.length ||
      !Number.isSafeInteger(records[0].knownAt) ||
      records[0].knownAt < 0
    )
      fail("HISTORY_CALENDAR_INCOMPLETE");
    const resolved = resolveSession(
      c.calendarDays,
      c.instrument.market,
      date,
      now,
    );
    if (!resolved.ok) fail("HISTORY_CALENDAR_UNVERIFIED");
    selectedCalendar.push(records[0]);
    if (date === c.basisDate) {
      if (!resolved.session) fail("HISTORY_TARGET_CLOSED");
      target = resolved.session!;
    } else if (resolved.session)
      sessions.set(resolved.session.id, resolved.session);
  }
  if (!target) fail("HISTORY_BASIS_NOT_KNOWN");
  if (sessions.size !== c.rawDaily.length)
    fail("HISTORY_SESSION_COVERAGE_MISMATCH");
  const seen = new Set<string>(),
    ids = new Set<string>();
  const bars = c.rawDaily
    .map((raw) => {
      const session = sessions.get(raw.sessionId);
      if (!session || seen.has(raw.sessionId) || ids.has(raw.id))
        fail("HISTORY_DUPLICATE_OR_UNKNOWN_SESSION");
      if (
        raw.instrumentId !== c.instrument.id ||
        raw.market !== c.instrument.market ||
        raw.source !== LONGBRIDGE_SOURCE ||
        raw.synthetic ||
        raw.id.startsWith("synthetic:")
      )
        fail("HISTORY_SOURCE_MISMATCH");
      if (
        raw.period !== "1D" ||
        !raw.final ||
        raw.receivedAt > now ||
        raw.volumeUnit !== "SHARE" ||
        raw.adjustment !== "RAW"
      )
        fail("HISTORY_RAW_CONTRACT_UNVERIFIED");
      seen.add(raw.sessionId);
      ids.add(raw.id);
      try {
        return normalizeBar(raw, session!);
      } catch {
        return fail("HISTORY_RAW_BAR_INVALID");
      }
    })
    .sort((a, b) => a.start - b.start);
  const targetSession = target!;
  // Basis is the target open. Require coverage through its close and reject known intraday scale changes.
  if (c.adjustments.coverage.through < targetSession.close)
    fail("HISTORY_ACTION_COVERAGE_INCOMPLETE");
  const latest = new Map<string, AdjustmentDataset["actions"][number]>();
  for (const action of c.adjustments.actions) {
    if (action.receivedAt > now || action.publishedAt > now) continue;
    const prev = latest.get(action.id);
    if (!prev || action.revision > prev.revision) latest.set(action.id, action);
  }
  for (const action of latest.values()) {
    if (action.kind !== "SPLIT") continue;
    if (
      action.effectiveAt > targetSession.open &&
      action.effectiveAt <= targetSession.close
    )
      fail("HISTORY_TARGET_SCALE_CHANGED");
    if (
      bars.some(
        (b) => b.start < action.effectiveAt && action.effectiveAt < b.end,
      )
    )
      fail("HISTORY_ACTION_INSIDE_DAILY_BAR");
  }
  const adjusted = adjustForScheduledSession(
    bars,
    c.adjustments,
    now,
    targetSession,
  );
  if (!adjusted.ok) fail("HISTORY_ADJUSTMENT_UNVERIFIED");
  const context: ClosedBarContext = {
    source: LONGBRIDGE_SOURCE,
    probeReportId: c.probeReportId,
    instrumentRulesId: c.instrumentRulesId,
    adjustmentEvidenceId: c.adjustmentEvidenceId,
    actionEvidenceVersion: actionVersion,
    dailyHistoryId: `longbridge-daily:${closedHash({ calendar: selectedCalendar, bars, adjustments: c.adjustments, historyStartDate: c.historyStartDate, basisDate: c.basisDate })}`,
    instrument: c.instrument,
    capability: {
      ...c.capability,
      sequenceContractVerified: false,
      continuousTradesVerified: false,
    },
    calendar: selectedCalendar.at(-1)!,
    daily: adjusted.bars.map((b) => ({ ...b, synthetic: false as const })),
    basisDate: c.basisDate,
    basisKnownAt: Math.max(
      adjusted.knownAt,
      ...bars.map((b) => b.receivedAt),
      ...selectedCalendar.map((d) => d.knownAt),
    ),
  };
  validateClosedContext(context, now);
  return context;
}
