import { runLocalAcceptance } from "../apps/server/local-acceptance.js";
const args = process.argv.slice(2);
try {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !["--database", "--output-dir", "--url"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    )
      throw new Error("INVALID_ARGUMENTS");
    values.set(key, value);
  }
  if (!values.has("--output-dir")) throw new Error("OUTPUT_DIRECTORY_REQUIRED");
  const report = await runLocalAcceptance({
    databasePath:
      values.get("--database") ??
      process.env.PULLBACK_DB ??
      "data/pullback.sqlite",
    outputDirectory: values.get("--output-dir")!,
    baseUrl: values.get("--url") ?? "http://127.0.0.1:3000",
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.checks.some(
    (check) => check.status === "FAIL" || check.status === "NOT_RUN",
  )
    ? 1
    : 0;
} catch {
  // Arbitrary filesystem/network errors can contain paths, tokens, or response bodies.
  console.error(
    "LOCAL_ACCEPTANCE_FAILED: 请检查参数、原数据库与全新输出目录；不输出原始错误。用法：npm run acceptance:local -- --output-dir NEW_DIRECTORY [--database DATABASE_PATH] [--url http://127.0.0.1:3000]",
  );
  process.exitCode = 1;
}
