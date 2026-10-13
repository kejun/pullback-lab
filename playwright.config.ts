import { defineConfig } from "@playwright/test";

// Each scenario has its own service and temporary SQLite database. A chart-only
// test must not pre-confirm settings or seed plans for the research acceptance flow.
// Port 4190 is blocked by browsers (Sieve); keep the provider fixture on 4191.
const scenarios = [
  "research",
  "chart",
  "runtime-feed",
  "candidates",
  "operations",
  "recovery",
  "action-evidence",
  "market-sampling",
  "research-history",
  "formal-monitor",
  "provider-research",
  "intrabar-monitor",
  "eod-research",
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
    use: {
      baseURL: `http://127.0.0.1:${name === "eod-research" ? 4193 : name === "intrabar-monitor" ? 4192 : name === "provider-research" ? 4191 : 4180 + index}`,
    },
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
  webServer: scenarios.map((name, index) => ({
    command:
      name === "eod-research"
        ? "node --import tsx scripts/e2e-eod-research.ts"
        : name === "intrabar-monitor"
          ? "node --import tsx scripts/e2e-intrabar-monitor.ts"
          : name === "provider-research"
            ? "node --import tsx scripts/e2e-provider-research.ts"
            : name === "formal-monitor"
              ? "node --import tsx scripts/e2e-formal-monitor.ts"
              : "node --import tsx scripts/e2e-server.ts",
    url: `http://127.0.0.1:${name === "eod-research" ? 4193 : name === "intrabar-monitor" ? 4192 : name === "provider-research" ? 4191 : 4180 + index}/api/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(
        name === "eod-research"
          ? 4193
          : name === "intrabar-monitor"
            ? 4192
            : name === "provider-research"
              ? 4191
              : 4180 + index,
      ),
      HOST: "127.0.0.1",
      PULLBACK_PASSWORD: "e2e-only-password",
      PULLBACK_DEMO: "1",
      NODE_ENV: "test",
      PULLBACK_MARKET_WORKER: "0",
      PULLBACK_MINUTE_SYMBOLS: name === "market-sampling" ? "SAMPLE.US" : "",
      MARKET_SAMPLING_E2E: name === "market-sampling" ? "1" : "0",
      RESEARCH_HISTORY_E2E: name === "research-history" ? "1" : "0",
      ACTION_EVIDENCE_E2E: name === "action-evidence" ? "1" : "0",
    },
  })),
});
