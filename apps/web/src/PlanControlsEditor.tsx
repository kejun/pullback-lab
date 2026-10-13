import { useId } from "react";
import type {
  Currency,
  FeeSchedule,
  FeeSide,
  PlanInput,
} from "../../../packages/contracts/index";
import "./PlanControlsEditor.css";

export const feeFields: readonly [keyof FeeSide, string][] = [
  ["minimum", "最低费用 / 笔"],
  ["fixed", "固定费用 / 笔"],
  ["perShare", "每股费用"],
  ["notionalRate", "成交额费率（小数比例）"],
];

export function PlanControlsEditor({
  plan,
  currency,
  onChaseChange,
  onFeeChange,
}: {
  plan: PlanInput;
  currency: Currency;
  onChaseChange: (chase: PlanInput["chaseLimit"]) => void;
  onFeeChange: (fees: PlanInput["feeSchedule"]) => void;
}) {
  const id = useId();
  const schedule = plan.feeSchedule;
  const enabled = plan.chaseLimit?.enabled === true;
  const complete = Boolean(
    schedule?.version.trim() &&
    schedule.effectiveDate &&
    [schedule.buy, schedule.sell].every((side) =>
      feeFields.every(([field]) => (side[field] ?? "").trim() !== ""),
    ),
  );
  function editSchedule(change: Partial<FeeSchedule>) {
    if (schedule) onFeeChange({ ...schedule, ...change, confirmed: false });
  }
  function editSide(side: "buy" | "sell", field: keyof FeeSide, value: string) {
    if (schedule)
      editSchedule({ [side]: { ...schedule[side], [field]: value } });
  }
  return (
    <section className="plan-controls" aria-label="计划追价与费用规则">
      <div className="plan-control-block">
        <h4>追价上限</h4>
        <div className="field">
          <label htmlFor={`${id}-chase`}>追价限制</label>
          <select
            id={`${id}-chase`}
            value={enabled ? "enabled" : "disabled"}
            onChange={(event) =>
              onChaseChange(
                event.target.value === "enabled"
                  ? { enabled: true, maxPercent: "" }
                  : { enabled: false },
              )
            }
          >
            <option value="disabled">关闭</option>
            <option value="enabled">启用</option>
          </select>
        </div>
        {enabled ? (
          <div className="field">
            <label htmlFor={`${id}-percent`}>
              距当时已知低点的最大涨幅（%）
            </label>
            <input
              id={`${id}-percent`}
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              required
              value={plan.chaseLimit?.maxPercent ?? ""}
              placeholder="请自行填写百分比"
              aria-describedby={`${id}-chase-help`}
              onChange={(event) =>
                onChaseChange({ enabled: true, maxPercent: event.target.value })
              }
            />
          </div>
        ) : (
          <p className="field-explanation" role="status">
            {plan.chaseLimit
              ? "本计划明确关闭追价限制。"
              : "未配置追价上限，保持关闭。"}
          </p>
        )}
        <p className="field-explanation" id={`${id}-chase-help`}>
          涨幅 =（核查入场价 − 当时已知低点）÷
          当时已知低点。只使用常规开盘以来、决策时刻已知的低点，不含盘前或之后的价格。严格超过上限才阻断；启用后低点证据不完整会暂停。
        </p>
      </div>
      <div className="plan-control-block">
        <div className="plan-control-heading">
          <h4>本计划费用规则</h4>
          <span
            className={`badge ${schedule?.confirmed ? "green" : "neutral"}`}
          >
            {schedule
              ? schedule.confirmed
                ? "已核对"
                : "待核对"
              : "旧版固定费用"}
          </span>
        </div>
        {!schedule ? (
          <>
            <p className="field-explanation" role="status">
              此计划未配置完整费用规则，沿用资金快照中的旧版每笔固定费用。不会推断券商费率。
            </p>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                onFeeChange({
                  buy: {
                    minimum: "",
                    fixed: "",
                    perShare: "",
                    notionalRate: "",
                  },
                  sell: {
                    minimum: "",
                    fixed: "",
                    perShare: "",
                    notionalRate: "",
                  },
                  currency,
                  version: "",
                  effectiveDate: "",
                  confirmed: false,
                })
              }
            >
              为此计划填写完整费用规则
            </button>
          </>
        ) : (
          <>
            <p className="field-explanation" id={`${id}-fee-help`}>
              每侧费用 = max（最低费用，固定费用 + 每股费用 × 股数 + 成交额费率
              × 股数 ×
              核算价格），向上取整到小数点后两位。买卖分别核算。所有项目请明确填写，无该项填
              0。
            </p>
            <div className="field-pair">
              <div className="field">
                <label htmlFor={`${id}-currency`}>费用币种</label>
                <select
                  id={`${id}-currency`}
                  value={schedule.currency}
                  onChange={(event) =>
                    editSchedule({ currency: event.target.value as Currency })
                  }
                >
                  <option value="USD">USD</option>
                  <option value="CNY">CNY</option>
                </select>
                <small>须与证券报价币种 {currency} 一致。</small>
              </div>
              <div className="field">
                <label htmlFor={`${id}-fee-version`}>费用规则版本</label>
                <input
                  id={`${id}-fee-version`}
                  value={schedule.version}
                  required
                  maxLength={120}
                  placeholder="填写核对的规则标识"
                  onChange={(event) =>
                    editSchedule({ version: event.target.value })
                  }
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor={`${id}-effective`}>费用规则生效日期</label>
              <input
                id={`${id}-effective`}
                type="date"
                required
                value={schedule.effectiveDate ?? ""}
                onChange={(event) =>
                  editSchedule({ effectiveDate: event.target.value })
                }
              />
            </div>
            {(["buy", "sell"] as const).map((side) => (
              <fieldset className="plan-fee-side" key={side}>
                <legend>{side === "buy" ? "买入侧费用" : "卖出侧费用"}</legend>
                <div className="field-pair">
                  {feeFields.map(([field, label]) => (
                    <div className="field" key={field}>
                      <label htmlFor={`${id}-${side}-${field}`}>{label}</label>
                      <input
                        id={`${id}-${side}-${field}`}
                        aria-label={`${side === "buy" ? "买入" : "卖出"}${label}`}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        required
                        value={schedule[side][field] ?? ""}
                        placeholder="无该项须填 0"
                        aria-describedby={
                          field === "notionalRate"
                            ? `${id}-rate-help`
                            : `${id}-fee-help`
                        }
                        onChange={(event) =>
                          editSide(side, field, event.target.value)
                        }
                      />
                    </div>
                  ))}
                </div>
              </fieldset>
            ))}
            <p className="field-explanation" id={`${id}-rate-help`}>
              成交额费率使用小数比例，不是百分数。例如 0.1% 应填
              0.001，此例仅说明单位，不是推荐费率。
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={schedule.confirmed}
                disabled={!complete}
                onChange={(event) =>
                  onFeeChange({ ...schedule, confirmed: event.target.checked })
                }
              />
              <span>我已核对本计划买卖两侧全部适用费用、币种及生效日期。</span>
            </label>
            {!schedule.confirmed && (
              <p className="support-warning" role="status">
                {complete
                  ? "费用规则尚未核对，风险检查不会通过。修改任何费用字段后须重新确认。"
                  : "请填写全部费用项目、版本及生效日期，再确认费用规则。"}
              </p>
            )}
            <button
              type="button"
              className="text-button"
              onClick={() => onFeeChange(undefined)}
            >
              改用旧版固定费用
            </button>
          </>
        )}
      </div>
      <p className="field-explanation plan-controls-note">
        追价与费用规则随本次计划版本保存。编辑后须保存新版本；旧计划及事件依据保持不变。
      </p>
    </section>
  );
}
