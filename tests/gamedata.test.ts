import { describe, expect, it } from "vitest";
import { checkAll, checkSpecies } from "../src/sim/content/validate";
import { SPECIES, STARTER_IDS } from "../src/sim/species";

/** A copy of a record to break, so the table it came from is left alone. */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const says = (problems: { at: string; says: string }[]): string =>
  problems.map((p) => `${p.at} ${p.says}`).join(" | ");

describe("the game data files", () => {
  it("hold nothing the game cannot read", () => {
    // Every line, and every id every script names, checked against what exists.
    const found = checkAll();
    expect(found.map((f) => `${f.kind}/${f.id}: ${says(f.problems)}`)).toEqual([]);
  });

  it("still offer the starters in the order they were written", () => {
    expect(STARTER_IDS[0]).toBe("cresce");
    expect(STARTER_IDS).toContain("roulle");
    expect(STARTER_IDS).not.toContain("aulium");
  });
});

describe("catching a broken line", () => {
  it("catches a line that knows a move that does not exist", () => {
    const bad = copy(SPECIES["allin"]!);
    bad.moves = ["fold"];
    expect(says(checkSpecies(bad))).toContain('moves[0] names a move called "fold"');
  });

  it("catches a line missing one of its stats", () => {
    const bad = copy(SPECIES["allin"]!) as unknown as { genes: Record<string, number> };
    delete bad.genes["spd"];
    expect(says(checkSpecies(bad))).toContain("genes.spd is missing");
  });

  it("catches a line growing into one that does not exist", () => {
    expect(says(checkSpecies({ ...copy(SPECIES["roulle"]!), evolvesTo: "allout" })))
      .toContain('names a species called "allout"');
  });

  it("catches a misspelled key, which is the dangerous one", () => {
    const bad = copy(SPECIES["allin"]!) as unknown as Record<string, unknown>;
    bad["primaryability"] = bad["primaryAbility"];
    delete bad["primaryAbility"];
    const found = says(checkSpecies(bad));
    expect(found).toContain("primaryAbility is missing");
    expect(found).toContain('Did you mean "primaryAbility"');
  });

  it("catches a passive that does not exist", () => {
    expect(says(checkSpecies({ ...copy(SPECIES["allin"]!), primaryAbility: "all-in" })))
      .toContain('names a passive called "all-in"');
  });
});
