import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const cwd = new URL("../", import.meta.url);
function probe(args: string[]) {
  const env = { ...process.env };
  for (const name of [
    "LONGBRIDGE_APP_KEY",
    "LONGBRIDGE_APP_SECRET",
    "LONGBRIDGE_ACCESS_TOKEN",
  ])
    delete env[name];
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/probe.ts", ...args],
    {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    },
  );
}
describe("isolated probe CLI", () => {
  it("flushes a parseable UNKNOWN report and owner-only checkpoint without credentials or native network calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "pullback-probe-"));
    try {
      const path = join(dir, "report.jsonl");
      const result = probe(["--symbols", "AAPL.US", "--output", path]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout);
      expect(report.status).toBe("BLOCKED");
      expect(report.schema).toBe("pullback-lab-market-probe-v2");
      expect(
        report.capabilities.every(
          (x: { level: string }) => x.level === "UNKNOWN",
        ),
      ).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report);
      if (process.platform !== "win32")
        expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("refuses to overwrite existing evidence and does not leak the private path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pullback-probe-"));
    try {
      const path = join(dir, "private-report.jsonl");
      writeFileSync(path, "original evidence");
      const result = probe(["--output", path]);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain(path);
      expect(readFileSync(path, "utf8")).toBe("original evidence");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects unknown command arguments without echoing their values", () => {
    const result = probe(["--secret-token", "do-not-leak"]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("do-not-leak");
    expect(JSON.parse(result.stdout).failureCode).toBe(
      "PROBE_ARGUMENT_OR_OUTPUT_FAILED",
    );
  });
});

it("requires a private create-only journal for minute-source mode and forces a safe summary", () => {
  const missingOutput = probe([
    "--symbols",
    "688008.SH",
    "--minute-sources",
    "--observe-seconds",
    "1",
  ]);
  expect(missingOutput.status).toBe(1);
  const dir = mkdtempSync(join(tmpdir(), "pullback-minute-source-"));
  try {
    const file = join(dir, "private.jsonl");
    const result = probe([
      "--symbols",
      "688008.SH",
      "--minute-sources",
      "--observe-seconds",
      "1",
      "--output",
      file,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary.schema).toBe("pullback-lab-market-probe-summary-v1");
    expect(summary.liveEligible).toBe(false);
    expect(summary.status).toBe("BLOCKED");
    expect(result.stdout).not.toContain("tradePackets");
    expect(result.stdout).not.toContain(file);
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
    const original = readFileSync(file, "utf8");
    expect(
      probe([
        "--symbols",
        "688008.SH",
        "--minute-sources",
        "--observe-seconds",
        "1",
        "--output",
        file,
      ]).status,
    ).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
