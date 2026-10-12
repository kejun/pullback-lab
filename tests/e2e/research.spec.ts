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
  await page
    .getByLabel("备注", { exact: true })
    .fill("自动化验收：合成回放，人工确认入场摘要。");
  await page
    .getByRole("button", { name: "已交易", exact: true })
    .last()
    .click();
  await expect(page.locator(".event-detail")).toContainText("已交易");
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
