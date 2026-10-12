export interface ProviderQuota {
  researchSymbols: number | null;
  simultaneousSubscriptions: number | null;
  monthlyUniqueSymbols: number | null;
  requestsPerSecond: number | null;
  verified: boolean;
}
export interface QuotaState {
  researchSymbols: string[];
  monitoringSymbols: string[];
  monthlySymbols: string[];
  requestTimes: number[];
}
export type QuotaDecision =
  { ok: true; state: QuotaState } | { ok: false; reason: string };
/** Shared US/CN capacity. Keep state in the application's transaction, never one counter per market. */
export function reserveQuota(
  state: QuotaState,
  quota: ProviderQuota,
  kind: "RESEARCH" | "MONITOR" | "REQUEST",
  symbol: string,
  now: number,
): QuotaDecision {
  const next = structuredClone(state);
  if (!quota.verified) return { ok: false, reason: "PROVIDER_QUOTA_UNKNOWN" };
  const caps = [
    quota.researchSymbols,
    quota.simultaneousSubscriptions,
    quota.monthlyUniqueSymbols,
    quota.requestsPerSecond,
  ];
  if (caps.some((x) => x === null || !Number.isSafeInteger(x) || x < 0))
    return { ok: false, reason: "PROVIDER_QUOTA_UNKNOWN" };
  if (kind === "REQUEST") {
    next.requestTimes = next.requestTimes.filter((x) => x > now - 1000);
    if (next.requestTimes.length >= quota.requestsPerSecond!)
      return { ok: false, reason: "REQUEST_RATE_LIMIT" };
    next.requestTimes.push(now);
    return { ok: true, state: next };
  }
  if (!symbol) return { ok: false, reason: "SYMBOL_REQUIRED" };
  if (!next.monthlySymbols.includes(symbol)) {
    if (next.monthlySymbols.length >= quota.monthlyUniqueSymbols!)
      return { ok: false, reason: "MONTHLY_SYMBOL_LIMIT" };
    next.monthlySymbols.push(symbol);
  }
  if (kind === "RESEARCH" && !next.researchSymbols.includes(symbol)) {
    if (next.researchSymbols.length >= Math.min(100, quota.researchSymbols!))
      return { ok: false, reason: "RESEARCH_POOL_LIMIT" };
    next.researchSymbols.push(symbol);
  }
  if (kind === "MONITOR" && !next.monitoringSymbols.includes(symbol)) {
    if (!next.researchSymbols.includes(symbol))
      return { ok: false, reason: "SYMBOL_NOT_IN_RESEARCH_POOL" };
    if (
      next.monitoringSymbols.length >=
      Math.min(10, quota.simultaneousSubscriptions!)
    )
      return { ok: false, reason: "MONITORING_LIMIT" };
    next.monitoringSymbols.push(symbol);
  }
  return { ok: true, state: next };
}
