import Database from "better-sqlite3";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireServiceLock,
  assertSQLiteRuntime,
  isSupportedSQLiteVersion,
} from "../runtime-safety.js";
import {
  DATABASE_MIGRATIONS,
  initializeDatabase,
  runMigrations,
} from "../migrations.js";
import { Store } from "../store.js";

const directories: string[] = [];
const children = new Set<ChildProcess>();
const databases = new Set<Database.Database>();
const handles: { release(): void }[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "pullback-runtime-"));
  directories.push(path);
  return path;
}
function database(path = ":memory:") {
  const db = new Database(path);
  databases.add(db);
  return db;
}
function v1Database(path = ":memory:") {
  const db = database(path);
  db.exec(
    readFileSync(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8"),
  );
  db.exec(`
    INSERT INTO settings VALUES('funds_generation','1');
    INSERT INTO plan_versions VALUES('plan-1',1,'{"frozen":"plan"}');
    INSERT INTO account_snapshots VALUES(1,'{"generation":1,"stale":false}');
    INSERT INTO decision_inputs VALUES('input-1','{"frozen":"input"}');
    INSERT INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES('event-1','attempt-1','TECHNICAL_TRIGGERED','key-1','input-1','{"frozen":"event"}');
    INSERT INTO record_revisions VALUES('revision-1','event-1',123,'{"kind":"SKIPPED"}');
  `);
  return db;
}
function track(child: ChildProcess) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
function lockChild(path: string) {
  const child = track(
    fork(resolve("apps/server/tests/fixtures/service-lock-child.ts"), [path], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  );
  const result = once(child, "message").then(
    ([message]) => message as { kind: string; code?: string },
  );
  return { child, result };
}
async function releaseChild(child: ChildProcess) {
  const exited = once(child, "exit");
  child.send("release");
  expect(await exited).toEqual([0, null]);
}
async function mainChild(path: string) {
  const child = track(
    spawn(process.execPath, ["--import", "tsx", "apps/server/main.ts"], {
      env: {
        ...process.env,
        PULLBACK_DB: path,
        PULLBACK_PASSWORD: "runtime-test-password",
        PULLBACK_DEMO: "0",
        PULLBACK_MARKET_WORKER: "0",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  let output = "";
  child.stdout!.on("data", (data) => {
    output += String(data);
  });
  child.stderr!.on("data", (data) => {
    output += String(data);
  });
  return { child, output: () => output };
}
async function waitForListening(child: ChildProcess, output: () => string) {
  if (output().includes("Server listening at")) return;
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(
      () => done(new Error(`Server did not listen: ${output()}`)),
      7000,
    );
    function done(error?: Error) {
      clearTimeout(timeout);
      child.stdout!.off("data", onData);
      child.off("exit", onExit);
      error ? reject(error) : resolveReady();
    }
    function onData() {
      if (output().includes("Server listening at")) done();
    }
    function onExit() {
      done(new Error(`Server exited before listening: ${output()}`));
    }
    child.stdout!.on("data", onData);
    child.once("exit", onExit);
  });
}

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }),
  );
  for (const handle of handles.splice(0)) handle.release();
  for (const db of databases) if (db.open) db.close();
  databases.clear();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("loaded SQLite runtime", () => {
  it("accepts stable fixed versions and only specifically documented older backports", () => {
    for (const version of [
      "3.44.6",
      "3.50.7",
      "3.51.3",
      "3.51.4",
      "3.53.0",
      "3.53.4",
    ])
      expect(isSupportedSQLiteVersion(version), version).toBe(true);
    for (const version of [
      "3.44.5",
      "3.44.7",
      "3.50.6",
      "3.50.8",
      "3.51.2",
      "3.52.0",
      "3.52.1",
      "4.0.0",
      "unknown",
    ])
      expect(isSupportedSQLiteVersion(version), version).toBe(false);
    const db = database();
    expect(assertSQLiteRuntime(db)).toBe(
      (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v,
    );
  });
  it("checks the engine before enabling WAL or creating schema", () => {
    const db = database(join(directory(), "old.sqlite"));
    db.function("sqlite_version", () => "3.51.2");
    expect(() => initializeDatabase(db)).toThrow("SQLite 3.51.2");
    expect(db.pragma("journal_mode", { simple: true })).toBe("delete");
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  });
});

describe("transactional schema migration and immutable facts", () => {
  it("upgrades a released v1 file without altering history and can be reopened", () => {
    const path = join(directory(), "v1.sqlite");
    const old = v1Database(path);
    old.close();
    const db = database(path);
    initializeDatabase(db);
    const first = db
      .prepare("SELECT * FROM schema_migrations ORDER BY version")
      .all();
    expect(first).toHaveLength(DATABASE_MIGRATIONS.length);
    expect(db.prepare("SELECT json FROM plan_versions").get()).toEqual({
      json: '{"frozen":"plan"}',
    });
    expect(db.prepare("SELECT * FROM record_revisions").get()).toMatchObject({
      id: "revision-1",
      created_at: 123,
    });
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    initializeDatabase(db);
    expect(
      db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
    ).toEqual(first);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('market_provider_receipts','market_raw_inputs','market_bar_revisions') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "market_bar_revisions" },
      { name: "market_provider_receipts" },
      { name: "market_raw_inputs" },
    ]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });
  it("blocks UPDATE, DELETE and REPLACE from a separate connection with recursive triggers disabled", () => {
    const path = join(directory(), "facts.sqlite");
    const initial = v1Database(path);
    initializeDatabase(initial);
    const db = database(path);
    db.pragma("recursive_triggers = OFF");
    const cases = [
      {
        table: "plan_versions",
        replace:
          "INSERT OR REPLACE INTO plan_versions VALUES('plan-1',1,'changed')",
      },
      {
        table: "account_snapshots",
        replace: "INSERT OR REPLACE INTO account_snapshots VALUES(1,'changed')",
      },
      {
        table: "decision_inputs",
        replace:
          "INSERT OR REPLACE INTO decision_inputs VALUES('input-1','changed')",
      },
      {
        table: "decision_events",
        replace:
          "INSERT OR REPLACE INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES('event-1','attempt-1','TECHNICAL_TRIGGERED','key-1','input-1','changed')",
      },
      {
        table: "record_revisions",
        replace:
          "INSERT OR REPLACE INTO record_revisions VALUES('revision-1','event-1',456,'changed')",
      },
    ];
    for (const { table, replace } of cases) {
      const before = db.prepare(`SELECT * FROM ${table}`).all();
      expect(
        () => db.exec(`UPDATE ${table} SET json='changed'`),
        table,
      ).toThrow("append-only");
      expect(() => db.exec(`DELETE FROM ${table}`), table).toThrow(
        "append-only",
      );
      expect(() => db.exec(replace), table).toThrow("append-only");
      expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(before);
    }
    // A new id/key may also replace an old row via the partial unique index.
    expect(() =>
      db.exec(
        "INSERT OR REPLACE INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES('new-event','attempt-1','TECHNICAL_TRIGGERED','new-key','input-1','changed')",
      ),
    ).toThrow("append-only");
    db.exec(
      "INSERT INTO decision_inputs VALUES('input-2','new immutable fact')",
    );
    expect(
      db.prepare("SELECT count(*) AS n FROM decision_inputs").get(),
    ).toEqual({ n: 2 });
    db.exec("UPDATE settings SET value='2' WHERE key='funds_generation'");
    expect(db.prepare("SELECT value FROM settings").get()).toEqual({
      value: "2",
    });
  });
  it("rolls back all pending DDL, data and migration markers when any migration fails", () => {
    const db = v1Database();
    expect(() =>
      runMigrations(db, [
        ...DATABASE_MIGRATIONS,
        {
          version: DATABASE_MIGRATIONS.length + 1,
          apply(connection) {
            connection.exec(
              "CREATE TABLE should_rollback(id INTEGER); UPDATE settings SET value='999';",
            );
            throw new Error("simulated migration interruption");
          },
        },
      ]),
    ).toThrow("simulated migration interruption");
    expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
      { version: 1 },
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' OR name='should_rollback' OR name LIKE 'market_%' OR name LIKE 'runtime_%' OR name LIKE 'event_%' OR name LIKE 'screening_%'",
        )
        .all(),
    ).toEqual([]);
    expect(db.prepare("SELECT value FROM settings").get()).toEqual({
      value: "1",
    });
    initializeDatabase(db);
    expect(
      db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(DATABASE_MIGRATIONS.map(({ version }) => ({ version })));
  });
  it("refuses newer or discontinuous schema histories", () => {
    const newer = database();
    initializeDatabase(newer);
    newer
      .prepare("INSERT INTO schema_migrations VALUES(?,1)")
      .run(DATABASE_MIGRATIONS.length + 1);
    expect(() => runMigrations(newer)).toThrow("更新版本");
    const gap = v1Database();
    gap.exec("INSERT INTO schema_migrations VALUES(3,1)");
    expect(() => runMigrations(gap)).toThrow("不连续");
  });
});

describe("cross-process service ownership", () => {
  it("has exactly one winner under simultaneous process startup, then permits normal release", async () => {
    const path = join(directory(), "db.sqlite");
    const a = lockChild(path),
      b = lockChild(path);
    const results = await Promise.all([a.result, b.result]);
    expect(results.map((r) => r.kind).sort()).toEqual(["acquired", "rejected"]);
    expect(results.find((r) => r.kind === "rejected")!.code).toBe(
      "SERVICE_ALREADY_RUNNING",
    );
    const winner = results[0].kind === "acquired" ? a.child : b.child;
    await releaseChild(winner);
    expect(existsSync(`${path}.service-lock.sqlite`)).toBe(true);
    const next = lockChild(path);
    expect((await next.result).kind).toBe("acquired");
    await releaseChild(next.child);
  });
  it("recovers ownership after SIGKILL without deleting or timing out a stale file", async () => {
    const path = join(directory(), "db.sqlite");
    const first = lockChild(path);
    expect((await first.result).kind).toBe("acquired");
    const exited = once(first.child, "exit");
    first.child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    expect(existsSync(`${path}.service-lock.sqlite`)).toBe(true);
    const recovered = lockChild(path);
    expect((await recovered.result).kind).toBe("acquired");
    await releaseChild(recovered.child);
  });
  it("allows different databases and multiple independent Store connections", async () => {
    const dir = directory();
    const a = lockChild(join(dir, "a.sqlite")),
      b = lockChild(join(dir, "b.sqlite"));
    expect((await a.result).kind).toBe("acquired");
    expect((await b.result).kind).toBe("acquired");
    const first = new Store(join(dir, "a.sqlite"));
    const second = new Store(join(dir, "a.sqlite"));
    try {
      first.setSetting("connection", "first");
      expect(second.setting("connection")).toBe("first");
      second.setSetting("connection", "second");
      expect(first.setting("connection")).toBe("second");
    } finally {
      first.close();
      second.close();
    }
    await releaseChild(a.child);
    await releaseChild(b.child);
  });
  it("uses the canonical target for symlink paths and refuses hard-linked databases", () => {
    const dir = directory(),
      path = join(dir, "db.sqlite");
    const db = database(path);
    initializeDatabase(db);
    db.close();
    const lock = acquireServiceLock(path);
    handles.push(lock);
    symlinkSync(path, join(dir, "alias.sqlite"));
    expect(() => acquireServiceLock(join(dir, "alias.sqlite"))).toThrow(
      "已有服务进程",
    );
    lock.release();
    symlinkSync(join(dir, "missing.sqlite"), join(dir, "dangling.sqlite"));
    expect(() => acquireServiceLock(join(dir, "dangling.sqlite"))).toThrow(
      "目标必须已经存在",
    );
    linkSync(path, join(dir, "hardlink.sqlite"));
    expect(() => acquireServiceLock(path)).toThrow("单一硬链接");
  });
  it("rejects a second real main process before it can invalidate funds again", async () => {
    const path = join(directory(), "main.sqlite");
    const seeded = v1Database(path);
    seeded.close();
    const first = await mainChild(path);
    await waitForListening(first.child, first.output);
    const observer = database(path);
    expect(
      observer
        .prepare("SELECT value FROM settings WHERE key='funds_generation'")
        .get(),
    ).toEqual({ value: "2" });
    const snapshotCount = observer
      .prepare("SELECT count(*) AS n FROM account_snapshots")
      .get();
    const second = await mainChild(path);
    const [code] = await once(second.child, "exit");
    expect(code).toBe(1);
    expect(second.output()).toContain("SERVICE_ALREADY_RUNNING");
    expect(
      observer
        .prepare("SELECT value FROM settings WHERE key='funds_generation'")
        .get(),
    ).toEqual({ value: "2" });
    expect(
      observer.prepare("SELECT count(*) AS n FROM account_snapshots").get(),
    ).toEqual(snapshotCount);
    const exited = once(first.child, "exit");
    first.child.kill("SIGTERM");
    expect(await exited).toEqual([0, null]);
    const next = lockChild(path);
    expect((await next.result).kind).toBe("acquired");
    await releaseChild(next.child);
  });
});
