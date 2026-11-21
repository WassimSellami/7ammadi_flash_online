import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
    ],
    environment: "node",
    reporters: ["default"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
