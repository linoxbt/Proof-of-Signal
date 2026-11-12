import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// Uses a preinstalled Chromium when present (CI image / dev container), else
// Playwright's own download. Override with PW_CHROMIUM_PATH.
const preinstalled = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const executablePath = existsSync(preinstalled) ? preinstalled : undefined;
const PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL ?? `http://localhost:${PORT}`,
    trace: "off",
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
        launchOptions: {
          executablePath,
          args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
        },
      },
    },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        // Demo mode: no NEXT_PUBLIC_API_BASE, development server.
        command: "npm run dev",
        url: `http://localhost:${PORT}`,
        reuseExistingServer: true,
        timeout: 120_000,
        env: { NEXT_PUBLIC_API_BASE: "", NEXT_TELEMETRY_DISABLED: "1" },
      },
});
