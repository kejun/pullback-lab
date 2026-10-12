import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { NormalizedBar } from "./normalize.js";
export type IngestResult = {
  status: "INSERTED" | "DUPLICATE" | "REVISION" | "CONFLICT";
  ingestSequence: number;
  invalidatesActivePlans: boolean;
};
function identity(b: NormalizedBar): string {
  return `${b.source}:${b.instrumentId}:${b.period}:${b.sessionId}:${b.start}`;
}
function hash(b: NormalizedBar): string {
  // Arrival time is evidence, not provider payload. Identical repeated frames may arrive later.
  const { receivedAt, historical, ...payload } = b;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
/** Separate immutable raw receipts from accepted revisions. Caller wraps ingest + plan pause in one transaction. */
export class BarRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS market_raw_inputs(
      ingest_sequence INTEGER PRIMARY KEY AUTOINCREMENT,logical_key TEXT NOT NULL,provider_revision TEXT NOT NULL,
      received_at INTEGER NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS market_bar_revisions(
      logical_key TEXT NOT NULL,provider_revision TEXT NOT NULL,payload_hash TEXT NOT NULL,ingest_sequence INTEGER NOT NULL,
      PRIMARY KEY(logical_key,provider_revision),FOREIGN KEY(ingest_sequence) REFERENCES market_raw_inputs(ingest_sequence));
      CREATE INDEX IF NOT EXISTS market_raw_cutoff ON market_raw_inputs(received_at,ingest_sequence);`);
  }
  ingest(bar: NormalizedBar): IngestResult {
    return this.db.transaction(() => {
      const key = identity(bar),
        digest = hash(bar);
      const prior = this.db
        .prepare(
          "SELECT payload_hash,ingest_sequence FROM market_bar_revisions WHERE logical_key=? AND provider_revision=?",
        )
        .get(key, bar.revision) as
        { payload_hash: string; ingest_sequence: number } | undefined;
      const other = this.db
        .prepare(
          "SELECT 1 FROM market_bar_revisions WHERE logical_key=? LIMIT 1",
        )
        .get(key);
      const status: IngestResult["status"] = prior
        ? prior.payload_hash === digest
          ? "DUPLICATE"
          : "CONFLICT"
        : other
          ? "REVISION"
          : "INSERTED";
      const result = this.db
        .prepare(
          "INSERT INTO market_raw_inputs(logical_key,provider_revision,received_at,payload_hash,payload_json,status) VALUES(?,?,?,?,?,?)",
        )
        .run(
          key,
          bar.revision,
          bar.receivedAt,
          digest,
          JSON.stringify(bar),
          status,
        );
      const sequence = Number(result.lastInsertRowid);
      if (!prior)
        this.db
          .prepare("INSERT INTO market_bar_revisions VALUES(?,?,?,?)")
          .run(key, bar.revision, digest, sequence);
      return {
        status,
        ingestSequence: sequence,
        invalidatesActivePlans: status === "REVISION" || status === "CONFLICT",
      };
    })();
  }
  /** Decisions store these stable IDs; later corrections never rewrite their inputs. */
  readEvidence(sequences: readonly number[]): NormalizedBar[] {
    return sequences.map((id) => {
      const row = this.db
        .prepare(
          "SELECT payload_json FROM market_raw_inputs WHERE ingest_sequence=?",
        )
        .get(id) as { payload_json: string } | undefined;
      if (!row) throw new Error("MISSING_INPUT_EVIDENCE");
      return JSON.parse(row.payload_json) as NormalizedBar;
    });
  }
  receiptsKnownAt(
    asOf: number,
  ): Array<{ sequence: number; status: string; bar: NormalizedBar }> {
    const rows = this.db
      .prepare(
        "SELECT ingest_sequence,status,payload_json FROM market_raw_inputs WHERE received_at<=? ORDER BY ingest_sequence",
      )
      .all(asOf) as Array<{
      ingest_sequence: number;
      status: string;
      payload_json: string;
    }>;
    return rows.map((x) => ({
      sequence: x.ingest_sequence,
      status: x.status,
      bar: JSON.parse(x.payload_json),
    }));
  }
}
