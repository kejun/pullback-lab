import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMarketProbe, type ProbeReport } from "./probe.js";
import { summarizeMarketProbe } from "./probe-summary.js";
async function report() {
  return (
    await runMarketProbe({
      symbols: ["NVDA.US", "688008.SH"],
      observeSeconds: 0,
      env: {},
      runtime: "v24.19.0",
      sdk: "5.2.0",
      platform: "linux",
      architecture: "x64",
      adapterFactory: () => {
        throw new Error("must not open provider");
      },
    })
  ).report;
}
describe("shareable probe summary", () => {
  it("allows only named fields and enum values, excluding arbitrary evidence and private content", async () => {
    const r = await report(),
      secret = "private-token-value";
    r.blockedBy.push(secret);
    r.checks.cost = secret;
    r.missingEnvironmentNames.push(secret);
    r.sdk = secret;
    r.runtime = secret;
    r.deploymentRegion.declared = secret;
    r.steps = [
      {
        id: "quote-packages",
        status: "SAMPLED",
        startedAt: 0,
        completedAt: 1,
        elapsedMs: 1,
        evidence: [{ key: secret, url: secret, name: secret }],
      },
      {
        id: "bars:NVDA.US:1D",
        status: "SAMPLED",
        startedAt: 0,
        completedAt: 1,
        elapsedMs: 1,
        evidence: {
          count: 300,
          samples: [{ token: secret }],
          countExtra: secret,
        },
      },
      {
        id: "quote:NVDA.US",
        status: "FAILED",
        reason: secret,
        startedAt: 0,
        completedAt: 1,
        elapsedMs: 1,
        evidence: { price: secret },
      },
      {
        id: secret,
        status: secret as never,
        startedAt: 0,
        completedAt: 1,
        elapsedMs: NaN,
      },
    ];
    const s = summarizeMarketProbe(r, 1, true),
      serialized = JSON.stringify(s);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("samples");
    expect(serialized).not.toContain('"price"');
    expect(s.steps[1]).toMatchObject({ id: "bars:NVDA.US:1D", count: 300 });
    expect(s.checks.cost).toBe("UNKNOWN");
    expect(s.liveEligible).toBe(false);
  });
  it("preserves empty/failed/skipped distinction without interpreting closed-market silence as an entitlement failure", async () => {
    const r = await report();
    r.steps = [
      {
        id: "confirmed-observation",
        status: "EMPTY",
        reason: "NO_EVIDENCE_RETURNED",
        startedAt: 0,
        completedAt: 1,
        elapsedMs: 1,
        evidence: { events: 0, confirmedCount: 0, observedDelayMs: null },
      },
      {
        id: "calendar:CN",
        status: "FAILED",
        reason: "QUOTE_PROBE_STEP_FAILED",
        startedAt: 0,
        completedAt: 1,
        elapsedMs: 1,
      },
      {
        id: "bars:NVDA.US:5m",
        status: "SKIPPED",
        reason: "PREVIOUS_REQUEST_UNSETTLED",
        startedAt: 0,
        completedAt: 1,
        elapsedMs: 1,
      },
    ];
    const s = summarizeMarketProbe(r, 2, false);
    expect(s.steps.map((x) => x.status)).toEqual([
      "EMPTY",
      "FAILED",
      "SKIPPED",
    ]);
    expect(s.blockedBy).toContain("PRIVATE_REPORT_NOT_SAVED");
    expect(s.interpretation).toContain("DOES_NOT_PROVE_ENTITLEMENT_FAILURE");
  });
  it("allows finite integer observed delays but never promotes timestamp/clock validation", async () => {
    const r = await report();
    r.steps = [
      {
        id: "confirmed-observation",
        status: "SAMPLED",
        startedAt: 0,
        completedAt: 1,
        elapsedMs: 1,
        evidence: {
          events: 2,
          confirmedCount: 2,
          observedDelayMs: { min: -1, p50: 0, p95: 500, max: 600 },
          clockVerified: true,
          timestampSemanticsVerified: true,
        },
      },
    ];
    expect(summarizeMarketProbe(r, 2, true).steps[0]).toMatchObject({
      events: 2,
      confirmedCount: 2,
      clockVerified: false,
      timestampSemanticsVerified: false,
      observedDelayMs: { min: -1, max: 600 },
    });
    (r.steps[0].evidence as { observedDelayMs: unknown }).observedDelayMs = {
      min: NaN,
      p50: 0,
      p95: 1,
      max: Infinity,
    };
    expect(summarizeMarketProbe(r, 2, true).steps[0]).not.toHaveProperty(
      "observedDelayMs",
    );
  });
  it("CLI summary leaves the existing private JSONL format/default output intact and never contacts a provider when credentials are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-summary-"));
    try {
      for (const summary of [false, true]) {
        const output = join(dir, summary ? "summary.jsonl" : "default.jsonl");
        const r = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/probe.ts",
            "--symbols",
            "NVDA.US,688008.SH",
            "--output",
            output,
            ...(summary ? ["--summary"] : []),
          ],
          {
            env: {
              ...process.env,
              LONGBRIDGE_APP_KEY: "",
              LONGBRIDGE_APP_SECRET: "",
              LONGBRIDGE_ACCESS_TOKEN: "",
              PULLBACK_DEPLOYMENT_REGION: "CN_MAINLAND",
            },
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 100000,
          },
        );
        expect(r.status).toBe(2);
        const terminal = JSON.parse(r.stdout);
        const saved = JSON.parse(
          readFileSync(output, "utf8").trim().split("\n").at(-1)!,
        );
        expect(terminal.schema).toBe(
          summary
            ? "pullback-lab-market-probe-summary-v1"
            : "pullback-lab-market-probe-v2",
        );
        expect(saved.schema).toBe("pullback-lab-market-probe-v2");
        expect(statSync(output).mode & 0o777).toBe(0o600);
        expect(saved.steps).toEqual([]);
        if (summary)
          expect(terminal).toMatchObject({
            reportSaved: true,
            liveEligible: false,
            deploymentRegion: { declared: "CN_MAINLAND", verified: false },
          });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("date-window CLI requires a private journal and forces sanitized terminal output", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-window-"));
    const output = join(dir, "history.jsonl");
    const env = {
      ...process.env,
      LONGBRIDGE_APP_KEY: "",
      LONGBRIDGE_APP_SECRET: "",
      LONGBRIDGE_ACCESS_TOKEN: "",
    };
    const invoke = (args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/probe.ts",
          "--symbols",
          "NVDA.US",
          ...args,
        ],
        { env, encoding: "utf8", timeout: 10000, maxBuffer: 100000 },
      );
    try {
      const missing = invoke([
        "--history-from",
        "2025-10-01",
        "--history-through",
        "2026-10-12",
      ]);
      expect(missing.status).toBe(1);
      expect(JSON.parse(missing.stdout)).toEqual({
        status: "BLOCKED",
        failureCode: "PROBE_ARGUMENT_OR_OUTPUT_FAILED",
      });
      const result = invoke([
        "--history-from",
        "2025-10-01",
        "--history-through",
        "2026-10-12",
        "--output",
        output,
      ]);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: "pullback-lab-market-probe-summary-v1",
        liveEligible: false,
        reportSaved: true,
      });
      expect(result.stdout).not.toContain("historyCaptures");
      expect(statSync(output).mode & 0o777).toBe(0o600);
      const saved = readFileSync(output, "utf8");
      expect(JSON.parse(saved.trim()).schema).toBe(
        "pullback-lab-market-probe-v2",
      );
      expect(
        invoke([
          "--history-from",
          "2025-10-01",
          "--history-through",
          "2026-10-12",
          "--output",
          output,
        ]).status,
      ).toBe(1);
      expect(readFileSync(output, "utf8")).toBe(saved);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
