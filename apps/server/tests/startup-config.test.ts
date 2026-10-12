import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { readStartupConfig } from "../startup-config.js";
import { DATABASE_MIGRATIONS, runMigrations } from "../migrations.js";

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "pullback-startup-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const production = {
  NODE_ENV: "production",
  PULLBACK_PASSWORD: "private-test-password",
  PULLBACK_ORIGIN: "https://research.example.test",
};
function buildStub(path: string) {
  mkdirSync(join(path, "dist/web"), { recursive: true });
  writeFileSync(join(path, "dist/web/index.html"), "<!doctype html>");
}
function main(env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "apps/server/main.ts"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        PULLBACK_DEMO: "0",
        PULLBACK_MARKET_WORKER: "0",
        PULLBACK_RESTORED: "0",
        HOST: "127.0.0.1",
        ...env,
      },
      encoding: "utf8",
      timeout: 10000,
      killSignal: "SIGKILL",
      maxBuffer: 100_000,
    },
  );
}

describe("read-only startup preflight", () => {
  it("requires a production origin and built UI without creating database or lock files", () => {
    const cwd = directory();
    expect(() => readStartupConfig(production, cwd)).toThrow("页面尚未构建");
    expect(existsSync(join(cwd, "data"))).toBe(false);
    buildStub(cwd);
    const config = readStartupConfig(
      { ...production, PULLBACK_ORIGIN: production.PULLBACK_ORIGIN + "/" },
      cwd,
    );
    expect(config).toMatchObject({
      origin: production.PULLBACK_ORIGIN,
      production: true,
      demo: false,
      restore: false,
      port: 3000,
    });
    expect(config.backupDirectory).toBe(join(cwd, "data/backups"));
    expect(existsSync(join(cwd, "data"))).toBe(false);
    expect(
      readStartupConfig({ PULLBACK_PASSWORD: "local-password", PORT: "0" }, cwd)
        .port,
    ).toBe(0);
  });
  it("rejects unsafe origins and invalid switches instead of silently changing behavior", () => {
    const cwd = directory();
    buildStub(cwd);
    for (const origin of [
      "http://research.example.test",
      "https://user:secret@research.example.test",
      "https://research.example.test/path",
      "https://research.example.test/?token=secret",
      "https://research.example.test/#secret",
      "not-an-origin",
    ])
      expect(() =>
        readStartupConfig({ ...production, PULLBACK_ORIGIN: origin }, cwd),
      ).toThrow();
    for (const values of [
      { PULLBACK_ORIGIN: undefined },
      { PULLBACK_PASSWORD: "        " },
      { PORT: "0" },
      { PORT: "65536" },
      { PORT: "12.5" },
      { HOST: "bad?host" },
      { HOST: "host:3000" },
      { HOST: "-badhost" },
      { PULLBACK_DB: ":memory:" },
      { PULLBACK_BACKUP_DIR: "" },
      { PULLBACK_MARKET_WORKER: "yes" },
      { PULLBACK_DEMO: "yes" },
    ])
      expect(() =>
        readStartupConfig({ ...production, ...values }, cwd),
      ).toThrow();
  });
  it("rejects an invalid production start before touching a database and redacts input values", () => {
    const db = join(directory(), "private-path-canary.sqlite");
    const result = main({
      ...production,
      PULLBACK_DB: db,
      PULLBACK_PASSWORD: "tiny",
      PULLBACK_ORIGIN: "https://secret-origin.example.test/?canary=private",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PASSWORD_NOT_CONFIGURED");
    expect(result.stderr).not.toContain("tiny");
    expect(result.stderr).not.toContain("secret-origin");
    expect(result.stderr).not.toContain(db);
    expect(existsSync(db)).toBe(false);
    expect(existsSync(`${db}.service-lock.sqlite`)).toBe(false);
  });
  it("stops an upgrade if its pre-migration backup cannot be created", () => {
    const path = directory(),
      dbPath = join(path, "existing.sqlite"),
      denied = join(path, "not-a-directory");
    const db = new Database(dbPath);
    runMigrations(db, DATABASE_MIGRATIONS.slice(0, 4));
    db.prepare(
      "INSERT INTO settings VALUES('upgrade-canary','preserved')",
    ).run();
    db.close();
    writeFileSync(denied, "do not replace");
    const result = main({
      ...production,
      NODE_ENV: "test",
      PORT: "0",
      PULLBACK_DB: dbPath,
      PULLBACK_BACKUP_DIR: denied,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(dbPath);
    const after = new Database(dbPath, { readonly: true });
    try {
      expect(
        after
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 4 });
      expect(
        after
          .prepare("SELECT value FROM settings WHERE key='upgrade-canary'")
          .get(),
      ).toEqual({ value: "preserved" });
      expect(
        after
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='screening_rule_versions'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      after.close();
    }
  });
});
