import { defineConfig } from "@playwright/test";

const testPort = process.env.PLAYWRIGHT_PORT ?? "3100";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${testPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: Number(process.env.PLAYWRIGHT_WORKERS ?? (process.env.CI ? 2 : 1)),
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  outputDir: "work/playwright-results",
  use: {
    baseURL,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    locale: "en-GB",
    timezoneId: "Europe/London",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npm run dev -- -p ${testPort}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          ...process.env,
          APP_URL: baseURL,
          DEMO_MODE: "false",
          META_ADS_ENABLED: "false",
          META_DAILY_BUDGET_CAP: "0",
          GLOBAL_EXTERNAL_WORK_ENABLED: "false"
        }
      },
  projects: [
    { name: "mobile-375", use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
    { name: "tablet-768", use: { viewport: { width: 768, height: 1024 }, hasTouch: true } },
    { name: "desktop-1024", use: { viewport: { width: 1024, height: 768 } } },
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 1000 } } }
  ]
});
