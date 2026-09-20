import { defineConfig } from "vitest/config";

/**
 * The roster coverage report, kept out of the game's suite: it prints a page
 * of tables rather than checking anything, and `npm test` should stay quiet.
 */
export default defineConfig({
  test: {
    include: ["tools/coverage.report.ts"],
    // Printed as it is written rather than gathered up and labelled per test.
    disableConsoleIntercept: true,
    reporters: ["dot"],
  },
});
