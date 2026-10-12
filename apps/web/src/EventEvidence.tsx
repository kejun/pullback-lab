import { useEffect, useState } from "react";
import type {
  DecisionEvent,
  FeedbackRevision,
} from "../../../packages/contracts/index";
import { api } from "./api";

type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
}
function value(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "未记录";
}
function at(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" })} UTC`
    : "未记录";
}
const checkLabels: Record<string, string> = {
  capability: "行情能力",
  quote: "报价",
  price: "入场价格",
  entry: "入场范围",
  entryRange: "入场范围",
  chase: "追价距离",
  lod: "当日低点",
  risk: "风险预算",
  health: "行情完整性",
  background: "回踩背景",
  support: "支撑证据",
};
const replayCheckLabels: Record<string, string> = {
  inputHash: "输入指纹",
  serializedInput: "持久化输入",
  algorithmVersion: "算法版本",
  snapshotSchema: "快照结构",
  ingestSequence: "输入顺序",
  attemptState: "尝试状态",
  emittedEvents: "事件序列",
  risk: "风险核算",
};
const attemptLabels: Record<string, string> = {
  USER_PAUSED: "已暂停",
  DATA_PAUSED: "数据暂停",
  WAIT_RETEST: "等待回踩",
  ARMED: "回踩已确认",
  TRIGGERED: "已触发",
  INVALID: "已失效",
  EXPIRED: "已到期",
};
const stateLabels: Record<string, string> = {
  PASS: "通过",
  BLOCKED: "阻断",
  FAIL: "不一致",
  UNAVAILABLE: "依据不可用",
  UNSUPPORTED: "无法验证",
};

export function DecisionEvidence({ event }: { event: DecisionEvent }) {
  const s = event.snapshot;
  const plan = object(s.planVersion ?? s.plan);
  const state = object(s.state);
  const reference = object(state.reference);
  const trigger = object(state.trigger);
  const risk = object(s.risk);
  const support = object(plan.supportSnapshot);
  const emitted = Array.isArray(s.emitted) ? s.emitted : [];
  const assessment = [...emitted]
    .reverse()
    .map((item) => object(object(item).snapshot))
    .find((item) => Object.keys(object(item.checks)).length);
  const checks = object(s.checks ?? assessment?.checks);
  return (
    <section className="evidence-summary" aria-label="结构化判断依据">
      <h3>当时的判断依据</h3>
      {typeof plan.reason === "string" && plan.reason && (
        <p className="revision-note">{plan.reason}</p>
      )}
      <dl className="detail-list">
        <dt>冻结计划版本</dt>
        <dd>{plan.version == null ? "未记录" : `v${value(plan.version)}`}</dd>
        <dt>支撑区</dt>
        <dd>
          {value(plan.lower)} – {value(plan.upper)}
        </dd>
        <dt>允许入场区</dt>
        <dd>
          {value(plan.entryMin)} – {value(plan.entryMax)}
        </dd>
        <dt>止损参考</dt>
        <dd>{value(plan.stop)}</dd>
        <dt>首次回踩</dt>
        <dd>{at(state.touchAt)}</dd>
        <dt>突破阈值</dt>
        <dd>{value(trigger.threshold)}</dd>
        <dt>引用 K 线</dt>
        <dd className="breakable">{value(reference.barId)}</dd>
        <dt>检查截止</dt>
        <dd>{at(state.deadline)}</dd>
        <dt>冻结支撑家族</dt>
        <dd>
          {Array.isArray(support.matchedFamilies)
            ? support.matchedFamilies
                .map(
                  (family) =>
                    ({ EMA: "均线", AVWAP: "锚定均价", HORIZONTAL: "水平线" })[
                      String(family)
                    ] ?? String(family),
                )
                .join(" / ") || "无有效家族"
            : "旧记录未保存"}
        </dd>
        <dt>风险结论</dt>
        <dd>
          {risk.passed === true
            ? "通过"
            : risk.passed === false
              ? "未通过"
              : "未记录"}
        </dd>
        <dt>核算入场价</dt>
        <dd>{value(risk.entry)}</dd>
        <dt>占用现金 / 风险</dt>
        <dd>
          {value(risk.cashUse)} / {value(risk.riskBase)}
        </dd>
      </dl>
      {Object.keys(checks).length > 0 ? (
        <div className="gate-checks">
          {Object.entries(checks).map(([name, raw]) => {
            const check = object(raw);
            return (
              <div key={name}>
                <strong>{checkLabels[name] ?? name}</strong>
                <span
                  className={
                    check.status === "PASS" ? "green-text" : "danger-text"
                  }
                >
                  {stateLabels[value(check.status)] ?? value(check.status)}
                </span>
                {Array.isArray(check.reasons) && check.reasons.length > 0 ? (
                  <small>{check.reasons.map(String).join("；")}</small>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="field-explanation">
          此记录未保存逐项检查明细；现有字段不代表完整验证。
        </p>
      )}
      <p className="field-explanation">
        以上内容只取自事件发生时的冻结输入。
        {event.snapshot.synthetic === true
          ? "合成回放中的行情能力仍为未知。"
          : "当前行情和账户修改不会替换此记录。"}
      </p>
    </section>
  );
}

const deviations: Record<string, string> = {
  ACTUAL_PRICE_OUTSIDE_ENTRY_RANGE: "实际均价超出计划入场区",
  ACTUAL_QUANTITY_ABOVE_APPROVED: "实际数量高于核算数量",
  ACTUAL_QUANTITY_RULE_MISMATCH: "实际数量不符合证券数量规则",
  ACTUAL_TIME_BEFORE_SIGNAL: "实际入场时间早于提醒",
};
export function FeedbackHistory({
  revisions,
  loading,
  error,
  onReload,
}: {
  revisions: FeedbackRevision[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
}) {
  return (
    <section
      className="feedback-history"
      aria-label="反馈修订历史"
      aria-busy={loading}
    >
      <div className="section-heading">
        <h3>反馈修订历史</h3>
        <span>{revisions.length} 次</span>
      </div>
      {loading && (
        <p role="status" className="field-explanation">
          正在读取已保存的实际值…
        </p>
      )}
      {error && (
        <div className="support-warning" role="alert">
          <p>{error}</p>
          <button type="button" className="text-button" onClick={onReload}>
            重新读取修订历史
          </button>
        </div>
      )}
      {!loading && !error && !revisions.length && (
        <p className="field-explanation">尚未记录交易选择。</p>
      )}
      {[...revisions].reverse().map((revision, index) => (
        <article
          className="feedback-revision"
          key={revision.id || `${revision.recordedAt}:${index}`}
        >
          <div className="section-heading">
            <strong>
              第 {revisions.length - index} 次 ·{" "}
              {revision.kind === "TAKEN" ? "已交易" : "已跳过"}
            </strong>
            {index === 0 && <span className="badge neutral">最新</span>}
          </div>
          <small>{at(revision.recordedAt)}</small>
          <p className="revision-note">{revision.note || "未填写备注"}</p>
          <dl className="detail-list">
            <dt>实际均价</dt>
            <dd>{revision.actualPrice ?? "未填写"}</dd>
            <dt>实际数量</dt>
            <dd>
              {revision.actualQuantity == null
                ? "未填写"
                : `${revision.actualQuantity} 股`}
            </dd>
            <dt>实际入场</dt>
            <dd>
              {revision.actualTime == null ? "未填写" : at(revision.actualTime)}
            </dd>
          </dl>
          {revision.deviationCodes?.length ? (
            <ul className="reason-list support-warning">
              {revision.deviationCodes.map((code) => (
                <li key={code}>{deviations[code] ?? code}</li>
              ))}
            </ul>
          ) : (
            <p className="field-explanation">
              {revision.assessmentVersion === "legacy-unassessed"
                ? "旧记录未评估偏离，原始值已保留。"
                : "已填写字段未发现上述计划偏离。"}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}

interface ReplaySummary {
  status: string | null;
  eventTypes: string[];
  quantity: number | null;
}
interface ReplayResult {
  status: "MATCH" | "MISMATCH" | "UNSUPPORTED";
  checks: {
    name: string;
    status: "PASS" | "FAIL" | "UNSUPPORTED";
    detail: string;
  }[];
  reasons: string[];
  original: ReplaySummary;
  replayed: ReplaySummary | null;
  inputHash: string;
  algorithmVersion: string | null;
  coverage: {
    trigger: "VERIFIED" | "NOT_VERIFIED";
    risk: "FROZEN_GATE_ONLY" | "RECOMPUTED" | "NOT_VERIFIED";
    scope: "PERSISTED_INPUTS_ONLY";
  };
}
export function EventReplay({ eventId }: { eventId: string }) {
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (!request) return;
    let active = true;
    setLoading(true);
    setError(null);
    api<ReplayResult>(`/events/${eventId}/replay`)
      .then((response) => {
        if (active) setResult(response);
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
  }, [eventId, request]);
  const status =
    result?.status === "MATCH"
      ? "冻结输入回放一致"
      : result?.status === "MISMATCH"
        ? "发现不一致"
        : "现有证据不足以回放";
  return (
    <section className="event-replay" aria-label="只读历史回放">
      <div className="section-heading">
        <h3>只读历史回放</h3>
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => setRequest((r) => r + 1)}
        >
          {loading ? "正在验证…" : "验证冻结输入"}
        </button>
      </div>
      <p className="field-explanation">
        重放已保存输入，核对当时判断。此操作不会启用计划、生成新提醒或修改资金。
      </p>
      {error && (
        <p className="support-warning" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div aria-live="polite">
          <strong
            className={result.status === "MATCH" ? "green-text" : "danger-text"}
          >
            {status}
          </strong>
          <dl className="detail-list">
            <dt>触发检查</dt>
            <dd>
              {result.coverage.trigger === "VERIFIED" ? "已验证" : "未验证"}
            </dd>
            <dt>风险检查范围</dt>
            <dd>
              {result.coverage.risk === "RECOMPUTED"
                ? "已重新计算"
                : result.coverage.risk === "FROZEN_GATE_ONLY"
                  ? "只核对冻结风险结论"
                  : "未验证"}
            </dd>
            <dt>原状态 / 回放状态</dt>
            <dd>
              {result.original.status
                ? (attemptLabels[result.original.status] ??
                  result.original.status)
                : "未记录"}{" "}
              /{" "}
              {result.replayed?.status
                ? (attemptLabels[result.replayed.status] ??
                  result.replayed.status)
                : "无法重放"}
            </dd>
            <dt>原数量 / 回放数量</dt>
            <dd>
              {result.original.quantity ?? "未记录"} /{" "}
              {result.replayed?.quantity ?? "未记录"}
            </dd>
            <dt>算法版本</dt>
            <dd className="breakable">{result.algorithmVersion ?? "未记录"}</dd>
          </dl>
          <div className="gate-checks">
            {result.checks.map((check, index) => (
              <div key={`${check.name}:${index}`}>
                <strong>{replayCheckLabels[check.name] ?? check.name}</strong>
                <span
                  className={
                    check.status === "PASS" ? "green-text" : "danger-text"
                  }
                >
                  {stateLabels[check.status]}
                </span>
                <small>{check.detail}</small>
              </div>
            ))}
          </div>
          {result.reasons.length > 0 && (
            <ul className="reason-list">
              {result.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <p className="field-explanation">
            验证范围仅限持久化输入；一致结果不代表真实行情接入或生产环境已验收。
          </p>
          <details className="snapshot-details">
            <summary>输入指纹与事件类型</summary>
            <code className="breakable">{result.inputHash}</code>
            <p>原事件：{result.original.eventTypes.join("、") || "无"}</p>
            <p>回放事件：{result.replayed?.eventTypes.join("、") || "无"}</p>
          </details>
        </div>
      )}
    </section>
  );
}
