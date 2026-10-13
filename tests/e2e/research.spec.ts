import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import Decimal from "decimal.js";
import type {
  Bootstrap,
  Plan,
  RiskResult,
  DecisionEvent,
} from "../../packages/contracts/index";

test("private API rejects anonymous access and cross-site writes", async ({
  request,
}) => {
  expect((await request.get("/api/bootstrap")).status()).toBe(401);
  expect(
    (
      await request.post("/api/login", {
        data: { password: "e2e-only-password" },
        headers: {
          Origin: "https://elsewhere.invalid",
          "X-Requested-With": "PullbackLab",
        },
      })
    ).status(),
  ).toBe(403);
});

test("research workflow preserves plans, records and stale-funds protection", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto("/");
  await page.getByLabel("访问密码").fill("e2e-only-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name: "设置与资金快照 ↗" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "载入合成示例数据" })
    .click();
  await expect(
    page.getByRole("button", { name: "填入明确的合成资金示例" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "填入明确的合成资金示例" }).click();
  await page.getByLabel(/我已按当前账户更新现金/).check();
  await page.getByRole("button", { name: /确认并保存资金/ }).click();
  await page.getByLabel("关闭设置").click();
  await page.getByRole("button", { name: "确认使用预设" }).click();
  await expect(
    page.getByRole("button", { name: "DEMO-A.US", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("candidates.png"),
    fullPage: true,
  });
  await page
    .locator("tr")
    .filter({ hasText: "DEMO-A.US" })
    .getByRole("button")
    .last()
    .click();
  await expect(page.locator("canvas").first()).toBeVisible();
  const chartResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/bars?") &&
      response.url().includes("anchorTime=") &&
      response.status() === 200,
  );
  await page.getByLabel("选择 AVWAP 锚点日期").selectOption({ index: 1 });
  await chartResponse;
  await page.screenshot({
    path: test.info().outputPath("research.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "填入合成示例计划" }).click();
  const support = page.getByRole("region", { name: "支撑家族与证据" });
  await expect(support).toContainText("支撑证据完整");
  await support.getByLabel("EMA 9", { exact: true }).uncheck();
  await expect(support).toContainText("待补充证据");
  await support.getByLabel("EMA 9", { exact: true }).check();
  await expect(support).toContainText("支撑证据完整");
  await page.getByLabel(/我已确认回踩背景/).check();
  await page.getByRole("button", { name: /保存研究计划|保存计划/ }).click();
  await expect(page.getByRole("button", { name: "保存新版本" })).toBeVisible();
  const existing = (
    (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap
  ).plans[0];
  const otherEditor = await page.request.post(
    `/api/plans/${existing.id}/versions`,
    {
      headers: { "X-Requested-With": "PullbackLab" },
      data: {
        ...existing,
        expectedVersion: existing.version,
        expectedAttemptId: existing.attemptId ?? null,
        reason: "另一个标签页的研究依据",
      },
    },
  );
  expect(otherEditor.status()).toBe(200);
  const localReason = "本标签页保留的研究依据，已核对并发变更";
  await page.getByLabel(/计划依据/).fill(localReason);
  await page.getByRole("button", { name: "保存新版本" }).click();
  const conflict = page.getByRole("region", { name: "计划版本冲突复核" });
  await expect(conflict).toBeVisible();
  await expect(page.getByLabel(/计划依据/)).toHaveValue(localReason);
  await conflict
    .getByRole("button", { name: "读取最新数据", exact: true })
    .click();
  await expect(conflict).toContainText("另一个标签页的研究依据");
  await conflict
    .getByRole("button", {
      name: "保留输入并基于最新版本继续编辑",
      exact: true,
    })
    .click();
  await expect(page.getByLabel(/计划依据/)).toHaveValue(localReason);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/plans/${existing.id}/versions`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存新版本" }).click();
  expect((await saved).status()).toBe(200);
  await page.getByRole("button", { name: "检查风险数量" }).click();
  await page.getByRole("button", { name: "启用合成计划观察" }).click();
  await expect(page.getByRole("button", { name: "暂停观察" })).toBeVisible();
  await page.getByRole("button", { name: "运行此计划的合成回放 →" }).click();
  await page
    .getByRole("button", { name: /提醒与记录/ })
    .first()
    .click();
  await page
    .locator(".event-row")
    .filter({ hasText: /合成演练 · 条件命中/ })
    .first()
    .click();
  await expect(page.locator(".event-detail")).toContainText("历史");
  const audit = page.getByRole("region", { name: "只读历史回放" });
  await audit.getByRole("button", { name: "验证冻结输入" }).click();
  await expect(audit).toContainText("冻结输入回放一致");
  await page
    .getByLabel("备注", { exact: true })
    .fill("自动化验收：合成回放，人工确认入场摘要。");
  await page.getByText("实际入场摘要（可选）", { exact: true }).click();
  await page.getByLabel("实际均价", { exact: true }).fill("102.1234");
  await page.getByLabel("实际数量", { exact: true }).fill("10000");
  await page
    .getByRole("button", { name: "已交易", exact: true })
    .last()
    .click();
  await expect(page.locator(".event-detail")).toContainText("已交易");
  const revisions = page.getByRole("region", { name: "反馈修订历史" });
  await expect(revisions).toContainText("102.1234");
  await expect(revisions).toContainText("实际均价超出计划入场区");
  await expect(revisions).toContainText("实际数量高于核算数量");
  await page
    .getByLabel("备注", { exact: true })
    .fill("更正备注；保留原始实际价量。");
  const entry = (
    (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap
  ).events.find((row) => row.type === "HISTORICAL_TRIGGERED")!;
  const priorFeedback = await (
    await page.request.get(`/api/events/${entry.id}/feedback`)
  ).json();
  const concurrentFeedback = await page.request.post(
    `/api/events/${entry.id}/feedback`,
    {
      headers: { "X-Requested-With": "PullbackLab" },
      data: {
        kind: "TAKEN",
        note: "另一标签页补充记录",
        actualPrice: "102.1234",
        actualQuantity: 10000,
        expectedRevisionId: priorFeedback.revisions.at(-1).id,
      },
    },
  );
  expect(concurrentFeedback.status()).toBe(200);
  // The live summary detects the newer revision before another stale submission.
  // The server suite separately verifies the 409 compare-and-swap backstop.
  const feedbackConflict = page.getByRole("region", {
    name: "反馈版本冲突复核",
  });
  await expect(feedbackConflict).toBeVisible();
  await expect(page.getByLabel("备注", { exact: true })).toHaveValue(
    "更正备注；保留原始实际价量。",
  );
  await feedbackConflict
    .getByRole("button", { name: "读取最新反馈，保留当前输入" })
    .click();
  await expect(revisions).toContainText("另一标签页补充记录");
  await page
    .getByRole("button", { name: "已交易", exact: true })
    .last()
    .click();
  await expect(revisions.locator(".feedback-revision")).toHaveCount(3);
  await expect(page.getByLabel("实际均价", { exact: true })).toHaveValue(
    "102.1234",
  );
  await audit.getByRole("button", { name: "验证冻结输入" }).click();
  await expect(audit).toContainText("冻结输入回放一致");
  await page.screenshot({
    path: test.info().outputPath("records.png"),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "设置与资金快照 ↗" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    /过期|重新确认|待确认|待刷新/,
  );
  await page.getByLabel("关闭设置").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(failures).toEqual([]);
});

const controlHeaders = { "X-Requested-With": "PullbackLab" };
async function preparePlanControls(page: Page) {
  const post = (path: string, data?: unknown) =>
    page.request.post(`/api${path}`, { headers: controlHeaders, data });
  expect(
    (await post("/login", { password: "e2e-only-password" })).status(),
  ).toBe(200);
  expect((await post("/demo/seed")).status()).toBe(200);
  expect(
    (await post("/settings/screening", { confirmed: true })).status(),
  ).toBe(200);
  const boot = (await (
    await page.request.get("/api/bootstrap")
  ).json()) as Bootstrap;
  const now = Date.now();
  expect(
    (
      await post("/funds", {
        nav: "10000",
        baseCurrency: "USD",
        cash: { USD: "10000", CNY: "0" },
        existing: {},
        riskBudget: "50",
        riskPool: "100",
        maxWeight: "0.9",
        fx: { USD: "1", CNY: "0.14" },
        fxAsOf: now,
        confirmedAt: now,
        stale: false,
        buyFee: "0",
        sellFee: "0",
        slippageIn: "0",
        slippageOut: "0",
        feesConfirmed: true,
        expectedGeneration: boot.funds?.generation ?? 0,
      })
    ).status(),
  ).toBe(200);
  await page.goto("/");
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  const create = page.getByRole("button", { name: "创建新计划", exact: true });
  if (await create.isVisible()) await create.click();
  await page.getByRole("button", { name: "填入合成示例计划" }).click();
  await page.getByLabel(/我已确认回踩背景/).check();
  await expect(
    page.getByRole("region", { name: "支撑家族与证据" }),
  ).toContainText("支撑证据完整");
}
async function recordControlFonts(page: Page, name: string) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: ".plan-controls h4",
    });
    const fonts = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.fonts.some((font) => font.glyphCount > 0)).toBe(true);
    const report = {
      chromium: page.context().browser()?.version(),
      ...fonts,
    };
    const reportPath = test
      .info()
      .outputPath(`plan-controls-${name}-fonts.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    await test.info().attach(`plan-controls-${name}-fonts`, {
      path: reportPath,
      contentType: "application/json",
    });
    console.log(`plan-controls-${name}-fonts`, JSON.stringify(report));
  } finally {
    await session.detach();
  }
}
async function expectControlCenterReachable(control: Locator) {
  await expect(control).toBeVisible();
  await expect
    .poll(
      () =>
        control.evaluate((node: HTMLInputElement) => {
          const rect = node.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          if (
            x < 0 ||
            x >= window.innerWidth ||
            y < 0 ||
            y >= window.innerHeight
          )
            return false;
          const hit = document.elementFromPoint(x, y);
          return (
            hit !== null &&
            (hit === node ||
              node.contains(hit) ||
              Array.from(node.labels ?? []).some((label) =>
                label.contains(hit),
              ))
          );
        }),
      {
        message:
          "The control center must be reachable without a navigation overlay",
      },
    )
    .toBe(true);
}
async function saveControlPlan(page: Page, planId?: string): Promise<Plan> {
  const response = page.waitForResponse(
    (r) =>
      r
        .url()
        .endsWith(planId ? `/api/plans/${planId}/versions` : "/api/plans") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", {
      name: planId ? "保存新版本" : "保存研究计划",
      exact: true,
    })
    .click();
  const saved = await response;
  expect(saved.status()).toBe(200);
  return saved.json();
}
async function checkControlRisk(
  page: Page,
  planId: string,
): Promise<RiskResult> {
  const response = page.waitForResponse((r) =>
    r.url().endsWith(`/api/plans/${planId}/risk`),
  );
  await page.getByRole("button", { name: "检查风险数量", exact: true }).click();
  const checked = await response;
  expect(checked.status()).toBe(200);
  return checked.json();
}
async function fillControlFees(page: Page, version: string) {
  await page
    .getByRole("button", { name: "为此计划填写完整费用规则", exact: true })
    .click();
  const controls = page.getByRole("region", { name: "计划追价与费用规则" });
  const confirmation = controls.getByLabel(/我已核对本计划买卖两侧/);
  await expect(confirmation).toBeDisabled();
  const values = [
    ["买入最低费用 / 笔", "1"],
    ["买入固定费用 / 笔", "0.2"],
    ["买入每股费用", "0.1"],
    ["买入成交额费率（小数比例）", "0.0005"],
    ["卖出最低费用 / 笔", "1.5"],
    ["卖出固定费用 / 笔", "0.3"],
    ["卖出每股费用", "0.15"],
    ["卖出成交额费率（小数比例）", "0.0007"],
  ] as const;
  for (const [name, value] of values) {
    const input = controls.getByLabel(name, { exact: true });
    await expect(input).toHaveValue("");
    await input.fill(value);
  }
  await controls.getByLabel("费用规则版本", { exact: true }).fill(version);
  await controls.getByLabel("费用规则日期", { exact: true }).fill("2026-10-01");
  await expect(controls.getByLabel("费用币种", { exact: true })).toHaveValue(
    "USD",
  );
  await confirmation.check();
  return controls;
}
function expectQuantityFees(risk: RiskResult, buyPerShare = "0.1") {
  const fee = (
    minimum: string,
    fixed: string,
    perShare: string,
    rate: string,
    price: string,
  ) =>
    Decimal.max(
      minimum,
      new Decimal(fixed)
        .plus(new Decimal(perShare).mul(risk.quantity))
        .plus(new Decimal(rate).mul(risk.quantity).mul(price)),
    ).toDecimalPlaces(2, Decimal.ROUND_CEIL);
  expect(
    new Decimal(risk.buyFee!).eq(
      fee("1", "0.2", buyPerShare, "0.0005", risk.entry),
    ),
  ).toBe(true);
  expect(
    new Decimal(risk.sellFee!).eq(
      fee("1.5", "0.3", "0.15", "0.0007", risk.stopExec),
    ),
  ).toBe(true);
}

test("plan controls save real versions, reprice quantity, preserve CAS drafts and frozen evidence", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await preparePlanControls(page);
  let controls = page.getByRole("region", { name: "计划追价与费用规则" });
  await expect(controls).toContainText("旧版固定费用");
  await expect(controls.getByLabel("追价限制", { exact: true })).toHaveValue(
    "disabled",
  );
  const legacy = await saveControlPlan(page);
  expect(legacy.feeSchedule).toBeUndefined();
  expect(legacy.chaseLimit).toBeUndefined();
  const legacyRisk = await checkControlRisk(page, legacy.id);
  expect(legacyRisk.passed).toBe(true);

  await controls
    .getByLabel("追价限制", { exact: true })
    .selectOption("enabled");
  const chase = controls.getByLabel("距当时已知低点的最大涨幅（%）", {
    exact: true,
  });
  await expect(chase).toHaveValue("");
  expect(
    await chase.evaluate(
      (node: HTMLInputElement) => node.validity.valueMissing,
    ),
  ).toBe(true);
  await chase.fill("1.7500");
  controls = await fillControlFees(page, "ui-desktop-fees-v1");
  const full = await saveControlPlan(page, legacy.id);
  expect(full.version).toBe(2);
  expect(full.chaseLimit).toEqual({ enabled: true, maxPercent: "1.7500" });
  expect(full.feeSchedule?.confirmed).toBe(true);
  expect(full.feeSchedule?.ruleDate).toBe("2026-10-01");
  const priced = await checkControlRisk(page, full.id);
  expect(priced.passed).toBe(true);
  expect(priced.quantity).toBeLessThan(legacyRisk.quantity);
  expect(priced.feeVersion).toBe("ui-desktop-fees-v1");
  expectQuantityFees(priced);
  await expect(page.locator(".risk-details")).toContainText("核算买入费用");
  await recordControlFonts(page, "desktop");
  await controls.screenshot({
    path: test.info().outputPath("plan-controls-desktop.png"),
  });
  await controls
    .getByRole("heading", { name: "追价上限", exact: true })
    .evaluate((node) =>
      node.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  await page.screenshot({
    path: test.info().outputPath("plan-controls-desktop-top-viewport.png"),
    fullPage: false,
  });

  // Record a real event first, so later saved versions must not rewrite its controls.
  await page
    .getByRole("button", { name: "启用合成计划观察", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "暂停观察", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "运行此计划的合成回放 →", exact: true })
    .click();
  const recorded = (await (
    await page.request.get("/api/bootstrap")
  ).json()) as Bootstrap;
  const summary = recorded.events.find(
    (event) =>
      event.planId === full.id && event.type === "HISTORICAL_TRIGGERED",
  )!;
  expect(summary).toBeTruthy();
  const originalEvent = (await (
    await page.request.get(`/api/events/${summary.id}`)
  ).json()) as DecisionEvent;
  await page
    .getByRole("button", { name: /提醒与记录/ })
    .first()
    .click();
  await page
    .locator(".event-row")
    .filter({ hasText: "合成演练 · 条件命中" })
    .first()
    .click();
  const evidence = page.getByRole("region", { name: "结构化判断依据" });
  await expect(evidence).toContainText("最大 1.7500%");
  await expect(evidence).toContainText("ui-desktop-fees-v1");
  await expect(evidence).toContainText("向上取整到小数点后两位");
  await page
    .getByRole("region", { name: "只读历史回放" })
    .getByRole("button", { name: "验证冻结输入" })
    .click();
  await expect(
    page.getByRole("region", { name: "只读历史回放" }),
  ).toContainText("冻结输入回放一致");
  await evidence.screenshot({
    path: test.info().outputPath("plan-controls-frozen-evidence.png"),
  });
  await page
    .getByRole("button", { name: "已跳过", exact: true })
    .last()
    .click();
  await expect(page.locator(".event-detail")).toContainText("已跳过");
  await page
    .getByRole("button", { name: /标的与计划/ })
    .first()
    .click();

  // Editing any fee detail clears its confirmation and marks the plan as dirty.
  await chase.fill("2.2500");
  await controls.getByLabel("买入每股费用", { exact: true }).fill("0.2");
  const confirmation = controls.getByLabel(/我已核对本计划买卖两侧/);
  await expect(confirmation).not.toBeChecked();
  await expect(page.locator(".plan-editor")).toContainText("未保存");
  await controls
    .getByLabel("费用规则版本", { exact: true })
    .fill("ui-local-fees-v2");
  await confirmation.check();
  await controls.getByLabel("费用规则日期", { exact: true }).fill("2026-10-02");
  await expect(confirmation).not.toBeChecked();
  await confirmation.check();
  await controls.getByLabel("费用币种", { exact: true }).selectOption("CNY");
  await expect(confirmation).not.toBeChecked();
  await controls.getByLabel("费用币种", { exact: true }).selectOption("USD");
  await confirmation.check();
  const current = (
    (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap
  ).plans.find((p) => p.id === full.id)!;
  const remote = await page.request.post(`/api/plans/${full.id}/versions`, {
    headers: controlHeaders,
    data: {
      ...current,
      expectedVersion: current.version,
      expectedAttemptId: current.attemptId,
      chaseLimit: { enabled: true, maxPercent: "0.5" },
      feeSchedule: { ...current.feeSchedule, version: "ui-remote-fees-v2" },
    },
  });
  expect(remote.status()).toBe(200);
  const conflictResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/plans/${full.id}/versions`) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  expect((await conflictResponse).status()).toBe(409);
  const conflict = page.getByRole("region", { name: "计划版本冲突复核" });
  await conflict
    .getByRole("button", { name: "读取最新数据", exact: true })
    .click();
  await expect(conflict).toContainText("ui-remote-fees-v2");
  await expect(conflict).toContainText("ui-local-fees-v2");
  await expect(conflict).toContainText("追价上限（%）");
  await expect(conflict).toContainText("买入每股费用");
  await conflict
    .getByRole("button", {
      name: "保留输入并基于最新版本继续编辑",
      exact: true,
    })
    .click();
  await expect(chase).toHaveValue("2.2500");
  await expect(
    controls.getByLabel("买入每股费用", { exact: true }),
  ).toHaveValue("0.2");
  const updated = await saveControlPlan(page, full.id);
  expect(updated.version).toBe(4);
  expect(updated.feeSchedule?.version).toBe("ui-local-fees-v2");
  const repriced = await checkControlRisk(page, full.id);
  expect(repriced.passed).toBe(true);
  expect(repriced.quantity).toBeLessThan(priced.quantity);
  expectQuantityFees(repriced, "0.2");
  const unchanged = (await (
    await page.request.get(`/api/events/${summary.id}`)
  ).json()) as DecisionEvent;
  expect(unchanged.snapshot).toEqual(originalEvent.snapshot);

  await page.reload();
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  await expect(chase).toHaveValue("2.2500");
  await expect(confirmation).toBeChecked();
  await expect(
    controls.getByLabel("费用规则版本", { exact: true }),
  ).toHaveValue("ui-local-fees-v2");
  expect(failures).toEqual([]);
});

test("plan controls are editable and persisted at 390px without invented rates", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preparePlanControls(page);
  const controls = await fillControlFees(page, "ui-mobile-fees-v1");
  await controls
    .getByLabel("追价限制", { exact: true })
    .selectOption("enabled");
  const chase = controls.getByLabel("距当时已知低点的最大涨幅（%）", {
    exact: true,
  });
  await expect(chase).toHaveValue("");
  await chase.fill("0");
  const saved = await saveControlPlan(page);
  expect(saved.chaseLimit).toEqual({ enabled: true, maxPercent: "0" });
  expect(saved.feeSchedule?.version).toBe("ui-mobile-fees-v1");
  const risk = await checkControlRisk(page, saved.id);
  expect(risk.passed).toBe(true);
  expectQuantityFees(risk);
  await page.reload();
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  await expect(chase).toHaveValue("0");
  await expect(controls.getByLabel(/我已核对本计划买卖两侧/)).toBeChecked();
  await recordControlFonts(page, "390px");
  await controls.screenshot({
    path: test.info().outputPath("plan-controls-390px.png"),
  });
  // Keep the real fixed navigation visible. A tall element capture alone cannot
  // show that controls are reachable in an ordinary scrolled viewport.
  await controls
    .getByRole("heading", { name: "追价上限", exact: true })
    .evaluate((node) =>
      node.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  await page.screenshot({
    path: test.info().outputPath("plan-controls-390px-top-viewport.png"),
    fullPage: false,
  });
  const lastRate = controls.getByLabel("卖出成交额费率（小数比例）", {
    exact: true,
  });
  const feeConfirmation = controls.getByLabel(/我已核对本计划买卖两侧/);
  await lastRate.evaluate((node) =>
    node.scrollIntoView({ block: "center", behavior: "instant" }),
  );
  await feeConfirmation.scrollIntoViewIfNeeded();
  await expectControlCenterReachable(lastRate);
  await expectControlCenterReachable(feeConfirmation);
  await page.screenshot({
    path: test.info().outputPath("plan-controls-390px-fees-viewport.png"),
    fullPage: false,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  // The operator can explicitly disable the limit without leaving a hidden preset.
  await controls
    .getByLabel("追价限制", { exact: true })
    .selectOption("disabled");
  const disabled = await saveControlPlan(page, saved.id);
  expect(disabled.chaseLimit).toEqual({ enabled: false });
  expect(disabled.feeSchedule).toEqual(saved.feeSchedule);
  await page.reload();
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  await expect(controls.getByLabel("追价限制", { exact: true })).toHaveValue(
    "disabled",
  );
});
