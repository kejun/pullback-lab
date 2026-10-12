import { useEffect, useState } from "react";
import { api } from "./api";
import { ProviderReceipts } from "./ProviderReceipts";

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
  minuteSymbols: string[];
  streams: Array<{
    instrumentId: string;
    symbol: string;
    period: "1D" | "1m" | "5m";
    outcome: "PENDING" | "SAMPLED" | "EMPTY" | "FAILED" | "INTERRUPTED";
    selected: boolean;
    lastAttemptAt: number;
    lastSampleCount: number;
    lastErrorCode: string | null;
    lastQuarantineReason: string | null;
  }>;
  watermarks: Array<{
    instrumentId: string;
    period: string;
    providerTimestamp: number;
  }>;
}
const periodNames = { "1D": "日线", "1m": "1 分钟", "5m": "5 分钟" };
const outcomes = {
  PENDING: "请求中",
  SAMPLED: "已收样",
  EMPTY: "空结果",
  FAILED: "失败",
  INTERRUPTED: "已中断",
};
const labels = {
  DISABLED: "未启用",
  IDLE: "等待采样",
  POLLING: "正在采样",
  BACKOFF: "退避等待",
  STOPPED: "已停止",
};
const reasons: Record<string, string> = {
  WORKER_DISABLED: "持续行情采样尚未启用。",
  CREDENTIALS_MISSING: "未配置行情访问凭据，采样保持关闭。",
  SAMPLING_ONLY_CAPABILITY_UNVERIFIED: "已配置只读采样，行情能力仍待独立验证。",
  RESEARCH_POOL_EMPTY: "研究池暂无可采集的真实标的。",
  WORKER_STOPPED: "采样进程已停止。",
  PROVIDER_REQUEST_TIMEOUT: "行情请求等待超时；原请求未结束前暂停发送新请求。",
  PROVIDER_REQUEST_UNSETTLED: "上一次行情请求仍未结束；继续等待，不叠加请求。",
  PROVIDER_REQUEST_FAILED: "行情供应商请求失败，等待退避后重试。",
  PERSISTENCE_UNAVAILABLE: "采样证据暂时无法保存，已停止继续采集。",
  FINALITY_UNVERIFIED: "K 线最终状态未经验证，已隔离样本。",
  AUDITED_EVIDENCE_REQUIRED: "仍缺少独立核验依据，样本保留在隔离区。",
  MINUTE_EVIDENCE_UNVERIFIED: "分钟样本仅归档，尚未核验正式接入依据。",
  SAMPLE_IDENTITY_OR_TIME_INVALID:
    "样本的证券、周期或时间不符合本次请求，未推进采样进度。",
  WORKER_INTERRUPTED: "上一次请求因进程中断未完成。",
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
        <strong>只读行情采样</strong>
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
            <dt>最近成功轮询</dt>
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
          <p>
            分钟采样：
            {status.minuteSymbols?.length
              ? status.minuteSymbols.join("、")
              : "未选择"}
            。仅采集已加入观察列表的标的。
          </p>
          {!!status.streams?.length && (
            <details className="snapshot-details">
              <summary>查看各周期采样进度</summary>
              <p>
                进度只表示已收到样本的最晚时间，不证明其间连续或完整。空结果不能作为无成交证明。
              </p>
              <div className="sampling-streams">
                {status.streams.map((stream) => {
                  const mark = status.watermarks.find(
                    (item) =>
                      item.instrumentId === stream.instrumentId &&
                      item.period === stream.period,
                  );
                  return (
                    <article
                      className="sampling-stream"
                      key={`${stream.instrumentId}:${stream.period}`}
                      aria-label={`${stream.symbol} ${periodNames[stream.period]}采样`}
                    >
                      <div className="section-heading">
                        <strong>
                          {stream.symbol} · {periodNames[stream.period]}
                        </strong>
                        <span className="badge neutral">
                          {outcomes[stream.outcome]}
                        </span>
                      </div>
                      {!stream.selected && (
                        <p>已移出当前采样范围，保留历史记录。</p>
                      )}
                      <dl className="detail-list">
                        <dt>本次收样</dt>
                        <dd>{stream.lastSampleCount} 条</dd>
                        <dt>最近请求</dt>
                        <dd>{when(stream.lastAttemptAt)}</dd>
                        <dt>最晚样本时间</dt>
                        <dd>{when(mark?.providerTimestamp ?? null)}</dd>
                      </dl>
                      {stream.lastErrorCode && (
                        <p className="support-warning">
                          {reasons[stream.lastErrorCode] ??
                            stream.lastErrorCode}
                        </p>
                      )}
                      {stream.lastQuarantineReason && (
                        <p className="support-warning">
                          {reasons[stream.lastQuarantineReason] ??
                            stream.lastQuarantineReason}
                        </p>
                      )}
                      <ProviderReceipts
                        instrumentId={stream.instrumentId}
                        period={stream.period}
                      />
                    </article>
                  );
                })}
              </div>
            </details>
          )}
          {status.watermarks
            .filter(
              (mark) =>
                !status.streams.some(
                  (stream) => stream.instrumentId === mark.instrumentId,
                ),
            )
            .filter(
              (mark, index, all) =>
                all.findIndex(
                  (other) => other.instrumentId === mark.instrumentId,
                ) === index,
            )
            .map((mark) => (
              <div key={mark.instrumentId} className="sampling-stream">
                <strong>{mark.instrumentId} · 旧版采样存档</strong>
                <ProviderReceipts
                  instrumentId={mark.instrumentId}
                  period="unknown"
                />
              </div>
            ))}
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
        采样只用于保存和核验历史行情证据。成功采集或等待采样均不代表权限、复权、证券规则和连续性已通过验证。
      </p>
    </section>
  );
}
