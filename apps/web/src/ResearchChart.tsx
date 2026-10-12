import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar, PlanInput } from "../../../packages/contracts/index";
import {
  chartSafePrice,
  dragCoordinate,
  planPriceFields,
  pointPriceProposal,
  type ChartPriceProposal,
  type PlanPriceField,
} from "./chart-price";

export interface ResearchChartProps {
  bars: Bar[];
  ema9: (string | null)[];
  ema21: (string | null)[];
  ema50: (string | null)[];
  avwap: (string | null)[];
  period: "1D" | "1m" | "5m";
  plan: PlanInput;
  /** UTC seconds, matching Bar.time and the server's anchorTime contract. */
  onAnchor: (time: number) => void;
  instrumentTick?: string;
  onPriceProposal?: (
    field: PlanPriceField,
    proposal: ChartPriceProposal,
  ) => Promise<void>;
}

const colors = {
  ink: "#193d32",
  muted: "#73827a",
  grid: "#e9eee8",
  paper: "#fffefa",
  up: "#26745b",
  down: "#c17763",
  ema9: "#b49b5d",
  ema21: "#63846e",
  ema50: "#8b98a3",
  avwap: "#8a6aa8",
  support: "#34765b",
  entry: "#ab872e",
  stop: "#b45e54",
};

function numberOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayLabel(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

export function ResearchChart({
  bars,
  ema9,
  ema21,
  ema50,
  avwap,
  period,
  plan,
  onAnchor,
  instrumentTick = "",
  onPriceProposal,
}: ResearchChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const adjustmentHelpId = useId();
  const chartRef = useRef<{
    chart: IChartApi;
    candles: ISeriesApi<"Candlestick">;
    overlays: ISeriesApi<"Line">[];
    markers: ISeriesMarkersPluginApi<Time>;
    priceLines: IPriceLine[];
    fitKey: string;
  } | null>(null);
  const [hovered, setHovered] = useState<Bar | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [selectedField, setSelectedField] =
    useState<PlanPriceField>("primarySupport");
  const [preview, setPreview] = useState<string | null>(null);
  const [handleY, setHandleY] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [adjustmentMessage, setAdjustmentMessage] = useState("");
  const operation = useRef(0);
  const pendingRef = useRef(false);
  const drag = useRef<{
    pointerId: number;
    element: HTMLButtonElement;
    field: PlanPriceField;
    grabOffset: number;
    startY: number;
    proposal: ChartPriceProposal | null;
    originalPrice: string;
  } | null>(null);
  const latest = useRef({
    bars,
    period,
    onAnchor,
    plan,
    instrumentTick,
    onPriceProposal,
    adjusting,
    selectedField,
  });
  latest.current = {
    bars,
    period,
    onAnchor,
    plan,
    instrumentTick,
    onPriceProposal,
    adjusting,
    selectedField,
  };

  function cancelDrag(message?: string) {
    const active = drag.current;
    drag.current = null;
    if (active?.element.hasPointerCapture(active.pointerId))
      active.element.releasePointerCapture(active.pointerId);
    setPreview(null);
    if (message) setAdjustmentMessage(message);
  }

  // Cancelling a gesture never mutates a plan. The parent also guards async results.
  useEffect(() => {
    operation.current += 1;
    pendingRef.current = false;
    setPending(false);
    cancelDrag();
    setAdjusting(false);
    setAdjustmentMessage("");
  }, [plan.instrumentId, period]);

  useEffect(() => {
    const cancel = () => {
      if (drag.current) cancelDrag("已取消未提交的调价。");
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      operation.current += 1;
      cancelDrag();
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  useEffect(() => {
    if (drag.current) cancelDrag("行情或价格单位已变更，已取消拖动。");
  }, [bars, instrumentTick]);

  async function submitProposal(
    field: PlanPriceField,
    proposal: ChartPriceProposal,
  ) {
    const callback = latest.current.onPriceProposal;
    if (!callback || pendingRef.current) return;
    const token = ++operation.current;
    pendingRef.current = true;
    setPending(true);
    setAdjustmentMessage("正在按最小变价单位校验…");
    try {
      await callback(field, proposal);
      if (operation.current === token)
        setAdjustmentMessage("已更新计划草稿；保存后才会生成新版本。");
    } catch (error) {
      if (operation.current === token)
        setAdjustmentMessage(
          error instanceof Error ? error.message : "调价失败，计划价格未修改。",
        );
    } finally {
      if (operation.current === token) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (drag.current && drag.current.pointerId !== event.pointerId) {
      cancelDrag("检测到多点触控，已取消拖动。");
      return;
    }
    const current = latest.current;
    const instance = chartRef.current;
    const element = container.current;
    if (
      !current.adjusting ||
      pendingRef.current ||
      !event.isPrimary ||
      event.button !== 0 ||
      drag.current ||
      !instance ||
      !element
    )
      return;
    const price = chartSafePrice(
      current.plan[current.selectedField],
      current.instrumentTick,
    );
    const coordinate =
      price === null ? null : instance.candles.priceToCoordinate(price);
    if (coordinate === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        element: event.currentTarget,
        field: current.selectedField,
        grabOffset:
          event.clientY - element.getBoundingClientRect().top - coordinate,
        startY: event.clientY,
        proposal: null,
        originalPrice: current.plan[current.selectedField],
      };
      setAdjustmentMessage("拖动预览中；松开校验，Esc 取消。");
    } catch {
      cancelDrag("无法开始拖动，请使用下方加减按钮。");
    }
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    const instance = chartRef.current;
    const element = container.current;
    if (
      !active ||
      active.pointerId !== event.pointerId ||
      !instance ||
      !element
    )
      return;
    if (latest.current.plan[active.field] !== active.originalPrice) {
      cancelDrag("价格已在表单中变更，已取消拖动。");
      return;
    }
    const bounds = element.getBoundingClientRect();
    const y = dragCoordinate(
      event.clientY,
      bounds.top,
      active.grabOffset,
      instance.chart.panes()[0].getHeight(),
    );
    if (
      y === null ||
      event.clientX < bounds.left ||
      event.clientX > bounds.right
    ) {
      cancelDrag("拖动超出图表，已取消。");
      return;
    }
    if (Math.abs(event.clientY - active.startY) < 3 && active.proposal === null)
      return;
    const proposal = pointPriceProposal(
      instance.candles.coordinateToPrice(y),
      latest.current.instrumentTick,
    );
    if (!proposal || proposal.kind !== "POINT") {
      cancelDrag("此价格尺度无法精确调价，请直接填写价格。");
      return;
    }
    active.proposal = proposal;
    setPreview(proposal.displayPrice);
  }

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    // Validate the release position as well: pointer-up may arrive without a final move.
    moveDrag(event);
    if (drag.current !== active) return;
    const proposal = active.proposal;
    cancelDrag();
    if (proposal) void submitProposal(active.field, proposal);
    else setAdjustmentMessage("未改变价格。");
  }

  function stepPrice(steps: number) {
    const current = latest.current;
    if (
      drag.current ||
      chartSafePrice(
        current.plan[current.selectedField],
        current.instrumentTick,
      ) === null
    )
      return;
    void submitProposal(current.selectedField, {
      kind: "STEP",
      price: current.plan[current.selectedField],
      steps,
    });
  }

  // Retain source indices so each indicator stays aligned after normalization.
  const rows = useMemo(() => {
    const unique = new Map<number, { bar: Bar; index: number }>();
    bars.forEach((bar, index) => {
      const values = [bar.open, bar.high, bar.low, bar.close].map(numberOrNull);
      if (
        !Number.isFinite(bar.time) ||
        bar.time <= 0 ||
        values.some((v) => v === null)
      )
        return;
      const [open, high, low, close] = values as number[];
      if (
        low > Math.min(open, close) ||
        high < Math.max(open, close) ||
        low > high
      )
        return;
      unique.set(bar.time, { bar, index });
    });
    return [...unique.values()].sort((a, b) => a.bar.time - b.bar.time);
  }, [bars]);

  useEffect(() => {
    if (!container.current) return;
    const element = container.current;
    const chart = createChart(element, {
      width: element.clientWidth,
      height: element.clientWidth < 620 ? 350 : 420,
      layout: {
        background: { type: ColorType.Solid, color: colors.paper },
        textColor: colors.muted,
        fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.14, bottom: 0.12 },
      },
      timeScale: {
        borderVisible: false,
        rightOffset: 5,
        barSpacing: 8,
        minBarSpacing: 3,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "#8c9f92",
          labelBackgroundColor: colors.ink,
          style: LineStyle.Dashed,
        },
        horzLine: {
          color: "#8c9f92",
          labelBackgroundColor: colors.ink,
          style: LineStyle.Dashed,
        },
      },
      localization: { locale: "zh-CN" },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    const overlays = [
      colors.ema9,
      colors.ema21,
      colors.ema50,
      colors.avwap,
    ].map((color, index) =>
      chart.addSeries(LineSeries, {
        color,
        lineWidth: index === 3 ? 2 : 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }),
    );
    const markers = createSeriesMarkers(candles, []);
    chartRef.current = {
      chart,
      candles,
      overlays,
      markers,
      priceLines: [],
      fitKey: "",
    };
    chart.subscribeClick((event) => {
      if (
        latest.current.adjusting ||
        latest.current.period !== "1D" ||
        typeof event.time !== "number"
      )
        return;
      const selected = latest.current.bars.find(
        (bar) => bar.time === event.time,
      );
      if (selected?.final) latest.current.onAnchor(selected.time);
    });
    chart.subscribeCrosshairMove((event) => {
      if (typeof event.time !== "number" || !event.point) {
        setHovered(null);
        return;
      }
      setHovered(
        latest.current.bars.find((bar) => bar.time === event.time) ?? null,
      );
    });
    const observer = new ResizeObserver((entries) => {
      const width = Math.floor(
        entries[0]?.contentRect.width ?? element.clientWidth,
      );
      if (width > 0)
        chart.applyOptions({ width, height: width < 620 ? 350 : 420 });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      markers.detach();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chartRef.current;
    if (!instance) return;
    const { chart, candles, overlays } = instance;
    chart.applyOptions({
      timeScale: { timeVisible: period !== "1D", secondsVisible: false },
    });
    candles.setData(
      rows.map(({ bar }) => ({
        time: bar.time as UTCTimestamp,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
      })),
    );
    [ema9, ema21, ema50, avwap].forEach((values, index) => {
      overlays[index].setData(
        rows.map(({ bar, index: sourceIndex }) => {
          const value = numberOrNull(values[sourceIndex]);
          return value === null
            ? { time: bar.time as UTCTimestamp }
            : { time: bar.time as UTCTimestamp, value };
        }),
      );
    });
    const fitKey = `${plan.instrumentId}:${period}:${rows.length}:${rows[0]?.bar.time}:${rows.at(-1)?.bar.time}`;
    if (rows.length && instance.fitKey !== fitKey) {
      chart.timeScale().fitContent();
      instance.fitKey = fitKey;
    }
    setHovered(null);
  }, [rows, ema9, ema21, ema50, avwap, period, plan.instrumentId]);

  useEffect(() => {
    const instance = chartRef.current;
    if (!instance) return;
    instance.priceLines.forEach((line) =>
      instance.candles.removePriceLine(line),
    );
    const lines: {
      value: string;
      title: string;
      color: string;
      main?: boolean;
    }[] = [
      {
        value: plan.primarySupport,
        title: "主支撑",
        color: colors.support,
        main: true,
      },
      { value: plan.lower, title: "支撑下沿", color: colors.support },
      { value: plan.upper, title: "支撑上沿", color: colors.support },
      { value: plan.entryMin, title: "入场下限", color: colors.entry },
      { value: plan.entryMax, title: "入场上限", color: colors.entry },
      { value: plan.stop, title: "止损", color: colors.stop, main: true },
    ];
    for (const selection of plan.supportSelections ?? []) {
      if (selection.source === "HORIZONTAL")
        lines.push({
          value: selection.price,
          title: selection.label || "水平支撑",
          color: colors.support,
        });
    }
    if (adjusting) {
      const field = planPriceFields.find(
        (candidate) => candidate.field === selectedField,
      )!;
      lines.push({
        value: preview ?? plan[selectedField],
        title: `${field.label} · 调价`,
        color: colors.ink,
        main: true,
      });
    }
    instance.priceLines = lines.flatMap((line) => {
      const price = numberOrNull(line.value);
      if (price === null || price <= 0) return [];
      return [
        instance.candles.createPriceLine({
          price,
          title: line.title,
          color: line.color,
          lineWidth: line.main ? 2 : 1,
          lineStyle: line.main ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
        }),
      ];
    });
  }, [
    plan.primarySupport,
    plan.lower,
    plan.upper,
    plan.entryMin,
    plan.entryMax,
    plan.stop,
    plan.supportSelections,
    adjusting,
    selectedField,
    preview,
  ]);

  // Lightweight Charts has no price-scale change subscription. Poll only while
  // its one selected handle is active, updating React only when geometry changes.
  useEffect(() => {
    if (!adjusting) {
      setHandleY(null);
      return;
    }
    let frame = 0;
    const position = () => {
      const instance = chartRef.current;
      const value = chartSafePrice(
        preview ?? plan[selectedField],
        instrumentTick,
      );
      const y =
        value === null
          ? null
          : (instance?.candles.priceToCoordinate(value) ?? null);
      const height = instance?.chart.panes()[0]?.getHeight() ?? 0;
      const next =
        y !== null && y >= 22 && y <= height - 22 ? Math.round(y) : null;
      setHandleY((previous) => (previous === next ? previous : next));
      frame = requestAnimationFrame(position);
    };
    frame = requestAnimationFrame(position);
    return () => cancelAnimationFrame(frame);
  }, [adjusting, preview, plan[selectedField], instrumentTick, selectedField]);

  useEffect(() => {
    const instance = chartRef.current;
    if (!instance) return;
    const anchorBar =
      period === "1D" &&
      rows.find(({ bar }) => bar.time === plan.anchorTime && bar.final);
    instance.markers.setMarkers(
      anchorBar
        ? [
            {
              time: anchorBar.bar.time as UTCTimestamp,
              position: "belowBar",
              shape: "arrowUp",
              color: colors.avwap,
              text: "锚点",
              size: 1,
            },
          ]
        : [],
    );
  }, [plan.anchorTime, period, rows]);

  const displayed = hovered ?? rows.at(-1)?.bar;
  const legend = [
    ["EMA 9", colors.ema9],
    ["EMA 21", colors.ema21],
    ["EMA 50", colors.ema50],
    ["锚定均价 AVWAP", colors.avwap],
    ["支撑区", colors.support],
    ["入场区", colors.entry],
    ["止损", colors.stop],
  ];
  const completedBars = rows.filter(({ bar }) => bar.final);
  const selectedLabel = planPriceFields.find(
    (field) => field.field === selectedField,
  )!.label;
  const priceAdjustable =
    !!onPriceProposal &&
    rows.length > 0 &&
    chartSafePrice(plan[selectedField], instrumentTick) !== null;

  return (
    <div
      style={{
        background: colors.paper,
        border: "1px solid #e3e8df",
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "16px 18px 8px",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: colors.muted,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: rows.length ? colors.up : "#b8c2b9",
            }}
          />
          <span>
            {period === "1D"
              ? "日线结构"
              : `${period === "1m" ? "1" : "5"} 分钟走势`}
          </span>
          <span style={{ color: "#bdc7bd" }}>／</span>
          <span>{rows.length} 根 K 线</span>
        </div>
        {displayed && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
              color: colors.muted,
            }}
          >
            <span>
              {dayLabel(displayed.time)}
              {!displayed.final ? " · 未收盘" : ""}
            </span>
            {[
              ["开", displayed.open],
              ["高", displayed.high],
              ["低", displayed.low],
              ["收", displayed.close],
            ].map(([label, value]) => (
              <span key={label}>
                {label} <span style={{ color: colors.ink }}>{value}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {onPriceProposal && (
        <section
          aria-label="图表调价"
          style={{
            padding: "10px 18px",
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "center",
            fontSize: 12,
            borderTop: "1px solid #e9eee5",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            价格线
            <select
              aria-label="选择调价价格线"
              value={selectedField}
              disabled={pending}
              onChange={(event) => {
                cancelDrag();
                setSelectedField(event.target.value as PlanPriceField);
                setAdjustmentMessage("");
              }}
              style={{ maxWidth: "100%", padding: 8 }}
            >
              {planPriceFields.map(({ field, label }) => (
                <option key={field} value={field}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-pressed={adjusting}
            disabled={!priceAdjustable || pending}
            onClick={() => {
              cancelDrag();
              setAdjusting((value) => !value);
              setAdjustmentMessage("");
            }}
          >
            {adjusting ? "结束图表调价" : "开启图表调价"}
          </button>
          {adjusting && (
            <>
              <button
                type="button"
                aria-label={`${selectedLabel}减少一个最小变价单位`}
                disabled={!priceAdjustable || pending || preview !== null}
                onClick={() => stepPrice(-1)}
              >
                − 1 tick
              </button>
              <button
                type="button"
                aria-label={`${selectedLabel}增加一个最小变价单位`}
                disabled={!priceAdjustable || pending || preview !== null}
                onClick={() => stepPrice(1)}
              >
                + 1 tick
              </button>
            </>
          )}
          <span
            style={{
              width: "100%",
              lineHeight: 1.7,
              overflowWrap: "anywhere",
              color: colors.muted,
            }}
          >
            {adjusting
              ? `当前：${selectedLabel} ${preview ?? plan[selectedField]}${preview ? "（拖动预览）" : ""}。拖动图中手柄，或聚焦手柄后用方向键按 tick 调整；Esc 取消。`
              : "选择价格线后开启调价。拖动只修改草稿，需另行保存。"}
            {adjusting && handleY === null && priceAdjustable
              ? "价格线在可视范围外，可用加减按钮调整。"
              : ""}
            {!priceAdjustable
              ? "当前价格或行情不足以精确调价，请先在表单填写有效价格。"
              : ""}
          </span>
          <span
            role="status"
            aria-live="polite"
            style={{
              minHeight: 18,
              width: "100%",
              overflowWrap: "anywhere",
              color: colors.ink,
            }}
          >
            {adjustmentMessage}
          </span>
        </section>
      )}
      <div style={{ position: "relative" }}>
        <div
          ref={container}
          role="img"
          aria-label={`${period === "1D" ? "日线" : "分钟"}蜡烛图，包含均线、锚定均价和交易计划价格线`}
          style={{ width: "100%", minHeight: 350 }}
        />
        {adjusting && handleY !== null && priceAdjustable && (
          <button
            type="button"
            aria-label={`拖动${selectedLabel}价格线`}
            aria-describedby={adjustmentHelpId}
            aria-disabled={pending}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={() => cancelDrag("手势已取消，价格未修改。")}
            onLostPointerCapture={() => {
              if (drag.current) cancelDrag("手势已取消，价格未修改。");
            }}
            onBlur={() => {
              if (drag.current) cancelDrag("已取消未提交的调价。");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelDrag("已取消未提交的调价。");
                setAdjusting(false);
              } else if (
                ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(
                  event.key,
                )
              ) {
                event.preventDefault();
                if (!event.repeat)
                  stepPrice(
                    event.key === "ArrowUp" || event.key === "ArrowRight"
                      ? 1
                      : -1,
                  );
              }
            }}
            style={{
              position: "absolute",
              left: 12,
              top: handleY - 22,
              minHeight: 44,
              minWidth: 100,
              maxWidth: "calc(100% - 110px)",
              padding: "6px 12px",
              touchAction: "none",
              cursor: preview ? "grabbing" : "ns-resize",
              border: `2px solid ${colors.ink}`,
              color: colors.ink,
              background: "#fffefaef",
              borderRadius: 8,
              fontSize: 12,
              zIndex: 2,
              overflowWrap: "anywhere",
            }}
          >
            ↕ {selectedLabel}
          </button>
        )}
        {!rows.length && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              background: colors.paper,
            }}
          >
            <div style={{ textAlign: "center", padding: 28 }}>
              <div style={{ fontSize: 15, color: colors.ink, fontWeight: 600 }}>
                暂无可展示的行情
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: colors.muted,
                }}
              >
                选择标的并加载行情后，查看价格结构与计划位置。
              </div>
            </div>
          </div>
        )}
      </div>
      <div
        style={{
          borderTop: "1px solid #e9eee5",
          padding: "12px 18px",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "10px 16px",
        }}
      >
        {legend.map(([label, color]) => (
          <span
            key={label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: colors.muted,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 13,
                height: 2,
                background: color,
              }}
            />
            {label}
          </span>
        ))}
      </div>
      <div
        style={{
          padding: "0 18px 13px",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          fontSize: 11,
          color: colors.muted,
        }}
      >
        <span id={adjustmentHelpId}>
          {adjusting
            ? "调价模式已暂停日线锚点点击；图外区域仍可滚动页面。"
            : period === "1D"
              ? "点击已收盘日线，设置 AVWAP 锚点。"
              : "AVWAP 使用服务端投影；切换日线可调整锚点。"}
        </span>
        {period === "1D" && completedBars.length > 0 && (
          <label
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            锚点日期
            <select
              aria-label="选择 AVWAP 锚点日期"
              value={
                completedBars.some(({ bar }) => bar.time === plan.anchorTime)
                  ? String(plan.anchorTime)
                  : ""
              }
              onChange={(event) => {
                if (event.target.value) onAnchor(Number(event.target.value));
              }}
              style={{
                border: "1px solid #dfe5da",
                borderRadius: 6,
                background: colors.paper,
                padding: "5px 7px",
                color: colors.ink,
                fontSize: 11,
              }}
            >
              <option value="" disabled>
                选择日期
              </option>
              {[...completedBars].reverse().map(({ bar }) => (
                <option key={bar.time} value={bar.time}>
                  {dayLabel(bar.time)}
                </option>
              ))}
            </select>
          </label>
        )}
        {rows.length < bars.length && (
          <span role="status" style={{ color: colors.stop }}>
            有 {bars.length - rows.length} 根重复或无效 K 线未展示。
          </span>
        )}
      </div>
    </div>
  );
}

export default ResearchChart;
