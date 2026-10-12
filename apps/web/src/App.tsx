import {
  useEffect,
  useId,
  cloneElement,
  isValidElement,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Bar,
  Bootstrap,
  CandidateRow,
  CandidatePage,
  ScreeningSettings,
  Currency,
  DecisionEvent,
  DecisionEventSummary,
  Funds,
  FeedbackRevision,
  SupportSnapshot,
  Instrument,
  Plan,
  PlanInput,
  RiskResult,
} from "../../../packages/contracts/index";
import { api, ApiError } from "./api";
import ResearchChart from "./ResearchChart";
import type { ChartPriceProposal, PlanPriceField } from "./chart-price";
import { useEventFeed } from "./useEventFeed";
import { SyntheticRuntime } from "./SyntheticRuntime";
import { SupportEditor } from "./SupportEditor";
import { MarketStatus } from "./MarketStatus";
import { UniverseImport, ObservationEditor } from "./UniverseEditor";
import type { UniverseSnapshot } from "../../../packages/contracts/universe";
import { ScreeningRulesEditor } from "./ScreeningRulesEditor";
import { DEFAULT_SCREENING_PARAMETERS } from "../../../packages/domain/screening-rules";
import {
  DecisionEvidence,
  FeedbackHistory,
  EventReplay,
} from "./EventEvidence";

type Page = "candidates" | "research" | "events";
type Period = "1D" | "1m" | "5m";
type ConflictTarget =
  | { kind: "plan"; planId: string; context: string; version: number }
  | { kind: "funds"; generation: number };
type ConflictReview = {
  requestId: string;
  target: ConflictTarget;
  loaded: boolean;
  latestPlan: Plan | null;
  latestFunds: Funds | null;
};
type ChartData = {
  bars: Bar[];
  ema9: (string | null)[];
  ema21: (string | null)[];
  ema50: (string | null)[];
  avwap: (string | null)[];
  synthetic: boolean;
};
const EMPTY_CHART: ChartData = {
  bars: [],
  ema9: [],
  ema21: [],
  ema50: [],
  avwap: [],
  synthetic: false,
};
const EMPTY_BOOT: Bootstrap = {
  demo: false,
  capabilities: [],
  instruments: [],
  plans: [],
  funds: null,
  events: [],
  eventPage: {
    events: [],
    beforeCursor: null,
    afterCursor: null,
    feedCursor: "",
    feedRevision: 0,
    feedEpoch: "",
    hasMore: false,
    counts: { total: 0, unread: 0, pending: 0, taken: 0, skipped: 0 },
  },
  screeningConfirmed: false,
  screeningRules: {
    version: 0,
    current: null,
    defaultParameters: DEFAULT_SCREENING_PARAMETERS,
  },
  universeRevision: "",
};
const blankPlan = (instrumentId = ""): PlanInput => ({
  instrumentId,
  anchorTime: null,
  primarySupport: "",
  lower: "",
  upper: "",
  stop: "",
  entryMin: "",
  entryMax: "",
  mode: "CLOSE_CONFIRM",
  sessionDate: new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  }),
  reason: "",
  backgroundConfirmed: false,
  supportSelections: [],
});
const planState: Record<string, string> = {
  DRAFT: "草稿",
  WAIT_RETEST: "等待首次回踩",
  ARMED: "已确认回踩",
  PAUSED: "已暂停",
  DATA_PAUSED: "数据暂停",
  INVALID: "计划失效",
  EXPIRED: "本次已到期",
  TRIGGERED: "条件已触发",
  ENTRY_TRIGGERED: "条件已触发",
  BLOCKED: "检查阻断",
  TAKEN: "已交易",
  SKIPPED: "已跳过",
  ACTIVE: "观察中",
  RISK_BLOCKED: "风险检查阻断",
};
const candidateState: Record<string, string> = {
  PASS: "筛选通过",
  FAIL: "未通过",
  UNKNOWN: "数据待确认",
  MANUAL: "人工加入",
};
function healthReason(reason: string): string {
  return (
    (
      {
        MISSING_HISTORY: "尚无完成日线",
        INSUFFICIENT_HISTORY: "完成日线数量不足",
        HISTORY_NOT_VERIFIED: "历史来源尚未验证",
        ADJUSTMENT_PROVENANCE_UNVERIFIED: "复权来源尚未验证",
        SYNTHETIC_FIXTURE: "合成演练输入",
        SYNTHETIC_DATA: "合成演练输入",
        SYNTHETIC_FIXTURE_NOT_LIVE: "合成演练输入，非实时行情",
        UNFINISHED_BARS_EXCLUDED: "已排除未完成日线",
        FUTURE_INPUTS_EXCLUDED: "已排除未来输入",
        SCREENING_RULES_UNCONFIRMED: "筛选参数尚未确认",
      } as Record<string, string>
    )[reason] ?? reason
  );
}
const capabilityLabel: Record<string, string> = {
  UNKNOWN: "能力待验证",
  EOD_ONLY: "仅收盘研究",
  DELAYED: "延迟行情",
  LIVE_CLOSED_BAR: "实时收盘确认",
  LIVE_TICK: "实时逐笔",
};
const eventLabel: Record<string, string> = {
  ENTRY_TRIGGERED: "技术条件满足",
  TECHNICAL_TRIGGER: "技术条件满足",
  TECHNICAL_TRIGGERED: "技术条件满足",
  RISK_BLOCKED: "风险检查阻断",
  DATA_PAUSED: "数据监测暂停",
  BREAKOUT_FADED: "突破后回落",
  STOP_REFERENCE_TOUCHED: "触及止损参考",
  EXPIRED: "观察窗口结束",
  PLAN_ACTIVATED: "开始观察",
  PLAN_PAUSED: "观察已暂停",
  HISTORICAL_MATCH: "历史条件命中",
  HISTORICAL_TRIGGERED: "合成演练 · 条件命中",
  LATE_TECHNICAL_REFERENCE: "迟到技术参考",
};
function num(value: string | number | null | undefined, digits = 2) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      })
    : "—";
}
function pct(value: string | null | undefined) {
  return value == null
    ? "—"
    : `${Number(value) >= 0 ? "+" : ""}${num(Number(value) * 100)}%`;
}
function compact(value: string | null | undefined) {
  if (value == null) return "—";
  const n = Number(value);
  return n >= 1e8
    ? `${num(n / 1e8, 1)} 亿`
    : n >= 1e4
      ? `${num(n / 1e4, 1)} 万`
      : num(n, 0);
}
function when(value: number | null | undefined) {
  return value
    ? `${new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" })} UTC`
    : "未确认";
}
function shortDate(value: number | null) {
  return value ? new Date(value * 1000).toISOString().slice(0, 10) : "尚未选择";
}
function canRecord(event: DecisionEvent | DecisionEventSummary) {
  return "recordable" in event
    ? event.recordable
    : event.type === "ENTRY_TRIGGERED" ||
        (event.type === "HISTORICAL_TRIGGERED" &&
          event.snapshot.synthetic === true);
}
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    chart: (
      <>
        <path d="M3 3v18h18" />
        <path d="m6 15 4-5 4 3 6-8" />
      </>
    ),
    bell: (
      <>
        <path d="M5 16V9a7 7 0 0 1 14 0v7l2 3H3l2-3Z" />
        <path d="M9 22h6" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" fill="currentColor" />
        <circle cx="15" cy="17" r="3" fill="currentColor" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-2l2 7M4 12l2 7a7 7 0 0 0 12-2" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V6a4 4 0 0 1 8 0v4" />
        <path d="M12 14v3" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7v1" />
      </>
    ),
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    play: <path d="m7 4 14 8-14 8V4Z" />,
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] || paths.info}
    </svg>
  );
}
function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const control = isValidElement<{ id?: string; "aria-describedby"?: string }>(
    children,
  )
    ? children
    : null;
  const id = control?.props.id ?? generatedId;
  const helpId = `${generatedId}-help`;
  const describedBy =
    [control?.props["aria-describedby"], help ? helpId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control
        ? cloneElement(control, { id, "aria-describedby": describedBy })
        : children}
      {help && <small id={helpId}>{help}</small>}
    </div>
  );
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <Icon name="chart" size={30} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<{
    authenticated: boolean;
    configured: boolean;
    demo: boolean;
  } | null>(null);
  const [boot, setBoot] = useState<Bootstrap>(EMPTY_BOOT);
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [candidatePage, setCandidatePage] = useState<CandidatePage | null>(
    null,
  );
  const [screeningSettings, setScreeningSettings] = useState<ScreeningSettings>(
    EMPTY_BOOT.screeningRules,
  );
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [universe, setUniverse] = useState<UniverseSnapshot | null>(null);
  const [coverage, setCoverage] = useState(0);
  const eventFeed = useEventFeed(Boolean(session?.authenticated));
  const { events, counts: eventCounts, stream } = eventFeed;
  const [eventDetail, setEventDetail] = useState<DecisionEvent | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailLoadSeq = useRef(0);
  const [page, setPage] = useState<Page>("candidates");
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    error: boolean;
    conflict?: boolean;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [market, setMarket] = useState<"US" | "CN">("US");
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sort, setSort] = useState("rank");
  const [addOpen, setAddOpen] = useState<"single" | "batch" | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [plan, setPlan] = useState<PlanInput>(blankPlan());
  const [savedPlan, setSavedPlan] = useState<Plan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [period, setPeriod] = useState<Period>("1D");
  const [chart, setChart] = useState<ChartData>(EMPTY_CHART);
  const [chartLoading, setChartLoading] = useState(false);
  const [risk, setRisk] = useState<RiskResult | null>(null);
  const [supportResult, setSupportResult] = useState<{
    key: string;
    snapshot: SupportSnapshot | null;
    error: string | null;
  } | null>(null);
  const supportKey = JSON.stringify({
    instrumentId: selectedId,
    anchorTime: plan.anchorTime,
    primarySupport: plan.primarySupport,
    supportSelections: plan.supportSelections ?? [],
    ...(plan.sessionDate ? { sessionDate: plan.sessionDate } : {}),
  });
  const supportPreview =
    supportResult?.key === supportKey ? supportResult.snapshot : null;
  const supportLoading = Boolean(
    selectedId && plan.primarySupport && supportResult?.key !== supportKey,
  );
  const [feedbackHistory, setFeedbackHistory] = useState<FeedbackRevision[]>(
    [],
  );
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackConflict, setFeedbackConflict] = useState<{
    eventId: string;
    loaded: boolean;
  } | null>(null);
  const feedbackTouched = useRef({
    note: false,
    price: false,
    quantity: false,
    time: false,
  });
  const feedbackLoadSeq = useRef(0);
  const feedbackContext = useRef<string | null>(null);
  const [eventFilter, setEventFilter] = useState("ALL");
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [actualPrice, setActualPrice] = useState("");
  const [actualQuantity, setActualQuantity] = useState("");
  const [actualTime, setActualTime] = useState("");
  const [fundsForm, setFundsForm] = useState<Funds | null>(null);
  const [fundsGeneration, setFundsGeneration] = useState(0);
  const [existingText, setExistingText] = useState("");
  const [fxTime, setFxTime] = useState("");
  const [fundsConfirmed, setFundsConfirmed] = useState(false);
  const [conflictReview, setConflictReview] = useState<ConflictReview | null>(
    null,
  );
  const planEditSeq = useRef(0);
  const researchContext = useRef("");
  researchContext.current = `${selectedId}:${savedPlan?.id || "new"}`;
  const priceProposalSeq = useRef(0);
  const priceProposalContext = useRef("");
  const refreshSeq = useRef(0);
  async function refresh(updateSelected = false) {
    const context = priceProposalContext.current;
    const requested = ++refreshSeq.current;
    setCandidateLoading(true);
    setCandidateError(null);
    try {
      let response: [Bootstrap, CandidatePage, UniverseSnapshot] | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const values = await Promise.all([
          api<Bootstrap>("/bootstrap"),
          api<CandidatePage>("/candidates"),
          api<UniverseSnapshot>("/universe"),
        ]);
        if (requested !== refreshSeq.current) return;
        const [bootstrap, page, list] = values;
        if (
          bootstrap.universeRevision === page.universeRevision &&
          page.universeRevision === list.universeRevision &&
          bootstrap.screeningRules.version === page.rules.version &&
          bootstrap.screeningRules.current?.hash === page.rules.current?.hash
        ) {
          response = values;
          break;
        }
      }
      if (!response)
        throw new Error(
          "列表或筛选规则连续发生变更，未覆盖当前结果，请稍后刷新",
        );
      const [b, c, u] = response;
      if (requested !== refreshSeq.current) return;
      setBoot(b);
      setCandidates(c.candidates);
      setCandidatePage(c);
      setScreeningSettings(b.screeningRules);
      setUniverse(u);
      setCoverage(c.coverage);
      eventFeed.acceptPage(b.eventPage);
      if (
        updateSelected &&
        context === priceProposalContext.current &&
        savedPlan
      )
        setSavedPlan(
          b.plans.find((row) => row.id === savedPlan.id) ?? savedPlan,
        );
    } catch (error) {
      if (requested !== refreshSeq.current) return;
      setCandidateError(
        error instanceof Error ? error.message : "候选结果读取失败",
      );
      throw error;
    } finally {
      if (requested === refreshSeq.current) setCandidateLoading(false);
    }
  }

  async function action(
    fn: () => Promise<void>,
    success?: string,
    conflictTarget?: ConflictTarget,
  ) {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice({ text: success, error: false });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && conflictTarget) {
        setConflictReview({
          requestId: crypto.randomUUID(),
          target: conflictTarget,
          loaded: false,
          latestPlan: null,
          latestFunds: null,
        });
        if (conflictTarget.kind === "funds") setFundsConfirmed(false);
      }
      setNotice({
        text: e instanceof Error ? e.message : "操作未完成，请稍后重试。",
        error: true,
        conflict: e instanceof ApiError && e.status === 409,
      });
    } finally {
      setBusy(false);
    }
  }
  async function readConflict() {
    if (!conflictReview) return;
    const pending = conflictReview;
    await action(async () => {
      const latest = await api<Bootstrap>("/bootstrap");
      setBoot(latest);
      eventFeed.acceptPage(latest.eventPage);
      const target = pending.target;
      setConflictReview((current) =>
        current?.requestId === pending.requestId
          ? {
              ...current,
              loaded: true,
              latestPlan:
                target.kind === "plan"
                  ? (latest.plans.find((p) => p.id === target.planId) ?? null)
                  : null,
              latestFunds: latest.funds,
            }
          : current,
      );
    }, "已读取服务端最新内容。请核对下方对照，当前输入和提交基线尚未改变。");
  }
  function adoptConflictBaseline() {
    if (!conflictReview?.loaded) return;
    if (conflictReview.target.kind === "plan") {
      if (
        conflictReview.target.context !== researchContext.current ||
        !conflictReview.latestPlan
      )
        return;
      setSavedPlan(conflictReview.latestPlan);
      setDirty(true);
      setRisk(null);
      setNotice({
        text: `已保留输入，基于服务端版本 ${conflictReview.latestPlan.version} 继续编辑。请核对后保存新版本。`,
        error: false,
      });
    } else {
      setFundsGeneration(conflictReview.latestFunds?.generation ?? 0);
      setFundsConfirmed(false);
      setNotice({
        text: "已保留输入并更新资金版本基线。请重新核对券商现金、已有敞口和资金变化，再勾选确认并保存；系统没有重试提交。",
        error: false,
      });
    }
    setConflictReview(null);
  }
  useEffect(() => {
    api<{ authenticated: boolean; configured: boolean; demo: boolean }>(
      "/session",
    )
      .then(setSession)
      .catch((e) => setNotice({ text: e.message, error: true }));
  }, []);
  useEffect(() => {
    if (!session?.authenticated) return;
    void action(refresh);
    const id = feedbackContext.current;
    if (id) {
      setFeedbackConflict({ eventId: id, loaded: false });
      void loadEventDetail(id);
    }
  }, [session?.authenticated]);
  useEffect(() => {
    if (!eventFeed.authExpired) return;
    refreshSeq.current++;
    detailLoadSeq.current++;
    feedbackLoadSeq.current++;
    setEventDetail(null);
    setFeedbackHistory([]);
    setFeedbackLoading(false);
    setSession((current) =>
      current ? { ...current, authenticated: false } : current,
    );
    setNotice({
      text: "登录已过期。重新登录后可继续，当前输入已保留。",
      error: true,
    });
  }, [eventFeed.authExpired]);
  useEffect(() => {
    const id = feedbackContext.current;
    if (!id || eventFeed.resetVersion === 0) return;
    feedbackLoadSeq.current++;
    setFeedbackHistory([]);
    setFeedbackLoading(false);
    setEventDetail(null);
    setFeedbackConflict({ eventId: id, loaded: false });
    void loadEventDetail(id);
  }, [eventFeed.resetVersion]);
  useEffect(() => {
    if (!selectedId) {
      setChart(EMPTY_CHART);
      return;
    }
    let active = true;
    setChartLoading(true);
    api<ChartData>(
      `/instruments/${encodeURIComponent(selectedId)}/bars?period=${period}&anchorTime=${plan.anchorTime ?? 0}`,
    )
      .then((data) => {
        if (active) setChart(data);
      })
      .catch((e) => {
        if (active) {
          setChart(EMPTY_CHART);
          setNotice({ text: e.message, error: true });
        }
      })
      .finally(() => {
        if (active) setChartLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId, period, plan.anchorTime, candidates]);
  useEffect(() => {
    if (!selectedId || !plan.primarySupport) return;
    let active = true;
    const timer = window.setTimeout(() => {
      api<SupportSnapshot>(
        "/plans/support-preview",
        "POST",
        JSON.parse(supportKey),
      )
        .then((snapshot) => {
          if (active)
            setSupportResult({ key: supportKey, snapshot, error: null });
        })
        .catch((e: Error) => {
          if (active)
            setSupportResult({
              key: supportKey,
              snapshot: null,
              error: e.message,
            });
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [supportKey, selectedId, plan.primarySupport]);
  useEffect(() => {
    if (!settings) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [settings]);
  const instrument =
    boot.instruments.find((i) => i.id === selectedId) ||
    candidates.find((c) => c.instrument.id === selectedId)?.instrument;
  const candidate = candidates.find((c) => c.instrument.id === selectedId);
  const currentCapability = boot.capabilities.find(
    (c) => c.market === instrument?.market,
  );
  const monitorUnavailable = boot.demo
    ? ""
    : !instrument?.rulesVerified
      ? "证券规则尚未核验，暂不可启用观察。"
      : plan.mode === "INTRABAR_CROSS" &&
          currentCapability?.level !== "LIVE_TICK"
        ? "需要经验证的连续实时逐笔数据。"
        : !["LIVE_CLOSED_BAR", "LIVE_TICK"].includes(
              currentCapability?.level || "UNKNOWN",
            )
          ? "行情能力尚未达到实时观察要求，当前仅供研究。"
          : "";
  const unread = eventCounts.unread;
  const activeCount = boot.plans.filter((p) =>
    ["WAIT_RETEST", "ARMED", "DATA_PAUSED", "TRIGGERED"].includes(p.status),
  ).length;
  const tagOptions = [...new Set(candidates.flatMap((c) => c.tags))];
  const visibleCandidates = useMemo(
    () =>
      candidates
        .filter(
          (c) =>
            c.instrument.market === market &&
            (filter === "ALL" ||
              (filter === "MANUAL"
                ? c.manual
                : c.screeningStatus === filter)) &&
            (!tagFilter || c.tags.includes(tagFilter)) &&
            `${c.instrument.symbol} ${c.instrument.name} ${c.tags.join(" ")}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort((a, b) => {
          if (sort === "rank")
            return (
              (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
              a.instrument.symbol.localeCompare(b.instrument.symbol)
            );
          const av = a.indicators[sort as keyof typeof a.indicators],
            bv = b.indicators[sort as keyof typeof b.indicators];
          return (
            (bv == null ? -Infinity : Number(bv)) -
              (av == null ? -Infinity : Number(av)) ||
            a.instrument.symbol.localeCompare(b.instrument.symbol)
          );
        }),
    [candidates, market, filter, tagFilter, search, sort],
  );
  const displayedEvents = events.filter(
    (e) =>
      eventFilter === "ALL" ||
      (eventFilter === "UNREAD" && !e.read) ||
      (eventFilter === "PENDING" && !e.feedback && canRecord(e)) ||
      e.feedback === eventFilter,
  );
  const selectedSummary = events.find((row) => row.id === selectedEvent);
  const event =
    eventDetail?.id === selectedEvent
      ? {
          ...eventDetail,
          read: selectedSummary?.read ?? eventDetail.read,
          feedback: selectedSummary?.feedback ?? eventDetail.feedback,
        }
      : null;
  const remoteFeedbackChanged = Boolean(
    selectedSummary?.feedbackRevisionId &&
    !feedbackLoading &&
    selectedSummary.feedbackRevisionId !== (feedbackHistory.at(-1)?.id ?? null),
  );
  priceProposalContext.current = JSON.stringify([
    selectedId,
    period,
    savedPlan?.id,
    savedPlan?.version,
    instrument,
  ]);
  function openResearch(id: string, existing?: Plan) {
    planEditSeq.current++;
    setSelectedId(id);
    const latest =
      existing ||
      boot.plans
        .filter((p) => p.instrumentId === id)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    setSavedPlan(latest || null);
    setPlan(latest ? { ...latest } : blankPlan(id));
    setDirty(false);
    setRisk(null);
    setPage("research");
  }
  function updatePlan<K extends keyof PlanInput>(key: K, value: PlanInput[K]) {
    planEditSeq.current++;
    setPlan((p) => ({ ...p, [key]: value }));
    setDirty(true);
    setRisk(null);
  }
  async function proposeChartPrice(
    field: PlanPriceField,
    proposal: ChartPriceProposal,
  ) {
    const requested = ++priceProposalSeq.current;
    const context = priceProposalContext.current;
    const editing = planEditSeq.current;
    const result = await api<{
      price: string;
      tick: string;
      instrumentRevision: string;
    }>(
      `/instruments/${encodeURIComponent(selectedId)}/price-proposal`,
      "POST",
      proposal,
    );
    if (
      requested !== priceProposalSeq.current ||
      context !== priceProposalContext.current ||
      editing !== planEditSeq.current
    )
      throw new Error("草稿已变更，本次调价已取消。");
    if (result.tick !== instrument?.tick)
      throw new Error("证券变价规则已变更，请刷新研究页面后重新调价。");
    updatePlan(field, result.price);
  }
  function setSamplePlan() {
    planEditSeq.current++;
    setPlan((p) => ({
      ...p,
      sessionDate: "2026-10-09",
      primarySupport: "100",
      lower: "99.75",
      upper: "100.25",
      stop: "99.40",
      entryMin: "100.61",
      entryMax: "101.50",
      reason: "合成示例：确认价格从支撑区上方回踩，观察之后的首次突破。",
      backgroundConfirmed: false,
      supportSelections: [
        { source: "EMA9" },
        {
          source: "HORIZONTAL",
          id: "demo-level-100",
          label: "合成水平支撑",
          price: "100",
        },
      ],
    }));
    setDirty(true);
    setRisk(null);
  }
  async function savePlan(e: FormEvent) {
    e.preventDefault();
    if (conflictReview?.target.kind === "plan") {
      setNotice({
        text: "请先核对冲突版本，并明确选择提交基线。当前输入已保留。",
        error: true,
      });
      return;
    }
    const editing = planEditSeq.current;
    const context = researchContext.current;
    await action(
      async () => {
        const result = await api<Plan>(
          savedPlan ? `/plans/${savedPlan.id}/versions` : "/plans",
          "POST",
          savedPlan ? { ...plan, expectedVersion: savedPlan.version } : plan,
        );
        if (context === researchContext.current) {
          setSavedPlan(result);
          if (editing === planEditSeq.current) {
            setPlan({ ...result });
            setDirty(false);
          }
        }
        await refresh();
      },
      savedPlan ? "已保存新计划版本，原有记录保持不变。" : "研究计划已保存。",
      savedPlan
        ? {
            kind: "plan",
            planId: savedPlan.id,
            context,
            version: savedPlan.version,
          }
        : undefined,
    );
  }
  function openSettings() {
    if (conflictReview?.target.kind === "funds" && fundsForm) {
      setSettings(true);
      return;
    }
    const f = boot.funds;
    setFundsGeneration(f?.generation || 0);
    setFundsForm(
      f
        ? {
            ...f,
            cash: { ...f.cash },
            fx: { ...f.fx },
            existing: { ...f.existing },
          }
        : {
            generation: 0,
            nav: "",
            baseCurrency: "USD",
            cash: { USD: "", CNY: "" },
            existing: {},
            riskBudget: "",
            riskPool: "",
            maxWeight: "",
            fx: { USD: "1", CNY: "" },
            fxAsOf: 0,
            confirmedAt: 0,
            stale: false,
            buyFee: "",
            sellFee: "",
            slippageIn: "",
            slippageOut: "",
            feesConfirmed: false,
          },
    );
    setExistingText(
      f
        ? Object.entries(f.existing)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n")
        : "",
    );
    setFxTime(
      f?.fxAsOf
        ? new Date(f.fxAsOf - new Date().getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : "",
    );
    setFundsConfirmed(false);
    setSettings(true);
  }
  function sampleFunds() {
    setFundsForm((f) => ({
      ...f!,
      nav: "10000",
      baseCurrency: "USD",
      cash: { USD: "10000", CNY: "0" },
      riskBudget: "50",
      riskPool: "100",
      maxWeight: "0.2",
      fx: { USD: "1", CNY: "0.14" },
      buyFee: "0",
      sellFee: "0",
      slippageIn: "0",
      slippageOut: "0",
      feesConfirmed: true,
    }));
    setExistingText("");
    setFxTime(
      new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16),
    );
    setFundsConfirmed(false);
  }
  async function saveFunds(e: FormEvent) {
    e.preventDefault();
    if (!fundsForm) return;
    if (conflictReview?.target.kind === "funds" || !fundsConfirmed) {
      setNotice({
        text: "请先核对资金版本，并重新确认当前账户快照。输入已保留。",
        error: true,
      });
      return;
    }
    await action(
      async () => {
        const existing: Record<string, string> = {};
        for (const line of existingText.split("\n").filter((l) => l.trim())) {
          const parts = line.split("=");
          if (
            parts.length !== 2 ||
            !parts[0].trim() ||
            !Number.isFinite(Number(parts[1])) ||
            Number(parts[1]) < 0
          )
            throw new Error(
              "已有敞口请按「标的 ID=基础币种金额」填写，每行一个。",
            );
          existing[parts[0].trim()] = parts[1].trim();
        }
        const result = await api<Funds>("/funds", "POST", {
          ...fundsForm,
          existing,
          fxAsOf: fxTime ? new Date(fxTime).getTime() : 0,
          confirmedAt: Date.now(),
          stale: false,
          expectedGeneration: fundsGeneration,
        });
        setFundsForm(result);
        setFundsGeneration(result.generation);
        setFundsConfirmed(false);
        await refresh();
      },
      "资金快照已确认，活动计划的占用已重新检查。",
      { kind: "funds", generation: fundsGeneration },
    );
  }
  async function loadFeedback(id: string, prefill: boolean) {
    const requested = ++feedbackLoadSeq.current;
    setFeedbackLoading(true);
    setFeedbackError(null);
    try {
      const result = await api<{ revisions: FeedbackRevision[] }>(
        `/events/${id}/feedback`,
      );
      if (
        feedbackContext.current !== id ||
        requested !== feedbackLoadSeq.current
      )
        return false;
      setFeedbackHistory(result.revisions);
      const latest = result.revisions.at(-1);
      if (prefill && latest) {
        if (!feedbackTouched.current.note) setFeedbackNote(latest.note);
        if (!feedbackTouched.current.price)
          setActualPrice(latest.actualPrice ?? "");
        if (!feedbackTouched.current.quantity)
          setActualQuantity(
            latest.actualQuantity == null ? "" : String(latest.actualQuantity),
          );
        if (!feedbackTouched.current.time)
          setActualTime(
            latest.actualTime == null
              ? ""
              : new Date(
                  latest.actualTime -
                    new Date(latest.actualTime).getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 23),
          );
      }
      return true;
    } catch (e) {
      if (
        feedbackContext.current === id &&
        requested === feedbackLoadSeq.current
      )
        setFeedbackError(
          e instanceof Error ? e.message : "修订历史暂时无法读取。",
        );
      return false;
    } finally {
      if (
        feedbackContext.current === id &&
        requested === feedbackLoadSeq.current
      )
        setFeedbackLoading(false);
    }
  }
  async function loadEventDetail(id: string) {
    const requested = ++detailLoadSeq.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result = await api<DecisionEvent>(
        `/events/${encodeURIComponent(id)}`,
      );
      if (feedbackContext.current === id && requested === detailLoadSeq.current)
        setEventDetail(result);
    } catch (cause) {
      if (feedbackContext.current === id && requested === detailLoadSeq.current)
        setDetailError(
          cause instanceof Error ? cause.message : "判断快照暂时无法读取。",
        );
    } finally {
      if (feedbackContext.current === id && requested === detailLoadSeq.current)
        setDetailLoading(false);
    }
  }
  function openEvent(e: DecisionEventSummary) {
    if (feedbackContext.current === e.id) return;
    feedbackContext.current = e.id;
    feedbackTouched.current = {
      note: false,
      price: false,
      quantity: false,
      time: false,
    };
    setFeedbackHistory([]);
    setFeedbackConflict(null);
    setSelectedEvent(e.id);
    setEventDetail(null);
    setFeedbackNote("");
    setActualPrice("");
    setActualQuantity("");
    setActualTime("");
    void loadEventDetail(e.id);
    void loadFeedback(e.id, true);
    if (!e.read)
      void action(async () => {
        await api(`/events/${e.id}/read`, "POST");
        await refresh();
      });
  }
  async function feedback(kind: "TAKEN" | "SKIPPED") {
    if (!event || !canRecord(event)) return;
    if (
      remoteFeedbackChanged ||
      (feedbackConflict?.eventId === event.id && !feedbackConflict.loaded)
    ) {
      setNotice({
        text: "请先读取最新反馈并核对修订历史。当前输入已保留。",
        error: true,
      });
      return;
    }
    await action(
      async () => {
        if (
          actualQuantity &&
          (!Number.isSafeInteger(Number(actualQuantity)) ||
            Number(actualQuantity) <= 0)
        )
          throw new Error("实际数量应为正整数。");
        if (
          actualPrice &&
          (!Number.isFinite(Number(actualPrice)) || Number(actualPrice) <= 0)
        )
          throw new Error("实际均价应大于 0。");
        const eventId = event.id;
        try {
          await api(`/events/${eventId}/feedback`, "POST", {
            kind,
            note: feedbackNote,
            expectedRevisionId: feedbackHistory.at(-1)?.id ?? null,
            ...(actualPrice ? { actualPrice } : {}),
            ...(actualQuantity
              ? { actualQuantity: Number(actualQuantity) }
              : {}),
            ...(actualTime
              ? { actualTime: new Date(actualTime).getTime() }
              : {}),
          });
          if (feedbackContext.current === eventId) setFeedbackConflict(null);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status === 409 &&
            error.code === "FEEDBACK_REVISION_CONFLICT" &&
            feedbackContext.current === eventId
          )
            setFeedbackConflict({ eventId, loaded: false });
          throw error;
        }
        await Promise.all([
          refresh(),
          feedbackContext.current === eventId
            ? loadFeedback(eventId, false)
            : Promise.resolve(),
        ]);
      },
      kind === "TAKEN"
        ? "已保存交易摘要。请更新资金快照后继续风险检查。"
        : "已记录跳过本次机会。",
    );
  }

  if (!session?.authenticated)
    return (
      <div className="login-page">
        <div className="login-brand">
          <Logo />
          <span>
            有依据地观察。
            <br />
            有边界地行动。
          </span>
          <small>PERSONAL RESEARCH WORKSPACE</small>
        </div>
        <main className="login-card">
          <div className="eyebrow">PULLBACK LAB / PRIVATE ACCESS</div>
          <h1>回到你的研究工作台</h1>
          <p>
            从一份清楚的计划开始，
            <br />
            记录每一次判断，以及它的依据。
          </p>
          {session?.demo && (
            <div className="callout demo">
              合成演示环境 · 不提供真实行情或交易建议
            </div>
          )}
          {notice && (
            <div role="alert" className="callout danger">
              {notice.text}
            </div>
          )}
          {session && !session.configured ? (
            <div className="callout warning">
              访问密码尚未配置。请由部署者完成私有访问设置后重新打开。
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await api("/login", "POST", { password });
                  setPassword("");
                  setSession(await api("/session"));
                });
              }}
            >
              <Field label="访问密码">
                <input
                  autoComplete="current-password"
                  type="password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="输入你的工作台密码"
                />
              </Field>
              <button
                className="button primary full"
                disabled={busy || !session}
              >
                <Icon name="lock" size={17} />
                {busy ? "正在验证…" : "进入工作台"}
                <Icon name="arrow" size={18} />
              </button>
            </form>
          )}
          <footer>仅供个人研究 · 自行在券商端交易</footer>
        </main>
      </div>
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="workspace-label">个人研究工作台</div>
        <nav aria-label="主导航">
          {(
            [
              {
                id: "candidates",
                name: "候选池",
                en: "Watchlist",
                icon: "grid",
                n: "01",
              },
              {
                id: "research",
                name: "标的与计划",
                en: "Research & plan",
                icon: "chart",
                n: "02",
              },
              {
                id: "events",
                name: "提醒与记录",
                en: "Activity",
                icon: "bell",
                n: "03",
              },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <Icon name={item.icon} />
              <span>
                {item.name}
                <small>{item.en}</small>
              </span>
              {item.id === "events" && unread > 0 ? (
                <b className="nav-count">{unread}</b>
              ) : (
                <small className="nav-number">{item.n}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="orbit-icon">↗</div>
          <strong>计划先于信号</strong>
          <p>
            候选、技术触发与实际成交，
            <br />
            分别记录，逐一确认。
          </p>
        </div>
        <button className="settings-nav" onClick={openSettings}>
          <Icon name="settings" />
          <span>设置与资金快照</span>
          <span>↗</span>
        </button>
        <div className="sidebar-bottom">
          <span className="avatar">PL</span>
          <div>
            私人工作区<small>现金做多 · 人工决策</small>
          </div>
          <button
            className="text-button"
            title="退出登录"
            onClick={() =>
              void action(async () => {
                await api("/logout", "POST");
                refreshSeq.current++;
                setSession({ ...session, authenticated: false });
                setBoot(EMPTY_BOOT);
                feedbackContext.current = null;
                detailLoadSeq.current++;
                feedbackLoadSeq.current++;
                setEventDetail(null);
                setSelectedEvent(null);
              })
            }
          >
            退出
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            研究工作台 <span>/</span>{" "}
            {page === "candidates"
              ? "候选池"
              : page === "research"
                ? "标的与计划"
                : "提醒与记录"}
          </div>
          <div className="topbar-right">
            <span className={`connection ${stream === "已连接" ? "ok" : ""}`}>
              <i />
              {stream === "已连接" ? "记录同步已连接" : stream}
            </span>
            <button
              className="icon-button mobile-settings"
              aria-label="打开设置"
              onClick={openSettings}
            >
              <Icon name="settings" />
            </button>
            <span className="top-date">
              {new Date().toLocaleDateString("zh-CN", {
                month: "long",
                day: "numeric",
                weekday: "short",
              })}
            </span>
          </div>
        </header>
        {(boot.demo || session.demo) && (
          <div className="demo-banner">
            <strong>合成演示环境</strong>
            <span>价格、图表和回放均为测试数据，不是真实行情。</span>
            <span className="demo-tag">DEMO</span>
          </div>
        )}
        {notice && !settings && (
          <div
            role="alert"
            className={`notice ${notice.error ? "error" : "success"}`}
          >
            <Icon name={notice.error ? "info" : "check"} size={18} />
            <div>
              {notice.text}
              {notice.conflict && (
                <p>输入已保留。请重新读取最新版本后核对差异，再提交。</p>
              )}
            </div>
            {notice.conflict && (
              <button
                className="text-button"
                onClick={() =>
                  conflictReview
                    ? void readConflict()
                    : void action(
                        refresh,
                        "已读取最新数据；当前表单输入仍然保留。",
                      )
                }
              >
                读取最新数据
              </button>
            )}
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setNotice(null)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        <main className="main-content">
          {page === "candidates" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">01 / DISCOVER</div>
                  <h1>
                    候选池<span className="heading-dot">.</span>
                  </h1>
                  <p>从有限股票池中寻找强势，等待一个有依据的回踩。</p>
                </div>
                <div className="heading-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void action(refresh)}
                  >
                    <Icon name="refresh" size={16} />
                    刷新
                  </button>
                  <button
                    className="button primary"
                    onClick={() =>
                      setAddOpen((o) => (o === "single" ? null : "single"))
                    }
                  >
                    <Icon name="plus" size={17} />
                    添加观察标的
                  </button>
                  <button
                    className="button secondary"
                    onClick={() =>
                      setAddOpen((o) => (o === "batch" ? null : "batch"))
                    }
                  >
                    批量导入
                  </button>
                </div>
              </div>
              <div className="stats-grid">
                <Stat
                  label="研究覆盖"
                  value={String(coverage)}
                  suffix="只"
                  detail={`本地余量 ${universe?.limits.localResearchRemaining ?? "—"} · 上限 ${universe?.limits.researchMax ?? 100} 只`}
                />
                <Stat
                  label="筛选通过"
                  value={String(
                    candidates.filter((c) => c.screeningStatus === "PASS")
                      .length,
                  )}
                  suffix="只"
                  detail="按各市场分别筛选与排序"
                />
                <Stat
                  label="观察名额占用"
                  value={String(activeCount)}
                  suffix="/ 10"
                  detail={`本地观察余量 ${Math.max(0, (universe?.limits.effectiveMonitoringMax ?? 10) - activeCount)} · 上限 10 只`}
                />
                <Stat
                  label="待阅读记录"
                  value={String(unread)}
                  suffix="条"
                  detail="保留技术判断与阻断原因"
                  accent
                />
              </div>
              <div className="market-health">
                {(["US", "CN"] as const).map((m) => {
                  const c = boot.capabilities.find((c) => c.market === m);
                  return (
                    <div key={m}>
                      <span className="market-code">{m}</span>
                      <strong>{m === "US" ? "美股" : "A 股"}</strong>
                      <Badge
                        tone={c?.level.startsWith("LIVE") ? "green" : "amber"}
                      >
                        {capabilityLabel[c?.level || "UNKNOWN"]}
                      </Badge>
                      <span className="health-reason">
                        {c?.reason || "行情权限和数据质量尚未核验"}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="quota-note" aria-label="供应商额度">
                <strong>
                  供应商额度：
                  {universe?.limits.provider.verified ? "已验证" : "未知"}
                </strong>
                <span>
                  研究证券、同时订阅、每月唯一标的与请求速率均需权限证据核验；本地余量不等于供应商余额。
                </span>
              </div>
              {candidatePage && (
                <div className="sampling-status" aria-label="行情采样状态">
                  <strong>
                    {
                      {
                        DISABLED: "行情采样未启用",
                        IDLE: "行情采样等待中",
                        POLLING: "行情采样中",
                        BACKOFF: "行情采样失败，等待重试",
                        STOPPED: "行情采样已停止",
                      }[candidatePage.workerHealth.state]
                    }
                  </strong>
                  <span>{candidatePage.workerHealth.reason}</span>
                  {candidatePage.workerHealth.state === "BACKOFF" && (
                    <span>
                      当前保留已取得的研究数据。
                      {candidatePage.workerHealth.lastErrorCode
                        ? `错误：${candidatePage.workerHealth.lastErrorCode}`
                        : ""}
                    </span>
                  )}
                </div>
              )}
              {addOpen && universe && (
                <UniverseImport
                  key={addOpen}
                  mode={addOpen}
                  initialMarket={market}
                  universe={universe}
                  onChanged={refresh}
                  onClose={() => setAddOpen(null)}
                />
              )}
              {!boot.screeningConfirmed && (
                <div className="callout screening-notice">
                  <Icon name="info" />
                  <div>
                    <strong>先确认筛选规则</strong>
                    <p>
                      当前阈值为开发测试预设。确认后采用 EMA 9/21/50、30
                      日动量、成交额及波幅筛选，不代表已验证的盈利参数。
                    </p>
                  </div>
                  <button
                    className="button secondary compact"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api("/settings/screening", "POST", {
                          confirmed: true,
                          expectedVersion: candidatePage?.rules.version ?? 0,
                          parameters:
                            candidatePage?.rules.current?.parameters ??
                            candidatePage?.rules.defaultParameters,
                        });
                        await refresh();
                      }, "已确认当前筛选预设。")
                    }
                  >
                    确认使用预设
                  </button>
                </div>
              )}
              <section
                className="panel candidate-panel"
                aria-busy={candidateLoading}
              >
                <div
                  className={`candidate-refresh-state ${candidateError ? "failed" : ""}`}
                  role="status"
                  aria-label="候选数据状态"
                  aria-live="polite"
                >
                  {candidateError
                    ? `刷新失败：${candidateError}。${candidatePage ? "已保留上次候选结果，请重试刷新。" : "尚无可用结果，请重试刷新。"}`
                    : candidateLoading
                      ? candidatePage
                        ? "正在刷新，当前保留上次候选结果。"
                        : "正在计算候选结果…"
                      : candidatePage
                        ? `${candidatePage.cacheHit ? "已读取缓存结果" : "已完成计算"} · 筛选规则第 ${candidatePage.rules.version} 版 · 计算于 ${when(candidatePage.computedAt)}`
                        : "等待加载候选结果"}
                </div>
                <div className="panel-toolbar">
                  <div className="segmented" aria-label="候选市场">
                    <button
                      className={market === "US" ? "selected" : ""}
                      onClick={() => setMarket("US")}
                    >
                      美股{" "}
                      <span>
                        {
                          candidates.filter((c) => c.instrument.market === "US")
                            .length
                        }
                      </span>
                    </button>
                    <button
                      className={market === "CN" ? "selected" : ""}
                      onClick={() => setMarket("CN")}
                    >
                      A 股{" "}
                      <span>
                        {
                          candidates.filter((c) => c.instrument.market === "CN")
                            .length
                        }
                      </span>
                    </button>
                  </div>
                  <label className="search-box">
                    <Icon name="search" size={17} />
                    <input
                      aria-label="搜索标的"
                      placeholder="搜索代码、名称或标签"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                </div>
                <div className="filter-row">
                  <div className="filter-pills">
                    {[
                      ["ALL", "全部"],
                      ["PASS", "通过"],
                      ["MANUAL", "人工观察"],
                      ["UNKNOWN", "待确认"],
                      ["FAIL", "未通过"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        className={filter === value ? "selected" : ""}
                        onClick={() => setFilter(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="filter-selects">
                    <select
                      aria-label="主题标签筛选"
                      value={tagFilter}
                      onChange={(e) => setTagFilter(e.target.value)}
                    >
                      <option value="">所有主题</option>
                      {tagOptions.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <select
                      aria-label="候选排序"
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="rank">规则排序</option>
                      <option value="r30">30 日涨幅 ↓</option>
                      <option value="r3">3 日涨幅 ↓</option>
                      <option value="adv20">日均成交额 ↓</option>
                    </select>
                  </div>
                </div>
                {visibleCandidates.length ? (
                  <div className="table-wrap">
                    <table className="candidate-table">
                      <thead>
                        <tr>
                          <th className="rank-cell">排名</th>
                          <th>标的 / 主题</th>
                          <th>30 日涨幅</th>
                          <th>3 日涨幅</th>
                          <th>20 日日均成交额</th>
                          <th>ADR20</th>
                          <th>算法结果 / 身份</th>
                          <th>数据截止 / 健康</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {visibleCandidates.map((c) => (
                          <tr
                            key={c.instrument.id}
                            onClick={() => openResearch(c.instrument.id)}
                          >
                            <td className="rank-cell">
                              {c.rank ? String(c.rank).padStart(2, "0") : "—"}
                            </td>
                            <td>
                              <button
                                className="symbol-link"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openResearch(c.instrument.id);
                                }}
                              >
                                {c.instrument.symbol}
                              </button>
                              <div className="company-name">
                                {c.instrument.name}
                              </div>
                              {c.tags.length > 0 && (
                                <div className="tag-list">
                                  {c.tags.map((t) => (
                                    <span key={t}>{t}</span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td
                              className={
                                Number(c.indicators.r30) >= 0 ? "positive" : ""
                              }
                            >
                              {pct(c.indicators.r30)}
                            </td>
                            <td
                              className={
                                Number(c.indicators.r3) >= 0 ? "positive" : ""
                              }
                            >
                              {pct(c.indicators.r3)}
                            </td>
                            <td>
                              {compact(c.indicators.adv20)}
                              <small>
                                {c.instrument.currency}
                                {c.turnoverBasis === "ESTIMATED"
                                  ? " · 估算"
                                  : c.turnoverBasis === "PROVIDER"
                                    ? " · 实际成交额"
                                    : " · 缺失"}
                              </small>
                            </td>
                            <td>
                              {c.indicators.adr20 == null
                                ? "—"
                                : `${num(c.indicators.adr20)}%`}
                            </td>
                            <td>
                              <Badge
                                tone={
                                  c.screeningStatus === "PASS"
                                    ? "green"
                                    : c.screeningStatus === "UNKNOWN"
                                      ? "amber"
                                      : "neutral"
                                }
                              >
                                {candidateState[c.screeningStatus]}
                              </Badge>
                              {c.manual && (
                                <div className="manual-identity">人工观察</div>
                              )}
                              <div className="table-reason">
                                {c.reasons[0] || "查看研究依据"}
                              </div>
                            </td>
                            <td className="candidate-health-cell">
                              <strong>
                                {c.dataCutoff === null
                                  ? "暂无完成日线"
                                  : c.date}
                              </strong>
                              <small>
                                {c.health.state === "SYNTHETIC"
                                  ? "合成数据"
                                  : c.health.state === "MISSING"
                                    ? "缺少历史数据"
                                    : "数据待核验"}
                              </small>
                              <div className="table-reason">
                                {c.health.reasons.map(healthReason).join("；")}
                              </div>
                            </td>
                            <td>
                              <Icon name="arrow" size={18} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title={
                      candidates.length
                        ? "没有符合条件的标的"
                        : "从第一只观察标的开始"
                    }
                    text={
                      candidates.length
                        ? "试试其他市场、筛选条件或搜索词。"
                        : "添加你关注的证券。行情权限和数据未就绪时，研究状态会如实显示为待确认。"
                    }
                  >
                    {boot.demo && candidates.length === 0 ? (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await api("/demo/seed", "POST");
                            await refresh();
                          }, "合成示例已载入。所有数据仅用于演示。")
                        }
                      >
                        载入合成示例数据
                        <Icon name="arrow" size={17} />
                      </button>
                    ) : null}
                  </Empty>
                )}
                <div className="panel-foot">
                  <span>
                    本页 {visibleCandidates.length} 只 · 各标的数据日期见表格
                    {candidatePage && (
                      <small>
                        结果计算：{when(candidatePage.computedAt)} · 本次读取：
                        {when(candidatePage.evaluatedAt)}
                      </small>
                    )}
                  </span>
                  <span>R30 → R3 → 紧密度 → 成交额 → 代码</span>
                </div>
              </section>
              <div className="quiet-note">
                <Icon name="info" size={15} />
                <span>
                  筛选结果是研究入口。人工加入的标的独立标注；数据不足不会被当作零值，也不会自动通过。
                </span>
              </div>
            </>
          )}

          {page === "research" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">02 / BUILD A THESIS</div>
                  <h1>
                    标的与计划<span className="heading-dot">.</span>
                  </h1>
                  <p>让支撑、入场条件与风险边界，都有明确的位置。</p>
                </div>
                <select
                  className="instrument-select"
                  aria-label="选择研究标的"
                  value={selectedId}
                  onChange={(e) => openResearch(e.target.value)}
                >
                  <option value="">选择观察标的</option>
                  {boot.instruments.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.symbol} · {i.name}
                    </option>
                  ))}
                </select>
              </div>
              {!instrument ? (
                <section className="panel">
                  <Empty
                    title="选择一个标的，建立你的计划"
                    text="从候选池进入研究，查看日线背景，再确认支撑与允许入场的区间。"
                  >
                    <button
                      className="button primary"
                      onClick={() => setPage("candidates")}
                    >
                      前往候选池
                      <Icon name="arrow" size={17} />
                    </button>
                  </Empty>
                </section>
              ) : (
                <>
                  <div className="instrument-strip">
                    <div>
                      <span className="instrument-avatar">
                        {instrument.symbol.slice(0, 2)}
                      </span>
                      <div>
                        <h2>
                          {instrument.symbol}
                          <Badge>
                            {instrument.market === "US" ? "美股" : "A 股"}
                          </Badge>
                        </h2>
                        <p>
                          {instrument.name} <span>·</span> {instrument.currency}
                        </p>
                      </div>
                    </div>
                    <div className="instrument-metrics">
                      <div>
                        <small>30 日涨幅</small>
                        <strong className="positive">
                          {pct(candidate?.indicators.r30)}
                        </strong>
                      </div>
                      <div>
                        <small>ATR14</small>
                        <strong>{num(candidate?.indicators.atr14)}</strong>
                      </div>
                      <div>
                        <small>最小数量 / 步长</small>
                        <strong>
                          {instrument.qMin} / {instrument.qStep}
                        </strong>
                      </div>
                    </div>
                  </div>
                  {instrument.market === "CN" && (
                    <div className="callout warning">
                      <Icon name="info" />
                      <div>
                        <strong>A 股研究限制</strong>
                        <p>
                          {instrument.sellSameDay
                            ? "请核对该证券的当日可卖规则。"
                            : "普通 A 股新买入股票当日通常不可卖，不能依靠当天卖出来执行紧止损。"}
                          支持研究不等于可以直接使用美股日内方法。
                        </p>
                      </div>
                    </div>
                  )}
                  <div className="research-grid">
                    <div className="research-main">
                      <section className="panel chart-panel">
                        <div className="panel-toolbar">
                          <div>
                            <h3>价格与关键位置</h3>
                            <small>
                              {chart.synthetic ? "合成价格 · " : ""}
                              {chart.bars.length
                                ? `截至 ${new Date(chart.bars.at(-1)!.time * 1000).toLocaleString("zh-CN", { hour12: false })}`
                                : "尚无可用行情"}
                            </small>
                          </div>
                          <div className="segmented">
                            {(["1D", "1m", "5m"] as const).map((p) => (
                              <button
                                key={p}
                                className={period === p ? "selected" : ""}
                                onClick={() => setPeriod(p)}
                              >
                                {p === "1D"
                                  ? "日线"
                                  : p === "1m"
                                    ? "1 分钟"
                                    : "5 分钟"}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="chart-container">
                          {chartLoading && (
                            <div className="chart-loading">正在读取图表…</div>
                          )}
                          <ResearchChart
                            {...chart}
                            period={period}
                            plan={plan}
                            instrumentTick={instrument.tick}
                            onPriceProposal={proposeChartPrice}
                            onAnchor={(time) => updatePlan("anchorTime", time)}
                          />
                        </div>
                        <div className="chart-help">
                          <Icon name="info" size={15} />
                          {period === "1D"
                            ? "点击已完成日线设置 AVWAP 锚点；开启图表调价后可拖动价格线，或使用最小变价单位按钮微调。"
                            : "AVWAP 固定采用已完成日线的基准值，分钟图展示同一参考，不重新计算分钟锚点。"}
                        </div>
                      </section>
                      <section className="panel research-evidence">
                        <div className="section-heading">
                          <h3>研究依据</h3>
                          <Badge
                            tone={
                              candidate?.screeningStatus === "PASS"
                                ? "green"
                                : "amber"
                            }
                          >
                            {
                              candidateState[
                                candidate?.screeningStatus || "UNKNOWN"
                              ]
                            }
                          </Badge>
                        </div>
                        <div className="evidence-grid">
                          <div>
                            <small>EMA9 / EMA21 / EMA50</small>
                            <strong>
                              {num(candidate?.indicators.ema9)} /{" "}
                              {num(candidate?.indicators.ema21)} /{" "}
                              {num(candidate?.indicators.ema50)}
                            </strong>
                          </div>
                          <div>
                            <small>3 日紧密度</small>
                            <strong>
                              {candidate?.indicators.tight3 == null
                                ? "—"
                                : `${num(Number(candidate.indicators.tight3) * 100)}%`}
                            </strong>
                          </div>
                          <div>
                            <small>日线 AVWAP 锚点</small>
                            <strong>{shortDate(plan.anchorTime)}</strong>
                          </div>
                          <div>
                            <small>行情能力</small>
                            <strong>
                              {
                                capabilityLabel[
                                  boot.capabilities.find(
                                    (c) => c.market === instrument.market,
                                  )?.level || "UNKNOWN"
                                ]
                              }
                            </strong>
                          </div>
                        </div>
                        <ul className="reason-list">
                          {(candidate?.reasons.length
                            ? candidate.reasons
                            : candidate?.screeningStatus === "PASS"
                              ? ["当前输入通过已确认的工程筛选条件。"]
                              : ["尚无足够数据，暂不判断筛选条件。"]
                          ).map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                        {universe && (
                          <ObservationEditor
                            key={instrument.id}
                            instrument={instrument}
                            initialTags={candidate?.tags ?? []}
                            initialNote={candidate?.note ?? ""}
                            revision={universe.universeRevision}
                            onChanged={refresh}
                            onDeleted={() =>
                              setSelectedId((current) =>
                                current === instrument.id ? "" : current,
                              )
                            }
                          />
                        )}
                      </section>
                      {boot.plans.filter((p) => p.instrumentId === selectedId)
                        .length > 0 && (
                        <section className="panel plan-history">
                          <div className="section-heading">
                            <h3>已保存计划</h3>
                            <button
                              className="text-button"
                              onClick={() => {
                                planEditSeq.current++;
                                setSavedPlan(null);
                                setPlan(blankPlan(selectedId));
                                setDirty(false);
                                setRisk(null);
                              }}
                            >
                              创建新计划
                            </button>
                          </div>
                          {boot.plans
                            .filter((p) => p.instrumentId === selectedId)
                            .map((p) => (
                              <button
                                key={p.id}
                                className={`plan-row ${p.id === savedPlan?.id ? "selected" : ""}`}
                                onClick={() => openResearch(selectedId, p)}
                              >
                                <span>
                                  计划 · v{p.version}
                                  <small>
                                    {p.sessionDate} ·{" "}
                                    {p.mode === "CLOSE_CONFIRM"
                                      ? "收盘确认"
                                      : "盘中穿越"}
                                  </small>
                                </span>
                                <Badge>{planState[p.status] || p.status}</Badge>
                                <Icon name="arrow" size={16} />
                              </button>
                            ))}
                        </section>
                      )}
                    </div>
                    <aside className="plan-column">
                      <section className="panel plan-editor">
                        <div className="section-heading">
                          <div>
                            <div className="eyebrow">TRADE THESIS</div>
                            <h3>回踩计划</h3>
                          </div>
                          <Badge>
                            {savedPlan
                              ? `版本 ${savedPlan.version}${dirty ? " · 未保存" : ""}`
                              : "新计划"}
                          </Badge>
                        </div>
                        <p
                          className="plan-rule-version"
                          aria-label="计划筛选规则版本"
                        >
                          {savedPlan
                            ? savedPlan.screeningRuleSnapshot
                              ? `此计划绑定筛选规则第 ${savedPlan.screeningRuleSnapshot.version} 版`
                              : "此计划未记录筛选规则版本，不补用当前规则"
                            : "新计划将在保存时记录当时的筛选规则"}{" "}
                          · 当前候选使用第 {candidatePage?.rules.version ?? 0}{" "}
                          版
                        </p>
                        {conflictReview?.target.kind === "plan" && (
                          <ConflictPanel
                            review={conflictReview}
                            planDraft={plan}
                            busy={busy}
                            canAdopt={
                              conflictReview.target.context ===
                              researchContext.current
                            }
                            onRead={() => void readConflict()}
                            onAdopt={adoptConflictBaseline}
                          />
                        )}
                        <form onSubmit={savePlan}>
                          <Field label="计划交易日">
                            <input
                              type="date"
                              value={plan.sessionDate}
                              required
                              onChange={(e) =>
                                updatePlan("sessionDate", e.target.value)
                              }
                            />
                          </Field>
                          <div className="field-pair">
                            <Field label="主支撑价">
                              <input
                                inputMode="decimal"
                                type="number"
                                step="any"
                                min="0.000001"
                                required
                                value={plan.primarySupport}
                                onChange={(e) =>
                                  updatePlan("primarySupport", e.target.value)
                                }
                                placeholder="未设置"
                              />
                            </Field>
                            <Field label="失效 / 止损参考">
                              <input
                                inputMode="decimal"
                                type="number"
                                step="any"
                                min="0.000001"
                                required
                                value={plan.stop}
                                onChange={(e) =>
                                  updatePlan("stop", e.target.value)
                                }
                                placeholder="低于支撑区"
                              />
                            </Field>
                          </div>
                          <SupportEditor
                            plan={plan}
                            snapshot={supportPreview}
                            loading={supportLoading}
                            error={
                              supportResult?.key === supportKey
                                ? supportResult.error
                                : null
                            }
                            legacy={Boolean(
                              savedPlan && !savedPlan.supportSnapshot,
                            )}
                            onChange={(selections) =>
                              updatePlan("supportSelections", selections)
                            }
                            onApply={(lower, upper) => {
                              planEditSeq.current++;
                              setPlan((current) => ({
                                ...current,
                                lower,
                                upper,
                              }));
                              setDirty(true);
                              setRisk(null);
                            }}
                          />
                          <div className="field-pair">
                            <Field label="支撑区下沿">
                              <input
                                inputMode="decimal"
                                type="number"
                                step="any"
                                min="0.000001"
                                required
                                value={plan.lower}
                                onChange={(e) =>
                                  updatePlan("lower", e.target.value)
                                }
                                placeholder="下沿"
                              />
                            </Field>
                            <Field label="支撑区上沿">
                              <input
                                inputMode="decimal"
                                type="number"
                                step="any"
                                min="0.000001"
                                required
                                value={plan.upper}
                                onChange={(e) =>
                                  updatePlan("upper", e.target.value)
                                }
                                placeholder="上沿"
                              />
                            </Field>
                          </div>
                          <div className="field-pair">
                            <Field label="允许入场下沿">
                              <input
                                inputMode="decimal"
                                type="number"
                                step="any"
                                min="0.000001"
                                required
                                value={plan.entryMin}
                                onChange={(e) =>
                                  updatePlan("entryMin", e.target.value)
                                }
                                placeholder="最低价"
                              />
                            </Field>
                            <Field label="允许入场上沿">
                              <input
                                inputMode="decimal"
                                type="number"
                                step="any"
                                min="0.000001"
                                required
                                value={plan.entryMax}
                                onChange={(e) =>
                                  updatePlan("entryMax", e.target.value)
                                }
                                placeholder="最高价"
                              />
                            </Field>
                          </div>
                          <div className="anchor-control">
                            <div>
                              <small>AVWAP 日线锚点</small>
                              <strong>{shortDate(plan.anchorTime)}</strong>
                            </div>
                            {plan.anchorTime && (
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => updatePlan("anchorTime", null)}
                              >
                                清除
                              </button>
                            )}
                          </div>
                          <Field label="触发方式">
                            <select
                              value={plan.mode}
                              onChange={(e) =>
                                updatePlan(
                                  "mode",
                                  e.target.value as PlanInput["mode"],
                                )
                              }
                            >
                              <option value="CLOSE_CONFIRM">
                                收盘确认 · 闭合后判断
                              </option>
                              <option
                                value="INTRABAR_CROSS"
                                disabled={
                                  !boot.demo &&
                                  boot.capabilities.find(
                                    (c) => c.market === instrument.market,
                                  )?.level !== "LIVE_TICK"
                                }
                              >
                                盘中穿越 · 需要连续实时逐笔
                              </option>
                            </select>
                          </Field>
                          <p className="field-explanation">
                            首 15 分钟观察 1 分钟 K 线，随后至开盘首小时观察 5
                            分钟 K 线；一次计划尝试只接受首次合格触发。
                          </p>
                          <Field label="计划依据">
                            <textarea
                              value={plan.reason}
                              onChange={(e) =>
                                updatePlan("reason", e.target.value)
                              }
                              rows={3}
                              placeholder="为什么选择这个支撑？什么情况下放弃？"
                              required
                            />
                          </Field>
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={plan.backgroundConfirmed}
                              onChange={(e) =>
                                updatePlan(
                                  "backgroundConfirmed",
                                  e.target.checked,
                                )
                              }
                            />
                            <span>我已确认回踩背景、支撑位置与失效条件。</span>
                          </label>
                          <button
                            className="button primary full"
                            disabled={busy}
                          >
                            {savedPlan ? "保存新版本" : "保存研究计划"}
                            <Icon name="check" size={17} />
                          </button>
                          {boot.demo && (
                            <button
                              type="button"
                              className="text-button sample-link"
                              onClick={setSamplePlan}
                            >
                              填入合成示例计划
                            </button>
                          )}
                        </form>
                      </section>
                      <section className="panel risk-panel">
                        <div className="section-heading">
                          <h3>风险与观察</h3>
                          <Badge
                            tone={
                              risk?.passed
                                ? "green"
                                : risk
                                  ? "amber"
                                  : "neutral"
                            }
                          >
                            {risk?.passed
                              ? "校验通过"
                              : risk
                                ? "暂不可启用"
                                : "待检查"}
                          </Badge>
                        </div>
                        <div className="risk-quantity">
                          <span>{risk ? risk.quantity : "—"}</span>
                          <div>
                            股<small>按当前输入估算的合法数量</small>
                          </div>
                        </div>
                        {risk && (
                          <>
                            <div className="risk-details">
                              <span>估算入场价</span>
                              <strong>
                                {num(risk.entry)} {instrument.currency}
                              </strong>
                              <span>预计现金占用</span>
                              <strong>
                                {num(risk.cashUse)} {instrument.currency}
                              </strong>
                              <span>预算风险</span>
                              <strong>
                                {num(risk.riskBase)}{" "}
                                {boot.funds?.baseCurrency || ""}
                              </strong>
                              <span>考虑滑点的止损价</span>
                              <strong>{num(risk.stopExec)}</strong>
                            </div>
                            {risk.reasons.length > 0 && (
                              <ul className="reason-list danger-text">
                                {risk.reasons.map((r) => (
                                  <li key={r}>{r}</li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                        {!boot.funds ? (
                          <p className="risk-hint">
                            请先填写净值、现金、风险预算与费用，确认人工资金快照。
                          </p>
                        ) : (
                          <p
                            className={`risk-hint ${boot.funds.stale ? "danger-text" : ""}`}
                          >
                            基于人工资金快照 · {when(boot.funds.confirmedAt)}
                            {boot.funds.stale ? " · 已过期，需重新确认" : ""}
                          </p>
                        )}
                        <button className="text-button" onClick={openSettings}>
                          查看 / 更新资金快照 ↗
                        </button>
                        <div className="risk-actions">
                          <button
                            className="button secondary full"
                            disabled={busy || !savedPlan || dirty}
                            onClick={() =>
                              void action(async () => {
                                const context = researchContext.current;
                                const editing = planEditSeq.current;
                                const result = await api<RiskResult>(
                                  `/plans/${savedPlan!.id}/risk`,
                                  "POST",
                                );
                                if (
                                  context === researchContext.current &&
                                  editing === planEditSeq.current
                                )
                                  setRisk(result);
                              })
                            }
                          >
                            检查风险数量
                          </button>
                          {savedPlan &&
                          ["WAIT_RETEST", "ARMED", "ACTIVE"].includes(
                            savedPlan.status,
                          ) ? (
                            <button
                              className="button secondary full"
                              disabled={busy || dirty}
                              onClick={() =>
                                void action(
                                  async () => {
                                    const context = researchContext.current;
                                    const result = await api<Plan>(
                                      `/plans/${savedPlan.id}/pause`,
                                      "POST",
                                      { expectedVersion: savedPlan.version },
                                    );
                                    if (context === researchContext.current)
                                      setSavedPlan(result);
                                    await refresh();
                                  },
                                  "已暂停本次观察。",
                                  {
                                    kind: "plan",
                                    planId: savedPlan.id,
                                    context: researchContext.current,
                                    version: savedPlan.version,
                                  },
                                )
                              }
                            >
                              <Icon name="pause" size={16} />
                              暂停观察
                            </button>
                          ) : (
                            <button
                              className="button primary full"
                              disabled={
                                busy ||
                                !savedPlan ||
                                dirty ||
                                !plan.backgroundConfirmed ||
                                !savedPlan?.supportSnapshot?.ready ||
                                !supportPreview?.ready ||
                                !!monitorUnavailable
                              }
                              onClick={() =>
                                void action(
                                  async () => {
                                    const context = researchContext.current;
                                    const editing = planEditSeq.current;
                                    const result = await api<{
                                      plan: Plan;
                                      risk: RiskResult;
                                    }>(
                                      `/plans/${savedPlan!.id}/activate`,
                                      "POST",
                                      { expectedVersion: savedPlan!.version },
                                    );
                                    if (context === researchContext.current) {
                                      setSavedPlan(result.plan);
                                      if (editing === planEditSeq.current)
                                        setRisk(result.risk);
                                    }
                                    await refresh();
                                  },
                                  boot.demo
                                    ? "已启用合成计划观察。"
                                    : "计划观察已启用。",
                                  {
                                    kind: "plan",
                                    planId: savedPlan!.id,
                                    context: researchContext.current,
                                    version: savedPlan!.version,
                                  },
                                )
                              }
                            >
                              <Icon name="play" size={15} />
                              {boot.demo ? "启用合成计划观察" : "启用观察"}
                            </button>
                          )}
                        </div>
                        {savedPlan && !savedPlan.supportSnapshot?.ready && (
                          <small className="disabled-reason">
                            已保存版本缺少完整支撑证据。请选择有效家族并保存新版本。
                          </small>
                        )}
                        {!!monitorUnavailable && (
                          <small className="disabled-reason">
                            {monitorUnavailable}
                          </small>
                        )}
                        {(!savedPlan || dirty) && (
                          <small className="disabled-reason">
                            {!savedPlan
                              ? "保存计划后可检查风险并启用观察。"
                              : "先保存改动，再检查和启用新版本。"}
                          </small>
                        )}
                        {boot.demo &&
                          savedPlan &&
                          savedPlan.instrumentId.startsWith("DEMO-") && (
                            <SyntheticRuntime
                              key={`${savedPlan.id}:${savedPlan.version}:${savedPlan.attemptId ?? "none"}`}
                              plan={savedPlan}
                              disabled={busy || dirty}
                              onBusyChange={setBusy}
                              onChanged={() => refresh(true)}
                            />
                          )}
                        {boot.demo && savedPlan && (
                          <button
                            className="text-button replay-button"
                            disabled={busy || dirty}
                            onClick={() =>
                              void action(async () => {
                                await api(
                                  `/demo/plans/${savedPlan.id}/replay`,
                                  "POST",
                                );
                                await refresh();
                              }, "合成回放已完成，请在「提醒与记录」查看结果。")
                            }
                          >
                            运行此计划的合成回放 →
                          </button>
                        )}
                        <p className="disclaimer">
                          止损是计划参考，不是损失上限保证。提醒不会自动下单或改变实际持仓。
                        </p>
                      </section>
                    </aside>
                  </div>
                </>
              )}
            </>
          )}

          {page === "events" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">03 / REVIEW & RECORD</div>
                  <h1>
                    提醒与记录<span className="heading-dot">.</span>
                  </h1>
                  <p>保留当时的判断，记录你做出的选择。</p>
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void action(refresh)}
                >
                  <Icon name="refresh" size={16} />
                  刷新记录
                </button>
              </div>
              <div className="event-summary">
                <div>
                  <strong>{eventCounts.total}</strong>
                  <span>全部记录</span>
                </div>
                <div>
                  <strong>{eventCounts.pending}</strong>
                  <span>待记录选择</span>
                </div>
                <div>
                  <strong>{eventCounts.taken}</strong>
                  <span>已交易</span>
                </div>
                <div>
                  <strong>{eventCounts.skipped}</strong>
                  <span>已跳过</span>
                </div>
              </div>
              <div className="events-grid">
                <section className="panel event-list">
                  <div className="filter-row">
                    <div className="filter-pills">
                      {[
                        ["ALL", "全部"],
                        ["UNREAD", "未读"],
                        ["PENDING", "待记录"],
                        ["TAKEN", "已交易"],
                        ["SKIPPED", "已跳过"],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          className={eventFilter === value ? "selected" : ""}
                          onClick={() => setEventFilter(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {displayedEvents.length ? (
                    displayedEvents.map((e) => {
                      const p = boot.plans.find((p) => p.id === e.planId);
                      const i = boot.instruments.find(
                        (i) => i.id === p?.instrumentId,
                      );
                      return (
                        <button
                          key={e.id}
                          data-event-id={e.id}
                          className={`event-row ${selectedEvent === e.id ? "selected" : ""}`}
                          onClick={() => openEvent(e)}
                        >
                          <div
                            className={`event-symbol ${e.type.includes("BLOCK") ? "amber" : "green"}`}
                          >
                            <Icon
                              name={e.type.includes("BLOCK") ? "info" : "chart"}
                              size={19}
                            />
                          </div>
                          <div className="event-row-body">
                            <div>
                              <strong>{i?.symbol || "计划记录"}</strong>
                              <span>{when(e.time)}</span>
                              {!e.read && <i className="unread-dot" />}
                            </div>
                            <h3>{eventLabel[e.type] || e.type}</h3>
                            <p>{e.message}</p>
                            <div className="event-badges">
                              {e.historical && (
                                <Badge tone="amber">历史 / 合成回放</Badge>
                              )}
                              {e.feedback && (
                                <Badge
                                  tone={
                                    e.feedback === "TAKEN" ? "green" : "neutral"
                                  }
                                >
                                  {e.feedback === "TAKEN" ? "已交易" : "已跳过"}
                                </Badge>
                              )}
                              {e.quantity != null && (
                                <span>核算 {e.quantity} 股</span>
                              )}
                            </div>
                          </div>
                          <Icon name="arrow" size={16} />
                        </button>
                      );
                    })
                  ) : (
                    <Empty
                      title="目前没有记录"
                      text="启用计划后，技术事件与风险阻断会保存在这里。没有事件时不会生成示例提醒。"
                    />
                  )}
                  <div className="event-pagination">
                    <small>
                      已载入 {events.length} / {eventCounts.total}{" "}
                      条；筛选作用于已载记录。
                    </small>
                    {eventFeed.error && <p role="alert">{eventFeed.error}</p>}
                    {eventFeed.hasMore && (
                      <button
                        className="button secondary compact"
                        disabled={eventFeed.loadingOlder}
                        onClick={() => void eventFeed.loadOlder()}
                      >
                        {eventFeed.loadingOlder
                          ? "正在读取较早记录…"
                          : "加载更早记录"}
                      </button>
                    )}
                  </div>
                </section>
                <aside className="panel event-detail" aria-busy={detailLoading}>
                  {detailLoading && <p role="status">正在读取完整判断快照…</p>}
                  {detailError && (
                    <div className="support-warning" role="alert">
                      <p>{detailError}</p>
                      <button
                        className="button secondary compact"
                        onClick={() =>
                          selectedEvent && void loadEventDetail(selectedEvent)
                        }
                      >
                        重试读取判断快照
                      </button>
                    </div>
                  )}
                  {event ? (
                    <>
                      <div className="section-heading">
                        <h3>判断快照</h3>
                        <Badge>
                          {event.feedback === "TAKEN"
                            ? "已交易"
                            : event.feedback === "SKIPPED"
                              ? "已跳过"
                              : canRecord(event)
                                ? "待记录选择"
                                : "观察事件"}
                        </Badge>
                      </div>
                      <h2>{eventLabel[event.type] || event.type}</h2>
                      <p>{event.message}</p>
                      <dl className="detail-list">
                        <dt>事件发生</dt>
                        <dd>{when(event.time)}</dd>
                        <dt>接收时间</dt>
                        <dd>{when(event.receivedAt)}</dd>
                        <dt>核算数量</dt>
                        <dd>
                          {event.quantity == null
                            ? "未通过数量核算"
                            : `${event.quantity} 股`}
                        </dd>
                        <dt>数据类型</dt>
                        <dd>
                          {event.historical
                            ? "历史条件 / 合成回放"
                            : "当时接收的技术事件"}
                        </dd>
                      </dl>
                      {event.reasons.length > 0 && (
                        <ul className="reason-list">
                          {event.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      )}
                      <DecisionEvidence event={event} />
                      <EventReplay key={event.id} eventId={event.id} />
                      <FeedbackHistory
                        revisions={feedbackHistory}
                        loading={feedbackLoading}
                        error={feedbackError}
                        onReload={() => void loadFeedback(event.id, true)}
                      />
                      <details className="snapshot-details">
                        <summary>查看原始判断依据</summary>
                        <pre>{JSON.stringify(event.snapshot, null, 2)}</pre>
                      </details>
                      {canRecord(event) ? (
                        <div className="feedback-form">
                          <h3>
                            {event.snapshot.synthetic
                              ? "合成演练记录"
                              : "记录你的选择"}
                          </h3>
                          <p>
                            {event.feedback
                              ? "已读取最新记录。更正会追加一个修订版本，保留先前的实际值。"
                              : "填写一次入场摘要。没有填写的字段保持为空。"}
                          </p>
                          {(remoteFeedbackChanged ||
                            feedbackConflict?.eventId === event.id) && (
                            <div
                              className="feedback-conflict support-warning"
                              role="region"
                              aria-label="反馈版本冲突复核"
                            >
                              <strong>另一处已保存了新反馈</strong>
                              <p>
                                {feedbackConflict?.loaded &&
                                !remoteFeedbackChanged
                                  ? "最新修订已显示在上方。当前输入保持不变；核对差异后，再次点击已交易或已跳过才会保存。"
                                  : "当前备注和实际值已保留。请读取最新反馈，再核对历史与当前输入；系统不会自动重试。"}
                              </p>
                              <button
                                type="button"
                                className="button secondary compact"
                                disabled={feedbackLoading || busy}
                                onClick={async () => {
                                  const eventId = event.id;
                                  if (await loadFeedback(eventId, false))
                                    setFeedbackConflict((current) =>
                                      current?.eventId === eventId
                                        ? { ...current, loaded: true }
                                        : current,
                                    );
                                }}
                              >
                                读取最新反馈，保留当前输入
                              </button>
                            </div>
                          )}
                          <Field label="备注">
                            <textarea
                              rows={3}
                              value={feedbackNote}
                              onChange={(e) => {
                                feedbackTouched.current.note = true;
                                setFeedbackNote(e.target.value);
                              }}
                              placeholder="为什么交易，或者为什么跳过？"
                            />
                          </Field>
                          <details>
                            <summary>实际入场摘要（可选）</summary>
                            <div className="field-pair">
                              <Field label="实际均价">
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min="0.000001"
                                  step="any"
                                  value={actualPrice}
                                  onChange={(e) => {
                                    feedbackTouched.current.price = true;
                                    setActualPrice(e.target.value);
                                  }}
                                  placeholder="未填写"
                                />
                              </Field>
                              <Field label="实际数量">
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min="1"
                                  step="1"
                                  value={actualQuantity}
                                  onChange={(e) => {
                                    feedbackTouched.current.quantity = true;
                                    setActualQuantity(e.target.value);
                                  }}
                                  placeholder="未填写"
                                />
                              </Field>
                            </div>
                            <Field label="实际入场时间（本地时区）">
                              <input
                                type="datetime-local"
                                step="0.001"
                                value={actualTime}
                                onChange={(e) => {
                                  feedbackTouched.current.time = true;
                                  setActualTime(e.target.value);
                                }}
                              />
                            </Field>
                          </details>
                          <div className="field-pair">
                            <button
                              className="button primary"
                              disabled={
                                busy ||
                                feedbackLoading ||
                                Boolean(feedbackError) ||
                                remoteFeedbackChanged ||
                                (feedbackConflict?.eventId === event.id &&
                                  !feedbackConflict.loaded)
                              }
                              onClick={() => void feedback("TAKEN")}
                            >
                              已交易
                            </button>
                            <button
                              className="button secondary"
                              disabled={
                                busy ||
                                feedbackLoading ||
                                Boolean(feedbackError) ||
                                remoteFeedbackChanged ||
                                (feedbackConflict?.eventId === event.id &&
                                  !feedbackConflict.loaded)
                              }
                              onClick={() => void feedback("SKIPPED")}
                            >
                              已跳过
                            </button>
                          </div>
                          <small>
                            标记已交易后，资金快照需要重新确认。更正记录会追加保存，不改写原计划。
                          </small>
                        </div>
                      ) : (
                        <p className="disclaimer">
                          这是一条观察事件。可记录交易选择的条件提醒会独立展示。
                        </p>
                      )}
                    </>
                  ) : (
                    <Empty
                      title="打开一条记录"
                      text="这里会展示事件发生时的条件、风险结论和你的反馈。"
                    />
                  )}
                </aside>
              </div>
            </>
          )}
        </main>
        <footer className="workspace-footer">
          <span>
            PULLBACK LAB <span className="footer-line">/</span>{" "}
            有依据的研究，有记录的决策
          </span>
          <span>个人研究工具 · 不自动下单</span>
        </footer>
      </div>
      {settings && fundsForm && (
        <div
          className="drawer-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSettings(false);
          }}
        >
          <section
            className="settings-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="设置与资金快照"
          >
            <div className="drawer-heading">
              <div>
                <div className="eyebrow">WORKSPACE SETTINGS</div>
                <h2>设置与资金快照</h2>
              </div>
              <button
                className="icon-button"
                autoFocus
                aria-label="关闭设置"
                onClick={() => setSettings(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="drawer-body">
              {notice && (
                <div
                  role="alert"
                  className={`callout ${notice.error ? "danger" : ""}`}
                >
                  <div>
                    {notice.text}
                    {notice.conflict && (
                      <p>
                        你的输入已保留。请先读取服务端最新资金快照，核对差异后明确选择继续编辑。
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="清除操作提示"
                    onClick={() => setNotice(null)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              )}
              {conflictReview?.target.kind === "funds" && (
                <ConflictPanel
                  review={conflictReview}
                  fundsDraft={fundsForm}
                  existingDraft={existingText}
                  fxTimeDraft={fxTime}
                  busy={busy}
                  canAdopt
                  onRead={() => void readConflict()}
                  onAdopt={adoptConflictBaseline}
                />
              )}
              <section className="settings-section">
                <h3>行情与研究规则</h3>
                {boot.capabilities.map((c) => (
                  <div className="capability-card" key={c.market}>
                    <div>
                      <strong>{c.market === "US" ? "美股" : "A 股"}</strong>
                      <Badge
                        tone={c.level.startsWith("LIVE") ? "green" : "amber"}
                      >
                        {capabilityLabel[c.level]}
                      </Badge>
                    </div>
                    <p>{c.reason}</p>
                    <small>
                      {c.source || "来源未验证"} · {when(c.checkedAt)}
                    </small>
                  </div>
                ))}
                <MarketStatus />
                <div className="source-note">
                  <strong>规则来源与版本</strong>
                  <p>
                    需求 v0.2 · 指标
                    screening-v1。访谈方法用于研究背景；计算口径、时间边界和测试阈值为产品工程约定。
                  </p>
                  <a
                    href="https://github.com/kejun/blogpost/blob/main/2026-10-12-martin-luk-pullback-buying-system.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看访谈整理与来源 ↗
                  </a>
                </div>
                {boot.demo && (
                  <button
                    className="button secondary full"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api("/demo/seed", "POST");
                        await refresh();
                      }, "合成示例已载入。")
                    }
                  >
                    载入合成示例数据
                  </button>
                )}
              </section>
              {candidatePage && (
                <ScreeningRulesEditor
                  initial={screeningSettings}
                  onChanged={refresh}
                  onSaved={setScreeningSettings}
                />
              )}
              <form onSubmit={saveFunds}>
                <section className="settings-section">
                  <div className="section-heading">
                    <h3>人工资金快照</h3>
                    <Badge tone={boot.funds?.stale ? "amber" : "neutral"}>
                      {boot.funds
                        ? `第 ${boot.funds.generation} 次确认${boot.funds.stale ? " · 待刷新" : ""}`
                        : "尚未确认"}
                    </Badge>
                  </div>
                  <p className="settings-intro">
                    填写券商端的当前资金。资金变化或记录已交易后，请重新核对；本工具不读取券商持仓。
                  </p>
                  {boot.demo && (
                    <button
                      type="button"
                      className="text-button sample-link"
                      onClick={sampleFunds}
                    >
                      填入明确的合成资金示例
                    </button>
                  )}
                  <div className="field-pair">
                    <Field label="基础币种">
                      <select
                        value={fundsForm.baseCurrency}
                        onChange={(e) =>
                          setFundsForm((f) => ({
                            ...f!,
                            baseCurrency: e.target.value as Currency,
                            fx: { ...f!.fx, [e.target.value]: "1" },
                          }))
                        }
                      >
                        <option value="USD">USD · 美元</option>
                        <option value="CNY">CNY · 人民币</option>
                      </select>
                    </Field>
                    <Field label="净值 NAV">
                      <input
                        type="number"
                        min="0.000001"
                        step="any"
                        inputMode="decimal"
                        required
                        value={fundsForm.nav}
                        onChange={(e) =>
                          setFundsForm((f) => ({ ...f!, nav: e.target.value }))
                        }
                        placeholder="基础币种金额"
                      />
                    </Field>
                  </div>
                  <div className="field-pair">
                    {(["USD", "CNY"] as const).map((c) => (
                      <Field key={c} label={`${c} 可用现金`}>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          required
                          value={fundsForm.cash[c]}
                          onChange={(e) =>
                            setFundsForm((f) => ({
                              ...f!,
                              cash: { ...f!.cash, [c]: e.target.value },
                            }))
                          }
                          placeholder="实际币种余额，无余额填 0"
                        />
                      </Field>
                    ))}
                  </div>
                  <div className="field-pair">
                    <Field
                      label="单笔风险预算"
                      help={`金额，单位 ${fundsForm.baseCurrency}`}
                    >
                      <input
                        type="number"
                        min="0.000001"
                        step="any"
                        inputMode="decimal"
                        required
                        value={fundsForm.riskBudget}
                        onChange={(e) =>
                          setFundsForm((f) => ({
                            ...f!,
                            riskBudget: e.target.value,
                          }))
                        }
                        placeholder="自行填写"
                      />
                    </Field>
                    <Field
                      label="活动计划总风险预算"
                      help={`本应用待完成计划，单位 ${fundsForm.baseCurrency}`}
                    >
                      <input
                        type="number"
                        min="0.000001"
                        step="any"
                        inputMode="decimal"
                        required
                        value={fundsForm.riskPool}
                        onChange={(e) =>
                          setFundsForm((f) => ({
                            ...f!,
                            riskPool: e.target.value,
                          }))
                        }
                        placeholder="自行填写"
                      />
                    </Field>
                  </div>
                  <Field
                    label="单票敞口上限"
                    help="填写小数比例，例如 20% 填 0.2；没有预选比例。"
                  >
                    <input
                      type="number"
                      min="0.000001"
                      max="1"
                      step="any"
                      inputMode="decimal"
                      required
                      value={fundsForm.maxWeight}
                      onChange={(e) =>
                        setFundsForm((f) => ({
                          ...f!,
                          maxWeight: e.target.value,
                        }))
                      }
                      placeholder="0 至 1 之间"
                    />
                  </Field>
                  <Field
                    label="已有同标的敞口"
                    help={`每行「标的 ID=金额」，金额为 ${fundsForm.baseCurrency}；没有持仓可留空。标的 ID 见下方。`}
                  >
                    <textarea
                      rows={3}
                      value={existingText}
                      onChange={(e) => setExistingText(e.target.value)}
                      placeholder="标的 ID=金额"
                    />
                  </Field>
                  {boot.instruments.length > 0 && (
                    <details className="instrument-ids">
                      <summary>查看标的 ID</summary>
                      {boot.instruments.map((i) => (
                        <p key={i.id}>
                          {i.symbol}：<code>{i.id}</code>
                        </p>
                      ))}
                    </details>
                  )}
                </section>
                <section className="settings-section">
                  <h3>汇率</h3>
                  <p className="settings-intro">
                    1 单位报价币种 = 以下数量的 {fundsForm.baseCurrency}
                    。基础币种填 1，不会自动换汇。
                  </p>
                  <div className="field-pair">
                    {(["USD", "CNY"] as const).map((c) => (
                      <Field
                        key={c}
                        label={`1 ${c} = ${fundsForm.baseCurrency}`}
                      >
                        <input
                          type="number"
                          min="0.000001"
                          step="any"
                          inputMode="decimal"
                          required
                          value={fundsForm.fx[c]}
                          onChange={(e) =>
                            setFundsForm((f) => ({
                              ...f!,
                              fx: { ...f!.fx, [c]: e.target.value },
                            }))
                          }
                        />
                      </Field>
                    ))}
                  </div>
                  <Field label="汇率核对时间（本地时区）">
                    <input
                      type="datetime-local"
                      required
                      value={fxTime}
                      onChange={(e) => setFxTime(e.target.value)}
                    />
                  </Field>
                </section>
                <section className="settings-section">
                  <h3>费用与滑点估计</h3>
                  <p className="settings-intro">
                    填写完整适用的每笔买卖费用估计和每股滑点，单位为证券报价币种。未核实费用时只做研究，不允许风险通过。
                  </p>
                  <div className="field-pair">
                    <Field label="买入费用 / 笔">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        required
                        value={fundsForm.buyFee}
                        onChange={(e) =>
                          setFundsForm((f) => ({
                            ...f!,
                            buyFee: e.target.value,
                          }))
                        }
                        placeholder="无费用须明确填 0"
                      />
                    </Field>
                    <Field label="卖出费用 / 笔">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        required
                        value={fundsForm.sellFee}
                        onChange={(e) =>
                          setFundsForm((f) => ({
                            ...f!,
                            sellFee: e.target.value,
                          }))
                        }
                        placeholder="无费用须明确填 0"
                      />
                    </Field>
                  </div>
                  <div className="field-pair">
                    <Field label="买入滑点 / 股">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        required
                        value={fundsForm.slippageIn}
                        onChange={(e) =>
                          setFundsForm((f) => ({
                            ...f!,
                            slippageIn: e.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field label="止损卖出滑点 / 股">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        inputMode="decimal"
                        required
                        value={fundsForm.slippageOut}
                        onChange={(e) =>
                          setFundsForm((f) => ({
                            ...f!,
                            slippageOut: e.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={fundsForm.feesConfirmed}
                      onChange={(e) =>
                        setFundsForm((f) => ({
                          ...f!,
                          feesConfirmed: e.target.checked,
                        }))
                      }
                    />
                    <span>我已核对费用，包括适用的佣金、最低费用与税费。</span>
                  </label>
                </section>
                <div className="funds-confirm">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      required
                      checked={fundsConfirmed}
                      onChange={(e) => setFundsConfirmed(e.target.checked)}
                    />
                    <span>
                      我已按当前账户更新现金与已有敞口，以上快照反映实际可用资金
                      {boot.demo ? "（演示环境为合成资金）" : ""}。
                    </span>
                  </label>
                  <button
                    className="button primary full"
                    disabled={busy || !fundsConfirmed}
                  >
                    确认并保存资金快照
                    <Icon name="check" size={17} />
                  </button>
                  <small>上次确认：{when(boot.funds?.confirmedAt)}</small>
                </div>
              </form>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ConflictPanel({
  review,
  planDraft,
  fundsDraft,
  existingDraft = "",
  fxTimeDraft = "",
  busy,
  canAdopt,
  onRead,
  onAdopt,
}: {
  review: ConflictReview;
  planDraft?: PlanInput;
  fundsDraft?: Funds | null;
  existingDraft?: string;
  fxTimeDraft?: string;
  busy: boolean;
  canAdopt: boolean;
  onRead: () => void;
  onAdopt: () => void;
}) {
  type Row = { label: string; draft: string; latest: string };
  let rows: Row[] = [];
  const target = review.target;
  if (target.kind === "plan" && planDraft && review.latestPlan) {
    const fields: [keyof PlanInput, string][] = [
      ["sessionDate", "计划交易日"],
      ["primarySupport", "主支撑价"],
      ["lower", "支撑区下沿"],
      ["upper", "支撑区上沿"],
      ["stop", "止损参考"],
      ["entryMin", "入场下沿"],
      ["entryMax", "入场上沿"],
      ["anchorTime", "AVWAP 锚点"],
      ["mode", "触发方式"],
      ["reason", "计划依据"],
      ["backgroundConfirmed", "背景确认"],
    ];
    const value = (plan: PlanInput, key: keyof PlanInput) => {
      if (key === "anchorTime") return shortDate(plan.anchorTime);
      if (key === "backgroundConfirmed")
        return plan.backgroundConfirmed ? "已确认" : "未确认";
      if (key === "mode")
        return plan.mode === "CLOSE_CONFIRM" ? "收盘确认" : "盘中穿越";
      return String(plan[key] ?? "—");
    };
    rows = fields.map(([key, label]) => ({
      label,
      draft: value(planDraft, key),
      latest: value(review.latestPlan!, key),
    }));
  } else if (target.kind === "funds" && fundsDraft && review.latestFunds) {
    const latest = review.latestFunds;
    const fields: [keyof Funds, string][] = [
      ["baseCurrency", "基础币种"],
      ["nav", "净值 NAV"],
      ["riskBudget", "单笔风险预算"],
      ["riskPool", "总风险预算"],
      ["maxWeight", "单票敞口比例"],
      ["buyFee", "每笔买入费用"],
      ["sellFee", "每笔卖出费用"],
      ["slippageIn", "每股买入滑点"],
      ["slippageOut", "每股卖出滑点"],
    ];
    rows = fields.map(([key, label]) => ({
      label,
      draft: String(fundsDraft[key]),
      latest: String(latest[key]),
    }));
    rows.splice(
      2,
      0,
      ...(["USD", "CNY"] as const).map((currency) => ({
        label: `${currency} 可用现金`,
        draft: fundsDraft.cash[currency],
        latest: latest.cash[currency],
      })),
    );
    rows.push(
      {
        label: "已有同标的敞口",
        draft: existingDraft || "无",
        latest:
          Object.entries(latest.existing)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n") || "无",
      },
      ...(["USD", "CNY"] as const).map((currency) => ({
        label: `${currency} 汇率`,
        draft: fundsDraft.fx[currency],
        latest: latest.fx[currency],
      })),
      {
        label: "汇率核对时间",
        draft: fxTimeDraft ? when(new Date(fxTimeDraft).getTime()) : "未确认",
        latest: when(latest.fxAsOf),
      },
      {
        label: "费用确认",
        draft: fundsDraft.feesConfirmed ? "已确认" : "未确认",
        latest: latest.feesConfirmed ? "已确认" : "未确认",
      },
    );
  }
  const missingPlan =
    target.kind === "plan" && review.loaded && !review.latestPlan;
  return (
    <section
      className="source-note"
      aria-label={
        target.kind === "plan" ? "计划版本冲突复核" : "资金版本冲突复核"
      }
      style={{
        marginBottom: 20,
        border: "1px solid #e2c9a1",
        borderRadius: 7,
        padding: 14,
        background: "#fbf6ea",
      }}
    >
      <h3 style={{ fontSize: 12, marginBottom: 8 }}>
        版本发生变化 · 先核对，再继续
      </h3>
      <p>
        你的输入完整保留。读取最新内容不会覆盖输入，也不会自动更新提交基线。
      </p>
      <button
        type="button"
        className="button secondary full"
        disabled={busy}
        onClick={onRead}
      >
        {review.loaded ? "重新读取最新数据" : "读取最新数据"}
      </button>
      {review.loaded && (
        <>
          <p style={{ marginTop: 14 }}>
            {target.kind === "plan"
              ? `当前基线 v${target.version}；服务端最新 ${review.latestPlan ? `v${review.latestPlan.version} · ${planState[review.latestPlan.status] || review.latestPlan.status}` : "计划不存在"}`
              : `当前资金基线 ${target.generation}；服务端最新 ${review.latestFunds?.generation ?? 0} · ${review.latestFunds?.stale ? "待刷新" : "已确认"}`}
          </p>
          {target.kind === "funds" && (
            <p style={{ color: "#986b36" }}>
              最新确认时间：{when(review.latestFunds?.confirmedAt)}
              。期间的交易或账户变化可能使旧金额失效。请按券商现状核对现金与已有敞口，不能直接复用交易前金额。
            </p>
          )}
          {rows.length > 0 && (
            <div style={{ maxHeight: 390, overflow: "auto", margin: "12px 0" }}>
              <table
                style={{
                  width: "100%",
                  tableLayout: "fixed",
                  borderCollapse: "collapse",
                  fontSize: 10,
                  lineHeight: 1.7,
                }}
              >
                <thead>
                  <tr>
                    <th style={{ width: "30%", textAlign: "left" }}>
                      核对项目
                    </th>
                    <th style={{ textAlign: "left" }}>保留的输入</th>
                    <th style={{ textAlign: "left" }}>服务端最新</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.label}
                      style={{
                        background:
                          row.draft !== row.latest ? "#f3e9ce" : undefined,
                      }}
                    >
                      <td
                        style={{
                          padding: "7px 4px 7px 0",
                          borderBottom: "1px solid #e8deca",
                          verticalAlign: "top",
                        }}
                      >
                        {row.label}
                      </td>
                      <td
                        style={{
                          padding: "7px 5px",
                          borderBottom: "1px solid #e8deca",
                          overflowWrap: "anywhere",
                          whiteSpace: "pre-wrap",
                          verticalAlign: "top",
                        }}
                      >
                        {row.draft || "未填写"}
                      </td>
                      <td
                        style={{
                          padding: "7px 5px",
                          borderBottom: "1px solid #e8deca",
                          overflowWrap: "anywhere",
                          whiteSpace: "pre-wrap",
                          verticalAlign: "top",
                        }}
                      >
                        {row.latest || "未填写"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!canAdopt && <p>请返回发生冲突的原计划，完成核对后继续。</p>}
          {missingPlan && <p>原计划已不可用，不能沿用其版本继续提交。</p>}
          <button
            type="button"
            className="button primary full"
            style={{ whiteSpace: "normal", lineHeight: 1.7 }}
            disabled={busy || !canAdopt || missingPlan}
            onClick={onAdopt}
          >
            保留输入并基于最新版本继续编辑
          </button>
          {target.kind === "funds" && (
            <p>
              选择后会取消资金确认勾选。你需要重新核对账户并明确确认，之后才能保存。
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Logo() {
  return (
    <div className="brand">
      <div className="brand-mark">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M5 23 12 10l6 9 9-15" />
          <path d="M20 4h7v7" />
          <path className="brand-line" d="M5 28h22" />
        </svg>
      </div>
      <div>
        Pullback <span>Lab</span>
        <small>回调交易研究</small>
      </div>
    </div>
  );
}
function Stat({
  label,
  value,
  suffix,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  suffix: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className={`stat ${accent ? "accent" : ""}`}>
      <span>{label}</span>
      <div>
        {value}
        <small>{suffix}</small>
      </div>
      <p>{detail}</p>
    </div>
  );
}
