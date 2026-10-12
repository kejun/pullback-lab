import { Store } from "../apps/server/store.js";
import { MarketWorker } from "../apps/server/market-worker.js";
import type { Instrument } from "../packages/contracts/index.js";

/** Offline provider fixture; only called by the test bootstrap before HTTP startup. */
export async function seedMarketSampling(databasePath: string) {
  const store = new Store(databasePath);
  const instrument: Instrument = {
    id: "US:SAMPLE.US",
    symbol: "SAMPLE.US",
    name: "合成采样验收",
    market: "US",
    currency: "USD",
    tick: "0.01",
    qMin: 1,
    qStep: 1,
    sellSameDay: true,
    rulesVerified: false,
  };
  store.putInstrument({
    instrument,
    tags: ["合成验收"],
    note: "仅用于浏览器验收",
    manual: true,
  });
  const worker = new MarketWorker({
    db: store.db,
    enabled: true,
    minuteSymbols: [instrument.symbol],
    researchInstruments: () => [instrument],
    adapterFactory: () => ({
      source: "synthetic-e2e-provider",
      capabilities: () => [],
      fetchQuotes: async () => [],
      fetchBars: async (symbol, period) => {
        if (period === "1m") return [];
        if (period === "5m") throw Error("private-provider-error");
        return [
          {
            symbol,
            period,
            timestamp: Date.parse("2026-10-09T13:30:00Z"),
            receivedAt: Date.now(),
            open: "100",
            high: "101",
            low: "99",
            close: "100",
            volume: "1000",
            turnover: "100000",
            tradeSession: 0,
            adjustment: "RAW",
            finality: "UNKNOWN",
            volumeUnit: "UNVERIFIED",
          },
        ];
      },
    }),
  });
  try {
    await worker.pollOnce();
  } finally {
    await worker.stop();
    store.close();
  }
}
