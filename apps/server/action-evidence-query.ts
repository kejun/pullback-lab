import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  EvidenceChange,
  EvidenceDetail,
  EvidenceDocument,
  EvidenceDocumentContent,
  EvidenceHistory,
  EvidenceVersion,
} from "../../packages/contracts/action-evidence.js";
import type { ActionEvidenceSnapshot } from "../../packages/market-data/action-evidence.js";
import { ApiError, type Store } from "./store.js";

export const EVIDENCE_PAGE_SIZE = 20;
const params = z.object({
  id: z.string().min(1).max(160),
  version: z.string().regex(/^action-evidence-v1:[a-f0-9]{64}$/),
});
const query = z
  .object({
    before: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .optional(),
  })
  .strict();
const missing = () =>
  new ApiError(
    404,
    "ACTION_EVIDENCE_NOT_FOUND",
    "找不到该标的的证据版本或原文",
  );

function read(
  store: Store,
  instrumentId: string,
  version: string,
): ActionEvidenceSnapshot {
  const row = store.db
    .prepare(
      `SELECT sequence, recorded_at, manifest_json
    FROM corporate_action_snapshots WHERE instrument_id=? AND version=?`,
    )
    .get(instrumentId, version) as
    | { sequence: number; recorded_at: number; manifest_json: string }
    | undefined;
  if (!row) throw missing();
  return {
    sequence: row.sequence,
    recordedAt: row.recorded_at,
    instrumentId,
    version,
    manifest: JSON.parse(row.manifest_json),
  };
}
const summary = (s: ActionEvidenceSnapshot): EvidenceVersion => ({
  sequence: s.sequence,
  version: s.version,
  recordedAt: s.recordedAt,
  source: s.manifest.source,
  coverage: s.manifest.coverage,
  actionCount: s.manifest.actions.length,
  documentCount: s.manifest.documents.length,
});
const documents = (s: ActionEvidenceSnapshot): EvidenceDocument[] =>
  s.manifest.documents.map(({ content, ...d }) => ({
    ...d,
    bytes: Buffer.byteLength(content, "utf8"),
  }));
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function changes<T extends { id: string }>(
  before: T[],
  after: T[],
): EvidenceChange<T>[] {
  const old = new Map(before.map((x) => [x.id, x]));
  const next = new Map(after.map((x) => [x.id, x]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((id) => {
    const a = old.get(id) ?? null,
      b = next.get(id) ?? null;
    return equal(a, b) ? [] : [{ id, before: a, after: b }];
  });
}

/** Authenticated GET only. List queries never transfer stored document bodies to JS. */
export function registerActionEvidenceRoutes(
  app: FastifyInstance,
  store: Store,
) {
  const base = "/api/instruments/:id/action-evidence";
  app.get(base, async (request, reply): Promise<EvidenceHistory> => {
    reply.header("Cache-Control", "no-store");
    const { id } = params.pick({ id: true }).parse(request.params);
    const { before } = query.parse(request.query);
    store.instrument(id);
    const rows = store.db
      .prepare(
        `SELECT sequence, version, recorded_at AS recordedAt,
      json_extract(manifest_json,'$.source') AS source,
      json_extract(manifest_json,'$.coverage') AS coverage,
      json_array_length(manifest_json,'$.actions') AS actionCount,
      json_array_length(manifest_json,'$.documents') AS documentCount
      FROM corporate_action_snapshots WHERE instrument_id=? AND sequence<?
      ORDER BY sequence DESC LIMIT ?`,
      )
      .all(
        id,
        before ?? Number.MAX_SAFE_INTEGER,
        EVIDENCE_PAGE_SIZE + 1,
      ) as (Omit<EvidenceVersion, "coverage"> & { coverage: string })[];
    const more = rows.length > EVIDENCE_PAGE_SIZE;
    const versions = rows
      .slice(0, EVIDENCE_PAGE_SIZE)
      .map((r) => ({ ...r, coverage: JSON.parse(r.coverage) }));
    return {
      instrumentId: id,
      versions,
      nextBefore: more ? versions.at(-1)!.sequence : null,
      liveEligible: false,
    };
  });
  app.get(
    `${base}/:version`,
    async (request, reply): Promise<EvidenceDetail> => {
      reply.header("Cache-Control", "no-store");
      const { id, version } = params.parse(request.params);
      store.instrument(id);
      const selected = read(store, id, version);
      const previousRow = store.db
        .prepare(
          `SELECT version FROM corporate_action_snapshots
      WHERE instrument_id=? AND sequence<? ORDER BY sequence DESC LIMIT 1`,
        )
        .get(id, selected.sequence) as { version: string } | undefined;
      const previous = previousRow
        ? read(store, id, previousRow.version)
        : null;
      const current = store.db
        .prepare(
          `SELECT version FROM corporate_action_snapshots
      WHERE instrument_id=? ORDER BY sequence DESC LIMIT 1`,
        )
        .get(id) as { version: string };
      return {
        ...summary(selected),
        instrumentId: id,
        currentVersion: current.version,
        review: selected.manifest.review,
        actions: selected.manifest.actions,
        documents: documents(selected),
        removedActionIds: selected.manifest.removedActionIds,
        liveEligible: false,
        comparison: previous
          ? {
              previous: {
                ...summary(previous),
                review: previous.manifest.review,
              },
              sourceChanged: !equal(
                previous.manifest.source,
                selected.manifest.source,
              ),
              coverageChanged: !equal(
                previous.manifest.coverage,
                selected.manifest.coverage,
              ),
              reviewChanged: !equal(
                previous.manifest.review,
                selected.manifest.review,
              ),
              actions: changes(
                previous.manifest.actions,
                selected.manifest.actions,
              ),
              documents: changes(documents(previous), documents(selected)),
            }
          : null,
      };
    },
  );
  app.get(
    `${base}/:version/documents/:documentId`,
    async (request, reply): Promise<EvidenceDocumentContent> => {
      reply.header("Cache-Control", "no-store");
      const { id, version, documentId } = params
        .extend({ documentId: z.string().min(1).max(160) })
        .parse(request.params);
      store.instrument(id);
      const selected = read(store, id, version);
      const document = selected.manifest.documents.find(
        (d) => d.id === documentId,
      );
      if (!document) throw missing();
      return {
        ...document,
        bytes: Buffer.byteLength(document.content, "utf8"),
        instrumentId: id,
        version,
      };
    },
  );
}
