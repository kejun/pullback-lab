import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the production service lock and file-backed database with isolated data.
const directory = mkdtempSync(join(tmpdir(), "pullback-e2e-"));
process.env.PULLBACK_DB = join(directory, "research.sqlite");
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
await import("../apps/server/main.js");
