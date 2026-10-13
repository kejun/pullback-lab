import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  linkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Store } from "../store.js";
import { createApp } from "../app.js";
import { DATABASE_MIGRATIONS } from "../migrations.js";
import {
  localAcceptanceUrl,
  runLocalAcceptance as runActual,
  probeLocalHttp,
  type LocalAcceptanceOptions,
  type LocalHttpProbe,
} from "../local-acceptance.js";

const dirs: string[] = [];
const stores: Store[] = [];
function fixture(populated = true) {
  const dir = mkdtempSync(join(tmpdir(), "pullback-local-check-"));
  dirs.push(dir);
  const source = join(dir, "live.sqlite");
  const store = new Store(source);
  stores.push(store);
  if (populated)
    store.db.exec(`
    INSERT INTO sessions VALUES('SECRET-session',9999999999999);
    INSERT INTO command_results VALUES('SECRET-key','/api/funds','SECRET-hash','{"SECRET":"result"}');
    INSERT INTO settings VALUES('funds_generation','1');
    INSERT INTO settings VALUES('private','SECRET-setting');
    INSERT INTO account_snapshots VALUES(1,'{"generation":1,"stale":false,"nav":"SECRET-money"}');
    INSERT INTO plans VALUES('SECRET-active',1,'{"id":"SECRET-active","version":1,"status":"ARMED","updatedAt":1}');
    INSERT INTO plans VALUES('SECRET-triggered',1,'{"id":"SECRET-triggered","version":1,"status":"TRIGGERED","updatedAt":1}');
    INSERT INTO reservations VALUES('SECRET-triggered',1,'{"planId":"SECRET-triggered","state":"ACTIVE","cash":"SECRET-cash"}');
    INSERT INTO plan_versions VALUES('SECRET-triggered',1,'{"SECRET":"plan"}');
    INSERT INTO decision_inputs VALUES('SECRET-input','{"SECRET":"input"}');
    INSERT INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES('SECRET-event','SECRET-attempt','ENTRY_TRIGGERED','SECRET-event-key','SECRET-input','{"SECRET":"event"}');
    INSERT INTO record_revisions VALUES('SECRET-feedback','SECRET-event',1,'{"SECRET":"feedback"}');
  `);
  const options = {
    databasePath: source,
    outputDirectory: join(dir, "result"),
    baseUrl: "http://127.0.0.1:3000",
  };
  return { dir, source, store, options };
}
let probe: LocalHttpProbe;
function runLocalAcceptance(options: LocalAcceptanceOptions) {
  return runActual(options, probe);
}
function mockHttp() {
  probe = vi.fn(async (url: string) =>
    url.endsWith("/health")
      ? { status: 200, body: '{"ok":true,"dataReady":false}' }
      : { status: 401, body: '{"SECRET":"never exported"}' },
  );
  return probe;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("private non-destructive local acceptance", () => {
  it("checks a committed WAL snapshot, restores only a new copy, preserves source state and redacts private details", async () => {
    const { dir, source, store, options } = fixture();
    const fetch = mockHttp();
    const writer = new Database(source);
    writer.exec("BEGIN IMMEDIATE");
    writer
      .prepare(
        "INSERT INTO settings VALUES('uncommitted','SECRET-uncommitted')",
      )
      .run();
    const before = store.db.prepare("SELECT * FROM account_snapshots").all();
    try {
      const report = await runLocalAcceptance(options);
      expect(report.checks.every((check) => check.status === "PASS")).toBe(
        true,
      );
      expect(report.coverage).toEqual({
        historicalEventsPresent: true,
        reservationsPresent: true,
        fundsPresent: true,
        activePlansPresent: true,
        sessionsPresent: true,
        commandsPresent: true,
      });
      expect(report.releaseStatus).toBe("NOT_ACCEPTED");
      expect(report.remaining).toContain("INDEPENDENT_MEDIA_RESTORE");
      expect(report.source.runningServerCommit).toBe("UNVERIFIED");
      expect(fetch).toHaveBeenCalledTimes(5);
      const output = readFileSync(
        join(options.outputDirectory, "report.json"),
        "utf8",
      );
      expect(output).not.toContain("SECRET");
      expect(output).not.toContain(dir);
      expect(output).not.toContain("token_hash");
      expect(store.db.prepare("SELECT * FROM account_snapshots").all()).toEqual(
        before,
      );
      expect(store.db.prepare("SELECT count(*) n FROM sessions").get()).toEqual(
        { n: 1 },
      );
      expect(
        JSON.parse(
          (
            store.db
              .prepare("SELECT json FROM plans WHERE id='SECRET-active'")
              .get() as { json: string }
          ).json,
        ).status,
      ).toBe("ARMED");
      const backup = new Database(
        join(options.outputDirectory, "backup.sqlite"),
        { readonly: true },
      );
      try {
        expect(
          backup
            .prepare("SELECT value FROM settings WHERE key='uncommitted'")
            .get(),
        ).toBeUndefined();
      } finally {
        backup.close();
      }
      for (const name of ["report.json", "backup.sqlite", "restored.sqlite"])
        expect(statSync(join(options.outputDirectory, name)).mode & 0o777).toBe(
          0o600,
        );
      expect(statSync(options.outputDirectory).mode & 0o777).toBe(0o700);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
  it("does not turn an empty deployment into evidence of historical or active-state recovery", async () => {
    const { options } = fixture(false);
    mockHttp();
    const report = await runLocalAcceptance(options);
    expect(Object.values(report.coverage!)).not.toContain(true);
    for (const id of [
      "funds_stale",
      "plans_paused",
      "sessions_invalidated",
      "commands_invalidated",
      "reservations_preserved",
    ])
      expect(report.checks.find((c) => c.id === id)?.status).toBe(
        "NOT_APPLICABLE",
      );
  });
  it("rejects remote origins, credentials, paths, queries and fragments before network or filesystem work", async () => {
    const { options } = fixture();
    const fetch = mockHttp();
    for (const baseUrl of [
      "https://example.com",
      "http://localhost:3000",
      "http://127.0.0.1:3000/api",
      "http://secret@127.0.0.1",
      "http://127.0.0.1?token=secret",
      "http://127.0.0.1/#x",
    ])
      await expect(runLocalAcceptance({ ...options, baseUrl })).rejects.toThrow(
        "LOOPBACK_ORIGIN_REQUIRED",
      );
    expect(fetch).not.toHaveBeenCalled();
    expect(localAcceptanceUrl("http://[::1]:3000/")).toBe("http://[::1]:3000");
  });
  it("refuses existing outputs, symlinks and SQLite-family destination collisions", async () => {
    const { dir, source, options } = fixture();
    mockHttp();
    await expect(
      runLocalAcceptance({ ...options, outputDirectory: source + "-journal" }),
    ).rejects.toThrow("OUTPUT_DATABASE_COLLISION");
    writeFileSync(options.outputDirectory, "keep");
    await expect(runLocalAcceptance(options)).rejects.toThrow(
      "OUTPUT_DIRECTORY_EXISTS",
    );
    expect(readFileSync(options.outputDirectory, "utf8")).toBe("keep");
    const link = join(dir, "link");
    symlinkSync(join(dir, "missing"), link);
    await expect(
      runLocalAcceptance({ ...options, outputDirectory: link }),
    ).rejects.toThrow("OUTPUT_DIRECTORY_EXISTS");
  });
  it("rejects hard-linked source aliases without migrating or opening a Store on them", async () => {
    const { dir, source, options } = fixture();
    mockHttp();
    linkSync(source, join(dir, "alias.sqlite"));
    const report = await runLocalAcceptance(options);
    expect(report.checks[0]).toMatchObject({
      status: "FAIL",
      code: "REGULAR_SINGLE_LINK_DATABASE_REQUIRED",
    });
    expect(readdirSync(options.outputDirectory)).toEqual(["report.json"]);
  });
  it("reports corrupt and old schemas safely, without modifying source bytes", async () => {
    for (const old of [false, true]) {
      const { source, store, options } = fixture(false);
      store.close();
      if (old) {
        const db = new Database(source);
        db.exec(
          `DROP TRIGGER schema_migrations_immutable_delete; DELETE FROM schema_migrations WHERE version=${DATABASE_MIGRATIONS.length}`,
        );
        db.close();
      } else writeFileSync(source, "SECRET-corrupt");
      mockHttp();
      const before = readFileSync(source);
      const report = await runLocalAcceptance(options);
      expect(report.checks[0].status).toBe("FAIL");
      expect(readFileSync(source)).toEqual(before);
      expect(JSON.stringify(report)).not.toContain("SECRET");
      expect(readdirSync(options.outputDirectory)).toEqual(["report.json"]);
    }
  });
  it("records denied access as failure rather than accepting redirects or leaking response bodies", async () => {
    const { options } = fixture(false);
    probe = vi.fn(async () => ({ status: 302, body: "SECRET" }));
    const report = await runLocalAcceptance(options);
    expect(
      report.checks
        .filter(
          (c) =>
            c.id.startsWith("anonymous") ||
            c.id === "http_health" ||
            c.id === "encoded_api_rejected",
        )
        .every((c) => c.status === "FAIL"),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });
  it("direct loopback HTTP ignores redirects, omits credentials, and bounds response bodies and stalled streams", async () => {
    const server = createServer((request, response) => {
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
      if (request.url === "/redirect") {
        response.writeHead(302, {
          location: "https://external.example/SECRET",
        });
        response.end();
      } else if (request.url === "/large") response.end("x".repeat(4097));
      else if (request.url === "/stall") response.writeHead(200).flushHeaders();
      else response.end('{"ok":true,"dataReady":false}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      expect(await probeLocalHttp(base + "/health")).toEqual({
        status: 200,
        body: '{"ok":true,"dataReady":false}',
      });
      expect((await probeLocalHttp(base + "/redirect")).status).toBe(302);
      await expect(probeLocalHttp(base + "/large")).rejects.toThrow(
        "HTTP_BODY_LIMIT",
      );
      await expect(probeLocalHttp(base + "/stall")).rejects.toThrow(
        "HTTP_TIMEOUT",
      );
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });
  it("runs the complete CLI against a real local app and emits a redacted short summary", async () => {
    const { source, options } = fixture(false);
    const app = await createApp({
      databasePath: source,
      password: "SECRET-password",
    });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolveResult, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              "scripts/local-acceptance.ts",
              "--database",
              source,
              "--url",
              baseUrl,
              "--output-dir",
              options.outputDirectory,
              "--summary",
            ],
            { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
          );
          let output = "";
          const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
          child.stdout.on("data", (data) => (output += String(data)));
          child.stderr.on("data", (data) => (output += String(data)));
          child.on("error", reject);
          child.on("close", (code) => {
            clearTimeout(timeout);
            resolveResult({ code, output });
          });
        },
      );
      expect(result.code).toBe(0);
      const summary = JSON.parse(result.output);
      expect(summary.summary).toBe(true);
      expect(summary.releaseStatus).toBe("NOT_ACCEPTED");
      expect(summary.checks.FAIL).toBe(0);
      expect(summary.checks.NOT_APPLICABLE).toBe(5);
      expect(result.output).not.toContain("SECRET");
      expect(result.output).not.toContain(source);
      const full = JSON.parse(
        readFileSync(join(options.outputDirectory, "report.json"), "utf8"),
      );
      expect(
        full.checks.filter((c: { status: string }) => c.status === "PASS"),
      ).toHaveLength(10);
    } finally {
      await app.close();
    }
  });
  it("CLI validation is bounded and does not echo paths, credentials or raw stack traces", async () => {
    const { dir } = fixture(false);
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolveResult, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/local-acceptance.ts",
            "--database",
            join(dir, "SECRET-path"),
            "--url",
            "https://SECRET-token@example.com",
            "--output-dir",
            join(dir, "result"),
          ],
          {
            cwd: resolve("."),
            env: {
              ...process.env,
              PULLBACK_PASSWORD: "SECRET-password",
              LONGBRIDGE_APP_SECRET: "SECRET-key",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
        child.stdout.on("data", (data) => (output += String(data)));
        child.stderr.on("data", (data) => (output += String(data)));
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timeout);
          resolveResult({ code, output });
        });
      },
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("LOCAL_ACCEPTANCE_FAILED");
    expect(result.output).not.toContain("SECRET");
    expect(result.output).not.toContain(dir);
  });
});
