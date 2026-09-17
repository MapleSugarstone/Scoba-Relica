import { describe, expect, it } from "vitest";
import { babyLineOf, childGenes, hatchesAs } from "../src/sim/breeding";
import { commonStat, evolve, makeWild, rescaleLine, scaleToLevel, statsAt, MAX_LEVEL, BABY_EVOLVE_LEVEL, raiseLevel } from "../src/sim/scoba";
import { SPECIES, babyOf, type Species } from "../src/sim/species";
import { STAT_BUDGET, BABY_BUDGET, STAT_CAPS, statTotal, STAT_NAMES, stats } from "../src/sim/types";
import { rngFrom } from "../src/sim/rng";

const rng = () => 0.5;

/** The shipped roster, taken before the fixtures below register themselves. */
const REAL = Object.values(SPECIES).map((sp) => sp.id);

describe("stat budgets", () => {
  it("gives every standard line the full budget and the baby the small one", () => {
    for (const sp of REAL.map((id) => SPECIES[id]!)) {
      if (sp.pawn) continue;
      const want = sp.baby ? BABY_BUDGET : STAT_BUDGET;
      expect([sp.id, statTotal(sp.genes)]).toEqual([sp.id, want]);
    }
  });

  it("keeps every stat inside its cap", () => {
    for (const sp of REAL.map((id) => SPECIES[id]!)) {
      for (const name of STAT_NAMES) {
        expect([sp.id, name, sp.genes[name] <= STAT_CAPS[name]]).toEqual([sp.id, name, true]);
      }
    }
  });
});

describe("level scaling", () => {
  it("is the base line at the ceiling and half of it at half the levels", () => {
    const line = stats(100, 100, 100, 100, 100, 100);
    expect(scaleToLevel(line, MAX_LEVEL).str).toBe(100);
    expect(scaleToLevel(line, 15).str).toBe(50);
    expect(scaleToLevel(line, 3).str).toBe(10);
  });
});

describe("the common stat", () => {
  it("is five, and twenty more at the ceiling", () => {
    expect(commonStat(1)).toBe(6);
    expect(commonStat(MAX_LEVEL)).toBe(25);
  });

  it("rounds up, so no level is worth nothing", () => {
    for (let lv = 1; lv < MAX_LEVEL; lv++) {
      expect(commonStat(lv + 1)).toBeGreaterThanOrEqual(commonStat(lv));
    }
    expect(commonStat(15)).toBe(15);
  });

  it("sits on top of the line rather than inside its budget", () => {
    // Unmotivated changes no stat, so this reads the line itself rather than
    // whichever hobby the seed happened to roll.
    const s = { ...makeWild("octoshake", MAX_LEVEL, rngFrom("c")), hobby: "unmotivated" };
    const line = SPECIES.octoshake!.genes;
    // Octoshake spends nothing on Strength and still has some.
    expect(line.str).toBe(0);
    expect(statsAt(s, false).str).toBe(commonStat(MAX_LEVEL));
    for (const name of STAT_NAMES) {
      expect([name, statsAt(s, false)[name]]).toEqual([name, line[name] + commonStat(MAX_LEVEL)]);
    }
    // The line itself is untouched, so the budget still reads the same.
    expect(statTotal(s.genes)).toBe(STAT_BUDGET);
  });

  it("is not inherited: breeding mixes the lines and nothing else", () => {
    const mom = makeWild("octoshake", MAX_LEVEL, rngFrom("m"));
    const dad = makeWild("plib", MAX_LEVEL, rngFrom("d"));
    expect(childGenes(mom, dad)).toEqual(childGenes(
      { ...mom, level: 1 }, { ...dad, level: 1 },
    ));
  });
});

describe("baby lines", () => {
  /** The worked example from the design document, built as three species. */
  const A: Species = { ...SPECIES.plib!, id: "tA", genes: stats(100, 100, 100, 100, 100, 0), evolvesTo: undefined };
  const babyA: Species = { ...SPECIES.plib!, id: "tBabyA", genes: stats(10, 10, 10, 10, 10, 0), baby: true, evolvesTo: "tA" };
  const B: Species = { ...SPECIES.plib!, id: "tB", genes: stats(100, 100, 100, 100, 100, 0), evolvesTo: undefined };
  const babyB: Species = { ...SPECIES.plib!, id: "tBabyB", genes: stats(30, 30, 30, 30, 30, 0), baby: true, evolvesTo: "tB" };
  const C: Species = { ...SPECIES.plib!, id: "tC", genes: stats(100, 100, 100, 100, 100, 0) };

  for (const sp of [A, babyA, B, babyB, C]) SPECIES[sp.id] = sp;

  it("reads a parent with a baby form at that form's scale", () => {
    expect(babyLineOf(makeWild("tA", 1, rng)).str).toBe(10);
    expect(babyLineOf(makeWild("tB", 1, rng)).str).toBe(30);
  });

  it("scales a parent with no baby form down by three fifths", () => {
    expect(babyLineOf(makeWild("tC", 1, rng)).str).toBe(60);
  });

  it("mixes the two baby lines 65/35", () => {
    expect(childGenes(makeWild("tA", 1, rng), makeWild("tB", 1, rng)).str).toBe(17);
    expect(childGenes(makeWild("tA", 1, rng), makeWild("tC", 1, rng)).str).toBe(28);
  });

  it("hatches the mother's line as its first form", () => {
    expect(hatchesAs(A).id).toBe("tBabyA");
    expect(hatchesAs(C).id).toBe("tC");
  });

  it("carries a bred line up through evolution", () => {
    const child = makeWild("tBabyA", 1, rng);
    child.genes = childGenes(makeWild("tA", 1, rng), makeWild("tB", 1, rng));
    expect(child.genes.str).toBe(17);
    evolve(child);
    expect(child.speciesId).toBe("tA");
    // 17 is 1.7x what its baby form holds, so it grows into 1.7x the adult.
    expect(child.genes.str).toBe(170);
  });
});

describe("the Octoshake line", () => {
  it("makes Octoshake strictly better than Sqwoop in every stat", () => {
    const sq = SPECIES.sqwoop!.genes;
    const oc = SPECIES.octoshake!.genes;
    for (const name of STAT_NAMES) {
      if (sq[name] === 0) continue;
      expect([name, oc[name] > sq[name]]).toEqual([name, true]);
    }
  });

  it("grows Sqwoop into Octoshake on reaching the level and not before", () => {
    const s = makeWild("sqwoop", 1, rngFrom("t"));
    while (s.level < BABY_EVOLVE_LEVEL - 1) raiseLevel(s);
    expect(s.speciesId).toBe("sqwoop");
    raiseLevel(s);
    expect(s.level).toBe(BABY_EVOLVE_LEVEL);
    expect(s.speciesId).toBe("octoshake");
    expect(s.genes).toEqual(SPECIES.octoshake!.genes);
  });
});
