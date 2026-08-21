import { describe, expect, it } from "vitest";
import { validateScoba, validateTeam, reachableGenes } from "../src/sim/legality";
import { breed } from "../src/sim/breeding";
import { makeWild } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { SPECIES } from "../src/sim/species";

describe("validateScoba", () => {
  it("accepts a wild catch", () => {
    expect(validateScoba(makeWild("plib", 12, rngFrom("a")))).toEqual([]);
  });

  it("accepts bred children, including two generations", () => {
    const mom = makeWild("obera", 20, rngFrom("m"));
    const dad = makeWild("plib", 20, rngFrom("d"));
    const child = breed(mom, dad, rngFrom("c1")).child;
    expect(validateScoba(child)).toEqual([]);
    child.level = 15;
    const grandDad = makeWild("grima", 18, rngFrom("g"));
    const child2 = breed(child, grandDad, rngFrom("c2")).child;
    expect(validateScoba(child2)).toEqual([]);
  });

  it("rejects impossible levels and unknown species", () => {
    const s = makeWild("plib", 10, rngFrom("b"));
    s.level = 200;
    expect(validateScoba(s).join()).toMatch(/level/);
    const fake = { ...makeWild("plib", 10, rngFrom("c")), speciesId: "hackmon" };
    expect(validateScoba(fake).join()).toMatch(/unknown species/);
  });

  it("rejects inherited moves the Scoba has no breeding generations to justify", () => {
    const s = makeWild("plib", 10, rngFrom("d"));
    s.moves = ["crush", "tide-whip"]; // grima's spell, but breedCount 0
    expect(validateScoba(s).join()).toMatch(/inherited move/);
  });

  it("takes a move off any other line, since any two Scobas breed", () => {
    const s = makeWild("obera", 20, rngFrom("e"));
    s.breedCount = 1;
    s.moves = ["leaf-flick", "flame-burst"]; // a Sun spell on a Moss line
    expect(validateScoba(s)).toEqual([]);
    // Nothing anybody can learn is still nothing.
    s.moves = ["leaf-flick", "hackmove"];
    expect(validateScoba(s).join()).toMatch(/unknown move/);
  });

  it("rejects more inherited moves than breeding generations allow", () => {
    const s = makeWild("obera", 30, rngFrom("f"));
    s.breedCount = 1;
    s.moves = ["leaf-flick", "tide-whip", "riptide"]; // two inherited spells, one generation
    expect(validateScoba(s).join()).toMatch(/inherited move/);
  });

  it("rejects doctored genes", () => {
    const s = makeWild("plib", 10, rngFrom("g"));
    s.genes = { ...s.genes, spd: 50 };
    expect(validateScoba(s).join()).toMatch(/spd gene/);
    const t = makeWild("obera", 10, rngFrom("h"));
    t.breedCount = 1;
    // Obera's HP gene is 7 and the fattest line is 8, so one 80/20 mix lands
    // on 6 or 7 and nothing reaches 12.
    t.genes = { ...t.genes, hp: 12 };
    expect(validateScoba(t).join()).toMatch(/hp gene/);
  });

  it("rejects abilities on nobody's pool, even with breeding", () => {
    const s = makeWild("plib", 10, rngFrom("i"));
    s.secondaryAbility = "sun-heart"; // a primary, on no secondary pool at all
    expect(validateScoba(s).join()).toMatch(/ability/);
    s.breedCount = 1;
    expect(validateScoba(s).join()).toMatch(/ability/);
    const t = makeWild("plib", 10, rngFrom("j"));
    t.secondaryAbility = "moss-heart"; // Obera's pool, so one breeding step reaches it
    expect(validateScoba(t).join()).toMatch(/ability/);
    t.breedCount = 1;
    expect(validateScoba(t)).toEqual([]);
  });

  it("keeps special Scobas out of online teams", () => {
    const s = makeWild("relica", 20, rngFrom("k"));
    expect(validateScoba(s).join()).toMatch(/special/);
  });
});

describe("validateTeam", () => {
  it("checks size and duplicates", () => {
    const a = makeWild("plib", 10, rngFrom("l"));
    expect(validateTeam([]).join()).toMatch(/team/);
    expect(validateTeam([a, a]).join()).toMatch(/duplicate/);
    expect(validateTeam([a, makeWild("flarea", 10, rngFrom("m"))])).toEqual([]);
  });
});

describe("reachableGenes", () => {
  it("is exact for unbred Scobas", () => {
    const set = reachableGenes(SPECIES.plib!, 0, "spd");
    expect([...set]).toEqual([SPECIES.plib!.genes.spd]);
  });

  it("opens up by one breeding step, and no further than the mix allows", () => {
    // Obera's HP gene is 7 and every other line sits between 4 and 8, so
    // round(0.8*7 + 0.2*dad) can only land on 6 or 7.
    const g1 = reachableGenes(SPECIES.obera!, 1, "hp");
    expect([...g1].sort()).toEqual([6, 7]);
    const g2 = reachableGenes(SPECIES.obera!, 2, "hp");
    for (const v of g2) expect(v).toBeGreaterThanOrEqual(5);
    for (const v of g2) expect(v).toBeLessThanOrEqual(7);
  });
});
