import type { Plan } from "../../../packages/contracts/index";
import type { ClosedBarRuntime } from "../../server/closed-bar-runtime";

export interface MonitorSnapshot {
  availability: ReturnType<ClosedBarRuntime["availability"]>;
  progress: ReturnType<ClosedBarRuntime["status"]>;
}
export type MonitorCommand = "activate" | "recover" | "pause";

export function formalMonitorControls(
  plan: Plan,
  snapshot: MonitorSnapshot | null,
) {
  const availability = snapshot?.availability;
  const progress = snapshot?.progress;
  const sameSession = Boolean(
    progress && progress.sessionDate === plan.sessionDate,
  );
  const historicalOnly = Boolean(
    progress &&
    typeof progress.sessionDate === "string" &&
    progress.sessionDate !== plan.sessionDate,
  );
  const sessionUnknown = Boolean(progress && !progress.sessionDate);
  const instrument = availability?.instruments.find(
    (row) => row.instrumentId === plan.instrumentId,
  );
  const capabilityReason = !availability
    ? "尚未读取服务器正式监测状态。"
    : !availability.configured
      ? "未配置正式行情适配器，无法启用正式监测。"
      : !availability.connected
        ? "正式行情连接已断开，无法启用或恢复。"
        : !instrument?.liveEligible
          ? "此证券的实时授权、数据完整性或有效期尚未通过服务器核验。"
          : null;
  const evidenceReason = plan.researchHistoryId
    ? "人工历史资料仅供研究，不能启用正式提醒。"
    : plan.mode !== "CLOSE_CONFIRM"
      ? "正式监测目前只支持收盘确认；盘中逐笔模式未开放。"
      : !plan.backgroundConfirmed || !plan.reason.trim()
        ? "请确认研究背景并保存计划。"
        : !plan.supportSnapshot?.ready ||
            !plan.supportSnapshot.providerContextId
          ? "已保存计划缺少有效的服务端支撑依据，请核对并保存新版本。"
          : null;
  const identityMismatch = Boolean(
    progress &&
    plan.attemptId &&
    (!progress.current ||
      progress.attemptId !== plan.attemptId ||
      progress.planVersion !== plan.version),
  );
  const finished =
    [
      "TRIGGERED",
      "ENTRY_TRIGGERED",
      "TAKEN",
      "SKIPPED",
      "INVALID",
      "EXPIRED",
    ].includes(plan.status) ||
    Boolean(
      progress &&
      sameSession &&
      [
        "TRIGGERED",
        "ENTRY_TRIGGERED",
        "TAKEN",
        "SKIPPED",
        "INVALID",
        "EXPIRED",
      ].includes(progress.status),
    );
  const paused = ["DRAFT", "PAUSED", "USER_PAUSED", "DATA_PAUSED"].includes(
    plan.status,
  );
  const reason = capabilityReason ?? evidenceReason;
  return {
    capabilityReason,
    evidenceReason,
    reason,
    identityMismatch,
    sameSession,
    historicalOnly,
    sessionUnknown,
    canActivate: Boolean(
      snapshot &&
      !reason &&
      (!progress || historicalOnly) &&
      !plan.attemptId &&
      plan.status === "DRAFT",
    ),
    canRecover: Boolean(
      snapshot &&
      !reason &&
      progress &&
      sameSession &&
      !identityMismatch &&
      !finished &&
      paused,
    ),
    // A lost capability must never prevent explicitly stopping an existing attempt.
    canPause: Boolean(
      snapshot &&
      plan.attemptId &&
      !identityMismatch &&
      !finished &&
      ["WAIT_RETEST", "ARMED", "ACTIVE", "DATA_PAUSED"].includes(plan.status),
    ),
  };
}

export function monitorCommandBody(
  plan: Plan,
  snapshot: MonitorSnapshot,
  kind: MonitorCommand,
) {
  return {
    expectedVersion: plan.version,
    expectedAttemptId: plan.attemptId ?? null,
    ...(kind === "recover" && snapshot.progress
      ? {
          sourceAttemptId: snapshot.progress.attemptId,
          expectedWatermark: snapshot.progress.watermark,
        }
      : {}),
  };
}

/** One read per mount generation. Cancellation releases the lease for StrictMode remounts. */
export class MonitorReadFence {
  private generation = 0;
  private reading = false;
  begin(): number | null {
    if (this.reading) return null;
    this.reading = true;
    return ++this.generation;
  }
  current(token: number) {
    return token === this.generation;
  }
  finish(token: number) {
    if (!this.current(token)) return false;
    this.reading = false;
    return true;
  }
  cancel() {
    this.generation++;
    this.reading = false;
  }
}
