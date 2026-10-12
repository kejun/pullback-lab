import { useEffect, useState } from "react";
import { api } from "./api";

interface WorkerStatus {
  state: "DISABLED" | "IDLE" | "POLLING" | "BACKOFF" | "STOPPED";
  enabled: boolean;
  reason: string;
  source: string;
  connectionEpoch: string;
  liveEligible: boolean;
  providerQuotaVerified: boolean;
  continuity: string;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorCode: string | null;
  lastQuarantineReason?: string | null;
  nextPollAt: number | null;
  sampleCount: number;
  quarantinedCount: number;
  acceptedCount: number;
  duplicateCount: number;
  revisionCount: number;
  gapCount: number;
  researchCount: number;
  researchLimit: number;
}
const labels = {
  DISABLED: "未启用",
  IDLE: "等待采样",
  POLLING: "正在采样",
  BACKOFF: "退避等待",
  STOPPED: "已停止",
};
const reasons: Record<string, string> = {
  WORKER_DISABLED: "持续日线采样尚未启用。",
  CREDENTIALS_MISSING: "未配置行情访问凭据，采样保持关闭。",
  SAMPLING_ONLY_CAPABILITY_UNVERIFIED: "已配置只读采样，行情能力仍待独立验证。",
  RESEARCH_POOL_EMPTY: "研究池暂无可采集的真实标的。",
  WORKER_STOPPED: "采样进程已停止。",
  PROVIDER_REQUEST_FAILED: "行情供应商请求失败，等待退避后重试。",
  PERSISTENCE_UNAVAILABLE: "采样证据暂时无法保存，已停止继续采集。",
  FINALITY_UNVERIFIED: "K 线最终状态未经验证，已隔离样本。",
  AUDITED_EVIDENCE_REQUIRED: "仍缺少独立核验依据，样本保留在隔离区。",
  PROVIDER_SAMPLE_LIMIT: "本次供应商返回样本超过数量上限。",
};
function when(value: number | null) {
  return value == null
    ? "无记录"
    : `${new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" })} UTC`;
}
export function MarketStatus() {
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api<WorkerStatus>("/market/status")
      .then((data) => {
        if (active) setStatus(data);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [request]);
  return (
    <section
      id="market-worker-status"
      className="source-note"
      aria-label="行情采集状态"
      aria-busy={loading}
    >
      <div className="section-heading">
        <strong>只读日线采样</strong>
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => setRequest((r) => r + 1)}
        >
          {loading ? "正在读取…" : "刷新状态"}
        </button>
      </div>
      {error && (
        <p className="support-warning" role="status">
          采集状态暂不可读：{error}
        </p>
      )}
      {status && (
        <>
          <div className="section-heading">
            <span className="badge neutral">
              {labels[status.state] ?? status.state}
            </span>
            <span className="badge amber">实时观察未放行</span>
          </div>
          <p className="breakable">
            {reasons[status.reason] ??
              status.reason ??
              "采样状态不代表行情已通过验证。"}
          </p>
          <dl className="detail-list">
            <dt>最近采样成功</dt>
            <dd>{when(status.lastSuccessAt)}</dd>
            <dt>下次采样</dt>
            <dd>{when(status.nextPollAt)}</dd>
            <dt>研究池数量</dt>
            <dd>
              {status.researchCount} / {status.researchLimit}
            </dd>
            <dt>样本 / 隔离</dt>
            <dd>
              {status.sampleCount} / {status.quarantinedCount}
            </dd>
            <dt>接纳 / 重复</dt>
            <dd>
              {status.acceptedCount} / {status.duplicateCount}
            </dd>
            <dt>修订 / 缺口</dt>
            <dd>
              {status.revisionCount} / {status.gapCount}
            </dd>
            <dt>连续性证明</dt>
            <dd>
              {status.continuity === "UNVERIFIED"
                ? "未验证"
                : status.continuity}
            </dd>
            <dt>供应商配额</dt>
            <dd>{status.providerQuotaVerified ? "已验证" : "未验证"}</dd>
          </dl>
          {status.lastErrorCode && (
            <p className="support-warning">
              最近失败：{reasons[status.lastErrorCode] ?? status.lastErrorCode}{" "}
              · {when(status.lastFailureAt)}
            </p>
          )}
          {status.lastQuarantineReason && (
            <p className="support-warning">
              最近隔离原因：
              {reasons[status.lastQuarantineReason] ??
                status.lastQuarantineReason}
            </p>
          )}
          <details className="snapshot-details">
            <summary>查看采样来源</summary>
            <p className="breakable">{status.source || "未配置"}</p>
            <code className="breakable">
              {status.connectionEpoch || "尚未开始"}
            </code>
          </details>
        </>
      )}
      <p>
        采样只用于保存和核验日线证据。成功采集或等待采样均不代表权限、复权、证券规则和连续性已通过验证。
      </p>
    </section>
  );
}
