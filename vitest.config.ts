import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    passWithNoTests: false,
    workspace: "./vitest.workspace.ts"
  }
});
