import { describe, expect, it } from "vitest";
import { validateScoba, validateTeam, budgetFor, geneErrors, BUDGET_SLACK } from "../src/sim/legality";
import { breed } from "../src/sim/breeding";
import { evolve, makeWild } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { SPECIES } from "../src/sim/species";

describe("validateScoba", () => {
  it("accepts a wild catch", () => {
    expect(validateScoba(makeWild("plib", 12, rngFrom("a")))).toEqual([]);
  });

  it("accepts a hybrid and a same-line baby", () => {
    const mom = makeWild("obera", 20, rngFrom("m"));
    const dad = makeWild("plib", 20, rngFrom("d"));
    const hybrid = breed(mom, dad, rngFrom("c1"));
    expect(hybrid.hybrid).toBe(true);
    expect(validateScoba(hybrid)).toEqual([]);
    const baby = breed(mom, makeWild("obera", 18, rngFrom("g")), rngFrom("c2"));
    expect(validateScoba(baby)).toEqual([]);
  });

  it("rejects a hybrid mark that is not simply true", () => {
    const s = { ...makeWild("plib", 10, rngFrom("hm")), hybrid: 2 } as unknown as ReturnType<typeof makeWild>;
    expect(validateScoba(s).join()).toMatch(/hybrid mark/);
  });

  it("rejects impossible levels and unknown species", () => {
    const s = makeWild("plib", 10, rngFrom("b"));
    s.level = 200;
    expect(validateScoba(s).join()).toMatch(/level/);
    const fake = { ...makeWild("plib", 10, rngFrom("c")), speciesId: "hackmon" };
    expect(validateScoba(fake).join()).toMatch(/unknown species/);
  });

  it("rejects inherited moves on a Scoba that is not a hybrid", () => {
    const s = makeWild("plib", 10, rngFrom("d"));
    s.moves = ["crush", "tide-whip"]; // grima's spell, on a Scoba that is not a hybrid
    expect(validateScoba(s).join()).toMatch(/inherited move/);
  });

  it("takes a move off any other line on a hybrid, since any two lines make one", () => {
    const s = makeWild("obera", 20, rngFrom("e"));
    s.hybrid = true;
    s.moves = ["leaf-flick", "flame-burst"]; // a Sun spell on a Moss line
    expect(validateScoba(s)).toEqual([]);
    // Nothing anybody can learn is still nothing.
    s.moves = ["leaf-flick", "hackmove"];
    expect(validateScoba(s).join()).toMatch(/unknown move/);
  });

  it("rejects more inherited moves than a hybrid may hold", () => {
    const s = makeWild("obera", 30, rngFrom("f"));
    s.hybrid = true;
    s.moves = ["leaf-flick", "tide-whip", "riptide"]; // two inherited spells, one allowed
    expect(validateScoba(s).join()).toMatch(/inherited move/);
  });

  it("rejects doctored genes", () => {
    // Over the cap on one stat, whatever the rest of the line does.
    const s = makeWild("plib", 10, rngFrom("g"));
    s.genes = { ...s.genes, spd: 260 };
    expect(validateScoba(s).join()).toMatch(/spd gene 260 is over the cap/);
    // Inside every cap, but spending more than the line is built on.
    const t = makeWild("obera", 10, rngFrom("h"));
    t.hybrid = true;
    t.genes = { ...t.genes, hp: 300, mag: 250 };
    expect(validateScoba(t).join()).toMatch(/base stats total/);
  });

  it("rejects abilities on nobody's pool, even with breeding", () => {
    const s = makeWild("plib", 10, rngFrom("i"));
    s.secondaryAbility = "sun-heart"; // a primary, on no secondary pool at all
    expect(validateScoba(s).join()).toMatch(/ability/);
    s.hybrid = true;
    expect(validateScoba(s).join()).toMatch(/ability/);
    const t = makeWild("plib", 10, rngFrom("j"));
    t.secondaryAbility = "moss-heart"; // Obera's pool, so a hybrid can have it
    expect(validateScoba(t).join()).toMatch(/ability/);
    t.hybrid = true;
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

describe("gene budgets", () => {
  it("accepts every shipped line against its own budget", () => {
    for (const sp of Object.values(SPECIES)) {
      expect([sp.id, geneErrors(sp, sp.genes, sp.name)]).toEqual([sp.id, []]);
    }
  });

  it("puts a baby on the smaller budget", () => {
    expect(budgetFor(SPECIES.sqwoop!)).toBe(300);
    expect(budgetFor(SPECIES.octoshake!)).toBe(500);
  });

  it("allows the rounding a breed and an evolution leave behind", () => {
    const sp = SPECIES.plib!;
    const drifted = { ...sp.genes, hp: sp.genes.hp + BUDGET_SLACK };
    expect(geneErrors(sp, drifted, "Plib")).toEqual([]);
    const cheat = { ...sp.genes, hp: sp.genes.hp + BUDGET_SLACK + 1 };
    expect(geneErrors(sp, cheat, "Plib").join()).toMatch(/base stats total/);
  });

  it("keeps every line a real pairing can produce inside its budget", () => {
    // Every pairing on the roster, grown up where the child has a form to grow
    // into. Each child hatches as its mother's first form, so the budget it is
    // checked against is that form's and not the mother's.
    const roster = Object.values(SPECIES).filter((sp) => !sp.special && !sp.pawn && !sp.fusion);
    const parents = roster.map((sp) => makeWild(sp.id, 1, rngFrom(`g:${sp.id}`)));
    for (const m of parents) {
      for (const d of parents) {
        if (m.speciesId === d.speciesId) continue;
        const child = breed(m, d, rngFrom("b"));
        for (let grown = 0; grown < 2; grown++) {
          const sp = SPECIES[child.speciesId]!;
          expect([sp.id, geneErrors(sp, child.genes, sp.name)]).toEqual([sp.id, []]);
          evolve(child);
        }
      }
    }
  });
});
