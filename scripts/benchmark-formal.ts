import { runFormalBenchmark } from "./formal-benchmark.js";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => !/^--rounds=\d+$/.test(arg)))
    throw new Error("INVALID_ARGUMENTS");
  const rounds = args.length ? Number(args[0].split("=")[1]) : 30;
  const report = await runFormalBenchmark({ rounds });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
} catch {
  console.log(
    JSON.stringify({
      schema: "pullback-formal-runtime-benchmark-v1",
      status: "FAIL",
      exitCode: 1,
      failureCode: "BENCHMARK_ARGUMENT_OR_SETUP_FAILED",
    }),
  );
  process.exitCode = 1;
}
