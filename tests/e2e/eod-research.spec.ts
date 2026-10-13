import { expect, test } from "@playwright/test";
test("audited US and CN EOD captures reach research without a live adapter", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const login = await page.request.post("/api/login", {
    headers: { "X-Requested-With": "PullbackLab" },
    data: { password: "e2e-only-password" },
  });
  expect(login.status()).toBe(200);
  await page.goto("/");
  const candidates = await (await page.request.get("/api/candidates")).json();
  for (const symbol of ["EOD.US", "600000.SH"])
    expect(
      candidates.candidates.find((c: any) => c.instrument.symbol === symbol),
    ).toMatchObject({ origin: "PROVIDER", health: { state: "VERIFIED" } });
  const bootstrap = await (await page.request.get("/api/bootstrap")).json();
  expect(bootstrap.intrabarEligibleInstrumentIds).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("eod-research-candidates-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "EOD.US", exact: true }).click();
  const chart = page.locator(".chart-panel");
  await expect(chart.getByLabel("日线来源依据")).toContainText(
    "正式监测仍须单独核验",
  );
  await expect(chart.locator("canvas").first()).toBeVisible();
  const daily = await (
    await page.request.get("/api/instruments/EOD-US/bars")
  ).json();
  expect(daily.providerContext.id).toMatch(/^eod-context:/);
  expect(daily.providerContext.researchOnly).toBe(true);
  expect(daily.bars.length).toBeGreaterThanOrEqual(250);
  await page.screenshot({
    path: testInfo.outputPath("eod-research-chart-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chart.getByLabel("日线来源依据")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await chart.screenshot({
    path: testInfo.outputPath("eod-research-chart-mobile.png"),
  });
  expect(errors).toEqual([]);
});
