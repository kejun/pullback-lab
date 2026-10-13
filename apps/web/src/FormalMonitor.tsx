import { useEffect, useRef, useState } from "react";
import type { Plan } from "../../../packages/contracts/index";
import { api, ApiError } from "./api";
import {
  MonitorReadFence,
  formalMonitorControls,
  monitorCommandBody,
  type MonitorCommand,
  type MonitorSnapshot,
} from "./formal-monitor-state";

const labels: Record<string, string> = {
  RUNNING: "监测运行中",
  DATA_PAUSED: "数据暂停",
  RECOVERY_PAUSED: "重启后暂停",
  COMPLETE: "本次观察已结束",
  WAIT_RETEST: "等待回踩",
  ARMED: "回踩已确认",
  USER_PAUSED: "用户已暂停",
  TRIGGERED: "条件已触发，等待反馈",
  ENTRY_TRIGGERED: "条件已触发",
  INVALID: "本次计划失效",
  EXPIRED: "观察窗口已到期",
  TAKEN: "已记录交易",
  SKIPPED: "已记录跳过",
  RUNTIME_RESTARTED: "服务重启，原尝试保持暂停",
  LIVE_CAPABILITY_UNVERIFIED: "实时授权或行情能力尚未通过核验",
  ADAPTER_DISCONNECTED: "行情连接断开",
  MISSING_MINUTE: "缺少连续闭合分钟",
  MINUTE_OUT_OF_ORDER_OR_GAP: "分钟乱序或缺段",
  MINUTE_TOO_LATE: "分钟接收超出时限",
  PLAN_VERSION_CHANGED: "计划版本已改变",
  PLAN_NO_LONGER_ACTIVE: "计划已暂停或当前尝试已改变",
  STOP_REFERENCE_TOUCHED: "价格触及止损参考",
  SESSION_HISTORY_INCOMPLETE: "开盘后启用所需的此前会话证据不完整",
};
const time = (at: number | null | undefined) =>
  at == null
    ? "尚无"
    : new Date(at).toISOString().replace("T", " ").replace(".000Z", " UTC");
const actionLabels: Record<MonitorCommand, string> = {
  activate: "启用正式收盘监测",
  recover: "新建正式恢复尝试",
  pause: "暂停正式监测",
};

export function FormalMonitor({
  plan,
  disabled,
  onChanged,
  onBusyChange,
}: {
  plan: Plan;
  disabled: boolean;
  onChanged: (signal?: AbortSignal) => Promise<void>;
  onBusyChange: (value: boolean) => void;
}) {
  const title =
    plan.mode === "INTRABAR_CROSS" ? "正式盘中监测" : "正式收盘监测";
  const actionLabel = (kind: MonitorCommand) =>
    kind === "activate" && plan.mode === "INTRABAR_CROSS"
      ? "启用正式盘中监测"
      : actionLabels[kind];
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [confirmation, setConfirmation] = useState<MonitorCommand | null>(null);
  const [lastRead, setLastRead] = useState<number | null>(null);
  const active = useRef(false);
  const reads = useRef(new MonitorReadFence());
  const commandLock = useRef(false);
  const readAbort = useRef<AbortController | null>(null);
  const callback = useRef(onChanged);
  callback.current = onChanged;

  async function read(explicit = false, refreshPlan = explicit) {
    if (commandLock.current) return;
    const requested = reads.current.begin();
    if (requested === null) return;
    const controller = new AbortController();
    readAbort.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    try {
      if (refreshPlan) await callback.current(controller.signal);
      if (!active.current || !reads.current.current(requested)) return;
      const result = await api<MonitorSnapshot>(
        `/plans/${encodeURIComponent(plan.id)}/monitor`,
        "GET",
        undefined,
        { signal: controller.signal },
      );
      if (!active.current || !reads.current.current(requested)) return;
      setSnapshot(result);
      setLastRead(Date.now());
      setError(null);
      if (explicit) setNeedsRefresh(false);
    } catch (cause) {
      if (!active.current || !reads.current.current(requested)) return;
      setError(
        cause instanceof Error ? cause.message : "无法读取正式监测状态。",
      );
      setNeedsRefresh(true);
      setConfirmation(null);
    } finally {
      window.clearTimeout(timeout);
      if (reads.current.finish(requested)) {
        if (active.current) setLoading(false);
      }
    }
  }
  useEffect(() => {
    active.current = true;
    void read();
    return () => {
      active.current = false;
      reads.current.cancel();
      readAbort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (confirmation || pending || needsRefresh) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [confirmation, pending, needsRefresh]);
  useEffect(() => {
    if (disabled && !pending) setConfirmation(null);
  }, [disabled, pending]);

  const controls = formalMonitorControls(plan, snapshot);
  const blocked =
    disabled || loading || pending || needsRefresh || controls.identityMismatch;
  const allowed = (kind: MonitorCommand) =>
    kind === "activate"
      ? controls.canActivate
      : kind === "recover"
        ? controls.canRecover
        : controls.canPause;
  async function command(kind: MonitorCommand) {
    if (
      blocked ||
      commandLock.current ||
      !snapshot ||
      confirmation !== kind ||
      !allowed(kind)
    )
      return;
    commandLock.current = true;
    setPending(true);
    onBusyChange(true);
    setError(null);
    reads.current.cancel();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      await api(
        `/plans/${encodeURIComponent(plan.id)}/${kind === "recover" ? "monitor/recover" : kind}`,
        "POST",
        monitorCommandBody(plan, snapshot, kind),
        { signal: controller.signal },
      );
      if (!active.current) return;
      setConfirmation(null);
      // No optimistic activation. Adopt a new plan/attempt only after server readback.
      setNeedsRefresh(true);
      await callback.current(controller.signal);
      if (active.current) {
        commandLock.current = false;
        await read(true, false);
      }
    } catch (cause) {
      if (!active.current) return;
      setConfirmation(null);
      setNeedsRefresh(true);
      const message =
        cause instanceof Error ? cause.message : "正式监测操作暂时无法完成。";
      setError(
        cause instanceof ApiError && cause.status === 409
          ? `${message}。计划、尝试或水位已变化；未自动重试，请读取最新状态后重新核对。`
          : `${message}。请先读取最新状态确认结果；不会自动重试或启用。`,
      );
    } finally {
      window.clearTimeout(timeout);
      commandLock.current = false;
      onBusyChange(false);
      if (active.current) setPending(false);
    }
  }
  const progress = snapshot?.progress;
  const instrument = snapshot?.availability.instruments.find(
    (row) => row.instrumentId === plan.instrumentId,
  );
  const reasons = [
    ...new Set(
      [progress?.reason, instrument?.reason].filter((r): r is string =>
        Boolean(r),
      ),
    ),
  ];
  return (
    <section
      className="formal-monitor"
      aria-label={title}
      aria-busy={loading || pending}
    >
      <div className="section-heading">
        <h3>{title}</h3>
        <button
          type="button"
          className="text-button"
          disabled={loading || pending}
          onClick={() => {
            setConfirmation(null);
            void read(true);
          }}
        >
          读取最新监测状态
        </button>
      </div>
      <p>
        只接收服务器核验的行情与连续性证据。此入口不连接交易账户，也不会下单。
      </p>
      {error && (
        <p className="support-warning" role="alert">
          {error}
        </p>
      )}
      {controls.capabilityReason && (
        <p className="support-warning">{controls.capabilityReason}</p>
      )}
      {controls.evidenceReason && (
        <p className="support-warning">{controls.evidenceReason}</p>
      )}
      {controls.sessionUnknown && (
        <p className="support-warning">
          旧状态缺少会话身份；无法启用或恢复，请读取最新服务端状态。
        </p>
      )}
      {controls.historicalOnly && (
        <p className="field-explanation">
          以下为较早会话 {progress?.sessionDate} 的只读历史；当前计划会话为{" "}
          {plan.sessionDate}。旧尝试不能用于当前会话恢复。
        </p>
      )}
      {controls.identityMismatch && (
        <p className="support-warning" role="alert">
          服务端尝试与当前计划版本不一致。请读取最新监测状态，核对后再操作。
        </p>
      )}
      {disabled && (
        <p className="field-explanation">
          请先保存或核对当前草稿改动；监测控制暂不可用。
        </p>
      )}
      {needsRefresh && (
        <p className="support-warning">
          状态未确认；以下仅保留上次读回。请读取最新监测状态后再操作。
        </p>
      )}
      <dl className="detail-list">
        <dt>行情连接</dt>
        <dd>
          {!snapshot
            ? "读取中"
            : !snapshot.availability.configured
              ? "未配置"
              : snapshot.availability.connected
                ? "已连接"
                : "已断开"}
        </dd>
        <dt>本标的能力</dt>
        <dd>
          {instrument?.tickEligible
            ? "服务器已核验连续逐笔协议与收盘资格"
            : instrument?.liveEligible
              ? "服务器已核验正式收盘资格"
              : "未授权或尚未核验，不可行动"}
        </dd>
        <dt>实际运行模式</dt>
        <dd>
          {progress &&
          ["WAIT_RETEST", "ARMED"].includes(plan.status) &&
          progress.phase === "RUNNING" &&
          progress.current &&
          controls.sameSession &&
          !needsRefresh &&
          !controls.capabilityReason
            ? progress.mode === "INTRABAR_CROSS"
              ? "盘中穿越"
              : "收盘确认"
            : "未运行正式监测"}
          {!instrument?.tickEligible && "；盘中逐笔未开放"}
        </dd>
        <dt>模式差异</dt>
        <dd>
          收盘确认等待最终 K
          线；盘中穿越需要参考就绪后的连续两笔成交，可能触发后回落，原始记录会保留。
        </dd>
        {plan.mode === "INTRABAR_CROSS" && !instrument?.tickEligible && (
          <>
            <dt>盘中未开放原因</dt>
            <dd>
              {instrument?.tickReason ?? "连续逐笔协议与实际部署证据尚未核验"}
            </dd>
          </>
        )}
        <dt>当前计划版本</dt>
        <dd>
          v{plan.version} · {labels[plan.status] ?? plan.status}
        </dd>
        <dt>最近读取</dt>
        <dd>{time(lastRead)}</dd>
      </dl>
      {progress ? (
        <>
          <dl className="detail-list">
            <dt>尝试会话</dt>
            <dd>{progress.sessionDate ?? "未知"}</dd>
            <dt>尝试身份</dt>
            <dd>
              {progress.template === "RECOVERY"
                ? "恢复尝试（不是会话首次）"
                : "会话首次观察"}
            </dd>
            <dt>尝试版本与阶段</dt>
            <dd>
              v{progress.planVersion} ·{" "}
              {labels[progress.phase] ?? progress.phase}
            </dd>
            <dt>当前尝试</dt>
            <dd className="attempt-identity">{progress.attemptId}</dd>
            {progress.sourceAttemptId && (
              <>
                <dt>来源尝试</dt>
                <dd className="attempt-identity">{progress.sourceAttemptId}</dd>
              </>
            )}
            <dt>判断状态</dt>
            <dd>{labels[progress.status] ?? progress.status}</dd>
            <dt>激活水位</dt>
            <dd>{time(progress.activatedAt)}</dd>
            <dt>已处理输入水位</dt>
            <dd>{time(progress.watermark)}</dd>
            <dt>截止裁决水位</dt>
            <dd>{time(progress.deadlineWatermark)}</dd>
            <dt>观察截止</dt>
            <dd>{time(progress.deadline)}</dd>
            <dt>已记录输入</dt>
            <dd>{progress.inputCount} 条（含时钟检查）</dd>
          </dl>
          {reasons.map((reason) => (
            <p className="support-warning" key={reason}>
              {labels[reason] ?? "服务器已暂停或限制本次观察"}（{reason}）
            </p>
          ))}
          <p>
            旧机会与迟到行情不会追发。恢复会建立新证据代际，必须重新高于支撑区上沿后再回踩。
          </p>
        </>
      ) : (
        <p>
          {loading
            ? "正在读取已保存尝试…"
            : "尚无正式监测尝试。启用前仍由服务器复核会话、支撑、资金与授权。"}
        </p>
      )}
      <div className="monitor-actions">
        {(!progress || controls.historicalOnly) && !plan.attemptId && (
          <button
            type="button"
            className="button primary full"
            disabled={blocked || !controls.canActivate}
            onClick={() => setConfirmation("activate")}
          >
            {actionLabel("activate")}
          </button>
        )}
        {((progress && !controls.historicalOnly) || plan.attemptId) && (
          <button
            type="button"
            className="button primary full"
            disabled={blocked || !controls.canRecover}
            onClick={() => setConfirmation("recover")}
          >
            {actionLabels.recover}
          </button>
        )}
        {controls.canPause && (
          <button
            type="button"
            className="button secondary full"
            disabled={blocked}
            onClick={() => setConfirmation("pause")}
          >
            {actionLabels.pause}
          </button>
        )}
      </div>
      {confirmation && (
        <div
          className="monitor-confirmation"
          role="group"
          aria-label="确认正式监测操作"
        >
          <h4>{actionLabel(confirmation)}</h4>
          <p>
            将操作已保存版本 v{plan.version}，
            {plan.attemptId ? `当前尝试 ${plan.attemptId}` : "当前尚无尝试"}。
          </p>
          <p>
            {confirmation === "recover"
              ? `来源为 v${progress?.planVersion}，已处理水位 ${time(progress?.watermark)}。旧机会不会追发；恢复不代表会话首次，必须重新高于支撑区上沿后再回踩。`
              : confirmation === "pause"
                ? "暂停后不会自动重启；需要核对水位并显式新建恢复尝试。"
                : plan.mode === "INTRABAR_CROSS"
                  ? "按你的选择启用盘中穿越，必须有连续逐笔证据。盘中触发可能在收盘前回落；只保留真实发生的判断，不追发旧机会。"
                  : "仅启用收盘确认。开盘后缺少此前未触碰的完整证据会被拒绝，不会补发过去机会。"}
          </p>
          <div className="monitor-actions">
            <button
              type="button"
              className="button primary full"
              disabled={blocked || !allowed(confirmation)}
              onClick={() => void command(confirmation)}
            >
              {pending ? "正在提交…" : "确认并提交"}
            </button>
            <button
              type="button"
              className="button secondary full"
              disabled={pending}
              onClick={() => setConfirmation(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
