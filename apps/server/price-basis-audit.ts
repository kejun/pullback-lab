import type Database from "better-sqlite3";
import { ActionEvidenceRepository } from "../../packages/market-data/action-evidence.js";
import {
  auditPriceBasis,
  basisDigest,
  PriceBasisAuditError,
  priceBasisRequestSchema,
  PRICE_BASIS_AUDIT_VERSION,
} from "../../packages/market-data/price-basis-audit.js";
import type { NormalizedBar } from "../../packages/market-data/normalize.js";

/** Read one SQLite snapshot, without constructing Store/BarRepository (which perform DDL). */
export function readPriceBasisAudit(db: Database.Database, input: unknown) {
  const parsed = priceBasisRequestSchema.safeParse(input);
  if (!parsed.success) throw new PriceBasisAuditError("AUDIT_REQUEST_INVALID");
  const request = parsed.data;
  return db.transaction(() => {
    const unknown = (reason: string) => ({
      status: "UNKNOWN" as const,
      scope: "SELECTED_WINDOWS" as const,
      reason,
      liveEligible: false as const,
      bars: [],
    });
    const selected = [] as Array<{
      sequence: number;
      hash: string;
      bar: NormalizedBar;
    }>;
    const rowQuery = db.prepare(
      "SELECT * FROM market_raw_inputs WHERE ingest_sequence=?",
    );
    const latestQuery = db.prepare(
      "SELECT payload_hash FROM market_raw_inputs WHERE logical_key=? AND ingest_sequence<=? AND received_at<=? AND status IN ('INSERTED','REVISION') ORDER BY ingest_sequence DESC LIMIT 1",
    );
    const conflictQuery = db.prepare(
      "SELECT 1 FROM market_raw_inputs WHERE logical_key=? AND ingest_sequence<=? AND received_at<=? AND status='CONFLICT' LIMIT 1",
    );
    let problem: string | undefined;
    const max = db
      .prepare("SELECT MAX(ingest_sequence) n FROM market_raw_inputs")
      .get() as { n: number | null };
    if (request.receiptWatermark > (max.n ?? 0))
      problem = "AUDIT_WATERMARK_UNKNOWN";
    const instrumentRow = db
      .prepare("SELECT json FROM instruments WHERE id=?")
      .get(request.instrumentId) as { json: string } | undefined;
    const instrument = instrumentRow ? JSON.parse(instrumentRow.json) : null;
    if (
      !instrument ||
      (instrument.instrument ?? instrument).market !== request.market
    )
      problem = "AUDIT_INSTRUMENT_UNKNOWN";
    for (const sequence of [...request.sequences].sort((a, b) => a - b)) {
      const row = rowQuery.get(sequence) as
        | {
            logical_key: string;
            status: string;
            received_at: number;
            payload_hash: string;
            payload_json: string;
          }
        | undefined;
      if (
        !row ||
        !["INSERTED", "REVISION"].includes(row.status) ||
        row.received_at > request.asOf
      ) {
        problem ??= "AUDIT_RECEIPT_UNAVAILABLE";
        continue;
      }
      const bar = JSON.parse(row.payload_json) as NormalizedBar;
      const { receivedAt, historical: _history, ...payload } = bar;
      if (
        receivedAt !== row.received_at ||
        basisDigest(payload) !== row.payload_hash
      ) {
        problem ??= "AUDIT_RECEIPT_HASH_MISMATCH";
        continue;
      }
      const args = [row.logical_key, request.receiptWatermark, request.asOf];
      if (conflictQuery.get(...args)) problem ??= "AUDIT_RECEIPT_CONFLICT";
      const latest = latestQuery.get(...args) as
        { payload_hash: string } | undefined;
      if (latest?.payload_hash !== row.payload_hash)
        problem ??= "AUDIT_RECEIPT_SUPERSEDED";
      selected.push({ sequence, hash: row.payload_hash, bar });
    }
    const actions = new ActionEvidenceRepository(db);
    const dataset = actions.dataset(
      request.instrumentId,
      request.asOf,
      request.evidenceVersion,
    );
    const latestEvidence = actions.latest(request.instrumentId);
    const result = problem
      ? unknown(problem)
      : !dataset
        ? unknown("CORPORATE_ACTION_COVERAGE_UNKNOWN")
        : auditPriceBasis({
            ...request,
            dataset,
            bars: selected.map((s) => s.bar),
          });
    // Input order does not affect fingerprint. Explicit action version + receipt watermark resolve same-millisecond additions.
    const canonicalRequest = {
      ...request,
      sequences: [...request.sequences].sort((a, b) => a - b),
      calendarDays: [...request.calendarDays].sort((a, b) => {
        const left = JSON.stringify(a),
          right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    };
    return {
      schema: "pullback-lab-price-basis-report-v1",
      algorithmVersion: PRICE_BASIS_AUDIT_VERSION,
      request: canonicalRequest,
      inputHash: basisDigest({
        algorithm: PRICE_BASIS_AUDIT_VERSION,
        request: canonicalRequest,
        selected,
      }),
      currentEvidenceVersion: latestEvidence?.version ?? null,
      evidenceIsCurrent: latestEvidence?.version === request.evidenceVersion,
      ...result,
    };
  })();
}
