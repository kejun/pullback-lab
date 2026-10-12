import type { Bar, Instrument } from "../contracts/index.js";

/** Explicit synthetic fixtures. Never used by the production adapter or to infer capabilities. */
export const demoInstruments: Instrument[] = [
  {
    id: "DEMO-US-A",
    symbol: "DEMO-A.US",
    name: "合成趋势股 A · 演示",
    market: "US",
    currency: "USD",
    tick: "0.01",
    qMin: 1,
    qStep: 1,
    sellSameDay: true,
    rulesVerified: true,
  },
  {
    id: "DEMO-US-B",
    symbol: "DEMO-B.US",
    name: "合成趋势股 B · 演示",
    market: "US",
    currency: "USD",
    tick: "0.01",
    qMin: 1,
    qStep: 1,
    sellSameDay: true,
    rulesVerified: true,
  },
  {
    id: "DEMO-CN-A",
    symbol: "DEMO-A.CN",
    name: "合成研究股 C · 演示",
    market: "CN",
    currency: "CNY",
    tick: "0.01",
    qMin: 100,
    qStep: 100,
    sellSameDay: false,
    rulesVerified: true,
  },
];
export const DEMO_SESSION_DATE = "2026-10-09";
export const DEMO_PROVENANCE =
  "synthetic-fixture-v1; not exchange history; no profit claim";
export interface DemoBar extends Bar {
  synthetic: true;
  adjustmentVerified: true;
  rawClose: string;
  rawVolume: string;
  rawTurnover: string;
}
export function generateDemoBars(
  instrumentId: string,
  period: "1D" | "1m" | "5m" = "1D",
): DemoBar[] {
  const inst = demoInstruments.find((x) => x.id === instrumentId);
  if (!inst) throw new Error("UNKNOWN_DEMO_INSTRUMENT");
  const base = inst.id === "DEMO-US-B" ? 62 : inst.market === "CN" ? 18 : 100;
  const fmt = (n: number) => n.toFixed(2);
  if (period === "1D") {
    // Synthetic weekdays are a visual fixture, not a production exchange calendar.
    const dates: number[] = [];
    let day = Date.parse("2026-10-08T00:00:00Z");
    while (dates.length < 300) {
      if (![0, 6].includes(new Date(day).getUTCDay())) dates.unshift(day);
      day -= 86_400_000;
    }
    return dates.map((day, i) => {
      const trend = 0.43 + (0.57 * i) / 299;
      const wave = i > 293 ? 0.005 * Math.sin(i) : 0.011 * Math.sin(i / 5);
      const close = i === 299 ? base * 1.01 : base * (trend + wave);
      const open = close * (1 + 0.001 * Math.sin(i * 2));
      const spread = i > 293 ? 0.009 : 0.024;
      const volume = String(2_000_000 + (i % 17) * 35_000);
      return {
        id: `synthetic:${instrumentId}:1D:${day}`,
        time: day / 1000,
        open: fmt(open),
        high: fmt(Math.max(open, close) * (1 + spread)),
        low: fmt(Math.min(open, close) * (1 - spread)),
        close: fmt(close),
        volume,
        turnover: fmt(close * Number(volume)),
        final: true,
        receivedAt: day + 86_399_000,
        adjustmentVersion: "synthetic-split-none-v1",
        synthetic: true as const,
        adjustmentVerified: true as const,
        rawClose: fmt(close),
        rawVolume: volume,
        rawTurnover: fmt(close * Number(volume)),
      };
    });
  }
  const openAt = Date.parse(
    inst.market === "US" ? "2026-10-09T13:30:00Z" : "2026-10-09T01:30:00Z",
  );
  const minutes: DemoBar[] = Array.from({ length: 60 }, (_, i) => {
    const close =
      base *
      (i < 4
        ? 1.006 - i * 0.002
        : i < 8
          ? 0.999 + (i - 4) * 0.0007
          : 1.002 + (i - 8) * 0.0006);
    const open = close - base * 0.0005;
    const volume = String(20_000 + (i % 7) * 2000);
    return {
      id: `synthetic:${instrumentId}:1m:${i}`,
      time: (openAt + i * 60_000) / 1000,
      open: fmt(open),
      high: fmt(close + base * 0.0012),
      low: fmt(open - base * 0.001),
      close: fmt(close),
      volume,
      turnover: fmt(close * Number(volume)),
      final: true,
      receivedAt: openAt + (i + 1) * 60_000 + 1000,
      adjustmentVersion: "synthetic-split-none-v1",
      synthetic: true as const,
      adjustmentVerified: true as const,
      rawClose: fmt(close),
      rawVolume: volume,
      rawTurnover: fmt(close * Number(volume)),
    };
  });
  if (instrumentId === "DEMO-US-A") {
    Object.assign(minutes[0], {
      open: "100.50",
      high: "100.60",
      low: "100.00",
      close: "100.20",
      turnover: "2004000.00",
      rawClose: "100.20",
      rawTurnover: "2004000.00",
    });
    Object.assign(minutes[1], {
      open: "100.20",
      high: "100.70",
      low: "100.10",
      close: "100.61",
      turnover: "2213420.00",
      rawClose: "100.61",
      rawTurnover: "2213420.00",
    });
  }
  if (period === "1m") return minutes;
  return Array.from({ length: 12 }, (_, i) => {
    const a = minutes.slice(i * 5, i * 5 + 5);
    return {
      id: `synthetic:${instrumentId}:5m:${i}`,
      time: a[0].time,
      open: a[0].open,
      high: fmt(Math.max(...a.map((x) => Number(x.high)))),
      low: fmt(Math.min(...a.map((x) => Number(x.low)))),
      close: a[4].close,
      volume: String(a.reduce((n, x) => n + Number(x.volume), 0)),
      turnover: fmt(a.reduce((n, x) => n + Number(x.turnover), 0)),
      final: true,
      receivedAt: a[4].receivedAt,
      adjustmentVersion: "synthetic-split-none-v1",
      synthetic: true as const,
      adjustmentVerified: true as const,
      rawClose: a[4].close,
      rawVolume: String(a.reduce((n, x) => n + Number(x.volume), 0)),
      rawTurnover: fmt(a.reduce((n, x) => n + Number(x.turnover), 0)),
    };
  });
}
