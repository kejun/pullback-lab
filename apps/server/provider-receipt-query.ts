import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  ProviderReceiptDetail,
  ProviderReceiptPage,
  ProviderReceiptSummary,
  ReceiptPayload,
  ReceiptScope,
} from "../../packages/contracts/provider-receipts.js";
import {
  RECEIPT_PERIOD_SQL,
  RECEIPT_SYMBOL_SQL,
} from "./provider-receipt-schema.js";
import { ApiError, type Store } from "./store.js";

export const RECEIPT_PAGE_SIZE = 20;
export const RECEIPT_PAYLOAD_MAX_BYTES = 65_536;
const positive = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const scope = z.enum(["1D", "1m", "5m", "unknown"]);
const params = z.object({ id: z.string().min(1).max(160) });
const token = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);
const checkpointSchema = z
  .object({
    v: z.literal(1),
    id: z.string().min(1).max(160),
    period: scope,
    epoch: z.string().min(1).max(80),
    through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
const invalid = () =>
  new ApiError(400, "INVALID_RECEIPT_CURSOR", "回执查询条件无效");
const expired = () =>
  new ApiError(
    409,
    "RECEIPT_SNAPSHOT_EXPIRED",
    "存档已恢复或重置，请重新读取回执",
  );
const missing = () =>
  new ApiError(404, "PROVIDER_RECEIPT_NOT_FOUND", "找不到该范围内的回执");
const fields = `sequence,epoch,source,requested_period AS requestedPeriod,
  received_at AS receivedAt,observed_at AS observedAt,provider_timestamp AS providerTimestamp,
  status,reason,payload_hash AS payloadHash,length(CAST(payload_json AS BLOB)) AS payloadBytes`;
const periodValue = (period: ReceiptScope) =>
  period === "unknown" ? null : period;

function checkpoint(
  store: Store,
  id: string,
  period: ReceiptScope,
  encoded?: string,
): Checkpoint {
  const epoch = store.setting("event_feed_epoch");
  if (!epoch) throw expired();
  const max = (
    store.db
      .prepare(
        `SELECT coalesce(max(sequence),0) n FROM market_provider_receipts
    WHERE instrument_id=? AND requested_period IS ?`,
      )
      .get(id, periodValue(period)) as { n: number }
  ).n;
  if (!encoded) return { v: 1, id, period, epoch, through: max };
  let value: Checkpoint;
  try {
    value = checkpointSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    throw invalid();
  }
  if (value.id !== id || value.period !== period) throw invalid();
  if (value.epoch !== epoch || value.through > max) throw expired();
  return value;
}
const encode = (value: Checkpoint) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function readPayload(store: Store, sequence: number): ReceiptPayload {
  const row = store.db
    .prepare(
      `SELECT ${fields},
    CASE WHEN length(CAST(payload_json AS BLOB))<=? THEN payload_json END AS payloadJson
    FROM market_provider_receipts WHERE sequence=?`,
    )
    .get(RECEIPT_PAYLOAD_MAX_BYTES, sequence) as ProviderReceiptSummary & {
    payloadJson: string | null;
  };
  if (row.payloadJson === null)
    return { ...row, integrity: "TOO_LARGE", computedHash: null };
  try {
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw Error("object required");
    const { receivedAt: _receipt, ...payload } = parsed as Record<
      string,
      unknown
    >;
    const computedHash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    return {
      ...row,
      computedHash,
      integrity: computedHash === row.payloadHash ? "MATCH" : "MISMATCH",
    };
  } catch {
    return { ...row, integrity: "INVALID_JSON", computedHash: null };
  }
}

function compare(
  store: Store,
  selected: ReceiptPayload,
): Pick<ProviderReceiptDetail, "previous" | "comparison" | "changes"> {
  const unavailable = {
    previous: null,
    comparison: "UNAVAILABLE",
    changes: [],
  } as const;
  if (selected.integrity !== "MATCH") return { ...unavailable, changes: [] };
  const current = JSON.parse(selected.payloadJson!) as Record<string, unknown>;
  if (
    typeof current.symbol !== "string" ||
    typeof current.period !== "string" ||
    !["1D", "1m", "5m"].includes(current.period) ||
    current.timestamp !== selected.providerTimestamp
  )
    return { ...unavailable, changes: [] };
  const previousRow = store.db
    .prepare(`SELECT sequence FROM market_provider_receipts
    WHERE instrument_id=? AND source=? AND ${RECEIPT_SYMBOL_SQL}=? AND ${RECEIPT_PERIOD_SQL}=?
    AND provider_timestamp=? AND sequence<? ORDER BY sequence DESC LIMIT 1`);
  // Instrument is taken from the selected immutable row, never from a payload claim.
  const { instrumentId } = store.db
    .prepare(
      "SELECT instrument_id AS instrumentId FROM market_provider_receipts WHERE sequence=?",
    )
    .get(selected.sequence) as { instrumentId: string };
  const prior = previousRow.get(
    instrumentId,
    selected.source,
    current.symbol,
    current.period,
    selected.providerTimestamp,
    selected.sequence,
  ) as { sequence: number } | undefined;
  if (!prior) return { previous: null, comparison: "FIRST_SEEN", changes: [] };
  const previous = readPayload(store, prior.sequence);
  if (previous.integrity !== "MATCH")
    return { previous, comparison: "UNAVAILABLE", changes: [] };
  const old = JSON.parse(previous.payloadJson!) as Record<string, unknown>;
  if (old.timestamp !== selected.providerTimestamp)
    return { previous, comparison: "UNAVAILABLE", changes: [] };
  const changes = [...new Set([...Object.keys(old), ...Object.keys(current)])]
    .sort()
    .filter(
      (key) =>
        key !== "receivedAt" &&
        JSON.stringify(old[key]) !== JSON.stringify(current[key]),
    )
    .map((field) => ({
      field,
      before: old[field] ?? null,
      after: current[field] ?? null,
    }));
  return {
    previous,
    comparison: changes.length ? "CHANGED" : "UNCHANGED",
    changes,
  };
}

/** Reads only the existing archive. Authentication and no-store are installed by createApp. */
export function registerProviderReceiptRoutes(
  app: FastifyInstance,
  store: Store,
) {
  const base = "/api/instruments/:id/provider-receipts";
  app.get(base, async (request): Promise<ProviderReceiptPage> => {
    const { id } = params.parse(request.params);
    const { period, snapshot, before } = z
      .object({
        period: scope,
        snapshot: token.optional(),
        before: positive.optional(),
      })
      .strict()
      .parse(request.query);
    if (before !== undefined && !snapshot) throw invalid();
    return store.db.transaction(() => {
      const cp = checkpoint(store, id, period, snapshot);
      if (before !== undefined && before > cp.through) throw invalid();
      const rows = store.db
        .prepare(
          `SELECT ${fields} FROM market_provider_receipts
        WHERE instrument_id=? AND requested_period IS ? AND sequence<=? AND sequence${before === undefined ? "<=" : "<"}?
        ORDER BY sequence DESC LIMIT ?`,
        )
        .all(
          id,
          periodValue(period),
          cp.through,
          before ?? cp.through,
          RECEIPT_PAGE_SIZE + 1,
        ) as ProviderReceiptSummary[];
      const receipts = rows.slice(0, RECEIPT_PAGE_SIZE);
      return {
        instrumentId: id,
        period,
        snapshot: encode(cp),
        throughSequence: cp.through,
        receipts,
        nextBefore:
          rows.length > RECEIPT_PAGE_SIZE ? receipts.at(-1)!.sequence : null,
        liveEligible: false as const,
      };
    })();
  });
  app.get(
    `${base}/:sequence`,
    async (request): Promise<ProviderReceiptDetail> => {
      const { id, sequence } = params
        .extend({ sequence: positive })
        .parse(request.params);
      const { period, snapshot } = z
        .object({ period: scope, snapshot: token })
        .strict()
        .parse(request.query);
      return store.db.transaction(() => {
        const cp = checkpoint(store, id, period, snapshot);
        const row = store.db
          .prepare(
            `SELECT sequence FROM market_provider_receipts
        WHERE instrument_id=? AND requested_period IS ? AND sequence=? AND sequence<=?`,
          )
          .get(id, periodValue(period), sequence, cp.through);
        if (!row) throw missing();
        const selected = readPayload(store, sequence);
        return {
          instrumentId: id,
          snapshot: encode(cp),
          selected,
          ...compare(store, selected),
          liveEligible: false as const,
        };
      })();
    },
  );
}
