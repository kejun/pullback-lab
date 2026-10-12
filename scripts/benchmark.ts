import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { availableParallelism, cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type PullbackApp } from "../apps/server/app.js";
import { replayPlan } from "../apps/server/replay.js";
import { auditDecisionInput } from "../apps/server/audit-replay.js";
import {
  demoInstruments,
  generateDemoBars,
} from "../packages/market-data/fixtures.js";
import type {
  DecisionEvent,
  Plan,
  PlanInput,
} from "../packages/contracts/index.js";

/** Offline, authenticated HTTP-handler benchmark. Never reads credentials or contacts a provider. */
const suppliedSamples = process.argv.slice(2);
if (
  suppliedSamples.some((arg) => !/^--samples=\d+$/.test(arg)) ||
  suppliedSamples.length > 1
)
  throw new Error(
    "Usage: node --import tsx scripts/benchmark.ts [--samples=30]",
  );
const samples = suppliedSamples.length
  ? Number(suppliedSamples[0].split("=")[1])
  : 30;
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100)
  throw new Error("samples must be between 1 and 100");

const now = Date.parse("2026-10-12T10:00:00Z");
const password = "offline-benchmark-only";
const marker = { "x-requested-with": "PullbackLab" };
const poolSize = 100;
const monitoredPlans = 10;
const ids = Array.from(
  { length: poolSize },
  (_, index) => `DEMO-BENCH-${String(index).padStart(3, "0")}`,
);
const input = (instrumentId: string): PlanInput => ({
  instrumentId,
  anchorTime: null,
  primarySupport: "100",
  lower: "99.75",
  upper: "100.25",
  stop: "99.4",
  entryMin: "100.61",
  entryMax: "101.5",
  mode: "CLOSE_CONFIRM",
  sessionDate: "2026-10-09",
  reason: "固定合成性能样本；不代表真实证券或行情",
  backgroundConfirmed: true,
  supportSelections: [
    { source: "EMA9" },
    { source: "HORIZONTAL", id: "main", price: "100", label: "合成水平支撑" },
  ],
});
function summarize(values: number[]) {
  if (!values.length) throw new Error("No benchmark samples");
  const sorted = [...values].sort((a, b) => a - b);
  const rounded = (value: number) => Number(value.toFixed(3));
  return {
    samples: sorted.length,
    minMs: rounded(sorted[0]),
    medianMs: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maxMs: rounded(sorted.at(-1)!),
  };
}
function changes(app: PullbackApp) {
  return (
    app.store.db.prepare("SELECT total_changes() AS count").get() as {
      count: number;
    }
  ).count;
}
const candidatesCold: number[] = [],
  candidatesWarm: number[] = [];
const replayPerPlan: number[] = [],
  replayBatch: number[] = [];
const auditPerPlan: number[] = [],
  auditBatch: number[] = [];
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pullback-benchmark-"));
const databasePath = join(temporaryDirectory, "benchmark.sqlite");
let appToClose: PullbackApp | undefined;
let report: Record<string, unknown> | undefined;
try {
  const app = await createApp({
    password,
    demo: true,
    databasePath,
    now: () => now,
  });
  appToClose = app;
  const journalMode = app.store.db.pragma("journal_mode", { simple: true });
  const synchronous = app.store.db.pragma("synchronous", { simple: true });
  if (journalMode !== "wal" || synchronous !== 2)
    throw new Error(
      `Expected file-backed WAL/FULL, got ${journalMode}/${synchronous}`,
    );
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: marker,
    payload: { password },
  });
  if (login.statusCode !== 200 || !login.headers["set-cookie"])
    throw new Error(`Benchmark login failed: ${login.statusCode}`);
  const headers = {
    ...marker,
    cookie: login.headers["set-cookie"].toString().split(";")[0],
  };
  const request = async <T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
  ): Promise<T> => {
    const response = await app.inject({ method, url, headers, payload });
    if (response.statusCode !== 200)
      throw new Error(
        `${method} ${url}: ${response.statusCode} ${response.body}`,
      );
    return response.json<T>();
  };
  // Use the exact verified demo fixture; only identities change. All bar IDs retain the synthetic prefix.
  app.store.transaction(() => {
    for (const id of ids) {
      app.store.putInstrument({
        instrument: {
          ...demoInstruments[0],
          id,
          symbol: `${id}.US`,
          name: `合成基准 ${id}`,
        },
        tags: ["合成基准"],
        note: "离线性能测量",
        manual: false,
      });
      for (const period of ["1D", "1m", "5m"] as const)
        app.store.putBars(
          id,
          period,
          generateDemoBars("DEMO-US-A", period).map((bar) => ({
            ...bar,
            id: bar.id.replace("DEMO-US-A", id),
          })),
        );
    }
  });
  await request("POST", "/api/settings/screening", { confirmed: true });
  await request("POST", "/api/funds", {
    expectedGeneration: 0,
    nav: "1000000",
    baseCurrency: "USD",
    cash: { USD: "1000000", CNY: "0" },
    existing: {},
    riskBudget: "50",
    riskPool: "5000",
    maxWeight: "0.2",
    fx: { USD: "1", CNY: "0.14" },
    fxAsOf: now,
    buyFee: "0",
    sellFee: "0",
    slippageIn: "0",
    slippageOut: "0",
    feesConfirmed: true,
  });
  const plans: Plan[] = [];
  for (const id of ids.slice(0, monitoredPlans))
    plans.push(await request<Plan>("POST", "/api/plans", input(id)));
  for (let iteration = 0; iteration < samples; iteration++) {
    // Invalidate any result cache through a real authenticated mutation. This is application-cache cold,
    // not a claim about a fresh process, disk caches, socket transport or provider latency.
    await request("PATCH", `/api/universe/${ids[0]}`, {
      tags: ["合成基准"],
      note: `离线性能测量 ${iteration}`,
    });
    for (const bucket of [candidatesCold, candidatesWarm]) {
      const started = performance.now();
      const result = await request<{ candidates: unknown[]; coverage: number }>(
        "GET",
        "/api/candidates",
      );
      bucket.push(performance.now() - started);
      if (result.candidates.length !== poolSize || result.coverage !== poolSize)
        throw new Error(
          `Candidate fixture incomplete: ${result.candidates.length}/${result.coverage}`,
        );
    }
    for (let index = 0; index < plans.length; index++) {
      if (iteration > 0)
        plans[index] = await request<Plan>(
          "POST",
          `/api/plans/${plans[index].id}/versions`,
          {
            ...input(plans[index].instrumentId),
            expectedVersion: plans[index].version,
          },
        );
      const result = await request<{ plan: Plan }>(
        "POST",
        `/api/plans/${plans[index].id}/activate`,
        {
          expectedVersion: plans[index].version,
        },
      );
      plans[index] = result.plan;
      if (
        !result.plan.supportSnapshot?.ready ||
        result.plan.status !== "WAIT_RETEST"
      )
        throw new Error(
          "Plan activation did not pass the frozen support and risk gates",
        );
    }
    if (
      app.store
        .plans()
        .filter((plan) => ["WAIT_RETEST", "ARMED"].includes(plan.status))
        .length !== monitoredPlans
    )
      throw new Error("Expected exactly 10 activated synthetic plans");
    const decisions: DecisionEvent[] = [];
    const replayStarted = performance.now();
    for (const plan of plans) {
      const started = performance.now();
      const events = replayPlan(app.store, plan.id, now);
      replayPerPlan.push(performance.now() - started);
      const entry = events.find(
        (event) => event.type === "HISTORICAL_TRIGGERED",
      );
      if (!entry || !entry.historical)
        throw new Error(
          "Synthetic plan did not archive a historical entry event",
        );
      decisions.push(entry);
    }
    replayBatch.push(performance.now() - replayStarted);
    const beforeAudit = changes(app);
    const auditStarted = performance.now();
    for (const event of decisions) {
      const started = performance.now();
      const row = app.store.db
        .prepare(
          "SELECT i.json,e.input_hash FROM decision_inputs i JOIN decision_events e ON e.input_hash=i.hash WHERE e.id=?",
        )
        .get(event.id) as { json: string; input_hash: string } | undefined;
      if (!row) throw new Error("Decision input was not persisted");
      const result = auditDecisionInput({
        snapshot: JSON.parse(row.json),
        serializedInput: row.json,
        expectedInputHash: row.input_hash,
      });
      auditPerPlan.push(performance.now() - started);
      if (result.status !== "MATCH")
        throw new Error(`Audit replay failed: ${JSON.stringify(result)}`);
    }
    auditBatch.push(performance.now() - auditStarted);
    if (changes(app) !== beforeAudit)
      throw new Error("Read-only audit mutated SQLite");
    for (const event of decisions)
      await request("POST", `/api/events/${event.id}/feedback`, {
        kind: "SKIPPED",
        note: "离线基准释放合成预留",
      });
  }
  const cold = summarize(candidatesCold),
    warm = summarize(candidatesWarm);
  const replay = summarize(replayPerPlan),
    batch = summarize(replayBatch);
  const sqlite = (
    app.store.db.prepare("SELECT sqlite_version() AS version").get() as {
      version: string;
    }
  ).version;
  report = {
    benchmarkVersion: "pullback-synthetic-v2",
    generatedAt: new Date().toISOString(),
    syntheticOnly: true,
    environment: {
      node: process.version,
      sqlite,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      availableParallelism: availableParallelism(),
      database: {
        kind: "file-backed temporary SQLite",
        path: databasePath,
        journalMode,
        synchronous,
        synchronousName: "FULL",
        filesystemTypeHex: `0x${statfsSync(temporaryDirectory).type.toString(16)}`,
        removedAfterRun: true,
      },
      transport:
        "Fastify.inject; authenticated HTTP handlers, no socket/network",
    },
    dataset: {
      fixture: "DEMO-US-A copied under 100 distinct synthetic instrument IDs",
      market: "US",
      instruments: poolSize,
      dailyBarsPerInstrument: 300,
      minuteBarsPerInstrument: 60,
      fiveMinuteBarsPerInstrument: 12,
      simultaneousActivatedPlans: monitoredPlans,
      sampleRounds: samples,
      archivedAttempts: samples * monitoredPlans,
    },
    methodology: {
      percentile: "nearest-rank",
      candidatesCold:
        "first request after instrument metadata mutation, same process; not OS/process cold",
      candidatesWarm:
        "immediate second request with unchanged database; does not assume an application result cache",
      replay:
        "replayPlan from persisted verified synthetic bars through file-backed SQLite WAL/FULL transaction completion, including SQLite synchronization calls",
      audit:
        "read persisted decision_inputs, parse and auditDecisionInput; assert MATCH and no SQLite changes",
      setupExcluded:
        "login, fixture insertion, support-plan creation/versioning, risk activation, feedback and release",
    },
    candidates: { cold, warm },
    historicalReplay: { perPlan: replay, tenPlans: batch },
    readonlyAudit: {
      perPlan: summarize(auditPerPlan),
      tenPlans: summarize(auditBatch),
    },
    localTargets: {
      candidatesWarmP95AtMost2000ms: warm.p95Ms <= 2000,
      tenHistoricalPlansP95AtMost5000ms: batch.p95Ms <= 5000,
    },
    upstream: {
      measured: false,
      latencyMs: null,
      timeoutCount: null,
      failureCount: null,
    },
    limits: [
      "All instruments, market bars and attempts are synthetic; no provider credentials or external requests.",
      "Single process, serial requests and temporary file-backed SQLite with WAL/FULL; includes configured database synchronization calls but not a physical power-loss/durability proof or a production-disk benchmark.",
      "Socket/network transport, browser rendering, concurrent production load and provider latency are not measured.",
      "Cold timings invalidate application results only; JIT and operating-system caches can remain warm.",
      "Historical replay throughput does not establish live receipt-to-alert latency or upstream continuity.",
      "No live capability, production readiness or trading profitability claim.",
    ],
  };
} finally {
  try {
    await appToClose?.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(report, null, 2));
