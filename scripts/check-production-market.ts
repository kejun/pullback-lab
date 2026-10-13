import { prepareProductionMarket } from "../apps/server/production-market.js";
import { auditedLongbridgeConfiguration } from "../apps/server/production-market-config.js";

// Pure assembly check: no Store, migration, lock, provider context, credentials or HTTP request.
try {
  const { report } = prepareProductionMarket(auditedLongbridgeConfiguration);
  console.info(
    JSON.stringify({
      status: "CONFIGURATION_VALID",
      providerContacted: false,
      ...report,
    }),
  );
} catch (error) {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code)
      ? error.code
      : "MARKET_CONFIGURATION_INVALID";
  console.error(
    JSON.stringify({
      status: "BLOCKED",
      code,
      providerContacted: false,
      liveEnabled: false,
    }),
  );
  process.exitCode = 2;
}
