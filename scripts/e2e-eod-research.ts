/** Isolated captured-history browser fixture; never loaded by production startup. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createApp } from "../apps/server/app.js";
import { Store } from "../apps/server/store.js";
import { eodFixture } from "../apps/server/tests/eod-research-fixture.js";
if (process.env.NODE_ENV !== "test") throw new Error("E2E_ONLY");
const directory = mkdtempSync(join(tmpdir(), "pullback-eod-e2e-")),
  path = join(directory, "fixture.sqlite");
const fixtures = [eodFixture("US"), eodFixture("CN")],
  now = fixtures[0].now;
const store = new Store(path);
for (const { instrument } of fixtures)
  store.putInstrument({
    instrument,
    manual: false,
    tags: ["离线合成测试"],
    note: "完整原始采集形状夹具，非真实行情/授权",
  });
store.close();
const app = await createApp({
  databasePath: path,
  password: "e2e-only-password",
  demo: false,
  now: () => now,
  eodResearch: fixtures.map((f) => f.input),
});
app.store.confirmScreening(undefined, 0, now);
await app.monitor.start();
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
