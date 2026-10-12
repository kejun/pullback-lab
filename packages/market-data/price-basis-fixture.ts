import type { CalendarDay } from "./calendar.js";
import { resolveSession } from "./calendar.js";
import { normalizeBar } from "./normalize.js";
import { actionTestManifest } from "./action-evidence-fixture.js";
import type { AdjustmentDataset } from "./adjustments.js";

/** Explicit synthetic samples; no claim about actual exchange sessions or issuer actions. */
export function priceBasisFixture(market: "US" | "CN" = "US") {
  const instrumentId = market === "US" ? "DEMO-US-A" : "DEMO-CN-A";
  const calendarDays: CalendarDay[] = ["2026-10-08", "2026-10-09"].map(
    (date) => ({
      market,
      date,
      status: "OPEN",
      intervals:
        market === "US"
          ? [{ open: "09:30", close: "16:00" }]
          : [
              { open: "09:30", close: "11:30" },
              { open: "13:00", close: "15:00" },
            ],
      source: "synthetic-calendar",
      version: "fixture-v1",
      knownAt: Date.parse("2026-10-01"),
      verified: true,
    }),
  );
  const asOf = Date.parse("2026-10-10");
  const [previous, target] = calendarDays.map((day) => {
    const r = resolveSession(calendarDays, market, day.date, asOf);
    if (!r.ok || !r.session) throw new Error("fixture");
    return r.session;
  });
  const minutes = Array.from({ length: 5 }, (_, i) =>
    normalizeBar(
      {
        id: `synthetic-minute-${i}`,
        instrumentId,
        market,
        period: "1m",
        start: target.open + i * 60000,
        end: target.open + (i + 1) * 60000,
        open: "50",
        high: "52",
        low: "49",
        close: "51",
        volume: "100",
        turnover: "5050",
        volumeUnit: "SHARE",
        final: true,
        receivedAt: target.open + (i + 1) * 60000 + 1000,
        source: "synthetic-price-fixture",
        providerRevision: "1",
        sessionId: target.id,
        adjustment: "RAW",
        synthetic: true,
      },
      target,
    ),
  );
  const daily = normalizeBar(
    {
      id: "synthetic-daily",
      instrumentId,
      market,
      period: "1D",
      start: previous.open,
      end: previous.close,
      open: "100",
      high: "104",
      low: "98",
      close: "102",
      volume: "1000",
      turnover: "101000",
      volumeUnit: "SHARE",
      final: true,
      receivedAt: previous.close + 1000,
      source: "synthetic-price-fixture",
      providerRevision: "1",
      sessionId: previous.id,
      adjustment: "RAW",
      synthetic: true,
    },
    previous,
  );
  const nativeFive = {
    ...minutes[0],
    id: "synthetic-native-five",
    period: "5m" as const,
    end: target.open + 300000,
    receivedAt: target.open + 301000,
    volume: "500",
    rawVolume: "500",
    turnover: "25250",
    revision: "1",
  };
  const manifest = actionTestManifest();
  manifest.instrumentId = instrumentId;
  manifest.market = market;
  manifest.coverage = {
    ...manifest.coverage,
    from: previous.open,
    through: target.close,
  };
  manifest.actions[0].effectiveAt = target.open;
  manifest.actions[0].publishedAt = previous.close;
  const dataset: AdjustmentDataset = {
    coverage: {
      from: previous.open,
      through: target.close,
      knownAt: asOf,
      verified: true,
      source: manifest.source,
      version: "fixture-evidence-v1",
    },
    actions: manifest.actions.map((a) => ({
      ...a,
      source: manifest.source,
      receivedAt: asOf,
    })),
  };
  return {
    instrumentId,
    market,
    asOf,
    targetDate: target.date,
    calendarDays,
    dataset,
    bars: [daily, ...minutes, nativeFive],
    manifest,
    previous,
    target,
  };
}
