import { migrateMarketStreams } from "./market-stream-schema.js";
import type Database from "better-sqlite3";
import { MARKET_WORKER_SCHEMA_SQL } from "./market-worker.js";
import { BAR_REPOSITORY_SCHEMA_SQL } from "../../packages/market-data/ingestion.js";
import { assertSQLiteRuntime, RuntimeSafetyError } from "./runtime-safety.js";
import { ATTEMPT_RUNTIME_SCHEMA_SQL } from "./attempt-runtime-schema.js";
import { EVENT_FEED_SCHEMA_SQL } from "./events-feed.js";
import { migrateScreeningRules } from "./screening-settings.js";
import { ACTION_EVIDENCE_SCHEMA_SQL } from "../../packages/market-data/action-evidence.js";

export interface DatabaseMigration {
  version: number;
  apply(db: Database.Database): void;
}

const initialSchema = `
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE instruments(id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE bars(instrument_id TEXT NOT NULL, period TEXT NOT NULL, bar_id TEXT NOT NULL, time INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(instrument_id,period,bar_id));
  CREATE INDEX bars_timeline ON bars(instrument_id,period,time);
  CREATE TABLE plans(id TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL);
  CREATE TABLE plan_versions(plan_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(plan_id,version));
  CREATE TABLE attempts(id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
  CREATE TABLE account_snapshots(generation INTEGER PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE reservations(plan_id TEXT PRIMARY KEY, allocation_order INTEGER NOT NULL, json TEXT NOT NULL);
  CREATE TABLE decision_inputs(hash TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE decision_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL, type TEXT NOT NULL, event_key TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL REFERENCES decision_inputs(hash), json TEXT NOT NULL);
  CREATE UNIQUE INDEX one_technical_per_attempt ON decision_events(attempt_id) WHERE type='TECHNICAL_TRIGGERED';
  CREATE UNIQUE INDEX one_entry_per_attempt ON decision_events(attempt_id) WHERE type IN ('ENTRY_TRIGGERED','HISTORICAL_TRIGGERED');
  CREATE TABLE notifications(event_id TEXT PRIMARY KEY REFERENCES decision_events(id), created_at INTEGER NOT NULL);
  CREATE TABLE notification_ack(event_id TEXT PRIMARY KEY REFERENCES decision_events(id), read_at INTEGER NOT NULL);
  CREATE TABLE record_revisions(id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES decision_events(id), created_at INTEGER NOT NULL, json TEXT NOT NULL);
  CREATE INDEX feedback_order ON record_revisions(event_id,created_at);
  CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE command_results(key TEXT PRIMARY KEY, route TEXT NOT NULL, input_hash TEXT NOT NULL, json TEXT NOT NULL);
`;

const immutableTables: Record<string, string> = {
  schema_migrations: "version=NEW.version",
  plan_versions: "plan_id=NEW.plan_id AND version=NEW.version",
  account_snapshots: "generation=NEW.generation",
  decision_inputs: "hash=NEW.hash",
  decision_events: `seq=NEW.seq OR id=NEW.id OR event_key=NEW.event_key OR
    (attempt_id=NEW.attempt_id AND type='TECHNICAL_TRIGGERED' AND NEW.type='TECHNICAL_TRIGGERED') OR
    (attempt_id=NEW.attempt_id AND type IN ('ENTRY_TRIGGERED','HISTORICAL_TRIGGERED') AND NEW.type IN ('ENTRY_TRIGGERED','HISTORICAL_TRIGGERED'))`,
  record_revisions: "id=NEW.id",
};

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  { version: 1, apply: (db) => db.exec(initialSchema) },
  {
    version: 2,
    apply(db) {
      db.exec(
        "CREATE INDEX IF NOT EXISTS decision_events_attempt ON decision_events(attempt_id,seq)",
      );
      for (const [table, collision] of Object.entries(immutableTables)) {
        db.exec(`
          CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table}
          BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
          CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table}
          BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
          CREATE TRIGGER ${table}_immutable_replace BEFORE INSERT ON ${table}
          WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${collision})
          BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
        `);
      }
    },
  },
  {
    version: 3,
    apply(db) {
      db.exec(BAR_REPOSITORY_SCHEMA_SQL);
      db.exec(MARKET_WORKER_SCHEMA_SQL);
    },
  },
  {
    version: 4,
    apply(db) {
      db.exec(ATTEMPT_RUNTIME_SCHEMA_SQL);
      db.exec(EVENT_FEED_SCHEMA_SQL);
    },
  },
  { version: 5, apply: migrateScreeningRules },
  { version: 6, apply: (db) => db.exec(ACTION_EVIDENCE_SCHEMA_SQL) },
  {
    version: 7,
    apply: (db) =>
      db.exec(
        "CREATE INDEX market_raw_identity_sequence ON market_raw_inputs(logical_key,ingest_sequence)",
      ),
  },
  { version: 8, apply: migrateMarketStreams },
];

/** All pending DDL and version records commit together, or all roll back. */
export function runMigrations(
  db: Database.Database,
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): void {
  if (migrations.some((migration, index) => migration.version !== index + 1)) {
    throw new RuntimeSafetyError(
      "INVALID_MIGRATIONS",
      "数据库迁移版本必须从 1 连续递增",
    );
  }
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    const applied = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    if (applied.some((entry, index) => entry.version !== index + 1)) {
      throw new RuntimeSafetyError(
        "INVALID_SCHEMA_HISTORY",
        "数据库迁移历史不连续，不能自动升级",
      );
    }
    if (applied.length > migrations.length) {
      throw new RuntimeSafetyError(
        "NEWER_DATABASE_SCHEMA",
        "数据库由更新版本创建，请先升级应用",
      );
    }
    const insert = db.prepare(
      "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
    );
    for (const migration of migrations.slice(applied.length)) {
      migration.apply(db);
      insert.run(migration.version, Date.now());
    }
    if ((db.pragma("foreign_key_check") as unknown[]).length) {
      throw new RuntimeSafetyError(
        "INVALID_DATABASE_REFERENCES",
        "数据库存在无效历史引用，迁移已回滚",
      );
    }
  }).immediate();
}

/** Call immediately after opening a Store connection, before recovery or use. */
export function initializeDatabase(db: Database.Database): void {
  assertSQLiteRuntime(db);
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("recursive_triggers = ON");
  const mode = db.pragma("journal_mode = WAL", { simple: true });
  if (mode !== "wal" && mode !== "memory") {
    throw new RuntimeSafetyError(
      "WAL_UNAVAILABLE",
      "该数据库无法启用 WAL 模式",
    );
  }
  db.pragma("synchronous = FULL");
  runMigrations(db);
}
