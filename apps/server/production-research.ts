import {
  buildEodResearchContext,
  type EodResearchInput,
} from "./eod-research.js";
import { ProductionMarketError } from "./longbridge-context-builder.js";
/** A separately reviewed historical source; never enables a network connection or live monitoring. */
export function prepareProductionResearch(
  configuration: readonly EodResearchInput[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
) {
  const mode = env.PULLBACK_RESEARCH_MODE ?? "off";
  if (mode !== "off" && mode !== "longbridge-eod")
    throw new ProductionMarketError("RESEARCH_MODE_INVALID");
  if (mode === "off")
    return {
      histories: [] as EodResearchInput[],
      report: {
        mode,
        configured: false,
        contextCount: 0,
        liveEnabled: false as const,
      },
    };
  if (env.PULLBACK_DEMO === "1")
    throw new ProductionMarketError("LONGBRIDGE_DEMO_MUST_BE_DISABLED");
  if (!configuration?.length)
    throw new ProductionMarketError("AUDITED_RESEARCH_CONFIGURATION_REQUIRED");
  if (configuration.length > 100)
    throw new ProductionMarketError("EOD_RESEARCH_LIMIT");
  const histories = structuredClone(configuration),
    at = now();
  const contexts = histories.map((i) => buildEodResearchContext(i, at));
  if (
    new Set(contexts.map((c) => c.instrument.id)).size !== contexts.length ||
    new Set(contexts.map((c) => c.instrument.symbol)).size !== contexts.length
  )
    throw new ProductionMarketError("EOD_RESEARCH_DUPLICATE");
  return {
    histories,
    report: {
      mode,
      configured: true,
      contextCount: contexts.length,
      contextIds: contexts.map((c) => c.id),
      validUntil: Math.min(...contexts.map((c) => c.capability.validUntil)),
      liveEnabled: false as const,
    },
  };
}
