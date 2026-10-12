import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createApp } from "./app.js";
import { acquireServiceLock } from "./runtime-safety.js";
import {
  createMarketWorkerFromEnvironment,
  emptyMarketWorkerStatus,
  type MarketWorker,
} from "./market-worker.js";

// Acquire before createApp: startup recovery changes persisted funds/attempts.
const lock = acquireServiceLock(
  process.env.PULLBACK_DB ?? "./data/pullback.sqlite",
);
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let worker: MarketWorker | undefined;
let closePromise: Promise<void> | undefined;
function close(): Promise<void> {
  closePromise ??= (async () => {
    try {
      await worker?.stop();
    } finally {
      try {
        await app?.close();
      } finally {
        lock.release();
      }
    }
  })();
  return closePromise;
}
try {
  app = await createApp({
    databasePath: lock.databasePath,
    password: process.env.PULLBACK_PASSWORD,
    demo: process.env.PULLBACK_DEMO === "1",
    origin: process.env.PULLBACK_ORIGIN,
    secureCookies: process.env.NODE_ENV === "production",
    logger: true,
    restore: process.env.PULLBACK_RESTORED === "1",
    marketStatus: () => worker?.status() ?? emptyMarketWorkerStatus(),
  });
  const staticRoot = resolve("dist/web");
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: "/" });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "找不到接口", code: "NOT_FOUND" })
        : reply.sendFile("index.html"),
    );
  }
  await app.ready();
  worker = createMarketWorkerFromEnvironment(
    app.store,
    process.env,
    ({ instrumentId, reason, at }) =>
      app!.store.invalidateEvidence(instrumentId, reason, at),
  );
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
  });
  // No provider request starts until HTTP startup succeeds.
  worker.start();
  app.runtime.startScheduler();
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
} catch (error) {
  await close();
  throw error;
}
