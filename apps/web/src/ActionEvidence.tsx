import { useEffect, useState } from "react";
import type {
  EvidenceAction,
  EvidenceDetail,
  EvidenceDocument,
  EvidenceDocumentContent,
  EvidenceHistory,
  EvidenceVersion,
} from "../../../packages/contracts/action-evidence";
import { api } from "./api";

const time = (at: number) =>
  new Date(at).toLocaleString("zh-CN", { hour12: false });
const short = (version: string) => version.split(":")[1].slice(0, 12);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "读取失败，请重试";
const coverage = (v: EvidenceVersion) =>
  `${v.coverage.status === "COMPLETE" ? "完整覆盖声明" : "覆盖待核验"} · ${time(v.coverage.from)} — ${time(v.coverage.through)} · ${v.coverage.reason} · 依据 ${v.coverage.documentIds.join("、")}`;
const actionText = (a: EvidenceAction | null) =>
  a
    ? `${a.kind === "SPLIT" ? `拆并股 ${a.sharesAfter}:${a.sharesBefore}（新:旧）` : "现金分红（不作拆股复权）"} · 修订 ${a.revision} · 生效 ${time(a.effectiveAt)} · 发布 ${time(a.publishedAt)} · 依据 ${a.documentIds.join("、")}`
    : "无";
const documentText = (d: EvidenceDocument | null) =>
  d
    ? `${d.url} · 发布 ${time(d.publishedAt)} · ${d.bytes} 字节 · SHA256 ${d.sha256}`
    : "无";

export function ActionEvidence({ instrumentId }: { instrumentId: string }) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  return (
    <section className="panel action-evidence" aria-label="公司行动证据">
      <div className="section-heading">
        <div>
          <h3>公司行动证据</h3>
          <small>覆盖声明、来源原文与不可变收录历史</small>
        </div>
        <button
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起证据" : "查看证据"}
        </button>
      </div>
      {open && (
        <>
          <div className="evidence-notice">
            资料收录不代表真实行情已验证。完整覆盖由人工声明；查看历史不会修改图表口径、计划或资金。
          </div>
          <button
            className="text-button"
            onClick={() => setRefresh((v) => v + 1)}
          >
            重新读取证据
          </button>
          <EvidenceBrowser
            key={`${instrumentId}:${refresh}`}
            instrumentId={instrumentId}
          />
        </>
      )}
    </section>
  );
}

function EvidenceBrowser({ instrumentId }: { instrumentId: string }) {
  const base = `/instruments/${encodeURIComponent(instrumentId)}/action-evidence`;
  const [versions, setVersions] = useState<EvidenceVersion[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<EvidenceHistory>(
      `${base}${before === null ? "" : `?before=${before}`}`,
      "GET",
      undefined,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setVersions((old) =>
          before === null ? result.versions : [...old, ...result.versions],
        );
        setNext(result.nextBefore);
        if (before === null) setSelected(result.versions[0]?.version ?? "");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, before, retry]);
  return (
    <div className="evidence-browser">
      {loading && <p role="status">正在读取证据历史…</p>}
      {error && (
        <div role="alert">
          {error}{" "}
          <button
            className="text-button"
            onClick={() => setRetry((v) => v + 1)}
          >
            重试历史读取
          </button>
        </div>
      )}
      {!loading && !error && versions.length === 0 && (
        <p>
          尚未收录公司行动证据。没有记录不等于确认无公司行动；请先由维护者核验来源并导入资料。
        </p>
      )}
      {versions.length > 0 && (
        <>
          <label className="evidence-version-label">
            收录版本
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  收录 #{v.sequence} · {time(v.recordedAt)} · {short(v.version)}
                </option>
              ))}
            </select>
          </label>
          {next !== null && (
            <button
              className="text-button"
              disabled={loading || Boolean(error)}
              onClick={() => setBefore(next)}
            >
              读取更早版本
            </button>
          )}
          {selected && (
            <VersionDetail key={selected} base={base} version={selected} />
          )}
        </>
      )}
    </div>
  );
}

function VersionDetail({ base, version }: { base: string; version: string }) {
  const [detail, setDetail] = useState<EvidenceDetail | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const path = `${base}/${encodeURIComponent(version)}`;
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<EvidenceDetail>(path, "GET", undefined, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [path, retry]);
  if (error)
    return (
      <div role="alert">
        {error}{" "}
        <button className="text-button" onClick={() => setRetry((v) => v + 1)}>
          重试版本读取
        </button>
      </div>
    );
  if (!detail) return <p role="status">正在读取版本详情…</p>;
  const c = detail.comparison;
  return (
    <div className="evidence-version" aria-label="证据版本详情">
      <div className="evidence-state">
        {detail.version === detail.currentVersion
          ? "读取时的最新收录"
          : "历史收录 · 仅供查阅"}{" "}
        · {short(detail.version)}
      </div>
      <dl className="evidence-facts">
        <div>
          <dt>资料来源</dt>
          <dd>{detail.source}</dd>
        </div>
        <div>
          <dt>收录时间</dt>
          <dd>{time(detail.recordedAt)}</dd>
        </div>
        <div>
          <dt>人工核验记录</dt>
          <dd>{detail.review.reviewer} · 已确认来源声明</dd>
        </div>
        <div>
          <dt>覆盖范围</dt>
          <dd>{coverage(detail)}</dd>
        </div>
      </dl>
      <h4>公司行动 · {detail.actions.length} 项</h4>
      {detail.actions.length === 0 ? (
        <p>本版本未列出公司行动。是否完整仍取决于覆盖声明与来源核验。</p>
      ) : (
        <ul className="evidence-items">
          {detail.actions.map((a) => (
            <li key={a.id}>
              <strong>{a.id}</strong>
              <p>{actionText(a)}</p>
            </li>
          ))}
        </ul>
      )}
      <h4>来源资料 · {detail.documents.length} 份</h4>
      <ul className="evidence-items">
        {detail.documents.map((d) => (
          <li key={d.id}>
            <div className="evidence-document-heading">
              <strong>{d.id}</strong>
              <span>
                <a href={d.url} target="_blank" rel="noopener noreferrer">
                  来源页面 ↗
                </a>
                {" · "}
                <button
                  className="text-button"
                  aria-expanded={documentId === d.id}
                  onClick={() =>
                    setDocumentId((old) => (old === d.id ? null : d.id))
                  }
                >
                  {documentId === d.id ? "收起原文" : `查看原文 ${d.id}`}
                </button>
              </span>
            </div>
            <p>
              发布 {time(d.publishedAt)} · {d.bytes.toLocaleString()} 字节
            </p>
            <details>
              <summary>核对来源地址与摘要</summary>
              <p>{d.url}</p>
              <code>{d.sha256}</code>
              <p>摘要用于核对内容一致性，不证明来源权威性。</p>
            </details>
            {documentId === d.id && (
              <DocumentContent
                key={d.id}
                path={`${path}/documents/${encodeURIComponent(d.id)}`}
              />
            )}
          </li>
        ))}
      </ul>
      <details className="evidence-comparison">
        <summary>与前一收录版本比较</summary>
        {!c ? (
          <p>这是该标的的首次收录，没有更早版本。</p>
        ) : (
          <>
            <p>
              收录 #{c.previous.sequence}（{time(c.previous.recordedAt)} ·{" "}
              {short(c.previous.version)}） → 当前所选收录 #{detail.sequence}
            </p>
            {c.sourceChanged && (
              <Change
                label="来源"
                before={c.previous.source}
                after={detail.source}
              />
            )}
            {c.coverageChanged && (
              <Change
                label="覆盖声明"
                before={coverage(c.previous)}
                after={coverage(detail)}
              />
            )}
            {c.reviewChanged && (
              <Change
                label="核验人"
                before={c.previous.review.reviewer}
                after={detail.review.reviewer}
              />
            )}
            {c.actions.map((a) => (
              <Change
                key={`a:${a.id}`}
                label={`公司行动 ${a.id} · ${!a.before ? "新增" : !a.after ? "移除" : "修订"}`}
                before={actionText(a.before)}
                after={actionText(a.after)}
              />
            ))}
            {c.documents.map((d) => (
              <Change
                key={`d:${d.id}`}
                label={`来源资料 ${d.id} · ${!d.before ? "新增" : !d.after ? "移除" : "变更"}`}
                before={documentText(d.before)}
                after={documentText(d.after)}
              />
            ))}
            {!c.sourceChanged &&
              !c.coverageChanged &&
              !c.reviewChanged &&
              c.actions.length === 0 &&
              c.documents.length === 0 && (
                <p>来源、覆盖、核验人、公司行动和资料内容均无变化。</p>
              )}
          </>
        )}
      </details>
    </div>
  );
}

function Change({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}) {
  return (
    <div className="evidence-change">
      <strong>{label}</strong>
      <dl>
        <div>
          <dt>之前</dt>
          <dd>{before}</dd>
        </div>
        <div>
          <dt>之后</dt>
          <dd>{after}</dd>
        </div>
      </dl>
    </div>
  );
}

function DocumentContent({ path }: { path: string }) {
  const [data, setData] = useState<EvidenceDocumentContent | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<EvidenceDocumentContent>(path, "GET", undefined, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => controller.abort();
  }, [path, retry]);
  if (error)
    return (
      <div role="alert">
        {error}{" "}
        <button className="text-button" onClick={() => setRetry((v) => v + 1)}>
          重试原文读取
        </button>
      </div>
    );
  return data ? (
    <pre
      className="evidence-source"
      aria-label={`已存原文 ${data.id}`}
      tabIndex={0}
    >
      {data.content}
    </pre>
  ) : (
    <p role="status">正在读取已存原文…</p>
  );
}
