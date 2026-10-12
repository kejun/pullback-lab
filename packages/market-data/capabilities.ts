import type {
  Capability,
  Market,
  Mode,
  Instrument,
} from "../contracts/index.js";
export interface CapabilityEvidence {
  market: Market;
  source: string;
  checkedAt: number;
  validUntil: number;
  deploymentRegion: "CN_MAINLAND" | "OTHER" | "UNKNOWN";
  apiEntitlementVerified: boolean;
  historicalReadVerified: boolean;
  realtimeEntitlementVerified: boolean;
  unitsVerified: boolean;
  calendarVerified: boolean;
  completeMinutes: boolean;
  finalityContractVerified: boolean;
  maxClosedBarDelayMs: number | null;
  quoteAgeMs: number | null;
  sequenceContractVerified: boolean;
  continuousTradesVerified: boolean;
  clockSkewMs: number | null;
  delayMinutes: number | null;
}
export function assessCapability(
  e: CapabilityEvidence,
  now: number,
): Capability {
  const result = (level: Capability["level"], reason: string): Capability => ({
    market: e.market,
    level,
    reason,
    source: e.source,
    checkedAt: e.checkedAt,
  });
  if (
    !e.source ||
    !Number.isSafeInteger(e.checkedAt) ||
    !Number.isSafeInteger(e.validUntil) ||
    !Number.isSafeInteger(now) ||
    e.checkedAt > now ||
    e.validUntil < now ||
    !e.apiEntitlementVerified
  )
    return result("UNKNOWN", "行情权限证据缺失或已过期");
  if (!e.historicalReadVerified)
    return result("UNKNOWN", "尚未核验历史行情读取与数据口径");
  if (
    (e.delayMinutes ?? 0) > 0 ||
    (e.market === "CN" && e.deploymentRegion === "OTHER")
  )
    return result("DELAYED", "延迟行情仅用于研究，不允许行动提醒");
  if (
    !e.realtimeEntitlementVerified ||
    e.deploymentRegion === "UNKNOWN" ||
    e.delayMinutes === null ||
    !Number.isFinite(e.delayMinutes) ||
    e.delayMinutes < 0
  )
    return result("EOD_ONLY", "实时权限或实际部署地区尚未核验");
  if (
    !e.unitsVerified ||
    !e.calendarVerified ||
    !e.completeMinutes ||
    !e.finalityContractVerified
  )
    return result("EOD_ONLY", "分钟完整性、最终状态、单位或日历尚未核验");
  if (
    e.maxClosedBarDelayMs === null ||
    !Number.isFinite(e.maxClosedBarDelayMs) ||
    e.maxClosedBarDelayMs < 0 ||
    e.maxClosedBarDelayMs > 30_000 ||
    e.quoteAgeMs === null ||
    !Number.isFinite(e.quoteAgeMs) ||
    e.quoteAgeMs < 0 ||
    e.quoteAgeMs > 3000 ||
    e.clockSkewMs === null ||
    !Number.isFinite(e.clockSkewMs) ||
    Math.abs(e.clockSkewMs) > 1000
  )
    return result("EOD_ONLY", "K线延迟、报价新鲜度或时钟证据不合格");
  if (e.sequenceContractVerified && e.continuousTradesVerified)
    return result("LIVE_TICK", "已验证闭合行情和连续有序成交证据");
  return result("LIVE_CLOSED_BAR", "闭合行情合格；逐笔顺序或连续性未验证");
}
export function getUnknownCapabilities(): Capability[] {
  return (["US", "CN"] as Market[]).map((market) => ({
    market,
    level: "UNKNOWN",
    reason: "未在实际部署主机核验 API 权限、会话完整性与实时数据质量",
    source: "longbridge-probe-pending",
    checkedAt: null,
  }));
}
export function monitoringGate(
  capability: Capability,
  instrument: Instrument,
  mode: Mode,
): string[] {
  const reasons: string[] = [];
  if (!instrument.rulesVerified) reasons.push("INSTRUMENT_RULES_UNKNOWN");
  if (capability.market !== instrument.market)
    reasons.push("MARKET_CAPABILITY_MISMATCH");
  if (
    mode === "INTRABAR_CROSS"
      ? capability.level !== "LIVE_TICK"
      : !["LIVE_CLOSED_BAR", "LIVE_TICK"].includes(capability.level)
  )
    reasons.push("REALTIME_CAPABILITY_UNAVAILABLE");
  return reasons;
}
