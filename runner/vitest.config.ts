import { defineConfig } from "vitest/config";

// Unit tests only; the browser E2E runs with `npm run test:e2e` (needs Playwright's Chromium).
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
