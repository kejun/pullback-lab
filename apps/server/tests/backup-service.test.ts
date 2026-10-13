import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupBeforeMigration,
  backupDatabase,
  restoreDatabase,
} from "../backup-service.js";
import { DATABASE_MIGRATIONS, runMigrations } from "../migrations.js";
import { acquireServiceLock } from "../runtime-safety.js";
import { Store } from "../store.js";

const directories: string[] = [];
const databases = new Set<Database.Database>();
function directory() {
  const path = mkdtempSync(join(tmpdir(), "pullback-backup-"));
  directories.push(path);
  return path;
}
function current(path: string) {
  const store = new Store(path);
  databases.add(store.db);
  return store;
}
function open(path: string) {
  const db = new Database(path);
  databases.add(db);
  return db;
}
function old(path: string, version = 4) {
  const db = open(path);
  if (version === 1)
    db.exec(
      readFileSync(
        new URL("./fixtures/schema-v1.sql", import.meta.url),
        "utf8",
      ),
    );
  else runMigrations(db, DATABASE_MIGRATIONS.slice(0, version));
  return db;
}
function schema(db: Database.Database) {
  return db
    .prepare("SELECT max(version) AS version FROM schema_migrations")
    .get();
}
function count(db: Database.Database, table: string) {
  return (
    db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}
function noPartials(path: string) {
  expect(readdirSync(path).filter((name) => name.includes(".partial"))).toEqual(
    [],
  );
}
afterEach(() => {
  for (const db of databases) if (db.open) db.close();
  databases.clear();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("verified online backup", () => {
  it("captures committed WAL while a second connection has an uncommitted write, with a private self-contained result", async () => {
    const dir = directory();
    const source = join(dir, "live.sqlite");
    const target = join(dir, "copy.sqlite");
    const store = current(source);
    store.db.pragma("wal_autocheckpoint = 0");
    store.setSetting("committed", "visible-in-wal");
    expect(statSync(`${source}-wal`).size).toBeGreaterThan(0);
    const writer = open(source);
    writer.exec("BEGIN IMMEDIATE");
    writer
      .prepare("INSERT INTO settings VALUES('uncommitted','must-not-copy')")
      .run();
    try {
      expect(await backupDatabase(source, target)).toEqual({
        schemaVersion: 13,
      });
    } finally {
      writer.exec("ROLLBACK");
    }
    const copy = open(target);
    expect(
      copy.prepare("SELECT value FROM settings WHERE key='committed'").get(),
    ).toEqual({ value: "visible-in-wal" });
    expect(
      copy.prepare("SELECT value FROM settings WHERE key='uncommitted'").get(),
    ).toBeUndefined();
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(copy.pragma("foreign_key_check")).toEqual([]);
    expect(copy.pragma("journal_mode", { simple: true })).toBe("delete");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(existsSync(`${target}-shm`)).toBe(false);
    noPartials(dir);
  });

  it("does not overwrite an existing DB, WAL, SHM, dangling symlink, or its source", async () => {
    const dir = directory();
    const source = join(dir, "source.sqlite");
    current(source).close();
    await expect(backupDatabase(source, source)).rejects.toMatchObject({
      code: "SOURCE_TARGET_SAME",
    });
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const target = join(dir, `occupied-${suffix || "main"}.sqlite`);
      writeFileSync(target + suffix, "keep-original");
      await expect(backupDatabase(source, target)).rejects.toMatchObject({
        code: "BACKUP_TARGET_EXISTS",
      });
      expect(readFileSync(target + suffix, "utf8")).toBe("keep-original");
    }
    const symlink = join(dir, "symlink.sqlite");
    symlinkSync(join(dir, "missing.sqlite"), symlink);
    await expect(backupDatabase(source, symlink)).rejects.toMatchObject({
      code: "BACKUP_TARGET_EXISTS",
    });
    noPartials(dir);
  });

  it("publishes exactly one winner for two simultaneous copies to the same target", async () => {
    const dir = directory();
    const source = join(dir, "source.sqlite");
    const target = join(dir, "one.sqlite");
    current(source).close();
    const results = await Promise.allSettled([
      backupDatabase(source, target),
      backupDatabase(source, target),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "BACKUP_TARGET_EXISTS" } });
    expect(schema(open(target))).toEqual({ version: 13 });
    noPartials(dir);
  });

  it("rejects source hard-link aliases whose different WAL name could lose live commits", async () => {
    const dir = directory();
    const source = join(dir, "live.sqlite");
    const alias = join(dir, "alias.sqlite");
    const target = join(dir, "backup.sqlite");
    const store = current(source);
    store.db.pragma("wal_checkpoint(TRUNCATE)");
    store.setSetting("wal-only", "must-be-preserved");
    linkSync(source, alias);
    await expect(backupDatabase(alias, target)).rejects.toMatchObject({
      code: "INVALID_BACKUP_PATH",
    });
    await expect(backupDatabase(source, target)).rejects.toMatchObject({
      code: "INVALID_BACKUP_PATH",
    });
    expect(existsSync(target)).toBe(false);
    noPartials(dir);
  });

  it("refuses SQLite sidecar path collisions in either direction", async () => {
    const dir = directory();
    const source = join(dir, "source.sqlite");
    current(source).close();
    for (const suffix of [
      "-wal",
      "-shm",
      "-journal",
      ".service-lock.sqlite",
      ".service-lock.sqlite-journal",
    ]) {
      await expect(
        backupDatabase(source, source + suffix),
      ).rejects.toMatchObject({ code: "INVALID_BACKUP_PATH" });
      await expect(
        restoreDatabase(source, source + suffix),
      ).rejects.toMatchObject({ code: "INVALID_BACKUP_PATH" });
    }
    const reverseTarget = join(dir, "reverse.sqlite");
    await backupDatabase(source, `${reverseTarget}-wal`);
    await expect(
      backupDatabase(`${reverseTarget}-wal`, reverseTarget),
    ).rejects.toMatchObject({ code: "INVALID_BACKUP_PATH" });
    noPartials(dir);
  });

  it("rejects corrupt files, unrelated SQLite, missing schema objects and broken references without leaving a target", async () => {
    const dir = directory();
    const broken = join(dir, "broken.sqlite");
    writeFileSync(broken, "not sqlite and contains secret-value");
    const unrelated = join(dir, "unrelated.sqlite");
    open(unrelated).exec("CREATE TABLE something(value TEXT)");
    const altered = join(dir, "altered.sqlite");
    const alteredStore = current(altered);
    alteredStore.db.exec("DROP TRIGGER plan_versions_immutable_update");
    const badFk = join(dir, "bad-fk.sqlite");
    const invalid = current(badFk);
    invalid.db.pragma("foreign_keys = OFF");
    invalid.db.exec("INSERT INTO notification_ack VALUES('missing-event',0)");
    for (const [index, source] of [
      broken,
      unrelated,
      altered,
      badFk,
    ].entries()) {
      const target = join(dir, `target-${index}.sqlite`);
      await expect(backupDatabase(source, target)).rejects.toMatchObject({
        code: "INVALID_BACKUP_DATABASE",
      });
      expect(existsSync(target)).toBe(false);
    }
    noPartials(dir);
  });
});

describe("offline new-path restore", () => {
  it("expires sessions and commands, rotates feed cursors, pauses research while preserving triggered reservations and immutable facts", async () => {
    const dir = directory();
    const source = join(dir, "source.sqlite");
    const target = join(dir, "restored.sqlite");
    const store = current(source);
    store.db.exec(`
      INSERT INTO sessions VALUES('old-session',9999999999999);
      INSERT INTO command_results VALUES('old-key','/api/funds','hash','{"stale":"result"}');
      INSERT INTO account_snapshots VALUES(1,'{"generation":1,"stale":false,"nav":"10000"}');
      INSERT INTO settings VALUES('funds_generation','1');
      INSERT INTO plans VALUES('active',1,'{"id":"active","version":1,"status":"ARMED","updatedAt":1}');
      INSERT INTO plans VALUES('triggered',1,'{"id":"triggered","version":1,"status":"TRIGGERED","updatedAt":1}');
      INSERT INTO plans VALUES('taken',1,'{"id":"taken","version":1,"status":"TAKEN","updatedAt":1}');
      INSERT INTO reservations VALUES('triggered',1,'{"planId":"triggered","state":"ACTIVE","cash":"100"}');
      INSERT INTO reservations VALUES('taken',2,'{"planId":"taken","state":"TAKEN_PENDING","cash":"200"}');
      INSERT INTO plan_versions VALUES('triggered',1,'{"immutable":"plan"}');
      INSERT INTO decision_inputs VALUES('input','{"immutable":"input"}');
      INSERT INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES('event','attempt','ENTRY_TRIGGERED','key','input','{"immutable":"event"}');
      INSERT INTO record_revisions VALUES('feedback','event',1,'{"immutable":"feedback"}');
    `);
    const epoch = store.setting("event_feed_epoch");
    const originalFunds = store.db
      .prepare("SELECT json FROM account_snapshots WHERE generation=1")
      .get();
    const immutable = [
      "plan_versions",
      "decision_inputs",
      "decision_events",
      "record_revisions",
      "reservations",
    ].map((table) => ({
      table,
      rows: store.db.prepare(`SELECT * FROM ${table}`).all(),
    }));
    await expect(restoreDatabase(source, target)).resolves.toEqual({
      schemaVersion: 13,
    });
    const restored = current(target);
    expect(count(restored.db, "sessions")).toBe(0);
    expect(count(restored.db, "command_results")).toBe(0);
    expect(restored.setting("event_feed_epoch")).not.toBe(epoch);
    expect(restored.funds()).toMatchObject({ generation: 2, stale: true });
    expect(
      restored.db
        .prepare("SELECT json FROM account_snapshots WHERE generation=1")
        .get(),
    ).toEqual(originalFunds);
    expect(restored.plans().find((plan) => plan.id === "active")?.status).toBe(
      "DATA_PAUSED",
    );
    expect(
      restored.plans().find((plan) => plan.id === "triggered")?.status,
    ).toBe("TRIGGERED");
    for (const { table, rows } of immutable)
      expect(
        restored.db.prepare(`SELECT * FROM ${table}`).all(),
        table,
      ).toEqual(rows);
    expect(count(store.db, "sessions")).toBe(1);
    expect(count(store.db, "command_results")).toBe(1);
    expect(store.funds()).toMatchObject({ generation: 1, stale: false });
    expect(store.setting("event_feed_epoch")).toBe(epoch);
    noPartials(dir);
  });

  it("holds the target service lock against another connection for the complete copy", async () => {
    const dir = directory();
    const source = join(dir, "source.sqlite");
    const target = join(dir, "restore.sqlite");
    current(source).close();
    const lock = acquireServiceLock(target);
    try {
      await expect(restoreDatabase(source, target)).rejects.toMatchObject({
        code: "SERVICE_ALREADY_RUNNING",
      });
    } finally {
      lock.release();
    }
    const pending = restoreDatabase(source, target);
    expect(() => acquireServiceLock(target)).toThrow(/已有服务/);
    await expect(restoreDatabase(source, target)).rejects.toMatchObject({
      code: "SERVICE_ALREADY_RUNNING",
    });
    await pending;
    const available = acquireServiceLock(target);
    available.release();
    noPartials(dir);
  });

  it("migrates an old backup in the staging file only and leaves failed restorations unpublished", async () => {
    const dir = directory();
    const source = join(dir, "v1.sqlite");
    const target = join(dir, "new.sqlite");
    const legacy = old(source, 1);
    legacy.exec(
      `INSERT INTO sessions VALUES('legacy-session',9999999999999); INSERT INTO command_results VALUES('key','route','hash','{}'); INSERT INTO plan_versions VALUES('plan',1,'{"kept":"exact"}');`,
    );
    legacy.close();
    const original = readFileSync(source);
    await expect(restoreDatabase(source, target)).resolves.toEqual({
      schemaVersion: 13,
    });
    expect(readFileSync(source)).toEqual(original);
    expect(schema(open(source))).toEqual({ version: 1 });
    const restored = open(target);
    expect(schema(restored)).toEqual({ version: 13 });
    expect(restored.prepare("SELECT json FROM plan_versions").get()).toEqual({
      json: '{"kept":"exact"}',
    });
    expect(count(restored, "sessions")).toBe(0);
    expect(count(restored, "command_results")).toBe(0);
    const badSource = join(dir, "bad-state.sqlite");
    const malformed = current(badSource);
    malformed.db.exec(
      `INSERT INTO settings VALUES('funds_generation','1'); INSERT INTO account_snapshots VALUES(1,'not-json');`,
    );
    const badTarget = join(dir, "never-published.sqlite");
    await expect(restoreDatabase(badSource, badTarget)).rejects.toMatchObject({
      code: "BACKUP_FAILED",
    });
    expect(existsSync(badTarget)).toBe(false);
    noPartials(dir);
    const unlocked = acquireServiceLock(badTarget);
    unlocked.release();
  });

  it("CLI failures expose only a stable code and safe message, with bounded child lifetime", async () => {
    const dir = directory();
    const source = join(dir, "secret-source.sqlite");
    writeFileSync(source, "TOP-SECRET-DATA");
    const target = join(dir, "private-target.sqlite");
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolveResult, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "scripts/restore.ts", source, target],
          { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          output += String(chunk);
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolveResult({ code, output });
        });
      },
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("INVALID_BACKUP_DATABASE:");
    expect(result.output).not.toContain(dir);
    expect(result.output).not.toContain("TOP-SECRET-DATA");
    expect(result.output).not.toContain("SqliteError");
    noPartials(dir);
  });
});

describe("automatic migration checkpoint", () => {
  it("creates unique verified v4 backups without changing source and skips current/new databases", async () => {
    const dir = directory();
    const source = join(dir, "old.sqlite");
    const db = old(source);
    db.prepare("INSERT INTO settings VALUES('kept','legacy')").run();
    db.close();
    const original = readFileSync(source);
    const first = await backupBeforeMigration(source, join(dir, "backups"));
    const second = await backupBeforeMigration(source, join(dir, "backups"));
    expect(first).toMatchObject({ schemaVersion: 4 });
    expect(second?.path).not.toBe(first?.path);
    expect(readFileSync(source)).toEqual(original);
    expect(schema(open(first!.path))).toEqual({ version: 4 });
    const currentPath = join(dir, "current.sqlite");
    current(currentPath).close();
    await expect(
      backupBeforeMigration(currentPath, join(dir, "unused")),
    ).resolves.toBeNull();
    await expect(
      backupBeforeMigration(join(dir, "missing.sqlite"), join(dir, "unused")),
    ).resolves.toBeNull();
    expect(existsSync(join(dir, "unused"))).toBe(false);
  });

  it("refuses future schemas and orphan sidecars before migration", async () => {
    const dir = directory();
    const source = join(dir, "future.sqlite");
    const store = current(source);
    store.db
      .prepare("INSERT INTO schema_migrations VALUES(?,0)")
      .run(DATABASE_MIGRATIONS.length + 1);
    await expect(
      backupBeforeMigration(source, join(dir, "backups")),
    ).rejects.toMatchObject({ code: "NEWER_DATABASE_SCHEMA" });
    const orphan = join(dir, "orphan.sqlite");
    writeFileSync(`${orphan}-wal`, "orphan");
    await expect(
      backupBeforeMigration(orphan, join(dir, "backups")),
    ).rejects.toMatchObject({ code: "BACKUP_TARGET_EXISTS" });
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

describe("period watermark migration", () => {
  it("rolls back the entire cursor migration if a legacy value is invalid", () => {
    const db = old(join(directory(), "invalid-v7.sqlite"), 7);
    db.prepare(
      "INSERT INTO market_worker_watermarks VALUES('US:TEST.US','invalid-json')",
    ).run();
    expect(() => runMigrations(db)).toThrow();
    expect(schema(db)).toEqual({ version: 7 });
    expect(db.prepare("SELECT * FROM market_worker_watermarks").get()).toEqual({
      instrument_id: "US:TEST.US",
      json: "invalid-json",
    });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='market_worker_streams'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("backs up schema 7 and preserves daily history and private cursor fields when upgrading", async () => {
    const dir = directory(),
      path = join(dir, "v7.sqlite");
    const before = old(path, 7);
    const daily = {
      instrumentId: "US:AAPL.US",
      providerTimestamp: 123,
      receivedAt: 456,
      connectionEpoch: 2,
      historical: true,
      acceptedStart: 100,
    };
    before
      .prepare("INSERT INTO market_worker_watermarks VALUES(?,?)")
      .run(daily.instrumentId, JSON.stringify(daily));
    before.close();
    const backup = await backupBeforeMigration(path, join(dir, "backups"));
    expect(backup?.schemaVersion).toBe(7);
    const store = current(path);
    expect(schema(store.db)).toEqual({ version: 13 });
    const row = store.db
      .prepare("SELECT * FROM market_worker_watermarks")
      .get() as { instrument_id: string; period: string; json: string };
    expect(row.period).toBe("1D");
    expect(JSON.parse(row.json)).toEqual({ ...daily, period: "1D" });
    expect(count(store.db, "market_worker_streams")).toBe(0);
    const saved = open(backup!.path);
    expect(schema(saved)).toEqual({ version: 7 });
    expect(
      saved.prepare("SELECT json FROM market_worker_watermarks").get(),
    ).toEqual({ json: JSON.stringify(daily) });
    expect(store.db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("provider receipt query migration", () => {
  it("backs up v8 payload bytes and hashes, preserving unknown request periods and append-only guards", async () => {
    const dir = directory(),
      path = join(dir, "v8.sqlite");
    const before = old(path, 8);
    before.exec(`INSERT INTO market_worker_epochs(epoch,started_at) VALUES(1,10);
      INSERT INTO market_provider_receipts(epoch,instrument_id,source,received_at,observed_at,provider_timestamp,historical,payload_hash,payload_json,status,reason)
      VALUES(1,'US:TEST.US','synthetic',20,20,10,1,'legacy-hash','{ "period": "1m", "symbol": "TEST.US" }','QUARANTINED','UNKNOWN'),
      (1,'US:TEST.US','synthetic',20,20,10,1,'bad-hash','invalid-json','QUARANTINED','UNKNOWN');`);
    const original = before
      .prepare("SELECT * FROM market_provider_receipts ORDER BY sequence")
      .all();
    before.close();
    const backup = await backupBeforeMigration(path, join(dir, "backups"));
    expect(backup?.schemaVersion).toBe(8);
    const saved = open(backup!.path);
    expect(
      saved
        .prepare("SELECT * FROM market_provider_receipts ORDER BY sequence")
        .all(),
    ).toEqual(original);
    const store = current(path);
    expect(schema(store.db)).toEqual({ version: 13 });
    expect(
      store.db
        .prepare("SELECT * FROM market_provider_receipts ORDER BY sequence")
        .all(),
    ).toEqual(
      original.map((row) => ({ ...(row as object), requested_period: null })),
    );
    expect(() =>
      store.db.exec(
        "UPDATE market_provider_receipts SET requested_period='1m'",
      ),
    ).toThrow("IMMUTABLE_PROVIDER_RECEIPT");
    expect(() => store.db.exec("DELETE FROM market_provider_receipts")).toThrow(
      "IMMUTABLE_PROVIDER_RECEIPT",
    );
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT sequence FROM market_provider_receipts
      WHERE instrument_id=? AND requested_period IS ? AND sequence<=? AND sequence<? ORDER BY sequence DESC LIMIT 21`,
      )
      .all("US:TEST.US", null, 100, 100);
    expect(JSON.stringify(plan)).toContain("market_provider_stream_sequence");
    const { RECEIPT_SYMBOL_SQL, RECEIPT_PERIOD_SQL } =
      await import("../provider-receipt-schema.js");
    const priorPlan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT sequence FROM market_provider_receipts
      WHERE instrument_id=? AND source=? AND ${RECEIPT_SYMBOL_SQL}=? AND ${RECEIPT_PERIOD_SQL}=?
      AND provider_timestamp=? AND sequence<? ORDER BY sequence DESC LIMIT 1`,
      )
      .all("US:TEST.US", "synthetic", "TEST.US", "1m", 10, 100);
    expect(JSON.stringify(priorPlan)).toContain("market_provider_predecessor");
  });

  it("rolls back the new column and indexes if migration recording fails", () => {
    const db = old(join(directory(), "failed-v9.sqlite"), 8);
    db.exec(
      "CREATE TRIGGER fail_v9 BEFORE INSERT ON schema_migrations WHEN NEW.version=9 BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END",
    );
    expect(() => runMigrations(db)).toThrow("synthetic migration failure");
    expect(schema(db)).toEqual({ version: 8 });
    expect(
      (
        db.pragma("table_info(market_provider_receipts)") as { name: string }[]
      ).some((c) => c.name === "requested_period"),
    ).toBe(false);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='market_provider_stream_sequence'",
        )
        .get(),
    ).toBeUndefined();
  });
});

describe("manual research history migration", () => {
  it("backs up v9 before adding immutable history storage without changing existing data", async () => {
    const dir = directory(),
      path = join(dir, "v9.sqlite");
    const db = old(path, 9);
    db.prepare("INSERT INTO settings VALUES(?,?)").run(
      "private-marker",
      "preserved-v9",
    );
    db.close();
    const backup = await backupBeforeMigration(path, join(dir, "backups"));
    expect(backup?.schemaVersion).toBe(9);
    const saved = open(backup!.path);
    expect(schema(saved)).toEqual({ version: 9 });
    expect(
      saved
        .prepare("SELECT value FROM settings WHERE key='private-marker'")
        .get(),
    ).toEqual({ value: "preserved-v9" });
    expect(
      saved
        .prepare("SELECT name FROM sqlite_master WHERE name='research_history'")
        .get(),
    ).toBeUndefined();
    const store = current(path);
    expect(schema(store.db)).toEqual({ version: 13 });
    expect(store.setting("private-marker")).toBe("preserved-v9");
    expect(
      store.db.prepare("SELECT count(*) n FROM research_history").get(),
    ).toEqual({ n: 0 });
    expect(store.db.pragma("foreign_key_check")).toEqual([]);
  });
  it("rolls back history table and triggers if recording schema 10 fails", () => {
    const db = old(join(directory(), "failed-v10.sqlite"), 9);
    db.exec(
      "CREATE TRIGGER fail_v10 BEFORE INSERT ON schema_migrations WHEN NEW.version=10 BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END",
    );
    expect(() => runMigrations(db)).toThrow("synthetic migration failure");
    expect(schema(db)).toEqual({ version: 9 });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'research_history%'",
        )
        .all(),
    ).toEqual([]);
  });
  it("preserves immutable imported history through online backup and a new-file restore", async () => {
    const { researchHistoryFixture } =
      await import("../../../packages/market-data/research-history-fixture.js");
    const {
      previewResearchHistory,
      importResearchHistory,
      readResearchHistory,
    } = await import("../research-history.js");
    const dir = directory(),
      path = join(dir, "history.sqlite"),
      backup = join(dir, "history-backup.sqlite"),
      target = join(dir, "history-restored.sqlite");
    const store = current(path),
      manifest = researchHistoryFixture(),
      now = Date.parse("2026-10-12");
    const instrument = {
      id: manifest.instrumentId,
      symbol: "HISTORY.US",
      name: "synthetic offline fixture",
      market: "US" as const,
      currency: "USD" as const,
      tick: "0.01",
      qMin: 1,
      qStep: 1,
      sellSameDay: true,
      rulesVerified: false,
    };
    store.putInstrument({
      instrument,
      manual: true,
      note: "synthetic",
      tags: [],
    });
    const preview = previewResearchHistory(store, instrument, manifest, now);
    const imported = importResearchHistory(
      store,
      instrument,
      {
        manifest,
        token: preview.token,
        expectedHistoryId: preview.expectedHistoryId,
        expectedActionVersion: preview.expectedActionVersion,
        confirmed: true,
      },
      now,
    );
    const before = readResearchHistory(store.db, instrument.id);
    await backupDatabase(path, backup);
    await restoreDatabase(backup, target);
    const restored = current(target);
    expect(
      readResearchHistory(restored.db, instrument.id, imported.history.id),
    ).toEqual(before);
    expect(restored.db.pragma("foreign_key_check")).toEqual([]);
    expect(() => restored.db.exec("DELETE FROM research_history")).toThrow(
      "IMMUTABLE_RESEARCH_HISTORY",
    );
  });
});

describe("formal closed-bar migration", () => {
  it("backs up v10 before installing the formal runtime without modifying research bytes", async () => {
    const dir = directory(),
      path = join(dir, "v10.sqlite");
    const db = old(path, 10);
    db.prepare("INSERT INTO settings VALUES(?,?)").run(
      "v10-marker",
      "exact existing bytes",
    );
    db.close();
    const backup = await backupBeforeMigration(path, join(dir, "backups"));
    expect(backup?.schemaVersion).toBe(10);
    const upgraded = current(path);
    expect(schema(upgraded.db)).toEqual({ version: 13 });
    expect(upgraded.setting("v10-marker")).toBe("exact existing bytes");
    expect(
      upgraded.db.prepare("SELECT COUNT(*) n FROM closed_receipts").get(),
    ).toEqual({ n: 0 });
    expect(
      upgraded.db.prepare("SELECT COUNT(*) n FROM research_history").get(),
    ).toEqual({ n: 0 });
  });
});
