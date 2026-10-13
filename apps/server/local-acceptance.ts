import Database from "better-sqlite3";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  backupDatabase,
  backupErrorMessage,
  restoreDatabase,
} from "./backup-service.js";
import { DATABASE_MIGRATIONS } from "./migrations.js";
import { assertSQLiteRuntime } from "./runtime-safety.js";

export type CheckStatus = "PASS" | "FAIL" | "NOT_RUN" | "NOT_APPLICABLE";
export interface AcceptanceCheck {
  id: string;
  status: CheckStatus;
  code?: string;
}
export interface LocalAcceptanceOptions {
  databasePath: string;
  outputDirectory: string;
  baseUrl: string;
  cwd?: string;
}
export interface LocalAcceptanceReport {
  reportVersion: 1;
  capturedAt: string;
  scope: "LOCAL_READ_ONLY_SOURCE_AND_NEW_RESTORE_COPY";
  releaseStatus: "NOT_ACCEPTED";
  environment: {
    platform: string;
    architecture: string;
    osRelease: string;
    nodeVersion: string;
  };
  source: {
    cliCommit: string | null;
    cliWorktreeClean: boolean | null;
    runningServerCommit: "UNVERIFIED";
  };
  database: {
    sqliteVersion: string;
    schemaVersion: number;
    journalMode: "wal" | "delete" | "other";
    availableBytes: number | null;
  } | null;
  coverage: {
    historicalEventsPresent: boolean;
    reservationsPresent: boolean;
    fundsPresent: boolean;
    activePlansPresent: boolean;
    sessionsPresent: boolean;
    commandsPresent: boolean;
  } | null;
  checks: AcceptanceCheck[];
  remaining: string[];
}

class AcceptanceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const checks = [
  "runtime_database",
  "online_backup",
  "new_file_restore",
  "historical_rows_preserved",
  "reservations_preserved",
  "sessions_invalidated",
  "commands_invalidated",
  "funds_stale",
  "plans_paused",
  "cursor_rotated",
  "http_health",
  "anonymous_api_rejected",
  "anonymous_operations_rejected",
  "anonymous_sse_rejected",
  "encoded_api_rejected",
];
const remaining = [
  "RUNNING_SERVER_SOURCE_AND_DATABASE_IDENTITY",
  "AUTHENTICATED_COOKIE_ORIGIN_CSRF_AND_SSE_RECONNECT",
  "BROWSER_CLOSED_AND_PROCESS_SUPERVISOR_RESTART",
  "HOST_REBOOT_SLEEP_AND_NETWORK_LOSS",
  "INDEPENDENT_MEDIA_RESTORE",
  "HOST_DISK_FULL_AND_POWER_LOSS_DURABILITY",
  "CLOCK_SYNCHRONIZATION",
  "SOURCE_FILESYSTEM_IS_LOCAL_AND_DURABLE",
  "PUBLIC_HTTPS_AND_PROXY_CHAIN_IF_EXPOSED",
  "PER_MARKET_REAL_PROVIDER_ENTITLEMENT_SEMANTICS_AND_CONTINUITY",
  "REAL_END_TO_END_LATENCY_AND_UPSTREAM_DELAY",
];
function record(
  report: LocalAcceptanceReport,
  id: string,
  status: CheckStatus,
  code?: string,
) {
  const check = report.checks.find((entry) => entry.id === id)!;
  check.status = status;
  if (code) check.code = code;
}
/** Numeric loopback only. Never resolve a supplied hostname or follow a redirect. */
export function localAcceptanceUrl(input: string): string {
  try {
    const url = new URL(input);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AcceptanceError("LOOPBACK_ORIGIN_REQUIRED");
  }
}
function fileFamily(path: string) {
  return [path, `${path}.service-lock.sqlite`].flatMap((base) =>
    ["", "-wal", "-shm", "-journal"].map((suffix) => base + suffix),
  );
}
function prepareOutput(options: LocalAcceptanceOptions): string {
  const source = resolve(options.databasePath);
  const output = resolve(options.outputDirectory);
  const canonicalSource = lstatSync(source, { throwIfNoEntry: false })
    ? realpathSync(source)
    : source;
  // Parent must exist: do not create arbitrary directory trees or follow a final symlink.
  const canonicalOutput = join(realpathSync(dirname(output)), basename(output));
  if (
    [...fileFamily(source), ...fileFamily(canonicalSource)].includes(
      canonicalOutput,
    )
  )
    throw new AcceptanceError("OUTPUT_DATABASE_COLLISION");
  if (lstatSync(output, { throwIfNoEntry: false }))
    throw new AcceptanceError("OUTPUT_DIRECTORY_EXISTS");
  mkdirSync(output, { mode: 0o700 });
  return output;
}
function readonly(path: string): Database.Database {
  const info = lstatSync(realpathSync(path));
  if (!info.isFile() || info.nlink !== 1)
    throw new AcceptanceError("REGULAR_SINGLE_LINK_DATABASE_REQUIRED");
  const db = new Database(realpathSync(path), {
    readonly: true,
    fileMustExist: true,
    timeout: 1000,
  });
  try {
    db.pragma("query_only = ON");
    db.exec("BEGIN");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function cliSource(cwd: string): LocalAcceptanceReport["source"] {
  const result: LocalAcceptanceReport["source"] = {
    cliCommit: null,
    cliWorktreeClean: null,
    runningServerCommit: "UNVERIFIED",
  };
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      maxBuffer: 4096,
    }).trim();
    if (/^[a-f0-9]{40}$/.test(commit)) result.cliCommit = commit;
    result.cliWorktreeClean =
      execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=normal"],
        {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
          maxBuffer: 1024 * 1024,
        },
      ).trim() === "";
  } catch {
    /* Do not serialize git errors, repository paths, or branch names. */
  }
  return result;
}
function count(db: Database.Database, table: string): number {
  return (
    db.prepare(`SELECT count(*) n FROM ${quote(table)}`).get() as { n: number }
  ).n;
}
function quote(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}
function digestTable(db: Database.Database, table: string): string {
  const columns = db.pragma(`table_info(${quote(table)})`) as Array<{
    name: string;
    pk: number;
  }>;
  const keys = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  const order = (keys.length ? keys : columns)
    .map((c) => quote(c.name))
    .join(",");
  const hash = createHash("sha256");
  for (const row of db
    .prepare(`SELECT * FROM ${quote(table)} ORDER BY ${order}`)
    .raw()
    .safeIntegers()
    .iterate()) {
    hash.update(
      JSON.stringify(row, (_key, value) =>
        typeof value === "bigint" ? { integer: value.toString() } : value,
      ),
    );
    hash.update("\n");
  }
  // Internal comparison only: do not publish fingerprints of private row contents.
  return hash.digest("hex");
}
function setting(db: Database.Database, key: string): string | null {
  return (
    (
      db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value ?? null
  );
}
function verifyRestore(
  report: LocalAcceptanceReport,
  backup: string,
  restored: string,
) {
  const before = readonly(backup);
  let after: Database.Database;
  try {
    after = readonly(restored);
    const tables = (
      before
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const mutable = new Set([
      "settings",
      "plans",
      "account_snapshots",
      "sessions",
      "command_results",
    ]);
    const equal = (table: string) =>
      digestTable(before, table) === digestTable(after, table);
    const stableSettings = (db: Database.Database) =>
      db
        .prepare(
          "SELECT key,value FROM settings WHERE key NOT IN ('funds_generation','event_feed_epoch') ORDER BY key",
        )
        .all();
    const preserved =
      tables.filter((table) => !mutable.has(table)).every(equal) &&
      JSON.stringify(stableSettings(before)) ===
        JSON.stringify(stableSettings(after));
    record(
      report,
      "historical_rows_preserved",
      preserved ? "PASS" : "FAIL",
      preserved ? undefined : "RESTORE_HISTORY_MISMATCH",
    );
    const reservationCount = count(before, "reservations");
    record(
      report,
      "reservations_preserved",
      !reservationCount
        ? "NOT_APPLICABLE"
        : equal("reservations")
          ? "PASS"
          : "FAIL",
    );
    const sessionCount = count(before, "sessions");
    const commandCount = count(before, "command_results");
    record(
      report,
      "sessions_invalidated",
      count(after, "sessions") !== 0
        ? "FAIL"
        : sessionCount
          ? "PASS"
          : "NOT_APPLICABLE",
    );
    record(
      report,
      "commands_invalidated",
      count(after, "command_results") !== 0
        ? "FAIL"
        : commandCount
          ? "PASS"
          : "NOT_APPLICABLE",
    );
    const priorGeneration = setting(before, "funds_generation");
    const priorFunds = before
      .prepare(
        "SELECT generation,json FROM account_snapshots WHERE generation=?",
      )
      .get(priorGeneration) as { generation: number; json: string } | undefined;
    let oldFundsPreserved = true;
    for (const row of before
      .prepare("SELECT generation,json FROM account_snapshots")
      .iterate() as Iterable<{ generation: number; json: string }>) {
      if (
        (
          after
            .prepare("SELECT json FROM account_snapshots WHERE generation=?")
            .get(row.generation) as { json: string } | undefined
        )?.json !== row.json
      )
        oldFundsPreserved = false;
    }
    const currentFunds = after
      .prepare(
        "SELECT generation,json FROM account_snapshots WHERE generation=?",
      )
      .get(setting(after, "funds_generation")) as
      { generation: number; json: string } | undefined;
    const fundsCorrect = priorFunds
      ? currentFunds?.generation === priorFunds.generation + 1 &&
        JSON.stringify(JSON.parse(currentFunds.json)) ===
          JSON.stringify({
            ...JSON.parse(priorFunds.json),
            generation: priorFunds.generation + 1,
            stale: true,
          }) &&
        oldFundsPreserved &&
        count(after, "account_snapshots") ===
          count(before, "account_snapshots") + 1
      : !currentFunds && oldFundsPreserved;
    record(
      report,
      "funds_stale",
      !fundsCorrect ? "FAIL" : priorFunds ? "PASS" : "NOT_APPLICABLE",
    );
    let active = 0;
    let plansCorrect = count(before, "plans") === count(after, "plans");
    for (const row of before
      .prepare("SELECT id,version,json FROM plans")
      .iterate() as Iterable<{ id: string; version: number; json: string }>) {
      const original = JSON.parse(row.json);
      const result = after
        .prepare("SELECT version,json FROM plans WHERE id=?")
        .get(row.id) as { version: number; json: string } | undefined;
      if (!result) {
        plansCorrect = false;
        continue;
      }
      const plan = JSON.parse(result.json);
      if (["WAIT_RETEST", "ARMED", "DATA_PAUSED"].includes(original.status)) {
        active++;
        const { updatedAt: _beforeTime, ...expected } = {
          ...original,
          status: "DATA_PAUSED",
        };
        const { updatedAt: _afterTime, ...actual } = plan;
        if (
          JSON.stringify(actual) !== JSON.stringify(expected) ||
          result.version !== row.version
        )
          plansCorrect = false;
      } else if (result.json !== row.json || result.version !== row.version)
        plansCorrect = false;
    }
    record(
      report,
      "plans_paused",
      !plansCorrect ? "FAIL" : active ? "PASS" : "NOT_APPLICABLE",
    );
    record(
      report,
      "cursor_rotated",
      setting(after, "event_feed_epoch") &&
        setting(before, "event_feed_epoch") !==
          setting(after, "event_feed_epoch")
        ? "PASS"
        : "FAIL",
    );
    report.coverage = {
      historicalEventsPresent: count(before, "decision_events") > 0,
      reservationsPresent: reservationCount > 0,
      fundsPresent: Boolean(priorFunds),
      activePlansPresent: active > 0,
      sessionsPresent: sessionCount > 0,
      commandsPresent: commandCount > 0,
    };
  } finally {
    before.close();
    after!?.close();
  }
}
export interface LocalHttpResult {
  status: number;
  body: string;
}
export type LocalHttpProbe = (url: string) => Promise<LocalHttpResult>;
/** Direct numeric loopback sockets: ignore proxy environment, reject invalid TLS, never redirect. */
export const probeLocalHttp: LocalHttpProbe = (input) =>
  new Promise((resolveResult, reject) => {
    const url = new URL(input);
    localAcceptanceUrl(url.origin);
    if (url.username || url.password || url.search || url.hash)
      throw new AcceptanceError("LOOPBACK_ORIGIN_REQUIRED");
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: "GET", agent: false, rejectUnauthorized: true },
      (response) => {
        let body = "";
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4096) {
            request.destroy();
            reject(new Error("HTTP_BODY_LIMIT"));
            return;
          }
          body += chunk.toString("utf8");
        });
        response.on("end", () => {
          clearTimeout(timeout);
          resolveResult({ status: response.statusCode ?? 0, body });
        });
        response.on("error", reject);
      },
    );
    const timeout = setTimeout(() => {
      request.destroy(new Error("HTTP_TIMEOUT"));
    }, 2500);
    request.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.on("close", () => clearTimeout(timeout));
    request.end();
  });
async function checkHttp(
  report: LocalAcceptanceReport,
  base: string,
  probe: LocalHttpProbe,
) {
  const routes = [
    ["http_health", "/api/health"],
    ["anonymous_api_rejected", "/api/bootstrap"],
    ["anonymous_operations_rejected", "/api/operations/status"],
    ["anonymous_sse_rejected", "/api/events/stream"],
    ["encoded_api_rejected", "/%61pi/bootstrap"],
  ] as const;
  for (const [id, route] of routes) {
    try {
      const response = await probe(base + route);
      let pass = response.status === 401;
      if (id === "http_health") {
        const health = JSON.parse(response.body);
        pass =
          response.status === 200 &&
          health?.ok === true &&
          typeof health?.dataReady === "boolean";
      }
      record(
        report,
        id,
        pass ? "PASS" : "FAIL",
        pass ? undefined : "HTTP_EXPECTATION_FAILED",
      );
    } catch {
      record(report, id, "FAIL", "HTTP_UNAVAILABLE_OR_INVALID");
    }
  }
}

/** No source Store, migrations, credentials, authentication writes, or provider requests. */
export async function runLocalAcceptance(
  options: LocalAcceptanceOptions,
  probe: LocalHttpProbe = probeLocalHttp,
): Promise<LocalAcceptanceReport> {
  const base = localAcceptanceUrl(options.baseUrl);
  const source = cliSource(options.cwd ?? process.cwd());
  const output = prepareOutput(options);
  const report: LocalAcceptanceReport = {
    reportVersion: 1,
    capturedAt: new Date().toISOString(),
    scope: "LOCAL_READ_ONLY_SOURCE_AND_NEW_RESTORE_COPY",
    releaseStatus: "NOT_ACCEPTED",
    environment: {
      platform: platform(),
      architecture: arch(),
      osRelease: release(),
      nodeVersion: process.versions.node,
    },
    source,
    database: null,
    coverage: null,
    checks: checks.map((id) => ({ id, status: "NOT_RUN" })),
    remaining: [...remaining],
  };
  let stage = "runtime_database";
  try {
    const db = readonly(options.databasePath);
    try {
      const sqliteVersion = assertSQLiteRuntime(db);
      const schemaVersion = (
        db
          .prepare("SELECT max(version) version FROM schema_migrations")
          .get() as { version: number }
      ).version;
      if (schemaVersion !== DATABASE_MIGRATIONS.length)
        throw new AcceptanceError("CURRENT_SCHEMA_REQUIRED");
      const journal = db.pragma("journal_mode", { simple: true });
      let availableBytes: number | null = null;
      try {
        const fs = statfsSync(options.databasePath, { bigint: true });
        const bytes = fs.bavail * fs.bsize;
        if (bytes >= 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER))
          availableBytes = Number(bytes);
      } catch {
        /* unknown, never an inferred disk guarantee */
      }
      report.database = {
        sqliteVersion,
        schemaVersion,
        journalMode:
          journal === "wal" || journal === "delete" ? journal : "other",
        availableBytes,
      };
      if (Number(process.versions.node.split(".")[0]) < 24)
        throw new AcceptanceError("NODE_24_REQUIRED");
    } finally {
      db.close();
    }
    record(report, stage, "PASS");
    stage = "online_backup";
    const backup = join(output, "backup.sqlite");
    await backupDatabase(options.databasePath, backup);
    record(report, stage, "PASS");
    stage = "new_file_restore";
    const restored = join(output, "restored.sqlite");
    await restoreDatabase(backup, restored);
    record(report, stage, "PASS");
    stage = "historical_rows_preserved";
    verifyRestore(report, backup, restored);
  } catch (error) {
    const code =
      error instanceof AcceptanceError
        ? error.code
        : backupErrorMessage(error).code;
    record(report, stage, "FAIL", code);
  }
  await checkHttp(report, base, probe);
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return report;
}
