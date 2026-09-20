// `npm run coverage`. Prints what the roster covers, for designing against.
// It is a vitest file because vitest is the one thing here that runs the
// game's TypeScript outside the browser, and it runs under a config of its own
// so the game's own suite never picks it up.
import { it } from "vitest";
import { buildCoverage, renderCoverage } from "../src/dev/coverage";

it("roster coverage", () => {
  console.log(`\n${renderCoverage(buildCoverage())}\n`);
});
