import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Decimal from "decimal.js";
import type {
  Bar,
  DecisionEvent,
  Funds,
  Instrument,
  Plan,
  PlanInput,
  RiskResult,
  FeedbackInput,
  FeedbackRevision,
  FeedbackDeviationCode,
  SupportPreviewInput,
  SupportSnapshot,
  ScreeningParameters,
  ScreeningSettings,
} from "../../packages/contracts/index.js";
import type {
  AttemptState,
  TriggerEvent,
} from "../../packages/domain/trigger.js";
import { solveRisk } from "../../packages/domain/risk.js";
import { freezeSupport } from "../../packages/domain/plan-support.js";
import {
  DEFAULT_SCREENING_PARAMETERS,
  normalizeScreeningParameters,
} from "../../packages/domain/screening-rules.js";
import {
  currentScreeningRule,
  insertScreeningRule,
  makeScreeningRule,
} from "./screening-settings.js";
import { initializeDatabase } from "./migrations.js";
import { eventPage, eventFeed, type EventPageQuery } from "./events-feed.js";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(row: unknown): T | null =>
  row ? (JSON.parse((row as { json: string }).json) as T) : null;
const activeStatuses = ["WAIT_RETEST", "ARMED", "DATA_PAUSED", "TRIGGERED"];
export interface StoredInstrument {
  instrument: Instrument;
  tags: string[];
  note: string;
  manual: boolean;
}
export interface Reservation {
  planId: string;
  attemptId: string;
  generation: number;
  currency: string;
  instrumentId: string;
  quantity: number;
  cash: string;
  riskBase: string;
  exposureBase: string;
  allocationOrder: number;
  state: "ACTIVE" | "TAKEN_PENDING" | "RELEASED";
}
export interface TechnicalDecision {
  entry: string;
  time: number;
  receivedAt: number;
  refId: string;
  historical: boolean;
  reasons?: string[];
  snapshot: Record<string, unknown>;
  actionable?: boolean;
  simulationClock: {
    quoteAt: number;
    receivedAt: number;
    sessionOpenAt: number;
  };
}

/** All balance decisions run under BEGIN IMMEDIATE on a real SQLite connection. */
export class Store {
  readonly db: Database.Database;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      initializeDatabase(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  setting(key: string): string | null {
    return (
      (
        this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  screeningSettings(): ScreeningSettings {
    const current = currentScreeningRule(this.db);
    return {
      version: current?.version ?? 0,
      current,
      defaultParameters: DEFAULT_SCREENING_PARAMETERS,
    };
  }
  confirmScreening(
    parameters: ScreeningParameters | undefined,
    expectedVersion: number | undefined,
    now: number,
  ): ScreeningSettings {
    return this.transaction(() => {
      const current = currentScreeningRule(this.db);
      // The old one-click endpoint can confirm defaults only once. Its retries never overwrite a later version.
      if (parameters === undefined && current) return this.screeningSettings();
      if (
        parameters !== undefined &&
        expectedVersion !== (current?.version ?? 0)
      )
        throw new ApiError(
          409,
          "SCREENING_VERSION_CONFLICT",
          "筛选参数已有新版本，请读取后重新确认；输入已保留",
        );
      let normalized: ScreeningParameters;
      try {
        normalized = normalizeScreeningParameters(
          parameters === undefined ? DEFAULT_SCREENING_PARAMETERS : parameters,
        );
      } catch {
        throw new ApiError(
          400,
          "INVALID_SCREENING_PARAMETERS",
          "筛选参数须使用有效十进制金额、ADR 范围及 1–30 的每市场上限",
        );
      }
      const rule = makeScreeningRule(
        (current?.version ?? 0) + 1,
        normalized,
        now,
      );
      insertScreeningRule(this.db, rule);
      this.setSetting("screening_confirmed", "true");
      return this.screeningSettings();
    });
  }
  listInstruments(): StoredInstrument[] {
    return (
      this.db.prepare("SELECT json FROM instruments ORDER BY id").all() as {
        json: string;
      }[]
    ).map((row) => JSON.parse(row.json));
  }
  instrument(id: string): StoredInstrument {
    const result = parse<StoredInstrument>(
      this.db.prepare("SELECT json FROM instruments WHERE id=?").get(id),
    );
    if (!result) throw new ApiError(404, "NOT_FOUND", "找不到该标的");
    return result;
  }
  putInstrument(row: StoredInstrument) {
    this.db
      .prepare(
        "INSERT INTO instruments VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(row.instrument.id, json(row));
  }
  deleteInstrument(id: string) {
    this.instrument(id);
    if (this.plans().some((p) => p.instrumentId === id))
      throw new ApiError(
        409,
        "INSTRUMENT_HAS_PLANS",
        "标的已有计划，请保留其研究与历史引用",
      );
    this.db.prepare("DELETE FROM instruments WHERE id=?").run(id);
  }
  putBars(id: string, period: string, bars: Bar[]) {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO bars VALUES(?,?,?,?,?)",
    );
    for (const bar of bars) stmt.run(id, period, bar.id, bar.time, json(bar));
  }
  bars(id: string, period: string): Bar[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM bars WHERE instrument_id=? AND period=? ORDER BY time,bar_id",
        )
        .all(id, period) as { json: string }[]
    ).map((row) => JSON.parse(row.json));
  }
  private supportBars(
    id: string,
    knownAt: number,
    sessionDate?: string,
  ): Bar[] {
    return this.bars(id, "1D").filter(
      (bar) =>
        bar.final &&
        bar.receivedAt <= knownAt &&
        (!sessionDate ||
          new Date(bar.time * 1000).toISOString().slice(0, 10) < sessionDate),
    );
  }
  private revision(value: unknown): string {
    return createHash("sha256").update(json(value)).digest("hex");
  }
  supportPreview(
    input: Omit<SupportPreviewInput, "supportSelections"> & {
      supportSelections?: SupportPreviewInput["supportSelections"];
    },
    now: number,
    reason = "",
    sessionDate?: string,
  ): SupportSnapshot {
    const instrument = this.instrument(input.instrumentId).instrument;
    const bars = this.supportBars(input.instrumentId, now, sessionDate);
    // Only the server-installed synthetic fixture has a verified history today.
    // Real feed metadata is kept in quarantine until independent validation exists.
    const synthetic =
      instrument.id.startsWith("DEMO-") &&
      bars.length > 0 &&
      bars.every(
        (bar) =>
          bar.id.startsWith("synthetic:") &&
          (bar as Bar & { synthetic?: boolean }).synthetic === true,
      );
    return freezeSupport(
      { ...input, supportSelections: input.supportSelections ?? [] },
      instrument,
      {
        bars,
        historyComplete: synthetic,
        adjustmentVerified: synthetic,
        synthetic,
        dataRevision: this.revision(bars),
        instrumentRevision: this.revision(instrument),
      },
      now,
      reason,
    );
  }
  /** Compare all daily inputs, including EMA seeds and the AVWAP anchor, with the frozen version. */
  supportRevisionReasons(plan: Plan, now: number): string[] {
    const frozen = plan.supportSnapshot;
    if (!frozen || frozen.schemaVersion !== 2)
      return ["SUPPORT_SNAPSHOT_REQUIRED"];
    const reasons: string[] = [];
    const instrument = this.instrument(plan.instrumentId).instrument;
    if (this.revision(instrument) !== frozen.instrumentRevision)
      reasons.push("INSTRUMENT_REVISION_CHANGED");
    const daily = this.bars(plan.instrumentId, "1D").filter(
      (bar) =>
        bar.final &&
        bar.receivedAt <= now &&
        new Date(bar.time * 1000).toISOString().slice(0, 10) < plan.sessionDate,
    );
    if (this.revision(daily) !== frozen.dataRevision)
      reasons.push("PLAN_DATA_REVISION_CHANGED");
    return reasons;
  }
  invalidateEvidence(
    instrumentId: string,
    reason: string,
    now: number,
    onlyChanged = false,
  ) {
    return this.transaction(() => {
      for (const p of this.plans()) {
        if (
          p.instrumentId !== instrumentId ||
          !["WAIT_RETEST", "ARMED"].includes(p.status)
        )
          continue;
        const changed = onlyChanged
          ? this.supportRevisionReasons(p, now)
          : [reason];
        if (!changed.length) continue;
        const planReason = changed[0];
        this.writePlan({ ...p, status: "DATA_PAUSED", updatedAt: now });
        this.insertEvent(
          p,
          "DATA_PAUSED",
          `${p.attemptId}:evidence:${planReason}`,
          now,
          now,
          "计划依据已变化，请核对数据并保存新版本",
          changed,
          null,
          true,
          {
            planVersion: this.planVersion(p),
            reason: planReason,
            synthetic: p.instrumentId.startsWith("DEMO-"),
          },
        );
      }
    });
  }
  plans(): Plan[] {
    return (
      this.db.prepare("SELECT json FROM plans ORDER BY rowid DESC").all() as {
        json: string;
      }[]
    ).map((row) => JSON.parse(row.json));
  }
  plan(id: string): Plan {
    const p = parse<Plan>(
      this.db.prepare("SELECT json FROM plans WHERE id=?").get(id),
    );
    if (!p) throw new ApiError(404, "NOT_FOUND", "找不到该计划");
    return p;
  }
  planVersion(plan: Plan): Plan & {
    instrument: Instrument;
    previousDailyBar: Bar | null;
    anchorBar: Bar | null;
  } {
    return parse(
      this.db
        .prepare("SELECT json FROM plan_versions WHERE plan_id=? AND version=?")
        .get(plan.id, plan.version),
    )!;
  }
  private writePlan(plan: Plan) {
    this.db
      .prepare(
        "INSERT INTO plans VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,json=excluded.json",
      )
      .run(plan.id, plan.version, json(plan));
  }
  private assertVersion(plan: Plan, expected: number) {
    if (plan.version !== expected)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        `计划已有新版本 ${plan.version}，请重新读取；输入已保留`,
      );
  }
  createPlan(input: PlanInput, now: number): Plan {
    return this.transaction(() => {
      this.instrument(input.instrumentId);
      const p: Plan = {
        ...input,
        screeningRuleSnapshot: currentScreeningRule(this.db),
        supportSnapshot: this.supportPreview(
          input,
          now,
          input.reason,
          input.sessionDate,
        ),
        id: randomUUID(),
        version: 1,
        status: "DRAFT",
        attemptId: null,
        approvedQuantity: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.writePlan(p);
      this.savePlanVersion(p, now);
      return p;
    });
  }
  private savePlanVersion(p: Plan, now: number) {
    const bars = this.supportBars(p.instrumentId, now, p.sessionDate);
    const anchor = bars.find((bar) => bar.time === p.anchorTime);
    this.db.prepare("INSERT INTO plan_versions VALUES(?,?,?)").run(
      p.id,
      p.version,
      json({
        ...p,
        frozenAt: now,
        anchorBar: anchor ?? null,
        previousDailyBar: bars.at(-1) ?? null,
        instrument: this.instrument(p.instrumentId).instrument,
        algorithmVersion: "pullback-c01-c07-v1",
        supportDailyBars: bars,
      }),
    );
  }
  updatePlan(
    id: string,
    input: PlanInput,
    expected: number,
    now: number,
  ): Plan {
    return this.transaction(() => {
      const old = this.plan(id);
      this.assertVersion(old, expected);
      if (old.status === "TRIGGERED")
        throw new ApiError(
          409,
          "PENDING_ENTRY",
          "先记录该入场提醒已交易或已跳过，再修改计划",
        );
      this.instrument(input.instrumentId);
      this.release(id);
      const p: Plan = {
        ...input,
        screeningRuleSnapshot: currentScreeningRule(this.db),
        supportSnapshot: this.supportPreview(
          input,
          now,
          input.reason,
          input.sessionDate,
        ),
        id,
        version: old.version + 1,
        status: "DRAFT",
        attemptId: null,
        approvedQuantity: 0,
        createdAt: old.createdAt,
        updatedAt: now,
      };
      this.writePlan(p);
      this.savePlanVersion(p, now);
      return p;
    });
  }
  funds(): Funds | null {
    const gen = this.setting("funds_generation");
    return gen
      ? parse<Funds>(
          this.db
            .prepare("SELECT json FROM account_snapshots WHERE generation=?")
            .get(Number(gen)),
        )
      : null;
  }
  private writeFunds(f: Funds) {
    this.db
      .prepare("INSERT INTO account_snapshots VALUES(?,?)")
      .run(f.generation, json(f));
    this.setSetting("funds_generation", String(f.generation));
  }
  reservations(): Reservation[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM reservations ORDER BY allocation_order,plan_id",
        )
        .all() as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }
  private writeReservation(r: Reservation) {
    this.db
      .prepare(
        "INSERT INTO reservations VALUES(?,?,?) ON CONFLICT(plan_id) DO UPDATE SET allocation_order=excluded.allocation_order,json=excluded.json",
      )
      .run(r.planId, r.allocationOrder, json(r));
  }
  private release(planId: string) {
    const old = this.reservations().find((r) => r.planId === planId);
    // A reported trade remains locked until a new account snapshot explicitly
    // absorbs it. Editing, pausing or expiring a plan cannot turn spent cash
    // back into available cash, including after a historical feedback correction.
    if (old?.state === "ACTIVE")
      this.writeReservation({ ...old, state: "RELEASED" });
  }
  private totals(plan: Plan) {
    const currency = this.instrument(plan.instrumentId).instrument.currency;
    const others = this.reservations().filter(
      (r) => r.planId !== plan.id && r.state !== "RELEASED",
    );
    const sum = (
      rows: Reservation[],
      key: "cash" | "riskBase" | "exposureBase",
    ) => rows.reduce((s, r) => s.plus(r[key]), new Decimal(0)).toFixed();
    return {
      cash: sum(
        others.filter((r) => r.currency === currency),
        "cash",
      ),
      riskBase: sum(others, "riskBase"),
      exposureBase: sum(
        others.filter((r) => r.instrumentId === plan.instrumentId),
        "exposureBase",
      ),
    };
  }
  risk(
    plan: Plan,
    now: number,
    entry = plan.entryMax,
    approvedQuantity?: number,
    phase: "PLAN" | "TRIGGER" = "PLAN",
  ): RiskResult {
    const funds = this.funds();
    const pendingTrade = this.reservations().some(
      (r) => r.planId === plan.id && r.state === "TAKEN_PENDING",
    );
    if (!funds || pendingTrade)
      return {
        quantity: 0,
        entry,
        stopExec: plan.stop,
        cashUse: "0",
        riskBase: "0",
        exposureBase: "0",
        reasons: [
          pendingTrade
            ? "TAKEN_RECONCILIATION_REQUIRED"
            : "FUNDS_NOT_CONFIRMED",
        ],
        passed: false,
      };
    return solveRisk({
      instrument: this.instrument(plan.instrumentId).instrument,
      funds,
      entryCheck: entry,
      entryMin: plan.entryMin,
      entryMax: plan.entryMax,
      stop: plan.stop,
      now,
      approvedQuantity,
      phase,
      reservations: this.totals(plan),
    });
  }
  replayRisk(
    plan: Plan,
    currentNow: number,
    entry: string,
    clock: TechnicalDecision["simulationClock"],
  ): RiskResult {
    // Values are a present-day user scenario, explicitly mapped onto fixture time.
    // This does not upgrade the age or capability of any real quote.
    const baseline = this.risk(
      plan,
      currentNow,
      plan.entryMax,
      plan.approvedQuantity,
    );
    if (!baseline.passed) return baseline;
    const original = this.funds()!;
    const scenarioFunds = {
      ...original,
      confirmedAt: clock.sessionOpenAt,
      fxAsOf: clock.sessionOpenAt,
    };
    return solveRisk({
      instrument: this.instrument(plan.instrumentId).instrument,
      funds: scenarioFunds,
      entryCheck: entry,
      entryMin: plan.entryMin,
      entryMax: plan.entryMax,
      stop: plan.stop,
      now: clock.receivedAt,
      quoteAsOf: clock.quoteAt,
      sessionStartedAt: clock.sessionOpenAt,
      approvedQuantity: plan.approvedQuantity,
      phase: "TRIGGER",
      reservations: this.totals(plan),
    });
  }
  activate(
    id: string,
    expected: number,
    now: number,
    recovery?: {
      expectedAttemptId: string | null;
      recovery: true;
      sourceAttemptId: string;
    },
  ): { plan: Plan; risk: RiskResult } {
    return this.transaction(() => {
      const p = this.plan(id);
      this.assertVersion(p, expected);
      let recoveryQuantity: number | undefined;
      if (recovery) {
        if (p.attemptId !== recovery.expectedAttemptId)
          throw new ApiError(
            409,
            "ATTEMPT_CONFLICT",
            "当前尝试已改变，请重新读取",
          );
        const previous = this.db
          .prepare("SELECT * FROM attempts WHERE id=?")
          .get(recovery.sourceAttemptId) as
          | {
              plan_id: string;
              plan_version: number;
              consumed: number;
              json: string;
            }
          | undefined;
        if (
          !previous ||
          previous.plan_id !== p.id ||
          previous.consumed ||
          !(
            ["DATA_PAUSED", "USER_PAUSED"].includes(p.status) ||
            (p.status === "DRAFT" && p.attemptId === null)
          )
        )
          throw new ApiError(
            409,
            "RECOVERY_UNAVAILABLE",
            "只有尚未消费且已暂停的尝试可以建立恢复后新尝试",
          );
        const sourcePlan = parse<Plan>(
          this.db
            .prepare(
              "SELECT json FROM plan_versions WHERE plan_id=? AND version=?",
            )
            .get(p.id, previous.plan_version),
        );
        if (
          sourcePlan?.sessionDate !== p.sessionDate ||
          sourcePlan.instrumentId !== p.instrumentId
        )
          throw new ApiError(
            409,
            "RECOVERY_SOURCE_CHANGED",
            "恢复尝试必须沿用原证券与交易会话",
          );
        const source = JSON.parse(previous.json) as {
          approvedQuantity?: number;
        };
        const previousReservation = this.reservations().find(
          (r) => r.planId === id && r.attemptId === recovery.sourceAttemptId,
        );
        recoveryQuantity =
          p.approvedQuantity > 0
            ? p.approvedQuantity
            : (source.approvedQuantity ?? previousReservation?.quantity);
        if (!Number.isSafeInteger(recoveryQuantity) || recoveryQuantity! <= 0)
          throw new ApiError(
            409,
            "RECOVERY_QUANTITY_UNAVAILABLE",
            "原尝试的批准数量不可用，请重新核对计划",
          );
      }
      if (
        this.reservations().some(
          (r) => r.planId === id && r.state === "TAKEN_PENDING",
        )
      )
        throw new ApiError(
          409,
          "TAKEN_RECONCILIATION_REQUIRED",
          "该计划的已交易占用尚待核对，请先确认已包含实际交易的新资金快照",
        );
      const supportReasons = this.supportRevisionReasons(p, now);
      if (supportReasons.length)
        throw new ApiError(
          422,
          supportReasons[0],
          "支撑依据缺失或已修订，请显式保存新的计划版本",
        );
      if (!p.supportSnapshot?.ready)
        throw new ApiError(
          422,
          "SUPPORT_NOT_READY",
          p.supportSnapshot?.reasons.join("；") ?? "支撑快照缺失",
        );
      if (activeStatuses.includes(p.status) && !recovery) {
        if (p.attemptId && p.status === "WAIT_RETEST")
          return {
            plan: p,
            risk: this.risk(p, now, p.entryMax, p.approvedQuantity),
          };
        throw new ApiError(
          409,
          "ATTEMPT_ACTIVE",
          "当前尝试尚未结束，请先处理当前计划",
        );
      }
      if (
        this.plans().filter(
          (x) => x.id !== p.id && activeStatuses.includes(x.status),
        ).length >= 10
      )
        throw new ApiError(422, "MONITOR_LIMIT", "最多同时监测 10 个计划");
      const risk = this.risk(p, now, p.entryMax, recoveryQuantity);
      if (!risk.passed)
        throw new ApiError(422, "RISK_BLOCKED", risk.reasons.join("；"));
      const attemptId = randomUUID();
      const updated: Plan = {
        ...p,
        attemptId,
        status: "WAIT_RETEST",
        approvedQuantity: risk.quantity,
        updatedAt: now,
      };
      this.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?)").run(
        attemptId,
        id,
        p.version,
        0,
        json({
          startedAt: now,
          evidenceEpoch: randomUUID(),
          kind: "SYNTHETIC_REPLAY",
          version: p.version,
          approvedQuantity: risk.quantity,
          ...(recovery
            ? {
                template: "RECOVERY",
                parentAttemptId: recovery.sourceAttemptId,
              }
            : {}),
        }),
      );
      this.writePlan(updated);
      const maxOrder = this.reservations().reduce(
        (m, r) => Math.max(m, r.allocationOrder),
        0,
      );
      const previousReservation = recovery
        ? this.reservations().find((r) => r.planId === id)
        : undefined;
      this.writeReservation({
        planId: id,
        attemptId,
        generation: this.funds()!.generation,
        currency: this.instrument(p.instrumentId).instrument.currency,
        instrumentId: p.instrumentId,
        quantity: risk.quantity,
        cash: risk.cashUse,
        riskBase: risk.riskBase,
        exposureBase: risk.exposureBase,
        allocationOrder: previousReservation?.allocationOrder ?? maxOrder + 1,
        state: "ACTIVE",
      });
      return { plan: updated, risk };
    });
  }
  pause(id: string, expected: number, now: number): Plan {
    return this.transaction(() => {
      const p = this.plan(id);
      this.assertVersion(p, expected);
      if (p.status === "TRIGGERED")
        throw new ApiError(
          409,
          "PENDING_ENTRY",
          "提醒尚待处理；请明确记录已交易或已跳过",
        );
      if (["TAKEN", "SKIPPED"].includes(p.status))
        throw new ApiError(
          409,
          "ATTEMPT_FINISHED",
          "该尝试已经完成；如需继续观察，请显式启用新的尝试",
        );
      const updated = { ...p, status: "USER_PAUSED", updatedAt: now };
      this.release(id);
      this.writePlan(updated);
      return updated;
    });
  }
  updateFunds(input: Funds, expected: number, now: number): Funds {
    return this.transaction(() => {
      const current = this.funds();
      if ((current?.generation ?? 0) !== expected)
        throw new ApiError(
          409,
          "FUNDS_GENERATION_CONFLICT",
          "资金状态已经变化，请重新核对实际现金和已有敞口",
        );
      const next: Funds = {
        ...input,
        generation: expected + 1,
        confirmedAt: now,
        stale: false,
      };
      const reservations = this.reservations();
      // New cash/existing values already include TAKEN records; do not deduct them twice.
      for (const r of reservations)
        this.writeReservation({ ...r, state: "RELEASED" });
      this.writeFunds(next);
      // Pending entry records retain their original conservative lock until explicit
      // TAKEN/SKIPPED. A new cash form must never bypass that lifecycle.
      for (const r of reservations.filter((r) => r.state === "ACTIVE")) {
        if (this.plan(r.planId).status === "TRIGGERED")
          this.writeReservation({
            ...r,
            generation: next.generation,
            state: "ACTIVE",
          });
      }
      for (const r of reservations.filter((r) => r.state === "ACTIVE")) {
        const p = this.plan(r.planId);
        if (p.status === "TRIGGERED") continue;
        if (!activeStatuses.includes(p.status)) continue;
        const risk = this.risk(p, now, p.entryMax, p.approvedQuantity);
        if (risk.passed)
          this.writeReservation({
            ...r,
            generation: next.generation,
            quantity: risk.quantity,
            cash: risk.cashUse,
            riskBase: risk.riskBase,
            exposureBase: risk.exposureBase,
            state: "ACTIVE",
          });
        else {
          this.writePlan({ ...p, status: "DATA_PAUSED", updatedAt: now });
          this.insertEvent(
            p,
            "FUNDS_REBUILD_BLOCKED",
            `funds:${next.generation}:${p.id}`,
            now,
            now,
            "新资金快照不足，计划已暂停",
            risk.reasons,
            0,
            true,
            { funds: next, plan: p, risk },
          );
        }
      }
      return next;
    });
  }
  private inputHash(snapshot: Record<string, unknown>): string {
    const encoded = json(snapshot);
    const hash = createHash("sha256").update(encoded).digest("hex");
    this.db
      .prepare(
        "INSERT INTO decision_inputs SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM decision_inputs WHERE hash=?)",
      )
      .run(hash, encoded, hash);
    return hash;
  }
  private insertEvent(
    p: Plan,
    type: string,
    key: string,
    time: number,
    receivedAt: number,
    message: string,
    reasons: string[],
    quantity: number | null,
    historical: boolean,
    snapshot: Record<string, unknown>,
  ): DecisionEvent {
    const existing = parse<DecisionEvent>(
      this.db
        .prepare("SELECT json FROM decision_events WHERE event_key=?")
        .get(key),
    );
    if (existing) return existing;
    const inputHash = this.inputHash(snapshot);
    const event: DecisionEvent = {
      id: randomUUID(),
      planId: p.id,
      attemptId: p.attemptId ?? `draft:${p.id}`,
      type,
      time,
      receivedAt,
      message,
      reasons,
      quantity,
      historical,
      read: false,
      feedback: null,
      snapshot: { ...snapshot, inputHash },
    };
    this.db
      .prepare(
        "INSERT INTO decision_events(id,attempt_id,type,event_key,input_hash,json) VALUES(?,?,?,?,?,?)",
      )
      .run(event.id, event.attemptId, type, key, inputHash, json(event));
    this.db
      .prepare("INSERT INTO notifications VALUES(?,?)")
      .run(event.id, receivedAt);
    return event;
  }
  commitTechnical(
    id: string,
    expectedVersion: number,
    attemptId: string,
    decision: TechnicalDecision,
    now: number,
  ): DecisionEvent[] {
    return this.transaction(() => {
      const p = this.plan(id);
      this.assertVersion(p, expectedVersion);
      if (
        !decision.historical ||
        decision.snapshot.synthetic !== true ||
        !p.instrumentId.startsWith("DEMO-")
      )
        throw new ApiError(
          422,
          "SYNTHETIC_ONLY",
          "当前提交入口只接受明确合成历史回放",
        );
      if (p.attemptId !== attemptId)
        throw new ApiError(409, "ATTEMPT_CONFLICT", "当前尝试已改变");
      const attempt = this.db
        .prepare("SELECT consumed FROM attempts WHERE id=?")
        .get(attemptId) as { consumed: number } | undefined;
      if (!attempt)
        throw new ApiError(409, "ATTEMPT_MISSING", "当前计划尚未启用");
      if (attempt.consumed) return this.eventsForAttempt(attemptId);
      if (!["WAIT_RETEST", "ARMED"].includes(p.status))
        throw new ApiError(409, "ATTEMPT_INACTIVE", "当前尝试已经暂停或结束");
      const risk = this.replayRisk(
        p,
        now,
        decision.entry,
        decision.simulationClock,
      );
      const reasons = [
        ...new Set([...(decision.reasons ?? []), ...risk.reasons]),
      ];
      const passed =
        risk.passed && decision.actionable !== false && reasons.length === 0;
      const snapshot = {
        ...decision.snapshot,
        plan: p,
        planVersion: parse(
          this.db
            .prepare(
              "SELECT json FROM plan_versions WHERE plan_id=? AND version=?",
            )
            .get(p.id, p.version),
        ),
        funds: this.funds(),
        scenarioFunds: {
          ...this.funds(),
          confirmedAt: decision.simulationClock.sessionOpenAt,
          fxAsOf: decision.simulationClock.sessionOpenAt,
        },
        simulationClock: decision.simulationClock,
        reservations: this.reservations(),
        risk,
        decisionTime: now,
        algorithmVersion: "pullback-c01-c07-v1",
        synthetic: true,
      };
      this.db
        .prepare("UPDATE attempts SET consumed=1,json=? WHERE id=?")
        .run(json({ ...decision.snapshot, consumed: true }), attemptId);
      const technical = this.insertEvent(
        p,
        "TECHNICAL_TRIGGERED",
        `${attemptId}:technical`,
        decision.time,
        decision.receivedAt,
        "合成回放：首次回踩后的技术突破",
        [],
        null,
        decision.historical,
        snapshot,
      );
      let final: DecisionEvent;
      if (passed) {
        const old = this.reservations().find((r) => r.planId === id)!;
        this.writeReservation({
          ...old,
          quantity: risk.quantity,
          cash: risk.cashUse,
          riskBase: risk.riskBase,
          exposureBase: risk.exposureBase,
        });
        this.writePlan({ ...p, status: "TRIGGERED", updatedAt: now });
        final = this.insertEvent(
          p,
          "HISTORICAL_TRIGGERED",
          `${attemptId}:entry`,
          decision.time,
          decision.receivedAt,
          "合成回放通过风险检查，等待记录；不是实时交易信号",
          [],
          risk.quantity,
          true,
          snapshot,
        );
      } else {
        this.release(id);
        this.writePlan({ ...p, status: "USER_PAUSED", updatedAt: now });
        final = this.insertEvent(
          p,
          "RISK_BLOCKED",
          `${attemptId}:blocked`,
          decision.time,
          decision.receivedAt,
          "合成回放技术命中，但入场检查被阻断；本次尝试已消费",
          reasons.length ? reasons : ["GATE_UNAVAILABLE"],
          0,
          true,
          snapshot,
        );
      }
      return [technical, final];
    });
  }
  /** Persist only trusted synthetic runner results; real capability remains closed. */
  commitRuntimeTransition(
    id: string,
    expectedVersion: number,
    attemptId: string,
    state: AttemptState,
    events: TriggerEvent[],
    snapshot: Record<string, unknown>,
    now: number,
  ): void {
    this.transaction(() => {
      const p = this.plan(id);
      this.assertVersion(p, expectedVersion);
      if (
        p.attemptId !== attemptId ||
        state.attemptId !== attemptId ||
        state.planVersion !== expectedVersion
      )
        throw new ApiError(409, "ATTEMPT_CONFLICT", "当前尝试已改变");
      if (snapshot.synthetic !== true || !p.instrumentId.startsWith("DEMO-"))
        throw new ApiError(
          422,
          "SYNTHETIC_ONLY",
          "运行入口只接受服务端合成历史输入",
        );
      const attempt = this.db
        .prepare("SELECT consumed FROM attempts WHERE id=?")
        .get(attemptId) as { consumed: number } | undefined;
      if (!attempt)
        throw new ApiError(409, "ATTEMPT_MISSING", "当前计划尚未启用");
      if (state.status === "EXPIRED" && state.consumed && !attempt.consumed)
        this.db
          .prepare("UPDATE attempts SET consumed=1,json=? WHERE id=?")
          .run(json({ ...snapshot, consumed: true }), attemptId);
      if (!attempt.consumed) {
        if (["INVALID", "EXPIRED", "USER_PAUSED"].includes(state.status))
          this.release(id);
        if (
          [
            "WAIT_RETEST",
            "ARMED",
            "DATA_PAUSED",
            "INVALID",
            "EXPIRED",
            "USER_PAUSED",
          ].includes(state.status)
        )
          this.writePlan({ ...p, status: state.status, updatedAt: now });
      }
      for (const event of events) {
        const lateReference =
          state.status === "EXPIRED" &&
          state.consumed &&
          event.type === "TECHNICAL_TRIGGERED";
        if (
          [
            "TECHNICAL_TRIGGERED",
            "ENTRY_TRIGGERED",
            "HISTORICAL_TRIGGERED",
          ].includes(event.type) &&
          !lateReference
        )
          continue;
        if (
          attempt.consumed &&
          !["BREAKOUT_FADED", "STOP_REFERENCE_TOUCHED", "DATA_PAUSED"].includes(
            event.type,
          ) &&
          !lateReference
        )
          continue;
        const type = lateReference ? "LATE_TECHNICAL_REFERENCE" : event.type;
        // The pure reducer's emitted evidence stays untouched in snapshot. This
        // server-owned synthetic adapter marks its persisted presentation historical.
        this.insertEvent(
          p,
          type,
          `${attemptId}:runtime:${type}`,
          event.time,
          event.receivedAt,
          lateReference
            ? "合成迟到技术参考：尝试已过期，不恢复预算或入场提醒"
            : `合成运行：${type}`,
          event.reasons,
          lateReference ? null : (event.quantity ?? null),
          true,
          snapshot,
        );
      }
    });
  }
  recordReplayState(
    id: string,
    expected: number,
    status: string,
    now: number,
    snapshot: Record<string, unknown>,
    reasons: string[],
  ): DecisionEvent[] {
    return this.transaction(() => {
      const p = this.plan(id);
      this.assertVersion(p, expected);
      if (
        this.eventsForAttempt(p.attemptId ?? `draft:${p.id}`).some(
          (e) => e.type === "TECHNICAL_TRIGGERED",
        )
      )
        return this.eventsForAttempt(p.attemptId ?? `draft:${p.id}`);
      if (["INVALID", "EXPIRED", "USER_PAUSED"].includes(status))
        this.release(id);
      this.writePlan({ ...p, status, updatedAt: now });
      return [
        this.insertEvent(
          p,
          "REPLAY_RESULT",
          `${p.attemptId}:result`,
          now,
          now,
          `合成回放结束：${status}`,
          reasons,
          null,
          true,
          snapshot,
        ),
      ];
    });
  }
  eventPage(query: EventPageQuery = {}) {
    return eventPage(this.db, query);
  }
  eventFeed(after?: string) {
    return eventFeed(this.db, after);
  }
  events(after?: string): DecisionEvent[] {
    let seq = 0;
    if (after) {
      const row = this.db
        .prepare("SELECT seq FROM decision_events WHERE id=?")
        .get(after) as { seq: number } | undefined;
      if (!row)
        throw new ApiError(
          409,
          "CURSOR_EXPIRED",
          "事件游标不可用，请重新获取完整提醒列表",
        );
      seq = row.seq;
    }
    return this.readEvents("e.seq>?", [seq]);
  }
  eventsForAttempt(attemptId: string): DecisionEvent[] {
    return this.readEvents("e.attempt_id=?", [attemptId]);
  }
  private readEvents(
    where: string,
    params: (string | number)[],
  ): DecisionEvent[] {
    return (
      this.db
        .prepare(
          `SELECT e.json,a.read_at,(SELECT r.json FROM record_revisions r WHERE r.event_id=e.id ORDER BY r.rowid DESC LIMIT 1) feedback_json FROM decision_events e LEFT JOIN notification_ack a ON a.event_id=e.id WHERE ${where} ORDER BY e.seq`,
        )
        .all(...params) as {
        json: string;
        read_at: number | null;
        feedback_json: string | null;
      }[]
    ).map((row) => ({
      ...JSON.parse(row.json),
      read: row.read_at !== null,
      feedback: row.feedback_json ? JSON.parse(row.feedback_json).kind : null,
    }));
  }
  readEvent(id: string, now: number) {
    this.event(id);
    this.db
      .prepare("INSERT OR IGNORE INTO notification_ack VALUES(?,?)")
      .run(id, now);
  }
  event(id: string): DecisionEvent {
    const e = this.readEvents("e.id=?", [id])[0];
    if (!e) throw new ApiError(404, "NOT_FOUND", "找不到该事件");
    return e;
  }
  feedback(id: string, input: FeedbackInput, now: number) {
    return this.transaction(() => {
      const event = this.event(id);
      if (!["ENTRY_TRIGGERED", "HISTORICAL_TRIGGERED"].includes(event.type))
        throw new ApiError(
          422,
          "NOT_ENTRY_EVENT",
          "只有通过风险检查的入场提醒可以记录已交易或已跳过",
        );
      const oldRows = this.db
        .prepare(
          "SELECT id,json FROM record_revisions WHERE event_id=? ORDER BY rowid",
        )
        .all(id) as { id: string; json: string }[];
      const old = oldRows.at(-1);
      const prior = old ? (JSON.parse(old.json) as FeedbackInput) : null;
      const fields = [
        "kind",
        "note",
        "actualPrice",
        "actualQuantity",
        "actualTime",
      ] as const;
      if (prior && fields.every((field) => prior[field] === input[field]))
        return;
      if (
        input.expectedRevisionId !== undefined &&
        input.expectedRevisionId !== (old?.id ?? null)
      )
        throw new ApiError(
          409,
          "FEEDBACK_REVISION_CONFLICT",
          "记录已被其他页面更新；输入已保留，请重新读取后再保存",
        );
      const { expectedRevisionId: _expectedRevisionId, ...record } = input;
      const revision: FeedbackRevision = {
        ...record,
        id: randomUUID(),
        recordedAt: now,
        deviationCodes: this.feedbackDeviations(event, input),
        assessmentVersion: "feedback-v1",
      };
      this.db
        .prepare("INSERT INTO record_revisions VALUES(?,?,?,?)")
        .run(revision.id, id, now, json(revision));
      const p = this.plan(event.planId);
      // Historical corrections do not mutate a newer attempt's runtime state.
      if (p.attemptId === event.attemptId)
        this.writePlan({ ...p, status: input.kind, updatedAt: now });
      const everTaken = oldRows.some(
        (r) => JSON.parse(r.json).kind === "TAKEN",
      );
      if (input.kind === "TAKEN" && !everTaken) {
        const funds = this.funds();
        if (funds)
          this.writeFunds({
            ...funds,
            generation: funds.generation + 1,
            stale: true,
          });
        const reservation = this.reservations().find(
          (r) => r.attemptId === event.attemptId,
        );
        if (reservation)
          this.writeReservation({ ...reservation, state: "TAKEN_PENDING" });
      } else if (input.kind === "SKIPPED" && !everTaken) {
        const reservation = this.reservations().find(
          (r) => r.attemptId === event.attemptId,
        );
        if (reservation)
          this.writeReservation({ ...reservation, state: "RELEASED" });
      }
      this.readEvent(id, now);
    });
  }
  private feedbackDeviations(
    event: DecisionEvent,
    input: FeedbackInput,
  ): FeedbackDeviationCode[] {
    const snapshot = this.decisionInput(event.id);
    const plan = (snapshot.planVersion ?? snapshot.plan) as
      (Plan & { instrument?: Instrument }) | undefined;
    const codes: FeedbackDeviationCode[] = [];
    if (input.kind !== "TAKEN") return codes;
    if (
      input.actualPrice &&
      plan &&
      (new Decimal(input.actualPrice).lt(plan.entryMin) ||
        new Decimal(input.actualPrice).gt(plan.entryMax))
    )
      codes.push("ACTUAL_PRICE_OUTSIDE_ENTRY_RANGE");
    if (input.actualQuantity !== undefined) {
      if (event.quantity !== null && input.actualQuantity > event.quantity)
        codes.push("ACTUAL_QUANTITY_ABOVE_APPROVED");
      const rules = plan?.instrument;
      if (
        rules &&
        (input.actualQuantity < rules.qMin ||
          (input.actualQuantity - rules.qMin) % rules.qStep !== 0)
      )
        codes.push("ACTUAL_QUANTITY_RULE_MISMATCH");
    }
    if (input.actualTime !== undefined && input.actualTime < event.time)
      codes.push("ACTUAL_TIME_BEFORE_SIGNAL");
    return codes;
  }
  feedbackHistory(id: string): FeedbackRevision[] {
    this.event(id);
    return (
      this.db
        .prepare(
          "SELECT id,json,created_at FROM record_revisions WHERE event_id=? ORDER BY rowid",
        )
        .all(id) as { id: string; json: string; created_at: number }[]
    ).map((r) => ({
      deviationCodes: [],
      assessmentVersion: "legacy-unassessed" as const,
      ...JSON.parse(r.json),
      id: r.id,
      recordedAt: r.created_at,
    }));
  }
  /** Raw snapshots are immutable; this read never resolves current bars or funds. */
  decisionInput(eventId: string): Record<string, unknown> {
    const row = this.db
      .prepare(
        "SELECT i.json FROM decision_inputs i JOIN decision_events e ON e.input_hash=i.hash WHERE e.id=?",
      )
      .get(eventId);
    const input = parse<Record<string, unknown>>(row);
    if (!input) throw new ApiError(404, "NOT_FOUND", "找不到决策输入");
    return input;
  }
  async backup(destination: string) {
    mkdirSync(dirname(destination), { recursive: true });
    await this.db.backup(destination);
  }
  markRestored(now: number) {
    this.transaction(() => {
      const f = this.funds();
      if (f)
        this.writeFunds({ ...f, generation: f.generation + 1, stale: true });
      for (const p of this.plans())
        if (activeStatuses.includes(p.status) && p.status !== "TRIGGERED")
          this.writePlan({ ...p, status: "DATA_PAUSED", updatedAt: now });
      this.db.prepare("DELETE FROM sessions").run();
    });
  }
}
