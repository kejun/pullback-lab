import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../apps/server/store.js";
import { demoInstruments } from "./fixtures.js";
import {
  ActionEvidenceRepository,
  parseActionManifest,
} from "./action-evidence.js";
import {
  ACTION_TEST_NOW as now,
  actionTestBar as bar,
  actionTestManifest as manifest,
} from "./action-evidence-fixture.js";
import { adjustForSplits } from "./adjustments.js";

const stores: Store[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup(path?: string) {
  const store = new Store(path);
  stores.push(store);
  store.putInstrument({
    instrument: demoInstruments[0],
    tags: [],
    note: "synthetic",
    manual: false,
  });
  return { store, repo: new ActionEvidenceRepository(store.db) };
}
describe("immutable corporate action evidence", () => {
  it("uses frozen evidence versions to distinguish changes in the same millisecond", () => {
    const { repo } = setup(),
      m = manifest();
    const first = repo.import(m, now);
    const original = repo.adjust(
      m.instrumentId,
      [bar],
      now,
      3_000_000,
      first.version,
    );
    const second = structuredClone(m);
    second.expectedVersion = first.version;
    second.coverage.status = "UNKNOWN";
    repo.import(second, now);
    expect(repo.adjust(m.instrumentId, [bar], now, 3_000_000)).toMatchObject({
      ok: false,
    });
    expect(
      repo.adjust(m.instrumentId, [bar], now, 3_000_000, first.version),
    ).toEqual(original);
    expect(
      repo.adjust(m.instrumentId, [bar], now - 1, 3_000_000, first.version),
    ).toMatchObject({ ok: false });
    expect(repo.dataset("different-security", now, first.version)).toBeNull();
  });
  it("previews with zero writes; imports documents and retries without replacing receipt time", () => {
    const { store, repo } = setup(),
      m = manifest();
    const changes = store.db.prepare("SELECT total_changes() n").get();
    const preview = store.importActionEvidence(m, now, true);
    expect(preview).toMatchObject({
      status: "PREVIEW",
      recordedAt: null,
      liveEligible: false,
    });
    expect(store.db.prepare("SELECT total_changes() n").get()).toEqual(changes);
    const imported = store.importActionEvidence(m, now);
    expect(imported.version).toBe(preview.version);
    expect(store.importActionEvidence(m, now + 1)).toMatchObject({
      status: "DUPLICATE",
      recordedAt: now,
    });
    expect(repo.latest(m.instrumentId)!.manifest.documents).toEqual(
      m.documents,
    );
    expect(
      repo.adjust(m.instrumentId, [bar], now - 1, 3_000_000),
    ).toMatchObject({ ok: false });
    expect(repo.adjust(m.instrumentId, [bar], now, 3_000_000)).toMatchObject({
      ok: true,
      bars: [{ close: "55", volume: "40", turnover: "2200", raw: bar }],
    });
  });
  it("replays earlier receipts after a correction and prevents later UNKNOWN falling back to complete evidence", () => {
    const { repo } = setup(),
      m = manifest();
    const first = repo.import(m, now),
      original = repo.adjust(m.instrumentId, [bar], now, 3_000_000);
    const revised = structuredClone(m);
    revised.expectedVersion = first.version;
    revised.actions[0].revision = 2;
    revised.actions[0].sharesAfter = "3";
    const second = repo.import(revised, now + 100);
    expect(repo.adjust(m.instrumentId, [bar], now, 3_000_000)).toEqual(
      original,
    );
    expect(
      repo.adjust(m.instrumentId, [bar], now + 100, 3_000_000),
    ).toMatchObject({ ok: true, bars: [{ volume: "60" }] });
    const unknown = {
      ...revised,
      expectedVersion: second.version,
      coverage: { ...revised.coverage, status: "UNKNOWN" as const },
    };
    const third = repo.import(unknown, now + 200);
    expect(
      repo.adjust(m.instrumentId, [bar], now + 200, 3_000_000),
    ).toMatchObject({ ok: false, reason: "CORPORATE_ACTION_COVERAGE_UNKNOWN" });
    expect(repo.import(m, now + 300)).toMatchObject({
      status: "DUPLICATE",
      currentVersion: third.version,
    });
    expect(repo.latest(m.instrumentId)!.version).toBe(third.version);
  });
  it("requires current version, explicit removal acknowledgement and monotonic action revisions", () => {
    const { repo } = setup(),
      m = manifest();
    const first = repo.import(m, now);
    const stale = {
      ...m,
      review: { ...m.review, reviewer: "second reviewer" },
    };
    expect(() => repo.import(stale, now)).toThrow("ACTION_VERSION_CONFLICT");
    const changed = structuredClone(m);
    changed.expectedVersion = first.version;
    changed.actions[0].sharesAfter = "4";
    expect(() => repo.import(changed, now)).toThrow("ACTION_REVISION_CONFLICT");
    changed.actions = [];
    expect(() => repo.import(changed, now)).toThrow(
      "ACTION_REMOVAL_REQUIRES_ACKNOWLEDGEMENT",
    );
    changed.removedActionIds = ["split"];
    const removed = repo.import(changed, now + 1);
    expect(
      repo.adjust(m.instrumentId, [bar], now + 1, 3_000_000),
    ).toMatchObject({ ok: true, bars: [{ close: "110" }] });
    const revision = structuredClone(m);
    revision.expectedVersion = removed.version;
    revision.actions[0].revision = 2;
    revision.actions[0].sharesAfter = "3";
    const next = repo.import(revision, now + 2);
    expect(() =>
      repo.import({ ...m, expectedVersion: next.version }, now + 3),
    ).toThrow("ACTION_REVISION_CONFLICT");
    expect(() =>
      repo.import({ ...revision, expectedVersion: next.version }, now + 1),
    ).toThrow("IMPORT_CLOCK_REGRESSION");
  });
  it.each([
    [
      "hash",
      (m: ReturnType<typeof manifest>) => {
        m.documents[0].content += "changed";
      },
      "EVIDENCE_HASH_MISMATCH",
    ],
    [
      "reference",
      (m: ReturnType<typeof manifest>) => {
        m.actions[0].documentIds = ["missing"];
      },
      "EVIDENCE_REFERENCE_INVALID",
    ],
    [
      "duplicate action",
      (m: ReturnType<typeof manifest>) => {
        m.actions.push(m.actions[0]);
      },
      "ACTION_MANIFEST_INVALID",
    ],
    [
      "future coverage",
      (m: ReturnType<typeof manifest>) => {
        m.coverage.through = now + 1;
      },
      "ACTION_MANIFEST_INVALID",
    ],
    [
      "future document",
      (m: ReturnType<typeof manifest>) => {
        m.documents[0].publishedAt = now + 1;
      },
      "EVIDENCE_NOT_YET_PUBLISHED",
    ],
    [
      "future action",
      (m: ReturnType<typeof manifest>) => {
        m.actions[0].publishedAt = now + 1;
      },
      "ACTION_NOT_YET_PUBLISHED",
    ],
    [
      "coverage gap",
      (m: ReturnType<typeof manifest>) => {
        m.coverage.through = 1_000_000;
      },
      "ACTION_OUTSIDE_COVERAGE",
    ],
    [
      "publication",
      (m: ReturnType<typeof manifest>) => {
        m.actions[0].publishedAt = 0;
      },
      "ACTION_PUBLICATION_MISMATCH",
    ],
    [
      "market",
      (m: ReturnType<typeof manifest>) => {
        m.market = "CN";
      },
      "ACTION_MARKET_MISMATCH",
    ],
    [
      "unknown instrument",
      (m: ReturnType<typeof manifest>) => {
        m.instrumentId = "missing";
      },
      "ACTION_INSTRUMENT_UNKNOWN",
    ],
    [
      "dividend ratio",
      (m: ReturnType<typeof manifest>) => {
        m.actions[0].kind = "CASH_DIVIDEND";
      },
      "ACTION_MANIFEST_INVALID",
    ],
    [
      "zero ratio",
      (m: ReturnType<typeof manifest>) => {
        m.actions[0].sharesAfter = "0.00";
      },
      "ACTION_MANIFEST_INVALID",
    ],
  ])("rejects %s without partial writes", (_name, mutate, code) => {
    const { repo, store } = setup(),
      m = manifest();
    mutate(m);
    expect(() => repo.import(m, now)).toThrow(code);
    expect(
      store.db
        .prepare("SELECT COUNT(*) n FROM corporate_action_snapshots")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      store.db.prepare("SELECT COUNT(*) n FROM corporate_action_facts").get(),
    ).toEqual({ n: 0 });
  });
  it("does not accept user-supplied receipt times or unreviewed input", () => {
    expect(() =>
      parseActionManifest({ ...manifest(), recordedAt: 1 }, now),
    ).toThrow("ACTION_MANIFEST_INVALID");
    expect(() =>
      parseActionManifest(
        { ...manifest(), review: { reviewer: "x", confirmed: false } },
        now,
      ),
    ).toThrow("ACTION_MANIFEST_INVALID");
  });
  it("has stable hashes despite object and array ordering", () => {
    const { repo } = setup(),
      m = manifest();
    m.documents.push({ ...m.documents[0], id: "second" });
    const before = repo.import(m, now);
    const reordered = Object.fromEntries(Object.entries(m).reverse());
    (reordered.documents as unknown[]).reverse();
    expect(repo.import(reordered, now + 1)).toMatchObject({
      status: "DUPLICATE",
      version: before.version,
    });
  });
  it("rolls evidence and invalidation back together", () => {
    const { repo, store } = setup();
    expect(() =>
      repo.import(manifest(), now, {
        onChanged: () => {
          store.setSetting("should-rollback", "yes");
          throw new Error("pause failed");
        },
      }),
    ).toThrow("pause failed");
    expect(repo.latest(manifest().instrumentId)).toBeNull();
    expect(store.setting("should-rollback")).toBeNull();
    expect(
      store.db.prepare("SELECT COUNT(*) n FROM corporate_action_facts").get(),
    ).toEqual({ n: 0 });
  });
  it("survives file reopen, previews read-only and blocks separate-connection replacement", () => {
    const dir = mkdtempSync(join(tmpdir(), "action-evidence-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite"),
      { repo } = setup(path);
    const first = repo.import(manifest(), now);
    const db = new Database(path);
    try {
      db.pragma("recursive_triggers = OFF");
      for (const table of [
        "corporate_action_snapshots",
        "corporate_action_facts",
      ]) {
        expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(
          "IMMUTABLE_ACTION_EVIDENCE",
        );
        expect(() =>
          db.exec(`UPDATE ${table} SET instrument_id=instrument_id`),
        ).toThrow("IMMUTABLE_ACTION_EVIDENCE");
        expect(() =>
          db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),
        ).toThrow("IMMUTABLE_ACTION_EVIDENCE");
      }
    } finally {
      db.close();
    }
    const read = new Database(path, { readonly: true });
    try {
      const other = new ActionEvidenceRepository(read);
      expect(other.latest(manifest().instrumentId)!.version).toBe(
        first.version,
      );
      expect(
        other.import(
          { ...manifest(), expectedVersion: first.version },
          now + 1,
          { dryRun: true },
        ).status,
      ).toBe("PREVIEW");
    } finally {
      read.close();
    }
  });
});
describe("split adjustment fail-closed arithmetic", () => {
  it("bounds compounded factors before expanding decimal output", () => {
    const data = dataset(),
      a = data.actions[0];
    data.actions = Array.from({ length: 10 }, (_, i) => ({
      ...a,
      id: `split-${i}`,
      sharesAfter: "10000000000000000000000000000",
    }));
    expect(adjustForSplits([bar], data, now, 3_000_000)).toMatchObject({
      ok: false,
      reason: "ADJUSTMENT_FACTOR_OUT_OF_RANGE",
    });
  });
  function dataset() {
    const { repo } = setup();
    repo.import(manifest(), now);
    return repo.dataset(manifest().instrumentId, now)!;
  }
  it("handles a reverse split and ignores cash dividends without changing turnover", () => {
    const data = dataset();
    data.actions[0].sharesAfter = "1";
    data.actions[0].sharesBefore = "10";
    data.actions.push({
      id: "cash",
      revision: 1,
      kind: "CASH_DIVIDEND",
      effectiveAt: 2_100_000,
      publishedAt: 2_000_000,
      receivedAt: now,
      source: "synthetic",
    });
    expect(adjustForSplits([bar], data, now, 3_000_000)).toMatchObject({
      ok: true,
      ignoredCashDividends: 1,
      bars: [{ close: "1100", volume: "2", turnover: "2200" }],
    });
  });
  it("detects conflicts even when a newer revision appears first and deduplicates repeated receipts", () => {
    const data = dataset(),
      a = data.actions[0];
    data.actions = [{ ...a, revision: 2 }, a, { ...a, sharesAfter: "3" }];
    expect(adjustForSplits([bar], data, now, 3_000_000)).toMatchObject({
      ok: false,
      reason: "ACTION_REVISION_CONFLICT",
    });
    data.actions = [a, { ...a, receivedAt: now + 1 }];
    const once = adjustForSplits(
      [bar],
      { ...data, actions: [a] },
      now + 1,
      3_000_000,
    );
    expect(adjustForSplits([bar], data, now + 1, 3_000_000)).toEqual(once);
  });
  it.each([
    { close: "NaN" },
    { volume: "-1" },
    { low: "0" },
    { high: "80" },
    { final: false },
    { time: NaN },
  ])("blocks malformed raw bars %j without throwing", (override) => {
    expect(
      adjustForSplits([{ ...bar, ...override }], dataset(), now, 3_000_000),
    ).toMatchObject({ ok: false });
  });
  it("rejects invalid temporal coverage and action dates", () => {
    const data = dataset();
    data.coverage.knownAt = NaN;
    expect(adjustForSplits([bar], data, now, 3_000_000)).toMatchObject({
      ok: false,
    });
    data.coverage.knownAt = now;
    data.actions[0].effectiveAt = NaN;
    expect(adjustForSplits([bar], data, now, 3_000_000)).toMatchObject({
      ok: false,
      reason: "ACTION_PROVENANCE_INVALID",
    });
  });
});
