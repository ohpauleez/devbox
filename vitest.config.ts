import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["pasture/**", "dist/**", "node_modules/**"],
  },
});
