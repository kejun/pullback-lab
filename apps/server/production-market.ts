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
  const at = now();
  const contexts = configuration.histories.map((input) =>
    buildLongbridgeContext(input, at),
  );
  if (
    !contexts.length ||
    contexts.length > 10 ||
    new Set(contexts.map((c) => c.instrument.id)).size !== contexts.length ||
    new Set(contexts.map((c) => c.instrument.symbol)).size !== contexts.length
  )
    throw new ProductionMarketError("CLOSED_SUBSCRIPTION_LIMIT");
  const quota = structuredClone(configuration.quota);
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
    factory: longbridgeClosedBarFactory(contexts, quota, env, now),
  };
}
