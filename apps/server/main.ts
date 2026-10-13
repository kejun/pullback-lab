import { existsSync } from "node:fs";
import { prepareProductionMarket } from "./production-market.js";
import { auditedLongbridgeConfiguration } from "./production-market-config.js";
import fastifyStatic from "@fastify/static";
import { createApp } from "./app.js";
import { acquireServiceLock, type ServiceLock } from "./runtime-safety.js";
import { readStartupConfig } from "./startup-config.js";
import { backupBeforeMigration } from "./backup-service.js";
import {
  createMarketWorkerFromEnvironment,
  emptyMarketWorkerStatus,
  type MarketWorker,
} from "./market-worker.js";

// Acquire before createApp: startup recovery changes persisted funds/attempts.
let lock: ServiceLock | undefined;
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
        lock?.release();
      }
    }
  })();
  return closePromise;
}
try {
  const config = readStartupConfig();
  // Validate the audited server installation before any lock, migration or recovery writes.
  const market = prepareProductionMarket(auditedLongbridgeConfiguration);
  lock = acquireServiceLock(config.databasePath);
  const backup = await backupBeforeMigration(
    lock.databasePath,
    config.backupDirectory,
  );
  if (backup)
    console.info(
      JSON.stringify({
        event: "PRE_MIGRATION_BACKUP_CREATED",
        schemaVersion: backup.schemaVersion,
      }),
    );
  app = await createApp({
    databasePath: lock.databasePath,
    closedBarAdapterFactory: market.factory,
    password: config.password,
    demo: config.demo,
    origin: config.origin,
    secureCookies: config.production,
    logger: true,
    restore: config.restore,
    marketStatus: () => worker?.status() ?? emptyMarketWorkerStatus(),
  });
  const staticRoot = config.staticRoot;
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
    host: config.host,
    port: config.port,
  });
  // No provider request starts until HTTP startup succeeds.
  worker.start();
  await app.monitor.start();
  app.monitor.startScheduler();
  app.runtime.startScheduler();
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
} catch (error) {
  try {
    await close();
  } catch {
    /* Preserve the initial failure without logging private paths. */
  }
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code)
      ? error.code
      : "STARTUP_FAILED";
  console.error(
    JSON.stringify({
      code,
      error: "服务未启动；请核对配置、数据库与备份目录，原始错误详情不对外输出",
    }),
  );
  process.exitCode = 1;
}
