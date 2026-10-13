/** Isolated server-adapter acceptance tests, not evidence of a connected live provider. */
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AttemptConfig,
  AttemptInput,
  AttemptState,
} from "../../../packages/domain/trigger.js";
import { ClosedBarRuntime } from "../closed-bar-runtime.js";
import { Store } from "../store.js";
import {
  ContractAdapter,
  INSTRUMENT,
  OPEN,
  setupClosed,
  testFunds,
} from "./closed-bar-fixture.js";

const MINUTE = 60_000;
const touch = { open: "100.5", high: "100.6", low: "100", close: "100.5" };
const quiet = { open: "100.5", high: "100.6", low: "100.4", close: "100.5" };
const breakout = { open: "100.5", high: "101.2", low: "100.4", close: "101" };
type Fixture = Awaited<ReturnType<typeof setupClosed>>;
const fixtures: Fixture[] = [];
const resources: Array<{ store: Store; runner?: ClosedBarRuntime }> = [];
const directories: string[] = [];
async function setup(options: Parameters<typeof setupClosed>[0] = {}) {
  const fixture = await setupClosed(options);
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  const failures: unknown[] = [];
  for (const x of [...fixtures.splice(0), ...resources.splice(0)]) {
    try {
      if (x.runner && x.store.db.open) await x.runner.stop();
    } catch (error) {
      failures.push(error);
    } finally {
      if (x.store.db.open) x.store.close();
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  if (failures.length)
    throw new AggregateError(failures, "Formal runtime cleanup failed");
});
function state(x: Fixture, attemptId = x.plan.attemptId!): AttemptState {
  const row = x.store.db
    .prepare("SELECT state_json FROM closed_attempts WHERE attempt_id=?")
    .get(attemptId) as { state_json: string };
  return JSON.parse(row.state_json);
}
function config(x: Fixture, attemptId = x.plan.attemptId!): AttemptConfig {
  const row = x.store.db
    .prepare("SELECT config_json FROM closed_attempts WHERE attempt_id=?")
    .get(attemptId) as { config_json: string };
  return JSON.parse(row.config_json);
}
function inputs(x: Fixture, attemptId = x.plan.attemptId!): AttemptInput[] {
  return (
    x.store.db
      .prepare(
        "SELECT input_json FROM closed_inputs WHERE attempt_id=? ORDER BY ingest_seq",
      )
      .all(attemptId) as Array<{ input_json: string }>
  ).map((r) => JSON.parse(r.input_json));
}
function events(x: Fixture, type: string, attemptId = x.plan.attemptId!) {
  return x.store.eventsForAttempt(attemptId).filter((e) => e.type === type);
}
function reservation(x: Fixture) {
  return x.store.reservations().find((r) => r.planId === x.plan.id)!;
}
function pending(store: Store) {
  return (
    store.db
      .prepare(
        "SELECT COUNT(*) n FROM closed_receipts WHERE seq NOT IN (SELECT seq FROM closed_receipt_results)",
      )
      .get() as { n: number }
  ).n;
}
function noTrade(x: Fixture, index: number, delay = 0) {
  x.setNow(OPEN + (index + 1) * MINUTE + delay);
  x.adapter.sink.noTrade({
    instrumentId: INSTRUMENT,
    sessionId: x.adapter.session.id,
    source: x.adapter.context.source,
    start: OPEN + index * MINUTE,
    end: OPEN + (index + 1) * MINUTE,
    evidenceId: `no-trade:${index}`,
  });
}
function temporaryPath() {
  const directory = mkdtempSync(join(tmpdir(), "closed-bar-boundary-"));
  directories.push(directory);
  return join(directory, "contract.sqlite");
}

describe("formal closed-bar timing and frozen evidence", () => {
  it("includes both 30-second receipt boundaries for the frozen reference and final close", async () => {
    const x = await setup();
    x.minute(0, touch, 30_000);
    const reference = structuredClone(state(x).reference);
    expect(reference).toMatchObject({
      readyAt: OPEN + MINUTE + 30_000,
      high: "100.6",
      threshold: "100.61",
    });
    x.minute(1, breakout, 30_000);
    const entry = events(x, "ENTRY_TRIGGERED");
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({
      time: OPEN + 2 * MINUTE,
      receivedAt: OPEN + 2 * MINUTE + 30_000,
      historical: false,
    });
    expect(state(x).reference).toEqual(reference);
  });

  it("never upgrades a close received 30,001 ms late to an actionable entry", async () => {
    const x = await setup();
    x.minute(0, touch);
    x.setNow(OPEN + 2 * MINUTE + 30_001);
    x.adapter.sink.minute(x.adapter.bar(1, breakout));
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(events(x, "HISTORICAL_TRIGGERED")).toHaveLength(1);
    expect(events(x, "TECHNICAL_TRIGGERED")[0].historical).toBe(true);
    expect(reservation(x).state).toBe("RELEASED");
    x.minute(2, { ...breakout, high: "101.4", close: "101.3" });
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
  });

  it("archives a late close without replaying it after an earlier quote has already exposed missing coverage", async () => {
    const x = await setup();
    x.minute(0, touch);
    x.minute(1, breakout, 30_001);
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      reason: "MISSING_MINUTE",
    });
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    expect(events(x, "HISTORICAL_TRIGGERED")).toHaveLength(0);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(
      x.store.db
        .prepare(
          "SELECT status FROM closed_receipt_results ORDER BY seq DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ status: "PAUSED_HISTORY_ONLY" });
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM market_raw_inputs").get(),
    ).toEqual({ n: 2 });
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM closed_minutes").get(),
    ).toEqual({ n: 1 });
    expect(reservation(x).state).toBe("ACTIVE");
  });

  it("does not freeze a reference first received beyond the inclusive grace period", async () => {
    const x = await setup();
    x.setNow(OPEN + MINUTE + 30_001);
    x.adapter.sink.minute(x.adapter.bar(0, quiet));
    expect(Object.keys(state(x).references)).toHaveLength(0);
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      reason: "MINUTE_TOO_LATE",
    });
    x.minute(1, touch);
    x.minute(2, breakout);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
  });

  it("switches at minute 15 and freezes the adjacent complete five-minute reference", async () => {
    const x = await setup();
    for (let i = 0; i < 14; i++) x.minute(i);
    x.minute(14, touch, 30_000);
    const reference = structuredClone(state(x).reference);
    expect(reference).toMatchObject({
      candidate: {
        start: OPEN + 15 * MINUTE,
        end: OPEN + 20 * MINUTE,
        period: "5m",
      },
      high: "101.2",
      threshold: "101.21",
      readyAt: OPEN + 15 * MINUTE + 30_000,
    });
    expect(reference?.barId).toBe(
      `agg5:${x.adapter.session.id}:${OPEN + 10 * MINUTE}`,
    );
    for (let i = 15; i < 19; i++) {
      x.minute(i, { open: "101", high: "101.4", low: "100.8", close: "101.3" });
      expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
      expect(state(x).reference).toEqual(reference);
    }
    x.minute(19, { open: "101", high: "101.4", low: "100.8", close: "101.3" });
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(1);
    expect(state(x).trigger).toMatchObject({
      threshold: "101.21",
      candidate: {
        period: "5m",
        start: OPEN + 15 * MINUTE,
        end: OPEN + 20 * MINUTE,
      },
    });
  });

  it("waits through minute 60 plus exactly 30 seconds for the last eligible five-minute close", async () => {
    const x = await setup();
    for (let i = 0; i < 49; i++) x.minute(i);
    x.minute(49, touch);
    for (let i = 50; i < 59; i++) x.minute(i, quiet);
    expect(state(x).deadline).toBe(OPEN + 60 * MINUTE);
    x.setNow(OPEN + 60 * MINUTE);
    x.runner.flush();
    expect(state(x).status).toBe("ARMED");
    x.setNow(OPEN + 60 * MINUTE + 30_000);
    x.runner.flush();
    expect(state(x).status).toBe("ARMED");
    x.minute(59, breakout, 30_000);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(1);
    expect(state(x).trigger?.candidate).toEqual({
      period: "5m",
      start: OPEN + 55 * MINUTE,
      end: OPEN + 60 * MINUTE,
    });
    x.setNow(OPEN + 61 * MINUTE);
    x.runner.flush();
    expect(x.store.plan(x.plan.id).status).toBe("TRIGGERED");
    expect(reservation(x).state).toBe("ACTIVE");
  });

  it("limits a retest to 15 minutes and excludes a five-minute candidate straddling that deadline", async () => {
    const x = await setup();
    x.minute(0, touch);
    expect(state(x).deadline).toBe(OPEN + 16 * MINUTE);
    for (let i = 1; i < 16; i++) x.minute(i, quiet);
    x.setNow(OPEN + 16 * MINUTE + 30_000);
    x.runner.flush();
    expect(state(x).status).toBe("ARMED");
    x.setNow(OPEN + 16 * MINUTE + 30_001);
    x.runner.flush();
    expect(state(x)).toMatchObject({
      status: "EXPIRED",
      deadline: OPEN + 16 * MINUTE,
    });
    for (let i = 16; i < 19; i++) x.minute(i, quiet);
    x.minute(19, breakout);
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(events(x, "EXPIRED")).toHaveLength(1);
    expect(reservation(x).state).toBe("RELEASED");
  });

  it("expires only after the final receipt window and cannot trigger from a post-hour candidate", async () => {
    const x = await setup();
    for (let i = 0; i < 60; i++) x.minute(i);
    x.setNow(OPEN + 60 * MINUTE + 30_000);
    x.runner.flush();
    expect(state(x).status).toBe("WAIT_RETEST");
    x.setNow(OPEN + 60 * MINUTE + 30_001);
    x.runner.flush();
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "EXPIRED",
      phase: "COMPLETE",
      deadlineWatermark: OPEN + 60 * MINUTE + 30_001,
    });
    expect(reservation(x).state).toBe("RELEASED");
    x.minute(60, touch);
    x.minute(61, breakout);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(events(x, "EXPIRED")).toHaveLength(1);
  });
});

describe("formal closed-bar stream coverage", () => {
  it("quarantines a late minute after the five-minute switch before it can become aggregate evidence", async () => {
    const x = await setup();
    for (let i = 0; i < 14; i++) x.minute(i);
    x.minute(14, touch);
    x.setNow(OPEN + 16 * MINUTE + 30_001);
    x.adapter.sink.minute(
      x.adapter.bar(15, { ...breakout, high: "101.4", close: "101.3" }),
    );
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      reason: "MINUTE_TOO_LATE",
    });
    expect(
      x.store.db
        .prepare("SELECT COUNT(*) n FROM closed_minutes WHERE start=?")
        .get(OPEN + 15 * MINUTE),
    ).toEqual({ n: 0 });
    for (let i = 16; i < 20; i++)
      x.minute(i, { ...breakout, high: "101.4", close: "101.3" });
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(state(x).consumed).toBe(false);
  });

  it("keeps repeated gap facts idempotent so the next input and shutdown remain durable", async () => {
    const x = await setup();
    noTrade(x, 0, 30_001);
    const accepted = inputs(x);
    expect(new Set(accepted.map((i) => i.id)).size).toBe(accepted.length);
    expect(state(x).lastIngestSeq).toBe(accepted.at(-1)?.ingestSeq);
    x.store.pause(x.plan.id, x.plan.version, x.now());
    x.runner.flush();
    expect(state(x)).toMatchObject({ status: "USER_PAUSED", consumed: false });
    expect(x.runner.status(x.plan.id)?.phase).toBe("COMPLETE");
    expect(reservation(x).state).toBe("RELEASED");
  });

  it("deduplicates identical late frames without changing frozen reference or consuming the attempt twice", async () => {
    const x = await setup();
    x.minute(0, touch);
    const before = state(x);
    x.setNow(x.now() + 500);
    x.adapter.sink.minute(x.adapter.bar(0, touch));
    expect(state(x)).toEqual(before);
    expect(
      x.store.db
        .prepare(
          "SELECT status FROM closed_receipt_results ORDER BY seq DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ status: "DUPLICATE" });
    x.minute(1, breakout);
    const entry = events(x, "ENTRY_TRIGGERED")[0];
    x.setNow(x.now() + 500);
    x.adapter.sink.minute(x.adapter.bar(1, breakout));
    expect(events(x, "ENTRY_TRIGGERED").map((e) => e.id)).toEqual([entry.id]);
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(1);
  });

  it.each([
    [
      "provider revision",
      { providerRevision: "2", high: "100.7" },
      "MINUTE_REVISION_CHANGED",
    ],
    [
      "same-revision payload conflict",
      { high: "100.7" },
      "MINUTE_PAYLOAD_CONFLICT",
    ],
  ] as const)(
    "pauses on %s without rewriting the frozen reference",
    async (_label, revision, reason) => {
      const x = await setup();
      x.minute(0, touch);
      const reference = structuredClone(state(x).reference);
      const raw = x.store.db.prepare("SELECT json FROM closed_minutes").all();
      x.setNow(x.now() + 1);
      x.adapter.sink.minute(x.adapter.bar(0, { ...touch, ...revision }));
      expect(x.runner.status(x.plan.id)).toMatchObject({
        status: "DATA_PAUSED",
        reason,
      });
      expect(state(x).reference).toEqual(reference);
      expect(
        x.store.db.prepare("SELECT json FROM closed_minutes").all(),
      ).toEqual(raw);
      expect(reservation(x).state).toBe("ACTIVE");
      x.minute(1, breakout);
      expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    },
  );

  it("rejects a skipped/out-of-order minute and never uses the later backfill as a live retest", async () => {
    const x = await setup();
    x.setNow(OPEN + 2 * MINUTE);
    x.adapter.sink.minute(x.adapter.bar(1, touch));
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      reason: "MINUTE_OUT_OF_ORDER_OR_GAP",
    });
    x.setNow(x.now() + 1);
    x.adapter.sink.minute(x.adapter.bar(0));
    x.minute(2, breakout);
    expect(events(x, "RETEST_OBSERVED")).toHaveLength(0);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM closed_minutes").get(),
    ).toEqual({ n: 0 });
  });

  it("detects missing minutes strictly after their receive window, preserving the reservation", async () => {
    const x = await setup();
    x.setNow(OPEN + MINUTE + 30_000);
    x.runner.flush();
    expect(state(x).status).toBe("WAIT_RETEST");
    x.setNow(OPEN + MINUTE + 30_001);
    x.runner.flush();
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      reason: "MISSING_MINUTE",
    });
    expect(reservation(x).state).toBe("ACTIVE");
    x.adapter.sink.minute(x.adapter.bar(0, touch));
    expect(events(x, "RETEST_OBSERVED")).toHaveLength(0);
  });

  it("preserves explicit no-trade coverage without manufacturing a five-minute reference", async () => {
    const x = await setup();
    for (let i = 0; i < 10; i++) x.minute(i);
    noTrade(x, 10, 30_000);
    for (let i = 11; i < 14; i++) x.minute(i);
    x.minute(14, touch);
    expect(state(x).status).toBe("ARMED");
    expect(
      state(x).references[`5m:${OPEN + 15 * MINUTE}:${OPEN + 20 * MINUTE}`],
    ).toBeUndefined();
    for (let i = 15; i < 20; i++)
      x.minute(i, { ...breakout, high: "101.4", close: "101.3" });
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    expect(
      x.store.db.prepare("SELECT healthy,through_at FROM closed_streams").get(),
    ).toEqual({ healthy: 1, through_at: OPEN + 20 * MINUTE });
    const stored = x.store.db
      .prepare("SELECT json FROM closed_minutes WHERE start=?")
      .get(OPEN + 10 * MINUTE) as { json: string };
    expect(JSON.parse(stored.json)).toMatchObject({
      kind: "NO_TRADE",
      evidenceId: "no-trade:10",
    });
    expect(JSON.parse(stored.json)).not.toHaveProperty("close");
  });

  it("rejects no-trade coverage arriving beyond its grace period", async () => {
    const x = await setup();
    noTrade(x, 0, 30_001);
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      reason: "NO_TRADE_COVERAGE_INVALID",
    });
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM closed_minutes").get(),
    ).toEqual({ n: 0 });
  });
});

describe("formal decisions recheck current facts after durable ingress", () => {
  it.each(["revision", "gap"] as const)(
    "rejects an older queued breakout when a later received %s has revoked eligibility",
    async (kind) => {
      const x = await setup({ autoDrain: false });
      x.minute(0, touch);
      x.runner.drain();
      const frozen = structuredClone(state(x).reference);
      x.minute(1, breakout);
      if (kind === "revision") {
        x.setNow(x.now() + 1);
        x.adapter.sink.minute(
          x.adapter.bar(0, { ...touch, high: "100.7", providerRevision: "2" }),
        );
      } else x.minute(3, breakout);
      x.runner.drain();
      expect(state(x)).toMatchObject({
        status: "DATA_PAUSED",
        consumed: false,
      });
      expect(state(x).reference).toEqual(frozen);
      expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
      expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
      expect(reservation(x).state).toBe("ACTIVE");
    },
  );

  it("does not emit a queued entry when the current minute coverage has timed out", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout);
    x.setNow(OPEN + 3 * MINUTE + 30_001);
    x.adapter.quote(x.now(), "101");
    x.runner.flush();
    expect(state(x)).toMatchObject({ status: "DATA_PAUSED", consumed: false });
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
  });

  it("cannot reinstate a queued close after insufficient funds have paused its reservation", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout);
    x.store.updateFunds(
      { ...testFunds, cash: { USD: "50", CNY: "0" } },
      x.store.funds()!.generation,
      x.now(),
    );
    expect(x.store.plan(x.plan.id).status).toBe("DATA_PAUSED");
    x.runner.drain();
    expect(state(x)).toMatchObject({ status: "DATA_PAUSED", consumed: false });
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(reservation(x).state).toBe("RELEASED");
  });

  it("uses persisted receipt time for eligibility but a newer, fresh quote at decision time", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout, 30_000);
    expect(pending(x.store)).toBe(2);
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    x.setNow(OPEN + 3 * MINUTE);
    x.adapter.quote(x.now(), "101.1");
    x.runner.drain();
    const entry = events(x, "ENTRY_TRIGGERED")[0];
    expect(entry).toMatchObject({
      receivedAt: OPEN + 2 * MINUTE + 30_000,
      historical: false,
    });
    expect(entry.snapshot).toMatchObject({ decisionTime: OPEN + 3 * MINUTE });
    const barInput = inputs(x).findLast((i) => i.type === "BAR");
    expect(barInput).toMatchObject({
      receivedAt: OPEN + 2 * MINUTE + 30_000,
      gates: {
        decisionAt: OPEN + 3 * MINUTE,
        quote: { at: OPEN + 3 * MINUTE, price: "101.1" },
      },
    });
    expect(pending(x.store)).toBe(0);
  });

  it("accepts a decision quote at the inclusive 3,000 ms freshness boundary", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout);
    x.setNow(x.now() + 3_000);
    x.runner.drain();
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(1);
    expect(inputs(x).findLast((i) => i.type === "BAR")).toMatchObject({
      gates: {
        decisionAt: OPEN + 2 * MINUTE + 3_000,
        quote: { at: OPEN + 2 * MINUTE },
      },
    });
  });

  it("consumes once with an unavailable entry when its receipt-time quote is stale at decision", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout);
    x.setNow(x.now() + 3_001);
    x.runner.drain();
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(1);
    expect(events(x, "ENTRY_BLOCKED")[0].reasons).toContain(
      "QUOTE_STALE_OR_MISSING",
    );
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(state(x).consumed).toBe(true);
    expect(reservation(x).state).toBe("RELEASED");
    x.adapter.quote(x.now(), "101");
    x.runner.drain();
    x.minute(2, { ...breakout, high: "101.4", close: "101.3" });
    x.runner.drain();
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(1);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
  });

  it("latches a received stop before a queued breakout even after a fresh-price rebound", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout);
    x.setNow(x.now() + 100);
    x.adapter.quote(x.now(), "99.4");
    x.setNow(x.now() + 100);
    x.adapter.quote(x.now(), "101");
    x.runner.drain();
    expect(x.runner.status(x.plan.id)).toMatchObject({
      status: "INVALID",
      reason: "STOP_REFERENCE_TOUCHED",
    });
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(reservation(x).state).toBe("RELEASED");
    const barInput = inputs(x).findLast((i) => i.type === "BAR");
    expect(barInput).toMatchObject({
      gates: {
        quote: { price: "101" },
        knownStop: { price: "99.4", at: OPEN + 2 * MINUTE + 100 },
      },
    });
  });

  it("shrinks a queued entry using the current funds generation and never increases approved quantity", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    const approved = reservation(x).quantity;
    x.minute(1, breakout);
    const funds = x.store.updateFunds(
      { ...testFunds, cash: { USD: "510", CNY: "0" } },
      x.store.funds()!.generation,
      x.now(),
    );
    expect(reservation(x).quantity).toBe(5);
    expect(approved).toBeGreaterThan(5);
    x.runner.drain();
    expect(events(x, "ENTRY_TRIGGERED")[0].quantity).toBe(5);
    expect(reservation(x)).toMatchObject({
      generation: funds.generation,
      quantity: 5,
      state: "ACTIVE",
    });
    expect(events(x, "ENTRY_TRIGGERED")[0].snapshot).toMatchObject({
      funds: { generation: funds.generation },
    });
  });

  it("blocks a queued entry against a newly stale account snapshot", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout);
    // Model a separately committed TAKEN account update, without mutating immutable prior snapshots.
    const stale = {
      ...x.store.funds()!,
      generation: x.store.funds()!.generation + 1,
      stale: true,
    };
    x.store.transaction(() => {
      x.store.db
        .prepare("INSERT INTO account_snapshots VALUES(?,?)")
        .run(stale.generation, JSON.stringify(stale));
      x.store.setSetting("funds_generation", String(stale.generation));
    });
    x.runner.drain();
    expect(events(x, "ENTRY_BLOCKED")[0].reasons).toContain(
      "FUNDS_SNAPSHOT_STALE",
    );
    expect(events(x, "ENTRY_BLOCKED")[0].snapshot).toMatchObject({
      funds: { stale: true, generation: stale.generation },
    });
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(state(x).consumed).toBe(true);
    expect(reservation(x).state).toBe("RELEASED");
  });

  it("respects a user pause committed while a close is queued", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout);
    x.store.pause(x.plan.id, x.plan.version, x.now());
    x.runner.drain();
    expect(x.store.plan(x.plan.id).status).toBe("USER_PAUSED");
    expect(state(x)).toMatchObject({ status: "USER_PAUSED", consumed: false });
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    expect(reservation(x).state).toBe("RELEASED");
  });

  it("respects an externally invalidated evidence set while a close is queued", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout);
    x.store.invalidateEvidence(
      INSTRUMENT,
      "CORPORATE_ACTION_EVIDENCE_CHANGED",
      x.now(),
    );
    x.runner.drain();
    expect(x.store.plan(x.plan.id).status).toBe("DATA_PAUSED");
    expect(state(x)).toMatchObject({ status: "DATA_PAUSED", consumed: false });
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    expect(reservation(x).state).toBe("ACTIVE");
  });

  it("rechecks a changed instrument revision at decision time even before its invalidation callback", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.minute(1, breakout);
    const instrument = x.store.instrument(INSTRUMENT);
    x.store.putInstrument({
      ...instrument,
      instrument: { ...instrument.instrument, tick: "0.02" },
    });
    expect(
      x.store.supportRevisionReasons(x.store.plan(x.plan.id), x.now()),
    ).toContain("INSTRUMENT_REVISION_CHANGED");
    x.runner.drain();
    expect(x.store.plan(x.plan.id).status).toBe("DATA_PAUSED");
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(0);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
    expect(reservation(x).state).toBe("ACTIVE");
  });
});

describe("formal restart and transaction boundaries", () => {
  it("cannot start the session-first template mid-session without complete prior no-touch evidence", async () => {
    const x = await setup({ activate: false });
    x.setNow(OPEN + 1);
    expect(() =>
      x.runner.activate(x.plan.id, {
        expectedVersion: x.plan.version,
        expectedAttemptId: null,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SESSION_HISTORY_INCOMPLETE" }),
    );
    x.minute(0, touch);
    x.minute(1);
    expect(() =>
      x.runner.activate(x.plan.id, {
        expectedVersion: x.plan.version,
        expectedAttemptId: null,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "EARLIER_RETEST_ALREADY_OBSERVED" }),
    );
    expect(x.store.plan(x.plan.id)).toMatchObject({
      status: "DRAFT",
      attemptId: null,
    });
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM closed_attempts").get(),
    ).toEqual({ n: 0 });
  });

  it("fences old callbacks and requires a new recovery epoch, fresh above-support observation, then a retest", async () => {
    const x = await setup();
    x.minute(0, touch);
    const oldSink = x.adapter.sink;
    const oldAttempt = x.plan.attemptId!;
    const oldConfig = config(x);
    x.setNow(OPEN + 2 * MINUTE);
    x.adapter.sink.disconnect("TEST_DISCONNECTED");
    const watermark = x.runner.status(x.plan.id)!.watermark;
    // Complete the prior subscription cleanup before requesting a new connection.
    await new Promise((resolve) => setImmediate(resolve));
    await x.runner.start();
    expect(() =>
      x.runner.activate(x.plan.id, {
        expectedVersion: x.plan.version,
        expectedAttemptId: oldAttempt,
      }),
    ).toThrowError(expect.objectContaining({ code: "RECOVERY_REQUIRED" }));
    expect(() =>
      x.runner.activate(
        x.plan.id,
        { expectedVersion: x.plan.version, expectedAttemptId: oldAttempt },
        { sourceAttemptId: oldAttempt, expectedWatermark: watermark - 1 },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "RECOVERY_SOURCE_CONFLICT" }),
    );
    const recovered = x.runner.activate(
      x.plan.id,
      { expectedVersion: x.plan.version, expectedAttemptId: oldAttempt },
      { sourceAttemptId: oldAttempt, expectedWatermark: watermark },
    );
    const newAttempt = recovered.plan.attemptId!;
    expect(newAttempt).not.toBe(oldAttempt);
    expect(config(x, newAttempt)).toMatchObject({
      template: "RECOVERY",
      preActivationEvidence: "UNKNOWN",
    });
    expect(config(x, newAttempt).evidenceEpoch).not.toBe(
      oldConfig.evidenceEpoch,
    );
    expect(state(x, newAttempt).aboveEvidence).toBe(false);
    const count = x.store.db
      .prepare("SELECT COUNT(*) n FROM closed_receipts")
      .get();
    oldSink.quote({
      instrumentId: INSTRUMENT,
      sessionId: x.adapter.session.id,
      source: x.adapter.context.source,
      id: "old-stop",
      price: "99",
      at: x.now(),
    });
    oldSink.minute(x.adapter.bar(1, breakout));
    oldSink.disconnect("OLD_CONNECTION_DISCONNECT");
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM closed_receipts").get(),
    ).toEqual(count);
    expect(x.runner.availability().connected).toBe(true);
    x.adapter.quote(OPEN + MINUTE, "99");
    expect(state(x, newAttempt)).toMatchObject({
      status: "WAIT_RETEST",
      aboveEvidence: false,
    });
    expect(events(x, "INVALID", newAttempt)).toHaveLength(0);
    x.minute(2, { open: "100.2", high: "100.5", low: "100", close: "100.2" });
    expect(state(x, newAttempt).status).toBe("WAIT_RETEST");
    x.minute(3, quiet);
    expect(state(x, newAttempt).aboveEvidence).toBe(true);
    x.minute(4, touch);
    expect(state(x, newAttempt).status).toBe("ARMED");
    x.minute(5, breakout);
    expect(events(x, "ENTRY_TRIGGERED", newAttempt)).toHaveLength(1);
    expect(events(x, "ENTRY_TRIGGERED", oldAttempt)).toHaveLength(0);
    expect(events(x, "ENTRY_TRIGGERED", newAttempt)[0].snapshot).toMatchObject({
      config: {
        template: "RECOVERY",
        evidenceEpoch: config(x, newAttempt).evidenceEpoch,
      },
    });
  });

  it("requires a newly reviewed plan when reconnecting installs revised provider evidence", async () => {
    const x = await setup();
    x.minute(0, touch);
    x.setNow(OPEN + 2 * MINUTE);
    x.adapter.sink.disconnect("TEST_DISCONNECTED");
    const oldAttempt = x.plan.attemptId!;
    const watermark = x.runner.status(x.plan.id)!.watermark;
    x.adapter.context = {
      ...x.adapter.context,
      adjustmentEvidenceId: "test-revised-adjustment-evidence",
    };
    // Complete the prior subscription cleanup before requesting a new connection.
    await new Promise((resolve) => setImmediate(resolve));
    await x.runner.start();
    expect(() =>
      x.runner.activate(
        x.plan.id,
        { expectedVersion: x.plan.version, expectedAttemptId: oldAttempt },
        { sourceAttemptId: oldAttempt, expectedWatermark: watermark },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CONTEXT_REVISION_CHANGED" }),
    );
    expect(x.store.plan(x.plan.id)).toMatchObject({
      status: "DATA_PAUSED",
      attemptId: oldAttempt,
    });
    expect(
      x.store.db.prepare("SELECT COUNT(*) n FROM closed_attempts").get(),
    ).toEqual({ n: 1 });
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(0);
  });

  it("rolls back notifications, consumption, checkpoint and reservations while keeping durable ingress retryable", async () => {
    const x = await setup({ autoDrain: false });
    x.minute(0, touch);
    x.runner.drain();
    x.setNow(OPEN + 2 * MINUTE);
    x.adapter.quote(x.now(), "101");
    x.runner.drain();
    const before = {
      state: state(x),
      inputs: inputs(x),
      plan: x.store.plan(x.plan.id),
      reservations: x.store.reservations(),
      events: x.store.events(),
      notifications: x.store.db
        .prepare("SELECT * FROM notifications ORDER BY rowid")
        .all(),
      minutes: x.store.db
        .prepare("SELECT * FROM closed_minutes ORDER BY start")
        .all(),
    };
    x.adapter.sink.minute(x.adapter.bar(1, breakout));
    x.store.db.exec(
      "CREATE TEMP TRIGGER fail_closed_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'closed notification unavailable'); END",
    );
    expect(() => x.runner.drain()).toThrow("closed notification unavailable");
    expect(pending(x.store)).toBe(1);
    expect({
      state: state(x),
      inputs: inputs(x),
      plan: x.store.plan(x.plan.id),
      reservations: x.store.reservations(),
      events: x.store.events(),
      notifications: x.store.db
        .prepare("SELECT * FROM notifications ORDER BY rowid")
        .all(),
      minutes: x.store.db
        .prepare("SELECT * FROM closed_minutes ORDER BY start")
        .all(),
    }).toEqual(before);
    expect(
      x.store.db
        .prepare("SELECT consumed FROM attempts WHERE id=?")
        .get(x.plan.attemptId),
    ).toEqual({ consumed: 0 });
    expect(x.store.db.pragma("integrity_check", { simple: true })).toBe("ok");
    x.store.db.exec("DROP TRIGGER fail_closed_notification");
    x.runner.drain();
    x.runner.drain();
    expect(pending(x.store)).toBe(0);
    expect(events(x, "TECHNICAL_TRIGGERED")).toHaveLength(1);
    expect(events(x, "ENTRY_TRIGGERED")).toHaveLength(1);
    const event = events(x, "ENTRY_TRIGGERED")[0];
    expect(
      x.store.db
        .prepare("SELECT COUNT(*) n FROM notifications WHERE event_id=?")
        .get(event.id),
    ).toEqual({ n: 1 });
  });

  it.each(["ingress", "before_notification", "after_commit"] as const)(
    "recovers an actual subprocess SIGKILL at %s without catch-up entries",
    async (boundary) => {
      const path = temporaryPath();
      const child = fork(
        resolve("apps/server/tests/closed-bar-crash-worker.ts"),
        [path, boundary],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      const exit = await new Promise<{
        code: number | null;
        signal: string | null;
      }>((done, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `closed-bar crash fixture exceeded 10 seconds: ${stderr}`,
            ),
          );
        }, 10_000);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          done({ code, signal });
        });
      });
      expect(exit, stderr).toEqual({ code: null, signal: "SIGKILL" });
      const store = new Store(path);
      resources.push({ store });
      expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
      const plan = store.plans()[0];
      const committed = boundary === "after_commit";
      const beforeEntries = store
        .eventsForAttempt(plan.attemptId!)
        .filter((e) => e.type === "ENTRY_TRIGGERED");
      expect(beforeEntries).toHaveLength(committed ? 1 : 0);
      expect(plan.status).toBe(committed ? "TRIGGERED" : "ARMED");
      expect(
        store.db.prepare("SELECT COUNT(*) n FROM closed_minutes").get(),
      ).toEqual({ n: committed ? 2 : 1 });
      expect(
        store.db
          .prepare("SELECT consumed FROM attempts WHERE id=?")
          .get(plan.attemptId),
      ).toEqual({ consumed: committed ? 1 : 0 });
      expect(pending(store)).toBe(committed ? 0 : 1);
      const adapter = new ContractAdapter();
      const runner = new ClosedBarRuntime(store, {
        adapter,
        now: () => OPEN + 3 * MINUTE,
      });
      resources[resources.length - 1].runner = runner;
      expect(pending(store)).toBe(0);
      if (!committed) {
        expect(runner.status(plan.id)).toMatchObject({
          phase: "RECOVERY_PAUSED",
          status: "DATA_PAUSED",
          reason: "RUNTIME_RESTARTED",
        });
        expect(
          store.db
            .prepare(
              "SELECT status FROM closed_receipt_results ORDER BY seq DESC LIMIT 1",
            )
            .get(),
        ).toEqual({ status: "RESTART_HISTORY_ONLY" });
      }
      await runner.start();
      runner.drain();
      runner.flush();
      adapter.quote(OPEN + 3 * MINUTE, "101");
      adapter.sink.minute(adapter.bar(1, breakout));
      expect(
        store
          .eventsForAttempt(plan.attemptId!)
          .filter((e) => e.type === "ENTRY_TRIGGERED")
          .map((e) => e.id),
      ).toEqual(beforeEntries.map((e) => e.id));
      expect(
        store.db
          .prepare(
            "SELECT COUNT(*) n FROM notifications n LEFT JOIN decision_events e ON e.id=n.event_id WHERE e.id IS NULL",
          )
          .get(),
      ).toEqual({ n: 0 });
      if (committed) {
        expect(store.plan(plan.id).status).toBe("TRIGGERED");
        expect(
          store.reservations().find((r) => r.planId === plan.id)?.state,
        ).toBe("ACTIVE");
        expect(
          store.db
            .prepare("SELECT COUNT(*) n FROM notifications WHERE event_id=?")
            .get(beforeEntries[0].id),
        ).toEqual({ n: 1 });
      }
    },
  );
});
