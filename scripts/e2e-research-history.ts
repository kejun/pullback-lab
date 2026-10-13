import { Store } from "../apps/server/store.js";
import { DEFAULT_SCREENING_PARAMETERS } from "../packages/domain/screening-rules.js";
export function seedResearchHistory(path: string) {
  const store = new Store(path);
  try {
    for (const symbol of ["HISTORY.US", "OTHER.US"]) {
      store.putInstrument({
        instrument: {
          id: `US:${symbol}`,
          symbol,
          name: `${symbol} 合成测试证券`,
          market: "US",
          currency: "USD",
          tick: "0.01",
          qMin: 1,
          qStep: 1,
          sellSameDay: true,
          rulesVerified: false,
        },
        manual: true,
        tags: ["合成测试"],
        note: "仅用于离线浏览器验收，不是真实证券资料",
      });
    }
    store.confirmScreening(DEFAULT_SCREENING_PARAMETERS, 0, Date.now());
  } finally {
    store.close();
  }
}
