import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    globals: true,
    globalSetup: ["./tests/integration/globalSetup.ts"],
    include: ["tests/integration/**/*.test.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    name: "integration",
    passWithNoTests: false,
    setupFiles: ["./tests/integration/setupFile.ts"],
    testTimeout: 180_000
  }
});
