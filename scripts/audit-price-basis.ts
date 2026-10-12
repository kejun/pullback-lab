import Database from "better-sqlite3";
import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { readPriceBasisAudit } from "../apps/server/price-basis-audit.js";
import { PriceBasisAuditError } from "../packages/market-data/price-basis-audit.js";
import { assertSQLiteRuntime } from "../apps/server/runtime-safety.js";
import { DATABASE_MIGRATIONS } from "../apps/server/migrations.js";

let db: Database.Database | undefined;
try {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || path.startsWith("--") || extra.length)
    throw new PriceBasisAuditError("AUDIT_USAGE");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let input: unknown;
  try {
    if (!fstatSync(fd).isFile())
      throw new PriceBasisAuditError("AUDIT_FILE_REQUIRED");
    const bytes = Buffer.alloc(2_000_001);
    let size = 0,
      read = 0;
    do {
      read = readSync(fd, bytes, size, bytes.length - size, null);
      size += read;
    } while (read > 0 && size < bytes.length);
    if (size > 2_000_000) throw new PriceBasisAuditError("AUDIT_INPUT_LIMIT");
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
  } finally {
    closeSync(fd);
  }
  db = new Database(process.env.PULLBACK_DB ?? "data/pullback.sqlite", {
    readonly: true,
    fileMustExist: true,
  });
  assertSQLiteRuntime(db);
  db.pragma("query_only = ON");
  const schema = db
    .prepare("SELECT MAX(version) version FROM schema_migrations")
    .get() as { version: number };
  if (schema.version !== DATABASE_MIGRATIONS.length)
    throw new PriceBasisAuditError("AUDIT_SCHEMA_UPGRADE_REQUIRED");
  const report = readPriceBasisAudit(db, input);
  process.stdout.write(JSON.stringify(report) + "\n");
  if (report.status !== "CONSISTENT") process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      code: error instanceof PriceBasisAuditError ? error.code : "AUDIT_FAILED",
      liveEligible: false,
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
