import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["typescript/tests/unit/**/*.test.ts"],
    allowOnly: !process.env["CI"],
    passWithNoTests: false,
    retry: 0,
    // One worker per CPU in CI, whose runners run nothing else. Two locally, beside other work.
    maxWorkers: process.env["CI"] ? availableParallelism() : 2,
    // Suspected destination-boundary bugs stop instead of continuing, locally as in CI.
    env: { POMERADO_BOUNDARY_STRICT: "1" },
  },
});
