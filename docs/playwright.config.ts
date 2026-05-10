import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],

  // Tests run against the docs server already started via the Claude
  // Code preview tool (port 6543). If you want the test runner to spawn
  // its own server, swap this for a `webServer` config — historically
  // bun + Vite inside Playwright's webServer hits an esbuild crash so
  // the locally-running server path is the reliable one.

  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    actionTimeout: 5_000,
  },

  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
