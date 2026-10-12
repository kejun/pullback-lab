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
import type {
  Candidate,
  Funds,
  Plan,
  PlanInput,
} from "../../packages/contracts/index.js";
import {
  avwap,
  calculateIndicators,
  ema,
  rankCandidates,
  screenInstrument,
} from "../../packages/domain/indicators.js";
import {
  demoInstruments,
  generateDemoBars,
  getUnknownCapabilities,
} from "../../packages/market-data/index.js";
import { ApiError, Store } from "./store.js";
import { replayPlan } from "./replay.js";

export interface AppOptions {
  databasePath?: string;
  password?: string;
  demo?: boolean;
  now?: () => number;
  origin?: string;
  secureCookies?: boolean;
  logger?: boolean;
  restore?: boolean;
}
export type PullbackApp = FastifyInstance & { store: Store };
const numeric = z
  .string()
  .max(80)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "价格和金额必须是非负十进制字符串");
const positive = numeric.refine((s) => new Decimal(s).gt(0), "数值必须大于零");
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.object({ expectedVersion: integer.positive() });
const planSchema = z.object({
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
  if (options.restore || store.funds()) store.markRestored(now());
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
    if (!request.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    const requestOrigin = `${request.protocol}://${request.headers.host}`;
    if (origin && origin !== (options.origin ?? requestOrigin))
      throw new ApiError(403, "ORIGIN_REJECTED", "拒绝来自其他站点的请求");
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (isWrite && request.headers["x-requested-with"] !== "PullbackLab")
      throw new ApiError(403, "CSRF_REJECTED", "写请求缺少应用来源标记");
    if (
      ["/api/session", "/api/login", "/api/health"].includes(
        request.url.split("?")[0],
      )
    )
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
      return reply
        .status(400)
        .send({
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；"),
          code: "INVALID_INPUT",
        });
    if (error instanceof ApiError)
      return reply
        .status(error.statusCode)
        .send({ error: error.message, code: error.code });
    if ((error as { code?: string }).code === "SQLITE_BUSY")
      return reply
        .status(503)
        .send({
          error: "数据库暂忙，尚未确认保存，请重试",
          code: "DATABASE_BUSY",
        });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500)
      return reply
        .status(statusCode)
        .send({ error: "请求格式无效", code: "INVALID_REQUEST" });
    requestSafeLog(app, error);
    return reply
      .status(500)
      .send({
        error: "服务端处理失败；输入已保留，请重新读取核对",
        code: "INTERNAL_ERROR",
      });
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
  app.get("/api/bootstrap", async () => ({
    demo,
    capabilities: getUnknownCapabilities(),
    instruments: store.listInstruments().map((x) => x.instrument),
    plans: store.plans(),
    funds: store.funds(),
    events: store.events(),
    screeningConfirmed: store.setting("screening_confirmed") === "true",
  }));
  app.get("/api/candidates", async () => {
    const candidates: Candidate[] = store.listInstruments().map((row) => {
      const bars = store.bars(row.instrument.id, "1D");
      const synthetic =
        bars.length > 0 && bars.every((bar) => bar.id.startsWith("synthetic:"));
      const c = screenInstrument(row.instrument, bars, {
        historyComplete: synthetic,
        unadjusted: synthetic,
        date: bars.length
          ? new Date(bars.at(-1)!.time * 1000).toISOString().slice(0, 10)
          : "",
      });
      if (!synthetic) {
        c.status = row.manual ? "MANUAL" : "UNKNOWN";
        c.reasons = ["真实行情与拆股口径尚未验证"];
      } else if (store.setting("screening_confirmed") !== "true") {
        c.status = "UNKNOWN";
        c.reasons = ["请先确认 C 类工程筛选预设"];
      }
      return { ...c, tags: row.tags, note: row.note };
    });
    return {
      candidates: rankCandidates(candidates),
      coverage: candidates.filter((c) => c.indicators.screeningReady).length,
      asOf: candidates.reduce((date, c) => (c.date > date ? c.date : date), ""),
    };
  });
  function command<T>(request: FastifyRequest, execute: () => T): T {
    const key = request.headers["idempotency-key"];
    if (!key) return execute();
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
  app.post("/api/universe", async (request) =>
    command(request, () => {
      const input = z
        .object({
          symbol: z
            .string()
            .min(1)
            .max(32)
            .regex(/^[A-Za-z0-9.\-]+$/),
          market: z.enum(["US", "CN"]),
          name: z.string().max(100).optional(),
        })
        .parse(request.body);
      const symbol = input.symbol.toUpperCase();
      const id = `${input.market}:${symbol}`;
      const existing = store
        .listInstruments()
        .find((x) => x.instrument.id === id);
      if (existing) return existing.instrument;
      if (store.listInstruments().length >= 100)
        throw new ApiError(422, "UNIVERSE_LIMIT", "研究池最多 100 个明确标的");
      const instrument = {
        id,
        symbol,
        name: input.name ?? symbol,
        market: input.market,
        currency: input.market === "US" ? ("USD" as const) : ("CNY" as const),
        tick: "0.01",
        qMin: 1,
        qStep: 1,
        sellSameDay: false,
        rulesVerified: false,
      };
      store.putInstrument({ instrument, tags: [], note: "", manual: true });
      return instrument;
    }),
  );
  app.patch<{ Params: { id: string } }>("/api/universe/:id", async (request) =>
    command(request, () => {
      const input = z
        .object({
          tags: z.array(z.string().max(40)).max(20),
          note: z.string().max(4000),
        })
        .parse(request.body);
      const row = store.instrument(request.params.id);
      store.putInstrument({ ...row, ...input });
      return { ok: true };
    }),
  );
  app.delete<{ Params: { id: string } }>("/api/universe/:id", async (request) =>
    command(request, () => {
      store.deleteInstrument(request.params.id);
      return { ok: true };
    }),
  );
  app.post("/api/settings/screening", async (request) => {
    z.object({ confirmed: z.literal(true) }).parse(request.body);
    store.setSetting("screening_confirmed", "true");
    return { ok: true };
  });
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
  app.get<{
    Params: { id: string };
    Querystring: { period?: string; anchorTime?: string };
  }>("/api/instruments/:id/bars", async (request) => {
    store.instrument(request.params.id);
    const period = z
      .enum(["1D", "1m", "5m"])
      .parse(request.query.period ?? "1D");
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
    const dailyAvwap =
      anchor >= 0
        ? avwap(
            daily.map((bar) => ({
              ...bar,
              adjustmentVerified: bar.id.startsWith("synthetic:"),
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
      synthetic:
        bars.length > 0 && bars.every((bar) => bar.id.startsWith("synthetic:")),
    };
  });
  function validatePlan(body: unknown): PlanInput {
    const p = planSchema.parse(body);
    const instrument = store.instrument(p.instrumentId).instrument;
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
        .bars(p.instrumentId, "1D")
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
  app.post("/api/plans", async (request) =>
    command(request, () => store.createPlan(validatePlan(request.body), now())),
  );
  app.post<{ Params: { id: string } }>(
    "/api/plans/:id/versions",
    async (request) =>
      command(request, () =>
        store.updatePlan(
          request.params.id,
          validatePlan(request.body),
          version.parse(request.body).expectedVersion,
          now(),
        ),
      ),
  );
  app.post<{ Params: { id: string } }>("/api/plans/:id/risk", async (request) =>
    store.risk(store.plan(request.params.id), now()),
  );
  app.post<{ Params: { id: string } }>(
    "/api/plans/:id/activate",
    async (request) =>
      command(request, () => {
        const p = store.plan(request.params.id);
        const expected = version.parse(request.body).expectedVersion;
        if (p.version !== expected)
          throw new ApiError(
            409,
            "VERSION_CONFLICT",
            "计划已经变化，请重新读取",
          );
        if (!demo || !p.instrumentId.startsWith("DEMO-"))
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
        if (store.setting("screening_confirmed") !== "true")
          throw new ApiError(
            422,
            "RULES_UNCONFIRMED",
            "请先在设置中确认 C 类工程筛选预设",
          );
        const bars = store.bars(p.instrumentId, "1D");
        const indicators = calculateIndicators(bars);
        if (!indicators.screeningReady || !bars.at(-1))
          throw new ApiError(
            422,
            "DAILY_HISTORY_INCOMPLETE",
            "日线预热或完整性不足",
          );
        if (!new Decimal(bars.at(-1)!.close).gt(p.upper))
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
        return store.activate(p.id, expected, now());
      }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/plans/:id/pause",
    async (request) =>
      command(request, () =>
        store.pause(
          request.params.id,
          version.parse(request.body).expectedVersion,
          now(),
        ),
      ),
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
  app.get<{ Querystring: { after?: string } }>(
    "/api/events",
    async (request) => ({ events: store.events(request.query.after) }),
  );
  app.get<{ Params: { id: string } }>(
    "/api/events/:id/input",
    async (request) => store.decisionInput(request.params.id),
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
          })
          .parse(request.body);
        store.feedback(request.params.id, input, now());
        return { ok: true };
      }),
  );
  app.post<{ Params: { id: string } }>(
    "/api/demo/plans/:id/replay",
    async (request) =>
      command(request, () => {
        if (!demo)
          throw new ApiError(404, "DEMO_DISABLED", "未启用合成演示模式");
        return { events: replayPlan(store, request.params.id, now()) };
      }),
  );
  const streams = new Set<NodeJS.Timeout>();
  const connections = new Set<import("node:http").ServerResponse>();
  app.get<{ Querystring: { after?: string } }>(
    "/api/events/stream",
    async (request, reply) => {
      const header = request.headers["last-event-id"];
      let lastId = typeof header === "string" ? header : request.query.after;
      const initial = store.events(lastId);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      connections.add(reply.raw);
      reply.raw.write(": connected\n\n");
      for (const event of initial) {
        reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        lastId = event.id;
      }
      let heartbeat = 0;
      const timer = setInterval(() => {
        if (!auth(request)) {
          reply.raw.end();
          return;
        }
        try {
          for (const event of store.events(lastId)) {
            reply.raw.write(
              `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            lastId = event.id;
          }
          if (++heartbeat % 15 === 0) reply.raw.write(": heartbeat\n\n");
          if (reply.raw.writableLength > 1_000_000) reply.raw.end();
        } catch {
          reply.raw.end();
        }
      }, 1000);
      timer.unref();
      streams.add(timer);
      reply.raw.on("close", () => {
        clearInterval(timer);
        streams.delete(timer);
        connections.delete(reply.raw);
      });
    },
  );
  app.addHook("preClose", async () => {
    for (const stream of streams) clearInterval(stream);
    for (const response of connections) response.end();
  });
  app.addHook("onClose", async () => store.close());
  return app;
}

function requestSafeLog(app: FastifyInstance, error: unknown) {
  app.log.error(
    { code: (error as { code?: string }).code ?? "UNEXPECTED_ERROR" },
    "request failed",
  );
}
