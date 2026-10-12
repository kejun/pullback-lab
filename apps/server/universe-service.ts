import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Instrument } from "../../packages/contracts/index.js";
import {
  normalizeUniverseSymbol,
  UniverseSymbolError,
} from "../../packages/domain/universe-symbol.js";
export { normalizeUniverseSymbol } from "../../packages/domain/universe-symbol.js";
import type {
  UniverseSnapshot,
  UniverseLimits,
  UniverseImportRowResult,
  UniverseRowError,
} from "../../packages/contracts/universe.js";
import type { ProviderQuota } from "../../packages/market-data/quota.js";
import { ApiError, type Store, type StoredInstrument } from "./store.js";

const RESEARCH_MAX = 100;
const MONITORING_MAX = 10;
const IMPORT_BODY_MAX = 128_000;
const expectedRevision = z.string().regex(/^[a-f0-9]{64}$/);
const metadataSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  note: z.string().max(4000).optional(),
});
const rowSchema = metadataSchema
  .extend({
    symbol: z.string().trim().min(1).max(32),
    market: z.enum(["US", "CN"]),
    name: z.string().trim().max(100).optional(),
  })
  .strict();
const importSchema = z
  .object({
    rows: z.array(z.unknown()).min(1).max(RESEARCH_MAX),
    expectedRevision,
  })
  .strict();

export interface UniverseOptions {
  /** Only deployment-owned evidence may provide this value; no public write API. */
  providerQuota?: () => ProviderQuota | null;
}
export class UniverseError extends ApiError {
  constructor(
    statusCode: number,
    code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(statusCode, code, message);
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
/** Includes metadata and instrument rules, not only membership. */
export function universeRevision(store: Store): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(store.listInstruments())))
    .digest("hex");
}
function limits(store: Store, options: UniverseOptions): UniverseLimits {
  const supplied = options.providerQuota?.();
  const verified =
    supplied?.verified === true &&
    [
      supplied.researchSymbols,
      supplied.simultaneousSubscriptions,
      supplied.monthlyUniqueSymbols,
      supplied.requestsPerSecond,
    ].every(
      (value) => value !== null && Number.isSafeInteger(value) && value >= 0,
    );
  const provider: ProviderQuota = verified
    ? { ...supplied! }
    : {
        verified: false,
        researchSymbols: null,
        simultaneousSubscriptions: null,
        monthlyUniqueSymbols: null,
        requestsPerSecond: null,
      };
  const researchUsed = store.listInstruments().length;
  return {
    researchMax: RESEARCH_MAX,
    monitoringMax: MONITORING_MAX,
    effectiveResearchMax: Math.min(
      RESEARCH_MAX,
      provider.researchSymbols ?? RESEARCH_MAX,
    ),
    effectiveMonitoringMax: Math.min(
      MONITORING_MAX,
      provider.simultaneousSubscriptions ?? MONITORING_MAX,
    ),
    researchUsed,
    localResearchRemaining: Math.max(0, RESEARCH_MAX - researchUsed),
    provider,
  };
}
export function readUniverse(
  store: Store,
  options: UniverseOptions = {},
): UniverseSnapshot {
  return store.db.transaction(() => ({
    rows: store.listInstruments(),
    universeRevision: universeRevision(store),
    limits: limits(store, options),
  }))();
}
function checkRevision(store: Store, expected?: string) {
  const current = universeRevision(store);
  if (expected !== undefined && expected !== current)
    throw new UniverseError(
      409,
      "UNIVERSE_VERSION_CONFLICT",
      "研究池已发生变化；请读取最新数据后核对输入",
      { universeRevision: current },
    );
}
function parseRows(rows: unknown[]) {
  const parsed: StoredInstrument[] = [];
  const errors: UniverseRowError[] = [];
  rows.forEach((raw, index) => {
    try {
      const input = rowSchema.parse(raw);
      const symbol = normalizeUniverseSymbol(input.symbol, input.market);
      const instrument: Instrument = {
        id: `${input.market}:${symbol}`,
        symbol,
        name: input.name || symbol,
        market: input.market,
        currency: input.market === "US" ? "USD" : "CNY",
        // Placeholder research values are explicitly unverified and cannot enable monitoring.
        tick: "0.01",
        qMin: 1,
        qStep: 1,
        sellSameDay: false,
        rulesVerified: false,
      };
      parsed.push({
        instrument,
        tags: [...new Set(input.tags ?? [])],
        note: input.note ?? "",
        manual: true,
      });
    } catch (error) {
      errors.push({
        row: index + 1,
        status: "error",
        code:
          error instanceof ApiError || error instanceof UniverseSymbolError
            ? error.code
            : "INVALID_UNIVERSE_ROW",
        error:
          error instanceof z.ZodError
            ? error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("；")
            : error instanceof Error
              ? error.message
              : "标的输入无效",
      });
    }
  });
  return { parsed, errors };
}
function importRows(
  store: Store,
  rows: unknown[],
  expected: string | undefined,
  options: UniverseOptions,
) {
  const { parsed, errors } = parseRows(rows);
  if (errors.length)
    throw new UniverseError(
      422,
      "INVALID_UNIVERSE_ROWS",
      "部分标的信息无效，本次未导入任何标的",
      { results: errors, universeRevision: universeRevision(store) },
    );
  return store.transaction(() => {
    checkRevision(store, expected);
    const currentRows = store.listInstruments();
    // Earlier versions accepted bare US symbols. Recognize their canonical
    // identity without rewriting IDs referenced by existing plans and history.
    const original = new Map<string, string>();
    for (const row of currentRows) {
      const instrument = row.instrument;
      try {
        original.set(
          `${instrument.market}:${normalizeUniverseSymbol(instrument.symbol, instrument.market)}`,
          instrument.id,
        );
      } catch {
        original.set(instrument.id, instrument.id);
      }
    }
    const seen = new Map<string, number>();
    const additions: StoredInstrument[] = [];
    const results: UniverseImportRowResult[] = parsed.map((row, index) => {
      const { id, symbol, market } = row.instrument;
      const storedId = original.get(id) ?? id;
      const duplicateOf = seen.get(id);
      if (duplicateOf !== undefined)
        return {
          row: index + 1,
          id: storedId,
          symbol,
          market,
          status: "duplicate",
          duplicateOf,
        };
      seen.set(id, index + 1);
      if (original.has(id))
        return {
          row: index + 1,
          id: storedId,
          symbol,
          market,
          status: "existing",
        };
      additions.push(row);
      return { row: index + 1, id, symbol, market, status: "imported" };
    });
    const capacity = limits(store, options);
    if (
      additions.length &&
      currentRows.length + additions.length > capacity.effectiveResearchMax
    )
      throw new UniverseError(
        422,
        "UNIVERSE_LIMIT",
        `研究池最多 ${capacity.effectiveResearchMax} 个明确标的，本次未导入任何标的`,
        {
          universeRevision: universeRevision(store),
          limits: capacity,
          requestedAdditions: additions.length,
        },
      );
    for (const row of additions) store.putInstrument(row);
    return {
      results,
      imported: additions.length,
      existing: results.filter((row) => row.status === "existing").length,
      duplicates: results.filter((row) => row.status === "duplicate").length,
      universeRevision: universeRevision(store),
      limits: limits(store, options),
    };
  });
}
export function importUniverse(
  store: Store,
  input: unknown,
  options: UniverseOptions = {},
) {
  const parsed = importSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > IMPORT_BODY_MAX)
    throw new UniverseError(
      413,
      "UNIVERSE_IMPORT_TOO_LARGE",
      "导入内容超过 128 KB，请缩短名称、标签或备注",
    );
  return importRows(store, parsed.rows, parsed.expectedRevision, options);
}

type Command = <T>(request: FastifyRequest, execute: () => T) => T;
export function registerUniverseRoutes(
  app: FastifyInstance,
  store: Store,
  command: Command,
  options: UniverseOptions = {},
) {
  function respond<T>(reply: FastifyReply, work: () => T): T | FastifyReply {
    try {
      return work();
    } catch (error) {
      if (error instanceof UniverseError)
        return reply
          .status(error.statusCode)
          .send({ error: error.message, code: error.code, ...error.details });
      throw error;
    }
  }
  app.get("/api/universe", async () => readUniverse(store, options));
  app.post(
    "/api/universe/import",
    { bodyLimit: IMPORT_BODY_MAX },
    async (request, reply) =>
      respond(reply, () =>
        command(request, () => importUniverse(store, request.body, options)),
      ),
  );
  app.post("/api/universe", async (request, reply) =>
    respond(reply, () =>
      command(request, () => {
        const input = rowSchema
          .extend({ expectedRevision: expectedRevision.optional() })
          .parse(request.body);
        const { expectedRevision: expected, ...row } = input;
        return store.transaction(() => {
          const result = importRows(store, [row], expected, options);
          return {
            ...store.instrument(result.results[0].id).instrument,
            universeRevision: result.universeRevision,
          };
        });
      }),
    ),
  );
  app.patch<{ Params: { id: string } }>(
    "/api/universe/:id",
    async (request, reply) =>
      respond(reply, () =>
        command(request, () => {
          const input = metadataSchema
            .required()
            .extend({ expectedRevision: expectedRevision.optional() })
            .strict()
            .parse(request.body);
          return store.transaction(() => {
            checkRevision(store, input.expectedRevision);
            const row = {
              ...store.instrument(request.params.id),
              tags: [...new Set(input.tags)],
              note: input.note,
            };
            store.putInstrument(row);
            return { ok: true, row, universeRevision: universeRevision(store) };
          });
        }),
      ),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/universe/:id",
    async (request, reply) =>
      respond(reply, () =>
        command(request, () => {
          const input = z
            .object({ expectedRevision: expectedRevision.optional() })
            .strict()
            .parse(request.body ?? {});
          return store.transaction(() => {
            checkRevision(store, input.expectedRevision);
            store.deleteInstrument(request.params.id);
            return { ok: true, universeRevision: universeRevision(store) };
          });
        }),
      ),
  );
}
