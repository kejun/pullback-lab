import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../apps/server/store.js";
import {
  DATABASE_MIGRATIONS,
  runMigrations,
} from "../apps/server/migrations.js";
import { backupBeforeMigration } from "../apps/server/backup-service.js";
import { readPriceBasisAudit } from "../apps/server/price-basis-audit.js";
import { acquireServiceLock } from "../apps/server/runtime-safety.js";
import { ActionEvidenceRepository } from "../packages/market-data/action-evidence.js";
import { BarRepository } from "../packages/market-data/ingestion.js";
import { priceBasisFixture } from "../packages/market-data/price-basis-fixture.js";
import { demoInstruments } from "../packages/market-data/fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup(schemaVersion = DATABASE_MIGRATIONS.length) {
  const f = priceBasisFixture(),
    dir = mkdtempSync(join(tmpdir(), "basis-audit-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite"),
    file = join(dir, "request.json"),
    db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  runMigrations(db, DATABASE_MIGRATIONS.slice(0, schemaVersion));
  db.prepare("INSERT INTO instruments VALUES(?,?)").run(
    f.instrumentId,
    JSON.stringify({
      instrument: demoInstruments[0],
      tags: [],
      note: "synthetic",
      manual: false,
    }),
  );
  const actions = new ActionEvidenceRepository(db),
    bars = new BarRepository(db);
  const imported = actions.import(f.manifest, f.asOf);
  const sequences = f.bars.map((b) => bars.ingest(b).ingestSequence);
  const request = {
    schema: "pullback-lab-price-basis-audit-v1",
    instrumentId: f.instrumentId,
    market: f.market,
    asOf: f.asOf,
    evidenceVersion: imported.version,
    receiptWatermark: Math.max(...sequences),
    sequences,
    targetDate: f.targetDate,
    calendarDays: f.calendarDays,
  };
  writeFileSync(file, JSON.stringify(request));
  db.close();
  const run = (args = [file], databasePath = path) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/audit-price-basis.ts", ...args],
      {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, PULLBACK_DB: databasePath },
        encoding: "utf8",
        timeout: 7000,
        maxBuffer: 500_000,
      },
    );
  return { f, dir, path, file, request, run };
}
describe("persisted cross-period audit and read-only CLI", () => {
  it("requires application migration of v6, preserves inputs and uses the receipt lookup index", async () => {
    const { path, request, run, dir } = setup(6);
    const before = readFileSync(path);
    expect(JSON.parse(run().stderr).code).toBe("AUDIT_SCHEMA_UPGRADE_REQUIRED");
    expect(readFileSync(path)).toEqual(before);
    await backupBeforeMigration(path, join(dir, "backups"));
    const store = new Store(path);
    try {
      expect(readPriceBasisAudit(store.db, request).status).toBe("CONSISTENT");
      const plan = store.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT payload_hash FROM market_raw_inputs WHERE logical_key=? AND ingest_sequence<=? AND received_at<=? AND status IN ('INSERTED','REVISION') ORDER BY ingest_sequence DESC LIMIT 1",
        )
        .all("test", 7, request.asOf);
      expect(JSON.stringify(plan)).toContain("market_raw_identity_sequence");
      expect(
        store.db.prepare("SELECT count(*) n FROM market_raw_inputs").get(),
      ).toEqual({ n: 7 });
      expect(
        new ActionEvidenceRepository(store.db).latest(request.instrumentId)
          ?.version,
      ).toBe(request.evidenceVersion);
    } finally {
      store.close();
    }
    expect(run().status).toBe(0);
  });
  it("reproduces frozen inputs through a read-only handle without changing any table", () => {
    const { path, request } = setup();
    const db = new Database(path, { readonly: true });
    db.pragma("query_only=ON");
    try {
      const before = db.prepare("SELECT total_changes() n").get();
      const report = readPriceBasisAudit(db, request);
      expect(report).toMatchObject({
        status: "CONSISTENT",
        liveEligible: false,
        evidenceIsCurrent: true,
        comparedWindows: 1,
      });
      expect(
        readPriceBasisAudit(db, {
          ...request,
          sequences: [...request.sequences].reverse(),
          calendarDays: [...request.calendarDays].reverse(),
        }),
      ).toEqual(report);
      expect(db.prepare("SELECT total_changes() n").get()).toEqual(before);
      expect(() => db.prepare("DELETE FROM sessions").run()).toThrow();
    } finally {
      db.close();
    }
  });
  it("runs while service lock is held and leaves closed database bytes unchanged", () => {
    const { path, run } = setup(),
      before = readFileSync(path),
      lock = acquireServiceLock(path);
    try {
      const result = run();
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe("CONSISTENT");
      expect(readFileSync(path)).toEqual(before);
    } finally {
      lock.release();
    }
  });
  it("retains an old report fingerprint after same-millisecond evidence and bar revisions", () => {
    const { path, request, f } = setup();
    const db = new Database(path);
    try {
      const before = readPriceBasisAudit(db, request),
        actions = new ActionEvidenceRepository(db),
        repo = new BarRepository(db);
      const next = structuredClone(f.manifest);
      next.expectedVersion = request.evidenceVersion;
      next.actions[0].revision = 2;
      next.actions[0].sharesAfter = "4";
      actions.import(next, f.asOf);
      const changed = {
        ...f.bars[1],
        revision: "2",
        close: "52",
        receivedAt: f.asOf,
      };
      const update = repo.ingest(changed);
      const after = readPriceBasisAudit(db, request);
      expect(after).toEqual({
        ...before,
        currentEvidenceVersion: actions.latest(f.instrumentId)!.version,
        evidenceIsCurrent: false,
      });
      expect(
        readPriceBasisAudit(db, {
          ...request,
          receiptWatermark: update.ingestSequence,
        }),
      ).toMatchObject({
        status: "UNKNOWN",
        reason: "AUDIT_RECEIPT_SUPERSEDED",
        bars: [],
      });
    } finally {
      db.close();
    }
  });
  it("rejects conflicts, future receipts, missing evidence and another instrument", () => {
    const { path, request, f } = setup(),
      db = new Database(path);
    try {
      const repo = new BarRepository(db);
      const conflict = repo.ingest({
        ...f.bars[1],
        close: "52",
        receivedAt: f.asOf,
      });
      expect(
        readPriceBasisAudit(db, {
          ...request,
          receiptWatermark: conflict.ingestSequence,
        }),
      ).toMatchObject({ reason: "AUDIT_RECEIPT_CONFLICT", bars: [] });
      expect(
        readPriceBasisAudit(db, { ...request, asOf: f.asOf - 1 }),
      ).toMatchObject({ reason: "CORPORATE_ACTION_COVERAGE_UNKNOWN" });
      expect(
        readPriceBasisAudit(db, { ...request, asOf: f.target.open }),
      ).toMatchObject({ reason: "AUDIT_RECEIPT_UNAVAILABLE" });
      expect(
        readPriceBasisAudit(db, { ...request, instrumentId: "OTHER.US" }),
      ).toMatchObject({ reason: "AUDIT_INSTRUMENT_UNKNOWN" });
      expect(
        readPriceBasisAudit(db, {
          ...request,
          evidenceVersion: "action-evidence-v1:" + "0".repeat(64),
        }),
      ).toMatchObject({ reason: "CORPORATE_ACTION_COVERAGE_UNKNOWN" });
      expect(
        readPriceBasisAudit(db, { ...request, receiptWatermark: 999999 }),
      ).toMatchObject({ reason: "AUDIT_WATERMARK_UNKNOWN" });
    } finally {
      db.close();
    }
  });
  it("distinguishes an inconclusive audit from invalid private input and never creates missing databases", () => {
    const { run, path, file, dir, request } = setup();
    writeFileSync(
      file,
      JSON.stringify({
        ...request,
        evidenceVersion: "action-evidence-v1:" + "0".repeat(64),
      }),
    );
    const unknown = run();
    expect(unknown.status).toBe(2);
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      status: "UNKNOWN",
      liveEligible: false,
    });
    const absent = join(dir, "missing.sqlite");
    expect(run([file], absent).status).toBe(1);
    expect(existsSync(absent)).toBe(false);
    writeFileSync(file, "private-not-json");
    const invalid = run();
    expect(invalid.status).toBe(1);
    expect(invalid.stderr + invalid.stdout).not.toContain("private-not-json");
    expect(invalid.stderr).not.toContain(path);
    expect(run([file, "--apply"]).status).toBe(1);
    writeFileSync(file, "x".repeat(2_000_001));
    expect(JSON.parse(run().stderr).code).toBe("AUDIT_INPUT_LIMIT");
    const link = join(dir, "link.json");
    symlinkSync(file, link);
    expect(run([link]).status).toBe(1);
  });
});
