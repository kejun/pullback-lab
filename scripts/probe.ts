import { createRequire } from "node:module";
import { getUnknownCapabilities } from "../packages/market-data/capabilities.js";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
const credentialNames = [
  "LONGBRIDGE_APP_KEY",
  "LONGBRIDGE_APP_SECRET",
  "LONGBRIDGE_ACCESS_TOKEN",
] as const;
const missing = credentialNames.filter((key) => !process.env[key]);
const symbols = (option("--symbols") ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const observeSeconds = Number(option("--observe-seconds") ?? "0");
const report: Record<string, unknown> = {
  schema: "pullback-lab-market-probe-v1",
  timestamp: new Date().toISOString(),
  runtime: process.version,
  sdk: require("longbridge/package.json").version,
  platform: process.platform,
  architecture: process.arch,
  deploymentRegion: {
    declared: process.env.PULLBACK_DEPLOYMENT_REGION ?? "UNKNOWN",
    verified: false,
  },
  mode: "READ_ONLY_QUOTE_CONTEXT",
  status: "BLOCKED",
  capabilities: getUnknownCapabilities(),
  checks: {
    credentials: missing.length ? "MISSING" : "PRESENT",
    entitlements: "UNKNOWN",
    dataUnits: "UNKNOWN",
    splitOnlyFactors: "UNKNOWN",
    corporateActionCoverage: "UNKNOWN",
    closedBarDelay: "UNKNOWN",
    tickSequence: "UNAVAILABLE_IN_SDK_5_2_0_TYPES",
    tickContinuity: "UNKNOWN",
    providerQuota: "UNKNOWN",
    retentionLicense: "UNKNOWN",
    cost: "UNKNOWN",
  },
  blockedBy: [] as string[],
};
function finish(code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () =>
      process.exit(code),
    );
  });
}
function addBlock(reason: string) {
  (report.blockedBy as string[]).push(reason);
}
if (missing.length) {
  report.missingEnvironmentNames = missing;
  addBlock("未配置应用自己的 OpenAPI 凭据；连接插件不等于应用授权。");
  await finish(2);
}
if (
  symbols.length < 1 ||
  symbols.length > 2 ||
  symbols.some((x) => !/^[A-Z0-9._-]+\.(US|SH|SZ)$/.test(x))
) {
  addBlock(
    "请用 --symbols 明确列出1至2只已授权研究证券；探针不会默认选择证券或购买行情。",
  );
  await finish(2);
}
if (
  !Number.isFinite(observeSeconds) ||
  observeSeconds < 0 ||
  observeSeconds > 120
) {
  addBlock("--observe-seconds 必须在0至120之间。");
  await finish(2);
}
async function bounded<T>(promise: Promise<T>, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PROBE_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const { LongbridgeReadOnlyAdapter } =
    await import("../packages/market-data/longbridge.js");
  const adapter = LongbridgeReadOnlyAdapter.fromEnvironment();
  report.entitlements = await bounded(adapter.entitlementEvidence());
  report.instruments = await bounded(adapter.instrumentEvidence(symbols));
  report.quotes = await bounded(adapter.fetchQuotes(symbols));
  const samples: Record<string, unknown> = {};
  for (const symbol of symbols) {
    const daily = await bounded(adapter.fetchBars(symbol, "1D", 300));
    const minute = await bounded(adapter.fetchBars(symbol, "1m", 60));
    samples[symbol] = {
      dailyCount: daily.length,
      minuteCount: minute.length,
      dailyLast: daily.slice(-3),
      minuteLast: minute.slice(-5),
      finality:
        "Historical query has no confirmed flag; production finality remains UNKNOWN",
    };
  }
  report.samples = samples;
  const now = new Date(),
    from = now.toISOString().slice(0, 10),
    through = new Date(now.getTime() + 14 * 86400000)
      .toISOString()
      .slice(0, 10);
  const markets = [
    ...new Set(symbols.map((x) => (x.endsWith(".US") ? "US" : "CN"))),
  ] as Array<"US" | "CN">;
  const calendar: Record<string, unknown> = {};
  for (const market of markets)
    calendar[market] = await bounded(
      adapter.calendarEvidence(market, from, through),
    );
  report.calendar = calendar;
  if (observeSeconds >= 1) {
    const confirmed = await bounded(
      adapter.observeConfirmed(symbols, observeSeconds * 1000),
      observeSeconds * 1000 + 20_000,
    );
    const delays = confirmed
      .filter((x) => x.finality === "CONFIRMED")
      .map((x) => x.receivedAt - (x.timestamp + 60000))
      .sort((a, b) => a - b);
    report.observation = {
      durationSeconds: observeSeconds,
      events: confirmed.length,
      confirmedCount: delays.length,
      delayMs: delays.length
        ? {
            min: delays[0],
            p50: delays[Math.floor((delays.length - 1) * 0.5)],
            p95: delays[Math.ceil((delays.length - 1) * 0.95)],
            max: delays.at(-1),
          }
        : null,
      samples: confirmed.slice(-5),
      timestampSemanticsVerified: false,
    };
  }
  report.status = "SAMPLES_COLLECTED_CAPABILITY_UNKNOWN";
  addBlock(
    "采样不等于验收：部署地区、行情单位、最终K线时序、会话完整性、逐笔连续性、拆股完整来源及额度仍需独立证据。",
  );
  addBlock(
    "SDK 推送类型没有包级 sequence；不可由本地序号或时间排序推定连续逐笔。",
  );
  addBlock(
    "未核验缓存许可与成本，未购买任何行情，未访问交易账户、持仓或订单。",
  );
  await finish(2);
} catch (error) {
  // Never emit provider error text, URLs, environment values, or credentials.
  report.failureCode =
    error instanceof Error && error.message === "PROBE_TIMEOUT"
      ? "PROBE_TIMEOUT"
      : "QUOTE_PROBE_FAILED";
  addBlock(
    "行情探针未完成。检查主机网络、OpenAPI权限及只读凭据配置；原始错误未输出以避免敏感数据泄漏。",
  );
  await finish(1);
}
