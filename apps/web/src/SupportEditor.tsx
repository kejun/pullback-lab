import type {
  PlanInput,
  SupportSelection,
  SupportSnapshot,
} from "../../../packages/contracts/index";

const sources = ["EMA9", "EMA21", "EMA50", "AVWAP"] as const;
const labels = {
  EMA9: "EMA 9",
  EMA21: "EMA 21",
  EMA50: "EMA 50",
  AVWAP: "锚定均价 AVWAP",
};
const familyLabel: Record<string, string> = {
  EMA: "均线",
  AVWAP: "锚定均价",
  HORIZONTAL: "水平线",
};

function decimalLabel(value: string | null): string {
  if (value == null) return "不可用";
  const parts = value.split(".");
  return parts.length === 2 && parts[1].length > 8
    ? `${parts[0]}.${parts[1].slice(0, 6)}…`
    : value;
}
const reasonLabels: Record<string, string> = {
  DAILY_HISTORY_INCOMPLETE: "已完成日线不足，或历史完整性尚未验证。",
  ADJUSTMENT_EVIDENCE_UNVERIFIED: "拆股复权依据尚未验证。",
  INSTRUMENT_RULES_UNVERIFIED: "证券规则尚未验证。",
  DAILY_SERIES_INVALID: "日线序列不满足计算要求。",
  DUPLICATE_SUPPORT_SELECTION: "同一支撑依据被重复选择。",
  EMA9_NOT_READY: "EMA 9 数据尚未就绪。",
  EMA21_NOT_READY: "EMA 21 数据尚未就绪。",
  EMA50_NOT_READY: "EMA 50 数据尚未就绪。",
  AVWAP_NOT_READY: "锚定均价不可用，请选择有效日线锚点并确认价量依据。",
  HORIZONTAL_NOT_READY: "水平线价格不可用。",
  ATR_NOT_READY: "ATR 14 尚未完成预热。",
  INSUFFICIENT_SUPPORT_FAMILIES:
    "容差内需要至少两个家族，且包含均线或锚定均价。",
  NON_POSITIVE_SUPPORT_ZONE: "建议支撑区下沿须大于零。",
  SUPPORT_INPUT_INVALID: "支撑输入不满足计算条件。",
  PREVIOUS_DAILY_BAR_MISSING: "缺少计划交易日前的已完成日线。",
};
function cutoff(value: number | null) {
  return value == null
    ? "不可用"
    : `${new Date(value).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export function SupportEditor({
  plan,
  snapshot,
  loading,
  error,
  legacy,
  onChange,
  onApply,
}: {
  plan: PlanInput;
  snapshot: SupportSnapshot | null;
  loading: boolean;
  error: string | null;
  legacy: boolean;
  onChange: (selections: SupportSelection[]) => void;
  onApply: (lower: string, upper: string) => void;
}) {
  const selections = plan.supportSelections ?? [];
  function toggle(source: (typeof sources)[number]) {
    onChange(
      selections.some((s) => s.source === source)
        ? selections.filter((s) => s.source !== source)
        : [...selections, { source }],
    );
  }
  function editHorizontal(id: string, field: "price" | "label", value: string) {
    onChange(
      selections.map((s) =>
        s.source === "HORIZONTAL" && s.id === id ? { ...s, [field]: value } : s,
      ),
    );
  }
  return (
    <section className="support-editor" aria-label="支撑家族与证据">
      <div className="section-heading">
        <h4>支撑家族与证据</h4>
        <span className={`badge ${snapshot?.ready ? "green" : "amber"}`}>
          {loading ? "核算中" : snapshot?.ready ? "支撑证据完整" : "待补充证据"}
        </span>
      </div>
      <p className="field-explanation">
        选择接近主支撑的依据。至少需要两个不同家族，且包含均线或锚定均价；多条均线只算一个家族。
      </p>
      {legacy && (
        <p className="support-warning" role="status">
          此旧计划没有支撑快照。请明确选择依据并保存新版本，再启用观察。
        </p>
      )}
      <div className="support-options">
        {sources.map((source) => (
          <label className="checkbox" key={source}>
            <input
              type="checkbox"
              checked={selections.some((s) => s.source === source)}
              disabled={
                selections.length >= 20 &&
                !selections.some((s) => s.source === source)
              }
              onChange={() => toggle(source)}
            />
            <span>{labels[source]}</span>
          </label>
        ))}
      </div>
      {selections
        .filter((s) => s.source === "HORIZONTAL")
        .map((line) => (
          <div className="horizontal-editor" key={line.id}>
            <label>
              水平线名称
              <input
                aria-label="水平线名称"
                value={line.label}
                maxLength={80}
                onChange={(e) =>
                  editHorizontal(line.id, "label", e.target.value)
                }
              />
            </label>
            <label>
              水平线价格
              <input
                aria-label="水平线价格"
                inputMode="decimal"
                value={line.price}
                placeholder="精确价格"
                onChange={(e) =>
                  editHorizontal(line.id, "price", e.target.value)
                }
              />
            </label>
            <button
              type="button"
              className="text-button"
              aria-label={`删除水平线 ${line.label || "未命名"}`}
              onClick={() => onChange(selections.filter((s) => s !== line))}
            >
              删除
            </button>
          </div>
        ))}
      <button
        type="button"
        className="text-button"
        disabled={selections.length >= 20}
        onClick={() =>
          onChange([
            ...selections,
            {
              source: "HORIZONTAL",
              id: crypto.randomUUID(),
              label: "手动水平线",
              price: plan.primarySupport,
            },
          ])
        }
      >
        ＋ 添加手动水平线
      </button>
      <div className="support-preview" aria-live="polite" aria-busy={loading}>
        {error && <p className="support-warning">{error}</p>}
        {!snapshot && !error && (
          <p className="field-explanation">
            {loading
              ? "正在按最新选择核算支撑…"
              : "填写主支撑价格后，显示服务端核算结果。"}
          </p>
        )}
        {snapshot && (
          <>
            <dl className="support-metrics">
              <div>
                <dt>容差 τ</dt>
                <dd>{decimalLabel(snapshot.tolerance)}</dd>
              </div>
              <div>
                <dt>有效家族</dt>
                <dd>{snapshot.matchedFamilies.length} / 至少 2</dd>
              </div>
              <div>
                <dt>参考收盘</dt>
                <dd>{snapshot.reference.close ?? "不可用"}</dd>
              </div>
              <div>
                <dt>ATR 14</dt>
                <dd>{decimalLabel(snapshot.reference.atr14)}</dd>
              </div>
            </dl>
            <div className="support-lines">
              {snapshot.lines.map((line) => (
                <div key={line.id} className="support-line">
                  <div>
                    <strong>{line.label}</strong>
                    <span>
                      {familyLabel[line.family]} ·{" "}
                      {line.withinTolerance
                        ? "在容差内"
                        : line.price == null
                          ? "数据不可用"
                          : "超出容差"}
                    </span>
                  </div>
                  <dl>
                    <dt>参考价格</dt>
                    <dd title={line.price ?? undefined}>
                      {decimalLabel(line.price)}
                    </dd>
                    <dt>距离 / τ</dt>
                    <dd title={line.distance ?? undefined}>
                      {decimalLabel(line.distance)}
                    </dd>
                    <dt>数据截止</dt>
                    <dd>{cutoff(line.dataCutoff)}</dd>
                  </dl>
                  {line.reasons?.length ? (
                    <ul className="reason-list">
                      {line.reasons.map((reason) => (
                        <li key={reason}>{reasonLabels[reason] ?? reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
            {snapshot.reasons.length > 0 && (
              <ul className="reason-list support-warning">
                {snapshot.reasons.map((reason) => (
                  <li key={reason}>{reasonLabels[reason] ?? reason}</li>
                ))}
              </ul>
            )}
            {snapshot.suggestedLower && snapshot.suggestedUpper && (
              <div className="suggested-zone">
                <div>
                  <small>服务端建议支撑区</small>
                  <strong>
                    {snapshot.suggestedLower} – {snapshot.suggestedUpper}
                  </strong>
                </div>
                <button
                  type="button"
                  className="button secondary compact"
                  onClick={() =>
                    onApply(snapshot.suggestedLower!, snapshot.suggestedUpper!)
                  }
                >
                  应用建议区间
                </button>
              </div>
            )}
            <p className="field-explanation">
              距离 / τ = |参考价 − 主支撑| ÷ τ，≤ 1
              为容差内。较长小数仅缩略展示。
            </p>
            <details className="snapshot-details">
              <summary>查看完整精度与计算口径</summary>
              <dl className="detail-list">
                <dt>容差 τ</dt>
                <dd className="breakable">{snapshot.tolerance ?? "不可用"}</dd>
                <dt>ATR 14</dt>
                <dd className="breakable">
                  {snapshot.reference.atr14 ?? "不可用"}
                </dd>
                <dt>基准</dt>
                <dd>已完成日线 · 拆股复权</dd>
                <dt>锚定均价</dt>
                <dd>HLC3 × 成交量</dd>
              </dl>
              {snapshot.lines.map((line) => (
                <p className="breakable" key={line.id}>
                  {line.label}：价格 {line.price ?? "不可用"}；距离 / τ{" "}
                  {line.distance ?? "不可用"}
                </p>
              ))}
            </details>
            <p className="field-explanation">
              建议区间只有在点击后才写入表单。
              {snapshot.synthetic
                ? "当前依据来自合成样本。"
                : "依据固定日线与复权口径核算。"}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
