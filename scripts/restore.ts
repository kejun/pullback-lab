import {
  backupErrorMessage,
  restoreDatabase,
} from "../apps/server/backup-service.js";
const [source, target] = process.argv.slice(2);
if (!source || !target || process.argv.length !== 4) {
  console.error(
    "RESTORE_USAGE: npm run restore -- BACKUP_PATH NEW_DATABASE_PATH",
  );
  process.exitCode = 1;
} else {
  try {
    const result = await restoreDatabase(source, target);
    console.log(
      `RESTORE_COMPLETE: 已恢复至新数据库，schema ${result.schemaVersion}；请确认资金后重新激活计划`,
    );
  } catch (error) {
    const safe = backupErrorMessage(error);
    console.error(`${safe.code}: ${safe.message}`);
    process.exitCode = 1;
  }
}
