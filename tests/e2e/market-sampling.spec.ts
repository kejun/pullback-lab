import { readFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";

// Center within the actual clipping ancestor: browser scrollIntoViewIfNeeded
// can leave a fractional edge clipped, especially after a viewport resize.
async function revealCard(card: Locator) {
  await card.evaluate((element) => {
    const container = element.closest(".drawer-body")!;
    const rect = element.getBoundingClientRect(),
      clip = container.getBoundingClientRect();
    container.scrollTop +=
      rect.top - clip.top - (container.clientHeight - rect.height) / 2;
  });
  await expect
    .poll(() =>
      card.evaluate((element) => {
        const rect = element.getBoundingClientRect(),
          clip = element.closest(".drawer-body")!.getBoundingClientRect();
        return {
          inside:
            rect.top >= clip.top &&
            rect.bottom <= clip.bottom &&
            rect.left >= clip.left &&
            rect.right <= clip.right,
          fits: element.scrollWidth <= element.clientWidth,
        };
      }),
    )
    .toEqual({ inside: true, fits: true });
}

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
  await expect(daily).toContainText("22 条");
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
      await revealCard(card);
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

test("archives load on demand, preserve raw text and export the selected comparison on desktop and mobile", async ({
  page,
  browser,
}) => {
  const errors: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("provider-receipts")) requests.push(r.url());
  });
  expect(
    (
      await page.request.get(
        "/api/instruments/US:SAMPLE.US/provider-receipts?period=1D",
      )
    ).status(),
  ).toBe(401);
  await page.goto("/");
  await page.getByLabel("访问密码").fill("e2e-only-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name: "设置与资金快照 ↗" }).click();
  const panel = page.getByRole("region", { name: "行情采集状态" });
  await panel.getByText("查看各周期采样进度", { exact: true }).click();
  const daily = panel.getByRole("article", { name: "SAMPLE.US 日线采样" });
  expect(requests).toEqual([]);
  await daily.getByRole("button", { name: "查看采样回执" }).click();
  const archive = daily.getByRole("region", { name: "采样回执核验" });
  await expect(archive.getByLabel("收录回执")).toHaveValue("22");
  await expect(archive).toContainText("前序 #21 → 当前 #22");
  await expect(archive).toContainText("样本内容有变化");
  await expect(archive).toContainText("哈希一致");
  await expect(archive.getByLabel("收录回执").locator("option")).toHaveCount(
    20,
  );
  await archive.getByText("当前回执原文与摘要", { exact: true }).click();
  await expect(archive.getByLabel("回执 #22 原文")).toContainText(
    "<script>document.body.remove()</script>",
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    archive.getByRole("button", { name: "下载本条核验 JSON" }).click(),
  ]);
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported).toMatchObject({
    selected: { sequence: 22, integrity: "MATCH" },
    previous: { sequence: 21 },
    comparison: "CHANGED",
    liveEligible: false,
  });
  expect(exported.changes).toEqual([
    { field: "close", before: "100", after: "101" },
  ]);
  expect(exported.selected.payloadJson).toBe(
    await archive.getByLabel("回执 #22 原文").textContent(),
  );
  await archive.getByText("当前回执原文与摘要", { exact: true }).click();
  const capture = async (viewport: string) => {
    for (const name of ["summary", "comparison"]) {
      const box = archive.locator(`.receipt-${name}`);
      await revealCard(box);
      await box.screenshot({
        path: test
          .info()
          .outputPath(`provider-receipts-${viewport}-${name}.png`),
      });
    }
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".receipt-summary strong",
  });
  const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.fonts.some((font) => font.glyphCount > 0)).toBe(true);
  console.log(
    "PROVIDER_RECEIPT_BROWSER",
    browser.version(),
    "RENDERED_FONTS",
    JSON.stringify(fonts.fonts),
  );
  await cdp.detach();
  await capture("desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("mobile");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await archive.getByRole("button", { name: "读取更早回执" }).click();
  await expect(archive.getByLabel("收录回执")).toHaveValue("2");
  await expect(archive.getByLabel("收录回执").locator("option")).toHaveCount(2);
  await expect(archive).toContainText("本次固定收录上限 #22");
  await archive.getByLabel("请求周期", { exact: true }).selectOption("unknown");
  await expect(archive.getByLabel("收录回执")).toHaveValue("23");
  await expect(archive).toContainText("旧版没有记录请求周期");
  await archive.getByLabel("请求周期", { exact: true }).selectOption("1m");
  await expect(archive).toContainText("该范围没有回执");
  await expect(panel).toContainText("实时观察未放行");
  expect(errors).toEqual([]);
});

test("archive retries isolate failed pages, details and responses from a previous selection", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("访问密码").fill("e2e-only-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name: "设置与资金快照 ↗" }).click();
  const panel = page.getByRole("region", { name: "行情采集状态" });
  await panel.getByText("查看各周期采样进度", { exact: true }).click();
  const daily = panel.getByRole("article", { name: "SAMPLE.US 日线采样" });
  await page.route(
    "**/provider-receipts?*",
    (route) => route.fulfill({ status: 503, json: { error: "合成列表失败" } }),
    { times: 1 },
  );
  await daily.getByRole("button", { name: "查看采样回执" }).click();
  const archive = daily.getByRole("region", { name: "采样回执核验" });
  await expect(archive).toContainText("合成列表失败");
  await page.route(
    "**/provider-receipts/22?*",
    (route) => route.fulfill({ status: 503, json: { error: "合成详情失败" } }),
    { times: 1 },
  );
  await archive.getByRole("button", { name: "重试回执列表" }).click();
  await expect(archive).toContainText("合成详情失败");
  await archive.getByRole("button", { name: "重试回执详情" }).click();
  await expect(archive).toContainText("前序 #21 → 当前 #22");
  await page.route(
    "**/provider-receipts?*before=*",
    (route) => route.fulfill({ status: 503, json: { error: "合成分页失败" } }),
    { times: 1 },
  );
  await archive.getByRole("button", { name: "读取更早回执" }).click();
  await expect(archive).toContainText("合成分页失败");
  await expect(archive.getByLabel("收录回执")).toHaveValue("22");
  await expect(archive).toContainText("前序 #21 → 当前 #22");
  await archive.getByRole("button", { name: "重试回执列表" }).click();
  await expect(archive.getByLabel("收录回执")).toHaveValue("2");
  await archive.getByRole("button", { name: "重新读取回执" }).click();
  await expect(archive.getByLabel("收录回执")).toHaveValue("22");
  let release!: () => void, arrived!: () => void, finished!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route(
    "**/provider-receipts/21?*",
    async (route) => {
      const response = await route.fetch();
      arrived();
      await waiting;
      try {
        await route.fulfill({ response });
      } catch {
        /* Selection aborted the request. */
      } finally {
        finished();
      }
    },
    { times: 1 },
  );
  await archive.getByLabel("收录回执").selectOption("21");
  await requested;
  await archive.getByLabel("收录回执").selectOption("22");
  await expect(archive).toContainText("前序 #21 → 当前 #22");
  release();
  await completed;
  await expect(
    archive.getByLabel("回执 #22 详情", { exact: true }),
  ).toBeVisible();
  await expect(
    archive.getByLabel("回执 #21 详情", { exact: true }),
  ).toHaveCount(0);
  await archive.getByRole("button", { name: "收起采样回执" }).click();
  await expect(archive.getByLabel("收录回执")).toHaveCount(0);
});
