import { expect, test, type Page } from "@playwright/test";
import type { EvidenceHistory } from "../../packages/contracts/action-evidence";

const panel = (page: Page) =>
  page.getByRole("region", { name: "公司行动证据", exact: true });
const base = "/api/instruments/DEMO-US-A/action-evidence";
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("访问密码").fill("e2e-only-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "候选池" })).toBeVisible();
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
}
async function snapshot(page: Page) {
  const response = await page.request.get("/api/bootstrap");
  const {
    funds,
    plans,
    instruments,
    universeRevision,
    events,
    screeningRules,
    capabilities,
  } = await response.json();
  return {
    funds,
    plans,
    instruments,
    universeRevision,
    events,
    screeningRules,
    capabilities,
  };
}

test("on-demand provenance, immutable history, comparison and plain-text documents keep research unchanged", async ({
  page,
}) => {
  const errors: string[] = [],
    mutations: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/action-evidence")) requests.push(r.url());
  });
  await login(page);
  expect(requests).toHaveLength(0);
  const before = await snapshot(page);
  page.on("request", (r) => {
    if (r.url().includes("/api/") && r.method() !== "GET")
      mutations.push(r.method());
  });
  const region = panel(page);
  await region.getByRole("button", { name: "查看证据", exact: true }).click();
  await expect(region).toContainText("synthetic-fixture-v22");
  await expect(region).toContainText("读取时的最新收录");
  await expect(region).toContainText("覆盖待核验");
  await expect(region).toContainText("资料收录不代表真实行情已验证");
  await expect(region.getByRole("option")).toHaveCount(20);
  expect(requests.filter((p) => p.includes("/documents/"))).toHaveLength(0);
  await region.getByText("与前一收录版本比较", { exact: true }).click();
  await expect(region).toContainText("公司行动 split · 移除");
  await expect(region).toContainText("公司行动 cash · 新增");
  await expect(region).toContainText("来源资料 doc · 变更");
  await region
    .getByRole("button", { name: "查看原文 doc", exact: true })
    .click();
  await expect(region.getByLabel("已存原文 doc")).toContainText(
    "<script>window.evidenceExecuted = true</script>",
  );
  expect(await page.evaluate(() => "evidenceExecuted" in window)).toBe(false);
  await region.getByRole("button", { name: "读取更早版本" }).click();
  await expect(region.getByRole("option")).toHaveCount(22);
  const firstVersion = await region
    .getByRole("option")
    .last()
    .getAttribute("value");
  await region.getByLabel("收录版本").selectOption(firstVersion!);
  await expect(region).toContainText("历史收录 · 仅供查阅");
  await expect(region).toContainText("synthetic-fixture-v1");
  await expect(region.getByLabel("已存原文 doc")).toHaveCount(0);
  await region
    .getByRole("button", { name: "查看原文 doc", exact: true })
    .click();
  await expect(region.getByLabel("已存原文 doc")).toContainText(
    "2 shares after",
  );
  await region.getByText("与前一收录版本比较", { exact: true }).click();
  await expect(region).toContainText("首次收录，没有更早版本");
  await region.getByRole("button", { name: "重新读取证据" }).click();
  await expect(region).toContainText("synthetic-fixture-v22");
  expect(await snapshot(page)).toEqual(before);
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await region.scrollIntoViewIfNeeded();
  expect(await region.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await region.screenshot({ path: "test-results/evidence-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await region.screenshot({ path: "test-results/evidence-desktop.png" });
});

test("failed reads retry, switching securities discards late results, empty evidence stays unknown, and deleting referenced securities is blocked", async ({
  page,
}) => {
  await login(page);
  const region = panel(page);
  await page.route(
    `**${base}`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "测试读取失败", code: "TEST" },
      }),
    { times: 1 },
  );
  await region.getByRole("button", { name: "查看证据", exact: true }).click();
  await expect(region.getByRole("alert")).toContainText("测试读取失败");
  await region.getByRole("button", { name: "重试历史读取" }).click();
  await expect(region).toContainText("synthetic-fixture-v22");
  const data = (await (await page.request.get(base)).json()) as EvidenceHistory;
  const latest = `${base}/${encodeURIComponent(data.versions[0].version)}`;
  await page.route(
    `**${latest}/documents/doc`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "原文暂不可读", code: "TEST" },
      }),
    { times: 1 },
  );
  await region.getByRole("button", { name: "查看原文 doc" }).click();
  await expect(region.getByRole("alert")).toContainText("原文暂不可读");
  await region.getByRole("button", { name: "重试原文读取" }).click();
  await expect(region.getByLabel("已存原文 doc")).toContainText(
    "SYNTHETIC TEST ONLY",
  );
  await page.route(
    `**${latest}`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "版本暂不可读", code: "TEST" },
      }),
    { times: 1 },
  );
  await region.getByRole("button", { name: "重新读取证据" }).click();
  await expect(region.getByRole("alert")).toContainText("版本暂不可读");
  await region.getByRole("button", { name: "重试版本读取" }).click();
  await expect(region).toContainText("synthetic-fixture-v22");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(
    `**${latest}`,
    async (route) => {
      const response = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await region.getByRole("button", { name: "重新读取证据" }).click();
  await requested;
  try {
    await page.getByLabel("选择研究标的").selectOption("DEMO-US-B");
    await expect(
      region.getByRole("button", { name: "查看证据", exact: true }),
    ).toBeVisible();
    await region.getByRole("button", { name: "查看证据", exact: true }).click();
    await expect(region).toContainText("尚未收录公司行动证据");
  } finally {
    release();
  }
  await expect(region).not.toContainText("synthetic-fixture");
  await page.getByLabel("选择研究标的").selectOption("DEMO-US-A");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "移出观察列表", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("标的已有公司行动证据");
  await expect(page.getByLabel("选择研究标的")).toHaveValue("DEMO-US-A");
});
