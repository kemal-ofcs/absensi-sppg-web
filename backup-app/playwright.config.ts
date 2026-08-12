import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";
const shouldManageWebServer = !process.env.PLAYWRIGHT_BASE_URL;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  timeout: 120_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: shouldManageWebServer
    ? {
        command: "npx next dev --webpack -p 3000",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      }
    : undefined,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
