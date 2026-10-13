import { useEffect, useRef, useState } from "react";
import type {
  ResearchChartData,
  ResearchHistoryPreview,
  ResearchHistoryStatus,
  ResearchHistorySummary,
} from "../../../packages/contracts/research-history";
import { api } from "./api";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const message = (error: unknown) =>
  error instanceof Error ? error.message : "请求未完成，请重试。";
const recordedAt = (value: number) =>
  `${new Date(value).toISOString().replace("T", " ").slice(0, 19)} UTC`;

function HistoryFacts({
  history,
}: {
  history: ResearchHistoryPreview["summary"] | ResearchHistorySummary;
}) {
  return (
    <dl className="history-facts">
      <div>
        <dt>资料来源</dt>
        <dd>{history.source}</dd>
      </div>
      <div>
        <dt>目标交易日</dt>
        <dd>{history.targetDate}</dd>
      </div>
      {"importedAt" in history && (
        <div>
          <dt>实际导入时间</dt>
          <dd>{recordedAt(history.importedAt)}</dd>
        </div>
      )}
      <div>
        <dt>完整 K 线</dt>
        <dd>
          日线 {history.counts["1D"]} · 1 分钟 {history.counts["1m"]} · 5 分钟{" "}
          {history.counts["5m"]}
        </dd>
      </div>
      <div>
        <dt>公司行动版本</dt>
        <dd>{history.actionEvidenceVersion}</dd>
      </div>
      <div>
        <dt>复权版本</dt>
        <dd>{history.adjustmentVersion}</dd>
      </div>
    </dl>
  );
}

/** File selection stays local. Only an explicit preview uploads to this app. */
export function ResearchHistory({
  instrumentId,
  selectedHistoryId,
  savedPlan,
  onAdopt,
  onImported,
  onStatus,
  viewedHistoryId,
  onView,
}: {
  instrumentId: string;
  selectedHistoryId?: string;
  savedPlan: boolean;
  onAdopt: (history: ResearchHistorySummary) => void;
  onImported: () => Promise<void>;
  onStatus: (status: ResearchHistoryStatus) => void;
  viewedHistoryId: string | null;
  onView: (historyId: string | null) => void;
}) {
  const base = `/instruments/${encodeURIComponent(instrumentId)}/research-history`;
  const [status, setStatus] = useState<ResearchHistoryStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [retry, setRetry] = useState(0);
  const [fileName, setFileName] = useState("");
  const [manifest, setManifest] = useState<unknown>(null);
  const [preview, setPreview] = useState<ResearchHistoryPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"read" | "preview" | "import" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const statusSequence = useRef(0);
  const alive = useRef(true);
  const pending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const reportStatus = useRef(onStatus);
  reportStatus.current = onStatus;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const requested = ++statusSequence.current;
    setStatusError("");
    void api<ResearchHistoryStatus>(base, "GET", undefined, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted || requested !== statusSequence.current)
          return;
        setStatus(result);
        reportStatus.current(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted && requested === statusSequence.current)
          setStatusError(message(e));
      });
    return () => controller.abort();
  }, [base, retry]);

  function clearFile() {
    sequence.current++;
    setManifest(null);
    setFileName("");
    setPreview(null);
    setConfirmed(false);
    setError("");
    setNotice("");
    setBusy("");
    pending.current = false;
    if (input.current) input.current.value = "";
  }
  async function selectFile(file: File | undefined) {
    clearFile();
    if (!file) return;
    const requested = sequence.current;
    setFileName(file.name);
    if (file.size > MAX_FILE_BYTES) {
      setError("文件不能超过 2 MiB。尚未上传任何资料。");
      return;
    }
    setBusy("read");
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!alive.current || requested !== sequence.current) return;
      setManifest(parsed);
    } catch {
      if (alive.current && requested === sequence.current)
        setError(
          "文件不是有效 JSON。请检查模板格式后重新选择文件，尚未上传任何资料。",
        );
    } finally {
      if (alive.current && requested === sequence.current) setBusy("");
    }
  }
  async function readPreview() {
    if (manifest == null || pending.current) return;
    pending.current = true;
    const requested = ++sequence.current;
    setBusy("preview");
    setPreview(null);
    setConfirmed(false);
    setError("");
    setNotice("");
    try {
      const result = await api<ResearchHistoryPreview>(
        `${base}/preview`,
        "POST",
        { manifest },
      );
      if (alive.current && requested === sequence.current) setPreview(result);
    } catch (e) {
      if (alive.current && requested === sequence.current) setError(message(e));
    } finally {
      if (alive.current && requested === sequence.current) {
        setBusy("");
        pending.current = false;
      }
    }
  }
  async function importHistory() {
    if (!preview || !confirmed || pending.current) return;
    pending.current = true;
    const requested = ++sequence.current;
    setBusy("import");
    setError("");
    try {
      const result = await api<{
        status: "IMPORTED" | "DUPLICATE";
        history: ResearchHistorySummary;
      }>(base, "POST", {
        manifest,
        token: preview.token,
        expectedHistoryId: preview.expectedHistoryId,
        expectedActionVersion: preview.expectedActionVersion,
        confirmed: true,
      });
      if (!alive.current || requested !== sequence.current) return;
      if (!result.history.current) {
        setPreview(null);
        setConfirmed(false);
        setNotice(
          "本次资料已存在，但已被新资料或公司行动修订替代，未用于当前草稿。请读取并采用当前资料。",
        );
        setRetry((value) => value + 1);
        await onImported();
        return;
      }
      statusSequence.current++;
      const next = {
        current: result.history,
        history: [
          result.history,
          ...(status?.history ?? [])
            .filter((row) => row.id !== result.history.id)
            .map((row) => ({ ...row, current: false })),
        ],
      };
      setStatus(next);
      reportStatus.current(next);
      setPreview(null);
      setConfirmed(false);
      onAdopt(result.history);
      setNotice(
        `${result.status === "DUPLICATE" ? "相同资料已存在，未重复导入。" : "资料已原子导入。"}已用于当前计划草稿，原有价格输入已保留。${savedPlan ? "请保存新版本，原有计划记录保持不变。" : "请核对锚点、价格和目标交易日，再保存计划草稿。"}`,
      );
      // Refresh the candidate pool without replacing the user's open draft.
      try {
        await onImported();
      } catch (e) {
        if (alive.current && requested === sequence.current)
          setError(`资料已导入，但候选列表刷新失败：${message(e)}`);
      }
    } catch (e) {
      if (alive.current && requested === sequence.current) {
        setError(message(e));
        setPreview(null);
        setConfirmed(false);
        setRetry((value) => value + 1);
      }
    } finally {
      if (alive.current && requested === sequence.current) {
        setBusy("");
        pending.current = false;
      }
    }
  }
  return (
    <section className="panel research-history" aria-label="人工历史资料">
      <div className="section-heading">
        <div>
          <h3>人工历史资料</h3>
          <small>下载模板 → 本地选文件 → 只读预览 → 确认导入</small>
        </div>
        <span className="badge amber">仅供历史研究</span>
      </div>
      <p className="evidence-notice">
        人工历史重建，非当时已知。导入资料不能证明当时已收到行情，也不会开启正式提醒。
      </p>
      <button
        type="button"
        className="text-button"
        disabled={Boolean(busy)}
        onClick={() => setRetry((value) => value + 1)}
      >
        重新读取历史资料
      </button>
      {!status && !statusError && <p role="status">正在读取当前资料…</p>}
      {statusError && (
        <p role="alert">
          {statusError}{" "}
          <button
            className="text-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试资料读取
          </button>
        </p>
      )}
      {status?.current ? (
        <details className="current-history" open>
          <summary>
            当前历史资料
            {selectedHistoryId === status.current.id
              ? " · 已用于当前草稿"
              : " · 尚未用于当前草稿"}
          </summary>
          <HistoryFacts history={status.current} />
          {!status.current.current && (
            <p className="support-warning">
              最新收录已被公司行动修订替代。请核对来源并重新预览导入后再用于草稿。
            </p>
          )}
          {status.current.current &&
            selectedHistoryId !== status.current.id && (
              <>
                <p className="field-explanation">
                  明确采用后会更新草稿的资料版本和目标交易日，保留锚点与价格。
                  {savedPlan
                    ? "请另存新版本，旧计划不会自动改用新资料。"
                    : "价格与研究依据仍需人工核对。"}
                </p>
                <button
                  type="button"
                  className="button secondary"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    onAdopt(status.current!);
                    setNotice("已用于当前计划草稿，请核对价格与锚点后保存。");
                  }}
                >
                  用于当前计划草稿
                </button>
              </>
            )}
        </details>
      ) : (
        status && (
          <p className="field-explanation">
            尚未导入历史资料。可以先下载模板并填写数据。
          </p>
        )
      )}
      {Boolean(status?.history.length) && (
        <div className="history-browser">
          <label className="evidence-version-label">
            只读查阅历史资料图表（最近 20 次）
            <select
              aria-label="只读查阅历史资料图表"
              value={viewedHistoryId ?? ""}
              disabled={busy === "import"}
              onChange={(event) => onView(event.target.value || null)}
            >
              <option value="">当前计划草稿图表</option>
              {status!.history.map((history) => (
                <option value={history.id} key={history.id}>
                  {recordedAt(history.importedAt)} · {history.targetDate} ·{" "}
                  {history.source} · {history.current ? "当前资料" : "已替代"}
                </option>
              ))}
            </select>
          </label>
          <p className="field-explanation">
            列表只显示最近 20
            次收录。查阅不修改草稿、目标日或资料版本；更早资料仍可通过引用它的已保存计划查看。
          </p>
          {viewedHistoryId && (
            <button
              type="button"
              className="button secondary"
              onClick={() => onView(null)}
            >
              返回当前草稿图表
            </button>
          )}
        </div>
      )}
      <p className="field-explanation">
        JSON 最大 2 MiB、最多 3000 根 K
        线。选文件只在本地读取；点击“只读预览”才上传至本应用。预览不会写入行情、计划或提醒。
      </p>
      <details className="history-format-help">
        <summary>如何填写 JSON 模板</summary>
        <ul>
          <li>
            替换来源、核对人、日期和所有占位内容。模板会保留已有公司行动资料；请核对覆盖期间、来源原文与拆股、分红清单，不能把未知当作没有。
          </li>
          <li>
            start、end、knownAt、publishedAt 和覆盖时间使用 UTC
            毫秒时间戳；交易日使用
            YYYY-MM-DD，日历开收盘时间使用交易所当地时间。
          </li>
          <li>
            价格、volume 和 turnover 均填写十进制字符串。volumeUnit 为 SHARE
            时填写股数；为 LOT 时还须填写每手股数 lotSize。
          </li>
          <li>
            日线日期须早于目标交易日；分钟数据只接受目标交易日已收盘会话。至少提供
            1 根完整日线、连续 5 根 1 分钟线及对应 1 根 5 分钟线。
          </li>
          <li>
            对应 5 分钟区间的开高低收、股数与成交额必须和 1
            分钟线汇总一致。填写原始未复权数据，拆股口径由服务端依据公司行动统一核算。
          </li>
        </ul>
      </details>
      <div className="history-actions">
        <a
          className="button secondary"
          href={`/api${base}/template`}
          download={`${instrumentId}-research-history.json`}
        >
          下载历史资料 JSON 模板
        </a>
        <label className="history-file">
          选择历史资料 JSON
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            disabled={busy === "import"}
            onChange={(event) => void selectFile(event.target.files?.[0])}
          />
        </label>
      </div>
      {fileName && <p className="history-file-name">已选择：{fileName}</p>}
      <div className="history-actions">
        <button
          type="button"
          className="button secondary"
          disabled={manifest == null || Boolean(busy)}
          onClick={() => void readPreview()}
        >
          {busy === "preview" ? "正在只读预览…" : "只读预览"}
        </button>
        {(fileName || preview || busy) && (
          <button
            type="button"
            className="text-button"
            disabled={busy === "import"}
            onClick={clearFile}
          >
            取消本次资料
          </button>
        )}
      </div>
      {error && (
        <p className="support-warning" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="history-notice" role="status">
          {notice}
        </p>
      )}
      {preview && (
        <div
          className="history-preview"
          role="region"
          aria-label="历史资料只读预览"
        >
          <h4>只读预览 · 尚未写入</h4>
          <HistoryFacts history={preview.summary} />
          {preview.warnings.length > 0 && (
            <ul className="reason-list">
              {preview.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy === "import"}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              我已核对来源、目标日和数据，确认导入并用于当前计划草稿；仅作人工历史研究，正式提醒禁用。
            </span>
          </label>
          <button
            type="button"
            className="button primary"
            disabled={!confirmed || Boolean(busy)}
            onClick={() => void importHistory()}
          >
            {busy === "import" ? "正在原子导入…" : "确认导入历史资料"}
          </button>
        </div>
      )}
    </section>
  );
}

export function ResearchHistoryChartEvidence({
  chart,
  adopted,
}: {
  chart: ResearchChartData;
  adopted: boolean;
}) {
  const history = chart.researchHistory;
  if (!history) return null;
  const latestCutoff = chart.avwapCutoffs?.at(-1);
  return (
    <section className="history-chart-evidence" aria-label="图表历史资料口径">
      <strong>人工历史重建 · 非当时已知 · 正式提醒禁用</strong>
      <p>
        来源：{history.source} · 目标日：{history.targetDate} · 实际导入时间：
        {recordedAt(history.importedAt)}
      </p>
      {!history.current && (
        <p className="support-warning">
          此资料已被新资料或公司行动修订替代。旧图仅供查阅，不能覆盖保存；请明确采用当前资料后保存新版本。
        </p>
      )}
      {history.current && !adopted && (
        <p className="support-warning">
          当前图表仅供查阅。请在上方点击“用于当前计划草稿”后再保存，旧计划尚未改用此资料。
        </p>
      )}
      <p>
        AVWAP 上一完成日截止：
        {latestCutoff == null ? "不可用" : recordedAt(latestCutoff * 1000)}
        。分钟图使用同一日线参考，不以分钟数据重算。
      </p>
      <details>
        <summary>查看服务端 AVWAP 精确值与逐点截止</summary>
        <ol className="history-avwap-values">
          {chart.bars.map((bar, index) => (
            <li key={`${bar.time}:${index}`}>
              图表时间 {recordedAt(bar.time * 1000)}；AVWAP{" "}
              {chart.avwap[index] ?? "不可用"}；上一完成日截止{" "}
              {chart.avwapCutoffs?.[index] == null
                ? "不可用"
                : recordedAt(chart.avwapCutoffs[index]! * 1000)}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
