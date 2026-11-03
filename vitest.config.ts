import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "live",
          include: ["test/live/**/*.test.ts"],
          testTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
