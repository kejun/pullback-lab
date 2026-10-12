import { expect, test } from "@playwright/test";
import type { Bootstrap, Plan } from "../../packages/contracts/index";
import type { RuntimeProgress } from "../../apps/server/attempt-runtime";

test("recovery creates a new attempt and stale tabs retain their draft and attempt baseline", async ({
  page,
  context,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const post = (path: string, data?: unknown) =>
    page.request.post(`/api${path}`, {
      headers: { "X-Requested-With": "PullbackLab" },
      ...(data === undefined ? {} : { data }),
    });
  expect(
    (await post("/login", { password: "e2e-only-password" })).status(),
  ).toBe(200);
  expect((await post("/demo/seed")).status()).toBe(200);
  expect(
    (await post("/settings/screening", { confirmed: true })).status(),
  ).toBe(200);
  const bootstrap = (await (
    await page.request.get("/api/bootstrap")
  ).json()) as Bootstrap;
  const now = Date.now();
  expect(
    (
      await post("/funds", {
        nav: "10000",
        baseCurrency: "USD",
        cash: { USD: "10000", CNY: "0" },
        existing: {},
        riskBudget: "50",
        riskPool: "100",
        maxWeight: "0.2",
        fx: { USD: "1", CNY: "0.14" },
        fxAsOf: now,
        confirmedAt: now,
        stale: false,
        buyFee: "0",
        sellFee: "0",
        slippageIn: "0",
        slippageOut: "0",
        feesConfirmed: true,
        expectedGeneration: bootstrap.funds?.generation ?? 0,
      })
    ).status(),
  ).toBe(200);
  const created = await post("/plans", {
    instrumentId: "DEMO-US-A",
    anchorTime: null,
    primarySupport: "100",
    lower: "99.75",
    upper: "100.25",
    stop: "99.4",
    entryMin: "100.61",
    entryMax: "101.5",
    mode: "CLOSE_CONFIRM",
    sessionDate: "2026-10-09",
    reason: "恢复尝试双标签验收",
    backgroundConfirmed: true,
    supportSelections: [
      { source: "EMA9" },
      {
        source: "HORIZONTAL",
        id: "recovery-e2e",
        label: "合成水平线",
        price: "100",
      },
    ],
  });
  expect(created.status()).toBe(200);
  const plan = (await created.json()) as Plan;
  const activated = await post(`/plans/${plan.id}/activate`, {
    expectedVersion: plan.version,
    expectedAttemptId: plan.attemptId ?? null,
  });
  expect(activated.status()).toBe(200);
  const first = (await activated.json()).plan as Plan;
  expect(
    (
      await post(`/demo/plans/${plan.id}/runtime/start`, {
        expectedVersion: first.version,
        expectedAttemptId: first.attemptId,
      })
    ).status(),
  ).toBe(200);
  const stepped = await post(`/demo/plans/${plan.id}/runtime/step`, {
    expectedVersion: first.version,
    expectedAttemptId: first.attemptId,
    expectedStep: 0,
    count: 1,
  });
  expect(stepped.status()).toBe(200);
  const oldRuntime = (await stepped.json()).runtime as RuntimeProgress;

  await page.goto("/");
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  const reason = page.getByLabel(/计划依据/);
  const draft = "这个标签页的输入必须保留，不能静默替换尝试基线";
  await reason.fill(draft);
  const other = await context.newPage();
  other.on("pageerror", (error) => failures.push(error.message));
  await other.goto("/");
  await other.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  await other.getByRole("button", { name: "暂停观察", exact: true }).click();
  await expect(
    other.getByRole("button", { name: "启用合成计划观察", exact: true }),
  ).toHaveCount(0);
  const runtime = other.getByRole("region", {
    name: "分步合成演练",
    exact: true,
  });
  await expect(
    runtime.getByRole("button", { name: "新建恢复尝试", exact: true }),
  ).toBeEnabled();
  const recovering = other.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/demo/plans/${plan.id}/runtime/recover`) &&
      response.request().method() === "POST",
  );
  await runtime
    .getByRole("button", { name: "新建恢复尝试", exact: true })
    .click();
  const recoveredResponse = await recovering;
  expect(recoveredResponse.status()).toBe(200);
  expect(recoveredResponse.request().postDataJSON()).toMatchObject({
    expectedVersion: first.version,
    expectedAttemptId: first.attemptId,
    sourceAttemptId: first.attemptId,
    expectedStep: oldRuntime.step,
  });
  const recovered = (await recoveredResponse.json()).runtime as RuntimeProgress;
  expect(recovered.attemptId).not.toBe(first.attemptId);
  expect(recovered.template).toBe("RECOVERY");
  expect(recovered.recoveredFromAttemptId).toBe(first.attemptId);
  expect(recovered.activatedAt).toBe(oldRuntime.simulationTime);
  expect(recovered.eventTypes).toEqual([]);
  expect(recovered.nextInput!.receivedAt).toBeGreaterThan(
    oldRuntime.simulationTime,
  );
  await expect(runtime).toContainText(
    "这是从已保存水位之后开始的恢复尝试，不代表会话首次回踩",
  );
  await expect(runtime).toContainText(recovered.attemptId);

  // An explicit progress read must preserve an editing tab's original CAS baseline.
  await page
    .getByRole("region", { name: "分步合成演练", exact: true })
    .getByRole("button", { name: "读取最新演练进度", exact: true })
    .click();
  await expect(reason).toHaveValue(draft);
  const saving = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/plans/${plan.id}/versions`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  const staleSave = await saving;
  expect(staleSave.status()).toBe(409);
  expect(staleSave.request().postDataJSON()).toMatchObject({
    expectedVersion: first.version,
    expectedAttemptId: first.attemptId,
    reason: draft,
  });
  const conflict = page.getByRole("region", {
    name: "计划版本冲突复核",
    exact: true,
  });
  await expect(conflict).toBeVisible();
  await expect(reason).toHaveValue(draft);
  expect(
    (
      await post(`/plans/${plan.id}/pause`, {
        expectedVersion: first.version,
        expectedAttemptId: first.attemptId,
      })
    ).status(),
  ).toBe(409);
  const unchanged = (await (
    await page.request.get("/api/bootstrap")
  ).json()) as Bootstrap;
  expect(unchanged.plans.find((item) => item.id === plan.id)).toMatchObject({
    version: first.version,
    attemptId: recovered.attemptId,
    reason: plan.reason,
  });
  await conflict
    .getByRole("button", { name: "读取最新数据", exact: true })
    .click();
  await expect(conflict).toContainText(first.attemptId!);
  await expect(conflict).toContainText(recovered.attemptId);
  await expect(reason).toHaveValue(draft);
  await conflict
    .getByRole("button", {
      name: "保留输入并基于最新版本继续编辑",
      exact: true,
    })
    .click();
  const newVersionResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/plans/${plan.id}/versions`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  const newVersionResult = await newVersionResponse;
  expect(newVersionResult.status()).toBe(200);
  expect(newVersionResult.request().postDataJSON()).toMatchObject({
    expectedVersion: first.version,
    expectedAttemptId: recovered.attemptId,
  });
  const edited = (await newVersionResult.json()) as Plan;
  expect(edited.attemptId).toBeNull();
  await expect(reason).toHaveValue(draft);
  const editedRuntime = page.getByRole("region", {
    name: "分步合成演练",
    exact: true,
  });
  await expect(
    editedRuntime.getByRole("button", { name: "新建恢复尝试", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "启用合成计划观察", exact: true }),
  ).toHaveCount(0);
  const editedRecovering = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/demo/plans/${plan.id}/runtime/recover`) &&
      response.request().method() === "POST",
  );
  await editedRuntime
    .getByRole("button", { name: "新建恢复尝试", exact: true })
    .click();
  const editedRecoveryResponse = await editedRecovering;
  expect(editedRecoveryResponse.status()).toBe(200);
  expect(editedRecoveryResponse.request().postDataJSON()).toMatchObject({
    expectedVersion: edited.version,
    expectedAttemptId: null,
    sourceAttemptId: recovered.attemptId,
    expectedStep: 0,
  });
  const editedRecovery = (await editedRecoveryResponse.json())
    .runtime as RuntimeProgress;
  expect(editedRecovery).toMatchObject({
    planVersion: edited.version,
    template: "RECOVERY",
    recoveredFromAttemptId: recovered.attemptId,
  });
  expect(editedRecovery.attemptId).not.toBe(recovered.attemptId);
  await expect(editedRuntime).toContainText(editedRecovery.attemptId);
  await page.screenshot({
    path: test.info().outputPath("recovery-attempt.png"),
    fullPage: true,
  });
  await other.close();
  expect(failures).toEqual([]);
});

test("clean progress refresh adopts visible plan fields and CAS baseline together", async ({
  page,
  context,
}) => {
  const post = (path: string, data?: unknown) =>
    page.request.post(`/api${path}`, {
      headers: { "X-Requested-With": "PullbackLab" },
      ...(data === undefined ? {} : { data }),
    });
  expect(
    (await post("/login", { password: "e2e-only-password" })).status(),
  ).toBe(200);
  expect((await post("/demo/seed")).status()).toBe(200);
  const created = await post("/plans", {
    instrumentId: "DEMO-US-A",
    anchorTime: null,
    primarySupport: "100",
    lower: "99.75",
    upper: "100.25",
    stop: "99.4",
    entryMin: "100.61",
    entryMax: "101.5",
    mode: "CLOSE_CONFIRM",
    sessionDate: "2026-10-09",
    reason: "读取前的计划依据",
    backgroundConfirmed: true,
    supportSelections: [
      { source: "EMA9" },
      {
        source: "HORIZONTAL",
        id: "clean-refresh-e2e",
        label: "合成水平线",
        price: "100",
      },
    ],
  });
  expect(created.status()).toBe(200);
  const initial = (await created.json()) as Plan;
  await page.goto("/");
  await page.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  const localStop = page.getByLabel("失效 / 止损参考", { exact: true });
  const localReason = page.getByLabel("计划依据", { exact: true });
  await expect(localStop).toHaveValue("99.4");
  await expect(localReason).toHaveValue(initial.reason);

  const other = await context.newPage();
  await other.goto("/");
  await other.getByRole("button", { name: "DEMO-A.US", exact: true }).click();
  await other.getByLabel("失效 / 止损参考", { exact: true }).fill("99.30");
  await other
    .getByLabel("计划依据", { exact: true })
    .fill("另一标签保存的新版依据");
  const otherSaving = other.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/plans/${initial.id}/versions`) &&
      response.request().method() === "POST",
  );
  await other.getByRole("button", { name: "保存新版本", exact: true }).click();
  const otherSavedResponse = await otherSaving;
  expect(otherSavedResponse.status()).toBe(200);
  const updated = (await otherSavedResponse.json()) as Plan;
  expect(updated.version).toBe(initial.version + 1);
  await page
    .getByRole("region", { name: "分步合成演练", exact: true })
    .getByRole("button", { name: "读取最新演练进度", exact: true })
    .click();
  await expect(localStop).toHaveValue(updated.stop);
  await expect(localReason).toHaveValue(updated.reason);

  await localReason.fill("基于已显示的新版止损，仅补充依据");
  const saving = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/plans/${initial.id}/versions`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  const savedResponse = await saving;
  expect(savedResponse.status()).toBe(200);
  expect(savedResponse.request().postDataJSON()).toMatchObject({
    expectedVersion: updated.version,
    expectedAttemptId: updated.attemptId ?? null,
    stop: updated.stop,
    reason: "基于已显示的新版止损，仅补充依据",
  });
  const saved = (await savedResponse.json()) as Plan;
  expect(saved.stop).toBe(updated.stop);
  expect(saved.version).toBe(updated.version + 1);
  await other.close();
});
