import { useId, useMemo, useState } from "react";
import type { Instrument, Market } from "../../../packages/contracts/index";
import { api, ApiError } from "./api";
import { previewUniverseImport } from "./universe-preview";
import { normalizeUniverseSymbol } from "../../../packages/domain/universe-symbol";

import type {
  UniverseSnapshot as UniverseView,
  UniverseImportResult as ImportResult,
} from "../../../packages/contracts/universe";

export function UniverseImport({
  mode,
  initialMarket,
  universe,
  onChanged,
  onClose,
}: {
  mode: "single" | "batch";
  initialMarket: Market;
  universe: UniverseView;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [market, setMarket] = useState(initialMarket);
  const [source, setSource] = useState("");
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [baseline, setBaseline] = useState(universe);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [rowErrors, setRowErrors] = useState<{ row: number; error: string }[]>(
    [],
  );
  const existing = useMemo(
    () =>
      new Set(
        baseline.rows.map(
          ({ instrument }) =>
            `${instrument.market}:${(() => {
              try {
                return normalizeUniverseSymbol(
                  instrument.symbol,
                  instrument.market,
                );
              } catch {
                return instrument.symbol;
              }
            })()}`,
        ),
      ),
    [baseline],
  );
  const preview = useMemo(
    () => previewUniverseImport(source, market, existing),
    [source, market, existing],
  );
  const invalid =
    preview.some((row) => row.status === "error") || preview.length > 100;
  const changed = () => {
    setResult(null);
    setError(null);
    setRowErrors([]);
    setMessage("");
  };
  async function readLatest() {
    setBusy(true);
    try {
      setBaseline(await api<UniverseView>("/universe"));
      setConflict(false);
      setError(null);
      setMessage("已读取最新列表并重新预览；输入仍然保留，请核对后再次提交。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setBusy(true);
    setError(null);
    setRowErrors([]);
    setMessage("");
    try {
      if (mode === "batch") {
        const saved = await api<ImportResult>("/universe/import", "POST", {
          rows: preview.map((row) => row.value),
          expectedRevision: baseline.universeRevision,
        });
        setResult(saved);
        setMessage(
          `导入完成：新增 ${saved.imported} 只，已有 ${saved.existing} 只，重复 ${saved.duplicates} 行。`,
        );
      } else {
        await api("/universe", "POST", {
          symbol: symbol.trim(),
          market,
          ...(name.trim() ? { name: name.trim() } : {}),
          expectedRevision: baseline.universeRevision,
        });
        setSymbol("");
        setName("");
        setMessage("已加入人工观察列表。");
      }
      // The mutation has completed even if refreshing the view fails.
      try {
        const latest = await api<UniverseView>("/universe");
        setBaseline(latest);
        await onChanged();
      } catch {
        setError("保存已成功，但列表刷新失败。请刷新查看结果。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交未完成，请重试。");
      if (e instanceof ApiError) {
        if (e.code === "UNIVERSE_VERSION_CONFLICT") setConflict(true);
        const details = e.details?.results;
        if (Array.isArray(details))
          setRowErrors(
            details.filter(
              (r): r is { row: number; error: string } =>
                typeof r?.row === "number" && typeof r?.error === "string",
            ),
          );
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel universe-import"
      aria-label={mode === "batch" ? "批量导入观察标的" : "添加观察标的"}
    >
      <div className="section-heading">
        <h3>{mode === "batch" ? "批量导入观察标的" : "添加观察标的"}</h3>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={onClose}
        >
          收起
        </button>
      </div>
      <p className="settings-intro">
        导入只建立人工观察身份，算法会独立显示通过、未通过或数据待确认。重复标的保留原有名称、标签与笔记。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field-pair">
          <label className="field">
            <span>{mode === "batch" ? "默认市场" : "市场"}</span>
            <select
              value={market}
              disabled={busy}
              onChange={(e) => {
                setMarket(e.target.value as Market);
                changed();
              }}
            >
              <option value="US">美股</option>
              <option value="CN">A 股</option>
            </select>
          </label>
          {mode === "single" ? (
            <label className="field">
              <span>完整证券代码</span>
              <input
                required
                value={symbol}
                disabled={busy}
                onChange={(e) => {
                  setSymbol(e.target.value);
                  changed();
                }}
                placeholder={market === "US" ? "AAPL.US" : "600519.SH"}
              />
            </label>
          ) : (
            <div className="import-capacity">
              <strong>
                本地研究余量{" "}
                {Math.max(
                  0,
                  baseline.limits.effectiveResearchMax -
                    baseline.limits.researchUsed,
                )}{" "}
                / {baseline.limits.effectiveResearchMax}
              </strong>
              <small>供应商额度尚未验证，未知不代表还有余额。</small>
            </div>
          )}
        </div>
        {mode === "single" ? (
          <label className="field">
            <span>名称（可选）</span>
            <input
              value={name}
              disabled={busy}
              onChange={(e) => {
                setName(e.target.value);
                changed();
              }}
              placeholder="便于辨认的名称"
              maxLength={100}
            />
          </label>
        ) : (
          <>
            <label className="field">
              <span>粘贴代码列表</span>
              <textarea
                rows={5}
                value={source}
                disabled={busy}
                maxLength={30000}
                onChange={(e) => {
                  setSource(e.target.value);
                  changed();
                }}
                placeholder={
                  "AAPL.US,Apple\nUS,MSFT.US,Microsoft\nCN,600519.SH,贵州茅台"
                }
              />
              <small>
                每行「代码,名称」，名称可省略。混合市场用「US 或
                CN,代码,名称」。美股可省略 .US；A 股须带 .SH 或
                .SZ。含逗号的名称请用双引号包围。每次最多 100 行。
              </small>
            </label>
            {preview.length > 0 && (
              <div className="import-preview" aria-label="导入预览">
                <p>
                  预览 {preview.length} 行 · 新增{" "}
                  {preview.filter((r) => r.status === "valid").length} · 已有{" "}
                  {preview.filter((r) => r.status === "existing").length} · 重复{" "}
                  {preview.filter((r) => r.status === "duplicate").length} ·
                  错误 {preview.filter((r) => r.status === "error").length}
                </p>
                {preview.length > 100 && (
                  <p className="danger-text">
                    超过单次 100 行，请减少后再提交。
                  </p>
                )}
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>行</th>
                        <th>市场 / 代码</th>
                        <th>预览结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row) => (
                        <tr key={row.line}>
                          <td>{row.line}</td>
                          <td>
                            {row.value
                              ? `${row.value.market} / ${row.value.symbol}`
                              : row.input}
                          </td>
                          <td
                            className={
                              row.status === "error" ? "danger-text" : ""
                            }
                          >
                            {row.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="callout danger">
            {error}
          </p>
        )}
        {rowErrors.length > 0 && (
          <ul className="reason-list">
            {rowErrors.map((row) => (
              <li key={row.row}>
                第 {preview[row.row - 1]?.line ?? row.row} 行：{row.error}
              </li>
            ))}
          </ul>
        )}
        {conflict && (
          <div
            className="callout"
            role="region"
            aria-label="观察列表版本冲突复核"
          >
            <div>
              <strong>观察列表已被其他操作更新</strong>
              <p>
                当前输入已保留。读取最新列表后重新检查重复项与可用容量，再提交。
              </p>
            </div>
            <button
              type="button"
              className="button secondary compact"
              disabled={busy}
              onClick={() => void readLatest()}
            >
              读取最新列表，保留输入
            </button>
          </div>
        )}
        {message && (
          <p role="status" className="callout">
            {message}
          </p>
        )}
        {result && (
          <details className="import-result" open>
            <summary>本次导入明细</summary>
            <ul>
              {result.results.map((row) => (
                <li key={row.row}>
                  第 {preview[row.row - 1]?.line ?? row.row} 行 · {row.symbol} ·{" "}
                  {row.status === "imported"
                    ? "已加入"
                    : row.status === "existing"
                      ? "已存在，未改动"
                      : "重复，已跳过"}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="form-buttons">
          <button
            className="button primary"
            disabled={
              busy ||
              conflict ||
              (mode === "batch" &&
                (invalid || !preview.length || result !== null))
            }
          >
            {busy
              ? "正在处理…"
              : mode === "batch"
                ? "确认导入观察列表"
                : "加入观察"}
          </button>
        </div>
      </form>
    </section>
  );
}

export function ObservationEditor({
  instrument,
  initialTags,
  initialNote,
  revision,
  onChanged,
  onDeleted,
}: {
  instrument: Instrument;
  initialTags: string[];
  initialNote: string;
  revision: string;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const fieldId = useId();
  const [tags, setTags] = useState(initialTags.join("，"));
  const [note, setNote] = useState(initialNote);
  const [baseline, setBaseline] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [latest, setLatest] = useState<UniverseView["rows"][number] | null>(
    null,
  );
  const [message, setMessage] = useState("");
  async function readLatest() {
    setBusy(true);
    try {
      const data = await api<UniverseView>("/universe");
      const row = data.rows.find((row) => row.instrument.id === instrument.id);
      setLatest(row ?? null);
      setRemoved(!row);
      setBaseline(data.universeRevision);
      setConflict(false);
      setError(null);
      setMessage(
        row
          ? "已读取最新内容，输入已保留。请核对下方内容后再次保存或移出。"
          : "此标的已移出观察列表。当前笔记输入仍然保留，可复制后重新添加标的。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }
  async function save(remove = false) {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const data = await api<{ universeRevision: string }>(
        `/universe/${instrument.id}`,
        remove ? "DELETE" : "PATCH",
        {
          expectedRevision: baseline,
          ...(remove
            ? {}
            : {
                tags: tags
                  .split(/[,，]/)
                  .map((t) => t.trim())
                  .filter(Boolean),
                note,
              }),
        },
      );
      setBaseline(data.universeRevision);
      setLatest(null);
      setMessage(remove ? "已移出观察列表。" : "主题标签和观察笔记已保存。");
      if (remove) onDeleted();
      try {
        await onChanged();
      } catch {
        setError("保存已成功，但列表刷新失败。请刷新查看结果。");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      if (e instanceof ApiError && e.code === "UNIVERSE_VERSION_CONFLICT")
        setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="observation-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field">
        <label htmlFor={`${fieldId}-tags`}>人工主题标签</label>
        <input
          id={`${fieldId}-tags`}
          aria-describedby={`${fieldId}-tags-help`}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="例如：半导体，关注财报"
        />
        <small id={`${fieldId}-tags-help`}>
          逗号分隔；主题不参与自动质量判断
        </small>
      </div>
      <div className="field">
        <label htmlFor={`${fieldId}-note`}>观察笔记</label>
        <textarea
          id={`${fieldId}-note`}
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="记录值得关注的背景与尚待确认的事项"
        />
      </div>
      {error && (
        <p role="alert" className="callout danger">
          {error}
        </p>
      )}
      {conflict && (
        <div
          className="callout"
          role="region"
          aria-label="观察笔记版本冲突复核"
        >
          <div>
            <strong>观察列表已有更新，输入已保留</strong>
            <p>读取最新内容，核对差异后再提交。</p>
          </div>
          <button
            type="button"
            className="button secondary compact"
            disabled={busy}
            onClick={() => void readLatest()}
          >
            读取最新观察内容，保留输入
          </button>
        </div>
      )}
      {latest && (
        <div className="source-note">
          <strong>服务端最新内容</strong>
          <p>标签：{latest.tags.join("，") || "无"}</p>
          <p>笔记：{latest.note || "无"}</p>
        </div>
      )}
      {message && (
        <p role="status" className="callout">
          {message}
        </p>
      )}
      <div className="form-buttons">
        <button
          className="button secondary compact"
          disabled={busy || conflict || removed}
        >
          保存观察笔记
        </button>
        <button
          type="button"
          className="text-button danger-text"
          disabled={busy || conflict || removed}
          onClick={() => {
            if (
              window.confirm(
                `将 ${instrument.symbol} 移出观察列表？已关联计划的标的不可移除。`,
              )
            )
              void save(true);
          }}
        >
          移出观察列表
        </button>
      </div>
    </form>
  );
}
