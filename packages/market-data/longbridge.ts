import {
  AdjustType,
  Config,
  Market as LBMarket,
  NaiveDate,
  Period,
  PushCandlestickMode,
  QuoteContext,
  TradeSessions,
  type Candlestick,
} from "longbridge";
import type { Capability, Market } from "../contracts/index.js";
import { withDeadline, OperationTimeout } from "./deadline.js";
import {
  observeRawTradeSources,
  type TradeSourceObservation,
} from "./longbridge-trade-observer.js";
import { getUnknownCapabilities } from "./capabilities.js";
import {
  dailyHistoryWindows,
  HISTORY_PAGE_SAMPLE_LIMIT,
} from "./history-capture.js";
export interface ProviderBarSample {
  symbol: string;
  period: "1D" | "1m" | "5m";
  timestamp: number;
  receivedAt: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover: string;
  tradeSession: number;
  adjustment: "RAW";
  finality: "UNKNOWN" | "CONFIRMED";
  volumeUnit: "UNVERIFIED";
}
export interface QuoteSample {
  symbol: string;
  price: string;
  timestamp: number;
  receivedAt: number;
}
export interface MarketDataAdapter {
  readonly source: string;
  fetchBars(
    symbol: string,
    period: "1D" | "1m" | "5m",
    count: number,
  ): Promise<ProviderBarSample[]>;
  fetchQuotes(symbols: string[]): Promise<QuoteSample[]>;
  capabilities(): Capability[];
}
const periods = { "1D": Period.Day, "1m": Period.Min_1, "5m": Period.Min_5 };
const validateSymbol = (symbol: string) => {
  if (!/^[A-Z0-9._-]+\.(US|SH|SZ)$/.test(symbol))
    throw new Error("UNSUPPORTED_SYMBOL_FORMAT");
};
const asNaive = (day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("INVALID_DATE");
  const [y, m, d] = day.split("-").map(Number);
  const at = Date.UTC(y, m - 1, d);
  if (new Date(at).toISOString().slice(0, 10) !== day)
    throw new Error("INVALID_DATE");
  return new NaiveDate(y, m, d);
};
function sample(
  symbol: string,
  period: ProviderBarSample["period"],
  b: Candlestick,
  receivedAt: number,
  confirmed = false,
): ProviderBarSample {
  if (!Number.isSafeInteger(b.volume) || b.volume < 0)
    throw new Error("PROVIDER_VOLUME_PRECISION_UNSAFE");
  return {
    symbol,
    period,
    timestamp: b.timestamp.getTime(),
    receivedAt,
    open: b.open.toString(),
    high: b.high.toString(),
    low: b.low.toString(),
    close: b.close.toString(),
    volume: String(b.volume),
    turnover: b.turnover.toString(),
    tradeSession: b.tradeSession,
    adjustment: "RAW",
    finality: confirmed ? "CONFIRMED" : "UNKNOWN",
    volumeUnit: "UNVERIFIED",
  };
}
/** QuoteContext only: no account, balance, position, order or trading APIs. Raw samples do not imply production readiness. */
export class LongbridgeReadOnlyAdapter implements MarketDataAdapter {
  readonly source = "longbridge-node-5.2.0";
  private observing = false;
  private readonly cache = new Map<
    string,
    { at: number; bars: ProviderBarSample[] }
  >();
  constructor(
    private readonly ctx: QuoteContext,
    private readonly clock: () => number = Date.now,
  ) {}
  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
  ): LongbridgeReadOnlyAdapter {
    const {
      LONGBRIDGE_APP_KEY: key,
      LONGBRIDGE_APP_SECRET: secret,
      LONGBRIDGE_ACCESS_TOKEN: token,
    } = env;
    if (!key || !secret || !token)
      throw new Error("LONGBRIDGE_CREDENTIALS_MISSING");
    const cfg = Config.fromApikey(key, secret, token, {
      enablePrintQuotePackages: false,
      enableOvernight: false,
      pushCandlestickMode: PushCandlestickMode.Confirmed,
    });
    return new LongbridgeReadOnlyAdapter(QuoteContext.new(cfg));
  }
  capabilities(): Capability[] {
    return getUnknownCapabilities();
  }
  async fetchBars(
    symbol: string,
    period: ProviderBarSample["period"],
    count: number,
  ): Promise<ProviderBarSample[]> {
    validateSymbol(symbol);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
      throw new Error("BAR_COUNT_OUT_OF_RANGE");
    const key = `${symbol}:${period}:${count}`,
      cached = this.cache.get(key),
      now = this.clock();
    if (cached && now - cached.at < 60_000) return structuredClone(cached.bars);
    const raw = await this.ctx.candlesticks(
      symbol,
      periods[period],
      count,
      AdjustType.NoAdjust,
      TradeSessions.Intraday,
    );
    const receivedAt = this.clock(),
      bars = raw.map((x) => sample(symbol, period, x, receivedAt));
    this.cache.set(key, { at: receivedAt, bars });
    return structuredClone(bars);
  }
  /** Fresh remote request, not subscribeCandlesticks' possibly mixed in-memory tail. */
  async fetchMinuteSeed(
    symbol: string,
    period: "1m" | "5m",
    count = 60,
  ): Promise<ProviderBarSample[]> {
    validateSymbol(symbol);
    if (
      !/^\d{6}\.(SH|SZ)$/.test(symbol) ||
      !["1m", "5m"].includes(period) ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 60
    )
      throw new Error("MINUTE_SEED_BOUNDS_INVALID");
    const raw = await this.ctx.candlesticks(
      symbol,
      periods[period],
      count,
      AdjustType.NoAdjust,
      TradeSessions.Intraday,
    );
    if (raw.length > count) throw new Error("MINUTE_SEED_SAMPLE_LIMIT");
    const receivedAt = this.clock();
    return raw.map((bar) => sample(symbol, period, bar, receivedAt));
  }
  /** One bounded RAW endpoint page. Timestamp labels, units and finality remain unverified. */
  async fetchDailyHistoryPage(
    symbol: string,
    from: string,
    through: string,
  ): Promise<ProviderBarSample[]> {
    validateSymbol(symbol);
    if (dailyHistoryWindows(from, through).length !== 1)
      throw new Error("HISTORY_PAGE_OUT_OF_BOUNDS");
    const raw = await this.ctx.historyCandlesticksByDate(
      symbol,
      Period.Day,
      AdjustType.NoAdjust,
      asNaive(from),
      asNaive(through),
      TradeSessions.Intraday,
    );
    if (raw.length > HISTORY_PAGE_SAMPLE_LIMIT)
      throw new Error("HISTORY_PAGE_SAMPLE_LIMIT");
    const receivedAt = this.clock();
    return raw.map((bar) => sample(symbol, "1D", bar, receivedAt));
  }
  /** Every page requires admission. Preserve duplicates/conflicts in request order for later review. */
  async fetchDailyHistory(
    symbol: string,
    from: string,
    through: string,
    admitPage: () => Promise<void>,
  ): Promise<ProviderBarSample[]> {
    validateSymbol(symbol);
    const windows = dailyHistoryWindows(from, through);
    const result: ProviderBarSample[] = [];
    for (const page of windows) {
      await admitPage();
      result.push(
        ...(await this.fetchDailyHistoryPage(symbol, page.from, page.through)),
      );
    }
    return result;
  }
  async fetchQuotes(symbols: string[]): Promise<QuoteSample[]> {
    if (symbols.length < 1 || symbols.length > 10)
      throw new Error("QUOTE_SYMBOL_LIMIT");
    symbols.forEach(validateSymbol);
    const quotes = await this.ctx.quote(symbols),
      receivedAt = this.clock();
    return quotes.map((x) => ({
      symbol: x.symbol,
      price: x.lastDone.toString(),
      timestamp: x.timestamp.getTime(),
      receivedAt,
    }));
  }
  async entitlementEvidence(): Promise<{
    level: string;
    packages: Array<{
      key: string;
      name: string;
      startAt: number;
      endAt: number;
    }>;
  }> {
    return {
      level: await this.quoteLevelEvidence(),
      packages: await this.quotePackagesEvidence(),
    };
  }
  async quoteLevelEvidence(): Promise<string> {
    return this.ctx.quoteLevel();
  }
  async quotePackagesEvidence(): Promise<
    Array<{
      key: string;
      name: string;
      startAt: number;
      endAt: number;
    }>
  > {
    return (await this.ctx.quotePackageDetails()).map((x) => ({
      key: x.key,
      name: x.name,
      startAt: x.startAt.getTime(),
      endAt: x.endAt.getTime(),
    }));
  }
  async instrumentEvidence(symbols: string[]): Promise<
    Array<{
      symbol: string;
      exchange: string;
      currency: string;
      lotSize: number;
      rulesVerified: false;
      securityBoard?: number | null;
    }>
  > {
    symbols.forEach(validateSymbol);
    if (symbols.length > 10) throw new Error("SYMBOL_LIMIT");
    return (await this.ctx.staticInfo(symbols)).map((x) => ({
      symbol: x.symbol,
      exchange: x.exchange,
      currency: x.currency,
      lotSize: x.lotSize,
      rulesVerified: false,
      securityBoard: Number.isSafeInteger(x.board) ? x.board : null,
    }));
  }
  async calendarEvidence(
    market: Market,
    from: string,
    through: string,
  ): Promise<{
    tradingDays: string[];
    halfDays: string[];
    sessionHoursVerified: false;
  }> {
    const days = await this.ctx.tradingDays(
      market === "US" ? LBMarket.US : LBMarket.CN,
      asNaive(from),
      asNaive(through),
    );
    return {
      tradingDays: days.tradingDays.map((x) => x.toString()),
      halfDays: days.halfTradingDays.map((x) => x.toString()),
      sessionHoursVerified: false,
    };
  }
  /** Separate raw endpoints: never expose SDK-mixed candle volume as homogeneous shares. */
  async observeTradeSources(
    symbols: string[],
    durationMs: number,
    requestTimeoutMs = 20_000,
  ): Promise<TradeSourceObservation> {
    if (this.observing) throw new Error("OBSERVATION_ALREADY_RUNNING");
    this.observing = true;
    try {
      const result = await observeRawTradeSources(
        this.ctx,
        symbols,
        durationMs,
        requestTimeoutMs,
        this.clock,
      );
      if (result.reusable) this.observing = false;
      return result;
    } catch (error) {
      // Release only for known pre-native validation failures. Unknown failures poison ownership.
      if (
        error instanceof Error &&
        ["TRADE_SOURCE_BOUNDS_INVALID", "TRADE_SOURCE_CLOCK_INVALID"].includes(
          error.message,
        )
      )
        this.observing = false;
      throw error;
    }
  }
  async observeConfirmed(
    symbols: string[],
    durationMs: number,
    requestTimeoutMs = 20_000,
  ): Promise<ProviderBarSample[]> {
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs < 1000 ||
      durationMs > 120_000 ||
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 60_000 ||
      symbols.length < 1 ||
      symbols.length > 2 ||
      new Set(symbols).size !== symbols.length
    )
      throw new Error("OBSERVATION_BOUNDS_INVALID");
    symbols.forEach(validateSymbol);
    if (this.observing) throw new Error("OBSERVATION_ALREADY_RUNNING");
    this.observing = true;
    const samples: ProviderBarSample[] = [];
    let active = true;
    let callbackError = false;
    const attempted: string[] = [];
    let failure: unknown;
    let failed = false;
    let cleanupFailed = false;
    const unsubscribe = (symbol: string) =>
      withDeadline(
        () => this.ctx.unsubscribeCandlesticks(symbol, Period.Min_1),
        requestTimeoutMs,
      );
    try {
      this.ctx.setOnCandlestick((err, event) => {
        if (!active) return;
        if (err) {
          callbackError = true;
          return;
        }
        if (
          symbols.includes(event.symbol) &&
          event.data.period === Period.Min_1
        ) {
          try {
            if (samples.length >= 2048)
              throw new Error("OBSERVATION_SAMPLE_LIMIT");
            samples.push(
              sample(
                event.symbol,
                "1m",
                event.data.candlestick,
                this.clock(),
                event.data.isConfirmed,
              ),
            );
          } catch {
            callbackError = true;
          }
        }
      });
      for (const symbol of symbols) {
        // Even a failed subscription may have taken effect remotely.
        attempted.push(symbol);
        await withDeadline(() => {
          const pending = this.ctx.subscribeCandlesticks(
            symbol,
            Period.Min_1,
            TradeSessions.Intraday,
          );
          void pending.then(
            () => {
              // A late subscribe acknowledgement must not outlive cleanup silently.
              if (!active) void unsubscribe(symbol).catch(() => {});
            },
            () => {},
          );
          return pending;
        }, requestTimeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      if (callbackError) throw new Error("CANDLESTICK_STREAM_ERROR");
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      active = false;
      try {
        this.ctx.setOnCandlestick(() => {});
      } catch {
        cleanupFailed = true;
      }
      const cleanup = await Promise.allSettled(attempted.map(unsubscribe));
      cleanupFailed ||= cleanup.some((result) => result.status === "rejected");
      // An unresolved/failed operation can still affect this native context. Do not reuse it for observation.
      if (!cleanupFailed && !(failure instanceof OperationTimeout))
        this.observing = false;
    }
    if (failed) throw failure;
    if (cleanupFailed) throw new Error("CANDLESTICK_CLEANUP_FAILED");
    return samples;
  }
}
