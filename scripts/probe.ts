import { createRequire } from "node:module";
import { summarizeMarketProbe } from "../packages/market-data/probe-summary.js";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  runMarketProbe,
  type ProbeReport,
} from "../packages/market-data/probe.js";

const require = createRequire(import.meta.url);
let output: number | undefined;
let latest: ProbeReport | undefined;
let exitCode = 2;
let outputFailed = false;
let summary = false;
let reportSaved = false;
try {
  const { values } = parseArgs({
    options: {
      symbols: { type: "string" },
      summary: { type: "boolean", default: false },
      "observe-seconds": { type: "string", default: "0" },
      output: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  summary = values.summary!;
  // Create only, owner-readable. JSONL checkpoints preserve prior evidence if a later step fails.
  if (values.output) output = openSync(values.output, "wx", 0o600);
  const result = await runMarketProbe({
    symbols: (values.symbols ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    observeSeconds: /^(0|[1-9]\d*)$/.test(values["observe-seconds"]!)
      ? Number(values["observe-seconds"])
      : NaN,
    env: process.env,
    runtime: process.version,
    sdk: require("longbridge/package.json").version,
    platform: process.platform,
    architecture: process.arch,
    adapterFactory: async () => {
      const { LongbridgeReadOnlyAdapter } =
        await import("../packages/market-data/longbridge.js");
      return LongbridgeReadOnlyAdapter.fromEnvironment();
    },
    checkpoint: (report) => {
      latest = report;
      if (output !== undefined) {
        const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(
            output,
            bytes,
            offset,
            bytes.length - offset,
          );
          if (written === 0) throw new Error("REPORT_WRITE_FAILED");
          offset += written;
        }
        fsyncSync(output);
        reportSaved = true;
      }
    },
  });
  latest = result.report;
  exitCode = result.exitCode;
} catch {
  // Never emit native error messages, paths, credential values or provider URLs.
  exitCode = 1;
  outputFailed = true;
} finally {
  if (output !== undefined) {
    try {
      closeSync(output);
    } catch {
      exitCode = 1;
      outputFailed = true;
    }
  }
}
const payload = latest
  ? {
      ...latest,
      ...(outputFailed
        ? {
            status:
              latest.status === "BLOCKED"
                ? "BLOCKED"
                : "INCOMPLETE_CAPABILITY_UNKNOWN",
            failureCode: "PROBE_REPORT_INCOMPLETE",
          }
        : {}),
    }
  : { status: "BLOCKED", failureCode: "PROBE_ARGUMENT_OR_OUTPUT_FAILED" };
// Native SDK sockets can remain alive after a timed-out call. Flush the report, then terminate this isolated CLI.
const terminalPayload =
  summary && latest
    ? summarizeMarketProbe(
        payload as ProbeReport,
        exitCode,
        reportSaved && !outputFailed,
      )
    : payload;
process.stdout.write(`${JSON.stringify(terminalPayload, null, 2)}\n`, () =>
  process.exit(exitCode),
);
