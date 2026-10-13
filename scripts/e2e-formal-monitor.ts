/** Isolated browser acceptance only. This fixture is never loaded by production startup. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createApp } from "../apps/server/app.js";
import {
  ContractAdapter,
  OPEN,
  planInput,
  testFunds,
} from "../apps/server/tests/closed-bar-fixture.js";

if (process.env.NODE_ENV !== "test") throw new Error("E2E_ONLY");
const directory = mkdtempSync(join(tmpdir(), "pullback-formal-monitor-e2e-"));
const adapter = new ContractAdapter();
const now = OPEN - 1;
const app = await createApp({
  databasePath: join(directory, "fixture.sqlite"),
  password: "e2e-only-password",
  demo: false,
  now: () => now,
  closedBarAdapter: adapter,
});
app.store.putInstrument({
  instrument: {
    ...adapter.context.instrument,
    name: "正式监测离线合成契约夹具",
  },
  manual: true,
  tags: ["离线合成测试"],
  note: "不是生产接通或真实授权证明",
});
app.store.putInstrument({
  instrument: {
    ...adapter.context.instrument,
    id: "UNVERIFIED-US",
    symbol: "UNVERIFIED.US",
    name: "未授权离线夹具",
    rulesVerified: false,
  },
  manual: true,
  tags: ["离线合成测试"],
  note: "没有服务端上下文",
});
await app.monitor.start();
app.store.confirmScreening(undefined, 0, now);
app.store.updateFunds({ ...testFunds, fxAsOf: now }, 0, now);
app.store.createPlan(planInput, now);
app.store.createPlan(
  { ...planInput, instrumentId: "UNVERIFIED-US", supportSelections: [] },
  now,
);
await app.register(fastifyStatic, { root: resolve("dist/web"), prefix: "/" });
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT) });
app.monitor.startScheduler();
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
