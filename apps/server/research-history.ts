import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Bar, Instrument } from "../../packages/contracts/index.js";
import type {
  ResearchHistorySummary,
  ResearchHistoryPreview,
  ResearchChartData,
} from "../../packages/contracts/research-history.js";
import {
  actionManifestSchema,
  ActionEvidenceRepository,
  ActionEvidenceError,
  evidenceHash,
  type ActionManifest,
} from "../../packages/market-data/action-evidence.js";
import {
  priceBasisRequestSchema,
  auditPriceBasis,
} from "../../packages/market-data/price-basis-audit.js";
import { resolveSession } from "../../packages/market-data/calendar.js";
import {
  normalizeBar,
  MarketDataError,
  type NormalizedBar,
} from "../../packages/market-data/normalize.js";
import { avwap, ema } from "../../packages/domain/indicators.js";
import { decimal as domainDecimal } from "../../packages/domain/numeric.js";
import { ApiError, type Store } from "./store.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = z.string().trim().min(1).max(500);
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
const at = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().regex(/^\d{1,30}(\.\d{1,20})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const doc = actionManifestSchema.shape.documents.element.omit({ sha256: true });
const corporateActions = actionManifestSchema
  .omit({
    schema: true,
    instrumentId: true,
    market: true,
    expectedVersion: true,
    review: true,
    documents: true,
  })
  .extend({ documents: z.array(doc).min(1).max(20) });
export const researchHistoryManifestSchema = z
  .object({
    schema: z.literal("pullback-lab-research-history-v1"),
    instrumentId: id,
    source: text,
    reviewer: text,
    targetDate: date,
    calendarDays: priceBasisRequestSchema.shape.calendarDays,
    corporateActions,
    bars: z
      .array(
        z
          .object({
            id,
            period: z.enum(["1D", "1m", "5m"]),
            sessionDate: date,
            revision: id,
            start: at,
            end: at,
            open: decimal,
            high: decimal,
            low: decimal,
            close: decimal,
            volume: decimal,
            turnover: decimal,
            volumeUnit: z.enum(["SHARE", "LOT"]),
            lotSize: z.number().int().positive().max(1000000).optional(),
            final: z.literal(true),
            adjustment: z.literal("RAW"),
          })
          .strict(),
      )
      .min(7)
      .max(3000),
  })
  .strict();
export type ResearchHistoryManifest = z.infer<
  typeof researchHistoryManifestSchema
>;
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
interface Snapshot {
  summary: ResearchHistorySummary;
  manifest: ResearchHistoryManifest;
  raw: NormalizedBar[];
  bars: Bar[];
}
interface Row {
  id: string;
  instrument_id: string;
  recorded_at: number;
  input_hash: string;
  request_token: string;
  request_epoch: string;
  payload_hash: string;
  payload_json: string;
}
const fail = (code: string, message: string, status = 422): never => {
  throw new ApiError(status, code, message);
};
function parseManifest(input: unknown): ResearchHistoryManifest {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > HISTORY_MAX_BYTES)
    fail("HISTORY_TOO_LARGE", "历史资料文件不得超过 2 MiB", 413);
  const result = researchHistoryManifestSchema.safeParse(input);
  if (!result.success)
    return fail(
      "HISTORY_INVALID",
      "历史资料字段无效：" +
        result.error.issues
          .slice(0, 8)
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("；"),
      400,
    );
  return result.data;
}
const rowFor = (
  db: Database.Database,
  instrumentId: string,
  historyId?: string,
) =>
  (historyId
    ? db
        .prepare(
          "SELECT * FROM research_history WHERE instrument_id=? AND id=?",
        )
        .get(instrumentId, historyId)
    : db
        .prepare(
          "SELECT * FROM research_history WHERE instrument_id=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(instrumentId)) as Row | undefined;
function decode(row: Row): Snapshot {
  let result: Snapshot;
  try {
    result = JSON.parse(row.payload_json);
  } catch {
    return fail("HISTORY_CORRUPT", "历史资料不可读，请从已验证备份恢复");
  }
  if (
    hash(result) !== row.payload_hash ||
    result.summary.id !== row.id ||
    result.summary.instrumentId !== row.instrument_id ||
    result.summary.importedAt !== row.recorded_at
  )
    fail("HISTORY_CORRUPT", "历史资料哈希不一致，请从已验证备份恢复");
  return result;
}
export function readResearchHistory(
  db: Database.Database,
  instrumentId: string,
  historyId?: string,
): Snapshot | null {
  const row = rowFor(db, instrumentId, historyId);
  if (!row) {
    if (historyId) fail("HISTORY_NOT_FOUND", "找不到该标的的历史资料版本", 404);
    return null;
  }
  const result = decode(row);
  const latest = rowFor(db, instrumentId);
  const action = new ActionEvidenceRepository(db).latest(instrumentId);
  const reasons = [
    ...(latest?.id !== row.id ? ["HISTORY_SUPERSEDED"] : []),
    ...(action?.version !== result.summary.actionEvidenceVersion
      ? ["ACTION_EVIDENCE_CHANGED"]
      : []),
  ];
  result.summary = {
    ...result.summary,
    current: reasons.length === 0,
    reasons,
  };
  return result;
}
export function researchHistoryBars(
  db: Database.Database,
  instrumentId: string,
  period: string,
  historyId?: string,
): Bar[] | null {
  const stored = readResearchHistory(db, instrumentId, historyId);
  if (!stored) return null;
  if (!historyId && !stored.summary.current) return [];
  return stored.bars.filter((_b, i) => stored.raw[i].period === period);
}
export function assertCurrentResearchHistory(
  db: Database.Database,
  instrumentId: string,
  historyId?: string,
): void {
  const current = readResearchHistory(db, instrumentId);
  if (!current && !historyId) return;
  if (
    !historyId ||
    !current ||
    current.summary.id !== historyId ||
    !current.summary.current
  )
    fail(
      "HISTORY_VERSION_CONFLICT",
      "历史资料已有变化，请明确采用当前资料后再保存；计划草稿已保留",
      409,
    );
}
function build(
  store: Store,
  instrument: Instrument,
  input: unknown,
  now: number,
) {
  const manifest = parseManifest(input);
  for (const [path, value] of [
    ["source", manifest.source],
    ["reviewer", manifest.reviewer],
    ["corporateActions.source", manifest.corporateActions.source],
    [
      "corporateActions.coverage.reason",
      manifest.corporateActions.coverage.reason,
    ],
    ...manifest.calendarDays.map((d, i) => [
      `calendarDays.${i}.source`,
      d.source,
    ]),
    ...manifest.corporateActions.documents.flatMap((d, i) => [
      [`corporateActions.documents.${i}.content`, d.content],
      [`corporateActions.documents.${i}.url`, d.url],
    ]),
  ]) {
    if (
      value.startsWith("请") ||
      value.includes("example.com/replace-with-actual-source")
    )
      fail(
        "HISTORY_TEMPLATE_INCOMPLETE",
        `${path}：请用已核对的实际资料替换模板占位内容`,
        400,
      );
  }
  if (
    manifest.instrumentId !== instrument.id ||
    instrument.id.startsWith("DEMO-")
  )
    fail(
      "HISTORY_INSTRUMENT_MISMATCH",
      "资料必须属于当前人工观察标的，不能覆盖合成示例",
    );
  const previous = readResearchHistory(store.db, instrument.id);
  const actions = new ActionEvidenceRepository(store.db);
  const expectedHistoryId = previous?.summary.id ?? null;
  const expectedActionVersion = actions.latest(instrument.id)?.version ?? null;
  const inputHash = hash(manifest);
  const token = hash({
    schema: "research-history-import-v1",
    epoch: store.setting("event_feed_epoch"),
    inputHash,
    expectedHistoryId,
    expectedActionVersion,
  });
  if (
    previous &&
    previous.summary.current &&
    hash(previous.manifest) === inputHash
  )
    return {
      manifest,
      inputHash,
      token,
      expectedHistoryId,
      expectedActionVersion,
      duplicate: previous,
      snapshot: previous,
      actionManifest: null,
    };
  const actionManifest: ActionManifest = {
    ...manifest.corporateActions,
    schema: "pullback-lab-actions-v1",
    instrumentId: instrument.id,
    market: instrument.market,
    expectedVersion: expectedActionVersion,
    review: { reviewer: manifest.reviewer, confirmed: true },
    documents: manifest.corporateActions.documents.map((d) => ({
      ...d,
      sha256: evidenceHash(d.content),
    })),
  };
  let actionVersion: string;
  try {
    actionVersion = actions.import(actionManifest, now, {
      dryRun: true,
    }).version;
  } catch (e) {
    if (e instanceof ActionEvidenceError)
      return fail(e.code, `公司行动资料校验失败：${e.code}`);
    throw e;
  }
  const raw = manifest.bars
    .map((b, index) => {
      const s = resolveSession(
        manifest.calendarDays,
        instrument.market,
        b.sessionDate,
        now,
      );
      if (!s.ok || !s.session)
        return fail(
          "HISTORY_CALENDAR_INVALID",
          `bars.${index}.sessionDate：${s.ok ? "该日未开市" : s.reason}`,
        );
      if (s.session.close > now)
        fail(
          "HISTORY_SESSION_NOT_COMPLETED",
          `bars.${index}：只接受已经收盘的完整历史会话`,
        );
      try {
        return {
          ...normalizeBar(
            {
              ...b,
              instrumentId: instrument.id,
              market: instrument.market,
              providerRevision: b.revision,
              sessionId: s.session.id,
              receivedAt: now,
              source: manifest.source,
              synthetic: false,
            },
            s.session,
          ),
          historical: true,
        };
      } catch (e) {
        if (e instanceof MarketDataError)
          return fail(e.code, `bars.${index}：${e.code}`);
        throw e;
      }
    })
    .sort((a, b) => a.start - b.start || a.period.localeCompare(b.period));
  if (new Set(raw.map((b) => b.id)).size !== raw.length)
    fail("HISTORY_DUPLICATE_ID", "bars.id 必须逐根唯一");
  const result = auditPriceBasis({
    instrumentId: instrument.id,
    market: instrument.market,
    asOf: now,
    targetDate: manifest.targetDate,
    calendarDays: manifest.calendarDays,
    bars: raw,
    dataset: {
      coverage: {
        from: actionManifest.coverage.from,
        through: actionManifest.coverage.through,
        verified: actionManifest.coverage.status === "COMPLETE",
        source: actionManifest.source,
        version: actionVersion,
        knownAt: now,
      },
      actions: actionManifest.actions.map(({ documentIds: _docs, ...a }) => ({
        ...a,
        source: actionManifest.source,
        receivedAt: now,
      })),
    },
  });
  if (result.status !== "CONSISTENT")
    return fail(
      result.reason,
      `历史资料尚不能共用同一价格尺度：${result.reason}`,
    );
  // Admission must honor the downstream calculation boundary too: a mathematically
  // valid cumulative split must not persist an unreadable chart/plan dataset.
  for (const [index, bar] of result.bars.entries()) {
    try {
      for (const field of [
        "open",
        "high",
        "low",
        "close",
        "volume",
        "turnover",
        "rawClose",
        "rawVolume",
        "rawTurnover",
      ] as const)
        if (bar[field] !== undefined) domainDecimal(bar[field], field);
    } catch {
      fail(
        "HISTORY_NUMERIC_RANGE",
        `bars.${index}：拆股调整后的量价超过计算精度范围，请核对拆股比例与原始单位`,
      );
    }
  }
  const historyId = `history-v1:${hash({ inputHash, actionVersion, importedAt: now })}`;
  const summary: ResearchHistorySummary = {
    id: historyId,
    instrumentId: instrument.id,
    source: manifest.source,
    importedAt: now,
    targetDate: manifest.targetDate,
    actionEvidenceVersion: actionVersion,
    adjustmentVersion: result.adjustmentVersion,
    counts: {
      "1D": raw.filter((b) => b.period === "1D").length,
      "1m": raw.filter((b) => b.period === "1m").length,
      "5m": raw.filter((b) => b.period === "5m").length,
    },
    current: true,
    reasons: [],
    liveEligible: false,
  };
  const snapshot: Snapshot = { summary, manifest, raw, bars: result.bars };
  return {
    manifest,
    inputHash,
    token,
    expectedHistoryId,
    expectedActionVersion,
    duplicate: null,
    snapshot,
    actionManifest,
  };
}
export function previewResearchHistory(
  store: Store,
  instrument: Instrument,
  input: unknown,
  now: number,
): ResearchHistoryPreview {
  return store.db.transaction(() => {
    const b = build(store, instrument, input, now);
    const {
      id: _id,
      importedAt: _importedAt,
      current: _current,
      ...summary
    } = b.snapshot.summary;
    return {
      status: "PREVIEW" as const,
      token: b.token,
      expectedHistoryId: b.expectedHistoryId,
      expectedActionVersion: b.expectedActionVersion,
      summary,
      warnings: [
        "人工提供的历史研究资料，来源与覆盖由使用者核对，不表示券商行情已接通。",
        "分钟 AVWAP 是按当前导入资料重建的上一完成日线值，不表示当时已知；不生成历史入场提醒。",
        "计划仅可保存草稿；正式筛选资格、真实监测及交易接口均未开放。",
      ],
    };
  })();
}
const importSchema = z
  .object({
    manifest: z.unknown(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    expectedHistoryId: z.string().nullable(),
    expectedActionVersion: z.string().nullable(),
    confirmed: z.literal(true),
  })
  .strict();
export function importResearchHistory(
  store: Store,
  instrument: Instrument,
  input: unknown,
  now: number,
) {
  const request = importSchema.parse(input);
  return store.transaction(() => {
    const retry = store.db
      .prepare(
        "SELECT * FROM research_history WHERE request_token=? AND instrument_id=?",
      )
      .get(request.token, instrument.id) as Row | undefined;
    if (retry) {
      if (retry.request_epoch !== store.setting("event_feed_epoch"))
        fail(
          "HISTORY_PREVIEW_EXPIRED",
          "数据库已恢复或重置，请重新预览后再导入",
          409,
        );
      if (hash(parseManifest(request.manifest)) !== retry.input_hash)
        fail(
          "HISTORY_TOKEN_MISMATCH",
          "预览内容与导入内容不一致，请重新预览",
          409,
        );
      return {
        status: "DUPLICATE" as const,
        history: readResearchHistory(store.db, instrument.id, retry.id)!
          .summary,
      };
    }
    const b = build(store, instrument, request.manifest, now);
    if (
      request.token !== b.token ||
      request.expectedHistoryId !== b.expectedHistoryId ||
      request.expectedActionVersion !== b.expectedActionVersion
    )
      fail(
        "HISTORY_VERSION_CONFLICT",
        "历史资料或公司行动已有变化，请重新预览；旧资料未修改",
        409,
      );
    if (b.duplicate)
      return { status: "DUPLICATE" as const, history: b.duplicate.summary };
    store.importActionEvidence(b.actionManifest!, now);
    const payload = JSON.stringify(b.snapshot);
    store.db
      .prepare(
        "INSERT INTO research_history(id,instrument_id,recorded_at,input_hash,request_token,request_epoch,payload_hash,payload_json) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        b.snapshot.summary.id,
        instrument.id,
        now,
        b.inputHash,
        request.token,
        store.setting("event_feed_epoch"),
        hash(b.snapshot),
        payload,
      );
    store.invalidateEvidence(instrument.id, "RESEARCH_HISTORY_CHANGED", now);
    return { status: "IMPORTED" as const, history: b.snapshot.summary };
  });
}
export function historyChart(
  stored: Snapshot,
  period: string,
  anchorTime: number | null | undefined,
): ResearchChartData {
  const daily = stored.bars.filter((_b, i) => stored.raw[i].period === "1D");
  const dailyRaw = stored.raw.filter((b) => b.period === "1D");
  const bars = stored.bars.filter((_b, i) => stored.raw[i].period === period);
  const anchor = daily.findIndex((b) => b.time === anchorTime);
  const values =
    anchor < 0
      ? daily.map(() => null)
      : avwap(
          daily.map((b) => ({ ...b, adjustmentVerified: true })),
          anchor,
        );
  const cutoffs: (number | null)[] = [];
  const projected = bars.map((b) => {
    const index =
      period === "1D"
        ? daily.findIndex((d) => d.id === b.id)
        : dailyRaw.findLastIndex((d) => d.end <= b.time * 1000);
    cutoffs.push(index < 0 ? null : dailyRaw[index].end / 1000);
    return index < 0 ? null : values[index];
  });
  return {
    bars,
    ema9: ema(
      bars.map((b) => b.close),
      9,
    ),
    ema21: ema(
      bars.map((b) => b.close),
      21,
    ),
    ema50: ema(
      bars.map((b) => b.close),
      50,
    ),
    avwap: projected,
    avwapCutoffs: cutoffs,
    synthetic: false,
    researchHistory: stored.summary,
  };
}
export function registerResearchHistoryRoutes(
  app: FastifyInstance,
  store: Store,
  now: () => number,
) {
  const base = "/api/instruments/:id/research-history";
  app.get<{ Params: { id: string } }>(base, async (request) =>
    store.db.transaction(() => {
      const instrument = store.instrument(request.params.id).instrument;
      const rows = store.db
        .prepare(
          "SELECT id FROM research_history WHERE instrument_id=? ORDER BY sequence DESC LIMIT 20",
        )
        .all(instrument.id) as { id: string }[];
      return {
        current: readResearchHistory(store.db, instrument.id)?.summary ?? null,
        history: rows.map(
          (r) => readResearchHistory(store.db, instrument.id, r.id)!.summary,
        ),
      };
    })(),
  );
  app.get<{ Params: { id: string } }>(base + "/template", async (request) =>
    historyTemplate(
      store.instrument(request.params.id).instrument,
      new ActionEvidenceRepository(store.db).latest(request.params.id)
        ?.manifest,
    ),
  );
  app.post<{ Params: { id: string } }>(
    base + "/preview",
    { bodyLimit: HISTORY_MAX_BYTES + 65536 },
    async (request) => {
      const body = z
        .object({ manifest: z.unknown() })
        .strict()
        .parse(request.body);
      return previewResearchHistory(
        store,
        store.instrument(request.params.id).instrument,
        body.manifest,
        now(),
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    base,
    { bodyLimit: HISTORY_MAX_BYTES + 65536 },
    async (request) =>
      importResearchHistory(
        store,
        store.instrument(request.params.id).instrument,
        request.body,
        now(),
      ),
  );
}
export function historyTemplate(
  instrument: Instrument,
  previous?: ActionManifest,
) {
  const template = {
    schema: "pullback-lab-research-history-v1",
    instrumentId: instrument.id,
    source: "请填写历史量价的实际来源",
    reviewer: "请填写核对人",
    targetDate: "YYYY-MM-DD",
    calendarDays: [
      {
        market: instrument.market,
        date: "YYYY-MM-DD",
        status: "OPEN",
        intervals: [{ open: "HH:MM", close: "HH:MM" }],
        source: "请填写交易日历来源",
        version: "calendar-v1",
        knownAt: 0,
        verified: true,
      },
    ],
    corporateActions: {
      source: "请填写公司行动来源",
      coverage: {
        from: 0,
        through: 0,
        status: "COMPLETE",
        documentIds: ["source-1"],
        reason:
          "请核对从最早日线到目标会话收盘的全部拆股与分红，不能把未知当作没有",
      },
      actions: [],
      removedActionIds: [],
      documents: [
        {
          id: "source-1",
          url: "https://example.com/replace-with-actual-source",
          publishedAt: 0,
          content: "请替换为实际公司行动来源文本，哈希由服务端计算",
        },
      ],
    },
    bars: [
      {
        id: "daily-1",
        period: "1D",
        sessionDate: "YYYY-MM-DD",
        revision: "1",
        start: 0,
        end: 0,
        open: "",
        high: "",
        low: "",
        close: "",
        volume: "",
        turnover: "",
        volumeUnit: "SHARE",
        final: true,
        adjustment: "RAW",
      },
      {
        id: "minute-1",
        period: "1m",
        sessionDate: "YYYY-MM-DD",
        revision: "1",
        start: 0,
        end: 0,
        open: "",
        high: "",
        low: "",
        close: "",
        volume: "",
        turnover: "",
        volumeUnit: "SHARE",
        final: true,
        adjustment: "RAW",
      },
      {
        id: "five-minute-1",
        period: "5m",
        sessionDate: "YYYY-MM-DD",
        revision: "1",
        start: 0,
        end: 0,
        open: "",
        high: "",
        low: "",
        close: "",
        volume: "",
        turnover: "",
        volumeUnit: "SHARE",
        final: true,
        adjustment: "RAW",
      },
    ],
  };
  if (!previous) return template;
  const {
    schema: _schema,
    instrumentId: _id,
    market: _market,
    expectedVersion: _expected,
    review: _review,
    documents,
    ...actions
  } = previous;
  return {
    ...template,
    corporateActions: {
      ...actions,
      removedActionIds: [],
      documents: documents.map(({ sha256: _sha, ...document }) => document),
    },
  };
}
