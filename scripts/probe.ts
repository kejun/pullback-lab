import { createRequire } from "node:module";
import {
  HISTORY_MAX_JOURNAL_BYTES,
  HISTORY_MAX_CHECKPOINT_BYTES,
} from "../packages/market-data/history-capture.js";
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
let journalBytes = 0;
try {
  const { values } = parseArgs({
    options: {
      symbols: { type: "string" },
      "history-from": { type: "string" },
      "history-through": { type: "string" },
      "minute-sources": { type: "boolean", default: false },
      summary: { type: "boolean", default: false },
      "observe-seconds": { type: "string", default: "0" },
      output: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  const historyRequested =
    values["history-from"] !== undefined ||
    values["history-through"] !== undefined;
  // Full raw history must have a private, create-only journal. Never print it to terminal.
  summary = values.summary! || historyRequested || values["minute-sources"]!;
  if (values["minute-sources"] && (!values.output || historyRequested))
    throw new Error("MINUTE_SOURCES_PRIVATE_OUTPUT_REQUIRED");
  if (
    historyRequested &&
    (!values["history-from"] || !values["history-through"] || !values.output)
  )
    throw new Error("HISTORY_WINDOW_AND_OUTPUT_REQUIRED");
  // Create only, owner-readable. JSONL checkpoints preserve prior evidence if a later step fails.
  if (values.output) output = openSync(values.output, "wx", 0o600);
  const result = await runMarketProbe({
    ...(historyRequested
      ? {
          historyWindow: {
            from: values["history-from"]!,
            through: values["history-through"]!,
          },
        }
      : {}),
    minuteSources: values["minute-sources"],
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
        if (
          (historyRequested || values["minute-sources"]) &&
          (bytes.length > HISTORY_MAX_CHECKPOINT_BYTES ||
            journalBytes + bytes.length > HISTORY_MAX_JOURNAL_BYTES)
        )
          throw new Error("HISTORY_REPORT_SIZE_LIMIT");
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
        journalBytes += bytes.length;
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
