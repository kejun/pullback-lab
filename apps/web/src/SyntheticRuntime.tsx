import { useEffect, useRef, useState } from "react";
import type { Plan } from "../../../packages/contracts/index";
import type { RuntimeProgress } from "../../server/attempt-runtime";
import { api, ApiError } from "./api";

const phaseLabels: Record<RuntimeProgress["phase"], string> = {
  READY: "准备就绪",
  RUNNING: "分步演练中",
  COMPLETE: "合成序列已完成",
  RECOVERY_PAUSED: "重启后已暂停",
  DATA_PAUSED: "依据变化，已暂停",
};
const stateLabels: Record<string, string> = {
  WAIT_RETEST: "等待首次回踩",
  ARMED: "已确认回踩",
  ENTRY_TRIGGERED: "条件已触发",
  TRIGGERED: "条件已触发",
  INVALID: "计划失效",
  EXPIRED: "窗口到期",
  DATA_PAUSED: "数据暂停",
  USER_PAUSED: "本次判断已暂停",
  TAKEN: "已记录交易",
  SKIPPED: "已记录跳过",
};
function reasonText(reason: string) {
  const labels: Record<string, string> = {
    HISTORICAL_ONLY:
      "本次仅记录合成历史条件，观察尝试已消费。可继续处理后续合成输入。",
    USER_PAUSED: "本次观察由用户暂停。",
    RUNTIME_RESTARTED: "服务已重启，原演练保持暂停，需核对后建立新尝试。",
    PLAN_NO_LONGER_ACTIVE: "计划已暂停或不再属于当前观察尝试。",
    ATTEMPT_DEADLINE: "本次观察窗口已结束。",
    REFERENCE_REVISION_CHANGED: "参考行情发生修订，已停止沿用原判断。",
    PLAN_VERSION_CHANGED: "计划版本已变化，需重新确认。",
    DUPLICATE_INPUT_CONFLICT: "同一输入出现冲突内容，演练已暂停。",
    STOP_REFERENCE_TOUCHED: "价格触及止损参考，本次计划失效。",
    TOUCH_BAR_CLOSED_BELOW_SUPPORT: "回踩收盘低于支撑下沿，本次计划失效。",
  };
  return labels[reason] ?? `演练已按数据或检查条件暂停（${reason}）。`;
}
export function SyntheticRuntime({
  plan,
  disabled,
  onChanged,
  onBusyChange,
}: {
  plan: Plan;
  disabled: boolean;
  onChanged: () => Promise<void>;
  onBusyChange: (value: boolean) => void;
}) {
  const [runtime, setRuntime] = useState<RuntimeProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const active = useRef(true);
  const loadSequence = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const requested = ++loadSequence.current;
    let current = true;
    setLoading(true);
    setError(null);
    api<{ runtime: RuntimeProgress | null }>(
      `/demo/plans/${encodeURIComponent(plan.id)}/runtime`,
    )
      .then((result) => {
        if (!current || requested !== loadSequence.current) return;
        setRuntime(result.runtime);
        setConflict(false);
      })
      .catch((cause: Error) => {
        if (current) setError(cause.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [plan.id, plan.version, plan.attemptId, reload]);

  async function reloadProgress() {
    setLoading(true);
    setError(null);
    try {
      await onChanged();
      if (active.current) setReload((value) => value + 1);
    } catch (cause) {
      if (active.current) {
        setError(
          cause instanceof Error ? cause.message : "最新演练状态暂时无法读取。",
        );
        setLoading(false);
      }
    }
  }
  async function command(kind: "start" | "step") {
    if (!plan.attemptId || disabled || pending || loading || conflict) return;
    setPending(true);
    onBusyChange(true);
    setError(null);
    const requested = ++loadSequence.current;
    try {
      const result = await api<{ runtime: RuntimeProgress }>(
        `/demo/plans/${encodeURIComponent(plan.id)}/runtime/${kind}`,
        "POST",
        {
          expectedVersion: plan.version,
          expectedAttemptId: plan.attemptId,
          ...(kind === "step" ? { expectedStep: runtime?.step, count: 1 } : {}),
        },
      );
      if (active.current && requested === loadSequence.current)
        setRuntime(result.runtime);
      await onChanged();
    } catch (cause) {
      if (!active.current) return;
      setError(
        cause instanceof Error ? cause.message : "演练操作暂时无法完成。",
      );
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
    } finally {
      onBusyChange(false);
      if (active.current) setPending(false);
    }
  }
  const canStart = Boolean(
    plan.attemptId && ["WAIT_RETEST", "ARMED"].includes(plan.status),
  );
  const canStep = runtime && ["READY", "RUNNING"].includes(runtime.phase);
  return (
    <section
      className="synthetic-runtime"
      aria-label="分步合成演练"
      aria-busy={loading || pending}
    >
      <div className="section-heading">
        <h3>分步合成演练</h3>
        <button
          type="button"
          className="text-button"
          disabled={pending || loading}
          onClick={() => void reloadProgress()}
        >
          读取最新演练进度
        </button>
      </div>
      <p>
        逐条推进已保存的合成行情，查看回踩、突破与后续事件。进度由服务端保存。
      </p>
      {error && (
        <p className="support-warning" role="alert">
          {error}
          {conflict ? " 请先读取最新演练进度；操作未自动重试。" : ""}
        </p>
      )}
      {runtime ? (
        <>
          <div className="section-heading">
            <strong>{phaseLabels[runtime.phase]}</strong>
            <span>
              {runtime.step} / {runtime.totalSteps} 条
            </span>
          </div>
          <progress
            aria-label="合成演练进度"
            value={runtime.step}
            max={runtime.totalSteps || 1}
          />
          <dl className="detail-list">
            <dt>判断状态</dt>
            <dd>
              {runtime.reason === "HISTORICAL_ONLY"
                ? "合成历史判断已完成"
                : (stateLabels[runtime.status] ?? runtime.status)}
            </dd>
            <dt>已记录输入</dt>
            <dd>{runtime.inputCount} 条（含时钟检查）</dd>
            <dt>下一个输入</dt>
            <dd>
              {runtime.nextInput
                ? `${runtime.nextInput.type} · ${new Date(runtime.nextInput.receivedAt).toISOString().slice(11, 19)} UTC`
                : "无"}
            </dd>
          </dl>
          {runtime.reason && (
            <p className="support-warning">{reasonText(runtime.reason)}</p>
          )}
          {runtime.eventTypes.length > 0 && (
            <small>
              已保存 {runtime.eventTypes.length}{" "}
              条事件，可在「提醒与记录」查看。
            </small>
          )}
          {canStep ? (
            <button
              type="button"
              className="button secondary full"
              disabled={disabled || pending || loading || conflict}
              onClick={() => void command("step")}
            >
              推进下一条合成行情
            </button>
          ) : (
            <small>
              {runtime.phase === "COMPLETE"
                ? "合成序列已处理完毕，不代表真实成交。"
                : "本次演练已暂停。核对计划与资金后，可显式启用新的观察尝试。"}
            </small>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            className="button secondary full"
            disabled={disabled || pending || loading || conflict || !canStart}
            onClick={() => void command("start")}
          >
            准备分步合成演练
          </button>
          {!canStart && (
            <small>先保存计划并启用合成计划观察，再准备分步演练。</small>
          )}
        </>
      )}
    </section>
  );
}
