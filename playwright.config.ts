import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  use: { baseURL: "http://127.0.0.1:5174" },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 5174",
    url: "http://127.0.0.1:5174",
  },
});
