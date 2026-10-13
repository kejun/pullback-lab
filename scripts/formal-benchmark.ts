import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { availableParallelism, cpus, platform, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { createApp, type PullbackApp } from "../apps/server/app.js";
import { closedHash } from "../apps/server/closed-bar-adapter.js";
import { auditDecisionInput } from "../apps/server/audit-replay.js";
import {
  ContractAdapter,
  OPEN,
  planInput,
  testFunds,
} from "../apps/server/tests/closed-bar-fixture.js";
import {
  demoInstruments,
  generateDemoBars,
} from "../packages/market-data/fixtures.js";
import type {
  CandidatePage,
  DecisionEvent,
  Plan,
} from "../packages/contracts/index.js";

const POOL_SIZE = 100;
const MONITORED = 10;
const marker = { "x-requested-with": "PullbackLab" };
const roundMs = (value: number) => Number(value.toFixed(3));

/** Benchmark-only contract adapter. This module is never loaded by production startup. */
class BenchmarkAdapter extends ContractAdapter {
  readonly fixtures = Array.from({ length: MONITORED }, (_, index) => {
    const context = structuredClone(this.context);
    const id = `CONTRACT-BENCH-${String(index).padStart(3, "0")}`;
    context.instrument = { ...context.instrument, id, symbol: `${id}.US` };
    context.daily = context.daily.map((bar) => ({
      ...bar,
      id: `${id}:${bar.id}`,
    }));
    return context;
  });
  override contexts() {
    return this.fixtures;
  }
  sendQuote(index: number, at: number, price: string) {
    this.sink.quote({
      instrumentId: this.fixtures[index].instrument.id,
      sessionId: this.session.id,
      source: this.context.source,
      id: `benchmark-quote:${index}:${at}`,
      price,
      at,
    });
  }
  minute(index: number, minuteIndex: number) {
    return this.bar(minuteIndex, {
      instrumentId: this.fixtures[index].instrument.id,
      id: `benchmark-minute:${index}:${minuteIndex}`,
      open: "100.5",
      high: minuteIndex === 0 ? "100.6" : "101.2",
      low: minuteIndex === 0 ? "100" : "100.4",
      close: minuteIndex === 0 ? "100.5" : "101",
    });
  }
}

export interface BenchmarkSample {
  round: number;
  instrumentId?: string;
  elapsedMs: number;
  success: boolean;
  failureCode?: string;
}
export function summarizeSamples(
  values: readonly BenchmarkSample[],
  planned: number,
) {
  const successful = values
    .filter((sample) => sample.success)
    .map((sample) => sample.elapsedMs)
    .sort((a, b) => a - b);
  return {
    planned,
    attempted: values.length,
    successful: successful.length,
    failed: values.length - successful.length,
    notAttempted: planned - values.length,
    successfulOnly: successful.length
      ? {
          minMs: successful[0],
          medianMs: successful[Math.ceil(successful.length * 0.5) - 1],
          p95Ms: successful[Math.ceil(successful.length * 0.95) - 1],
          maxMs: successful.at(-1)!,
        }
      : null,
    samples: values,
  };
}
export function targetPassed(
  summary: ReturnType<typeof summarizeSamples>,
  threshold: number,
) {
  return (
    summary.planned > 0 &&
    summary.successful === summary.planned &&
    summary.failed === 0 &&
    summary.notAttempted === 0 &&
    summary.successfulOnly!.p95Ms <= threshold
  );
}
const assert = (condition: unknown, code: string): void => {
  if (!condition) throw new Error(code);
};
const failureCode = (cause: unknown): string => {
  const value = cause instanceof Error ? cause.message : "BENCHMARK_FAILED";
  return /^[A-Z][A-Z0-9_]{0,100}$/.test(value)
    ? value
    : "BENCHMARK_OPERATION_FAILED";
};

/** Read a single committed snapshot from a separate SQLite connection. No writes or replay of inputs. */
function verifyEntry(
  reader: Database.Database,
  plan: Plan,
  expectedMinute: unknown,
) {
  return reader.transaction(() => {
    const entries = reader
      .prepare(
        `SELECT e.id,e.json,i.json input_json,e.input_hash,
      a.consumed,c.state_json,c.watermark,r.json reservation_json,p.json plan_json,
      q.payload_hash,q.payload_json,x.status receipt_status,
      (SELECT count(*) FROM notifications WHERE event_id=e.id) notifications,
      (SELECT count(*) FROM event_summaries WHERE id=e.id) summaries,
      (SELECT count(*) FROM event_feed_changes WHERE event_id=e.id AND kind='EVENT') feed
      FROM decision_events e JOIN decision_inputs i ON i.hash=e.input_hash
      JOIN attempts a ON a.id=e.attempt_id JOIN closed_attempts c ON c.attempt_id=e.attempt_id
      JOIN plans p ON p.id=c.plan_id JOIN reservations r ON r.plan_id=c.plan_id
      JOIN closed_receipts q ON q.seq=json_extract(i.json,'$.receiptSeq')
      JOIN closed_receipt_results x ON x.seq=q.seq
      WHERE e.attempt_id=? AND e.type='ENTRY_TRIGGERED'`,
      )
      .all(plan.attemptId) as Array<{
      id: string;
      json: string;
      input_json: string;
      input_hash: string;
      consumed: number;
      state_json: string;
      watermark: number;
      reservation_json: string;
      plan_json: string;
      payload_hash: string;
      payload_json: string;
      receipt_status: string;
      notifications: number;
      summaries: number;
      feed: number;
    }>;
    assert(entries.length === 1, "COMMITTED_ENTRY_MISSING_OR_DUPLICATED");
    const row = entries[0];
    const entry = JSON.parse(row.json) as DecisionEvent;
    const snapshot = JSON.parse(row.input_json);
    const reservation = JSON.parse(row.reservation_json);
    assert(
      !entry.historical &&
        snapshot.runtimeVersion === "closed-bar-v1" &&
        snapshot.synthetic === false,
      "FORMAL_ENTRY_REQUIRED",
    );
    assert(
      row.payload_hash === closedHash(expectedMinute) &&
        closedHash(JSON.parse(row.payload_json)) === row.payload_hash,
      "QUALIFIED_RECEIPT_MISMATCH",
    );
    assert(
      closedHash(snapshot) === row.input_hash &&
        row.receipt_status === "ACCEPTED",
      "COMMITTED_RECEIPT_OR_SNAPSHOT_INVALID",
    );
    assert(
      row.consumed === 1 &&
        JSON.parse(row.state_json).status === "TRIGGERED" &&
        JSON.parse(row.plan_json).status === "TRIGGERED",
      "COMMITTED_STATE_INVALID",
    );
    assert(
      row.watermark === OPEN + 120000 &&
        reservation.attemptId === plan.attemptId &&
        reservation.state === "ACTIVE" &&
        reservation.quantity === entry.quantity,
      "COMMITTED_RESERVATION_INVALID",
    );
    assert(
      row.notifications === 1 && row.summaries === 1 && row.feed === 1,
      "COMMITTED_NOTIFICATION_MISSING",
    );
    return {
      snapshot,
      serializedInput: row.input_json,
      expectedInputHash: row.input_hash,
    };
  })();
}

export interface FormalBenchmarkOptions {
  rounds: number;
  /** Test seam for proving failed commits are counted. Never used by the CLI. */
  beforeQualifiedInput?: (
    app: PullbackApp,
    round: number,
    index: number,
  ) => void;
}

export async function runFormalBenchmark({
  rounds,
  beforeQualifiedInput,
}: FormalBenchmarkOptions) {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100)
    throw new Error("INVALID_ROUNDS");
  const started = performance.now();
  const source = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    changes: execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
  };
  // Use the checkout filesystem, not /tmp: cloud /tmp may be tmpfs and would
  // measure memory-backed storage despite using the real SQLite file API.
  const directory = mkdtempSync(join(process.cwd(), ".formal-benchmark-"));
  const filesystemTypeHex = `0x${statfsSync(directory).type.toString(16)}`;
  const cold: BenchmarkSample[] = [],
    warm: BenchmarkSample[] = [],
    entry: BenchmarkSample[] = [],
    batch: BenchmarkSample[] = [];
  const failures: Array<{ round: number; phase: string; code: string }> = [];
  let sqlite: string | null = null;
  let auditsMatched = 0;
  let completedRounds = 0;
  let removedAfterRun = false;
  try {
    for (let round = 1; round <= rounds; round++) {
      let now = OPEN - 1;
      let app: PullbackApp | undefined;
      let reader: Database.Database | undefined;
      try {
        const databasePath = join(directory, `round-${round}.sqlite`);
        const adapter = new BenchmarkAdapter();
        app = await createApp({
          password: "offline-formal-benchmark",
          databasePath,
          now: () => now,
          closedBarAdapter: adapter,
        });
        sqlite = (
          app.store.db.prepare("SELECT sqlite_version() version").get() as {
            version: string;
          }
        ).version;
        assert(
          app.store.db.pragma("journal_mode", { simple: true }) === "wal" &&
            app.store.db.pragma("synchronous", { simple: true }) === 2,
          "FILE_SQLITE_WAL_FULL_REQUIRED",
        );
        app.store.transaction(() => {
          for (const context of adapter.contexts()) {
            app!.store.putInstrument({
              instrument: context.instrument,
              manual: false,
              tags: ["offline contract fixture"],
              note: "Not an actual security or account",
            });
            app!.store.putBars(context.instrument.id, "1D", context.daily);
          }
          for (let index = MONITORED; index < POOL_SIZE; index++) {
            const id = `DEMO-BENCH-${String(index).padStart(3, "0")}`;
            app!.store.putInstrument({
              instrument: {
                ...demoInstruments[0],
                id,
                symbol: `${id}.US`,
                name: "Offline benchmark fixture",
              },
              manual: false,
              tags: ["synthetic"],
              note: "Not an actual security or account",
            });
            app!.store.putBars(
              id,
              "1D",
              generateDemoBars("DEMO-US-A").map((bar) => ({
                ...bar,
                id: bar.id.replace("DEMO-US-A", id),
              })),
            );
          }
        });
        await app.monitor.start();
        app.store.confirmScreening(undefined, 0, now);
        const funds = {
          ...testFunds,
          nav: "1000000",
          cash: { USD: "1000000", CNY: "0" },
          riskPool: "5000",
          fxAsOf: now,
        };
        app.store.updateFunds(funds, 0, now);
        const login = await app.inject({
          method: "POST",
          url: "/api/login",
          headers: marker,
          payload: { password: "offline-formal-benchmark" },
        });
        assert(
          login.statusCode === 200 && login.headers["set-cookie"],
          "LOGIN_FAILED",
        );
        const headers = {
          ...marker,
          cookie: login.headers["set-cookie"]!.toString().split(";")[0],
        };
        const plans: Plan[] = [];
        for (const context of adapter.contexts()) {
          const created = app.store.createPlan(
            { ...planInput, instrumentId: context.instrument.id },
            now,
          );
          const response = await app.inject({
            method: "POST",
            url: `/api/plans/${created.id}/activate`,
            headers,
            payload: {
              expectedVersion: created.version,
              expectedAttemptId: null,
            },
          });
          assert(response.statusCode === 200, "FORMAL_ACTIVATION_FAILED");
          plans.push(response.json<{ plan: Plan }>().plan);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert(
          adapter.subscriptions.length === MONITORED &&
            plans.every(
              (plan) => app!.monitor.status(plan.id)?.status === "WAIT_RETEST",
            ),
          "TEN_FORMAL_MONITORS_REQUIRED",
        );
        for (const [bucket, cacheHit] of [
          [cold, false],
          [warm, true],
        ] as const) {
          const sampleStart = performance.now();
          let code: string | undefined;
          try {
            const response = await app.inject({
              url: "/api/candidates",
              headers,
            });
            assert(response.statusCode === 200, "CANDIDATE_REQUEST_FAILED");
            const page = response.json<CandidatePage>();
            assert(
              page.candidates.length === POOL_SIZE &&
                page.coverage === POOL_SIZE &&
                page.cacheHit === cacheHit,
              "CANDIDATE_COVERAGE_OR_CACHE_INVALID",
            );
          } catch (cause) {
            code = failureCode(cause);
          }
          bucket.push({
            round,
            elapsedMs: roundMs(performance.now() - sampleStart),
            success: !code,
            ...(code ? { failureCode: code } : {}),
          });
        }
        now = OPEN;
        app.store.updateFunds(
          { ...funds, fxAsOf: now },
          app.store.funds()!.generation,
          now,
        );
        now = OPEN + 60000;
        for (let index = 0; index < MONITORED; index++) {
          adapter.sendQuote(index, now, "100.5");
          adapter.sink.minute(adapter.minute(index, 0));
        }
        assert(
          plans.every(
            (plan) => app!.monitor.status(plan.id)?.status === "ARMED",
          ),
          "TEN_ARMED_ATTEMPTS_REQUIRED",
        );
        now = OPEN + 120000;
        for (let index = 0; index < MONITORED; index++)
          adapter.sendQuote(index, now, "101");
        reader = new Database(databasePath, {
          readonly: true,
          fileMustExist: true,
        });
        reader.pragma("query_only = ON");
        const audits: ReturnType<typeof verifyEntry>[] = [];
        const batchStart = performance.now();
        let batchFailed = false;
        for (let index = 0; index < MONITORED; index++) {
          beforeQualifiedInput?.(app, round, index);
          const minute = adapter.minute(index, 1);
          const sampleStart = performance.now();
          let code: string | undefined;
          try {
            adapter.sink.minute(minute);
            audits.push(verifyEntry(reader, plans[index], minute));
          } catch (cause) {
            code = failureCode(cause);
            batchFailed = true;
          }
          entry.push({
            round,
            instrumentId: plans[index].instrumentId,
            elapsedMs: roundMs(performance.now() - sampleStart),
            success: !code,
            ...(code ? { failureCode: code } : {}),
          });
        }
        batch.push({
          round,
          elapsedMs: roundMs(performance.now() - batchStart),
          success: !batchFailed,
          ...(batchFailed ? { failureCode: "BATCH_HAS_FAILED_ENTRY" } : {}),
        });
        // Audit outside the latency window; never replay an input into the live runtime.
        const before = (
          app.store.db.prepare("SELECT total_changes() n").get() as {
            n: number;
          }
        ).n;
        for (const audit of audits) {
          assert(
            auditDecisionInput(audit).status === "MATCH",
            "FORMAL_AUDIT_MISMATCH",
          );
          auditsMatched++;
        }
        assert(
          (
            app.store.db.prepare("SELECT total_changes() n").get() as {
              n: number;
            }
          ).n === before,
          "AUDIT_MUST_BE_READ_ONLY",
        );
        completedRounds++;
      } catch (cause) {
        failures.push({ round, phase: "round", code: failureCode(cause) });
      } finally {
        try {
          reader?.close();
        } catch (cause) {
          failures.push({
            round,
            phase: "reader-close",
            code: failureCode(cause),
          });
        }
        try {
          await app?.close();
        } catch (cause) {
          failures.push({
            round,
            phase: "app-close",
            code: failureCode(cause),
          });
        }
      }
    }
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
      removedAfterRun = true;
    } catch (cause) {
      failures.push({ round: 0, phase: "cleanup", code: failureCode(cause) });
    }
  }
  const candidatesCold = summarizeSamples(cold, rounds),
    candidatesWarm = summarizeSamples(warm, rounds);
  const qualifiedInputToCommit = summarizeSamples(entry, rounds * MONITORED),
    tenPlanBurst = summarizeSamples(batch, rounds);
  const targets = {
    cachedPageP95AtMost2000ms: targetPassed(candidatesWarm, 2000),
    qualifiedInputToCommitP95AtMost5000ms: targetPassed(
      qualifiedInputToCommit,
      5000,
    ),
    tenPlanBurstP95AtMost5000ms: targetPassed(tenPlanBurst, 5000),
  };
  const success =
    Object.values(targets).every(Boolean) &&
    candidatesCold.failed === 0 &&
    candidatesCold.notAttempted === 0 &&
    failures.length === 0 &&
    auditsMatched === rounds * MONITORED;
  return {
    schema: "pullback-formal-runtime-benchmark-v1",
    generatedAt: new Date().toISOString(),
    status: success ? "PASS" : "FAIL",
    exitCode: success ? 0 : 1,
    syntheticOnly: true,
    source,
    environment: {
      node: process.version,
      sqlite,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      availableParallelism: availableParallelism(),
      database: {
        kind: "separate temporary file per round on the checkout filesystem",
        journalMode: "wal",
        synchronous: "FULL",
        independentReadOnlyConnection: true,
        filesystemTypeHex,
        removedAfterRun,
      },
      transport:
        "Fastify.inject authenticated candidate and activation handlers; in-process ContractAdapter callbacks; no socket or provider requests",
    },
    dataset: {
      instruments: POOL_SIZE,
      dailyBarsPerInstrument: 300,
      simultaneousFormalMonitors: MONITORED,
      sampleRounds: rounds,
      completedRounds,
      plannedEntries: rounds * MONITORED,
      fixture:
        "10 isolated ContractAdapter contexts plus 90 explicitly synthetic daily histories; all data is offline generated",
    },
    methodology: {
      clock:
        "performance.now() measures elapsed latency; injected server clock advances through a fixed two-minute session independently and is never used to compute latency",
      percentile:
        "nearest-rank over successful samples only; every attempt including failures is retained; any failure, missing sample, audit or cleanup failure fails the run",
      qualifiedInputToCommit:
        "from immediately before the qualifying closed-minute sink callback, including immutable receipt insertion, production auto-drain, risk/reducer/event transactions, WAL/FULL COMMIT and independent SQLite read-back of ENTRY, input hash, consumed attempt, plan, reservation and notification/feed",
      tenPlanBurst:
        "all 10 monitors remain active; 10 eligible inputs dispatched serially in one JavaScript turn with no intentional gap, from before first dispatch through last independent commit verification; conservative batch bound also enforced",
      candidates:
        "100 complete histories while 10 formal monitors are WAIT_RETEST; first request on a new application cache then immediate cache hit, both authenticated; new database each round, OS and JIT caches are not reset",
      excluded:
        "database/app/fixture setup, authentication, plan activation, first retest minute and prerequisite quotes, post-measurement read-only archive audit and shutdown",
    },
    candidates: { cold: candidatesCold, warm: candidatesWarm },
    formalRuntime: { qualifiedInputToCommit, tenPlanBurst, auditsMatched },
    targets,
    failures,
    upstream: {
      measured: false,
      latencyMs: null,
      timeoutCount: null,
      failureCount: null,
    },
    totalDurationMs: roundMs(performance.now() - started),
    limits: [
      "Offline trusted contract fixtures exercise the formal runtime, not actual provider evidence, an actual account, real market monitoring, or a production SLA.",
      "Fixture context synthetic=false is the isolated adapter contract required to test the formal branch; it does not make the generated market data real or enable production capabilities.",
      "No historical replayPlan call is used. Archive audit is read-only and excluded from measured input-to-commit latency.",
      "No provider/network, socket transport, browser rendering, SSE delivery, target-host disk, physical power loss or simultaneous OS-process contention is measured.",
      "Independent fresh-database rounds measure a fixed first opportunity, not long-running session/database growth or all timing paths. WAL/FULL configuration is verified, not physical durability; the filesystem type is recorded and the cloud host is not isolated from other work.",
    ],
  };
}
