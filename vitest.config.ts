import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    sequence: {
      concurrent: false
    }
  }
});
