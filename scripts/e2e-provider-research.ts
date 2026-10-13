/** Isolated SDK-shaped browser fixture; never imported by production startup. No provider calls. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createApp } from "../apps/server/app.js";
import {
  LongbridgeClosedBarAdapter,
  LONGBRIDGE_SOURCE,
  type LongbridgeQuotePort,
} from "../apps/server/longbridge-closed-bar-adapter.js";
import {
  ContractAdapter,
  OPEN,
  planInput,
  testFunds,
} from "../apps/server/tests/closed-bar-fixture.js";

if (process.env.NODE_ENV !== "test") throw new Error("E2E_ONLY");
const directory = mkdtempSync(
  join(tmpdir(), "pullback-provider-research-e2e-"),
);
const context = new ContractAdapter().context;
context.source = LONGBRIDGE_SOURCE;
context.capability.source = LONGBRIDGE_SOURCE;
context.instrument.name = "离线 SDK 日线契约夹具，非真实行情";
const now = OPEN - 1;
const port: LongbridgeQuotePort = {
  setOnCandlestick: () => {},
  setOnQuote: () => {},
  subscribeCandlesticks: async () => [],
  unsubscribeCandlesticks: async () => {},
  subscribe: async () => {},
  unsubscribe: async () => {},
};
const app = await createApp({
  databasePath: join(directory, "fixture.sqlite"),
  password: "e2e-only-password",
  demo: false,
  now: () => now,
  closedBarAdapterFactory: (store) => {
    store.putInstrument({
      instrument: context.instrument,
      manual: false,
      tags: ["离线合成测试"],
      note: "SDK形状隔离夹具，不是真实权限或来源证明",
    });
    store.putInstrument({
      instrument: {
        ...context.instrument,
        id: "UNKNOWN-US",
        symbol: "UNKNOWN.US",
        name: "无来源的离线反例",
        rulesVerified: false,
      },
      manual: false,
      tags: [],
      note: "无服务器上下文",
    });
    return new LongbridgeClosedBarAdapter({
      contexts: [context],
      quota: {
        verified: true,
        researchSymbols: 100,
        simultaneousSubscriptions: 10,
        monthlyUniqueSymbols: 100,
        requestsPerSecond: 10,
      },
      db: store.db,
      contextFactory: () => port,
      now: () => now,
    });
  },
});
await app.monitor.start();
app.store.confirmScreening(undefined, 0, now);
app.store.updateFunds({ ...testFunds, fxAsOf: now }, 0, now);
app.store.createPlan(
  {
    ...planInput,
    anchorTime: context.daily[0].time,
    reason: "离线 SDK 接线测试，不是真实行情",
  },
  now,
);
await app.register(fastifyStatic, { root: resolve("dist/web"), prefix: "/" });
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT) });
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().finally(() => {
      rmSync(directory, { recursive: true, force: true });
      process.exit(0);
    });
  });
