import { ProductionMarketError } from "./longbridge-context-builder.js";
import type Database from "better-sqlite3";
import { ActionEvidenceRepository } from "../../packages/market-data/action-evidence.js";
import type {
  AdjustmentDataset,
  CorporateAction,
} from "../../packages/market-data/adjustments.js";
import { assertClosedActionEvidenceCurrent } from "./closed-action-binding.js";
import { closedHash, type ClosedBarContext } from "./closed-bar-adapter.js";
/** Reconcile current local facts with independently reviewed external coverage. */
export function assertReviewedActionDataset(
  db: Database.Database,
  context: ClosedBarContext,
  adjustments: AdjustmentDataset,
): void {
  assertClosedActionEvidenceCurrent(db, context);
  if (context.actionEvidenceVersion) {
    const persisted = new ActionEvidenceRepository(db).dataset(
      context.instrument.id,
      context.basisKnownAt,
      context.actionEvidenceVersion,
    );
    if (!persisted)
      throw new ProductionMarketError("HISTORY_ACTION_BINDING_MISMATCH");
    // Local imports cover only already elapsed time. A reviewed external source may
    // cover the upcoming session; compare the relevant facts, not incompatible coverage envelopes.
    const latest = new Map<string, CorporateAction>();
    for (const action of adjustments.actions) {
      if (
        action.receivedAt > context.basisKnownAt ||
        action.publishedAt > context.basisKnownAt
      )
        continue;
      if (
        !latest.has(action.id) ||
        action.revision > latest.get(action.id)!.revision
      )
        latest.set(action.id, action);
    }
    const economicFact = (a: CorporateAction) =>
      closedHash({
        id: a.id,
        revision: a.revision,
        kind: a.kind,
        effectiveAt: a.effectiveAt,
        publishedAt: a.publishedAt,
        sharesAfter: a.sharesAfter,
        sharesBefore: a.sharesBefore,
      });
    const relevant = (a: CorporateAction) =>
      a.effectiveAt > context.daily[0].time * 1000 &&
      a.effectiveAt <= adjustments.coverage.through;
    if (
      persisted.actions
        .filter(relevant)
        .some(
          (a) =>
            !latest.has(a.id) ||
            economicFact(latest.get(a.id)!) !== economicFact(a),
        )
    )
      throw new ProductionMarketError("HISTORY_ACTION_BINDING_MISMATCH");
    // removedActionIds is only an adjacent-version delta. Consult immutable
    // facts so a later unrelated snapshot cannot erase an earlier withdrawal.
    const present = new Set(persisted.actions.map((action) => action.id));
    const previouslyKnown = db
      .prepare(
        "SELECT DISTINCT action_id FROM corporate_action_facts WHERE instrument_id=?",
      )
      .all(context.instrument.id) as { action_id: string }[];
    if (
      previouslyKnown.some(
        ({ action_id: id }) =>
          !present.has(id) && latest.has(id) && relevant(latest.get(id)!),
      )
    )
      throw new ProductionMarketError("HISTORY_ACTION_BINDING_MISMATCH");
  }
}
