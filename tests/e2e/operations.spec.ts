import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Bootstrap } from "../../packages/contracts/index";
import type { OperationsStatus } from "../../packages/contracts/operations";

const headers = { "X-Requested-With": "PullbackLab" };
const reportRegion = (page: Page) =>
  page.getByRole("region", { name: "运行诊断", exact: true });
const statusPath = "**/api/operations/status";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("访问密码").fill("e2e-only-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "候选池" })).toBeVisible();
}

async function openReport(page: Page): Promise<OperationsStatus> {
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/operations/status"),
  );
  await page.getByRole("button", { name: "设置与资金快照 ↗" }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  await expect(reportRegion(page)).toContainText("已读取运行状态。");
  return result.json() as Promise<OperationsStatus>;
}

async function researchState(page: Page) {
  const response = await page.request.get("/api/bootstrap");
  expect(response.status()).toBe(200);
  const {
    funds,
    plans,
    instruments,
    universeRevision,
    events,
    screeningRules,
  } = (await response.json()) as Bootstrap;
  return {
    funds,
    plans,
    instruments,
    universeRevision,
    events,
    screeningRules,
  };
}

test("encoded API paths retain the private browser security boundary", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("访问密码")).toBeVisible();
  // Browser fetch exercises the production router and static wildcard together.
  const anonymous = await page.evaluate(async () => {
    const results = [];
    for (const path of [
      "/api/bootstrap",
      "/%61pi/bootstrap",
      "/a%70i/operations/status",
      "/ap%69/events/stream",
      "/%61pi/instruments/PRIVATE.US/provider-receipts?period=1m",
    ]) {
      const response = await fetch(path);
      results.push({
        path,
        status: response.status,
        code: (await response.json()).code,
        cache: response.headers.get("cache-control"),
      });
    }
    return results;
  });
  for (const result of anonymous)
    expect(result, result.path).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
      cache: "no-store",
    });
  const denied = await page.request.post("/%61pi/universe", {
    headers,
    data: { symbol: "DENIED.US", market: "US" },
  });
  expect(denied.status()).toBe(401);
  await login(page);
  const before = await researchState(page);
  const csrf = await page.request.post("/a%70i/universe", {
    data: { symbol: "DENIED.US", market: "US" },
  });
  expect(csrf.status()).toBe(403);
  expect((await csrf.json()).code).toBe("CSRF_REJECTED");
  const foreign = await page.request.post("/ap%69/universe", {
    headers: { Origin: "https://research.trycloudflare.com" },
    data: { symbol: "DENIED.US", market: "US" },
  });
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).code).toBe("CSRF_REJECTED");
  expect(await researchState(page)).toEqual(before);
  expect(
    before.instruments.some((instrument) => instrument.symbol === "DENIED.US"),
  ).toBe(false);
  const encoded = await page.request.get("/%61pi/bootstrap", {
    headers: { Origin: "https://research.trycloudflare.com" },
  });
  expect(encoded.status()).toBe(200);
  expect((await encoded.json()).instruments).toEqual(before.instruments);
});

test("private diagnostics are loaded on demand and export only a read-only redacted report", async ({
  page,
}) => {
  const anonymous = await page.request.get("/api/operations/status");
  expect(anonymous.status()).toBe(401);
  expect(await anonymous.text()).not.toContain("nodeVersion");
  let statusRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/operations/status")) statusRequests++;
  });
  await login(page);
  expect(statusRequests).toBe(0);
  expect(
    (
      await page.request.post("/api/universe", {
        headers,
        data: {
          symbol: "PRIVATE.US",
          market: "US",
          name: "私有标的名称不可出现在诊断报告",
          note: "private-observation-secret-6759",
        },
      })
    ).status(),
  ).toBe(200);
  const before = await researchState(page);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET")
      mutations.push(`${request.method()} ${request.url()}`);
  });
  const captured = await openReport(page);
  const region = reportRegion(page);
  await expect(region).toContainText("报告采集时可访问");
  await expect(region).toContainText("美股：未知 · A 股：未知");
  await expect(region).toContainText("未知 · 尚未独立验证");
  await expect(region).toContainText("尚未确认");
  expect(captured).toMatchObject({
    reportVersion: 1,
    runtime: { journalMode: "wal", synchronous: "FULL" },
    markets: { US: "UNKNOWN", CN: "UNKNOWN" },
    clock: { status: "UNKNOWN", checkedAt: null },
    funds: { present: false },
  });
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: /恢复备份|还原数据库/ }),
  ).toHaveCount(0);
  const downloadEvent = page.waitForEvent("download");
  await region.getByRole("button", { name: "下载脱敏运行报告" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^pullback-status-.*\.json$/);
  const saved = await download.path();
  expect(saved).not.toBeNull();
  const serialized = await readFile(saved!, "utf8");
  expect(JSON.parse(serialized)).toEqual(captured);
  for (const forbidden of [
    "e2e-only-password",
    "PRIVATE.US",
    "私有标的名称不可出现在诊断报告",
    "private-observation-secret-6759",
    "research.sqlite",
    "/workspace/",
    "/tmp/",
    '"cash"',
    '"equity"',
    '"token"',
    '"password"',
  ])
    expect(serialized).not.toContain(forbidden);
  for (const cookie of await page.context().cookies())
    expect(serialized).not.toContain(cookie.value);
  expect(await researchState(page)).toEqual(before);
  expect(mutations).toEqual([]);
  await region
    .getByRole("heading", { name: "运行状态", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("operations-status.png"),
    fullPage: true,
  });
});

test("diagnostics retain their old timestamp on failure and reject late refreshes", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await login(page);
  const captured = await openReport(page);
  const region = reportRegion(page);
  const capturedTime = new Date(captured.capturedAt).toISOString();
  await expect(region.locator("time")).toHaveAttribute(
    "datetime",
    capturedTime,
  );
  await page.route(
    statusPath,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "STATUS_UNAVAILABLE",
          error: "/private/server/path contains credential-secret-9283",
        }),
      }),
    { times: 1 },
  );
  await region.getByRole("button", { name: "刷新运行状态" }).click();
  await expect(region).toContainText("运行状态暂不可读（HTTP 503）");
  await expect(region).toContainText("已保留上次报告，采集时间未更新。");
  await expect(region.locator("time")).toHaveAttribute(
    "datetime",
    capturedTime,
  );
  await expect(region).not.toContainText("credential-secret");
  await expect(region).not.toContainText("/private/server");
  await expect(
    region.getByRole("button", { name: "下载脱敏运行报告" }),
  ).toBeEnabled();

  let releaseOld!: () => void;
  let startedOld!: () => void;
  let completedOld!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    startedOld = resolve;
  });
  const oldRelease = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldCompleted = new Promise<void>((resolve) => {
    completedOld = resolve;
  });
  const oldReport = {
    ...captured,
    capturedAt: captured.capturedAt - 86_400_000,
  };
  const newestReport = {
    ...captured,
    capturedAt: captured.capturedAt + 60_000,
  };
  let refreshCount = 0;
  await page.route(statusPath, async (route) => {
    if (++refreshCount !== 1) {
      await route.fulfill({ json: newestReport });
      return;
    }
    startedOld();
    await oldRelease;
    try {
      await route.fulfill({ json: oldReport });
    } catch {
      // The refreshed request deliberately aborts the older network request.
    } finally {
      completedOld();
    }
  });
  try {
    await region.getByRole("button", { name: "刷新运行状态" }).click();
    await oldStarted;
    await expect(region).toHaveAttribute("aria-busy", "true");
    await expect(region).toContainText("正在刷新，以下为上次报告。");
    await region.getByRole("button", { name: "刷新运行状态" }).click();
    await expect(region.locator("time")).toHaveAttribute(
      "datetime",
      new Date(newestReport.capturedAt).toISOString(),
    );
    releaseOld();
    await oldCompleted;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(region.locator("time")).toHaveAttribute(
      "datetime",
      new Date(newestReport.capturedAt).toISOString(),
    );
    await expect(region).toHaveAttribute("aria-busy", "false");
    await expect(region).toContainText("已读取运行状态。");
    expect(failures).toEqual([]);
  } finally {
    releaseOld();
    await page.unroute(statusPath);
  }
});
