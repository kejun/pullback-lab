import { ClosedBarRuntime } from "./closed-bar-runtime.js";
import {
  trustedClosedSupport,
  type ClosedBarAdapter,
} from "./closed-bar-adapter.js";
import {
  registerResearchHistoryRoutes,
  readResearchHistory,
  historyChart,
  assertCurrentResearchHistory,
} from "./research-history.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { z, ZodError } from "zod";
import Decimal from "decimal.js";
import { decimal } from "../../packages/domain/numeric.js";
import type { Funds, Plan, PlanInput } from "../../packages/contracts/index.js";
import {
  avwap,
  calculateIndicators,
  ema,
} from "../../packages/domain/indicators.js";
import {
  demoInstruments,
  generateDemoBars,
  getUnknownCapabilities,
} from "../../packages/market-data/index.js";
import { ApiError, Store } from "./store.js";
import { replayPlan } from "./replay.js";
import { AttemptRuntime } from "./attempt-runtime.js";
import { ScreeningService } from "./screening-service.js";
import {
  registerUniverseRoutes,
  universeRevision,
} from "./universe-service.js";
import { registerPriceProposalRoutes } from "./price-proposal.js";
import { registerOperationsRoutes } from "./operations-status.js";
import { registerActionEvidenceRoutes } from "./action-evidence-query.js";
import { registerProviderReceiptRoutes } from "./provider-receipt-query.js";
import { auditDecisionInput } from "./audit-replay.js";
import {
  BoundedEventWriter,
  EventCursorError,
  EVENT_PAGE_LIMIT,
} from "./events-feed.js";
import {
  emptyMarketWorkerStatus,
  type MarketWorkerStatus,
} from "./market-worker.js";

export interface AppOptions {
  databasePath?: string;
  password?: string;
  demo?: boolean;
  now?: () => number;
  origin?: string;
  secureCookies?: boolean;
  logger?: boolean;
  restore?: boolean;
  marketStatus?: () => MarketWorkerStatus;
  /** Trusted server dependency only; never read from configuration JSON or a request. */
  closedBarAdapter?: ClosedBarAdapter;
  /** Audited server factory shares this store for quota accounting. Never an HTTP/env input. */
  closedBarAdapterFactory?: (store: Store) => ClosedBarAdapter;
}
export type PullbackApp = FastifyInstance & {
  store: Store;
  runtime: AttemptRuntime;
  monitor: ClosedBarRuntime;
};
const numeric = z
  .string()
  .max(80)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "价格和金额必须是非负十进制字符串");
const positive = numeric.refine((s) => new Decimal(s).gt(0), "数值必须大于零");
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.object({
  expectedVersion: integer.positive(),
  expectedAttemptId: z.string().min(1).max(120).nullable(),
});
const supportSelectionsSchema = z
  .array(
    z.union([
      z
        .object({ source: z.enum(["EMA9", "EMA21", "EMA50", "AVWAP"]) })
        .strict(),
      z
        .object({
          source: z.literal("HORIZONTAL"),
          id: z.string().min(1).max(100),
          price: positive,
          label: z.string().max(100),
        })
        .strict(),
    ]),
  )
  .max(20);
const supportPreviewSchema = z.object({
  researchHistoryId: z
    .string()
    .regex(/^history-v1:[a-f0-9]{64}$/)
    .optional(),
  instrumentId: z.string().min(1).max(100),
  anchorTime: integer.nullable(),
  primarySupport: positive,
  supportSelections: supportSelectionsSchema,
  sessionDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const feeSideSchema = z
  .object({
    minimum: numeric,
    fixed: numeric,
    perShare: numeric,
    notionalRate: numeric,
  })
  .strict();
const feeScheduleSchema = z
  .object({
    buy: feeSideSchema,
    sell: feeSideSchema,
    currency: z.enum(["USD", "CNY"]),
    version: z.string().trim().min(1).max(120),
    ruleDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const date = new Date(`${value}T00:00:00Z`);
        return (
          Number.isFinite(date.valueOf()) &&
          date.toISOString().slice(0, 10) === value
        );
      }, "费用规则日期无效"),
    confirmed: z.boolean(),
  })
  .strict();
const chaseLimitSchema = z
  .object({
    enabled: z.boolean(),
    maxPercent: numeric
      .refine((value) => {
        try {
          return decimal(value).gte(0);
        } catch {
          return false;
        }
      }, "百分比最多支持64位有效数字")
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.enabled || value.maxPercent !== undefined,
    "开启追高限制时须填写百分比",
  );
const planSchema = z.object({
  chaseLimit: chaseLimitSchema.optional(),
  feeSchedule: feeScheduleSchema.optional(),
  researchHistoryId: z
    .string()
    .regex(/^history-v1:[a-f0-9]{64}$/)
    .optional(),
  instrumentId: z.string().min(1).max(100),
  anchorTime: integer.nullable(),
  primarySupport: positive,
  lower: positive,
  upper: positive,
  stop: positive,
  entryMin: positive,
  entryMax: positive,
  mode: z.enum(["CLOSE_CONFIRM", "INTRABAR_CROSS"]),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(4000),
  backgroundConfirmed: z.boolean(),
  supportSelections: supportSelectionsSchema.optional(),
});
const fundsSchema = z.object({
  expectedGeneration: integer,
  nav: positive,
  baseCurrency: z.enum(["USD", "CNY"]),
  cash: z.object({ USD: numeric, CNY: numeric }),
  existing: z.record(z.string().max(100), numeric),
  riskBudget: positive,
  riskPool: positive,
  maxWeight: positive.refine((s) => new Decimal(s).lte(1), "不支持杠杆"),
  fx: z.object({ USD: positive, CNY: positive }),
  fxAsOf: integer,
  buyFee: numeric,
  sellFee: numeric,
  slippageIn: numeric,
  slippageOut: numeric,
  feesConfirmed: z.boolean(),
});
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function createApp(
  options: AppOptions = {},
): Promise<PullbackApp> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256_000,
    trustProxy: false,
  }) as unknown as PullbackApp;
  const store = new Store(options.databasePath ?? ":memory:");
  app.decorate("store", store);
  const now = options.now ?? Date.now;
  const demo = options.demo === true;
  const screening = new ScreeningService(store);
  const configured = Boolean(options.password && options.password.length >= 8);
  const savedSalt = store.setting("password_salt");
  const passwordSalt = savedSalt
    ? Buffer.from(savedSalt, "hex")
    : randomBytes(16);
  if (!savedSalt)
    store.setSetting("password_salt", passwordSalt.toString("hex"));
  const passwordHash = scryptSync(
    options.password ?? randomBytes(32).toString("hex"),
    passwordSalt,
    64,
  );
  const passwordVersion = passwordHash.toString("hex");
  if (store.setting("password_version") !== passwordVersion) {
    store.db.prepare("DELETE FROM sessions").run();
    store.setSetting("password_version", passwordVersion);
  }
  if (options.restore) {
    store.transaction(() => {
      store.markRestored(now());
      store.db.prepare("DELETE FROM command_results").run();
      store.setSetting("event_feed_epoch", randomBytes(16).toString("hex"));
    });
  } else if (store.funds()) store.markRestored(now());
  const runtime = new AttemptRuntime(store, { now });
  app.decorate("runtime", runtime);
  let adapter: ClosedBarAdapter | undefined;
  try {
    if (options.closedBarAdapter && options.closedBarAdapterFactory)
      throw new Error("CLOSED_ADAPTER_CONFIGURATION_CONFLICT");
    adapter =
      options.closedBarAdapter ?? options.closedBarAdapterFactory?.(store);
  } catch (error) {
    store.close();
    throw error;
  }
  const monitor = new ClosedBarRuntime(store, { now, adapter });
  app.decorate("monitor", monitor);
  await app.register(cookie);
  const auth = (request: FastifyRequest) => {
    const token = request.cookies.pullback_session;
    if (!token || !configured) return false;
    const row = store.db
      .prepare("SELECT expires_at FROM sessions WHERE token_hash=?")
      .get(digest(token)) as { expires_at: number } | undefined;
    return Boolean(row && row.expires_at > now());
  };
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    // The router resolves percent-encoded paths before onRequest runs, while
    // request.url is still raw. Apply security to the route that will execute.
    const routeUrl = request.routeOptions.url;
    if (!routeUrl?.startsWith("/api/") && !request.url.startsWith("/api/"))
      return;
    reply.header("Cache-Control", "no-store");
    // A tunnel's public Origin can differ from the local upstream address.
    // Keep the write marker and session checks independent of that address.
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (isWrite && request.headers["x-requested-with"] !== "PullbackLab")
      throw new ApiError(403, "CSRF_REJECTED", "写请求缺少应用来源标记");
    if (["/api/session", "/api/login", "/api/health"].includes(routeUrl ?? ""))
      return;
    if (!configured)
      throw new ApiError(
        503,
        "PASSWORD_NOT_CONFIGURED",
        "请在服务端配置至少 8 位 PULLBACK_PASSWORD 后使用私有应用",
      );
    if (!auth(request)) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.status(400).send({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("；"),
        code: "INVALID_INPUT",
      });
    if (error instanceof ApiError || error instanceof EventCursorError)
      return reply
        .status(error.statusCode)
        .send({ error: error.message, code: error.code });
    if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return reply.status(413).send({
        error: "请求内容过大，请按页面标注的文件大小上限重新准备资料",
        code: "REQUEST_BODY_TOO_LARGE",
      });
    if ((error as { code?: string }).code === "SQLITE_BUSY")
      return reply.status(503).send({
        error: "数据库暂忙，尚未确认保存，请重试",
        code: "DATABASE_BUSY",
      });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500)
      return reply
        .status(statusCode)
        .send({ error: "请求格式无效", code: "INVALID_REQUEST" });
    requestSafeLog(app, error);
    return reply.status(500).send({
      error: "服务端处理失败；输入已保留，请重新读取核对",
      code: "INTERNAL_ERROR",
    });
  });
  registerPriceProposalRoutes(app, store);
  registerActionEvidenceRoutes(app, store);
  registerProviderReceiptRoutes(app, store);
  registerOperationsRoutes(app, store, {
    now,
    secureCookies: options.secureCookies,
    originConfigured: Boolean(options.origin),
    marketStatus: options.marketStatus,
  });
  app.get("/api/health", async () => ({ ok: true, dataReady: false }));
  app.get("/api/session", async (request) => ({
    authenticated: auth(request),
    configured,
    demo,
  }));
  const attempts = new Map<string, { count: number; since: number }>();
  app.post("/api/login", async (request, reply) => {
    if (!configured)
      throw new ApiError(
        503,
        "PASSWORD_NOT_CONFIGURED",
        "请在服务端配置至少 8 位 PULLBACK_PASSWORD",
      );
    const { password } = z
      .object({ password: z.string().max(512) })
      .parse(request.body);
    const attempt = attempts.get(request.ip);
    if (attempt && now() - attempt.since < 60_000 && attempt.count >= 10)
      throw new ApiError(429, "LOGIN_RATE_LIMIT", "登录尝试过多，请稍后重试");
    const current =
      !attempt || now() - attempt.since >= 60_000
        ? { count: 0, since: now() }
        : attempt;
    attempts.set(request.ip, { ...current, count: current.count + 1 });
    const suppliedHash = scryptSync(password, passwordSalt, 64);
    if (!timingSafeEqual(passwordHash, suppliedHash))
      throw new ApiError(401, "INVALID_PASSWORD", "密码不正确");
    attempts.delete(request.ip);
    store.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now());
    const token = randomBytes(32).toString("base64url");
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?)")
      .run(digest(token), now() + 12 * 60 * 60_000);
    reply.setCookie("pullback_session", token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: options.secureCookies ?? process.env.NODE_ENV === "production",
      maxAge: 12 * 60 * 60,
    });
    return { ok: true };
  });
  app.post("/api/logout", async (request, reply) => {
    if (request.cookies.pullback_session)
      store.db
        .prepare("DELETE FROM sessions WHERE token_hash=?")
        .run(digest(request.cookies.pullback_session));
    reply.clearCookie("pullback_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/bootstrap", async () =>
    store.db.transaction(() => {
      const page = store.eventPage();
      return {
        demo,
        capabilities: getUnknownCapabilities(),
        instruments: store.listInstruments().map((x) => x.instrument),
        universeRevision: universeRevision(store),
        plans: store.plans(),
        funds: store.funds(),
        events: page.events,
        eventPage: page,
        screeningConfirmed: store.screeningSettings().current !== null,
        screeningRules: store.screeningSettings(),
      };
    })(),
  );
  app.get(
    "/api/market/status",
    async () => options.marketStatus?.() ?? emptyMarketWorkerStatus(),
  );
  app.get("/api/candidates", async () =>
    screening.candidates(now(), options.marketStatus?.()),
  );
  function checkedPlan(id: string, body: unknown): Plan {
    const expected = version.parse(body);
    const plan = store.plan(id);
    if (plan.version !== expected.expectedVersion)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "计划已有新版本，请重新读取；输入已保留",
      );
    if (plan.attemptId !== expected.expectedAttemptId)
      throw new ApiError(
        409,
        "ATTEMPT_CONFLICT",
        "观察尝试已经变化，请重新读取；输入已保留",
      );
    return plan;
  }
  function assertInitialActivation(plan: Plan): void {
    const previous = store.db
      .prepare(
        `SELECT a.id FROM attempts a
      JOIN plan_versions v ON v.plan_id=a.plan_id AND v.version=a.plan_version
      WHERE a.plan_id=? AND json_extract(v.json,'$.sessionDate')=?
      LIMIT 1`,
      )
      .get(plan.id, plan.sessionDate);
    if (previous && !(plan.attemptId && plan.status === "WAIT_RETEST"))
      throw new ApiError(
        409,
        "RECOVERY_REQUIRED",
        "本会话已有观察尝试，请从已保存进度显式新建恢复尝试",
      );
  }
  function command<T>(request: FastifyRequest, execute: () => T): T {
    const key = request.headers["idempotency-key"];
    // The attempt check and its write share the same lock even without a retry key.
    if (!key) return store.transaction(execute);
    if (typeof key !== "string" || key.length > 120 || key.length < 8)
      throw new ApiError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "幂等键长度须为 8–120",
      );
    const inputHash = digest(JSON.stringify(request.body ?? null));
    return store.transaction(() => {
      const old = store.db
        .prepare(
          "SELECT route,input_hash,json FROM command_results WHERE key=?",
        )
        .get(key) as
        { route: string; input_hash: string; json: string } | undefined;
      if (old) {
        if (
          old.route !== `${request.method}:${request.url}` ||
          old.input_hash !== inputHash
        )
          throw new ApiError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "幂等键已用于其他输入",
          );
        return JSON.parse(old.json) as T;
      }
      const result = execute();
      store.db
        .prepare("INSERT INTO command_results VALUES(?,?,?,?)")
        .run(
          key,
          `${request.method}:${request.url}`,
          inputHash,
          JSON.stringify(result),
        );
      return result;
    });
  }
  app.get<{ Params: { id: string } }>(
    "/api/plans/:id/monitor",
    async (request) => ({
      availability: monitor.availability(),
      progress: monitor.status(request.params.id),
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/plans/:id/monitor/recover",
    async (request) =>
      command(request, () => {
        const p = checkedPlan(request.params.id, request.body);
        const recovery = z
          .object({
            sourceAttemptId: z.string().min(1).max(120),
            expectedWatermark: integer,
          })
          .parse(request.body);
        return monitor.activate(
          p.id,
          { expectedVersion: p.version, expectedAttemptId: p.attemptId },
          recovery,
        );
      }),
  );
  registerUniverseRoutes(app, store, command);
  app.get("/api/settings/screening", async () => store.screeningSettings());
  app.post("/api/settings/screening", async (request) =>
    command(request, () => {
      const legacy = z
        .object({ confirmed: z.literal(true) })
        .strict()
        .safeParse(request.body);
      if (legacy.success)
        return store.confirmScreening(undefined, undefined, now());
      const input = z
        .object({
          confirmed: z.literal(true),
          expectedVersion: integer,
          parameters: z.unknown(),
        })
        .strict()
        .parse(request.body);
      if (!Object.hasOwn(input, "parameters"))
        throw new ApiError(
          400,
          "INVALID_SCREENING_PARAMETERS",
          "请提供完整筛选参数",
        );
      return store.confirmScreening(
        input.parameters as import("../../packages/contracts/screening.js").ScreeningParameters,
        input.expectedVersion,
        now(),
      );
    }),
  );
  app.post("/api/demo/seed", async () => {
    if (!demo) throw new ApiError(404, "DEMO_DISABLED", "未启用合成演示模式");
    store.transaction(() => {
      for (const instrument of demoInstruments) {
        if (
          !store
            .listInstruments()
            .some((x) => x.instrument.id === instrument.id)
        )
          store.putInstrument({
            instrument,
            tags: ["合成数据"],
            note: "固定演示样本；不是真实证券或行情",
            manual: false,
          });
        for (const period of ["1D", "1m", "5m"] as const)
          store.putBars(
            instrument.id,
            period,
            generateDemoBars(instrument.id, period),
          );
      }
      store.setSetting("demo_seeded", "true");
    });
    return { ok: true, synthetic: true };
  });
  registerResearchHistoryRoutes(app, store, now);
  app.get<{
    Params: { id: string };
    Querystring: { period?: string; anchorTime?: string; historyId?: string };
  }>("/api/instruments/:id/bars", async (request) => {
    store.instrument(request.params.id);
    const period = z
      .enum(["1D", "1m", "5m"])
      .parse(request.query.period ?? "1D");
    const historyId =
      request.query.historyId === undefined
        ? undefined
        : z
            .string()
            .regex(/^history-v1:[a-f0-9]{64}$/)
            .parse(request.query.historyId);
    const storedHistory = readResearchHistory(
      store.db,
      request.params.id,
      historyId,
    );
    if (storedHistory) {
      const anchorTime =
        request.query.anchorTime === undefined
          ? store.plans().find((p) => p.instrumentId === request.params.id)
              ?.anchorTime
          : z.coerce
              .number()
              .int()
              .nonnegative()
              .parse(request.query.anchorTime);
      return historyChart(storedHistory, period, anchorTime);
    }
    const bars = store.bars(request.params.id, period);
    const daily = period === "1D" ? bars : store.bars(request.params.id, "1D");
    const latest = store
      .plans()
      .find((p) => p.instrumentId === request.params.id);
    const anchorTime =
      request.query.anchorTime === undefined
        ? latest?.anchorTime
        : z.coerce.number().int().nonnegative().parse(request.query.anchorTime);
    const anchor = daily.findIndex((bar) => bar.time === anchorTime);
    const providerContext = trustedClosedSupport(
      store.db,
      store.instrument(request.params.id).instrument,
      daily,
      now(),
    );
    const adjustedDaily =
      Boolean(providerContext) ||
      (daily.length > 0 &&
        daily.every((bar) => bar.id.startsWith("synthetic:")));
    const dailyAvwap =
      anchor >= 0 && adjustedDaily
        ? avwap(
            daily.map((bar) => ({
              ...bar,
              adjustmentVerified:
                bar.id.startsWith("synthetic:") || Boolean(providerContext),
            })),
            anchor,
          )
        : daily.map(() => null);
    const projected =
      period === "1D"
        ? dailyAvwap
        : bars.map((bar) => {
            let value: string | null = null;
            for (let i = 0; i < daily.length; i++)
              if (daily[i].receivedAt <= bar.time * 1000) value = dailyAvwap[i];
            return value;
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
      providerContext: providerContext
        ? {
            id: providerContext.id,
            source: providerContext.source,
            probeReportId: providerContext.probeReportId,
            basisDate: providerContext.basisDate,
            validUntil: providerContext.capability.validUntil,
            researchOnly: true,
          }
        : null,
      synthetic:
        bars.length > 0 && bars.every((bar) => bar.id.startsWith("synthetic:")),
    };
  });
  function validatePlan(body: unknown): PlanInput {
    const p = planSchema.parse(body);
    const instrument = store.instrument(p.instrumentId).instrument;
    // Provenance date, not a future effective-date schedule. Trust only the server clock.
    const marketToday = new Intl.DateTimeFormat("en-CA", {
      timeZone:
        instrument.market === "US" ? "America/New_York" : "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now());
    if (p.feeSchedule && p.feeSchedule.ruleDate > marketToday)
      throw new ApiError(
        400,
        "FEE_RULE_DATE_IN_FUTURE",
        "费用规则日期不能晚于当前市场日期",
      );
    assertCurrentResearchHistory(store.db, p.instrumentId, p.researchHistoryId);
    if (
      !new Decimal(p.stop).lt(p.lower) ||
      new Decimal(p.lower).gte(p.upper) ||
      new Decimal(p.entryMin).lte(p.stop) ||
      new Decimal(p.entryMax).lte(p.entryMin)
    )
      throw new ApiError(
        400,
        "INVALID_PRICE_GEOMETRY",
        "须满足止损 < 支撑下界 < 支撑上界，入场上界 > 入场下界 > 止损",
      );
    if (
      new Decimal(p.primarySupport).lt(p.lower) ||
      new Decimal(p.primarySupport).gt(p.upper)
    )
      throw new ApiError(400, "SUPPORT_OUTSIDE_ZONE", "主支撑须位于支撑区间内");
    for (const key of [
      "primarySupport",
      "lower",
      "upper",
      "stop",
      "entryMin",
      "entryMax",
    ] as const)
      if (!new Decimal(p[key]).mod(instrument.tick).eq(0))
        throw new ApiError(
          400,
          "INVALID_PRICE_TICK",
          `${key} 必须按该证券价格跳动 ${instrument.tick} 填写`,
        );
    if (
      p.anchorTime !== null &&
      !store
        .bars(p.instrumentId, "1D", p.researchHistoryId)
        .some((b) => b.time === p.anchorTime && b.final)
    )
      throw new ApiError(400, "INVALID_ANCHOR", "锚点须选自已完成日线");
    const date = new Date(`${p.sessionDate}T00:00:00Z`);
    if (
      !Number.isFinite(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== p.sessionDate
    )
      throw new ApiError(400, "INVALID_SESSION_DATE", "交易日格式无效");
    return p;
  }
  app.post("/api/plans/support-preview", async (request) => {
    const input = supportPreviewSchema.parse(request.body);
    return store.supportPreview(input, now(), "", input.sessionDate);
  });
  app.post("/api/plans", async (request) =>
    command(request, () => store.createPlan(validatePlan(request.body), now())),
  );
  app.post<{ Params: { id: string } }>(
    "/api/plans/:id/versions",
    async (request) =>
      command(request, () => {
        const current = checkedPlan(request.params.id, request.body);
        return store.updatePlan(
          request.params.id,
          validatePlan(request.body),
          current.version,
          now(),
        );
      }),
  );
  app.post<{ Params: { id: string } }>("/api/plans/:id/risk", async (request) =>
    store.risk(store.plan(request.params.id), now()),
  );
  app.post<{ Params: { id: string } }>(
    "/api/plans/:id/activate",
    async (request) => {
      const key = request.headers["idempotency-key"];
      const knownCommand =
        typeof key === "string" &&
        store.db.prepare("SELECT 1 FROM command_results WHERE key=?").get(key);
      if (!knownCommand)
        store.transaction(() => {
          // Reject stale control snapshots before any evidence-driven pause. Successful
          // retries are read from command_results below even after the attempt changes.
          const current = checkedPlan(request.params.id, request.body);
          const revisionReasons = store.supportRevisionReasons(current, now());
          if (
            revisionReasons.some((reason) =>
              reason.endsWith("REVISION_CHANGED"),
            )
          )
            store.invalidateEvidence(
              current.instrumentId,
              revisionReasons[0],
              now(),
              true,
            );
        });
      return command(request, () => {
        const p = checkedPlan(request.params.id, request.body);
        const expected = p.version;
        if (!p.instrumentId.startsWith("DEMO-"))
          return monitor.activate(p.id, {
            expectedVersion: p.version,
            expectedAttemptId: p.attemptId,
          });
        if (!demo)
          throw new ApiError(
            422,
            "LIVE_CAPABILITY_UNVERIFIED",
            "真实行情、证券规则与拆股口径尚未验证，当前不可启用实时监测",
          );
        if (p.mode !== "CLOSE_CONFIRM")
          throw new ApiError(
            422,
            "TICK_CAPABILITY_UNVERIFIED",
            "逐笔连续性尚未验证；合成页面只开放收盘确认回放",
          );
        if (!p.backgroundConfirmed || !p.reason.trim())
          throw new ApiError(
            422,
            "BACKGROUND_UNCONFIRMED",
            "请确认日线背景并填写关注理由",
          );
        if (!store.screeningSettings().current)
          throw new ApiError(
            422,
            "RULES_UNCONFIRMED",
            "请先在设置中确认 C 类工程筛选预设",
          );
        if (!p.supportSnapshot)
          throw new ApiError(
            422,
            "SUPPORT_SNAPSHOT_REQUIRED",
            "旧计划缺少支撑快照，请显式保存新版本",
          );
        if (!p.supportSnapshot.ready)
          throw new ApiError(
            422,
            "SUPPORT_NOT_READY",
            p.supportSnapshot.reasons.join("；"),
          );
        const bars = store.bars(p.instrumentId, "1D");
        const indicators = calculateIndicators(bars);
        if (!indicators.screeningReady || !bars.at(-1))
          throw new ApiError(
            422,
            "DAILY_HISTORY_INCOMPLETE",
            "日线预热或完整性不足",
          );
        if (
          !p.supportSnapshot?.reference.close ||
          !new Decimal(p.supportSnapshot.reference.close).gt(p.upper)
        )
          throw new ApiError(
            422,
            "ABOVE_SUPPORT_EVIDENCE_REQUIRED",
            "上一完整日线收盘必须严格高于支撑区上界",
          );
        if (p.sessionDate !== "2026-10-09")
          throw new ApiError(
            422,
            "SYNTHETIC_SESSION_REQUIRED",
            "固定合成回放的会话日期为 2026-10-09",
          );
        const evidenceReasons = store.supportRevisionReasons(p, now());
        if (evidenceReasons.length)
          throw new ApiError(
            422,
            evidenceReasons[0],
            "支撑依据缺失或已修订，请显式保存新的计划版本",
          );
        assertInitialActivation(p);
        return store.activate(p.id, expected, now());
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/plans/:id/pause",
    async (request) =>
      command(request, () => {
        const current = checkedPlan(request.params.id, request.body);
        return store.pause(current.id, current.version, now());
      }),
  );
  app.post("/api/funds", async (request) =>
    command(request, () => {
      const parsed = fundsSchema.parse(request.body);
      const { expectedGeneration, ...input } = parsed;
      if (input.fxAsOf > now())
        throw new ApiError(400, "FUTURE_FX_TIME", "汇率时间不能晚于当前时间");
      return store.updateFunds(
        {
          ...input,
          generation: expectedGeneration,
          confirmedAt: now(),
          stale: false,
        },
        expectedGeneration,
        now(),
      );
    }),
  );
  app.get<{ Querystring: { after?: string; before?: string; limit?: string } }>(
    "/api/events",
    async (request) => {
      const query = z
        .object({
          after: z.string().min(1).max(300).optional(),
          before: z.string().min(1).max(300).optional(),
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(EVENT_PAGE_LIMIT)
            .optional(),
        })
        .refine(
          (value) => !(value.before && value.after),
          "before 与 after 不能同时使用",
        )
        .parse(request.query);
      return store.eventPage(query);
    },
  );
  app.get<{ Params: { id: string } }>("/api/events/:id", async (request) =>
    store.event(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/events/:id/input",
    async (request) => store.decisionInput(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/events/:id/replay",
    async (request) => {
      const row = store.db
        .prepare(
          "SELECT i.json,e.input_hash FROM decision_inputs i JOIN decision_events e ON e.input_hash=i.hash WHERE e.id=?",
        )
        .get(request.params.id) as
        { json: string; input_hash: string } | undefined;
      if (!row) throw new ApiError(404, "NOT_FOUND", "找不到决策输入");
      let snapshot: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(row.json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          snapshot = parsed as Record<string, unknown>;
      } catch {
        /* The auditor reports a corrupt archive using the original bytes. */
      }
      return auditDecisionInput({
        snapshot,
        expectedInputHash: row.input_hash,
        serializedInput: row.json,
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/events/:id/feedback",
    async (request) => ({
      revisions: store.feedbackHistory(request.params.id),
    }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/events/:id/read",
    async (request) => {
      store.readEvent(request.params.id, now());
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/events/:id/feedback",
    async (request) =>
      command(request, () => {
        const input = z
          .object({
            kind: z.enum(["TAKEN", "SKIPPED"]),
            note: z.string().max(4000).default(""),
            actualPrice: positive.optional(),
            actualQuantity: integer.positive().optional(),
            actualTime: integer.optional(),
            expectedRevisionId: z
              .string()
              .min(1)
              .max(120)
              .nullable()
              .optional(),
          })
          .parse(request.body);
        store.feedback(request.params.id, input, now());
        return { ok: true };
      }),
  );
  const runtimeCommand = z
    .object({
      expectedVersion: integer.positive(),
      expectedAttemptId: z.string().min(1).max(120),
    })
    .strict();
  const runtimeGuard = () => {
    if (!demo) throw new ApiError(404, "DEMO_DISABLED", "未启用合成演示模式");
  };
  app.get<{ Params: { id: string } }>(
    "/api/demo/plans/:id/runtime",
    async (request) => {
      runtimeGuard();
      return { runtime: runtime.status(request.params.id) };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/demo/plans/:id/runtime/start",
    async (request) => {
      runtimeGuard();
      return command(request, () => ({
        runtime: runtime.start(
          request.params.id,
          runtimeCommand.parse(request.body),
        ),
      }));
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/demo/plans/:id/runtime/recover",
    async (request) => {
      runtimeGuard();
      const input = version
        .extend({
          sourceAttemptId: z.string().min(1).max(120),
          expectedStep: integer,
        })
        .strict()
        .parse(request.body);
      return command(request, () => ({
        runtime: runtime.recover(request.params.id, input),
      }));
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/demo/plans/:id/runtime/step",
    async (request) => {
      runtimeGuard();
      const input = runtimeCommand
        .extend({
          expectedStep: integer,
          count: integer.min(1).max(20).optional(),
        })
        .parse(request.body);
      return command(request, () => ({
        runtime: runtime.step(request.params.id, input),
      }));
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/demo/plans/:id/replay",
    async (request) =>
      command(request, () => {
        if (!demo)
          throw new ApiError(404, "DEMO_DISABLED", "未启用合成演示模式");
        checkedPlan(request.params.id, request.body);
        if (runtime.status(request.params.id))
          throw new ApiError(
            409,
            "RUNTIME_ALREADY_STARTED",
            "该尝试已开始分步演练，请继续当前运行或显式建立新尝试",
          );
        return { events: replayPlan(store, request.params.id, now()) };
      }),
  );
  const streams = new Set<NodeJS.Timeout>();
  const connections = new Set<import("node:http").ServerResponse>();
  app.get<{ Querystring: { after?: string } }>(
    "/api/events/stream",
    async (request, reply) => {
      const header = request.headers["last-event-id"];
      let lastCursor =
        typeof header === "string" ? header : request.query.after;
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      connections.add(reply.raw);
      const writer = new BoundedEventWriter(reply.raw);
      let timer: NodeJS.Timeout | undefined;
      const stopTimer = () => {
        if (timer) {
          clearInterval(timer);
          streams.delete(timer);
        }
      };
      const cleanup = () => {
        stopTimer();
        connections.delete(reply.raw);
      };
      reply.raw.once("close", cleanup);
      writer.write(": connected\n\n");
      let heartbeat = 0;
      const pump = () => {
        if (!auth(request)) {
          writer.write(
            `event: auth-expired\ndata: ${JSON.stringify({ code: "UNAUTHENTICATED" })}\n\n`,
          );
          stopTimer();
          reply.raw.end();
          return;
        }
        if (!writer.ready) return;
        try {
          const batch = store.eventFeed(lastCursor);
          if (batch.events.length) {
            if (
              writer.write(
                `id: ${batch.feedCursor}\nevent: events\ndata: ${JSON.stringify(batch)}\n\n`,
              )
            )
              lastCursor = batch.feedCursor;
          } else if (++heartbeat % 15 === 0) writer.write(": heartbeat\n\n");
        } catch (error) {
          if (error instanceof EventCursorError)
            writer.write(
              `event: reset\ndata: ${JSON.stringify({ code: error.code, reason: error.message, feedEpoch: store.setting("event_feed_epoch") })}\n\n`,
            );
          stopTimer();
          reply.raw.end();
        }
      };
      pump();
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        timer = setInterval(pump, 1000);
        timer.unref();
        streams.add(timer);
      }
    },
  );
  app.addHook("preClose", async () => {
    await monitor.stop();
    runtime.close();
    for (const stream of streams) clearInterval(stream);
    for (const response of connections) response.destroy();
    app.server.closeIdleConnections();
    streams.clear();
    connections.clear();
  });
  app.addHook("onClose", async () => {
    await monitor.stop();
    runtime.close();
    store.close();
  });
  return app;
}

function requestSafeLog(app: FastifyInstance, error: unknown) {
  app.log.error(
    { code: (error as { code?: string }).code ?? "UNEXPECTED_ERROR" },
    "request failed",
  );
}
