import Database from "better-sqlite3";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  constants,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ActionEvidenceError,
  ActionEvidenceRepository,
  parseActionManifest,
} from "../packages/market-data/action-evidence.js";
import {
  acquireServiceLock,
  assertSQLiteRuntime,
  RuntimeSafetyError,
  type ServiceLock,
} from "../apps/server/runtime-safety.js";
import { backupBeforeMigration } from "../apps/server/backup-service.js";
import { DATABASE_MIGRATIONS } from "../apps/server/migrations.js";
import { Store } from "../apps/server/store.js";

function readManifest(path: string) {
  // Bounded reads refuse directories, pipes and symlinks; errors never print contents or paths.
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!fstatSync(fd).isFile())
      throw new ActionEvidenceError("ACTION_MANIFEST_FILE_REQUIRED");
    const buffer = Buffer.alloc(4_000_001);
    let length = 0,
      read = 0;
    do {
      read = readSync(fd, buffer, length, buffer.length - length, null);
      length += read;
    } while (read > 0 && length < buffer.length);
    if (length > 4_000_000)
      throw new ActionEvidenceError("EVIDENCE_SIZE_LIMIT");
    return parseActionManifest(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, length),
        ),
      ),
      Date.now(),
    );
  } finally {
    closeSync(fd);
  }
}
let db: Database.Database | undefined;
let store: Store | undefined;
let lock: ServiceLock | undefined;
try {
  const [path, flag, ...extra] = process.argv.slice(2);
  const inspect = path === "--current";
  if (
    !path ||
    extra.length ||
    (inspect
      ? !flag || !/^[A-Za-z0-9._:-]{1,160}$/.test(flag)
      : path.startsWith("--") || (flag !== undefined && flag !== "--apply"))
  )
    throw new ActionEvidenceError("ACTION_IMPORT_USAGE");
  const manifest = inspect ? null : readManifest(path);
  const databasePath = realpathSync(
    process.env.PULLBACK_DB ?? "data/pullback.sqlite",
  );
  const databaseInfo = statSync(databasePath);
  if (!databaseInfo.isFile() || databaseInfo.nlink !== 1)
    throw new ActionEvidenceError("ACTION_DATABASE_FILE_REQUIRED");
  // Require an existing application database; preview never creates or migrates one.
  db = new Database(databasePath, { readonly: true, fileMustExist: true });
  assertSQLiteRuntime(db);
  db.pragma("query_only = ON");
  if (inspect || flag !== "--apply") {
    const version = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    if (version.version !== DATABASE_MIGRATIONS.length)
      throw new ActionEvidenceError("ACTION_SCHEMA_UPGRADE_REQUIRED");
    const repo = new ActionEvidenceRepository(db);
    const current = inspect ? repo.latest(flag!) : null;
    console.log(
      JSON.stringify(
        inspect
          ? {
              status: "CURRENT",
              version: current?.version ?? null,
              recordedAt: current?.recordedAt ?? null,
              coverageStatus: current?.manifest.coverage.status ?? "UNKNOWN",
              actionCount: current?.manifest.actions.length ?? 0,
              liveEligible: false,
            }
          : repo.import(manifest, Date.now(), { dryRun: true }),
      ),
    );
  } else {
    db.close();
    db = undefined;
    lock = acquireServiceLock(databasePath);
    await backupBeforeMigration(
      lock.databasePath,
      process.env.PULLBACK_BACKUP_DIR ??
        join(dirname(lock.databasePath), "backups"),
    );
    store = new Store(lock.databasePath);
    console.log(
      JSON.stringify(store.importActionEvidence(manifest, Date.now())),
    );
  }
} catch (error) {
  const code =
    error instanceof ActionEvidenceError || error instanceof RuntimeSafetyError
      ? error.code
      : "ACTION_IMPORT_FAILED";
  console.error(JSON.stringify({ code, liveEligible: false }));
  process.exitCode = 1;
} finally {
  store?.close();
  db?.close();
  lock?.release();
}
