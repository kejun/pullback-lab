import { expect, test } from "@playwright/test";
const headers = { "X-Requested-With": "PullbackLab" };
test("intrabar uses exact-instrument eligibility, explicit confirmation, cancellation, and a visible blocked reason", async ({
  page,
  browser,
}, testInfo) => {
  expect(
    (
      await page.request.post("/api/login", {
        headers,
        data: { password: "e2e-only-password" },
      })
    ).status(),
  ).toBe(200);
  await page.goto("/");
  await page.getByRole("button", { name: "CONTRACT.US", exact: true }).click();
  const panel = page.getByRole("region", { name: "正式盘中监测", exact: true });
  await expect(panel).toContainText("服务器已核验连续逐笔协议与收盘资格");
  await expect(panel).toContainText("盘中穿越需要参考就绪后的连续两笔成交");
  const activate = panel.getByRole("button", {
    name: "启用正式盘中监测",
    exact: true,
  });
  await expect(activate).toBeEnabled();
  await activate.click();
  const confirmation = panel.getByRole("group", { name: "确认正式监测操作" });
  await expect(confirmation).toContainText("盘中触发可能在收盘前回落");
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(panel).toContainText("尚无正式监测尝试");
  await activate.click();
  await confirmation
    .getByRole("button", { name: "确认并提交", exact: true })
    .click();
  await expect(panel).toContainText("等待回踩");
  await expect(panel).toContainText("盘中穿越");
  await page.reload();
  await page.getByRole("button", { name: "CONTRACT.US", exact: true }).click();
  await expect(panel).toContainText("等待回踩");
  await page.screenshot({
    path: testInfo.outputPath("intrabar-monitor-running.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "BLOCKED.US", exact: true }).click();
  await expect(panel).toContainText("TICK_PROTOCOL_EVIDENCE_UNVERIFIED");
  await expect(
    panel.getByRole("button", { name: "启用正式盘中监测", exact: true }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toContainText("盘中逐笔未开放");
  await page.screenshot({
    path: testInfo.outputPath("intrabar-monitor-blocked-mobile.png"),
    fullPage: true,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".formal-monitor h3",
  });
  const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.fonts.some((font) => font.glyphCount > 0)).toBe(true);
  console.log(
    "INTRABAR_MONITOR_BROWSER",
    browser.version(),
    "RENDERED_FONTS",
    JSON.stringify(fonts.fonts),
  );
  await cdp.detach();
});
