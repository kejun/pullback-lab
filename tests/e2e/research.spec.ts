import { test, expect } from "@playwright/test";
import type { Bootstrap } from "../../packages/contracts/index";

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
