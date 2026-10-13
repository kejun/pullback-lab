/** Isolated synthetic protocol/UI acceptance only; never a real provider deployment. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createApp } from "../apps/server/app.js";
import { IntrabarContractAdapter } from "../apps/server/tests/intrabar-fixture.js";
import {
  OPEN,
  planInput,
  testFunds,
} from "../apps/server/tests/closed-bar-fixture.js";
if (process.env.NODE_ENV !== "test") throw new Error("E2E_ONLY");
const directory = mkdtempSync(join(tmpdir(), "pullback-intrabar-monitor-e2e-"));
const adapter = new IntrabarContractAdapter();
const blocked = structuredClone(adapter.context);
blocked.instrument.id = "TICK-BLOCKED-US";
blocked.instrument.symbol = "BLOCKED.US";
blocked.tickContract = undefined;
adapter.contexts = () => [adapter.context, blocked];
const now = OPEN - 1;
const app = await createApp({
  databasePath: join(directory, "fixture.sqlite"),
  password: "e2e-only-password",
  demo: false,
  now: () => now,
  closedBarAdapter: adapter,
});
for (const context of adapter.contexts())
  app.store.putInstrument({
    instrument: { ...context.instrument, name: "盘中监测离线合成契约夹具" },
    manual: true,
    tags: ["离线合成测试"],
    note: "不是生产逐笔连续性证明",
  });
await app.monitor.start();
app.store.confirmScreening(undefined, 0, now);
app.store.updateFunds({ ...testFunds, fxAsOf: now }, 0, now);
app.store.createPlan({ ...planInput, mode: "INTRABAR_CROSS" }, now);
app.store.createPlan(
  { ...planInput, instrumentId: blocked.instrument.id, mode: "INTRABAR_CROSS" },
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
