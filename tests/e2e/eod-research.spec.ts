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
  const researchDaily = await (
    await page.request.get("/api/instruments/EOD-US/bars")
  ).json();
  const draftResponse = await page.request.post("/api/plans", {
    headers: { "X-Requested-With": "PullbackLab" },
    data: {
      instrumentId: "EOD-US",
      anchorTime: researchDaily.bars[10].time,
      primarySupport: "101",
      lower: "100.75",
      upper: "101.25",
      stop: "100.4",
      entryMin: "101.61",
      entryMax: "102.5",
      mode: "CLOSE_CONFIRM",
      sessionDate: "2026-10-12",
      reason: "Isolated EOD research plan, not real market evidence",
      backgroundConfirmed: true,
      supportSelections: [{ source: "EMA9" }, { source: "AVWAP" }],
    },
  });
  expect(draftResponse.status()).toBe(200);
  const draft = await draftResponse.json();
  expect(draft.status).toBe("DRAFT");
  expect(draft.supportSnapshot.researchContextId).toMatch(/^eod-context:/);
  expect(draft.supportSnapshot.providerContextId).toBeUndefined();
  expect(draft.supportSnapshot.ready).toBe(false);
  await page.reload();
  await page.getByRole("button", { name: "EOD.US", exact: true }).click();
  const chart = page.locator(".chart-panel");
  await expect(chart.getByLabel("日线来源依据")).toContainText(
    "正式监测仍须单独核验",
  );
  await expect(chart.locator("canvas").first()).toBeVisible();
  const support = page.getByRole("region", { name: "支撑家族与证据" });
  await expect(support).toContainText("已核验日线 · 研究专用");
  await expect(support).toContainText("正式监测仍须单独核验");
  const avwapLine = support
    .locator(".support-line")
    .filter({ hasText: "AVWAP" });
  // This fixture's HLC3 is (102 + 99 + 101) / 3. AVWAP uses HLC3,
  // not the endpoint's turnover/volume ratio.
  await expect(avwapLine.locator("dd").first()).toHaveText("100.666666…");
  await expect(avwapLine.locator("dd").first()).toHaveAttribute(
    "title",
    draft.supportSnapshot.lines.find((line: any) => line.source === "AVWAP")
      .price,
  );
  await expect(avwapLine).not.toContainText("数据不可用");
  await expect(
    page.getByText("已保存版本缺少完整支撑证据", { exact: false }),
  ).toHaveCount(0);

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
