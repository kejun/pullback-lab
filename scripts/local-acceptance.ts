import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// Keep a parent outside synchronous SQLite work so a damaged/large database cannot hang indefinitely.
const args = process.argv.slice(2);
const summary = args.includes("--summary");
const workerArgs = args.filter((arg) => arg !== "--summary");
if (args.filter((arg) => arg === "--summary").length > 1)
  workerArgs.push("--invalid");
const env = { ...process.env };
for (const key of Object.keys(env))
  if (key === "PULLBACK_PASSWORD" || key.startsWith("LONGBRIDGE_"))
    delete env[key];
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    fileURLToPath(new URL("./local-acceptance-worker.ts", import.meta.url)),
    ...workerArgs,
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
let stopped = false;
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, 120_000);
child.stdout.on("data", (chunk: Buffer) => {
  if (Buffer.byteLength(output) + chunk.length > 64 * 1024) {
    stopped = true;
    child.kill("SIGKILL");
    return;
  }
  output += chunk.toString("utf8");
});
// Worker errors may originate in a module loader. Do not forward raw stacks or filesystem paths.
child.stderr.resume();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopped = true;
    child.kill("SIGKILL");
  });
child.on("error", () => {
  stopped = true;
});
child.on("close", (code) => {
  clearTimeout(timeout);
  if (!timedOut && !stopped) {
    try {
      const report = JSON.parse(output);
      if (
        report.reportVersion !== 1 ||
        report.scope !== "LOCAL_READ_ONLY_SOURCE_AND_NEW_RESTORE_COPY"
      )
        throw new Error();
      const failed = report.checks.filter(
        (check: { status: string }) =>
          check.status === "FAIL" || check.status === "NOT_RUN",
      );
      console.log(
        JSON.stringify(
          summary
            ? {
                reportVersion: 1,
                summary: true,
                releaseStatus: report.releaseStatus,
                cliCommit: report.source.cliCommit,
                cliWorktreeClean: report.source.cliWorktreeClean,
                environment: report.environment,
                sqliteVersion: report.database?.sqliteVersion ?? null,
                checks: Object.fromEntries(
                  ["PASS", "FAIL", "NOT_RUN", "NOT_APPLICABLE"].map(
                    (status) => [
                      status,
                      report.checks.filter(
                        (check: { status: string }) => check.status === status,
                      ).length,
                    ],
                  ),
                ),
                failures: failed,
                coverage: report.coverage,
                unverifiedRequirements: report.remaining.length,
                fullReport: "report.json",
              }
            : report,
          null,
          2,
        ),
      );
      process.exitCode = code === 0 ? 0 : 1;
      return;
    } catch {
      /* Only a complete, structured result is publishable. */
    }
  }
  console.error(
    timedOut
      ? "LOCAL_ACCEPTANCE_TIMEOUT: 检查超过120秒已停止；原数据库未执行写操作，新目录可能保留未完成的私有副本。"
      : "LOCAL_ACCEPTANCE_FAILED: 请检查原数据库、全新输出目录及参数。用法：npm run acceptance:local -- --output-dir NEW_DIRECTORY [--database DATABASE_PATH] [--url http://127.0.0.1:3000]",
  );
  process.exitCode = 1;
});
