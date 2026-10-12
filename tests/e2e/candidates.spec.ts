import { expect, test, type Page } from "@playwright/test";
import type {
  CandidatePage,
  ScreeningSettings,
} from "../../packages/contracts/index";
import type { UniverseSnapshot } from "../../packages/contracts/universe";

const headers = { "X-Requested-With": "PullbackLab" };
const rulesRegion = (page: Page) =>
  page.getByRole("region", { name: "C 类筛选参数", exact: true });
const candidateRow = (page: Page, symbol: string) =>
  page.locator(".candidate-table tbody tr").filter({ hasText: symbol });

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("访问密码").fill("e2e-only-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "候选池" })).toBeVisible();
}

async function settings(page: Page): Promise<ScreeningSettings> {
  const response = await page.request.get("/api/settings/screening");
  expect(response.status()).toBe(200);
  return response.json() as Promise<ScreeningSettings>;
}

async function candidates(page: Page): Promise<CandidatePage> {
  const response = await page.request.get("/api/candidates");
  expect(response.status()).toBe(200);
  return response.json() as Promise<CandidatePage>;
}

async function confirmRules(page: Page) {
  const editor = rulesRegion(page);
  await editor
    .getByLabel("我已核对这些工程筛选参数，并确认保存为新版本")
    .check();
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings/screening") &&
      response.request().method() === "POST",
  );
  await editor.getByRole("button", { name: "确认保存筛选规则" }).click();
  return submitted;
}

test("mixed-market imports keep manual provenance and preserve observation drafts on conflict", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await login(page);
  await expect(page.getByText("从第一只观察标的开始")).toBeVisible();
  await page.getByRole("button", { name: "批量导入", exact: true }).click();
  const importer = page.getByRole("region", { name: "批量导入观察标的" });
  await importer
    .getByLabel("粘贴代码列表")
    .fill("US,aapl.us,Apple\nCN,600519.sh,贵州茅台\nUS,AAPL.US,重复名称不覆盖");
  await expect(importer).toContainText("新增 2 · 已有 0 · 重复 1 · 错误 0");
  await importer.getByRole("button", { name: "确认导入观察列表" }).click();
  await expect(importer).toContainText("新增 2 只，已有 0 只，重复 1 行");
  await importer.getByRole("button", { name: "收起", exact: true }).click();
  await expect(candidateRow(page, "AAPL.US")).toHaveCount(1);
  await expect(candidateRow(page, "AAPL.US")).toContainText("人工");
  await expect(candidateRow(page, "AAPL.US")).toContainText("暂无完成日线");
  await expect(candidateRow(page, "AAPL.US")).toContainText("缺少历史数据");
  await expect(page.locator('[aria-label="供应商额度"]')).toContainText(
    "供应商额度：未知",
  );
  const initial = await candidates(page);
  expect(initial.candidates).toHaveLength(2);
  for (const row of initial.candidates) {
    expect(row).toMatchObject({
      manual: true,
      origin: "MANUAL",
      screeningStatus: "UNKNOWN",
      dataCutoff: null,
      health: { state: "MISSING" },
    });
  }
  expect(initial.workerHealth.providerQuotaVerified).toBe(false);
  await page
    .locator('[aria-label="候选市场"]')
    .getByRole("button", { name: /A 股/ })
    .click();
  await expect(candidateRow(page, "600519.SH")).toContainText("人工");
  await page
    .locator('[aria-label="候选市场"]')
    .getByRole("button", { name: /美股/ })
    .click();
  await page.getByRole("button", { name: "AAPL.US", exact: true }).click();
  await page.getByLabel("人工主题标签").fill("消费电子，长期跟踪");
  await page
    .getByRole("textbox", { name: "观察笔记", exact: true })
    .fill("人工观察：尚无已验证行情，不构成筛选通过。");
  await page.getByRole("button", { name: "保存观察笔记" }).click();
  await expect(
    page.getByText("主题标签和观察笔记已保存。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "AAPL.US", exact: true }).click();
  await expect(page.getByLabel("人工主题标签")).toHaveValue(
    "消费电子，长期跟踪",
  );
  await expect(
    page.getByRole("textbox", { name: "观察笔记", exact: true }),
  ).toHaveValue("人工观察：尚无已验证行情，不构成筛选通过。");

  const universe = (await (
    await page.request.get("/api/universe")
  ).json()) as UniverseSnapshot;
  const external = await page.request.patch("/api/universe/US:AAPL.US", {
    headers,
    data: {
      expectedRevision: universe.universeRevision,
      tags: ["另一标签页"],
      note: "另一标签页的观察依据",
    },
  });
  expect(external.status()).toBe(200);
  const draft = "本标签页补充的观察笔记，重读后保留并保存。";
  await page
    .getByRole("textbox", { name: "观察笔记", exact: true })
    .fill(draft);
  await page.getByRole("button", { name: "保存观察笔记" }).click();
  const conflict = page.getByRole("region", { name: "观察笔记版本冲突复核" });
  await expect(conflict).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "观察笔记", exact: true }),
  ).toHaveValue(draft);
  await conflict
    .getByRole("button", { name: "读取最新观察内容，保留输入" })
    .click();
  await expect(
    page.getByText("另一标签页的观察依据", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "观察笔记", exact: true }),
  ).toHaveValue(draft);
  await page.getByRole("button", { name: "保存观察笔记" }).click();
  await expect(
    page.getByText("主题标签和观察笔记已保存。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(candidateRow(page, "AAPL.US")).toContainText("消费电子");
  await page.getByRole("button", { name: "AAPL.US", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "观察笔记", exact: true }),
  ).toHaveValue(draft);
  await page.screenshot({
    path: test.info().outputPath("manual-observation.png"),
    fullPage: true,
  });
  // A candidate list and the mutation baseline must describe the same universe.
  // One stale endpoint cannot pair an old note with the newest CAS revision.
  const oldPage = await candidates(page);
  const newestNote = "并发快照核验：必须显示这份最新观察笔记。";
  const advanced = await page.request.patch("/api/universe/US:AAPL.US", {
    headers,
    data: {
      expectedRevision: oldPage.universeRevision,
      tags: ["一致快照"],
      note: newestNote,
    },
  });
  expect(advanced.status()).toBe(200);
  let refreshedLists = 0;
  const countLists = (request: import("@playwright/test").Request) => {
    if (request.url().endsWith("/api/candidates")) refreshedLists++;
  };
  page.on("request", countLists);
  await page.route(
    "**/api/candidates",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(oldPage),
      }),
    { times: 1 },
  );
  await page.reload();
  await page.getByRole("button", { name: "AAPL.US", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "观察笔记", exact: true }),
  ).toHaveValue(newestNote);
  await expect(page.getByLabel("人工主题标签")).toHaveValue("一致快照");
  expect(refreshedLists).toBeGreaterThanOrEqual(2);
  page.off("request", countLists);
  expect(failures).toEqual([]);
});

test("screening versions survive refresh and conflicts without stale candidate replacement", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await login(page);
  expect(
    (await page.request.post("/api/demo/seed", { headers })).status(),
  ).toBe(200);
  await page.reload();
  await page.getByRole("button", { name: "确认使用预设", exact: true }).click();
  await expect(candidateRow(page, "DEMO-A.US")).toContainText("筛选通过");
  expect((await settings(page)).version).toBe(1);
  await page.getByRole("button", { name: "设置与资金快照 ↗" }).click();
  const editor = rulesRegion(page);
  await editor.getByLabel("美股 ADV20 下限（USD）").fill("1000000000000");
  await editor.getByLabel("ADR20 下限（%）").fill("0");
  await editor.getByLabel("ADR20 上限（%）").fill("0");
  expect((await confirmRules(page)).status()).toBe(200);
  await expect(editor).toContainText("筛选规则第 2 版已保存");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(candidateRow(page, "DEMO-A.US")).toContainText("未通过");
  await page.reload();
  await expect(candidateRow(page, "DEMO-A.US")).toContainText("未通过");
  await page.getByRole("button", { name: "设置与资金快照 ↗" }).click();
  await expect(editor).toContainText("当前第 2 版");
  await expect(editor.getByLabel("美股 ADV20 下限（USD）")).toHaveValue(
    "1000000000000",
  );
  await expect(editor.getByLabel("ADR20 上限（%）")).toHaveValue("0");

  const current = await settings(page);
  const external = await page.request.post("/api/settings/screening", {
    headers,
    data: {
      confirmed: true,
      expectedVersion: current.version,
      parameters: { ...current.defaultParameters, limitPerMarket: 1 },
    },
  });
  expect(external.status()).toBe(200);
  await editor.getByLabel("美股 ADV20 下限（USD）").fill("30000000");
  await editor.getByLabel("ADR20 上限（%）").fill("10");
  expect((await confirmRules(page)).status()).toBe(409);
  const conflict = page.getByRole("region", { name: "筛选规则版本冲突复核" });
  await expect(conflict).toBeVisible();
  await expect(editor.getByLabel("美股 ADV20 下限（USD）")).toHaveValue(
    "30000000",
  );
  await expect(editor.getByLabel("ADR20 上限（%）")).toHaveValue("10");
  await conflict
    .getByRole("button", { name: "读取最新筛选规则，保留输入" })
    .click();
  await expect(editor).toContainText("服务端第 3 版参数");
  await expect(editor.getByLabel("美股 ADV20 下限（USD）")).toHaveValue(
    "30000000",
  );
  expect((await confirmRules(page)).status()).toBe(200);
  await expect(editor).toContainText("筛选规则第 4 版已保存");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(candidateRow(page, "DEMO-A.US")).toContainText("筛选通过");
  const saved = await settings(page);
  expect(saved.current?.parameters).toMatchObject({
    minimumAdv20: { US: "30000000" },
    adrMaxPct: "10",
  });

  await page.route(
    "**/api/candidates",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "CANDIDATE_TEST_UNAVAILABLE",
          error: "候选服务暂时不可用（浏览器验收）",
        }),
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "候选数据状态" }),
  ).toContainText("候选服务暂时不可用（浏览器验收）");
  await expect(
    page.getByRole("status", { name: "候选数据状态" }),
  ).toContainText("已保留上次候选结果");
  await expect(candidateRow(page, "DEMO-A.US")).toContainText("筛选通过");

  // Hold an old candidate response while a separately confirmed rule starts a
  // newer refresh. Finishing the older request must not restore its PASS rows.
  let releaseOld!: () => void;
  let startedOld!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    startedOld = resolve;
  });
  const oldRelease = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let completedOld!: () => void;
  const oldCompleted = new Promise<void>((resolve) => {
    completedOld = resolve;
  });
  await page.route(
    "**/api/candidates",
    async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      startedOld();
      await oldRelease;
      try {
        await route.fulfill({ response, body });
      } finally {
        completedOld();
      }
    },
    { times: 1 },
  );
  try {
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await oldStarted;
    await page.getByRole("button", { name: "设置与资金快照 ↗" }).click();
    await editor.getByLabel("美股 ADV20 下限（USD）").fill("1000000000000");
    expect((await confirmRules(page)).status()).toBe(200);
    await expect(editor).toContainText("筛选规则第 5 版已保存");
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(candidateRow(page, "DEMO-A.US")).toContainText("未通过");
    const oldResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/candidates"),
    );
    releaseOld();
    await oldCompleted;
    await (await oldResponse).finished();
    // Wait through the browser's next paint after response parsing and React's update.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(candidateRow(page, "DEMO-A.US")).toContainText("未通过");
    expect((await candidates(page)).rules.version).toBe(5);
  } finally {
    releaseOld();
  }
  await page.reload();
  await expect(candidateRow(page, "DEMO-A.US")).toContainText("未通过");
  await page.screenshot({
    path: test.info().outputPath("candidate-rules.png"),
    fullPage: true,
  });
  expect(failures).toEqual([]);
});
