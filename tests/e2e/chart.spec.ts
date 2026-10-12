import { expect, test, type Page } from "@playwright/test";
import Decimal from "decimal.js";

async function openSyntheticChart(page: Page) {
  const headers = { "X-Requested-With": "PullbackLab" };
  expect(
    (
      await page.request.post("/api/login", {
        headers,
        data: { password: "e2e-only-password" },
      })
    ).status(),
  ).toBe(200);
  expect(
    (await page.request.post("/api/demo/seed", { headers })).status(),
  ).toBe(200);
  expect(
    (
      await page.request.post("/api/settings/screening", {
        headers,
        data: { confirmed: true },
      })
    ).status(),
  ).toBe(200);
  await page.goto("/");
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  await page.getByRole("button", { name: "填入合成示例计划" }).click();
  await expect(
    page.getByRole("region", { name: "支撑家族与证据" }),
  ).toContainText("支撑证据完整");
  await expect(page.getByLabel("主支撑价", { exact: true })).toHaveValue("100");
  await page.getByRole("button", { name: "开启图表调价", exact: true }).click();
}

async function dragHandle(page: Page, delta: number, release = true) {
  const handle = page.getByRole("button", {
    name: "拖动主支撑价格线",
    exact: true,
  });
  await handle.scrollIntoViewIfNeeded();
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2;
  const y = bounds!.y + bounds!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + delta, { steps: 6 });
  if (release) await page.mouse.up();
}

test("chart proposals quantize on the server, stay as drafts and cancel safely", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await openSyntheticChart(page);
  const primary = page.getByLabel("主支撑价", { exact: true });
  const adjustment = page.getByRole("region", {
    name: "图表调价",
    exact: true,
  });
  const originalPlans = (
    await (await page.request.get("/api/bootstrap")).json()
  ).plans;
  const pointResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/price-proposal") &&
      response.request().postDataJSON()?.kind === "POINT",
  );
  await dragHandle(page, 28);
  const response = await pointResponse;
  expect(response.status()).toBe(200);
  const result = await response.json();
  const proposed = response.request().postDataJSON().displayPrice;
  expect(result.price).toBe(
    new Decimal(proposed)
      .div(result.tick)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .mul(result.tick)
      .toFixed(),
  );
  expect(result.price).not.toBe("100");
  await expect(primary).toHaveValue(result.price);
  await expect(adjustment).toContainText("已更新计划草稿");
  await page.screenshot({
    path: test.info().outputPath("chart-adjustment-desktop.png"),
    fullPage: true,
  });

  // Keyboard adjustments use the exact accepted string, not the chart's float.
  const handle = page.getByRole("button", {
    name: "拖动主支撑价格线",
    exact: true,
  });
  await handle.focus();
  await handle.press("ArrowUp");
  await expect(primary).toHaveValue(
    new Decimal(result.price).plus(result.tick).toFixed(),
  );
  await handle.press("ArrowDown");
  await expect(primary).toHaveValue(result.price);

  let proposalCount = 0;
  const count = (request: { url(): string }) => {
    if (request.url().endsWith("/price-proposal")) proposalCount++;
  };
  page.on("request", count);
  await dragHandle(page, 20, false);
  await expect(adjustment).toContainText("拖动预览");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "开启图表调价", exact: true }),
  ).toBeVisible();
  await expect(primary).toHaveValue(result.price);
  expect(proposalCount).toBe(0);
  page.off("request", count);
  expect(
    (await (await page.request.get("/api/bootstrap")).json()).plans,
  ).toEqual(originalPlans);
  expect(failures).toEqual([]);
});

test("delayed chart normalization cannot overwrite later edits or a new timeframe", async ({
  page,
}) => {
  await openSyntheticChart(page);
  const primary = page.getByLabel("主支撑价", { exact: true });
  const adjustment = page.getByRole("region", {
    name: "图表调价",
    exact: true,
  });
  let releaseResponse!: () => void;
  let received!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    received = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/api/instruments/*/price-proposal", async (route) => {
    const response = await route.fetch();
    received();
    await release;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "主支撑增加一个最小变价单位", exact: true })
    .click();
  await intercepted;
  await primary.fill("100.25");
  releaseResponse();
  await expect(adjustment).toContainText("草稿已变更，本次调价已取消");
  await expect(primary).toHaveValue("100.25");
  await page.unroute("**/api/instruments/*/price-proposal");

  let releaseTimeframe!: () => void;
  let receivedTimeframe!: () => void;
  const timeframeIntercepted = new Promise<void>((resolve) => {
    receivedTimeframe = resolve;
  });
  const timeframeRelease = new Promise<void>((resolve) => {
    releaseTimeframe = resolve;
  });
  await page.route("**/api/instruments/*/price-proposal", async (route) => {
    const response = await route.fetch();
    receivedTimeframe();
    await timeframeRelease;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "主支撑增加一个最小变价单位", exact: true })
    .click();
  await timeframeIntercepted;
  await page.getByRole("button", { name: "1 分钟", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开启图表调价", exact: true }),
  ).toBeVisible();
  const completed = page.waitForResponse((response) =>
    response.url().endsWith("/price-proposal"),
  );
  releaseTimeframe();
  await completed;
  // A following user operation must start from the user's retained price.
  await page.getByRole("button", { name: "开启图表调价", exact: true }).click();
  await expect(primary).toHaveValue("100.25");
  await page.unroute("**/api/instruments/*/price-proposal");
  await page
    .getByRole("button", { name: "主支撑增加一个最小变价单位", exact: true })
    .click();
  await expect(primary).toHaveValue("100.26");
});

test.describe("touch chart", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("touch dragging adjusts only its handle and touch cancellation discards preview", async ({
    page,
  }) => {
    await openSyntheticChart(page);
    const primary = page.getByLabel("主支撑价", { exact: true });
    const handle = page.getByRole("button", {
      name: "拖动主支撑价格线",
      exact: true,
    });
    const adjustment = page.getByRole("region", {
      name: "图表调价",
      exact: true,
    });
    const session = await page.context().newCDPSession(page);
    async function touchDrag(cancel: boolean) {
      await handle.scrollIntoViewIfNeeded();
      const bounds = (await handle.boundingBox())!;
      const point = {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
        id: 1,
      };
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, y: point.y + 18 }],
      });
      await expect(adjustment).toContainText("拖动预览");
      await session.send("Input.dispatchTouchEvent", {
        type: cancel ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
    }
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/price-proposal")) requests++;
    });
    await touchDrag(true);
    await expect(primary).toHaveValue("100");
    expect(requests).toBe(0);
    const accepted = page.waitForResponse((response) =>
      response.url().endsWith("/price-proposal"),
    );
    await touchDrag(false);
    const response = await accepted;
    expect(response.status()).toBe(200);
    await expect(primary).toHaveValue((await response.json()).price);
    expect(requests).toBe(1);
    await page.screenshot({
      path: test.info().outputPath("chart-adjustment-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await session.detach();
  });
});
