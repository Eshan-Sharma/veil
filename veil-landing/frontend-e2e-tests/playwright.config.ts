import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

// Manually load .env.local so the spec files can read TEST_ADMIN_KEYPAIR /
// TEST_USER_KEYPAIR / TEST_VICTIM_KEYPAIR. Playwright doesn't load Next.js
// env files automatically, and dotenv isn't a project dep.
const envPath = resolve(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k]) continue;
    process.env[k] = raw.replace(/^["']|["']$/g, "");
  }
}

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    cwd: resolve(__dirname, ".."),
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        // Slow each action so the user can watch it happen.
        launchOptions: { slowMo: 350 },
      },
    },
  ],
});
