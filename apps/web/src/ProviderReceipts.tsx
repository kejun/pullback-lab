import { useEffect, useState } from "react";
import type {
  ProviderReceiptDetail,
  ProviderReceiptPage,
  ReceiptPayload,
  ReceiptScope,
} from "../../../packages/contracts/provider-receipts";
import { api } from "./api";

const names = {
  "1D": "日线",
  "1m": "1 分钟",
  "5m": "5 分钟",
  unknown: "旧版 · 请求周期未知",
};
const integrityNames = {
  MATCH: "哈希一致",
  MISMATCH: "哈希不一致",
  INVALID_JSON: "存档格式不可读",
  TOO_LARGE: "原文超过读取上限",
};
const comparisons = {
  FIRST_SEEN: "没有更早的同根回执",
  UNCHANGED: "样本内容未变",
  CHANGED: "样本内容有变化",
  UNAVAILABLE: "无法可靠比较",
};
const time = (at: number) =>
  new Date(at).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" }) +
  " UTC";
const message = (error: unknown) =>
  error instanceof Error ? error.message : "读取失败，请重试";

export function ProviderReceipts({
  instrumentId,
  period,
}: {
  instrumentId: string;
  period: ReceiptScope;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState(period);
  const [refresh, setRefresh] = useState(0);
  return (
    <section className="provider-receipts" aria-label="采样回执核验">
      <button
        className="text-button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "收起采样回执" : "查看采样回执"}
      </button>
      {open && (
        <>
          <p>
            回执是适配器保存的历史样本。哈希一致仅说明样本内容与存档摘要一致，不证明来源、闭合或连续性。
          </p>
          <label className="evidence-version-label">
            请求周期
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as ReceiptScope)}
            >
              {Object.entries(names).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {scope === "unknown" && (
            <p>
              旧版没有记录请求周期。返回周期可在原文中查看，不能据此补填请求周期。
            </p>
          )}
          <button
            className="text-button"
            onClick={() => setRefresh((v) => v + 1)}
          >
            重新读取回执
          </button>
          <ReceiptBrowser
            key={`${instrumentId}:${scope}:${refresh}`}
            instrumentId={instrumentId}
            period={scope}
          />
        </>
      )}
    </section>
  );
}

function ReceiptBrowser({
  instrumentId,
  period,
}: {
  instrumentId: string;
  period: ReceiptScope;
}) {
  const base = `/instruments/${encodeURIComponent(instrumentId)}/provider-receipts`;
  const [page, setPage] = useState<ProviderReceiptPage | null>(null);
  const [cursor, setCursor] = useState<{
    snapshot: string;
    before: number;
  } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({
      period,
      ...(cursor
        ? { snapshot: cursor.snapshot, before: String(cursor.before) }
        : {}),
    });
    void api<ProviderReceiptPage>(`${base}?${query}`, "GET", undefined, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setPage(result);
        setSelected(result.receipts[0]?.sequence ?? null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, period, cursor, retry]);
  return (
    <div className="receipt-browser" aria-busy={loading}>
      {loading && <p role="status">正在读取回执…</p>}
      {error && (
        <div role="alert">
          {error}{" "}
          <button
            className="text-button"
            onClick={() => setRetry((v) => v + 1)}
          >
            重试回执列表
          </button>
        </div>
      )}
      {page && (
        <>
          <p>本次固定收录上限 #{page.throughSequence} · 新样本需重新读取。</p>
          {page.receipts.length ? (
            <>
              <label className="evidence-version-label">
                收录回执
                <select
                  value={selected ?? ""}
                  onChange={(e) => setSelected(Number(e.target.value))}
                  disabled={loading}
                >
                  {page.receipts.map((r) => (
                    <option key={r.sequence} value={r.sequence}>
                      #{r.sequence} · {time(r.providerTimestamp)}
                    </option>
                  ))}
                </select>
              </label>
              {page.nextBefore !== null && (
                <button
                  className="text-button"
                  disabled={loading || !!error}
                  onClick={() =>
                    setCursor({
                      snapshot: page.snapshot,
                      before: page.nextBefore!,
                    })
                  }
                >
                  读取更早回执
                </button>
              )}
              {selected !== null && (
                <ReceiptDetail
                  key={selected}
                  base={base}
                  period={period}
                  snapshot={page.snapshot}
                  sequence={selected}
                />
              )}
            </>
          ) : (
            <p>该范围没有回执。空存档不能作为无成交或采样成功的证明。</p>
          )}
        </>
      )}
    </div>
  );
}

function ReceiptDetail({
  base,
  period,
  snapshot,
  sequence,
}: {
  base: string;
  period: ReceiptScope;
  snapshot: string;
  sequence: number;
}) {
  const [detail, setDetail] = useState<ProviderReceiptDetail | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<ProviderReceiptDetail>(
      `${base}/${sequence}?${new URLSearchParams({ period, snapshot })}`,
      "GET",
      undefined,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [base, period, snapshot, sequence, retry]);
  if (error)
    return (
      <div role="alert">
        {error}{" "}
        <button className="text-button" onClick={() => setRetry((v) => v + 1)}>
          重试回执详情
        </button>
      </div>
    );
  if (!detail) return <p role="status">正在核对回执…</p>;
  const r = detail.selected;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(detail, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `provider-receipt-${r.sequence}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="receipt-detail" aria-label={`回执 #${r.sequence} 详情`}>
      <div className="receipt-summary">
        <div className="section-heading">
          <strong>回执 #{r.sequence}</strong>
          <span className="badge amber">{integrityNames[r.integrity]}</span>
        </div>
        <dl className="detail-list">
          <dt>请求周期</dt>
          <dd>{names[r.requestedPeriod ?? "unknown"]}</dd>
          <dt>存档状态</dt>
          <dd>
            {r.status} · {r.reason}
          </dd>
          <dt>供应商时间</dt>
          <dd>{time(r.providerTimestamp)}</dd>
          <dt>适配器接收</dt>
          <dd>{time(r.receivedAt)}</dd>
          <dt>服务端观测</dt>
          <dd>{time(r.observedAt)}</dd>
          <dt>来源 / 批次</dt>
          <dd>
            {r.source} / {r.epoch}
          </dd>
        </dl>
        <p>收录序号和连接批次均由本服务生成，不是供应商连续性凭据。</p>
        <button className="text-button" onClick={download}>
          下载本条核验 JSON
        </button>
      </div>
      <div className="receipt-comparison">
        <strong>{comparisons[detail.comparison]}</strong>
        {detail.previous && (
          <p>
            前序 #{detail.previous.sequence} → 当前 #{r.sequence} · 前序
            {integrityNames[detail.previous.integrity]}
          </p>
        )}
        <p>
          只比较相同来源、证券、返回周期和供应商时间的最近前序；不含接收时间。变化不等于供应商确认修订。
        </p>
        {detail.changes.map((change) => (
          <div className="evidence-change" key={change.field}>
            <strong>{change.field}</strong>
            <dl>
              <div>
                <dt>之前</dt>
                <dd>{JSON.stringify(change.before)}</dd>
              </div>
              <div>
                <dt>之后</dt>
                <dd>{JSON.stringify(change.after)}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
      <Payload receipt={r} label="当前回执原文与摘要" />
      {detail.previous && (
        <Payload receipt={detail.previous} label="前序回执原文与摘要" />
      )}
    </div>
  );
}

function Payload({
  receipt: r,
  label,
}: {
  receipt: ReceiptPayload;
  label: string;
}) {
  return (
    <details className="snapshot-details receipt-payload">
      <summary>{label}</summary>
      <p>
        SHA-256 校验按收录时的字段顺序序列化，排除
        receivedAt；不覆盖回执元数据，也不是供应商签名。
      </p>
      <dl className="detail-list">
        <dt>存档摘要</dt>
        <dd>{r.payloadHash}</dd>
        <dt>本次计算</dt>
        <dd>{r.computedHash ?? "无法计算"}</dd>
        <dt>原文大小</dt>
        <dd>{r.payloadBytes} 字节</dd>
      </dl>
      {r.payloadJson === null ? (
        <p>超过 64 KiB，未读取原文；下载同样保留未读取状态。</p>
      ) : (
        <pre
          className="evidence-source"
          aria-label={`回执 #${r.sequence} 原文`}
          tabIndex={0}
        >
          {r.payloadJson}
        </pre>
      )}
    </details>
  );
}
