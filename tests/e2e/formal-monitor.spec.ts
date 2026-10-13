import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Bootstrap, Plan } from "../../packages/contracts/index";
import type { MonitorSnapshot } from "../../apps/web/src/formal-monitor-state";

const headers = { "X-Requested-With": "PullbackLab" };
const panel = (page: Page) =>
  page.getByRole("region", { name: "正式收盘监测", exact: true });
const confirm = (page: Page) =>
  panel(page).getByRole("group", { name: "确认正式监测操作" });
async function login(page: Page) {
  expect(
    (
      await page.request.post("/api/login", {
        headers,
        data: { password: "e2e-only-password" },
      })
    ).status(),
  ).toBe(200);
  await page.goto("/");
  await page.getByRole("button", { name: "CONTRACT.US", exact: true }).click();
  await expect(panel(page)).toContainText("服务器已核验正式收盘资格");
}
async function saved(page: Page) {
  const boot = (await (
    await page.request.get("/api/bootstrap")
  ).json()) as Bootstrap;
  return boot.plans.find((p) => p.instrumentId === "CONTRACT-US-A")!;
}
async function status(page: Page, plan: Plan) {
  return (await (
    await page.request.get(`/api/plans/${plan.id}/monitor`)
  ).json()) as MonitorSnapshot;
}
async function reveal(target: Locator) {
  await target.evaluate((element) =>
    element.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant",
    }),
  );
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const nav = document.querySelector(".sidebar")?.getBoundingClientRect();
        const bottom =
          nav && nav.width >= innerWidth * 0.9 && nav.bottom >= innerHeight - 1
            ? nav.top
            : innerHeight;
        return (
          r.top >= 0 &&
          r.bottom <= bottom &&
          r.left >= 0 &&
          r.right <= innerWidth &&
          [0.25, 0.5, 0.75].every((x) =>
            [0.25, 0.5, 0.75].every((y) => {
              const hit = document.elementFromPoint(
                r.left + r.width * x,
                r.top + r.height * y,
              );
              return hit !== null && element.contains(hit);
            }),
          )
        );
      }),
    )
    .toBe(true);
}

test("formal controls require explicit confirmation, recover server CAS conflicts, ignore late navigation responses, and work at 390px", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const initial = await saved(page);
  expect(initial.status).toBe("DRAFT");
  await expect(
    panel(page).getByRole("button", { name: "启用正式收盘监测", exact: true }),
  ).toBeEnabled();
  let posts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/plans\/.*\/(activate|pause|monitor\/recover)$/.test(
        new URL(request.url()).pathname,
      )
    )
      posts++;
  });
  await panel(page)
    .getByRole("button", { name: "启用正式收盘监测", exact: true })
    .click();
  await confirm(page)
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(confirm(page)).toHaveCount(0);
  expect(posts).toBe(0);
  expect((await saved(page)).attemptId).toBeNull();
  // Real API request is held in the browser to exercise rapid repeated confirmation.
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/plans/${initial.id}/activate`, async (route) => {
    await hold;
    await route.continue();
  });
  await panel(page)
    .getByRole("button", { name: "启用正式收盘监测", exact: true })
    .click();
  await confirm(page)
    .getByRole("button", { name: "确认并提交", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(
    confirm(page).getByRole("button", { name: "正在提交…", exact: true }),
  ).toBeDisabled();
  release();
  await expect(panel(page)).toContainText("会话首次观察");
  expect(posts).toBe(1);
  await page.unroute(`**/api/plans/${initial.id}/activate`);
  const active = await saved(page);
  expect(active.status).toBe("WAIT_RETEST");
  expect(active.attemptId).toBeTruthy();
  await panel(page).screenshot({
    path: test.info().outputPath("formal-monitor-desktop-running.png"),
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const pause = panel(page).getByRole("button", {
    name: "暂停正式监测",
    exact: true,
  });
  await reveal(pause);
  await page.screenshot({
    path: test.info().outputPath("formal-monitor-mobile-pause-viewport.png"),
  });
  await pause.click();
  const submitPause = confirm(page).getByRole("button", {
    name: "确认并提交",
    exact: true,
  });
  await reveal(submitPause);
  await submitPause.click();
  await expect(panel(page)).toContainText("用户已暂停");
  const recover = panel(page).getByRole("button", {
    name: "新建正式恢复尝试",
    exact: true,
  });
  await expect(recover).toBeEnabled();
  await recover.click();
  await expect(confirm(page)).toContainText("旧机会不会追发");
  await expect(confirm(page)).toContainText("必须重新高于支撑区上沿后再回踩");
  await confirm(page)
    .getByRole("button", { name: "取消", exact: true })
    .click();
  expect((await saved(page)).attemptId).toBe(active.attemptId);

  // Another tab creates a new attempt after this view captured its source/CAS.
  await recover.click();
  const paused = await saved(page);
  const before = await status(page, paused);
  expect(
    (
      await page.request.post(`/api/plans/${paused.id}/monitor/recover`, {
        headers,
        data: {
          expectedVersion: paused.version,
          expectedAttemptId: paused.attemptId,
          sourceAttemptId: before.progress!.attemptId,
          expectedWatermark: before.progress!.watermark,
        },
      })
    ).status(),
  ).toBe(200);
  await reveal(
    confirm(page).getByRole("button", { name: "确认并提交", exact: true }),
  );
  await confirm(page)
    .getByRole("button", { name: "确认并提交", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("未自动重试");
  await expect(recover).toBeDisabled();
  await expect(page.getByLabel("主支撑价", { exact: true })).toHaveValue("100");
  await panel(page)
    .getByRole("button", { name: "读取最新监测状态", exact: true })
    .click();
  await expect(panel(page)).toContainText("恢复尝试（不是会话首次）");
  const second = await saved(page);
  expect(second.attemptId).not.toBe(active.attemptId);
  await panel(page)
    .getByRole("button", { name: "暂停正式监测", exact: true })
    .click();
  await confirm(page)
    .getByRole("button", { name: "确认并提交", exact: true })
    .click();
  await expect(recover).toBeEnabled();
  await recover.click();
  await reveal(
    confirm(page).getByRole("button", { name: "确认并提交", exact: true }),
  );
  await page.screenshot({
    path: test
      .info()
      .outputPath("formal-monitor-mobile-recovery-confirm-viewport.png"),
  });
  await confirm(page).screenshot({
    path: test.info().outputPath("formal-monitor-mobile-recovery-confirm.png"),
  });
  await confirm(page)
    .getByRole("button", { name: "确认并提交", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "暂停正式监测", exact: true }),
  ).toBeEnabled();
  expect((await saved(page)).attemptId).not.toBe(second.attemptId);

  // A status read failure must fail closed, retain readback, and allow explicit recovery.
  await page.route(`**/api/plans/${initial.id}/monitor`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "离线夹具：状态读取失败",
        code: "TEST_FAILURE",
      }),
    }),
  );
  await panel(page)
    .getByRole("button", { name: "读取最新监测状态", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText("状态读取失败");
  await expect(
    panel(page).getByRole("button", { name: "暂停正式监测", exact: true }),
  ).toBeDisabled();
  await page.unroute(`**/api/plans/${initial.id}/monitor`);
  await panel(page)
    .getByRole("button", { name: "读取最新监测状态", exact: true })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "暂停正式监测", exact: true }),
  ).toBeEnabled();
  await panel(page).screenshot({
    path: test.info().outputPath("formal-monitor-mobile-restored.png"),
  });

  // A late GET from this plan must not populate a different security's panel.
  let entered!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let releaseRead!: () => void;
  const holdRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route(`**/api/plans/${initial.id}/monitor`, async (route) => {
    const response = await route.fetch();
    entered();
    await holdRead;
    await route.fulfill({ response });
  });
  await panel(page)
    .getByRole("button", { name: "读取最新监测状态", exact: true })
    .click();
  await intercepted;
  await page.getByRole("button", { name: "候选池", exact: true }).click();
  await page
    .getByRole("button", { name: "UNVERIFIED.US", exact: true })
    .click();
  await expect(panel(page)).toContainText(
    "此证券的实时授权、数据完整性或有效期尚未通过服务器核验",
  );
  releaseRead();
  await expect(panel(page)).not.toContainText(active.attemptId!);
  await expect(
    panel(page).getByRole("button", { name: "启用正式收盘监测", exact: true }),
  ).toBeDisabled();
  await expect(panel(page)).not.toContainText("恢复尝试（不是会话首次）");
  await panel(page).screenshot({
    path: test.info().outputPath("formal-monitor-mobile-unverified.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".formal-monitor h3",
  });
  const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.fonts.some((font) => font.glyphCount > 0)).toBe(true);
  console.log(
    "FORMAL_MONITOR_BROWSER",
    browser.version(),
    "RENDERED_FONTS",
    JSON.stringify(fonts.fonts),
  );
  await cdp.detach();
  expect(errors).toEqual([]);
});

test("hung plan refresh is bounded, releases controls, and cannot apply its late response", async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  let entered!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    entered();
    await hold;
    await route.fulfill({ response });
  });
  const refresh = panel(page).getByRole("button", {
    name: "读取最新监测状态",
    exact: true,
  });
  await refresh.click();
  await intercepted;
  await page.clock.fastForward(15001);
  await expect(panel(page)).toContainText("状态未确认");
  await expect(refresh).toBeEnabled();
  await expect(
    panel(page).getByRole("button", { name: "暂停正式监测", exact: true }),
  ).toBeDisabled();
  release();
  await page.unroute("**/api/bootstrap");
  await refresh.click();
  await expect(panel(page)).not.toContainText("状态未确认");
  await expect(
    panel(page).getByRole("button", { name: "暂停正式监测", exact: true }),
  ).toBeEnabled();
});
