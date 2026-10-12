import type { Market } from "../contracts/index.js";
import type {
  LongbridgeReadOnlyAdapter,
  ProviderBarSample,
} from "./longbridge.js";
import { getUnknownCapabilities } from "./capabilities.js";
import { OperationTimeout, withDeadline } from "./deadline.js";

type ProbeAdapter = Pick<
  LongbridgeReadOnlyAdapter,
  | "quoteLevelEvidence"
  | "quotePackagesEvidence"
  | "instrumentEvidence"
  | "fetchQuotes"
  | "fetchBars"
  | "calendarEvidence"
  | "observeConfirmed"
>;
export interface ProbeOptions {
  symbols: string[];
  observeSeconds: number;
  env: NodeJS.ProcessEnv;
  runtime: string;
  sdk: string;
  platform: string;
  architecture: string;
  adapterFactory: () => ProbeAdapter | Promise<ProbeAdapter>;
  now?: () => number;
  requestTimeoutMs?: number;
  requestSpacingMs?: number;
  /** Called after each completed step. Only safe, report-shaped data is supplied. */
  checkpoint?: (report: ProbeReport) => void;
}
export interface ProbeStep {
  id: string;
  market?: Market;
  symbol?: string;
  status: "SAMPLED" | "EMPTY" | "FAILED" | "TIMED_OUT" | "SKIPPED";
  startedAt: number;
  completedAt: number;
  elapsedMs: number;
  reason?: string;
  evidence?: unknown;
}
export interface ProbeReport {
  schema: "pullback-lab-market-probe-v2";
  timestamp: string;
  completedAt?: string;
  runtime: string;
  sdk: string;
  platform: string;
  architecture: string;
  deploymentRegion: { declared: string; verified: false };
  mode: "READ_ONLY_QUOTE_CONTEXT";
  status:
    | "BLOCKED"
    | "COLLECTING"
    | "INCOMPLETE_CAPABILITY_UNKNOWN"
    | "SAMPLES_COLLECTED_CAPABILITY_UNKNOWN";
  capabilities: ReturnType<typeof getUnknownCapabilities>;
  checks: Record<string, string>;
  blockedBy: string[];
  missingEnvironmentNames: string[];
  steps: ProbeStep[];
}
const credentials = [
  "LONGBRIDGE_APP_KEY",
  "LONGBRIDGE_APP_SECRET",
  "LONGBRIDGE_ACCESS_TOKEN",
];
const caveats = [
  "采样不等于验收：权限、部署地区、行情单位、最终K线时序、时钟、会话和拆股完整性仍需独立证据。",
  "SDK 推送类型没有包级 sequence；不能由本地序号或排序推定连续逐笔。",
  "额度、留存许可和成本仍未核验；未购买行情，未访问交易账户、持仓或订单。",
];
function barEvidence(samples: ProviderBarSample[]) {
  return {
    count: samples.length,
    samples: samples.slice(-5),
    finalityVerified: false,
  };
}
function observationEvidence(
  samples: ProviderBarSample[],
  durationSeconds: number,
) {
  const delays = samples
    .filter((x) => x.finality === "CONFIRMED")
    .map((x) => x.receivedAt - (x.timestamp + 60_000))
    .sort((a, b) => a - b);
  return {
    durationSeconds,
    events: samples.length,
    confirmedCount: delays.length,
    // Raw differences include negative values: timestamp semantics and host clock are not yet verified.
    observedDelayMs: delays.length
      ? {
          min: delays[0],
          p50: delays[Math.floor((delays.length - 1) * 0.5)],
          p95: delays[Math.ceil((delays.length - 1) * 0.95)],
          max: delays.at(-1),
        }
      : null,
    samples: samples.slice(-5),
    timestampSemanticsVerified: false,
    clockVerified: false,
  };
}
export async function runMarketProbe(
  options: ProbeOptions,
): Promise<{ report: ProbeReport; exitCode: 1 | 2 }> {
  const now = options.now ?? Date.now;
  const timeout = options.requestTimeoutMs ?? 20_000;
  const spacing = options.requestSpacingMs ?? 1000;
  let previousRequestAt: number | undefined;
  const { symbols, observeSeconds } = options;
  const missing = credentials.filter((key) => !options.env[key]?.trim());
  // Declaration is a label, never echo arbitrary environment contents into reports.
  const declared = options.env.PULLBACK_DEPLOYMENT_REGION;
  const report: ProbeReport = {
    schema: "pullback-lab-market-probe-v2",
    timestamp: new Date(now()).toISOString(),
    runtime: options.runtime,
    sdk: options.sdk,
    platform: options.platform,
    architecture: options.architecture,
    deploymentRegion: {
      declared:
        declared && /^[a-zA-Z0-9_-]{1,40}$/.test(declared)
          ? declared
          : "UNKNOWN",
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
      clock: "UNKNOWN",
    },
    blockedBy: [...caveats],
    missingEnvironmentNames: missing,
    steps: [],
  };
  const checkpoint = () => options.checkpoint?.(structuredClone(report));
  const finish = (exitCode: 1 | 2) => {
    report.completedAt = new Date(now()).toISOString();
    checkpoint();
    return { report, exitCode };
  };
  if (missing.length)
    report.blockedBy.push(
      "未配置应用自己的 OpenAPI 凭据；连接插件不等于应用授权。",
    );
  if (
    symbols.length < 1 ||
    symbols.length > 2 ||
    new Set(symbols).size !== symbols.length ||
    symbols.some((x) => !/^[A-Z0-9._-]+\.(US|SH|SZ)$/.test(x))
  )
    report.blockedBy.push("--symbols 必须明确列出1至2只不重复的已授权证券。");
  if (
    !Number.isInteger(observeSeconds) ||
    observeSeconds < 0 ||
    observeSeconds > 120
  )
    report.blockedBy.push("--observe-seconds 必须为0至120的整数。");
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    report.blockedBy.push("请求超时必须为1至60000毫秒的整数。");
  if (!Number.isSafeInteger(spacing) || spacing < 0 || spacing > 60_000)
    report.blockedBy.push("请求间隔超出范围。");
  if (report.blockedBy.length > caveats.length) return finish(2);
  report.status = "COLLECTING";
  checkpoint();
  let timedOut = false;
  let failed = false;
  async function step<T>(
    id: string,
    operation: () => Promise<T>,
    evidence: (value: T) => unknown,
    empty: (value: T) => boolean = () => false,
    scope: { market?: Market; symbol?: string } = {},
    deadline = timeout,
  ): Promise<T | undefined> {
    const startedAt = now();
    let result: ProbeStep;
    let value: T | undefined;
    if (timedOut)
      result = {
        id,
        ...scope,
        startedAt,
        completedAt: now(),
        elapsedMs: 0,
        status: "SKIPPED",
        reason: "PREVIOUS_REQUEST_UNSETTLED",
      };
    else {
      try {
        if (previousRequestAt !== undefined) {
          const wait = Math.max(0, previousRequestAt + spacing - now());
          if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        }
        previousRequestAt = now();
        value = await withDeadline(operation, deadline);
        const isEmpty = empty(value);
        result = {
          id,
          ...scope,
          startedAt,
          completedAt: now(),
          elapsedMs: Math.max(0, now() - startedAt),
          status: isEmpty ? "EMPTY" : "SAMPLED",
          ...(isEmpty ? { reason: "NO_EVIDENCE_RETURNED" } : {}),
          evidence: evidence(value),
        };
      } catch (error) {
        failed = true;
        timedOut = error instanceof OperationTimeout;
        result = {
          id,
          ...scope,
          startedAt,
          completedAt: now(),
          elapsedMs: Math.max(0, now() - startedAt),
          status: timedOut ? "TIMED_OUT" : "FAILED",
          reason: timedOut ? "PROBE_TIMEOUT" : "QUOTE_PROBE_STEP_FAILED",
        };
      }
    }
    report.steps.push(result);
    checkpoint();
    return value;
  }
  const adapter = await step(
    "adapter",
    async () => options.adapterFactory(),
    () => ({ initialized: true }),
  );
  if (!adapter) {
    report.status = "INCOMPLETE_CAPABILITY_UNKNOWN";
    return finish(1);
  }
  await step(
    "quote-level",
    () => adapter.quoteLevelEvidence(),
    (x) => ({ level: x }),
    (x) => !x,
  );
  await step(
    "quote-packages",
    () => adapter.quotePackagesEvidence(),
    (x) => x,
    (x) => x.length === 0,
  );
  for (const symbol of symbols) {
    const market: Market = symbol.endsWith(".US") ? "US" : "CN";
    const scope = { symbol, market };
    await step(
      `instrument:${symbol}`,
      () => adapter.instrumentEvidence([symbol]),
      (x) => x,
      (x) => x.length === 0,
      scope,
    );
    await step(
      `quote:${symbol}`,
      () => adapter.fetchQuotes([symbol]),
      (x) => x,
      (x) => x.length === 0,
      scope,
    );
    for (const period of ["1D", "1m", "5m"] as const)
      await step(
        `bars:${symbol}:${period}`,
        () => adapter.fetchBars(symbol, period, period === "1D" ? 300 : 60),
        barEvidence,
        (x) => x.length === 0,
        scope,
      );
  }
  const from = new Date(now()).toISOString().slice(0, 10);
  const through = new Date(now() + 14 * 86_400_000).toISOString().slice(0, 10);
  for (const market of new Set(
    symbols.map((x): Market => (x.endsWith(".US") ? "US" : "CN")),
  ))
    await step(
      `calendar:${market}`,
      () => adapter.calendarEvidence(market, from, through),
      (x) => x,
      (x) => x.tradingDays.length === 0,
      { market },
    );
  if (observeSeconds > 0)
    await step(
      "confirmed-observation",
      () => adapter.observeConfirmed(symbols, observeSeconds * 1000, timeout),
      (x) => observationEvidence(x, observeSeconds),
      (x) => !x.some((bar) => bar.finality === "CONFIRMED"),
      {},
      observeSeconds * 1000 + (symbols.length + 1) * timeout + 1000,
    );
  else {
    report.steps.push({
      id: "confirmed-observation",
      status: "SKIPPED",
      reason: "OBSERVATION_NOT_REQUESTED",
      startedAt: now(),
      completedAt: now(),
      elapsedMs: 0,
    });
  }
  report.status =
    failed || report.steps.some((x) => x.status === "EMPTY")
      ? "INCOMPLETE_CAPABILITY_UNKNOWN"
      : "SAMPLES_COLLECTED_CAPABILITY_UNKNOWN";
  return finish(failed ? 1 : 2);
}
