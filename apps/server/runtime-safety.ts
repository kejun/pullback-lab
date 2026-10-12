import Database from "better-sqlite3";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

export class RuntimeSafetyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeSafetyError";
  }
}

/**
 * SQLite's WAL-reset fix: https://sqlite.org/wal.html#walresetbug
 * Stable fix: 3.51.3; official backports: exactly 3.44.6 and 3.50.7.
 * The 3.52 release line was withdrawn: https://sqlite.org/changes.html
 * Keep older backports explicit instead of admitting unverified patch ranges.
 */
export function isSupportedSQLiteVersion(version: string): boolean {
  if (version === "3.44.6" || version === "3.50.7") return true;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major === 3 && ((minor === 51 && patch >= 3) || minor >= 53);
}

/** Query the loaded engine, never infer it from the npm package version. */
export function assertSQLiteRuntime(db: Database.Database): string {
  const { version } = db
    .prepare("SELECT sqlite_version() AS version")
    .get() as {
    version: string;
  };
  if (!isSupportedSQLiteVersion(version)) {
    throw new RuntimeSafetyError(
      "UNSAFE_SQLITE_VERSION",
      `SQLite ${version} 不在本应用允许的 WAL 修复版本范围内；请使用 3.51.3 或 3.53.0 及以上稳定版本（另允许官方修复版本 3.44.6、3.50.7；3.52 已撤回）`,
    );
  }
  return version;
}

export interface ServiceLock {
  readonly databasePath: string;
  readonly lockPath: string;
  release(): void;
}

/**
 * One server per canonical database path, without locking the application DB.
 * A separate rollback-journal database holds BEGIN IMMEDIATE for the lifetime of
 * main. SQLite's OS file lock is released on normal close and process death.
 * Its file may remain after a crash: presence is not ownership, and must never
 * be used as a reason to unlink it (which could split live lock ownership).
 * Use only local filesystems, as required by the application's WAL database.
 */
export function acquireServiceLock(databasePath: string): ServiceLock {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) {
    throw new RuntimeSafetyError(
      "PERSISTENT_DATABASE_REQUIRED",
      "服务进程需要本地数据库文件路径；内存库仅用于独立 Store 测试",
    );
  }
  const requested = resolve(databasePath);
  mkdirSync(dirname(requested), { recursive: true });
  if (
    lstatSync(requested, { throwIfNoEntry: false })?.isSymbolicLink() &&
    !existsSync(requested)
  ) {
    throw new RuntimeSafetyError(
      "UNSAFE_DATABASE_PATH",
      "数据库符号链接的目标必须已经存在；请先使用真实文件路径初始化数据库",
    );
  }
  const canonical = existsSync(requested)
    ? realpathSync(requested)
    : resolve(realpathSync(dirname(requested)), basename(requested));
  if (existsSync(canonical)) {
    const info = statSync(canonical);
    if (!info.isFile() || info.nlink !== 1) {
      throw new RuntimeSafetyError(
        "UNSAFE_DATABASE_PATH",
        "数据库必须是单一硬链接的普通本地文件；不要通过硬链接共享数据库",
      );
    }
  }
  const lockPath = `${canonical}.service-lock.sqlite`;
  const db = new Database(lockPath, { timeout: 0 });
  try {
    assertSQLiteRuntime(db);
    db.pragma("busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
    ) {
      throw new RuntimeSafetyError(
        "SERVICE_ALREADY_RUNNING",
        `已有服务进程占用数据库 ${canonical}；本进程尚未打开业务数据库或执行恢复`,
      );
    }
    throw error;
  }
  let released = false;
  return {
    databasePath: canonical,
    lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    },
  };
}
