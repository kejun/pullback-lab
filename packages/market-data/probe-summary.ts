import type { ProbeReport } from "./probe.js";
const checkNames = [
  "credentials",
  "entitlements",
  "dataUnits",
  "splitOnlyFactors",
  "corporateActionCoverage",
  "closedBarDelay",
  "tickSequence",
  "tickContinuity",
  "providerQuota",
  "retentionLicense",
  "cost",
  "clock",
] as const;
const statuses = new Set([
  "BLOCKED",
  "COLLECTING",
  "INCOMPLETE_CAPABILITY_UNKNOWN",
  "SAMPLES_COLLECTED_CAPABILITY_UNKNOWN",
]);
const stepStatuses = new Set([
  "SAMPLED",
  "EMPTY",
  "FAILED",
  "TIMED_OUT",
  "SKIPPED",
]);
const reasons = new Set([
  "NO_EVIDENCE_RETURNED",
  "PROBE_TIMEOUT",
  "QUOTE_PROBE_STEP_FAILED",
  "PREVIOUS_REQUEST_UNSETTLED",
  "OBSERVATION_NOT_REQUESTED",
]);
const credentialNames = new Set([
  "LONGBRIDGE_APP_KEY",
  "LONGBRIDGE_APP_SECRET",
  "LONGBRIDGE_ACCESS_TOKEN",
]);
function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function label(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value) ? value : "UNKNOWN";
}
/** Strict projection, never raw package details, quote/bar samples, URLs, paths, exception text or environment values. */
export function summarizeMarketProbe(
  report: ProbeReport,
  exitCode: number,
  reportSaved: boolean,
) {
  const checks = Object.fromEntries(
    checkNames.map((key) => {
      const value = report.checks[key];
      return [
        key,
        [
          "PRESENT",
          "MISSING",
          "UNKNOWN",
          "UNAVAILABLE_IN_SDK_5_2_0_TYPES",
        ].includes(value)
          ? value
          : "UNKNOWN",
      ];
    }),
  );
  return {
    schema: "pullback-lab-market-probe-summary-v1",
    status: statuses.has(report.status) ? report.status : "BLOCKED",
    exitCode: exitCode === 1 ? 1 : 2,
    reportSaved,
    liveEligible: false,
    sdk: label(report.sdk, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
    runtime: label(report.runtime, /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/),
    platform: ["darwin", "linux", "win32", "freebsd"].includes(report.platform)
      ? report.platform
      : "UNKNOWN",
    architecture: ["arm64", "x64", "ia32", "arm"].includes(report.architecture)
      ? report.architecture
      : "UNKNOWN",
    deploymentRegion: {
      declared: ["CN_MAINLAND", "OTHER", "UNKNOWN"].includes(
        report.deploymentRegion.declared,
      )
        ? report.deploymentRegion.declared
        : "UNKNOWN",
      verified: false,
    },
    missingEnvironmentNames: report.missingEnvironmentNames.filter((name) =>
      credentialNames.has(name),
    ),
    checks,
    // Reason codes are derived locally. Do not echo free-text blockedBy even if a future adapter puts secrets there.
    blockedBy: [
      "ACTUAL_CAPABILITY_REQUIRES_REVIEW",
      "SDK_TICK_CONTINUITY_UNPROVEN",
      ...(!reportSaved ? ["PRIVATE_REPORT_NOT_SAVED"] : []),
      ...(checks.credentials === "MISSING"
        ? ["APPLICATION_CREDENTIALS_MISSING"]
        : []),
    ],
    steps: report.steps.slice(0, 30).map((step) => {
      const evidence = record(step.evidence);
      const delay = record(evidence.observedDelayMs);
      const delayValues = [delay.min, delay.p50, delay.p95, delay.max];
      return {
        id: label(
          step.id,
          /^(?:adapter|quote-level|quote-packages|confirmed-observation|calendar:(?:US|CN)|(?:instrument|quote):[A-Z0-9._-]{1,30}\.(?:US|SH|SZ)|bars:[A-Z0-9._-]{1,30}\.(?:US|SH|SZ):(?:1D|1m|5m))$/,
        ),
        status: stepStatuses.has(step.status) ? step.status : "FAILED",
        ...(step.reason && reasons.has(step.reason)
          ? { reason: step.reason }
          : {}),
        elapsedMs: count(step.elapsedMs),
        ...(step.id.startsWith("bars:")
          ? { count: count(evidence.count) }
          : {}),
        ...(step.id === "confirmed-observation"
          ? {
              events: count(evidence.events),
              confirmedCount: count(evidence.confirmedCount),
              ...(delayValues.every(
                (v) => typeof v === "number" && Number.isSafeInteger(v),
              )
                ? {
                    observedDelayMs: {
                      min: delay.min,
                      p50: delay.p50,
                      p95: delay.p95,
                      max: delay.max,
                    },
                  }
                : {}),
              timestampSemanticsVerified: false,
              clockVerified: false,
            }
          : {}),
      };
    }),
    interpretation:
      "EMPTY_OR_NO_PUSH_DOES_NOT_PROVE_ENTITLEMENT_FAILURE;OBSERVED_DELAY_IS_NOT_CLOCK_OR_TIMESTAMP_VALIDATION",
  };
}
