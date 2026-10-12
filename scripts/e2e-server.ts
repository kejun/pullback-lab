import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the production service lock and file-backed database with isolated data.
const directory = mkdtempSync(join(tmpdir(), "pullback-e2e-"));
process.env.PULLBACK_DB = join(directory, "research.sqlite");
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
if (
  process.env.NODE_ENV === "test" &&
  process.env.ACTION_EVIDENCE_E2E === "1"
) {
  const { seedActionEvidence } = await import("./e2e-action-evidence.js");
  seedActionEvidence(process.env.PULLBACK_DB);
}
if (
  process.env.NODE_ENV === "test" &&
  process.env.MARKET_SAMPLING_E2E === "1"
) {
  const { seedMarketSampling } = await import("./e2e-market-sampling.js");
  await seedMarketSampling(process.env.PULLBACK_DB);
}
await import("../apps/server/main.js");
