import { expect, test } from "@playwright/test";
import type {
  Bootstrap,
  EventPage,
  Plan,
} from "../../packages/contracts/index";
import type { RuntimeProgress } from "../../apps/server/attempt-runtime";

test("persisted synthetic steps stream summaries and preserve a feedback draft on reconnect", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const headers = { "X-Requested-With": "PullbackLab" };
  const post = (path: string, data?: unknown) =>
    page.request.post(`/api${path}`, {
      headers,
      ...(data === undefined ? {} : { data }),
    });
  expect(
    (await post("/login", { password: "e2e-only-password" })).status(),
  ).toBe(200);
  expect((await post("/demo/seed")).status()).toBe(200);
  expect(
    (await post("/settings/screening", { confirmed: true })).status(),
  ).toBe(200);
  const initial = (await (
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
        maxWeight: "0.2",
        fx: { USD: "1", CNY: "0.14" },
        fxAsOf: now,
        confirmedAt: now,
        stale: false,
        buyFee: "0",
        sellFee: "0",
        slippageIn: "0",
        slippageOut: "0",
        feesConfirmed: true,
        expectedGeneration: initial.funds?.generation ?? 0,
      })
    ).status(),
  ).toBe(200);
  const created = await post("/plans", {
    instrumentId: "DEMO-US-A",
    anchorTime: null,
    primarySupport: "100",
    lower: "99.75",
    upper: "100.25",
    stop: "99.4",
    entryMin: "100.61",
    entryMax: "101.5",
    mode: "CLOSE_CONFIRM",
    sessionDate: "2026-10-09",
    reason: "分步与流同步浏览器验收",
    backgroundConfirmed: true,
    supportSelections: [
      { source: "EMA9" },
      {
        source: "HORIZONTAL",
        id: "runtime-test",
        label: "合成水平线",
        price: "100",
      },
    ],
  });
  expect(created.status()).toBe(200);
  const plan = (await created.json()) as Plan;
  const activated = await post(`/plans/${plan.id}/activate`, {
    expectedVersion: plan.version,
  });
  expect(activated.status()).toBe(200);
  const activePlan = (await activated.json()).plan as Plan;

  // Capture the browser's live instance solely to inject a protocol reset.
  // Server tests independently cover real expired cursors and epoch changes.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const streams: EventSource[] = [];
    (window as unknown as { __testStreams: EventSource[] }).__testStreams =
      streams;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        streams.push(this);
      }
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  const runtime = page.getByRole("region", {
    name: "分步合成演练",
    exact: true,
  });
  await runtime.getByRole("button", { name: "准备分步合成演练" }).click();
  const progress = runtime.getByRole("progressbar", { name: "合成演练进度" });
  await expect(progress).toHaveAttribute("value", "0");
  await runtime.getByRole("button", { name: "推进下一条合成行情" }).click();
  await expect(progress).toHaveAttribute("value", "1");
  await runtime.getByRole("button", { name: "推进下一条合成行情" }).click();
  await expect(progress).toHaveAttribute("value", "2");
  await page.reload();
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  await expect(progress).toHaveAttribute("value", "2");

  await page
    .getByRole("button", { name: /提醒与记录/ })
    .first()
    .click();
  let detailRequests = 0;
  page.on("request", (request) => {
    if (
      /\/api\/events\/[^/?]+$/.test(request.url()) &&
      request.method() === "GET"
    )
      detailRequests++;
  });
  const step = await post(`/demo/plans/${plan.id}/runtime/step`, {
    expectedVersion: plan.version,
    expectedAttemptId: activePlan.attemptId,
    expectedStep: 2,
    count: 1,
  });
  expect(step.status()).toBe(200);
  expect(
    ((await step.json()) as { runtime: RuntimeProgress }).runtime.step,
  ).toBe(3);
  const eventPage = (await (
    await page.request.get("/api/events?limit=50")
  ).json()) as EventPage;
  const entry = eventPage.events.find(
    (event) => event.planId === plan.id && event.recordable,
  );
  expect(entry).toBeDefined();
  expect(eventPage.events.every((event) => !("snapshot" in event))).toBe(true);
  const row = page.locator(`[data-event-id="${entry!.id}"]`);
  // No UI refresh follows the external step: this row arrives on the live feed.
  await expect(row).toBeVisible();
  expect(detailRequests).toBe(0);
  await row.click();
  await expect(
    page.getByRole("region", { name: "只读历史回放" }),
  ).toBeVisible();
  expect(detailRequests).toBe(1);
  const draft = page.getByLabel("备注", { exact: true });
  await draft.fill("重连期间保留这份尚未提交的备注");
  const restoredPage = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/events?limit=50") &&
      response.request().method() === "GET",
  );
  await page.evaluate((feedEpoch) => {
    const streams = (window as unknown as { __testStreams: EventSource[] })
      .__testStreams;
    streams.at(-1)!.dispatchEvent(
      new MessageEvent("reset", {
        data: JSON.stringify({ code: "CURSOR_EXPIRED", feedEpoch }),
      }),
    );
  }, eventPage.feedEpoch);
  await restoredPage;
  await expect(draft).toHaveValue("重连期间保留这份尚未提交的备注");
  await expect(row).toBeVisible();
  expect(detailRequests).toBe(1);

  // A failed SSE handshake can return 401 before emitting auth-expired.
  // Confirming session expiry must return to login without discarding the draft.
  await page.route(
    "**/api/session",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: false,
          configured: true,
          demo: true,
        }),
      }),
    { times: 1 },
  );
  await page.evaluate(() => {
    const streams = (window as unknown as { __testStreams: EventSource[] })
      .__testStreams;
    streams.at(-1)!.dispatchEvent(new Event("error"));
  });
  await expect(page.getByLabel("访问密码")).toBeVisible();
  await page.getByLabel("访问密码").fill("e2e-only-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(draft).toHaveValue("重连期间保留这份尚未提交的备注");
  await expect(
    page.getByRole("region", { name: "反馈版本冲突复核" }),
  ).toBeVisible();
  expect(failures).toEqual([]);
});
