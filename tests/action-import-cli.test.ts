import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../apps/server/store.js";
import {
  DATABASE_MIGRATIONS,
  runMigrations,
} from "../apps/server/migrations.js";
import { acquireServiceLock } from "../apps/server/runtime-safety.js";
import { demoInstruments } from "../packages/market-data/fixtures.js";
import { ActionEvidenceRepository } from "../packages/market-data/action-evidence.js";
import { actionTestManifest } from "../packages/market-data/action-evidence-fixture.js";
import {
  backupDatabase,
  restoreDatabase,
} from "../apps/server/backup-service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "action-cli-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite"),
    file = join(dir, "private-manifest.json");
  const store = new Store(path);
  store.putInstrument({
    instrument: demoInstruments[0],
    tags: [],
    note: "synthetic",
    manual: false,
  });
  store.close();
  writeFileSync(file, JSON.stringify(actionTestManifest()));
  const run = (args: string[], databasePath = path) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/import-actions.ts", ...args],
      {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, PULLBACK_DB: databasePath },
        encoding: "utf8",
        timeout: 7000,
        maxBuffer: 128_000,
      },
    );
  return { dir, path, file, run };
}
describe("offline action evidence operator CLI", () => {
  it("previews no migration and backs up a released v5 database before explicit apply", () => {
    const { dir, file, run } = setup(),
      oldPath = join(dir, "old.sqlite");
    const old = new Database(oldPath);
    runMigrations(old, DATABASE_MIGRATIONS.slice(0, 5));
    old
      .prepare("INSERT INTO instruments VALUES(?,?)")
      .run(
        "DEMO-US-A",
        JSON.stringify({
          instrument: demoInstruments[0],
          tags: [],
          note: "synthetic",
          manual: false,
        }),
      );
    old.close();
    expect(JSON.parse(run([file], oldPath).stderr).code).toBe(
      "ACTION_SCHEMA_UPGRADE_REQUIRED",
    );
    expect(existsSync(join(dir, "backups"))).toBe(false);
    const applied = run([file, "--apply"], oldPath);
    expect(applied.error).toBeUndefined();
    expect(applied.status).toBe(0);
    const backups = readdirSync(join(dir, "backups")).filter((name) =>
      name.endsWith(".sqlite"),
    );
    expect(backups).toHaveLength(1);
    const prior = new Database(join(dir, "backups", backups[0]), {
      readonly: true,
    });
    try {
      expect(
        prior
          .prepare("SELECT MAX(version) version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 5 });
    } finally {
      prior.close();
    }
    expect(
      JSON.parse(run(["--current", "DEMO-US-A"], oldPath).stdout).version,
    ).toBe(JSON.parse(applied.stdout).version);
  });
  it("defaults to read-only preview and requires explicit apply; duplicate retry keeps the first receipt", () => {
    const { path, file, run } = setup();
    const preview = run([file]);
    expect(preview.error).toBeUndefined();
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      status: "PREVIEW",
      liveEligible: false,
    });
    const db = new Database(path, { readonly: true });
    try {
      expect(new ActionEvidenceRepository(db).latest("DEMO-US-A")).toBeNull();
    } finally {
      db.close();
    }
    const apply = run([file, "--apply"]);
    expect(apply.status).toBe(0);
    const receipt = JSON.parse(apply.stdout);
    expect(receipt.status).toBe("IMPORTED");
    const current = run(["--current", "DEMO-US-A"]);
    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout)).toMatchObject({
      status: "CURRENT",
      version: receipt.version,
      liveEligible: false,
    });
    const repeat = run([file, "--apply"]);
    expect(repeat.status).toBe(0);
    expect(JSON.parse(repeat.stdout)).toMatchObject({
      status: "DUPLICATE",
      recordedAt: receipt.recordedAt,
      version: receipt.version,
    });
    expect(apply.stdout + apply.stderr).not.toContain("SYNTHETIC TEST ONLY");
    expect(apply.stdout + apply.stderr).not.toContain(file);
  });
  it("refuses writing while the service owns the database but preview remains available", () => {
    const { path, file, run } = setup(),
      lock = acquireServiceLock(path);
    try {
      expect(run([file]).status).toBe(0);
      const result = run([file, "--apply"]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr).code).toBe("SERVICE_ALREADY_RUNNING");
    } finally {
      lock.release();
    }
  });
  it("rejects missing database, malformed/private input, unknown flags and oversized evidence without leaking values", () => {
    const { dir, file, run } = setup(),
      missing = join(dir, "missing.sqlite");
    expect(run([file], missing).status).toBe(1);
    expect(existsSync(missing)).toBe(false);
    const invalid = run([file, "private-secret-value"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr + invalid.stdout).not.toContain(
      "private-secret-value",
    );
    writeFileSync(file, "private-invalid-json");
    const bad = run([file]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).not.toContain("private-invalid-json");
    writeFileSync(file, "x".repeat(4_000_001));
    expect(JSON.parse(run([file]).stderr).code).toBe("EVIDENCE_SIZE_LIMIT");
  });
  it("preserves source documents and cutoff history through online backup and new-file restore", async () => {
    const { path, file, run, dir } = setup();
    expect(run([file, "--apply"]).status).toBe(0);
    const backup = join(dir, "backup.sqlite"),
      restored = join(dir, "restored.sqlite");
    await backupDatabase(path, backup);
    await restoreDatabase(backup, restored);
    const before = new Database(path, { readonly: true }),
      after = new Database(restored, { readonly: true });
    try {
      expect(new ActionEvidenceRepository(after).latest("DEMO-US-A")).toEqual(
        new ActionEvidenceRepository(before).latest("DEMO-US-A"),
      );
      expect(after.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      before.close();
      after.close();
    }
  });
});
