import Database from "better-sqlite3";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const source = resolve(process.env.PULLBACK_DB ?? "data/pullback.sqlite");
const target = process.argv[2];
if (
  !target ||
  !existsSync(source) ||
  resolve(target) === source ||
  existsSync(resolve(target))
) {
  console.error(
    "Usage: PULLBACK_DB=existing.sqlite npx tsx scripts/backup.ts NEW_BACKUP_PATH",
  );
  process.exit(1);
}
mkdirSync(dirname(resolve(target)), { recursive: true });
const db = new Database(source, { readonly: true });
try {
  await db.backup(resolve(target));
  const check = new Database(resolve(target), { readonly: true });
  const result = check.pragma("integrity_check", { simple: true });
  check.close();
  if (result !== "ok") throw new Error("Backup integrity check failed");
  console.log(
    "Consistent backup created. Restore only while the service is stopped.",
  );
} finally {
  db.close();
}
