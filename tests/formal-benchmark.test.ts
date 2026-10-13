import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  runFormalBenchmark,
  summarizeSamples,
  targetPassed,
} from "../scripts/formal-benchmark.js";

describe("formal runtime benchmark evidence", () => {
  it("measures ten formal committed entries and authenticated cache pages against 100 histories", async () => {
    const report = await runFormalBenchmark({ rounds: 1 });
    expect(report.failures).toEqual([]);
    expect(report.status).toBe("PASS");
    expect(report.exitCode).toBe(0);
    expect(report.syntheticOnly).toBe(true);
    expect(report.dataset).toMatchObject({
      instruments: 100,
      simultaneousFormalMonitors: 10,
      sampleRounds: 1,
      completedRounds: 1,
    });
    expect(report.candidates.warm).toMatchObject({
      planned: 1,
      attempted: 1,
      successful: 1,
      failed: 0,
      notAttempted: 0,
    });
    expect(report.formalRuntime.qualifiedInputToCommit).toMatchObject({
      planned: 10,
      attempted: 10,
      successful: 10,
      failed: 0,
      notAttempted: 0,
    });
    expect(report.formalRuntime.auditsMatched).toBe(10);
    expect(report.environment.database).toMatchObject({
      journalMode: "wal",
      synchronous: "FULL",
      independentReadOnlyConnection: true,
      removedAfterRun: true,
    });
    expect(report.upstream).toEqual({
      measured: false,
      latencyMs: null,
      timeoutCount: null,
      failureCount: null,
    });
  });

  it("retains failed commit samples and fails the report instead of hiding failures in a percentile", async () => {
    const report = await runFormalBenchmark({
      rounds: 1,
      beforeQualifiedInput(app, _round, index) {
        if (index === 0)
          app.store.db.exec(
            "CREATE TEMP TRIGGER benchmark_reject_commit BEFORE INSERT ON closed_receipt_results BEGIN SELECT RAISE(ABORT,'INJECTED_COMMIT_FAILURE'); END;",
          );
        if (index === 1)
          app.store.db.exec("DROP TRIGGER benchmark_reject_commit");
      },
    });
    expect(report.status).toBe("FAIL");
    expect(report.exitCode).toBe(1);
    expect(report.formalRuntime.qualifiedInputToCommit).toMatchObject({
      attempted: 10,
      failed: 1,
      successful: 9,
      notAttempted: 0,
    });
    expect(
      report.formalRuntime.qualifiedInputToCommit.samples[0],
    ).toMatchObject({ success: false, failureCode: "INJECTED_COMMIT_FAILURE" });
    expect(report.formalRuntime.tenPlanBurst.failed).toBe(1);
    expect(report.targets.qualifiedInputToCommitP95AtMost5000ms).toBe(false);
    expect(report.environment.database.removedAfterRun).toBe(true);
  });

  it("does not pass incomplete or zero-success series and uses nearest rank", () => {
    const success = (elapsedMs: number) => ({
      round: 1,
      success: true,
      elapsedMs,
    });
    const sample = summarizeSamples(
      Array.from({ length: 20 }, (_, index) => success(index + 1)),
      20,
    );
    expect(sample.successfulOnly?.p95Ms).toBe(19);
    expect(targetPassed(sample, 19)).toBe(true);
    expect(targetPassed(sample, 18)).toBe(false);
    expect(targetPassed(summarizeSamples([success(1)], 2), 2000)).toBe(false);
    expect(targetPassed(summarizeSamples([], 1), 2000)).toBe(false);
    expect(
      targetPassed(
        summarizeSamples([{ round: 1, success: false, elapsedMs: 3000 }], 1),
        5000,
      ),
    ).toBe(false);
  });

  it("prints a safe parseable failure and exits nonzero for invalid CLI options", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/benchmark-formal.ts",
        "--private-value=not-for-output",
      ],
      { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("not-for-output");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "FAIL",
      exitCode: 1,
      failureCode: "BENCHMARK_ARGUMENT_OR_SETUP_FAILED",
    });
  });
});
