import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DATABASE_MIGRATIONS, runMigrations } from "./migrations.js";
import {
  acquireServiceLock,
  assertSQLiteRuntime,
  RuntimeSafetyError,
  type ServiceLock,
} from "./runtime-safety.js";
import { Store } from "./store.js";

const messages = {
  INVALID_BACKUP_PATH: "请使用本地普通数据库文件和新的目标文件",
  SOURCE_NOT_FOUND: "源数据库不存在或不是普通文件",
  SOURCE_TARGET_SAME: "源数据库与目标不能相同",
  BACKUP_TARGET_EXISTS: "目标数据库或其日志文件已存在，未执行覆盖",
  INVALID_BACKUP_DATABASE: "源文件不是完整有效的应用数据库",
  NEWER_DATABASE_SCHEMA: "数据库由更新版本创建，请先升级应用",
  SERVICE_ALREADY_RUNNING: "目标数据库已有服务或恢复任务运行",
  BACKUP_TIMEOUT: "备份未在限定时间完成，请稍后重试",
  BACKUP_FAILED: "备份或恢复未完成，未发布目标数据库",
} as const;
type BackupCode = keyof typeof messages;
export class BackupError extends RuntimeSafetyError {
  constructor(code: BackupCode) {
    super(code, messages[code]);
    this.name = "BackupError";
  }
}
/** Never expose SQLite errors, file names, or persisted data in command output. */
export function backupErrorMessage(error: unknown): {
  code: string;
  message: string;
} {
  const code =
    error instanceof RuntimeSafetyError && error.code in messages
      ? (error.code as BackupCode)
      : "BACKUP_FAILED";
  return { code, message: messages[code] };
}
function safeError(error: unknown): BackupError {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "SQLITE_NOTADB" ||
      (typeof error.code === "string" &&
        error.code.startsWith("SQLITE_CORRUPT")))
  )
    return new BackupError("INVALID_BACKUP_DATABASE");
  return new BackupError(backupErrorMessage(error).code as BackupCode);
}
function localPath(path: string): string {
  if (
    !path ||
    path.trim() !== path ||
    path === ":memory:" ||
    path.startsWith("file:")
  )
    throw new BackupError("INVALID_BACKUP_PATH");
  return resolve(path);
}
function sourcePath(path: string): string {
  const requested = localPath(path);
  try {
    const source = realpathSync(requested);
    const info = lstatSync(source);
    if (!info.isFile()) throw new BackupError("SOURCE_NOT_FOUND");
    // A hard-link alias has a different WAL/SHM name and can omit live commits.
    if (info.nlink !== 1) throw new BackupError("INVALID_BACKUP_PATH");
    return source;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("SOURCE_NOT_FOUND");
  }
}
function targetPath(path: string): string {
  const requested = localPath(path);
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  return resolve(realpathSync(dirname(requested)), basename(requested));
}
function assertNewTarget(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (lstatSync(path + suffix, { throwIfNoEntry: false }))
      throw new BackupError("BACKUP_TARGET_EXISTS");
}

function sqlitePathFamily(path: string): Set<string> {
  return new Set(
    [path, `${path}.service-lock.sqlite`].flatMap((base) =>
      ["", "-wal", "-shm", "-journal"].map((suffix) => base + suffix),
    ),
  );
}

function assertSeparatePaths(source: string, target: string): void {
  if (source === target) throw new BackupError("SOURCE_TARGET_SAME");
  const sourceFamily = sqlitePathFamily(source);
  if ([...sqlitePathFamily(target)].some((path) => sourceFamily.has(path)))
    throw new BackupError("INVALID_BACKUP_PATH");
}
function readonlyDatabase(path: string): Database.Database {
  const db = new Database(path, {
    readonly: true,
    fileMustExist: true,
    timeout: 1000,
  });
  try {
    assertSQLiteRuntime(db);
    db.pragma("query_only = ON");
    db.exec("BEGIN");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
const schemaSignatures = new Map<number, Map<string, string>>();
type SchemaRow = { type: string; name: string; sql: string };
const normalizedSql = (sql: string) =>
  sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, "")
    .replace(/;$/, "");
function schemaRows(db: Database.Database): SchemaRow[] {
  return db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all() as SchemaRow[];
}
function expectedSchema(version: number): Map<string, string> {
  const cached = schemaSignatures.get(version);
  if (cached) return cached;
  const db = new Database(":memory:");
  try {
    runMigrations(db, DATABASE_MIGRATIONS.slice(0, version));
    const result = new Map(
      schemaRows(db).map((row) => [
        `${row.type}:${row.name}`,
        normalizedSql(row.sql),
      ]),
    );
    schemaSignatures.set(version, result);
    return result;
  } finally {
    db.close();
  }
}
/** Recognize a released application schema without running migrations on it. */
function validateDatabase(db: Database.Database): number {
  try {
    if (
      db.pragma("integrity_check", { simple: true }) !== "ok" ||
      (db.pragma("foreign_key_check") as unknown[]).length
    )
      throw new BackupError("INVALID_BACKUP_DATABASE");
    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    if (
      !versions.length ||
      versions.some((row, index) => row.version !== index + 1)
    )
      throw new BackupError("INVALID_BACKUP_DATABASE");
    if (versions.length > DATABASE_MIGRATIONS.length)
      throw new BackupError("NEWER_DATABASE_SCHEMA");
    const expected = expectedSchema(versions.length);
    const actual = new Map(
      schemaRows(db).map((row) => [
        `${row.type}:${row.name}`,
        normalizedSql(row.sql),
      ]),
    );
    // No missing or changed application objects. Additional indexes are harmless;
    // unexpected triggers could mutate facts while restoring and are rejected.
    if (
      [...expected].some(([name, sql]) => actual.get(name) !== sql) ||
      [...actual.keys()].some(
        (name) => name.startsWith("trigger:") && !expected.has(name),
      )
    )
      throw new BackupError("INVALID_BACKUP_DATABASE");
    return versions.length;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("INVALID_BACKUP_DATABASE");
  }
}
function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function removeStaging(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      unlinkSync(path + suffix);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
}
/** Close all writers and publish one self-contained DB inode, never its WAL. */
function checkStaging(path: string): number {
  const db = new Database(path, { fileMustExist: true });
  try {
    const version = validateDatabase(db);
    if (db.pragma("journal_mode = DELETE", { simple: true }) !== "delete")
      throw new BackupError("BACKUP_FAILED");
    db.pragma("synchronous = FULL");
    return version;
  } finally {
    db.close();
  }
}
async function copyToNewTarget(
  source: string,
  target: string,
  restore: boolean,
): Promise<{ schemaVersion: number }> {
  let sourceDb: Database.Database | undefined;
  let lock: ServiceLock | undefined;
  let staging: string | undefined;
  let published = false;
  let publishedIdentity: { dev: number; ino: number } | undefined;
  try {
    const canonicalSource = sourcePath(source);
    target = targetPath(target);
    assertSeparatePaths(canonicalSource, target);
    assertNewTarget(target);
    if (restore) {
      lock = acquireServiceLock(target);
      assertNewTarget(target);
    }
    sourceDb = readonlyDatabase(canonicalSource);
    validateDatabase(sourceDb);
    staging = resolve(
      dirname(target),
      `.${basename(target)}.${randomUUID()}.partial`,
    );
    closeSync(openSync(staging, "wx", 0o600));
    const deadline = Date.now() + 30_000;
    await sourceDb.backup(staging, {
      progress() {
        if (Date.now() > deadline) throw new BackupError("BACKUP_TIMEOUT");
        return 100;
      },
    });
    sourceDb.close();
    sourceDb = undefined;
    checkStaging(staging);
    if (restore) {
      const store = new Store(staging);
      try {
        store.transaction(() => {
          store.markRestored(Date.now());
          store.db.prepare("DELETE FROM command_results").run();
          store.setSetting("event_feed_epoch", randomUUID());
        });
      } finally {
        store.close();
      }
    }
    const schemaVersion = checkStaging(staging);
    fsyncFile(staging);
    assertNewTarget(target);
    // link is an atomic no-replace publication; rename would overwrite a racer.
    publishedIdentity = lstatSync(staging);
    linkSync(staging, target);
    published = true;
    fsyncFile(dirname(target));
    removeStaging(staging);
    staging = undefined;
    fsyncFile(dirname(target));
    return { schemaVersion };
  } catch (error) {
    if (published) {
      try {
        const current = lstatSync(target, { throwIfNoEntry: false });
        if (
          current?.dev === publishedIdentity?.dev &&
          current?.ino === publishedIdentity?.ino
        ) {
          unlinkSync(target);
          fsyncFile(dirname(target));
        }
      } catch {
        /* report failure */
      }
    }
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new BackupError("BACKUP_TARGET_EXISTS");
    throw safeError(error);
  } finally {
    sourceDb?.close();
    try {
      if (staging) removeStaging(staging);
    } finally {
      lock?.release();
    }
  }
}
/** Online SQLite backup includes committed WAL frames and never migrates source. */
export async function backupDatabase(
  source: string,
  target: string,
): Promise<{ schemaVersion: number }> {
  return copyToNewTarget(source, target, false);
}
/** Restore only into a fresh path, with sessions and replayable commands expired. */
export async function restoreDatabase(
  source: string,
  target: string,
): Promise<{ schemaVersion: number }> {
  return copyToNewTarget(source, target, true);
}
/** Called with the source service lock held, before opening Store for migration. */
export async function backupBeforeMigration(
  source: string,
  backupDirectory: string,
): Promise<{ path: string; schemaVersion: number } | null> {
  let db: Database.Database | undefined;
  try {
    const requested = localPath(source);
    if (!lstatSync(requested, { throwIfNoEntry: false })) {
      assertNewTarget(requested);
      return null;
    }
    db = readonlyDatabase(sourcePath(requested));
    const schemaVersion = validateDatabase(db);
    db.close();
    db = undefined;
    if (schemaVersion === DATABASE_MIGRATIONS.length) return null;
    const path = resolve(
      localPath(backupDirectory),
      `pullback-schema-${schemaVersion}-${Date.now()}-${randomUUID()}.sqlite`,
    );
    const result = await backupDatabase(source, path);
    return { path, ...result };
  } catch (error) {
    throw safeError(error);
  } finally {
    db?.close();
  }
}
