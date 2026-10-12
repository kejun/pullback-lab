import { statfsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { OperationsStatus } from "../../packages/contracts/operations.js";
import {
  emptyMarketWorkerStatus,
  type MarketWorkerStatus,
} from "./market-worker.js";
import type { Store } from "./store.js";

export interface OperationsOptions {
  now: () => number;
  secureCookies?: boolean;
  originConfigured: boolean;
  marketStatus?: () => MarketWorkerStatus;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function diskCapacity(store: Store): OperationsStatus["disk"] {
  if (store.db.memory) return null;
  try {
    const info = statfsSync(store.db.name, { bigint: true });
    const total = info.blocks * info.bsize;
    const available = info.bavail * info.bsize;
    if (
      total <= 0n ||
      available < 0n ||
      available > total ||
      total > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return null;
    return { totalBytes: Number(total), availableBytes: Number(available) };
  } catch {
    // Filesystem errors may include private absolute paths; never serialize them.
    return null;
  }
}

function workerSummary(options: OperationsOptions): OperationsStatus["worker"] {
  let status: MarketWorkerStatus;
  try {
    status = options.marketStatus?.() ?? emptyMarketWorkerStatus();
  } catch {
    return {
      enabled: false,
      state: "UNKNOWN",
      lastStartedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      nextPollAt: null,
      quarantinedCount: null,
    };
  }
  const states = ["DISABLED", "IDLE", "POLLING", "BACKOFF", "STOPPED"];
  return {
    enabled: status.enabled === true,
    state: states.includes(status.state) ? status.state : "UNKNOWN",
    lastStartedAt: nonnegativeInteger(status.lastStartedAt),
    lastSuccessAt: nonnegativeInteger(status.lastSuccessAt),
    lastFailureAt: nonnegativeInteger(status.lastFailureAt),
    nextPollAt: nonnegativeInteger(status.nextPollAt),
    quarantinedCount: nonnegativeInteger(status.quarantinedCount),
  };
}

/** A field allowlist keeps arbitrary worker errors, stored JSON and environment out. */
export function operationsStatus(
  store: Store,
  options: OperationsOptions,
): OperationsStatus {
  const worker = workerSummary(options);
  const disk = diskCapacity(store);
  return store.db.transaction((): OperationsStatus => {
    const funds = store.db
      .prepare(
        `SELECT generation,
      json_extract(json,'$.stale') stale,
      json_extract(json,'$.confirmedAt') confirmed_at
      FROM account_snapshots
      WHERE generation=(SELECT value FROM settings WHERE key='funds_generation')`,
      )
      .get() as
      | { generation: unknown; stale: unknown; confirmed_at: unknown }
      | undefined;
    const plans = store.db
      .prepare(
        `SELECT count(*) total,
      coalesce(sum(json_extract(json,'$.status') IN ('WAIT_RETEST','ARMED','DATA_PAUSED','TRIGGERED')),0) active
      FROM plans`,
      )
      .get() as { total: number; active: number };
    const reservations = store.db
      .prepare(
        `SELECT count(*) total,
      coalesce(sum(json_extract(json,'$.state')='ACTIVE'),0) active,
      coalesce(sum(json_extract(json,'$.state')='TAKEN_PENDING'),0) taken_pending
      FROM reservations`,
      )
      .get() as { total: number; active: number; taken_pending: number };
    const events = store.db
      .prepare(
        `SELECT
      coalesce(sum(a.event_id IS NULL),0) unread,
      coalesce(sum(e.recordable=1 AND NOT EXISTS(SELECT 1 FROM record_revisions r WHERE r.event_id=e.id)),0) pending
      FROM event_summaries e LEFT JOIN notification_ack a ON a.event_id=e.id`,
      )
      .get() as { unread: number; pending: number };
    const schema = store.db
      .prepare("SELECT coalesce(max(version),0) version FROM schema_migrations")
      .get() as { version: number };
    const sqlite = store.db
      .prepare("SELECT sqlite_version() version")
      .get() as { version: string };
    const journal = store.db.pragma("journal_mode", { simple: true });
    const synchronous = store.db.pragma("synchronous", { simple: true });
    return {
      reportVersion: 1,
      capturedAt: options.now(),
      runtime: {
        nodeVersion: process.versions.node,
        sqliteVersion: sqlite.version,
        schemaVersion: schema.version,
        journalMode:
          journal === "wal" || journal === "memory" ? journal : "unknown",
        synchronous: synchronous === 2 ? "FULL" : "UNKNOWN",
      },
      disk,
      security: {
        secureCookiesConfigured: options.secureCookies === true,
        originConfigured: options.originConfigured === true,
        publicTls: "UNKNOWN",
      },
      funds: {
        present: funds !== undefined,
        generation: nonnegativeInteger(funds?.generation),
        stale: funds?.stale === 1 ? true : funds?.stale === 0 ? false : null,
        confirmedAt: nonnegativeInteger(funds?.confirmed_at),
      },
      counts: {
        plans: plans.total,
        activePlans: plans.active,
        reservations: reservations.total,
        activeReservations: reservations.active,
        takenPendingReservations: reservations.taken_pending,
        pendingFeedback: events.pending,
        unreadEvents: events.unread,
      },
      worker,
      // Deployment configuration and provider activity are not capability evidence.
      markets: { US: "UNKNOWN", CN: "UNKNOWN" },
      clock: { status: "UNKNOWN", checkedAt: null },
    };
  })();
}

/** Register only after the application's authenticated /api hook. */
export function registerOperationsRoutes(
  app: FastifyInstance,
  store: Store,
  options: OperationsOptions,
): void {
  app.get("/api/operations/status", async () =>
    operationsStatus(store, options),
  );
}
