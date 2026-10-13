/** These prove implementation contracts using an isolated fake provider, NOT real market continuity. */
import { afterEach, describe, expect, it } from "vitest";
import { setupClosed, ContractAdapter, OPEN } from "./closed-bar-fixture.js";
import type { IntrabarContract, TickPacket } from "../intrabar-contract.js";
import { auditDecisionInput } from "../audit-replay.js";
import { ClosedBarRuntime } from "../closed-bar-runtime.js";
import { testIntrabarContract as contract } from "./intrabar-fixture.js";
const opened: Awaited<ReturnType<typeof setupClosed>>[] = [];
async function setup(options: Parameters<typeof setupClosed>[0] = {}) {
  const base = new ContractAdapter().context;
  const x = await setupClosed({
    ...options,
    planInput: { mode: "INTRABAR_CROSS", ...options.planInput },
    context: {
      tickContract: contract,
      capability: {
        ...base.capability,
        sequenceContractVerified: true,
        continuousTradesVerified: true,
      },
      ...options.context,
    },
  });
  opened.push(x);
  let previous: string | null = null,
    through = OPEN,
    next = 100;
  const packet = (
    at: number,
    prices: string[],
    patch: Partial<TickPacket> = {},
  ) => {
    const p: TickPacket = {
      instrumentId: x.plan.instrumentId,
      sessionId: x.adapter.session.id,
      source: x.adapter.context.source,
      providerEpoch: "provider-epoch-a",
      providerSequence: String((next += 17)),
      previousProviderSequence: previous,
      coverageFrom: through,
      coverageThrough: at,
      trades: prices.map((price, position) => ({
        price,
        position,
        at,
        type: "REGULAR_TRADE",
      })),
      ...patch,
    };
    x.setNow(at);
    x.adapter.sink.tickPacket!(p);
    previous = p.providerSequence;
    through = p.coverageThrough;
    return p;
  };
  const arm = () => {
    packet(OPEN + 1000, ["100"]);
    x.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
  };
  return { ...x, packet, arm };
}
afterEach(async () => {
  for (const x of opened.splice(0)) await x.close();
});
const entries = (x: Awaited<ReturnType<typeof setup>>) =>
  x.store.events().filter((e) => e.type === "ENTRY_TRIGGERED");

describe("durable capability-gated intrabar runtime", () => {
  it("rejects missing protocol evidence even when capability booleans claim LIVE_TICK", async () => {
    const x = await setup({
      activate: false,
      context: { tickContract: undefined },
    });
    expect(x.runner.availability().instruments[0]).toMatchObject({
      liveEligible: true,
      tickEligible: false,
      tickReason: "TICK_PROTOCOL_EVIDENCE_UNVERIFIED",
    });
    expect(() =>
      x.runner.activate(x.plan.id, {
        expectedVersion: x.plan.version,
        expectedAttemptId: null,
      }),
    ).toThrow();
    expect(x.store.plan(x.plan.id).attemptId).toBeNull();
  });
  it("rejects unsupported provider scope and expired protocol proof", async () => {
    for (const invalid of [
      { ...contract, sequenceScope: "CONNECTION_GLOBAL" },
      { ...contract, validUntil: OPEN - 2 },
    ]) {
      const x = await setup({
        activate: false,
        context: { tickContract: invalid as IntrabarContract },
      });
      expect(x.runner.availability().instruments[0].tickEligible).toBe(false);
      expect(() =>
        x.runner.activate(x.plan.id, {
          expectedVersion: x.plan.version,
          expectedAttemptId: null,
        }),
      ).toThrow();
    }
  });
  it("persists same-second packet order and accepts non-+1 sequence only with explicit provider predecessors", async () => {
    const x = await setup();
    x.arm();
    x.packet(OPEN + 61000, ["100.6", "100.62"]);
    expect(entries(x)).toHaveLength(1);
    expect(entries(x)[0].message).toContain("盘中穿越");
    expect(entries(x)[0].message).toContain("收盘前可能回落");
    expect(entries(x)[0].message).not.toContain("收盘确认");
    expect(
      x.store.events().find((e) => e.type === "RETEST_OBSERVED")?.message,
    ).toBe("盘中观察：RETEST_OBSERVED");
    expect(
      x.store.db
        .prepare("SELECT event_id FROM notifications WHERE event_id=?")
        .get(entries(x)[0].id),
    ).toEqual({ event_id: entries(x)[0].id });
    expect(x.runner.status(x.plan.id)).toMatchObject({
      mode: "INTRABAR_CROSS",
      status: "TRIGGERED",
    });
    const trades = x.store.db
      .prepare(
        "SELECT position,provider_token FROM tick_trades ORDER BY receipt_seq,position",
      )
      .all();
    expect(trades).toHaveLength(3);
    expect(trades.at(-1)).toMatchObject({
      position: 1,
      provider_token: '["provider-epoch-a","134",1]',
    });
    for (const event of x.store.events()) {
      const snapshot = x.store.decisionInput(event.id);
      expect(snapshot).toMatchObject({
        runtimeVersion: "intrabar-v1",
        synthetic: false,
      });
      const audit = auditDecisionInput({
        snapshot,
        expectedInputHash: event.snapshot.inputHash as string,
      });
      expect(audit.status, JSON.stringify(audit)).toBe("MATCH");
    }
  });
  it("records false-breakout fade without withdrawing the original entry (T09/T11)", async () => {
    const x = await setup();
    x.arm();
    x.packet(OPEN + 61000, ["100.6", "100.62"]);
    x.packet(OPEN + 62000, ["100.5"]);
    x.minute(1, { open: "100.5", high: "100.8", low: "100.4", close: "100.5" });
    expect(entries(x)).toHaveLength(1);
    expect(
      x.store.events().filter((e) => e.type === "BREAKOUT_FADED"),
    ).toHaveLength(1);
    const technical = x.store
      .events()
      .find((e) => e.type === "TECHNICAL_TRIGGERED")!;
    expect(
      (x.store.decisionInput(technical.id).state as { reference: unknown })
        .reference,
    ).toMatchObject({ threshold: "100.61" });
  });
  it("requires touch before crossing and two ticks after ref_ready within the same candidate (T10/U01)", async () => {
    const x = await setup();
    x.packet(OPEN + 1000, ["100.6"]);
    x.minute(
      0,
      { open: "100.5", high: "100.6", low: "100.5", close: "100.5" },
      1000,
    );
    x.packet(OPEN + 61000, ["100.62", "100"]);
    expect(entries(x)).toHaveLength(0);
    x.packet(OPEN + 62000, ["100.6", "100.62"]);
    expect(entries(x)).toHaveLength(1);
  });
  it("does not infer touch or crossing from only OHLC and quotes", async () => {
    const x = await setup();
    x.minute(0, { open: "100.5", high: "100.6", low: "100", close: "100.5" });
    x.minute(1, { open: "100.5", high: "102", low: "100", close: "101" });
    expect(entries(x)).toHaveLength(0);
    expect(x.runner.status(x.plan.id)?.status).toBe("WAIT_RETEST");
  });
  it("deduplicates full repeated packets without changing causal state or producing extra entries", async () => {
    const x = await setup();
    x.arm();
    const p = x.packet(OPEN + 61000, ["100.6", "100.62"]);
    const state = x.runner.status(x.plan.id);
    x.adapter.sink.tickPacket!(p);
    expect(x.runner.status(x.plan.id)).toEqual(state);
    expect(entries(x)).toHaveLength(1);
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM tick_trades").get(),
    ).toEqual({ n: 3 });
  });
  it.each([
    ["missing predecessor", { previousProviderSequence: null }],
    ["gap", { previousProviderSequence: "unknown-provider-packet" }],
    ["epoch reset", { providerEpoch: "provider-epoch-b" }],
    ["coverage gap", { coverageFrom: OPEN + 2000 }],
    ["missing sequence", { providerSequence: "" }],
    [
      "out-of-order position",
      {
        trades: [
          {
            position: 2,
            at: OPEN + 61000,
            price: "100.62",
            type: "REGULAR_TRADE",
          },
        ],
      },
    ],
    [
      "correction",
      {
        trades: [
          {
            position: 0,
            at: OPEN + 61000,
            price: "100.62",
            type: "CORRECTION",
          },
        ],
      },
    ],
  ])("fails closed for %s", async (_, patch) => {
    const x = await setup();
    x.arm();
    x.packet(OPEN + 61000, ["100.6", "100.62"], patch as Partial<TickPacket>);
    expect(entries(x)).toHaveLength(0);
    expect(x.runner.status(x.plan.id)?.status).toBe("DATA_PAUSED");
  });
  it("rejects a repeated sequence with a conflicting payload", async () => {
    const x = await setup();
    const p = x.packet(OPEN + 1000, ["100"]);
    x.adapter.sink.tickPacket!({
      ...p,
      trades: [{ ...p.trades[0], price: "100.1" }],
    });
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      reason: "TICK_PACKET_CONFLICT",
    });
  });
  it("rejects a late trade and an event-time regression without sorting inputs", async () => {
    const x = await setup();
    x.arm();
    x.packet(OPEN + 61000, ["100.6"]);
    x.packet(OPEN + 62000, [], {
      trades: [
        {
          position: 0,
          price: "100.62",
          at: OPEN + 60500,
          type: "REGULAR_TRADE",
        },
      ],
    });
    expect(x.runner.status(x.plan.id)?.status).toBe("DATA_PAUSED");
    const y = await setup();
    y.arm();
    y.packet(OPEN + 65000, [], {
      trades: [
        {
          position: 0,
          price: "100.62",
          at: OPEN + 61000,
          type: "REGULAR_TRADE",
        },
      ],
    });
    expect(y.runner.status(y.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      reason: "TICK_TOO_OLD",
    });
  });
  it("checks queued later gaps and stop facts before an earlier opportunity can commit", async () => {
    const x = await setup({ autoDrain: false });
    x.arm();
    x.runner.drain();
    x.packet(OPEN + 61000, ["100.6", "100.62"]);
    x.packet(OPEN + 62000, ["101"], { previousProviderSequence: "lost" });
    x.runner.drain();
    expect(entries(x)).toHaveLength(0);
    expect(x.runner.status(x.plan.id)?.status).toBe("DATA_PAUSED");
    const y = await setup({ autoDrain: false });
    y.arm();
    y.runner.drain();
    y.packet(OPEN + 61000, ["100.6", "100.62", "99.3", "101"]);
    y.runner.drain();
    expect(entries(y)).toHaveLength(0);
    expect(y.runner.status(y.plan.id)?.status).toBe("INVALID");
  });
  it("never backfills a timely received crossing after the decision queue becomes stale", async () => {
    const x = await setup({ autoDrain: false });
    x.arm();
    x.runner.drain();
    x.packet(OPEN + 61000, ["100.6", "100.62"]);
    x.setNow(OPEN + 65000);
    x.runner.drain();
    expect(entries(x)).toHaveLength(0);
    expect(
      x.store.events().some((e) => e.type === "HISTORICAL_TRIGGERED"),
    ).toBe(true);
  });
  it("expires intrabar at the exact deadline without the closed-bar grace period", async () => {
    const x = await setup();
    x.arm();
    const deadline = x.runner.status(x.plan.id)!.deadline;
    x.setNow(deadline);
    x.runner.flush();
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "EXPIRED",
      deadlineWatermark: deadline,
    });
  });
  it("keeps immutable packet and position evidence append-only", async () => {
    const x = await setup();
    x.packet(OPEN + 1000, ["100"]);
    for (const table of ["tick_packets", "tick_trades"]) {
      expect(() =>
        x.store.db.exec(
          `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`,
        ),
      ).toThrow("IMMUTABLE");
      expect(() => x.store.db.exec(`DELETE FROM ${table}`)).toThrow(
        "IMMUTABLE",
      );
    }
  });
  it("pauses persisted attempts after restart, fences old callbacks and never drains old queued ticks", async () => {
    const x = await setup({ autoDrain: false });
    x.arm();
    x.runner.drain();
    const p = x.packet(OPEN + 61000, ["100.6", "100.62"]);
    await x.runner.stop();
    const runner = new ClosedBarRuntime(x.store, {
      adapter: x.adapter,
      now: x.now,
    });
    try {
      await runner.start();
      expect(runner.status(x.plan.id)?.phase).toBe("RECOVERY_PAUSED");
      const count = x.store.db
        .prepare("SELECT COUNT(*) n FROM closed_receipts")
        .get();
      x.adapter.sinks[0].tickPacket!(p);
      expect(
        x.store.db.prepare("SELECT COUNT(*) n FROM closed_receipts").get(),
      ).toEqual(count);
      runner.flush();
      expect(entries(x)).toHaveLength(0);
    } finally {
      await runner.stop();
    }
  });
  it("does not use pre-reference ticks as the first half of a later crossing", async () => {
    const x = await setup();
    x.packet(OPEN + 1000, ["100"]);
    x.packet(OPEN + 60500, ["100.6"]);
    x.minute(
      0,
      { open: "100.5", high: "100.6", low: "100", close: "100.5" },
      1000,
    );
    x.packet(OPEN + 61000, ["100.62"]);
    expect(entries(x)).toHaveLength(0);
    x.packet(OPEN + 62000, ["100.6", "100.62"]);
    expect(entries(x)).toHaveLength(1);
  });
  it("rolls provider cursors, reducer inputs and events back together if notification insertion fails", async () => {
    const x = await setup();
    x.arm();
    const before = x.store.db
      .prepare("SELECT COUNT(*) n FROM tick_packets")
      .get();
    x.store.db.exec(
      "CREATE TRIGGER fail_tick_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'TEST_TICK_COMMIT_FAILURE'); END",
    );
    expect(() => x.packet(OPEN + 61000, ["100.6", "100.62"])).toThrow(
      "TEST_TICK_COMMIT_FAILURE",
    );
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM tick_packets").get(),
    ).toEqual(before);
    expect(entries(x)).toHaveLength(0);
    x.store.db.exec("DROP TRIGGER fail_tick_notification");
    x.runner.drain();
    expect(entries(x)).toHaveLength(1);
    x.runner.drain();
    expect(entries(x)).toHaveLength(1);
  });
  it("requires a new explicit recovery identity and fresh above-then-touch evidence after reconnect", async () => {
    const x = await setup();
    x.arm();
    const old = x.runner.status(x.plan.id)!;
    await new Promise((resolve) => setImmediate(resolve));
    x.runner.disconnect("PROVIDER_DISCONNECTED");
    x.setNow(OPEN + 61000);
    await x.runner.start();
    const plan = x.store.plan(x.plan.id);
    const paused = x.runner.status(x.plan.id)!;
    const recovered = x.runner.activate(
      plan.id,
      { expectedVersion: plan.version, expectedAttemptId: plan.attemptId },
      { sourceAttemptId: old.attemptId, expectedWatermark: paused.watermark },
    );
    expect(recovered.plan.attemptId).not.toBe(old.attemptId);
    expect(recovered.monitor).toMatchObject({
      template: "RECOVERY",
      status: "WAIT_RETEST",
    });
    x.packet(OPEN + 61000, ["100"], {
      providerEpoch: "provider-epoch-b",
      previousProviderSequence: null,
      coverageFrom: OPEN + 61000,
    });
    expect(x.runner.status(plan.id)?.status).toBe("WAIT_RETEST");
    x.packet(OPEN + 62000, ["100.5", "100"], {
      providerEpoch: "provider-epoch-b",
    });
    expect(x.runner.status(plan.id)?.status).toBe("ARMED");
    expect(entries(x)).toHaveLength(0);
  });
  it.each([
    ["100.7", "101", false],
    ["101", "100.8", true],
  ])(
    "uses provider chain tail %s -> %s despite a same-time old packet replay",
    async (oldPrice, tail, entry) => {
      const x = await setup({
        autoDrain: false,
        planInput: { entryMax: "100.9" },
      });
      x.arm();
      x.runner.drain();
      const old = x.packet(OPEN + 61000, [oldPrice]);
      x.packet(OPEN + 61000, ["100.6"]);
      x.packet(OPEN + 61000, ["100.62", tail]);
      x.adapter.sink.tickPacket!(old);
      x.runner.drain();
      expect(entries(x)).toHaveLength(entry ? 1 : 0);
      const event = x.store
        .events()
        .find((e) => e.type === (entry ? "ENTRY_TRIGGERED" : "ENTRY_BLOCKED"))!;
      expect(event).toBeDefined();
      const snapshot = x.store.decisionInput(event.id);
      expect(snapshot.riskInput).toMatchObject({ quote: { price: tail } });
      expect(
        auditDecisionInput({
          snapshot,
          expectedInputHash: event.snapshot.inputHash as string,
        }).status,
      ).toBe("MATCH");
    },
  );
});
