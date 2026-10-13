import { ActionEvidenceRepository } from "../../packages/market-data/action-evidence.js";
import { assertClosedActionEvidenceCurrent } from "./closed-action-binding.js";
import type { Store } from "./store.js";
import type { CorporateAction } from "../../packages/market-data/adjustments.js";
import type { ProviderQuota } from "../../packages/market-data/quota.js";
import { reserveQuota } from "../../packages/market-data/quota.js";
import { closedHash } from "./closed-bar-adapter.js";
import {
  buildLongbridgeContext,
  ProductionMarketError,
  type LongbridgeContextInput,
} from "./longbridge-context-builder.js";
import { longbridgeClosedBarFactory } from "./longbridge-closed-bar-adapter.js";

/** A statically imported, code-reviewed server dependency. Never populated from HTTP, uploads or env JSON. */
export interface AuditedLongbridgeConfiguration {
  histories: readonly LongbridgeContextInput[];
  quota: ProviderQuota;
}
export function prepareProductionMarket(
  configuration: AuditedLongbridgeConfiguration | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
) {
  const mode = env.PULLBACK_CLOSED_BAR_MODE ?? "off";
  if (mode !== "off" && mode !== "longbridge-close-confirm")
    throw new ProductionMarketError("MARKET_MODE_INVALID");
  if (mode === "off")
    return {
      report: {
        mode,
        configured: false,
        liveEnabled: false as const,
        contextCount: 0,
      },
      factory: undefined,
    };
  if (env.PULLBACK_MARKET_WORKER === "1")
    throw new ProductionMarketError("LONGBRIDGE_SAMPLER_MUST_BE_DISABLED");
  if (env.PULLBACK_DEMO === "1")
    throw new ProductionMarketError("LONGBRIDGE_DEMO_MUST_BE_DISABLED");
  if (!configuration)
    throw new ProductionMarketError("AUDITED_SERVER_CONFIGURATION_REQUIRED");
  const reviewed = structuredClone(configuration);
  const at = now();
  const contexts = reviewed.histories.map((input) =>
    buildLongbridgeContext(input, at),
  );
  if (
    !contexts.length ||
    contexts.length > 10 ||
    new Set(contexts.map((c) => c.instrument.id)).size !== contexts.length ||
    new Set(contexts.map((c) => c.instrument.symbol)).size !== contexts.length
  )
    throw new ProductionMarketError("CLOSED_SUBSCRIPTION_LIMIT");
  if (contexts.some((context) => context.instrument.market === "CN"))
    throw new ProductionMarketError("LONGBRIDGE_CN_MINUTE_UNIT_UNSUPPORTED");
  const quota = structuredClone(reviewed.quota);
  const check = reserveQuota(
    {
      researchSymbols: [],
      monitoringSymbols: [],
      monthlySymbols: [],
      requestTimes: [],
    },
    quota,
    "REQUEST",
    "",
    at,
  );
  if (
    !check.ok ||
    quota.requestsPerSecond === null ||
    quota.requestsPerSecond < 1 ||
    quota.researchSymbols === null ||
    contexts.length > Math.min(100, quota.researchSymbols) ||
    quota.monthlyUniqueSymbols === null ||
    contexts.length > quota.monthlyUniqueSymbols ||
    quota.simultaneousSubscriptions === null ||
    contexts.length > Math.min(10, quota.simultaneousSubscriptions)
  )
    throw new ProductionMarketError("PROVIDER_QUOTA_UNKNOWN");
  return {
    report: {
      mode,
      configured: true,
      liveEnabled: false as const,
      contextCount: contexts.length,
      contextIds: contexts.map((c) => `closed-context:${closedHash(c)}`),
      basisDates: contexts.map((c) => c.basisDate),
      validUntil: Math.min(...contexts.map((c) => c.capability.validUntil)),
    },
    factory: (store: Store) => {
      contexts.forEach((context, index) => {
        assertClosedActionEvidenceCurrent(store.db, context);
        if (context.actionEvidenceVersion) {
          const persisted = new ActionEvidenceRepository(store.db).dataset(
            context.instrument.id,
            context.basisKnownAt,
            context.actionEvidenceVersion,
          );
          if (!persisted)
            throw new ProductionMarketError("HISTORY_ACTION_BINDING_MISMATCH");
          // Local imports cover only already elapsed time. A reviewed external source may
          // cover the upcoming session; compare the relevant facts, not incompatible coverage envelopes.
          const latest = new Map<string, CorporateAction>();
          for (const action of reviewed.histories[index].adjustments.actions) {
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
            a.effectiveAt <=
              reviewed.histories[index].adjustments.coverage.through;
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
          const previouslyKnown = store.db
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
      });
      return longbridgeClosedBarFactory(contexts, quota, env, now)(store);
    },
  };
}
