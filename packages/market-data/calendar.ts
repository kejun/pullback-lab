import type { Market } from "../contracts/index.js";

export interface CalendarDay {
  market: Market;
  date: string;
  status: "OPEN" | "CLOSED";
  /** Verified local regular-session intervals, e.g. CN 09:30–11:30 and 13:00–15:00. */
  intervals: Array<{ open: string; close: string }>;
  source: string;
  version: string;
  knownAt: number;
  verified: boolean;
}
export interface MarketSession {
  id: string;
  market: Market;
  date: string;
  timezone: string;
  intervals: Array<{ start: number; end: number }>;
  open: number;
  close: number;
  source: string;
  calendarVersion: string;
}
export type SessionResult =
  { ok: true; session: MarketSession | null } | { ok: false; reason: string };
const zones: Record<Market, string> = {
  US: "America/New_York",
  CN: "Asia/Shanghai",
};
/** Intl supplies timezone/DST offsets; whether an exchange is open comes ONLY from an explicit calendar record. */
export function localSessionTime(
  date: string,
  time: string,
  zone: string,
): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    throw new Error("INVALID_LOCAL_TIME");
  const parts = [
    ...date.split("-").map(Number),
    ...time.split(":").map(Number),
  ];
  const [year, month, day, hour, minute] = parts;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  )
    throw new Error("INVALID_LOCAL_TIME");
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(desired).toISOString().slice(0, 10) !== date)
    throw new Error("INVALID_LOCAL_DATE");
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let at = desired;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      fmt.formatToParts(at).map((x) => [x.type, x.value]),
    );
    const represented = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour,
      +p.minute,
      +p.second,
    );
    const delta = desired - represented;
    if (!delta) return at;
    at += delta;
  }
  throw new Error("AMBIGUOUS_OR_NONEXISTENT_SESSION_TIME");
}
export function resolveSession(
  days: readonly CalendarDay[],
  market: Market,
  date: string,
  asOf: number,
): SessionResult {
  const records = days
    .filter((x) => x.market === market && x.date === date && x.knownAt <= asOf)
    .sort((a, b) => b.knownAt - a.knownAt);
  if (!records.length) return { ok: false, reason: "CALENDAR_UNKNOWN" };
  const d = records[0];
  if (
    records.some(
      (x) => x.knownAt === d.knownAt && JSON.stringify(x) !== JSON.stringify(d),
    )
  )
    return { ok: false, reason: "CALENDAR_REVISION_CONFLICT" };
  if (!d.verified || !d.source || !d.version)
    return { ok: false, reason: "CALENDAR_UNVERIFIED" };
  if (d.status === "CLOSED")
    return d.intervals.length
      ? { ok: false, reason: "CALENDAR_CONFLICT" }
      : { ok: true, session: null };
  if (!d.intervals.length)
    return { ok: false, reason: "CALENDAR_HOURS_UNKNOWN" };
  try {
    const intervals = d.intervals.map((x) => ({
      start: localSessionTime(date, x.open, zones[market]),
      end: localSessionTime(date, x.close, zones[market]),
    }));
    if (
      intervals.some(
        (x, i) => x.end <= x.start || (i > 0 && x.start < intervals[i - 1].end),
      )
    )
      return { ok: false, reason: "CALENDAR_INTERVAL_INVALID" };
    return {
      ok: true,
      session: {
        id: `${market}:${date}:${d.version}`,
        market,
        date,
        timezone: zones[market],
        intervals,
        open: intervals[0].start,
        close: intervals.at(-1)!.end,
        source: d.source,
        calendarVersion: d.version,
      },
    };
  } catch {
    return { ok: false, reason: "CALENDAR_TIME_INVALID" };
  }
}
export function tradingMinuteStarts(session: MarketSession): number[] {
  return session.intervals.flatMap((x) =>
    Array.from(
      { length: Math.floor((x.end - x.start) / 60_000) },
      (_, i) => x.start + i * 60_000,
    ),
  );
}
export function isRegularInterval(
  session: MarketSession,
  start: number,
  end: number,
): boolean {
  return (
    end > start &&
    session.intervals.some((x) => start >= x.start && end <= x.end)
  );
}
