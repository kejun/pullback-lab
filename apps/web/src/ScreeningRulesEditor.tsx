import { useState } from "react";
import type {
  ScreeningParameters,
  ScreeningSettings,
} from "../../../packages/contracts/index";
import { api, ApiError } from "./api";

function confirmation(settings: ScreeningSettings): string {
  if (!settings.current) return "尚未确认，当前显示工程测试预设";
  return settings.current.confirmedAt === null
    ? "旧版已确认，确认时间未记录"
    : `确认于 ${new Date(settings.current.confirmedAt).toLocaleString("zh-CN", { hour12: false })}`;
}

export function ScreeningRulesEditor({
  initial,
  onChanged,
  onSaved,
}: {
  initial: ScreeningSettings;
  onChanged: () => Promise<void>;
  onSaved: (value: ScreeningSettings) => void;
}) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<ScreeningParameters>(() =>
    structuredClone(initial.current?.parameters ?? initial.defaultParameters),
  );
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<ScreeningSettings | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  function edit(change: Partial<ScreeningParameters>) {
    setDraft((d) => ({ ...d, ...change }));
    setConfirmed(false);
    setMessage("");
  }
  async function readLatest() {
    setBusy(true);
    try {
      const value = await api<ScreeningSettings>("/settings/screening");
      setSaved(value);
      onSaved(value);
      setLatest(value);
      setConflict(false);
      setConfirmed(false);
      setError(null);
      setMessage(
        "已读取最新规则。当前参数输入已保留，请核对差异并重新确认，再保存新版本。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const value = await api<ScreeningSettings>(
        "/settings/screening",
        "POST",
        { expectedVersion: saved.version, confirmed: true, parameters: draft },
      );
      setSaved(value);
      onSaved(value);
      setDraft(structuredClone(value.current!.parameters));
      setConfirmed(false);
      setLatest(null);
      setMessage(`筛选规则第 ${value.version} 版已保存。`);
      try {
        await onChanged();
      } catch {
        setError(
          `第 ${value.version} 版规则已保存，但候选结果刷新失败。候选页仍显示上次结果，请刷新重试。`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试。");
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        setConfirmed(false);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="settings-section screening-editor"
      aria-label="C 类筛选参数"
    >
      <div className="section-heading">
        <h3>C 类筛选参数</h3>
        <span className="badge">
          {saved.version ? `当前第 ${saved.version} 版` : "待确认"}
        </span>
      </div>
      <p className="settings-intro">
        {confirmation(saved)}
        。这些阈值是可调整的工程测试参数，不代表已经验证的盈利参数。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="field-pair">
          {(["US", "CN"] as const).map((m) => (
            <label className="field" key={m}>
              <span>
                {m === "US"
                  ? "美股 ADV20 下限（USD）"
                  : "A 股 ADV20 下限（CNY）"}
              </span>
              <input
                inputMode="decimal"
                required
                value={draft.minimumAdv20[m]}
                disabled={busy}
                onChange={(e) =>
                  edit({
                    minimumAdv20: {
                      ...draft.minimumAdv20,
                      [m]: e.target.value,
                    },
                  })
                }
              />
              <small>20 个已完成交易日的日均成交额</small>
            </label>
          ))}
        </div>
        <div className="field-pair">
          <label className="field">
            <span>ADR20 下限（%）</span>
            <input
              inputMode="decimal"
              required
              value={draft.adrMinPct}
              disabled={busy}
              onChange={(e) => edit({ adrMinPct: e.target.value })}
            />
          </label>
          <label className="field">
            <span>ADR20 上限（%）</span>
            <input
              inputMode="decimal"
              required
              value={draft.adrMaxPct}
              disabled={busy}
              onChange={(e) => edit({ adrMaxPct: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>每个市场最多入选数量</span>
          <input
            type="number"
            min={1}
            max={30}
            step={1}
            required
            value={draft.limitPerMarket || ""}
            disabled={busy}
            onChange={(e) => edit({ limitPerMarket: Number(e.target.value) })}
          />
          <small>
            1 至 30
            只；该数量限制用于筛选排序，独立于研究池与观察计划的容量限制。
          </small>
        </label>
        <div className="source-note">
          <strong>固定算法规则 · screening-v1</strong>
          <p>
            采用 EMA 9/21/50、30 日动量、成交额及 ADR20。排序依次比较 R30、R3、3
            日紧密度、成交额与代码。这些公式与排序规则不随本表单改变。
          </p>
          <p>保存后重新计算当前候选；已保存计划和历史事件保留原规则版本。</p>
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
            aria-label="筛选规则版本冲突复核"
          >
            <div>
              <strong>筛选规则已有新版本，输入已保留</strong>
              <p>请读取最新规则并核对后，再保存自己的参数。</p>
            </div>
            <button
              type="button"
              className="button secondary compact"
              disabled={busy}
              onClick={() => void readLatest()}
            >
              读取最新筛选规则，保留输入
            </button>
          </div>
        )}
        {latest?.current && (
          <div className="source-note">
            <strong>服务端第 {latest.version} 版参数</strong>
            <p>
              ADV20：US {latest.current.parameters.minimumAdv20.US} USD / CN{" "}
              {latest.current.parameters.minimumAdv20.CN} CNY
            </p>
            <p>
              ADR20：{latest.current.parameters.adrMinPct}% 至{" "}
              {latest.current.parameters.adrMaxPct}% · 每市场{" "}
              {latest.current.parameters.limitPerMarket} 只
            </p>
          </div>
        )}
        {message && (
          <p role="status" className="callout">
            {message}
          </p>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || conflict}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>我已核对这些工程筛选参数，并确认保存为新版本</span>
        </label>
        <button
          className="button primary full"
          disabled={busy || conflict || !confirmed}
        >
          {busy ? "正在保存…" : "确认保存筛选规则"}
        </button>
      </form>
    </section>
  );
}
