import { defineConfig } from "@playwright/test";

// Each scenario has its own service and temporary SQLite database. A chart-only
// test must not pre-confirm settings or seed plans for the research acceptance flow.
const scenarios = [
  "research",
  "chart",
  "runtime-feed",
  "candidates",
  "operations",
  "recovery",
] as const;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  projects: scenarios.map((name, index) => ({
    name,
    testMatch: `**/${name}.spec.ts`,
    use: { baseURL: `http://127.0.0.1:${4180 + index}` },
  })),
  use: {
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
  webServer: scenarios.map((_name, index) => ({
    command: "node --import tsx scripts/e2e-server.ts",
    url: `http://127.0.0.1:${4180 + index}/api/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(4180 + index),
      HOST: "127.0.0.1",
      PULLBACK_PASSWORD: "e2e-only-password",
      PULLBACK_DEMO: "1",
      NODE_ENV: "test",
    },
  })),
});
