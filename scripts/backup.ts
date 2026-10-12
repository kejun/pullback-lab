import {
  backupDatabase,
  backupErrorMessage,
} from "../apps/server/backup-service.js";
const target = process.argv[2];
if (!target || process.argv.length !== 3) {
  console.error(
    "BACKUP_USAGE: npm run backup -- NEW_BACKUP_PATH；源文件由 PULLBACK_DB 指定",
  );
  process.exitCode = 1;
} else {
  try {
    const result = await backupDatabase(
      process.env.PULLBACK_DB ?? "data/pullback.sqlite",
      target,
    );
    console.log(
      `BACKUP_COMPLETE: 已创建完整备份，schema ${result.schemaVersion}`,
    );
  } catch (error) {
    const safe = backupErrorMessage(error);
    console.error(`${safe.code}: ${safe.message}`);
    process.exitCode = 1;
  }
}
