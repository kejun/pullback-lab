import { expect, test } from "@playwright/test";

test("period evidence remains distinct across refresh and mobile layout", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  expect((await page.request.get("/api/market/status")).status()).toBe(401);
  await page.goto("/");
  await page.getByLabel("访问密码").fill("e2e-only-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name: "设置与资金快照 ↗" }).click();
  const panel = page.getByRole("region", { name: "行情采集状态" });
  await expect(panel).toContainText("分钟采样：SAMPLE.US");
  await panel.getByText("查看各周期采样进度", { exact: true }).click();
  const daily = panel.getByRole("article", { name: "SAMPLE.US 日线采样" });
  const one = panel.getByRole("article", { name: "SAMPLE.US 1 分钟采样" });
  const five = panel.getByRole("article", { name: "SAMPLE.US 5 分钟采样" });
  await expect(daily).toContainText("已收样");
  await expect(daily).toContainText("1 条");
  await expect(one).toContainText("空结果");
  await expect(one).toContainText("无记录");
  await expect(five).toContainText("失败");
  await expect(five).toContainText("行情供应商请求失败");
  await expect(panel).toContainText("实时观察未放行");
  const response = await page.request.get("/api/market/status");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const status = await response.json();
  expect(status.liveEligible).toBe(false);
  expect(
    status.streams.map((x: { period: string; outcome: string }) => [
      x.period,
      x.outcome,
    ]),
  ).toEqual([
    ["1D", "SAMPLED"],
    ["1m", "EMPTY"],
    ["5m", "FAILED"],
  ]);
  expect(status.watermarks.map((x: { period: string }) => x.period)).toEqual([
    "1D",
  ]);
  expect(JSON.stringify(status)).not.toContain("private-provider-error");
  // A screenshot of the entire tall panel escapes the drawer's scroll clip.
  // Capture each complete card only after it is visible inside that clip.
  const captureCards = async (viewport: string) => {
    for (const [name, card] of [
      ["daily", daily],
      ["one", one],
      ["five", five],
    ] as const) {
      await card.scrollIntoViewIfNeeded();
      const geometry = await card.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const clip = element.closest(".drawer-body")!.getBoundingClientRect();
        return {
          inside:
            rect.top >= clip.top &&
            rect.bottom <= clip.bottom &&
            rect.left >= clip.left &&
            rect.right <= clip.right,
          fits: element.scrollWidth <= element.clientWidth,
        };
      });
      expect(geometry).toEqual({ inside: true, fits: true });
      await card.screenshot({
        path: test.info().outputPath(`minute-sampling-${viewport}-${name}.png`),
      });
    }
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".sampling-stream strong",
  });
  const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.fonts.some((font) => font.glyphCount > 0)).toBe(true);
  console.log(
    "MINUTE_SAMPLING_BROWSER",
    browser.version(),
    "RENDERED_FONTS",
    JSON.stringify(fonts.fonts),
  );
  await cdp.detach();
  await captureCards("desktop");
  await page.route(
    "**/api/market/status",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "采样状态测试不可用" }),
      }),
    { times: 1 },
  );
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await expect(panel).toContainText("采集状态暂不可读");
  await expect(five).toContainText("失败");
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await expect(panel).not.toContainText("采集状态暂不可读");
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(one).toContainText("空结果");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await captureCards("mobile");
  expect(errors).toEqual([]);
});
