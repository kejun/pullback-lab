import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Bootstrap, PlanInput } from "../../packages/contracts/index";
import type {
  ResearchChartData,
  ResearchHistoryPreview,
  ResearchHistoryStatus,
} from "../../packages/contracts/research-history";
import { researchHistoryFixture } from "../../packages/market-data/research-history-fixture";

const headers = { "X-Requested-With": "PullbackLab" };
const id = "US:HISTORY.US";
const otherId = "US:OTHER.US";
const endpoint = (instrumentId = id) =>
  `/api/instruments/${encodeURIComponent(instrumentId)}/research-history`;
const panel = (page: Page) =>
  page.getByRole("region", { name: "人工历史资料", exact: true });
const previewPanel = (page: Page) =>
  page.getByRole("region", { name: "历史资料只读预览", exact: true });
const chartEvidence = (page: Page) =>
  page.getByRole("region", { name: "图表历史资料口径", exact: true });
const file = (manifest: unknown, name = "manual-history.json") => ({
  name,
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(manifest)),
});
async function login(page: Page) {
  const response = await page.request.post("/api/login", {
    headers,
    data: { password: "e2e-only-password" },
  });
  expect(response.status()).toBe(200);
}
async function openResearch(page: Page, symbol: string) {
  await page.goto("/");
  await page.getByRole("button", { name: symbol, exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
async function snapshot(page: Page, instrumentId = id) {
  const boot = (await (
    await page.request.get("/api/bootstrap")
  ).json()) as Bootstrap;
  return {
    plans: boot.plans,
    funds: boot.funds,
    events: boot.events,
    capabilities: boot.capabilities,
    instruments: boot.instruments,
    history: await (await page.request.get(endpoint(instrumentId))).json(),
    evidence: await (
      await page.request.get(
        `/api/instruments/${encodeURIComponent(instrumentId)}/action-evidence`,
      )
    ).json(),
  };
}
async function importViaApi(page: Page, manifest: unknown) {
  const preview = await page.request.post(`${endpoint()}/preview`, {
    headers,
    data: { manifest },
  });
  expect(preview.status()).toBe(200);
  const p = (await preview.json()) as ResearchHistoryPreview;
  const imported = await page.request.post(endpoint(), {
    headers,
    data: {
      manifest,
      token: p.token,
      expectedHistoryId: p.expectedHistoryId,
      expectedActionVersion: p.expectedActionVersion,
      confirmed: true,
    },
  });
  expect(imported.status()).toBe(200);
  return (await imported.json()).history;
}

test("manual history stays preview-only until confirmed, drives all charts, and saves an explicitly adopted research draft", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const original: PlanInput = {
    instrumentId: id,
    anchorTime: null,
    primarySupport: "50",
    lower: "49.75",
    upper: "50.25",
    stop: "49.4",
    entryMin: "50.61",
    entryMax: "51.50",
    sessionDate: "2026-10-09",
    mode: "CLOSE_CONFIRM",
    reason: "导入前的人工研究计划",
    backgroundConfirmed: true,
    supportSelections: [],
  };
  const created = await page.request.post("/api/plans", {
    headers,
    data: original,
  });
  expect(created.status()).toBe(200);
  const originalPlan = await created.json();
  await openResearch(page, "HISTORY.US");
  await page.getByLabel("主支撑价", { exact: true }).fill("50.01");
  const downloadPromise = page.waitForEvent("download");
  await panel(page)
    .getByRole("link", { name: "下载历史资料 JSON 模板" })
    .click();
  const download = await downloadPromise;
  const template = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(template.schema).toBe("pullback-lab-research-history-v1");
  expect(template.instrumentId).toBe(id);
  expect(template.bars.map((bar: { period: string }) => bar.period)).toEqual([
    "1D",
    "1m",
    "5m",
  ]);
  await expect(page.getByLabel("选择研究标的")).toHaveValue(id);

  const uploads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/research-history")
    )
      uploads.push(request.url());
  });
  const before = await snapshot(page);
  await panel(page)
    .getByLabel("选择历史资料 JSON")
    .setInputFiles(file(researchHistoryFixture()));
  await expect(
    panel(page).getByRole("button", { name: "只读预览", exact: true }),
  ).toBeEnabled();
  expect(uploads).toEqual([]);
  await panel(page)
    .getByRole("button", { name: "只读预览", exact: true })
    .click();
  await expect(previewPanel(page)).toContainText("只读预览 · 尚未写入");
  await expect(previewPanel(page)).toContainText(
    "日线 1 · 1 分钟 5 · 5 分钟 1",
  );
  await expect(
    previewPanel(page).getByRole("button", { name: "确认导入历史资料" }),
  ).toBeDisabled();
  expect(await snapshot(page)).toEqual(before);
  expect(uploads).toHaveLength(1);
  await previewPanel(page).getByRole("checkbox").check();
  const importedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/research-history"),
  );
  await previewPanel(page)
    .getByRole("button", { name: "确认导入历史资料" })
    .click();
  const imported = await (await importedResponse).json();
  expect(imported.status).toBe("IMPORTED");
  await expect(panel(page)).toContainText("资料已原子导入");
  await expect(page.getByLabel("主支撑价", { exact: true })).toHaveValue(
    "50.01",
  );
  await expect(page.getByLabel("计划交易日", { exact: true })).toHaveValue(
    "2026-10-09",
  );
  await expect(chartEvidence(page)).toContainText(
    "人工历史重建 · 非当时已知 · 正式提醒禁用",
  );
  await expect(chartEvidence(page)).toContainText("实际导入时间");
  await expect(panel(page)).toContainText("请保存新版本");
  const dailyResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/bars?period=1D&anchorTime=") &&
      !response.url().includes("anchorTime=0") &&
      response.url().includes("historyId="),
  );
  await page.getByLabel("选择 AVWAP 锚点日期").selectOption({ index: 1 });
  const daily = (await (await dailyResponse).json()) as ResearchChartData;
  expect(daily.bars[0].close).toBe("51");
  expect(daily.synthetic).toBe(false);
  expect(daily.avwap[0]).toMatch(/^50\.666/);
  for (const period of ["1m", "5m"] as const) {
    const response = page.waitForResponse(
      (r) =>
        r.url().includes(`/bars?period=${period}&`) &&
        r.url().includes("historyId="),
    );
    await page
      .getByRole("button", {
        name: period === "1m" ? "1 分钟" : "5 分钟",
        exact: true,
      })
      .click();
    const chart = (await (await response).json()) as ResearchChartData;
    expect(chart.bars).toHaveLength(period === "1m" ? 5 : 1);
    expect(chart.avwap.every((value) => value === daily.avwap[0])).toBe(true);
    expect(
      chart.avwapCutoffs?.every(
        (value) => value === Date.parse("2026-10-08T20:00:00Z") / 1000,
      ),
    ).toBe(true);
    const details = chartEvidence(page).getByText(
      "查看服务端 AVWAP 精确值与逐点截止",
      { exact: true },
    );
    if (
      (await chartEvidence(page).locator("details").getAttribute("open")) ===
      null
    )
      await details.click();
    await expect(chartEvidence(page).locator("ol")).toContainText(
      daily.avwap[0]!,
    );
    await expect(chartEvidence(page)).toContainText("2026-10-08 20:00:00 UTC");
  }
  await page
    .getByLabel("计划依据")
    .fill("人工核对历史来源与价格；仅保存研究草稿。");
  const save = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/plans/${originalPlan.id}/versions`),
  );
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  const savedResponse = await save;
  expect(savedResponse.status()).toBe(200);
  const saved = await savedResponse.json();
  expect(saved.researchHistoryId).toBe(imported.history.id);
  expect(saved.primarySupport).toBe("50.01");
  expect(saved.anchorTime).toBe(daily.bars[0].time);
  expect(saved.status).toBe("DRAFT");
  await expect(
    page.getByRole("button", { name: "启用合成计划观察", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "支撑家族与证据" }),
  ).toContainText("人工历史重建资料仅供研究");

  // A new import elsewhere cannot silently switch the saved draft to new evidence.
  const updated = await importViaApi(page, {
    ...researchHistoryFixture(),
    source: "SYNTHETIC REVISED OFFLINE TEST ONLY",
  });
  await openResearch(page, "HISTORY.US");
  await expect(chartEvidence(page)).toContainText("旧图仅供查阅，不能覆盖保存");
  await expect(
    page.getByRole("button", { name: "保存新版本", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("主支撑价", { exact: true })).toHaveValue(
    "50.01",
  );
  await panel(page)
    .getByRole("button", { name: "用于当前计划草稿", exact: true })
    .click();
  await expect(chartEvidence(page)).toContainText(updated.source);
  await expect(
    page.getByRole("button", { name: "保存新版本", exact: true }),
  ).toBeEnabled();
  expect(
    (await snapshot(page)).plans.find((plan) => plan.id === saved.id)
      ?.researchHistoryId,
  ).toBe(imported.history.id);
  await expect(page.locator(".research-evidence")).toContainText(
    "候选池为当前资料",
  );
  await expect(page.locator(".research-evidence .evidence-grid")).toHaveCount(
    0,
  );
  const draftBeforeRead = await page.locator(".plan-editor").innerText();
  const persistedBeforeRead = await snapshot(page);
  await panel(page)
    .getByLabel("只读查阅历史资料图表", { exact: true })
    .selectOption(imported.history.id);
  await expect(chartEvidence(page)).toContainText("旧图仅供查阅，不能覆盖保存");
  await expect(
    page.getByRole("button", { name: "保存新版本", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("主支撑价", { exact: true })).toHaveValue(
    "50.01",
  );
  await expect(panel(page).locator(".current-history summary")).toContainText(
    "已用于当前草稿",
  );
  expect((await snapshot(page)).plans).toEqual(persistedBeforeRead.plans);
  await panel(page)
    .getByRole("button", { name: "返回当前草稿图表", exact: true })
    .click();
  await expect(chartEvidence(page)).toContainText(updated.source);
  await expect(
    page.getByRole("button", { name: "保存新版本", exact: true }),
  ).toBeEnabled();
  expect(await page.locator(".plan-editor").innerText()).toEqual(
    draftBeforeRead,
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".research-history h3",
  });
  const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.fonts.some((font) => font.glyphCount > 0)).toBe(true);
  console.log(
    "RESEARCH_HISTORY_BROWSER",
    browser.version(),
    "RENDERED_FONTS",
    JSON.stringify(fonts.fonts),
  );
  await cdp.detach();
  await panel(page).screenshot({
    path: test.info().outputPath("research-history-desktop-panel.png"),
  });
  await chartEvidence(page).screenshot({
    path: test.info().outputPath("research-history-desktop-chart-evidence.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel(page).scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    await panel(page).evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await panel(page).screenshot({
    path: test.info().outputPath("research-history-mobile-panel.png"),
  });
  await chartEvidence(page).screenshot({
    path: test.info().outputPath("research-history-mobile-chart-evidence.png"),
  });
  expect(errors).toEqual([]);
});

test("invalid files, cancellation, file replacement, and late preview responses cannot change a different research context", async ({
  page,
}) => {
  await login(page);
  await openResearch(page, "OTHER.US");
  const region = panel(page);
  const input = region.getByLabel("选择历史资料 JSON");
  const valid = { ...researchHistoryFixture(), instrumentId: otherId };
  const before = await snapshot(page, otherId);
  await input.setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await expect(region.getByRole("alert")).toContainText("不是有效 JSON");
  await input.setInputFiles({
    name: "too-large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1, " "),
  });
  await expect(region.getByRole("alert")).toContainText("不能超过 2 MiB");
  await input.setInputFiles(file({ ...valid, bars: [] }));
  await expect(region.getByRole("alert")).toHaveCount(0);
  await region.getByRole("button", { name: "只读预览", exact: true }).click();
  await expect(region.getByRole("alert")).toContainText("历史资料字段无效");
  await input.setInputFiles(file(valid));
  await expect(region.getByRole("alert")).toHaveCount(0);

  for (const action of ["cancel", "replace", "switch"] as const) {
    await input.setInputFiles(file(valid));
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route("**/research-history/preview", async (route) => {
      const response = await route.fetch();
      arrived();
      await held;
      await route.fulfill({ response });
    });
    await region.getByRole("button", { name: "只读预览", exact: true }).click();
    await received;
    if (action === "cancel")
      await region.getByRole("button", { name: "取消本次资料" }).click();
    else if (action === "replace")
      await input.setInputFiles({
        name: "replacement.json",
        mimeType: "application/json",
        buffer: Buffer.from("invalid"),
      });
    else await page.getByLabel("选择研究标的").selectOption(id);
    const returned = page.waitForResponse((response) =>
      response.url().endsWith("/research-history/preview"),
    );
    release();
    await returned;
    await expect(previewPanel(page)).toHaveCount(0);
    if (action === "replace")
      await expect(region.getByRole("alert")).toContainText("不是有效 JSON");
    if (action === "switch") {
      await expect(page.getByLabel("选择研究标的")).toHaveValue(id);
      await expect(
        region.getByText("已选择：manual-history.json", { exact: true }),
      ).toHaveCount(0);
    }
    await page.unroute("**/research-history/preview");
  }
  const after = await snapshot(page, otherId);
  expect(after).toEqual(before);
  expect((after.history as ResearchHistoryStatus).current).toBeNull();
});
