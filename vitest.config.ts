import { defineConfig } from "vitest/config";

const traceCoverageEnabled = process.env.DEVBOX_TRACE_COVERAGE === "1"
  || process.env.DEVBOX_TRACE_COVERAGE === "true";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["pasture/**", "dist/**", "node_modules/**"],
    setupFiles: ["./test/support/spec-trace.setup.ts"],
    fileParallelism: traceCoverageEnabled ? false : undefined,
    reporters: ["default", "./test/support/spec-trace.reporter.ts"],
  },
});
