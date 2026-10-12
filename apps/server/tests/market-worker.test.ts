import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Instrument } from "../../../packages/contracts/index.js";
import type {
  MarketDataAdapter,
  ProviderBarSample,
} from "../../../packages/market-data/longbridge.js";
import {
  resolveSession,
  type MarketSession,
} from "../../../packages/market-data/calendar.js";
import {
  MarketWorker,
  createMarketWorkerFromEnvironment,
  type MarketWorkerOptions,
  type VerifiedSampleEvidence,
} from "../market-worker.js";

const instrument: Instrument = {
  id: "US:TEST.US",
  symbol: "TEST.US",
  name: "Test",
  market: "US",
  currency: "USD",
  tick: "0.01",
  qMin: 1,
  qStep: 1,
  sellSameDay: true,
  rulesVerified: false,
};
const at = Date.parse("2026-10-15T22:00:00Z");
function session(date = "2026-10-09"): MarketSession {
  const result = resolveSession(
    [
      {
        market: "US",
        date,
        status: "OPEN",
        intervals: [{ open: "09:30", close: "16:00" }],
        source: "test-exchange",
        version: "v1",
        knownAt: at - 30 * 86400000,
        verified: true,
      },
    ],
    "US",
    date,
    at,
  );
  if (!result.ok || !result.session) throw new Error("invalid fixture");
  return result.session;
}
function sample(overrides: Partial<ProviderBarSample> = {}): ProviderBarSample {
  return {
    symbol: instrument.symbol,
    period: "1D",
    timestamp: session().open,
    receivedAt: at,
    open: "100",
    high: "103",
    low: "99",
    close: "100",
    volume: "1000",
    turnover: "100000",
    tradeSession: 0,
    adjustment: "RAW",
    finality: "UNKNOWN",
    volumeUnit: "UNVERIFIED",
    ...overrides,
  };
}
function evidence(
  s: ProviderBarSample,
  revision = "r1",
  day = "2026-10-09",
  expectedPreviousStart?: number,
): VerifiedSampleEvidence {
  const resolved = session(day);
  return {
    evidenceId: "audited-test-evidence",
    verifiedAt: at - 1000,
    session: resolved,
    expectedPreviousStart,
    raw: {
      id: `verified:${day}:${revision}`,
      instrumentId: instrument.id,
      market: "US",
      period: "1D",
      start: resolved.open,
      end: resolved.close,
      open: s.open,
      high: s.high,
      low: s.low,
      close: s.close,
      volume: s.volume,
      turnover: s.turnover,
      volumeUnit: "SHARE",
      final: true,
      receivedAt: s.receivedAt,
      source: "test-provider",
      providerRevision: revision,
      sessionId: resolved.id,
      adjustment: "RAW",
    },
  };
}
function fakeAdapter(
  fetchBars: MarketDataAdapter["fetchBars"],
): MarketDataAdapter {
  return {
    source: "test-provider",
    fetchBars,
    fetchQuotes: vi.fn(async () => []),
    capabilities: () => [],
  };
}
const cleanup: Array<() => Promise<void>> = [];
function setup(extra: Partial<MarketWorkerOptions> = {}) {
  const db = new Database(":memory:");
  let now = at;
  const fetchBars = vi.fn(async () => [sample({ receivedAt: now })]);
  const worker = new MarketWorker({
    db,
    researchInstruments: () => [instrument],
    enabled: true,
    adapterFactory: () => fakeAdapter(fetchBars),
    now: () => now,
    ...extra,
  });
  cleanup.push(async () => {
    await worker.stop();
    db.close();
  });
  return {
    db,
    worker,
    fetchBars,
    advance: (ms = 16 * 60_000) => {
      now += ms;
    },
    now: () => now,
  };
}
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.useRealTimers();
});

describe("server-owned daily evidence worker", () => {
  it("defaults to disabled and never constructs the SDK without explicit enablement and credentials", async () => {
    const db = new Database(":memory:");
    const store = { db, listInstruments: () => [{ instrument }] };
    const disabled = createMarketWorkerFromEnvironment(store, {});
    await disabled.pollOnce();
    expect(disabled.status()).toMatchObject({
      enabled: false,
      state: "DISABLED",
      reason: "WORKER_DISABLED",
      connectionEpoch: 0,
      liveEligible: false,
    });
    await disabled.stop();
    const missing = createMarketWorkerFromEnvironment(store, {
      PULLBACK_MARKET_WORKER: "1",
    });
    await missing.pollOnce();
    expect(missing.status()).toMatchObject({
      enabled: true,
      state: "DISABLED",
      reason: "CREDENTIALS_MISSING",
      sampleCount: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM market_worker_epochs").get(),
    ).toEqual({ n: 0 });
    await missing.stop();
    db.close();
  });
  it("persists raw provider samples, receipt order and actual receipt time; unknown finality remains quarantined", async () => {
    const { db, worker, fetchBars, advance, now } = setup();
    await worker.pollOnce();
    advance();
    await worker.pollOnce();
    expect(fetchBars).toHaveBeenNthCalledWith(1, "TEST.US", "1D", 300);
    expect(fetchBars).toHaveBeenNthCalledWith(2, "TEST.US", "1D", 5);
    const receipts = db
      .prepare("SELECT * FROM market_provider_receipts ORDER BY sequence")
      .all() as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      sequence: 1,
      epoch: 1,
      historical: 1,
      received_at: at,
      observed_at: at,
      status: "QUARANTINED",
      reason: "FINALITY_UNVERIFIED",
      normalized_sequence: null,
    });
    expect(JSON.parse(String(receipts[0].payload_json))).toEqual(sample());
    expect(receipts[1].received_at).toBe(now());
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM market_raw_inputs").get(),
    ).toEqual({ n: 0 });
    expect(worker.status()).toMatchObject({
      sampleCount: 2,
      quarantinedCount: 2,
      duplicateCount: 1,
      acceptedCount: 0,
      lastSuccessAt: now(),
      lastQuarantineReason: "FINALITY_UNVERIFIED",
      continuity: "UNVERIFIED",
      providerQuotaVerified: false,
      liveEligible: false,
    });
    expect(worker.status().watermarks[0]).toMatchObject({
      providerTimestamp: sample().timestamp,
      receivedAt: now(),
      connectionEpoch: 1,
      historical: true,
    });
    expect(() =>
      db.prepare("UPDATE market_provider_receipts SET reason='verified'").run(),
    ).toThrow("IMMUTABLE_PROVIDER_RECEIPT");
    expect(() =>
      db.prepare("DELETE FROM market_provider_receipts").run(),
    ).toThrow("IMMUTABLE_PROVIDER_RECEIPT");
    expect(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO market_provider_receipts SELECT * FROM market_provider_receipts WHERE sequence=1",
        )
        .run(),
    ).toThrow("IMMUTABLE_PROVIDER_RECEIPT");
  });
  it("does not promote confirmed bars without audited unit/calendar evidence and never overrides unknown finality", async () => {
    const confirm = setup({
      adapterFactory: () =>
        fakeAdapter(async () => [sample({ finality: "CONFIRMED" })]),
    });
    await confirm.worker.pollOnce();
    expect(confirm.worker.status()).toMatchObject({
      quarantinedCount: 1,
      acceptedCount: 0,
      lastQuarantineReason: "AUDITED_EVIDENCE_REQUIRED",
    });
    const verifier = vi.fn((s: ProviderBarSample) => evidence(s));
    const unknown = setup({ verifySample: verifier });
    await unknown.worker.pollOnce();
    expect(verifier).not.toHaveBeenCalled();
    expect(unknown.worker.status().acceptedCount).toBe(0);
  });
  it("quarantines a verified payload mapped to the wrong day and keeps future timestamps out of watermarks", async () => {
    let current = sample({ finality: "CONFIRMED" });
    const ctx = setup({
      adapterFactory: () => fakeAdapter(async () => [current]),
      verifySample: (s) => evidence(s, "r1", "2026-10-08"),
    });
    await ctx.worker.pollOnce();
    expect(ctx.worker.status()).toMatchObject({
      acceptedCount: 0,
      quarantinedCount: 1,
      lastQuarantineReason: "EVIDENCE_SAMPLE_MISMATCH",
    });
    const previous = ctx.worker.status().watermarks[0];
    ctx.advance();
    current = {
      ...current,
      timestamp: ctx.now() + 86400000,
      receivedAt: ctx.now(),
    };
    await ctx.worker.pollOnce();
    expect(ctx.worker.status()).toMatchObject({
      acceptedCount: 0,
      quarantinedCount: 2,
      lastQuarantineReason: "SAMPLE_IDENTITY_OR_TIME_INVALID",
    });
    expect(ctx.worker.status().watermarks[0]).toEqual(previous);
    expect(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM market_raw_inputs").get(),
    ).toEqual({ n: 0 });
  });
  it("contains persistence failures from timer initialization and receipt writes without unhandled rejections", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const db = new Database(":memory:");
    const fetch = vi.fn(async () => [sample({ receivedAt: Date.now() })]);
    const worker = new MarketWorker({
      db,
      researchInstruments: () => [instrument],
      enabled: true,
      adapterFactory: () => fakeAdapter(fetch),
      pollIntervalMs: 60000,
    });
    db.exec(
      "CREATE TRIGGER reject_state BEFORE UPDATE ON market_worker_state BEGIN SELECT RAISE(ABORT,'private storage details'); END;",
    );
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(worker.status()).toMatchObject({
      state: "BACKOFF",
      reason: "PERSISTENCE_UNAVAILABLE",
      sampleCount: 0,
    });
    expect(JSON.stringify(worker.status())).not.toContain(
      "private storage details",
    );
    db.exec(
      "DROP TRIGGER reject_state;CREATE TRIGGER reject_receipt BEFORE INSERT ON market_provider_receipts BEGIN SELECT RAISE(ABORT,'private storage details'); END;",
    );
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(worker.status()).toMatchObject({
      state: "BACKOFF",
      reason: "PERSISTENCE_UNAVAILABLE",
      sampleCount: 0,
    });
    db.exec("DROP TRIGGER reject_receipt");
    await vi.advanceTimersByTimeAsync(60000);
    expect(worker.status()).toMatchObject({ state: "IDLE", sampleCount: 1 });
    await worker.stop();
    db.close();
  });
  it("serializes concurrent polls and bounds shutdown; late provider completion cannot write to a closed DB", async () => {
    let finish!: (samples: ProviderBarSample[]) => void;
    const fetch = vi.fn(
      () =>
        new Promise<ProviderBarSample[]>((resolve) => {
          finish = resolve;
        }),
    );
    const { db, worker } = setup({
      adapterFactory: () => fakeAdapter(fetch),
      shutdownTimeoutMs: 5,
    });
    const first = worker.pollOnce();
    const second = worker.pollOnce();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await worker.stop();
    expect(worker.status()).toMatchObject({ state: "STOPPED", sampleCount: 0 });
    db.close();
    cleanup.pop();
    finish([sample()]);
    await first;
  });
  it("backs off with a safe error code and preserves counts/watermarks while creating a new restart epoch", async () => {
    let fail = true;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("secret-access-token=do-not-leak");
      return [sample()];
    });
    const ctx = setup({ adapterFactory: () => fakeAdapter(fetch) });
    await ctx.worker.pollOnce();
    expect(ctx.worker.status()).toMatchObject({
      state: "BACKOFF",
      lastFailureAt: at,
      lastErrorCode: "PROVIDER_REQUEST_FAILED",
      nextPollAt: at + 5000,
    });
    expect(JSON.stringify(ctx.worker.status())).not.toContain(
      "secret-access-token",
    );
    await ctx.worker.pollOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    ctx.advance(5000);
    fail = false;
    await ctx.worker.pollOnce();
    expect(ctx.worker.status()).toMatchObject({
      state: "IDLE",
      consecutiveFailures: 0,
      requestCount: 2,
      sampleCount: 1,
      connectionEpoch: 1,
    });
    await ctx.worker.stop();
    ctx.advance();
    const restarted = new MarketWorker({
      db: ctx.db,
      researchInstruments: () => [instrument],
      enabled: true,
      adapterFactory: () => fakeAdapter(fetch),
      now: ctx.now,
    });
    await restarted.pollOnce();
    expect(restarted.status()).toMatchObject({
      connectionEpoch: 2,
      sampleCount: 2,
      requestCount: 3,
      continuity: "UNVERIFIED",
    });
    expect(restarted.status().watermarks[0]).toMatchObject({
      connectionEpoch: 2,
      historical: true,
    });
    await restarted.stop();
  });
  it("normalizes audited fixtures, preserves revisions and pauses on conflicting corrections and calendar gaps atomically", async () => {
    let current = sample({ finality: "CONFIRMED" });
    let revision = "r1";
    let day = "2026-10-09";
    let expectedPreviousStart: number | undefined;
    const changes: string[] = [];
    const ctx = setup({
      adapterFactory: () => fakeAdapter(async () => [current]),
      verifySample: (s) => evidence(s, revision, day, expectedPreviousStart),
      onInvalidation: (e) => {
        changes.push(e.reason);
        ctx.db.prepare("UPDATE test_plan SET status='DATA_PAUSED'").run();
      },
    });
    ctx.db.exec(
      "CREATE TABLE test_plan(status TEXT);INSERT INTO test_plan VALUES('ACTIVE');",
    );
    await ctx.worker.pollOnce();
    ctx.advance();
    current = { ...current, receivedAt: ctx.now() };
    await ctx.worker.pollOnce();
    revision = "r2";
    current = { ...current, close: "101" };
    ctx.advance();
    await ctx.worker.pollOnce();
    current = { ...current, close: "100.5" };
    ctx.advance();
    await ctx.worker.pollOnce();
    day = "2026-10-13";
    expectedPreviousStart = session("2026-10-12").open;
    revision = "r1";
    current = { ...current, timestamp: session(day).open };
    ctx.advance();
    await ctx.worker.pollOnce();
    expect(changes).toEqual(["BAR_REVISION", "BAR_CONFLICT", "DATA_GAP"]);
    expect(ctx.db.prepare("SELECT status FROM test_plan").get()).toEqual({
      status: "DATA_PAUSED",
    });
    const receipts = ctx.db
      .prepare(
        "SELECT status,normalized_sequence FROM market_provider_receipts ORDER BY sequence",
      )
      .all();
    expect(receipts).toEqual([
      { status: "INSERTED", normalized_sequence: 1 },
      { status: "DUPLICATE", normalized_sequence: 2 },
      { status: "REVISION", normalized_sequence: 3 },
      { status: "CONFLICT", normalized_sequence: 4 },
      { status: "INSERTED", normalized_sequence: 5 },
    ]);
    expect(ctx.worker.status()).toMatchObject({
      acceptedCount: 3,
      duplicateCount: 1,
      revisionCount: 2,
      gapCount: 1,
      liveEligible: false,
    });
    expect(() =>
      ctx.db.prepare("UPDATE market_raw_inputs SET status='INSERTED'").run(),
    ).toThrow("IMMUTABLE_NORMALIZED_RECEIPT");
  });
  it("rolls back normalized evidence and receipt counters if plan invalidation cannot be persisted", async () => {
    let current = sample({ finality: "CONFIRMED" });
    let rev = "r1";
    const ctx = setup({
      adapterFactory: () => fakeAdapter(async () => [current]),
      verifySample: (s) => evidence(s, rev),
      onInvalidation: () => {
        throw new Error("db write failed");
      },
    });
    await ctx.worker.pollOnce();
    ctx.advance();
    rev = "r2";
    current = { ...current, close: "101" };
    await ctx.worker.pollOnce();
    expect(ctx.worker.status()).toMatchObject({
      state: "BACKOFF",
      sampleCount: 1,
      acceptedCount: 1,
      revisionCount: 0,
      lastErrorCode: "PROVIDER_REQUEST_FAILED",
    });
    expect(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM market_raw_inputs").get(),
    ).toEqual({ n: 1 });
    expect(
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM market_provider_receipts")
        .get(),
    ).toEqual({ n: 1 });
  });
  it("enforces one shared daily request lane across US/CN, excludes demos, and never requests quote or minute streams", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const db = new Database(":memory:");
    const cn = {
      ...instrument,
      id: "CN:600000.SH",
      symbol: "600000.SH",
      market: "CN" as const,
      currency: "CNY" as const,
    };
    const fetch = vi.fn(async () => []);
    const adapter = fakeAdapter(fetch);
    const worker = new MarketWorker({
      db,
      enabled: true,
      researchInstruments: () => [
        instrument,
        cn,
        { ...instrument, id: "DEMO-X" },
      ],
      adapterFactory: () => adapter,
    });
    const poll = worker.pollOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await poll;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls).toEqual([
      ["600000.SH", "1D", 300],
      ["TEST.US", "1D", 300],
    ]);
    expect(adapter.fetchQuotes).not.toHaveBeenCalled();
    expect(worker.status().researchCount).toBe(2);
    await worker.stop();
    db.close();
  });
  it("runs from its own timer without a browser and cancels future polls on shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const db = new Database(":memory:");
    const fetch = vi.fn(async () => [sample({ receivedAt: Date.now() })]);
    const worker = new MarketWorker({
      db,
      researchInstruments: () => [instrument],
      enabled: true,
      adapterFactory: () => fakeAdapter(fetch),
      pollIntervalMs: 60000,
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(worker.status()).toMatchObject({ state: "STOPPED", sampleCount: 2 });
    db.close();
  });
  it("retains an unexpired failure backoff after a crash/restart", async () => {
    const ctx = setup({
      adapterFactory: () =>
        fakeAdapter(async () => {
          throw new Error("provider unavailable");
        }),
    });
    await ctx.worker.pollOnce();
    // A crash leaves the persisted BACKOFF state; the service lock prevents the two owners running together.
    const fetch = vi.fn(async () => []);
    const restarted = new MarketWorker({
      db: ctx.db,
      researchInstruments: () => [instrument],
      enabled: true,
      adapterFactory: () => fakeAdapter(fetch),
      now: ctx.now,
    });
    await restarted.pollOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(restarted.status()).toMatchObject({
      state: "BACKOFF",
      nextPollAt: at + 5000,
    });
    ctx.advance(5000);
    await restarted.pollOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    await restarted.stop();
  });
  it("refuses an oversized research pool before any provider request", async () => {
    const ctx = setup({
      researchInstruments: () =>
        Array.from({ length: 101 }, (_, i) => ({
          ...instrument,
          id: `US:${i}.US`,
          symbol: `${i}.US`,
        })),
    });
    await ctx.worker.pollOnce();
    expect(ctx.fetchBars).not.toHaveBeenCalled();
    expect(ctx.worker.status().reason).toBe("RESEARCH_POOL_LIMIT");
  });
});

describe("worker external-operation deadlines", () => {
  it("leaves POLLING on timeout, holds the single request lane, and discards late samples before retrying", async () => {
    vi.useFakeTimers();
    let complete!: (samples: ProviderBarSample[]) => void;
    const fetch = vi
      .fn<MarketDataAdapter["fetchBars"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue([sample()]);
    const ctx = setup({
      adapterFactory: () => fakeAdapter(fetch),
      requestTimeoutMs: 20,
    });
    const poll = ctx.worker.pollOnce();
    await vi.advanceTimersByTimeAsync(20);
    await poll;
    expect(ctx.worker.status()).toMatchObject({
      state: "BACKOFF",
      lastErrorCode: "PROVIDER_REQUEST_TIMEOUT",
      requestCount: 1,
      sampleCount: 0,
    });
    ctx.advance(5000);
    await ctx.worker.pollOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.worker.status()).toMatchObject({
      lastErrorCode: "PROVIDER_REQUEST_UNSETTLED",
      requestCount: 1,
    });
    complete([sample()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.worker.status().sampleCount).toBe(0);
    ctx.advance(10_000);
    await ctx.worker.pollOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ctx.worker.status()).toMatchObject({
      state: "IDLE",
      requestCount: 2,
      sampleCount: 1,
    });
    await ctx.worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds hanging factory initialization and consumes late rejection after database close", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const factory = vi.fn(
      () =>
        new Promise<MarketDataAdapter>((_, fail) => {
          reject = fail;
        }),
    );
    const ctx = setup({ adapterFactory: factory, requestTimeoutMs: 20 });
    const poll = ctx.worker.pollOnce();
    await vi.advanceTimersByTimeAsync(20);
    await poll;
    ctx.advance(5000);
    await ctx.worker.pollOnce();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(ctx.worker.status()).toMatchObject({
      state: "BACKOFF",
      requestCount: 0,
      lastErrorCode: "PROVIDER_REQUEST_UNSETTLED",
    });
    await ctx.worker.stop();
    ctx.db.close();
    cleanup.pop();
    reject(new Error("private native error"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts a pending request wait on shutdown without waiting for its long deadline", async () => {
    vi.useFakeTimers();
    const ctx = setup({
      adapterFactory: () => fakeAdapter(() => new Promise(() => {})),
      requestTimeoutMs: 60_000,
    });
    const poll = ctx.worker.pollOnce();
    await vi.advanceTimersByTimeAsync(0);
    await ctx.worker.stop();
    await poll;
    expect(ctx.worker.status()).toMatchObject({
      state: "STOPPED",
      sampleCount: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
