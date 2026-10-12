import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Bar } from "../contracts/index.js";
import {
  actionContent,
  adjustForSplits,
  type AdjustmentDataset,
} from "./adjustments.js";

const at = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
const text = z.string().trim().min(1).max(500);
const decimal = z
  .string()
  .regex(/^\d{1,30}(\.\d{1,20})?$/)
  .refine((value) => /[1-9]/.test(value));
const documentIds = z.array(id).min(1).max(20);
const action = z
  .object({
    id,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(["SPLIT", "CASH_DIVIDEND"]),
    effectiveAt: at,
    publishedAt: at,
    sharesAfter: decimal.optional(),
    sharesBefore: decimal.optional(),
    documentIds,
  })
  .strict()
  .refine((a) =>
    a.kind === "SPLIT"
      ? a.sharesAfter !== undefined && a.sharesBefore !== undefined
      : a.sharesAfter === undefined && a.sharesBefore === undefined,
  );
export const actionManifestSchema = z
  .object({
    schema: z.literal("pullback-lab-actions-v1"),
    instrumentId: id,
    market: z.enum(["US", "CN"]),
    expectedVersion: z
      .string()
      .regex(/^action-evidence-v1:[a-f0-9]{64}$/)
      .nullable(),
    source: text,
    coverage: z
      .object({
        from: at,
        through: at,
        status: z.enum(["COMPLETE", "UNKNOWN"]),
        documentIds,
        reason: text,
      })
      .strict(),
    actions: z.array(action).max(500),
    removedActionIds: z.array(id).max(500),
    review: z.object({ reviewer: text, confirmed: z.literal(true) }).strict(),
    documents: z
      .array(
        z
          .object({
            id,
            url: z
              .string()
              .max(2000)
              .refine((value) => {
                try {
                  const u = new URL(value);
                  return u.protocol === "https:" && !u.username && !u.password;
                } catch {
                  return false;
                }
              }),
            publishedAt: at,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            content: z.string().min(1).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type ActionManifest = z.infer<typeof actionManifestSchema>;
export class ActionEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new ActionEvidenceError(code);
};
export const evidenceHash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const order = <T extends { id: string }>(items: T[]) =>
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const unique = (items: string[]) => new Set(items).size === items.length;

/** Content hashes establish byte identity; the recorded human review establishes the source assertion. */
export function parseActionManifest(
  input: unknown,
  now: number,
): ActionManifest {
  if (!Number.isSafeInteger(now) || now < 0) fail("IMPORT_TIME_INVALID");
  const parsed = actionManifestSchema.safeParse(input);
  if (!parsed.success) fail("ACTION_MANIFEST_INVALID");
  const m = parsed.data!;
  if (
    m.coverage.from > m.coverage.through ||
    m.coverage.through > now ||
    !unique(m.actions.map((a) => a.id)) ||
    !unique(m.documents.map((d) => d.id)) ||
    !unique(m.removedActionIds)
  )
    fail("ACTION_MANIFEST_INVALID");
  if (
    m.documents.reduce((sum, d) => sum + Buffer.byteLength(d.content), 0) >
    2_000_000
  )
    fail("EVIDENCE_SIZE_LIMIT");
  const docs = new Map(m.documents.map((d) => [d.id, d]));
  for (const d of m.documents) {
    if (d.publishedAt > now) fail("EVIDENCE_NOT_YET_PUBLISHED");
    if (evidenceHash(d.content) !== d.sha256) fail("EVIDENCE_HASH_MISMATCH");
  }
  for (const item of [m.coverage, ...m.actions]) {
    if (!unique(item.documentIds) || item.documentIds.some((d) => !docs.has(d)))
      fail("EVIDENCE_REFERENCE_INVALID");
    item.documentIds.sort();
  }
  for (const a of m.actions) {
    if (a.publishedAt > now) fail("ACTION_NOT_YET_PUBLISHED");
    if (a.effectiveAt < m.coverage.from || a.effectiveAt > m.coverage.through)
      fail("ACTION_OUTSIDE_COVERAGE");
    // Source documents must have existed when this asserted revision was published.
    if (a.documentIds.some((d) => docs.get(d)!.publishedAt > a.publishedAt))
      fail("ACTION_PUBLICATION_MISMATCH");
  }
  order(m.actions);
  order(m.documents);
  m.removedActionIds.sort();
  return m;
}

export const ACTION_EVIDENCE_SCHEMA_SQL = `
CREATE TABLE corporate_action_snapshots(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL UNIQUE,
  instrument_id TEXT NOT NULL REFERENCES instruments(id), recorded_at INTEGER NOT NULL,
  manifest_json TEXT NOT NULL);
CREATE INDEX corporate_action_cutoff ON corporate_action_snapshots(instrument_id,recorded_at,sequence);
CREATE TABLE corporate_action_facts(
  instrument_id TEXT NOT NULL REFERENCES instruments(id), action_id TEXT NOT NULL,
  revision INTEGER NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY(instrument_id,action_id,revision));
${["corporate_action_snapshots", "corporate_action_facts"]
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ACTION_EVIDENCE'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ACTION_EVIDENCE'); END;
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${
      table === "corporate_action_snapshots"
        ? "sequence=NEW.sequence OR version=NEW.version"
        : "instrument_id=NEW.instrument_id AND action_id=NEW.action_id AND revision=NEW.revision"
    })
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ACTION_EVIDENCE'); END;`,
  )
  .join("\n")}
`;
export interface ActionEvidenceSnapshot {
  sequence: number;
  version: string;
  instrumentId: string;
  recordedAt: number;
  manifest: ActionManifest;
}
interface Row {
  sequence: number;
  version: string;
  instrument_id: string;
  recorded_at: number;
  manifest_json: string;
}
const snapshot = (row: Row): ActionEvidenceSnapshot => ({
  sequence: row.sequence,
  version: row.version,
  instrumentId: row.instrument_id,
  recordedAt: row.recorded_at,
  manifest: JSON.parse(row.manifest_json),
});
export interface ImportResult {
  status: "PREVIEW" | "IMPORTED" | "DUPLICATE";
  version: string;
  currentVersion: string | null;
  recordedAt: number | null;
  actionCount: number;
  removedActionIds: string[];
  coverageStatus: "COMPLETE" | "UNKNOWN";
  liveEligible: false;
}

/** No DDL here: application migrations own schema changes, and preview can use a read-only connection. */
export class ActionEvidenceRepository {
  constructor(private readonly db: Database.Database) {}
  latest(
    instrumentId: string,
    asOf = Number.MAX_SAFE_INTEGER,
  ): ActionEvidenceSnapshot | null {
    if (!Number.isSafeInteger(asOf) || asOf < 0)
      fail("ADJUSTMENT_CUTOFF_INVALID");
    const row = this.db
      .prepare(
        `SELECT * FROM corporate_action_snapshots
      WHERE instrument_id=? AND recorded_at<=? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(instrumentId, asOf) as Row | undefined;
    return row ? snapshot(row) : null;
  }
  private check(m: ActionManifest, now: number) {
    const instrument = this.db
      .prepare("SELECT json FROM instruments WHERE id=?")
      .get(m.instrumentId) as { json: string } | undefined;
    if (!instrument) fail("ACTION_INSTRUMENT_UNKNOWN");
    const decoded = JSON.parse(instrument!.json);
    if ((decoded.instrument ?? decoded).market !== m.market)
      fail("ACTION_MARKET_MISMATCH");
    const manifestJson = JSON.stringify(m),
      version = `action-evidence-v1:${evidenceHash(manifestJson)}`;
    const existing = this.db
      .prepare("SELECT * FROM corporate_action_snapshots WHERE version=?")
      .get(version) as Row | undefined;
    const prior = this.latest(m.instrumentId);
    if (existing) return { version, manifestJson, prior, existing };
    if ((prior?.version ?? null) !== m.expectedVersion)
      fail("ACTION_VERSION_CONFLICT");
    if (prior && now < prior.recordedAt) fail("IMPORT_CLOCK_REGRESSION");
    const removed = (prior?.manifest.actions ?? [])
      .filter((a) => !m.actions.some((b) => a.id === b.id))
      .map((a) => a.id)
      .sort();
    if (JSON.stringify(removed) !== JSON.stringify(m.removedActionIds))
      fail("ACTION_REMOVAL_REQUIRES_ACKNOWLEDGEMENT");
    for (const a of m.actions) {
      const fact = this.db
        .prepare(
          `SELECT revision,content FROM corporate_action_facts
        WHERE instrument_id=? AND action_id=? ORDER BY revision DESC LIMIT 1`,
        )
        .get(m.instrumentId, a.id) as
        { revision: number; content: string } | undefined;
      const content = actionContent({
        ...a,
        source: m.source,
        receivedAt: now,
      });
      if (
        fact &&
        (a.revision < fact.revision ||
          (a.revision === fact.revision && content !== fact.content))
      )
        fail("ACTION_REVISION_CONFLICT");
    }
    return { version, manifestJson, prior, existing };
  }
  import(
    input: unknown,
    now: number,
    options: {
      dryRun?: boolean;
      onChanged?: (instrumentId: string, version: string) => void;
    } = {},
  ): ImportResult {
    const m = parseActionManifest(input, now);
    const work = (): ImportResult => {
      const checked = this.check(m, now);
      const result: ImportResult = {
        status: checked.existing
          ? "DUPLICATE"
          : options.dryRun
            ? "PREVIEW"
            : "IMPORTED",
        version: checked.version,
        currentVersion: checked.prior?.version ?? null,
        recordedAt: checked.existing?.recorded_at ?? null,
        actionCount: m.actions.length,
        removedActionIds: m.removedActionIds,
        coverageStatus: m.coverage.status,
        liveEligible: false,
      };
      if (checked.existing || options.dryRun) return result;
      for (const a of m.actions) {
        const found = this.db
          .prepare(
            `SELECT 1 FROM corporate_action_facts WHERE instrument_id=? AND action_id=? AND revision=?`,
          )
          .get(m.instrumentId, a.id, a.revision);
        if (!found)
          this.db
            .prepare("INSERT INTO corporate_action_facts VALUES(?,?,?,?)")
            .run(
              m.instrumentId,
              a.id,
              a.revision,
              actionContent({ ...a, source: m.source, receivedAt: now }),
            );
      }
      this.db
        .prepare(
          `INSERT INTO corporate_action_snapshots(version,instrument_id,recorded_at,manifest_json) VALUES(?,?,?,?)`,
        )
        .run(checked.version, m.instrumentId, now, checked.manifestJson);
      options.onChanged?.(m.instrumentId, checked.version);
      return { ...result, currentVersion: checked.version, recordedAt: now };
    };
    // Preview uses a consistent read snapshot and cannot acquire a write transaction.
    return options.dryRun
      ? this.db.transaction(work)()
      : this.db.transaction(work).immediate();
  }
  dataset(
    instrumentId: string,
    asOf: number,
    evidenceVersion?: string,
  ): AdjustmentDataset | null {
    if (!Number.isSafeInteger(asOf) || asOf < 0)
      fail("ADJUSTMENT_CUTOFF_INVALID");
    const row =
      evidenceVersion === undefined
        ? undefined
        : (this.db
            .prepare(
              `SELECT * FROM corporate_action_snapshots
      WHERE instrument_id=? AND version=? AND recorded_at<=?`,
            )
            .get(instrumentId, evidenceVersion, asOf) as Row | undefined);
    const s =
      evidenceVersion === undefined
        ? this.latest(instrumentId, asOf)
        : row
          ? snapshot(row)
          : null;
    if (!s) return null;
    return {
      coverage: {
        from: s.manifest.coverage.from,
        through: s.manifest.coverage.through,
        knownAt: s.recordedAt,
        verified: s.manifest.coverage.status === "COMPLETE",
        source: s.manifest.source,
        version: s.version,
      },
      actions: s.manifest.actions.map(({ documentIds: _docs, ...a }) => ({
        ...a,
        source: s.manifest.source,
        receivedAt: s.recordedAt,
      })),
    };
  }
  adjust(
    instrumentId: string,
    bars: readonly Bar[],
    asOf: number,
    basisAt: number,
    evidenceVersion?: string,
  ) {
    const dataset = this.dataset(instrumentId, asOf, evidenceVersion);
    return dataset
      ? adjustForSplits(bars, dataset, asOf, basisAt)
      : {
          ok: false as const,
          bars: [] as [],
          reason: "CORPORATE_ACTION_COVERAGE_UNKNOWN",
        };
  }
}
