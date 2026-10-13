import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runMarketProbe,
  type ProbeOptions,
  type ProbeReport,
} from "./probe.js";
import type { ProviderBarSample } from "./longbridge.js";
import { OperationTimeout } from "./deadline.js";
const at = Date.parse("2026-10-12T14:00:00Z");
const bar: ProviderBarSample = {
  symbol: "AAPL.US",
  period: "1m",
  timestamp: at - 60_000,
  receivedAt: at + 500,
  open: "100",
  high: "102",
  low: "99",
  close: "101",
  volume: "100",
  turnover: "10000",
  tradeSession: 0,
  adjustment: "RAW",
  finality: "CONFIRMED",
  volumeUnit: "UNVERIFIED",
};
function fixture(overrides: Partial<ProbeOptions> = {}) {
  const adapter = {
    source: "longbridge-node-5.2.0" as const,
    fetchDailyHistoryPage: vi.fn(
      async (symbol: string, from: string, _through: string) =>
        Array.from({ length: 6 }, (_, i) => ({
          ...bar,
          symbol,
          period: "1D" as const,
          timestamp: Date.parse(`${from}T05:00:00Z`) + i * 86400000,
          receivedAt: at,
          finality: "UNKNOWN" as const,
        })),
    ),
    quoteLevelEvidence: vi.fn(async () => "LV1"),
    quotePackagesEvidence: vi.fn(async () => [
      { key: "test", name: "fixture", startAt: at, endAt: at + 1000 },
    ]),
    instrumentEvidence: vi.fn(async (symbols: string[]) => [
      {
        symbol: symbols[0],
        exchange: "test",
        currency: "USD",
        lotSize: 1,
        rulesVerified: false as const,
      },
    ]),
    fetchQuotes: vi.fn(async (symbols: string[]) => [
      { symbol: symbols[0], price: "101", timestamp: at, receivedAt: at },
    ]),
    fetchBars: vi.fn(async () => [bar]),
    calendarEvidence: vi.fn(
      async (_market: "US" | "CN", from: string, _through: string) => ({
        tradingDays: [from],
        halfDays: [],
        sessionHoursVerified: false as const,
      }),
    ),
    observeConfirmed: vi.fn(async () => [bar]),
  };
  const factory = vi.fn(async () => adapter);
  const snapshots: ProbeReport[] = [];
  const options: ProbeOptions = {
    symbols: ["AAPL.US", "600519.SH"],
    observeSeconds: 1,
    env: {
      LONGBRIDGE_APP_KEY: "test-key",
      LONGBRIDGE_APP_SECRET: "test-secret",
      LONGBRIDGE_ACCESS_TOKEN: "test-token",
    },
    runtime: "test",
    sdk: "5.2.0",
    platform: "test",
    architecture: "test",
    now: () => at,
    requestSpacingMs: 0,
    requestTimeoutMs: 50,
    adapterFactory: factory,
    checkpoint: (r) => snapshots.push(r),
    ...overrides,
  };
  return { adapter, factory, snapshots, options };
}
afterEach(() => vi.useRealTimers());
describe("partial read-only evidence probe", () => {
  it("samples each symbol and 1D/1m/5m independently; preserves both markets as UNKNOWN", async () => {
    const f = fixture();
    const { report, exitCode } = await runMarketProbe(f.options);
    expect(exitCode).toBe(2);
    expect(report.status).toBe("SAMPLES_COLLECTED_CAPABILITY_UNKNOWN");
    expect(f.adapter.fetchBars.mock.calls).toEqual([
      ["AAPL.US", "1D", 300],
      ["AAPL.US", "1m", 60],
      ["AAPL.US", "5m", 60],
      ["600519.SH", "1D", 300],
      ["600519.SH", "1m", 60],
      ["600519.SH", "5m", 60],
    ]);
    expect(report.capabilities.every((x) => x.level === "UNKNOWN")).toBe(true);
    expect(report.checks.entitlements).toBe("UNKNOWN");
    expect(report.steps.at(-1)?.evidence).toMatchObject({
      confirmedCount: 1,
      observedDelayMs: { p95: 500 },
      clockVerified: false,
      timestampSemanticsVerified: false,
    });
    expect(f.snapshots[1].steps).toHaveLength(1);
    expect(f.snapshots.at(-1)).toEqual(report);
    expect(JSON.stringify(report)).not.toContain("test-secret");
  });
  it("retains quote level and earlier samples when later requests fail, then continues independent steps", async () => {
    const f = fixture();
    f.adapter.quotePackagesEvidence.mockRejectedValue(
      new Error("secret-token http://private"),
    );
    f.adapter.fetchBars.mockRejectedValueOnce(
      new Error("private-provider-error"),
    );
    const { report, exitCode } = await runMarketProbe(f.options);
    expect(exitCode).toBe(1);
    expect(report.status).toBe("INCOMPLETE_CAPABILITY_UNKNOWN");
    expect(report.steps.find((x) => x.id === "quote-level")).toMatchObject({
      status: "SAMPLED",
      evidence: { level: "LV1" },
    });
    expect(report.steps.find((x) => x.id === "bars:AAPL.US:1D")?.status).toBe(
      "FAILED",
    );
    expect(report.steps.find((x) => x.id === "bars:AAPL.US:5m")?.status).toBe(
      "SAMPLED",
    );
    expect(report.steps.find((x) => x.id === "calendar:CN")?.status).toBe(
      "SAMPLED",
    );
    expect(JSON.stringify(report)).not.toMatch(
      /secret-token|private-provider-error|http:\/\/private/,
    );
  });
  it("records a timeout and skips all further network work without accumulating unresolved requests", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let lateReject!: (e: Error) => void;
    f.adapter.fetchBars.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          lateReject = reject;
        }),
    );
    const task = runMarketProbe(f.options);
    await vi.advanceTimersByTimeAsync(50);
    const { report, exitCode } = await task;
    expect(exitCode).toBe(1);
    expect(report.steps.find((x) => x.id === "bars:AAPL.US:1D")?.status).toBe(
      "TIMED_OUT",
    );
    expect(report.steps.find((x) => x.id === "quote:600519.SH")).toMatchObject({
      status: "SKIPPED",
      reason: "PREVIOUS_REQUEST_UNSETTLED",
    });
    expect(f.adapter.fetchBars).toHaveBeenCalledTimes(1);
    expect(f.adapter.calendarEvidence).not.toHaveBeenCalled();
    const frozen = JSON.stringify(report);
    lateReject(new Error("late-secret-error"));
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(report)).toBe(frozen);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("distinguishes empty observations and empty bars from verified capability", async () => {
    const f = fixture();
    f.adapter.observeConfirmed.mockResolvedValue([]);
    f.adapter.fetchBars.mockResolvedValue([]);
    const { report, exitCode } = await runMarketProbe(f.options);
    expect(exitCode).toBe(2);
    expect(report.status).toBe("INCOMPLETE_CAPABILITY_UNKNOWN");
    expect(report.steps.at(-1)).toMatchObject({
      status: "EMPTY",
      evidence: { confirmedCount: 0, observedDelayMs: null },
    });
  });
  it.each([
    { env: {} },
    { symbols: [] },
    { symbols: ["AAPL.US", "AAPL.US"] },
    { symbols: ["600519.US/secret"] },
    { observeSeconds: 0.5 },
    { observeSeconds: NaN },
    { observeSeconds: 121 },
  ])(
    "rejects missing credentials/invalid input without initializing native SDK: %j",
    async (options) => {
      const f = fixture(options);
      const result = await runMarketProbe(f.options);
      expect(result.exitCode).toBe(2);
      expect(result.report.status).toBe("BLOCKED");
      expect(f.factory).not.toHaveBeenCalled();
    },
  );
  it("stops after initialization timeout without exposing native error text", async () => {
    const f = fixture({
      adapterFactory: async () => {
        throw new OperationTimeout();
      },
    });
    const { report } = await runMarketProbe(f.options);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({
      id: "adapter",
      status: "TIMED_OUT",
    });
  });
  it("stops network work if the evidence journal cannot be saved", async () => {
    const f = fixture({
      checkpoint: (r) => {
        if (r.steps.length === 2) throw new Error("journal full");
      },
    });
    await expect(runMarketProbe(f.options)).rejects.toThrow("journal full");
    expect(f.adapter.quotePackagesEvidence).not.toHaveBeenCalled();
  });
  it("enforces a single paced request lane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const f = fixture({
      requestSpacingMs: 1000,
      now: Date.now,
      observeSeconds: 0,
      symbols: ["AAPL.US"],
    });
    const task = runMarketProbe(f.options);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.adapter.quoteLevelEvidence).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.adapter.quoteLevelEvidence).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect((await task).exitCode).toBe(2);
    expect(f.adapter.observeConfirmed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("explicit date-window probe collection", () => {
  const historyWindow = { from: "2026-01-01", through: "2026-04-10" };
  it("retains every raw receipt and matching historical calendar page beyond the five-sample preview", async () => {
    const f = fixture({
      symbols: ["AAPL.US"],
      observeSeconds: 0,
      historyWindow,
    });
    const { report, exitCode } = await runMarketProbe(f.options);
    expect(exitCode).toBe(2);
    expect(f.adapter.fetchBars).not.toHaveBeenCalled();
    expect(f.adapter.fetchDailyHistoryPage.mock.calls).toEqual([
      ["AAPL.US", "2026-01-01", "2026-03-31"],
      ["AAPL.US", "2026-04-01", "2026-04-10"],
    ]);
    expect(f.adapter.calendarEvidence.mock.calls).toEqual([
      ["US", "2026-01-01", "2026-03-31"],
      ["US", "2026-04-01", "2026-04-10"],
    ]);
    const c = report.historyCaptures![0];
    expect(c.pages.flatMap((p) => p.samples)).toHaveLength(12);
    expect(c).toMatchObject({
      ...historyWindow,
      status: "SAMPLED",
      capability: "UNKNOWN",
      coverage: "UNKNOWN",
      timestampAnchor: "UNKNOWN",
      completedAt: at,
    });
    expect(
      f.snapshots.some(
        (r) =>
          r.historyCaptures?.[0]?.pages.length === 1 &&
          r.historyCaptures[0].calendarPages.length === 0,
      ),
    ).toBe(true);
    const { prepareLongbridgeHistoryCandidates } =
      await import("../../apps/server/longbridge-history-input.js");
    expect(
      prepareLongbridgeHistoryCandidates(c, { symbol: "AAPL.US", market: "US" })
        .samples,
    ).toHaveLength(12);
  });
  it("retains earlier pages and marks the capture incomplete when a later page fails", async () => {
    const f = fixture({
      symbols: ["AAPL.US"],
      observeSeconds: 0,
      historyWindow,
    });
    f.adapter.fetchDailyHistoryPage.mockRejectedValueOnce(
      new Error("private-host-error"),
    );
    const { report, exitCode } = await runMarketProbe(f.options);
    expect(exitCode).toBe(1);
    expect(report.historyCaptures![0].status).toBe("INCOMPLETE");
    expect(report.historyCaptures![0].pages).toHaveLength(1);
    expect(report.historyCaptures![0].calendarPages).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("private-host-error");
  });
  it("does not issue calendar or further page requests after timeout, even after late settlement", async () => {
    vi.useFakeTimers();
    const f = fixture({
      symbols: ["AAPL.US"],
      observeSeconds: 0,
      historyWindow,
    });
    let resolve!: (value: never[]) => void;
    f.adapter.fetchDailyHistoryPage.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const task = runMarketProbe(f.options);
    await vi.advanceTimersByTimeAsync(50);
    const { report } = await task;
    expect(report.historyCaptures![0].status).toBe("INCOMPLETE");
    expect(f.adapter.fetchDailyHistoryPage).toHaveBeenCalledTimes(1);
    expect(f.adapter.calendarEvidence).not.toHaveBeenCalled();
    const before = JSON.stringify(report);
    resolve([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(report)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { from: "2026-02-30", through: "2026-04-10" },
    { from: "2026-04-10", through: "2026-01-01" },
    { from: "2020-01-01", through: "2026-01-01" },
  ])(
    "blocks invalid date windows before adapter creation: %j",
    async (historyWindow) => {
      const f = fixture({ historyWindow });
      expect((await runMarketProbe(f.options)).report.status).toBe("BLOCKED");
      expect(f.factory).not.toHaveBeenCalled();
    },
  );
  it("stops further requests if a historical checkpoint cannot be persisted", async () => {
    const f = fixture({
      symbols: ["AAPL.US"],
      observeSeconds: 0,
      historyWindow,
      checkpoint: (report) => {
        if (report.historyCaptures?.[0]?.pages.length)
          throw new Error("journal full");
      },
    });
    await expect(runMarketProbe(f.options)).rejects.toThrow("journal full");
    expect(f.adapter.fetchDailyHistoryPage).toHaveBeenCalledTimes(1);
    expect(f.adapter.calendarEvidence).not.toHaveBeenCalled();
  });
});
