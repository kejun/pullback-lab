import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4180",
    actionTimeout: 10_000,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
          args: ["--no-sandbox"],
        }
      : undefined,
  },
  webServer: {
    command: "node --import tsx scripts/e2e-server.ts",
    url: "http://127.0.0.1:4180/api/health",
    reuseExistingServer: false,
    env: {
      PORT: "4180",
      HOST: "127.0.0.1",
      PULLBACK_PASSWORD: "e2e-only-password",
      PULLBACK_DEMO: "1",
      NODE_ENV: "test",
    },
  },
});
