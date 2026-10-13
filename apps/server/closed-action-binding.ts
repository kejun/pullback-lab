import type Database from "better-sqlite3";
import type { ClosedBarContext } from "./closed-bar-adapter.js";

/** Latest persisted generation, independent of wall clock. A clock rollback cannot resurrect a revoked source. */
export function currentActionEvidenceVersion(
  db: Database.Database,
  instrumentId: string,
): string | null {
  return (
    (
      db
        .prepare(
          "SELECT version FROM corporate_action_snapshots WHERE instrument_id=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(instrumentId) as { version: string } | undefined
    )?.version ?? null
  );
}
/** Legacy contexts are compatible only while this instrument has no local action evidence at all. */
export function closedActionEvidenceCurrent(
  db: Database.Database,
  context: ClosedBarContext,
): boolean {
  return (
    (context.actionEvidenceVersion ?? null) ===
    currentActionEvidenceVersion(db, context.instrument.id)
  );
}
export function assertClosedActionEvidenceCurrent(
  db: Database.Database,
  context: ClosedBarContext,
): void {
  if (!closedActionEvidenceCurrent(db, context))
    throw new Error("CORPORATE_ACTION_CONTEXT_REVOKED");
}
