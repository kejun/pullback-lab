import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  QuoteContext,
  PushCandlestickEvent,
  PushQuoteEvent,
} from "longbridge";
vi.mock("longbridge", () => ({
  Config: { fromApikey: vi.fn(() => ({})) },
  QuoteContext: { new: vi.fn() },
  Period: { Min_1: 1 },
  PushCandlestickMode: { Confirmed: 1 },
  SubType: { Quote: 1 },
  TradeSession: { Intraday: 0 },
  TradeSessions: { Intraday: 0 },
  TradeStatus: { Normal: 0 },
}));
import { Config, QuoteContext as SDKQuoteContext } from "longbridge";
import {
  LongbridgeClosedBarAdapter,
  LONGBRIDGE_SOURCE,
  longbridgeClosedBarFactory,
  type LongbridgeQuotePort,
} from "../longbridge-closed-bar-adapter.js";
import type { ClosedBarContext, ClosedBarSink } from "../closed-bar-adapter.js";
import {
  ContractAdapter,
  INSTRUMENT,
  OPEN,
  planInput,
  testFunds,
} from "./closed-bar-fixture.js";
import { ClosedBarRuntime } from "../closed-bar-runtime.js";
import { Store } from "../store.js";
import { ScreeningService } from "../screening-service.js";
import { createApp } from "../app.js";
import type { ProviderQuota } from "../../../packages/market-data/quota.js";

const quota: ProviderQuota = {
  verified: true,
  researchSymbols: 100,
  simultaneousSubscriptions: 10,
  monthlyUniqueSymbols: 100,
  requestsPerSecond: 10,
};
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    const result = Promise.resolve(fn());
    const handled = result.catch(() => {});
    if (vi.isFakeTimers()) await vi.runAllTimersAsync();
    await handled;
  }
  vi.useRealTimers();
  vi.clearAllMocks();
});
function context(): ClosedBarContext {
  const c = new ContractAdapter().context;
  c.source = LONGBRIDGE_SOURCE;
  c.capability.source = LONGBRIDGE_SOURCE;
  return c;
}
function port() {
  let candle: Parameters<QuoteContext["setOnCandlestick"]>[0] = () => {};
  let quote: Parameters<QuoteContext["setOnQuote"]>[0] = () => {};
  const p = {
    setOnCandlestick: vi.fn((cb: typeof candle) => {
      candle = cb;
    }),
    setOnQuote: vi.fn((cb: typeof quote) => {
      quote = cb;
    }),
    subscribeCandlesticks: vi.fn(async () => [
      "historical response must never reach sink",
    ]),
    unsubscribeCandlesticks: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
  };
  return {
    p: p as unknown as LongbridgeQuotePort,
    mocks: p,
    candle: (value: unknown, err: Error | null = null) =>
      candle(err, value as PushCandlestickEvent),
    quote: (value: unknown, err: Error | null = null) =>
      quote(err, value as PushQuoteEvent),
    callbacks: () => ({ candle, quote }),
  };
}
const price = (v: string) => ({ toString: () => v });
function candle(start = OPEN, values: Record<string, unknown> = {}) {
  return {
    symbol: "CONTRACT.US",
    data: {
      period: 1,
      isConfirmed: true,
      candlestick: {
        timestamp: new Date(start),
        open: price("101"),
        high: price("101.2"),
        low: price("100.8"),
        close: price("101"),
        volume: 1000,
        turnover: price("101000"),
        tradeSession: 0,
        ...values,
      },
    },
  };
}
function quote(at = OPEN + 60000, values: Record<string, unknown> = {}) {
  return {
    symbol: "CONTRACT.US",
    data: {
      timestamp: new Date(at),
      lastDone: price("101"),
      tradeSession: 0,
      tradeStatus: 0,
      ...values,
    },
  };
}
function fixture(
  change: (c: ClosedBarContext) => void = () => {},
  limits = quota,
) {
  vi.useFakeTimers();
  const store = new Store();
  cleanup.push(() => store.close());
  const c = context();
  change(c);
  store.putInstrument({
    instrument: c.instrument,
    manual: false,
    note: "isolated SDK contract test",
    tags: [],
  });
  let now = OPEN - 1;
  const sdk = port();
  const factory = vi.fn(() => sdk.p);
  const adapter = new LongbridgeClosedBarAdapter({
    contexts: [c],
    quota: limits,
    db: store.db,
    contextFactory: factory,
    now: () => now,
    requestTimeoutMs: 5000,
  });
  cleanup.push(() => adapter.stop().catch(() => {}));
  const sink: ClosedBarSink = {
    minute: vi.fn(),
    quote: vi.fn(),
    noTrade: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    store,
    c,
    sdk,
    factory,
    adapter,
    sink,
    now: () => now,
    setNow: (n: number) => {
      now = n;
    },
    ready: async () => {
      await adapter.start(sink);
      const task = adapter.setSubscriptions([INSTRUMENT]);
      await vi.advanceTimersByTimeAsync(1100);
      await task;
    },
  };
}

describe("Longbridge production closed-bar SDK transport (isolated contract data)", () => {
  it("binds the exact quote-only SDK subscription and discards historical subscribe results", async () => {
    const f = fixture();
    await f.ready();
    expect(f.sdk.mocks.subscribeCandlesticks).toHaveBeenCalledWith(
      "CONTRACT.US",
      1,
      0,
    );
    expect(f.sdk.mocks.subscribe).toHaveBeenCalledWith(["CONTRACT.US"], [1]);
    expect(f.sink.minute).not.toHaveBeenCalled();
    expect(f.sink.noTrade).not.toHaveBeenCalled();
    expect(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM market_worker_monthly_symbols")
        .get(),
    ).toEqual({ n: 1 });
  });
  it("emits raw confirmed regular minutes and last-trade estimates, never receiver time or fake sequence", async () => {
    const f = fixture();
    await f.ready();
    f.setNow(OPEN + 60000);
    f.sdk.candle(candle());
    f.sdk.quote(quote());
    expect(f.sink.minute).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentId: INSTRUMENT,
        start: OPEN,
        end: OPEN + 60000,
        final: true,
        adjustment: "RAW",
        volumeUnit: "SHARE",
        volume: "1000",
        providerRevision: "sdk-unversioned-v1",
      }),
    );
    const v = vi.mocked(f.sink.minute).mock.calls[0][0];
    expect(v).not.toHaveProperty("receivedAt");
    expect(v).not.toHaveProperty("providerSequence");
    expect(f.sink.quote).toHaveBeenCalledWith(
      expect.objectContaining({
        price: "101",
        at: OPEN + 60000,
        source: LONGBRIDGE_SOURCE,
      }),
    );
  });
  it("does not accept unconfirmed, out-of-session, other-period or unselected pushes", async () => {
    const f = fixture();
    await f.ready();
    f.setNow(OPEN + 60000);
    const unconfirmed = candle();
    unconfirmed.data.isConfirmed = false;
    f.sdk.candle(unconfirmed);
    f.sdk.candle(candle(OPEN, { tradeSession: 1 }));
    const five = candle();
    five.data.period = 5;
    f.sdk.candle(five);
    const other = candle();
    other.symbol = "OTHER.US";
    f.sdk.candle(other);
    f.sdk.quote(quote(OPEN + 60000, { tradeSession: 2 }));
    expect(f.sink.minute).not.toHaveBeenCalled();
    expect(f.sink.quote).not.toHaveBeenCalled();
  });
  it.each([
    { volume: Number.MAX_SAFE_INTEGER + 1 },
    { volume: -1 },
    { timestamp: new Date(OPEN + 1) },
    { high: price("90") },
  ])(
    "invalid confirmed candle fails closed and later good frames cannot revive it: %j",
    async (values) => {
      const f = fixture();
      await f.ready();
      f.setNow(OPEN + 60000);
      f.sdk.candle(candle(OPEN, values));
      f.sdk.candle(candle());
      expect(f.sink.disconnect).toHaveBeenCalledWith(
        "LONGBRIDGE_CANDLE_CONTRACT_INVALID",
      );
      expect(f.sink.minute).not.toHaveBeenCalled();
    },
  );
  it("rejects a premature final candle", async () => {
    const f = fixture();
    await f.ready();
    f.setNow(OPEN + 59999);
    f.sdk.candle(candle());
    expect(f.sink.disconnect).toHaveBeenCalled();
    expect(f.sink.minute).not.toHaveBeenCalled();
  });
  it.each([
    { tradeStatus: 1 },
    { timestamp: new Date(OPEN + 60001) },
    { lastDone: price("0") },
    { lastDone: price("NaN") },
  ])("invalid current quote stops the connection: %j", async (values) => {
    const f = fixture();
    await f.ready();
    f.setNow(OPEN + 60000);
    f.sdk.quote(quote(OPEN + 60000, values));
    expect(f.sink.disconnect).toHaveBeenCalledWith(
      "LONGBRIDGE_QUOTE_CONTRACT_INVALID",
    );
    expect(f.sink.quote).not.toHaveBeenCalled();
  });
  it("freezes server context and strips unsupported LIVE_TICK claims", async () => {
    const f = fixture((c) => {
      c.capability.sequenceContractVerified = true;
      c.capability.continuousTradesVerified = true;
    });
    f.c.capability.validUntil = 0;
    const exposed = f.adapter.contexts();
    exposed[0].daily[0].close = "1";
    expect(f.adapter.contexts()[0].daily[0].close).not.toBe("1");
    expect(f.adapter.contexts()[0].capability.sequenceContractVerified).toBe(
      false,
    );
    await f.ready();
  });
  it("expired or clock-regressed evidence pauses and never extends itself", async () => {
    const f = fixture();
    await f.ready();
    f.setNow(f.c.capability.validUntil + 1);
    f.sdk.candle(candle());
    expect(f.sink.disconnect).toHaveBeenCalled();
    expect(f.sink.minute).not.toHaveBeenCalled();
  });
  it("callbacks from stopped connections are discarded even after a restart", async () => {
    const f = fixture();
    await f.ready();
    const old = f.sdk.callbacks();
    const stopping = f.adapter.stop().catch(() => {});
    await vi.runAllTimersAsync();
    await stopping;
    await f.adapter.start(f.sink);
    f.setNow(OPEN + 60000);
    old.candle(null, candle() as unknown as PushCandlestickEvent);
    old.quote(null, quote() as unknown as PushQuoteEvent);
    expect(f.sink.minute).not.toHaveBeenCalled();
    expect(f.sink.quote).not.toHaveBeenCalled();
    expect(f.sdk.mocks.unsubscribeCandlesticks).toHaveBeenCalledWith(
      "CONTRACT.US",
      1,
    );
  });
  it("SDK errors stop both data channels with a safe error code", async () => {
    const f = fixture();
    await f.ready();
    f.sdk.candle(null, new Error("private provider error"));
    expect(f.sink.disconnect).toHaveBeenCalledWith(
      "LONGBRIDGE_CANDLE_STREAM_ERROR",
    );
  });
  it("late subscribe acknowledgement gets compensating cleanup without reviving callbacks", async () => {
    const f = fixture();
    let resolve!: (value: string[]) => void;
    f.sdk.mocks.subscribeCandlesticks.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await f.adapter.start(f.sink);
    const task = f.adapter.setSubscriptions([INSTRUMENT]);
    const rejected = expect(task).rejects.toThrow(
      "LONGBRIDGE_SUBSCRIPTION_FAILED",
    );
    await vi.advanceTimersByTimeAsync(6101);
    await rejected;
    await expect(f.adapter.start(f.sink)).rejects.toThrow(
      "LONGBRIDGE_OPERATION_IN_FLIGHT",
    );
    expect(f.sdk.mocks.unsubscribeCandlesticks).not.toHaveBeenCalled();
    resolve([]);
    await vi.runAllTimersAsync();
    expect(f.sdk.mocks.unsubscribeCandlesticks).toHaveBeenCalledTimes(1);
    f.setNow(OPEN + 60000);
    f.sdk.candle(candle());
    expect(f.sink.minute).not.toHaveBeenCalled();
  });
  it("stopping during rate-limit waiting prevents the next native subscribe", async () => {
    const f = fixture();
    await f.adapter.start(f.sink);
    const task = f.adapter.setSubscriptions([INSTRUMENT]);
    const rejected = expect(task).rejects.toThrow(
      "LONGBRIDGE_SUBSCRIPTION_FAILED",
    );
    await vi.advanceTimersByTimeAsync(0);
    const stopping = f.adapter.stop().catch(() => {});
    await vi.runAllTimersAsync();
    await stopping;
    await rejected;
    expect(f.sdk.mocks.subscribeCandlesticks).not.toHaveBeenCalled();
  });
  it("accepts actual live callbacks during candle subscription acknowledgement, never the returned history", async () => {
    const f = fixture();
    await f.adapter.start(f.sink);
    f.sdk.mocks.subscribeCandlesticks.mockImplementation(async () => {
      f.setNow(OPEN + 60000);
      f.sdk.candle(candle());
      return ["history"];
    });
    const task = f.adapter.setSubscriptions([INSTRUMENT]);
    await vi.advanceTimersByTimeAsync(1100);
    await task;
    expect(f.sink.minute).toHaveBeenCalledTimes(1);
  });
  it("rate-limits and deduplicates cleanup, including after native acknowledgement arrives late", async () => {
    const f = fixture(() => {}, { ...quota, requestsPerSecond: 1 });
    const calls: number[] = [];
    f.sdk.mocks.subscribe.mockImplementation(async () => {
      calls.push(performance.now());
    });
    f.sdk.mocks.subscribeCandlesticks.mockImplementation(async () => {
      calls.push(performance.now());
      return [];
    });
    f.sdk.mocks.unsubscribe.mockImplementation(async () => {
      calls.push(performance.now());
    });
    f.sdk.mocks.unsubscribeCandlesticks.mockImplementation(async () => {
      calls.push(performance.now());
    });
    await f.ready();
    f.sdk.candle(null, new Error("disconnect"));
    const stopped = f.adapter.stop().catch(() => {});
    await vi.runAllTimersAsync();
    await stopped;
    expect(calls).toHaveLength(4);
    expect(calls.slice(1).every((at, i) => at - calls[i] >= 1000)).toBe(true);
    expect(f.sdk.mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it("cleanup rejection prevents reuse and is not reported as success on a second stop", async () => {
    const f = fixture();
    await f.ready();
    f.sdk.mocks.unsubscribe.mockRejectedValue(new Error("failed"));
    const stopped = expect(f.adapter.stop()).rejects.toThrow(
      "LONGBRIDGE_CLEANUP_FAILED",
    );
    await vi.runAllTimersAsync();
    await stopped;
    await expect(f.adapter.stop()).rejects.toThrow(
      "LONGBRIDGE_CLEANUP_UNCONFIRMED",
    );
    await expect(f.adapter.start(f.sink)).rejects.toThrow(
      "LONGBRIDGE_OPERATION_IN_FLIGHT",
    );
  });
  it("late acknowledgement cleanup is already scheduled before the owning database closes", async () => {
    const f = fixture();
    let release!: (value: string[]) => void;
    f.sdk.mocks.subscribeCandlesticks.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.adapter.start(f.sink);
    const subscribing = expect(
      f.adapter.setSubscriptions([INSTRUMENT]),
    ).rejects.toThrow("LONGBRIDGE_SUBSCRIPTION_FAILED");
    await vi.advanceTimersByTimeAsync(6101);
    await subscribing;
    const stopping = f.adapter.stop().catch(() => {});
    await vi.advanceTimersByTimeAsync(2001);
    await stopping;
    f.store.close();
    release([]);
    await vi.runAllTimersAsync();
    expect(f.sdk.mocks.unsubscribeCandlesticks).toHaveBeenCalledTimes(1);
    expect(f.sdk.mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.sink.minute).not.toHaveBeenCalled();
  });
  it("clock rollback and unknown subscription identity cannot deliver data", async () => {
    const f = fixture();
    await f.ready();
    await expect(f.adapter.setSubscriptions(["OTHER"])).rejects.toThrow(
      "LONGBRIDGE_SUBSCRIPTION_UNKNOWN",
    );
    f.setNow(OPEN - 2);
    f.sdk.candle(candle());
    expect(f.sink.disconnect).toHaveBeenCalled();
    expect(f.sink.minute).not.toHaveBeenCalled();
  });
  it("a normally stopped sampler's old enabled flag does not block audited startup", async () => {
    const f = fixture();
    f.store.db
      .prepare("INSERT INTO market_worker_state VALUES(1,?)")
      .run(JSON.stringify({ enabled: true, state: "STOPPED" }));
    await f.adapter.start(f.sink);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it("an unresolved asynchronous factory retains native ownership after timeout and stop", async () => {
    const f = fixture();
    let release!: (port: LongbridgeQuotePort) => void;
    const factory = vi.fn(
      () =>
        new Promise<LongbridgeQuotePort>((resolve) => {
          release = resolve;
        }),
    );
    const adapter = new LongbridgeClosedBarAdapter({
      contexts: [f.c],
      quota,
      db: f.store.db,
      contextFactory: factory,
      now: f.now,
      requestTimeoutMs: 5,
    });
    cleanup.push(() => adapter.stop().catch(() => {}));
    const opening = expect(adapter.start(f.sink)).rejects.toThrow(
      "LONGBRIDGE_START_FAILED",
    );
    await vi.advanceTimersByTimeAsync(6);
    await opening;
    await expect(adapter.start(f.sink)).rejects.toThrow(
      "LONGBRIDGE_OPERATION_IN_FLIGHT",
    );
    await expect(adapter.stop()).rejects.toThrow(
      "LONGBRIDGE_CLEANUP_UNCONFIRMED",
    );
    expect(factory).toHaveBeenCalledTimes(1);
    f.sdk.mocks.setOnQuote.mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    release(f.sdk.p);
    await vi.advanceTimersByTimeAsync(0);
    await expect(adapter.start(f.sink)).rejects.toThrow(
      "LONGBRIDGE_OPERATION_IN_FLIGHT",
    );
  });
  it("preserves a valid quote delivered before the SDK quote subscription acknowledges", async () => {
    const f = fixture();
    await f.adapter.start(f.sink);
    f.sdk.mocks.subscribe.mockImplementation(async () => {
      f.setNow(OPEN + 59000);
      f.sdk.quote(quote(OPEN + 59000));
    });
    const task = f.adapter.setSubscriptions([INSTRUMENT]);
    await vi.advanceTimersByTimeAsync(1100);
    await task;
    expect(f.sink.quote).toHaveBeenCalledWith(
      expect.objectContaining({ at: OPEN + 59000, price: "101" }),
    );
  });
  it("unknown quota, evidence source or units cannot open the SDK", () => {
    expect(() => fixture(() => {}, { ...quota, verified: false })).toThrow(
      "PROVIDER_QUOTA_UNKNOWN",
    );
    expect(() =>
      fixture((c) => {
        c.source = "arbitrary";
        c.capability.source = "arbitrary";
      }),
    ).toThrow("LONGBRIDGE_CONTEXT_SOURCE_MISMATCH");
    expect(() =>
      fixture((c) => {
        c.capability.unitsVerified = false;
      }),
    ).toThrow("LIVE_CAPABILITY_UNVERIFIED");
  });
  it("honors the lower provider subscription and persistent monthly symbol limits", async () => {
    const f = fixture(() => {}, { ...quota, simultaneousSubscriptions: 0 });
    await f.adapter.start(f.sink);
    await expect(f.adapter.setSubscriptions([INSTRUMENT])).rejects.toThrow(
      "MONITORING_LIMIT",
    );
    expect(f.sdk.mocks.subscribe).not.toHaveBeenCalled();
    const g = fixture(() => {}, { ...quota, monthlyUniqueSymbols: 1 });
    g.store.db
      .prepare("INSERT INTO market_worker_monthly_symbols VALUES(?,?)")
      .run("2026-10", "OTHER.US");
    await g.adapter.start(g.sink);
    await expect(g.adapter.setSubscriptions([INSTRUMENT])).rejects.toThrow(
      "MONTHLY_SYMBOL_LIMIT",
    );
  });
  it("refuses the unverified historical sampler's concurrent request lane", () => {
    const f = fixture();
    f.store.db
      .prepare("INSERT INTO market_worker_state VALUES(1,?)")
      .run(JSON.stringify({ enabled: true }));
    expect(
      () =>
        new LongbridgeClosedBarAdapter({
          contexts: [f.c],
          quota,
          db: f.store.db,
          contextFactory: f.factory,
          now: f.now,
        }),
    ).toThrow("LONGBRIDGE_SAMPLER_MUST_BE_DISABLED");
  });
  it("environment factory only reads secrets after the audited server path starts", async () => {
    const f = fixture();
    const env = {
      LONGBRIDGE_APP_KEY: "test-key",
      LONGBRIDGE_APP_SECRET: "test-secret",
      LONGBRIDGE_ACCESS_TOKEN: "test-token",
    };
    vi.mocked(SDKQuoteContext.new).mockReturnValue(f.sdk.p as QuoteContext);
    const a = longbridgeClosedBarFactory([f.c], quota, env, f.now)(f.store);
    cleanup.push(() => a.stop());
    expect(Config.fromApikey).not.toHaveBeenCalled();
    await a.start(f.sink);
    expect(Config.fromApikey).toHaveBeenCalledWith(
      "test-key",
      "test-secret",
      "test-token",
      {
        enablePrintQuotePackages: false,
        enableOvernight: false,
        pushCandlestickMode: 1,
      },
    );
  });
  it("routes SDK-shaped callbacks through durable runtime normalization and exact-context screening", async () => {
    const f = fixture();
    const runtime = new ClosedBarRuntime(f.store, {
      adapter: f.adapter,
      now: f.now,
    });
    cleanup.push(() => runtime.stop());
    await runtime.start();
    f.store.confirmScreening(undefined, 0, f.now());
    f.store.updateFunds({ ...testFunds, fxAsOf: f.now() }, 0, f.now());
    const plan = f.store.createPlan(planInput, f.now());
    runtime.activate(plan.id, { expectedVersion: 1, expectedAttemptId: null });
    await vi.advanceTimersByTimeAsync(1100);
    const screening = new ScreeningService(f.store);
    const page = screening.candidates(f.now());
    expect(page.candidates[0].health.state).toBe("VERIFIED");
    expect(page.candidates[0].screeningStatus).not.toBe("UNKNOWN");
    f.setNow(OPEN + 60000);
    f.sdk.quote(quote());
    f.sdk.candle(candle());
    expect(
      f.store.db.prepare("SELECT COUNT(*) n FROM closed_receipts").get(),
    ).toEqual({ n: 2 });
    expect(
      f.store.db.prepare("SELECT COUNT(*) n FROM market_raw_inputs").get(),
    ).toEqual({ n: 1 });
    const row = f.store.db
      .prepare("SELECT payload_json FROM market_raw_inputs")
      .get() as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({
      receivedAt: OPEN + 60000,
      providerSequence: null,
      source: LONGBRIDGE_SOURCE,
    });
    expect(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM market_provider_receipts")
        .get(),
    ).toEqual({ n: 0 });
    f.setNow(f.c.capability.validUntil + 1);
    const expired = screening.candidates(f.now());
    expect(expired.cacheHit).toBe(false);
    expect(expired.candidates[0].screeningStatus).toBe("UNKNOWN");
  });
  it("wires the same production factory into createApp and exposes provenance plus verified daily AVWAP", async () => {
    const c = context();
    const sdk = port();
    let now = OPEN - 1;
    const app = await createApp({
      password: "isolated-password",
      now: () => now,
      closedBarAdapterFactory: (store) => {
        store.putInstrument({
          instrument: c.instrument,
          manual: false,
          tags: [],
          note: "isolated SDK-shaped test",
        });
        return new LongbridgeClosedBarAdapter({
          contexts: [c],
          quota,
          db: store.db,
          contextFactory: () => sdk.p,
          now: () => now,
        });
      },
    });
    cleanup.push(() => app.close());
    await app.monitor.start();
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { "x-requested-with": "PullbackLab" },
      payload: { password: "isolated-password" },
    });
    const cookie = login.headers["set-cookie"]!.toString().split(";")[0];
    const url = `/api/instruments/${INSTRUMENT}/bars?anchorTime=${c.daily[0].time}`;
    const chart = (await app.inject({ url, headers: { cookie } })).json();
    expect(chart.synthetic).toBe(false);
    expect(chart.providerContext).toMatchObject({
      source: LONGBRIDGE_SOURCE,
      researchOnly: true,
    });
    expect(chart.avwap.at(-1)).not.toBeNull();
    now = c.capability.validUntil + 1;
    const expired = (await app.inject({ url, headers: { cookie } })).json();
    expect(expired.providerContext).toBeNull();
    expect(expired.avwap.every((v: unknown) => v === null)).toBe(true);
  });
});
