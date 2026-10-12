import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Funds, PlanInput } from "../../../packages/contracts/index.js";
import type { AttemptInput } from "../../../packages/domain/trigger.js";
import {
  demoInstruments,
  generateDemoBars,
} from "../../../packages/market-data/fixtures.js";
import { Store } from "../store.js";
import { AttemptRuntime, type RuntimeInput } from "../attempt-runtime.js";
import { auditDecisionInput } from "../audit-replay.js";

const now = Date.parse("2026-10-12T10:00:00Z");
const input: PlanInput = {
  instrumentId: "DEMO-US-A",
  anchorTime: null,
  primarySupport: "100",
  lower: "99.75",
  upper: "100.25",
  stop: "99.4",
  entryMin: "100.61",
  entryMax: "101.5",
  mode: "CLOSE_CONFIRM",
  sessionDate: "2026-10-09",
  reason: "服务端合成逐输入样本",
  backgroundConfirmed: true,
  supportSelections: [
    { source: "EMA9" },
    { source: "HORIZONTAL", id: "main", price: "100", label: "水平支撑" },
  ],
};
const funds: Funds = {
  generation: 0,
  nav: "10000",
  baseCurrency: "USD",
  cash: { USD: "10000", CNY: "0" },
  existing: {},
  riskBudget: "50",
  riskPool: "100",
  maxWeight: "0.2",
  fx: { USD: "1", CNY: "0.14" },
  fxAsOf: now,
  confirmedAt: now,
  stale: false,
  buyFee: "0",
  sellFee: "0",
  slippageIn: "0",
  slippageOut: "0",
  feesConfirmed: true,
};
const stores: Store[] = [];
const runtimes: AttemptRuntime[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function openStore(path = ":memory:") {
  const store = new Store(path);
  stores.push(store);
  return store;
}
function runtime(
  store: Store,
  options: ConstructorParameters<typeof AttemptRuntime>[1] = {},
) {
  const value = new AttemptRuntime(store, { now: () => now, ...options });
  runtimes.push(value);
  return value;
}
function setup(path = ":memory:", planInput = input) {
  const store = openStore(path);
  store.putInstrument({
    instrument: demoInstruments[0],
    tags: [],
    note: "synthetic",
    manual: false,
  });
  for (const period of ["1D", "1m", "5m"] as const)
    store.putBars("DEMO-US-A", period, generateDemoBars("DEMO-US-A", period));
  store.updateFunds(funds, 0, now);
  const created = store.createPlan(planInput, now);
  const { plan } = store.activate(created.id, created.version, now);
  const runner = runtime(store);
  const command = {
    expectedVersion: plan.version,
    expectedAttemptId: plan.attemptId!,
  };
  runner.start(plan.id, command);
  return { store, plan, runner, command };
}
function temporaryDb() {
  const directory = mkdtempSync(join(tmpdir(), "pullback-runtime-"));
  directories.push(directory);
  return join(directory, "data.sqlite");
}
function fixture(store: Store, attemptId: string): RuntimeInput[] {
  const row = store.db
    .prepare("SELECT fixture_json FROM runtime_attempts WHERE attempt_id=?")
    .get(attemptId) as { fixture_json: string };
  return JSON.parse(row.fixture_json);
}
function receipts(store: Store, attemptId: string) {
  return store.db
    .prepare(
      "SELECT * FROM runtime_inputs WHERE attempt_id=? ORDER BY ingest_seq",
    )
    .all(attemptId) as {
    ingest_seq: number;
    payload_hash: string;
    input_hash: string;
    input_json: string;
  }[];
}
function auditAll(store: Store) {
  for (const event of store.events()) {
    const snapshot = store.decisionInput(event.id);
    if (snapshot.runtimeVersion !== "synthetic-step-v1") continue;
    const expectedInputHash = event.snapshot.inputHash as string;
    const result = auditDecisionInput({ snapshot, expectedInputHash });
    expect(result.status, `${event.type}: ${JSON.stringify(result)}`).toBe(
      "MATCH",
    );
  }
}

describe("durable synthetic attempt runtime", () => {
  it("commits receipt order, positive sequences, hashes and a fully auditable technical prefix", () => {
    const { store, plan, runner, command } = setup();
    expect(runner.status(plan.id)).toMatchObject({
      phase: "READY",
      inputCount: 0,
      step: 0,
    });
    const state = runner.step(plan.id, {
      ...command,
      expectedStep: 0,
      count: 3,
    });
    expect(state).toMatchObject({
      phase: "RUNNING",
      step: 3,
      inputCount: 3,
      status: "USER_PAUSED",
    });
    expect(state.eventTypes).toContain("TECHNICAL_TRIGGERED");
    expect(store.plan(plan.id).status).toBe("TRIGGERED");
    const inputs = receipts(store, command.expectedAttemptId);
    expect(inputs.map((row) => row.ingest_seq)).toEqual([1, 2, 3]);
    for (const row of inputs)
      expect(row.input_hash).toBe(
        createHash("sha256").update(row.input_json).digest("hex"),
      );
    expect(store.events().every((event) => event.historical)).toBe(true);
    auditAll(store);
    expect(() =>
      store.db.prepare("UPDATE runtime_inputs SET input_json='{}'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      store.db.prepare("UPDATE runtime_attempts SET fixture_json='[]'").run(),
    ).toThrow(/frozen/);
  });

  it("continues after technical entry to archive fade/stop references without reopening entry or releasing its lock", () => {
    const { store, plan, runner, command } = setup();
    runner.step(plan.id, { ...command, expectedStep: 0, count: 3 });
    const before = store.reservations();
    const next = fixture(store, command.expectedAttemptId)[4];
    expect(next.type).toBe("BAR");
    if (next.type !== "BAR") throw new Error("bad fixture");
    const stop: RuntimeInput = {
      ...next,
      id: "synthetic:post-trigger-stop",
      bar: {
        ...next.bar,
        id: "synthetic:post-trigger-stop-bar",
        low: "99.00",
        close: "99.50",
        open: "100.00",
        high: "100.50",
      },
    };
    runner.ingest(command.expectedAttemptId, stop);
    runner.ingest(command.expectedAttemptId, stop);
    expect(
      store.events().filter((event) => event.type === "HISTORICAL_TRIGGERED"),
    ).toHaveLength(1);
    expect(
      store.events().filter((event) => event.type === "STOP_REFERENCE_TOUCHED"),
    ).toHaveLength(1);
    expect(
      store.events().filter((event) => event.type === "BREAKOUT_FADED"),
    ).toHaveLength(1);
    expect(store.plan(plan.id).status).toBe("TRIGGERED");
    expect(store.reservations()).toEqual(before);
    auditAll(store);
  });

  it("treats identical input as idempotent but archives and pauses a conflicting payload", () => {
    const { store, plan, runner, command } = setup();
    const raw = fixture(store, command.expectedAttemptId)[0];
    runner.step(plan.id, { ...command, expectedStep: 0 });
    runner.ingest(command.expectedAttemptId, raw);
    const before = receipts(store, command.expectedAttemptId)[0];
    expect(() =>
      runner.ingest(command.expectedAttemptId, {
        ...raw,
        receivedAt: raw.receivedAt + 1,
      }),
    ).toThrow(/不同内容/);
    const rows = receipts(store, command.expectedAttemptId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before);
    expect(JSON.parse(rows[1].input_json)).toMatchObject({
      type: "DATA_GAP",
      reason: "DUPLICATE_INPUT_CONFLICT",
      ingestSeq: 2,
    });
    expect(runner.status(plan.id)).toMatchObject({
      phase: "DATA_PAUSED",
      reason: "DUPLICATE_INPUT_CONFLICT",
    });
    expect(() => runner.step(plan.id, { ...command, expectedStep: 1 })).toThrow(
      /暂停/,
    );
    auditAll(store);
  });

  it("rolls back receipt, checkpoint, notification and reservation together when event insertion fails", () => {
    const { store, plan, runner, command } = setup();
    runner.step(plan.id, { ...command, expectedStep: 0, count: 2 });
    const before = {
      progress: runner.status(plan.id),
      events: store.events(),
      reservations: store.reservations(),
    };
    store.db.exec(
      "CREATE TRIGGER fail_runtime_entry BEFORE INSERT ON decision_events WHEN NEW.type='TECHNICAL_TRIGGERED' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;",
    );
    expect(() => runner.step(plan.id, { ...command, expectedStep: 2 })).toThrow(
      /simulated disk failure/,
    );
    expect(runner.status(plan.id)).toEqual(before.progress);
    expect(store.events()).toEqual(before.events);
    expect(store.reservations()).toEqual(before.reservations);
    expect(receipts(store, command.expectedAttemptId)).toHaveLength(2);
    store.db.exec("DROP TRIGGER fail_runtime_entry");
    runner.step(plan.id, { ...command, expectedStep: 2 });
    expect(
      receipts(store, command.expectedAttemptId).map((row) => row.ingest_seq),
    ).toEqual([1, 2, 3]);
    expect(
      store.events().filter((event) => event.type === "TECHNICAL_TRIGGERED"),
    ).toHaveLength(1);
    auditAll(store);
  });

  it("uses database CAS across two connections instead of accepting a stale browser step", () => {
    const path = temporaryDb();
    const { store, plan, runner, command } = setup(path);
    const other = runtime(openStore(path), { recover: false });
    runner.step(plan.id, { ...command, expectedStep: 0 });
    expect(() => other.step(plan.id, { ...command, expectedStep: 0 })).toThrow(
      /进度已改变/,
    );
    other.step(plan.id, { ...command, expectedStep: 1 });
    expect(runner.status(plan.id)).toMatchObject({ step: 2, inputCount: 2 });
    expect(
      receipts(store, command.expectedAttemptId).map((row) => row.ingest_seq),
    ).toEqual([1, 2]);
  });

  it("pauses persisted incomplete work on restart and requires an explicit new attempt", () => {
    const path = temporaryDb();
    const { store, plan, runner, command } = setup(path);
    runner.step(plan.id, { ...command, expectedStep: 0 });
    runner.close();
    store.close();
    const reopened = openStore(path);
    reopened.markRestored(now + 1);
    const restarted = runtime(reopened);
    expect(restarted.status(plan.id)).toMatchObject({
      phase: "RECOVERY_PAUSED",
      status: "DATA_PAUSED",
      reason: "RUNTIME_RESTARTED",
      step: 1,
      inputCount: 2,
    });
    expect(() =>
      restarted.step(plan.id, { ...command, expectedStep: 1 }),
    ).toThrow(/暂停/);
    expect(
      reopened.events().some((event) => event.type === "TECHNICAL_TRIGGERED"),
    ).toBe(false);
    auditAll(reopened);
  });

  it("preserves a consumed entry on restart without emitting it again", () => {
    const path = temporaryDb();
    const { store, plan, runner, command } = setup(path);
    runner.step(plan.id, { ...command, expectedStep: 0, count: 3 });
    const reservation = store.reservations();
    runner.close();
    store.close();
    const reopened = openStore(path);
    reopened.markRestored(now + 1);
    const restarted = runtime(reopened);
    expect(restarted.status(plan.id)?.phase).toBe("RECOVERY_PAUSED");
    expect(reopened.plan(plan.id).status).toBe("TRIGGERED");
    expect(reopened.reservations()).toEqual(reservation);
    expect(
      reopened
        .events()
        .filter((event) => event.type === "HISTORICAL_TRIGGERED"),
    ).toHaveLength(1);
    auditAll(reopened);
  });

  it("keeps the exact grace boundary and records late qualification only as non-actionable history", () => {
    const { store, plan, runner, command } = setup();
    runner.step(plan.id, { ...command, expectedStep: 0, count: 2 });
    const deadline = runner.status(plan.id)!.deadline;
    runner.ingest(command.expectedAttemptId, {
      type: "CLOCK",
      id: "synthetic:clock-boundary",
      receivedAt: deadline + 30_000,
    });
    expect(runner.status(plan.id)?.status).toBe("ARMED");
    runner.ingest(command.expectedAttemptId, {
      type: "CLOCK",
      id: "synthetic:clock-past-boundary",
      receivedAt: deadline + 30_001,
    });
    expect(runner.status(plan.id)).toMatchObject({
      status: "EXPIRED",
      deadlineWatermark: deadline + 30_001,
    });
    const raw = fixture(store, command.expectedAttemptId)[2];
    if (raw.type !== "BAR") throw new Error("bad fixture");
    const receivedAt = deadline + 30_002;
    runner.ingest(command.expectedAttemptId, {
      ...raw,
      receivedAt,
      bar: { ...raw.bar, receivedAt },
    });
    expect(runner.status(plan.id)?.eventTypes).toContain("TECHNICAL_TRIGGERED");
    expect(store.plan(plan.id).status).not.toBe("TRIGGERED");
    expect(store.reservations()[0].state).toBe("RELEASED");
    expect(
      store.events().some((event) => event.type === "HISTORICAL_TRIGGERED"),
    ).toBe(false);
    auditAll(store);
  });

  it("freezes the risk gate at each accepted receipt using the current atomic funding generation", () => {
    const { store, plan, runner, command } = setup();
    runner.step(plan.id, { ...command, expectedStep: 0, count: 2 });
    store.updateFunds({ ...funds, maxWeight: "0.1" }, 1, now);
    runner.step(plan.id, { ...command, expectedStep: 2 });
    const event = store
      .events()
      .find((entry) => entry.type === "HISTORICAL_TRIGGERED")!;
    expect(event.quantity).toBe(9);
    const snapshot = store.decisionInput(event.id);
    expect((snapshot.funds as Funds).generation).toBe(2);
    const last = (snapshot.inputs as AttemptInput[]).at(-1)!;
    expect(last.type === "BAR" && last.gates?.risk.quantity).toBe(9);
    auditAll(store);
  });

  it("keeps bar-specific lateness non-actionable even before the attempt deadline and without a CLOCK", () => {
    const { store, plan, runner, command } = setup();
    runner.step(plan.id, { ...command, expectedStep: 0, count: 2 });
    const raw = fixture(store, command.expectedAttemptId)[2];
    if (raw.type !== "BAR") throw new Error("bad fixture");
    const receivedAt = raw.bar.end + 30_001;
    runner.ingest(command.expectedAttemptId, {
      ...raw,
      receivedAt,
      bar: { ...raw.bar, receivedAt },
    });
    expect(runner.status(plan.id)).toMatchObject({
      status: "EXPIRED",
      deadlineWatermark: null,
    });
    expect(store.plan(plan.id).status).toBe("EXPIRED");
    expect(store.reservations()[0].state).toBe("RELEASED");
    expect(
      store.events().some((event) => event.type === "LATE_TECHNICAL_REFERENCE"),
    ).toBe(true);
    expect(
      store.events().some((event) => event.type === "HISTORICAL_TRIGGERED"),
    ).toBe(false);
    auditAll(store);
  });

  it("archives a blocked technical decision when another record makes the current funds stale", () => {
    const { store, plan, runner, command } = setup();
    runner.step(plan.id, { ...command, expectedStep: 0, count: 2 });
    // Same append-only funding transition as a pending external execution acknowledgement.
    const stale = { ...store.funds()!, generation: 2, stale: true };
    store.db
      .prepare("INSERT INTO account_snapshots VALUES(?,?)")
      .run(stale.generation, JSON.stringify(stale));
    store.setSetting("funds_generation", "2");
    runner.step(plan.id, { ...command, expectedStep: 2 });
    expect(store.events().some((event) => event.type === "RISK_BLOCKED")).toBe(
      true,
    );
    expect(
      store.events().some((event) => event.type === "HISTORICAL_TRIGGERED"),
    ).toBe(false);
    expect(store.plan(plan.id).status).toBe("USER_PAUSED");
    expect(store.reservations()[0].state).toBe("RELEASED");
    auditAll(store);
  });

  it("does not advance historical time from wall time and stops its scheduler before database close", async () => {
    const { store, plan, runner, command } = setup();
    runner.startScheduler(10);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runner.status(plan.id)).toMatchObject({
      phase: "READY",
      inputCount: 0,
    });
    runner.close();
    store.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(() => runner.step(plan.id, { ...command, expectedStep: 0 })).toThrow(
      /关闭/,
    );
  });

  it("can finish all frozen inputs after technical qualification without another entry", () => {
    const { store, plan, runner, command } = setup();
    while (
      !["COMPLETE", "DATA_PAUSED"].includes(runner.status(plan.id)!.phase)
    ) {
      runner.step(plan.id, {
        ...command,
        expectedStep: runner.status(plan.id)!.step,
        count: 20,
      });
    }
    const progress = runner.status(plan.id)!;
    expect(progress.phase).toBe("COMPLETE");
    expect(progress.step).toBe(progress.totalSteps);
    expect(
      store.events().filter((event) => event.type === "HISTORICAL_TRIGGERED"),
    ).toHaveLength(1);
    auditAll(store);
  });

  it("persists the final explicit CLOCK and releases a no-touch attempt after all fixture inputs", () => {
    const { store, plan, runner, command } = setup(":memory:", {
      ...input,
      lower: "99.00",
      upper: "99.20",
      stop: "98.50",
    });
    while (runner.status(plan.id)!.phase !== "COMPLETE")
      runner.step(plan.id, {
        ...command,
        expectedStep: runner.status(plan.id)!.step,
        count: 20,
      });
    const progress = runner.status(plan.id)!;
    expect(progress).toMatchObject({
      status: "EXPIRED",
      lastInput: { type: "CLOCK" },
    });
    expect(progress.deadlineWatermark).toBe(progress.deadline + 30_001);
    expect(progress.inputCount).toBe(progress.totalSteps + 1);
    expect(store.reservations()[0].state).toBe("RELEASED");
    expect(
      store.events().some((event) => event.type === "TECHNICAL_TRIGGERED"),
    ).toBe(false);
    auditAll(store);
  });
});
