/** Isolated provider-shaped data. Never imported by production configuration. */
import type { Market } from "../../../packages/contracts/index.js";
import type { EodResearchInput } from "../eod-research.js";
import { ContractAdapter } from "./closed-bar-fixture.js";
import {
  localSessionTime,
  resolveSession,
  type CalendarDay,
} from "../../../packages/market-data/calendar.js";
export function eodFixture(market: Market = "US") {
  const base = new ContractAdapter().context;
  const now = Date.parse("2026-10-12T00:00:00Z"),
    from = "2025-10-01",
    through = "2026-10-11";
  const instrument = {
    ...base.instrument,
    id: `EOD-${market}`,
    symbol: market === "US" ? "EOD.US" : "600000.SH",
    market,
    currency: market === "US" ? ("USD" as const) : ("CNY" as const),
    sellSameDay: market === "US",
    name: "隔离日线研究夹具，非真实行情",
  };
  const calendarDays: CalendarDay[] = [];
  const samples: any[] = [];
  for (let t = Date.parse(from); t <= Date.parse(through); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10),
      open = ![0, 6].includes(new Date(t).getUTCDay());
    const day: CalendarDay = {
      market,
      date,
      status: open ? "OPEN" : "CLOSED",
      intervals: !open
        ? []
        : market === "US"
          ? [
              {
                open: "09:30",
                close: date === "2025-11-28" ? "13:00" : "16:00",
              },
            ]
          : [
              { open: "09:30", close: "11:30" },
              { open: "13:00", close: "15:00" },
            ],
      source: "isolated-calendar",
      version: "isolated-v1",
      knownAt: now - 1000,
      verified: true,
    };
    calendarDays.push(day);
    const result = resolveSession([day], market, date, now);
    if (result.ok && result.session)
      samples.push({
        symbol: instrument.symbol,
        period: "1D",
        timestamp: localSessionTime(date, "00:00", result.session.timezone),
        receivedAt: now - 1000,
        open: "100",
        high: "102",
        low: "99",
        close: "101",
        volume: "1000",
        turnover: "100500",
        tradeSession: 0,
        adjustment: "RAW",
        finality: "UNKNOWN",
        volumeUnit: "UNVERIFIED",
      });
  }
  const pages: any[] = [],
    calendarPages: any[] = [];
  for (let t = Date.parse(from); t <= Date.parse(through); t += 90 * 86400000) {
    const end = Math.min(Date.parse(through), t + 89 * 86400000),
      f = new Date(t).toISOString().slice(0, 10),
      to = new Date(end).toISOString().slice(0, 10);
    const dates = calendarDays.filter((d) => d.date >= f && d.date <= to);
    const times = new Set(
      dates.map((d) =>
        localSessionTime(
          d.date,
          "00:00",
          market === "US" ? "America/New_York" : "Asia/Shanghai",
        ),
      ),
    );
    pages.push({
      from: f,
      through: to,
      receivedAt: now - 1000,
      samples: samples.filter((s) => times.has(s.timestamp)),
    });
    calendarPages.push({
      from: f,
      through: to,
      receivedAt: now - 1000,
      tradingDays: dates.filter((d) => d.status === "OPEN").map((d) => d.date),
      halfDays:
        market === "US"
          ? dates.filter((d) => d.date === "2025-11-28").map((d) => d.date)
          : [],
      sessionHoursVerified: false,
    });
  }
  const capture = {
    schema: "pullback-lab-longbridge-history-v1",
    source: "longbridge-node-5.2.0",
    sdk: "5.2.0",
    symbol: instrument.symbol,
    market,
    from,
    through,
    endpoint: "historyCandlesticksByDate",
    adjustment: "RAW",
    startedAt: now - 2000,
    completedAt: now - 500,
    status: "SAMPLED",
    pages,
    calendarPages,
    capability: "UNKNOWN",
    coverage: "UNKNOWN",
    timestampAnchor: "UNKNOWN",
  };
  const input: EodResearchInput = {
    capture,
    review: {
      history: {
        instrument,
        capability: {
          ...base.capability,
          market,
          source: capture.source,
          checkedAt: now - 400,
          validUntil: now + 86400000,
          realtimeEntitlementVerified: false,
          completeMinutes: false,
          sequenceContractVerified: false,
          continuousTradesVerified: false,
          maxClosedBarDelayMs: null,
          quoteAgeMs: null,
          clockSkewMs: null,
          delayMinutes: null,
          deploymentRegion: "UNKNOWN",
        },
        instrumentRulesId: "isolated-reviewed-rules",
        adjustmentEvidenceId: "isolated-reviewed-actions",
        historyStartDate: from,
        basisDate: through,
        calendarDays,
        adjustments: {
          actions: [],
          coverage: {
            from: 0,
            through: now - 1000,
            knownAt: now - 1000,
            verified: true,
            source: "isolated-actions",
            version: "isolated-v1",
          },
        },
      },
      endpoint: {
        evidenceId: "isolated-endpoint-review",
        sdk: "5.2.0",
        endpoint: "historyCandlesticksByDate",
        period: "1D",
        adjustment: "RAW",
        volumeUnit: "SHARE",
        timestampAnchor: "MARKET_LOCAL_MIDNIGHT",
        finality: "COMPLETED_SESSION_HISTORY",
      },
      halfTradingDates: market === "US" ? ["2025-11-28"] : [],
    },
  };
  return { input, now, capture, instrument };
}
