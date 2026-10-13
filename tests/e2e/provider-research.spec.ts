import { expect, test } from "@playwright/test";
import type { CandidatePage } from "../../packages/contracts/index";
import type { ResearchChartData } from "../../packages/contracts/research-history";

test("audited server daily context reaches provider candidates and chart without promoting unknown inputs", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const login = await page.request.post("/api/login", {
    headers: { "X-Requested-With": "PullbackLab" },
    data: { password: "e2e-only-password" },
  });
  expect(login.status()).toBe(200);
  await page.goto("/");
  const providerRow = page
    .locator(".candidate-table tbody tr")
    .filter({ hasText: "CONTRACT.US" });
  await expect(providerRow).toContainText("日线依据已核验");
  await expect(providerRow).toContainText("日线与已审计服务端来源精确匹配");
  await expect(providerRow).not.toContainText("数据待核验");
  const pageData: CandidatePage = await (
    await page.request.get("/api/candidates")
  ).json();
  expect(
    pageData.candidates.find((c) => c.instrument.symbol === "CONTRACT.US"),
  ).toMatchObject({ origin: "PROVIDER", health: { state: "VERIFIED" } });
  expect(
    pageData.candidates.find((c) => c.instrument.symbol === "UNKNOWN.US"),
  ).toMatchObject({ screeningStatus: "UNKNOWN", health: { state: "MISSING" } });
  expect(pageData.workerHealth.liveEligible).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("provider-research-candidates-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "CONTRACT.US", exact: true }).click();
  const chart = page.locator(".chart-panel");
  await expect(chart.getByLabel("日线来源依据")).toContainText(
    "longbridge-node-5.2.0",
  );
  await expect(chart.getByLabel("日线来源依据")).toContainText(
    "正式监测仍须单独核验",
  );
  await expect(chart.locator("canvas").first()).toBeVisible();
  // Use the currently saved anchor, avoiding a browser-only source/verification fixture.
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const anchored: ResearchChartData = await (
    await page.request.get(
      `/api/instruments/CONTRACT-US-A/bars?anchorTime=${boot.plans[0].anchorTime}`,
    )
  ).json();
  expect(anchored.bars.length).toBeGreaterThanOrEqual(250);
  expect(anchored.providerContext).toMatchObject({
    source: "longbridge-node-5.2.0",
    researchOnly: true,
  });
  expect(anchored.avwap.at(-1)).not.toBeNull();
  expect(anchored.synthetic).toBe(false);
  await chart.screenshot({
    path: testInfo.outputPath("provider-research-chart-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chart.getByLabel("日线来源依据")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await chart.screenshot({
    path: testInfo.outputPath("provider-research-chart-mobile.png"),
  });
  expect(errors).toEqual([]);
});
