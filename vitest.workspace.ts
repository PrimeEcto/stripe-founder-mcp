import { defineProject, defineWorkspace } from "vitest/config";

const sharedProjectConfig = {
  environment: "node" as const,
  globals: true,
  passWithNoTests: false
};

export default defineWorkspace([
  defineProject({
    test: {
      ...sharedProjectConfig,
      include: ["tests/unit/**/*.test.ts"],
      name: "unit",
      testTimeout: 30_000
    }
  }),
  defineProject({
    test: {
      ...sharedProjectConfig,
      fileParallelism: false,
      globalSetup: ["./tests/integration/globalSetup.ts"],
      include: ["tests/integration/**/*.test.ts"],
      maxWorkers: 1,
      minWorkers: 1,
      name: "integration",
      setupFiles: ["./tests/integration/setupFile.ts"],
      testTimeout: 180_000
    }
  })
]);
