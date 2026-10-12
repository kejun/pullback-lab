import { useCallback, useEffect, useRef, useState } from "react";
import type { OperationsStatus as OperationsStatusReport } from "../../../packages/contracts/operations";
import { api, ApiError } from "./api";

const workerLabels = {
  DISABLED: "未启用",
  IDLE: "等待采样",
  POLLING: "正在采样",
  BACKOFF: "退避等待",
  STOPPED: "已停止",
  UNKNOWN: "未知",
};

function when(value: number | null) {
  return value === null
    ? "无记录"
    : `${new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" })} UTC`;
}

function bytes(value: number) {
  return `${(value / 1024 ** 3).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GiB`;
}

export function OperationsStatus() {
  const [report, setReport] = useState<OperationsStatusReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(null);
    try {
      const next = await api<OperationsStatusReport>(
        "/operations/status",
        "GET",
        undefined,
        { signal: nextController.signal },
      );
      if (current === request.current && !nextController.signal.aborted)
        setReport(next);
    } catch (failure) {
      if (current === request.current && !nextController.signal.aborted)
        setError(
          failure instanceof ApiError
            ? `运行状态暂不可读（HTTP ${failure.status}）。`
            : "运行状态暂不可读，请检查连接后重试。",
        );
    } finally {
      if (current === request.current && !nextController.signal.aborted)
        setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
      controller.current?.abort();
    };
  }, [refresh]);

  function downloadReport() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(report, null, 2)}\n`], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pullback-status-${new Date(report.capturedAt).toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section
      className="settings-section operations-status"
      aria-label="运行诊断"
      aria-busy={loading}
    >
      <div className="section-heading">
        <h3>运行状态</h3>
        <button
          type="button"
          className="text-button"
          aria-label="刷新运行状态"
          onClick={() => void refresh()}
        >
          {loading ? "正在读取…" : "刷新状态"}
        </button>
      </div>
      <p className="operations-message" role="status" aria-label="运行诊断状态">
        {error
          ? `${error}${report ? "已保留上次报告，采集时间未更新。" : "尚无可用报告。"}`
          : loading
            ? report
              ? "正在刷新，以下为上次报告。"
              : "正在读取运行状态…"
            : "已读取运行状态。"}
      </p>
      {report && (
        <>
          <p className="operations-captured">
            报告采集时间：
            <time dateTime={new Date(report.capturedAt).toISOString()}>
              {when(report.capturedAt)}
            </time>
          </p>
          <dl className="detail-list operations-summary">
            <dt>服务响应</dt>
            <dd>报告采集时可访问</dd>
            <dt>真实行情能力</dt>
            <dd>美股：未知 · A 股：未知</dd>
            <dt>磁盘可用 / 总量</dt>
            <dd>
              {report.disk
                ? `${bytes(report.disk.availableBytes)} / ${bytes(report.disk.totalBytes)}`
                : "未知"}
            </dd>
            <dt>资金快照</dt>
            <dd>
              {!report.funds.present
                ? "尚未确认"
                : report.funds.stale === false
                  ? `第 ${report.funds.generation} 次确认 · 已确认`
                  : report.funds.stale === true
                    ? `第 ${report.funds.generation} 次确认 · 待重新确认`
                    : "确认状态未知"}
            </dd>
            <dt>活动计划 / 全部计划</dt>
            <dd>
              {report.counts.activePlans} / {report.counts.plans}
            </dd>
            <dt>占用 / 已交易待确认</dt>
            <dd>
              {report.counts.activeReservations} /{" "}
              {report.counts.takenPendingReservations}
            </dd>
            <dt>待反馈 / 未读事件</dt>
            <dd>
              {report.counts.pendingFeedback} / {report.counts.unreadEvents}
            </dd>
            <dt>日线采样</dt>
            <dd>{workerLabels[report.worker.state]}</dd>
            <dt>最近采样成功</dt>
            <dd>{when(report.worker.lastSuccessAt)}</dd>
            <dt>隔离样本</dt>
            <dd>{report.worker.quarantinedCount ?? "未知"}</dd>
            <dt>时钟同步</dt>
            <dd>未知 · 尚未独立验证</dd>
          </dl>
          <p className="settings-intro operations-note">
            服务响应和采样成功均不代表真实行情能力已验证。此报告只显示汇总状态，不含资金金额、标的或访问凭据。
          </p>
          <details className="snapshot-details operations-details">
            <summary>运行环境与访问配置</summary>
            <dl className="detail-list">
              <dt>Node / SQLite</dt>
              <dd>
                {report.runtime.nodeVersion} / {report.runtime.sqliteVersion}
              </dd>
              <dt>数据库结构版本</dt>
              <dd>{report.runtime.schemaVersion}</dd>
              <dt>日志 / 同步模式</dt>
              <dd>
                {report.runtime.journalMode} / {report.runtime.synchronous}
              </dd>
              <dt>安全 Cookie</dt>
              <dd>
                {report.security.secureCookiesConfigured ? "已配置" : "未配置"}
              </dd>
              <dt>访问来源限制</dt>
              <dd>{report.security.originConfigured ? "已配置" : "未配置"}</dd>
              <dt>公网 TLS</dt>
              <dd>未知 · 需在部署环境验证</dd>
            </dl>
          </details>
          <button
            type="button"
            className="button secondary full"
            onClick={downloadReport}
          >
            下载脱敏运行报告
          </button>
        </>
      )}
    </section>
  );
}
