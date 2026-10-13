import type { QuoteContext } from "longbridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeRawTradeSources,
  TRADE_SOURCE_TRADE_LIMIT,
  TRADE_SOURCE_PACKET_LIMIT,
} from "./longbridge-trade-observer.js";
const AT = Date.parse("2026-10-13T07:00:00Z");
function fixture() {
  let callback: Parameters<QuoteContext["setOnTrades"]>[0] = () => {};
  const ctx = {
    setOnTrades: vi.fn((next: typeof callback) => {
      callback = next;
    }),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
  };
  const trade = (volume = 2) => ({
    timestamp: new Date(AT),
    price: { toString: () => "10.25" },
    volume,
    tradeType: "",
    direction: 0,
    tradeSession: 0,
  });
  const emit = (trades = [trade()]) =>
    callback(null, {
      symbol: "688008.SH",
      data: { trades },
    } as Parameters<typeof callback>[1]);
  return {
    ctx,
    trade,
    emit,
    callback: () => callback,
    observe: () =>
      observeRawTradeSources(
        ctx as unknown as QuoteContext,
        ["688008.SH"],
        1000,
        20,
        () => AT + 1000,
      ),
  };
}
afterEach(() => vi.useRealTimers());
describe("bounded raw CN trade source observation", () => {
  it("uses only Trade subscription, preserves raw packet quantities and detaches stale callbacks", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = f.observe();
    await vi.advanceTimersByTimeAsync(0);
    const old = f.callback();
    f.emit();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result).toMatchObject({
      status: "SAMPLED",
      cleanup: "COMPLETE",
      reusable: true,
      packets: [
        {
          providerSequence: null,
          trades: [{ volume: "2", timestamp: AT, price: "10.25" }],
        },
      ],
    });
    expect(f.ctx.subscribe).toHaveBeenCalledWith(["688008.SH"], [3]);
    expect(f.ctx.unsubscribe).toHaveBeenCalledWith(["688008.SH"], [3]);
    old(null, {
      symbol: "688008.SH",
      data: { trades: [f.trade()] },
    } as Parameters<typeof old>[1]);
    expect(result.packets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains valid prefix but rejects a whole over-limit callback without truncating it", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = f.observe();
    await vi.advanceTimersByTimeAsync(0);
    f.emit();
    f.emit(Array(TRADE_SOURCE_TRADE_LIMIT).fill(f.trade()));
    const result = await pending;
    expect(result.status).toBe("INCOMPLETE");
    expect(result.failure).toBe("TRADE_SOURCE_SAMPLE_LIMIT");
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0].trades).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds callbacks even when they contain zero trades", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = f.observe();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i <= TRADE_SOURCE_PACKET_LIMIT; i++) f.emit([]);
    const result = await pending;
    expect(result.packets).toHaveLength(TRADE_SOURCE_PACKET_LIMIT);
    expect(result.failure).toBe("TRADE_SOURCE_SAMPLE_LIMIT");
  });
  it.each([Number.MAX_SAFE_INTEGER + 1, NaN, -1, 0.5])(
    "rejects unsafe raw transport volume %s before appending",
    async (volume) => {
      vi.useFakeTimers();
      const f = fixture(),
        pending = f.observe();
      await vi.advanceTimersByTimeAsync(0);
      f.emit();
      f.emit([f.trade(), f.trade(volume)]);
      const result = await pending;
      expect(result.failure).toBe("TRADE_SOURCE_SAMPLE_INVALID");
      expect(result.packets).toHaveLength(1);
    },
  );
  it("does not leak native error text or discard prior raw samples on a stream error", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = f.observe();
    await vi.advanceTimersByTimeAsync(0);
    f.emit();
    f.callback()(
      new Error("credential-secret https://private"),
      undefined as never,
    );
    const result = await pending;
    expect(result.failure).toBe("TRADE_SOURCE_STREAM_ERROR");
    expect(result.packets).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("credential-secret");
  });
  it("cleans up ambiguous subscribe failure and returns incomplete evidence", async () => {
    const f = fixture();
    f.ctx.subscribe.mockRejectedValueOnce(new Error("secret"));
    const result = await f.observe();
    expect(result.failure).toBe("TRADE_SOURCE_SUBSCRIBE_FAILED");
    expect(f.ctx.unsubscribe).toHaveBeenCalledOnce();
  });
  it("poisons a timed-out context and compensates late subscribe acknowledgement", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: () => void;
    f.ctx.subscribe.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const pending = f.observe();
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result.failure).toBe("TRADE_SOURCE_TIMEOUT");
    expect(result.reusable).toBe(false);
    expect(f.ctx.unsubscribe).toHaveBeenCalledOnce();
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.ctx.unsubscribe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds hanging cleanup and cannot report sampled success", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.ctx.unsubscribe.mockImplementation(() => new Promise(() => {}));
    const pending = f.observe();
    await vi.advanceTimersByTimeAsync(1020);
    const result = await pending;
    expect(result).toMatchObject({
      status: "INCOMPLETE",
      cleanup: "FAILED",
      reusable: false,
      failure: "TRADE_SOURCE_CLEANUP_FAILED",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("validates CN symbol/time limits before touching the context", async () => {
    const f = fixture();
    for (const symbols of [
      [],
      ["NVDA.US"],
      ["688008.SH", "688008.SH"],
      ["399001.SZ", "688008.SH", "600519.SH"],
    ])
      await expect(
        observeRawTradeSources(f.ctx as never, symbols, 1000, 20, () => AT),
      ).rejects.toThrow("TRADE_SOURCE_BOUNDS_INVALID");
    await expect(
      observeRawTradeSources(
        f.ctx as never,
        ["688008.SH"],
        120001,
        20,
        () => AT,
      ),
    ).rejects.toThrow("TRADE_SOURCE_BOUNDS_INVALID");
    expect(f.ctx.setOnTrades).not.toHaveBeenCalled();
    expect(f.ctx.subscribe).not.toHaveBeenCalled();
  });
});
