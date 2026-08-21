import { describe, expect, it } from "vitest";
import {
  EVOLVE_COST,
  LEVEL_COST,
  evolve,
  evolveError,
  levelUp,
  levelUpError,
} from "../src/sim/growth";
import { MAX_LEVEL, gainXp, makeWild, maxHp, settleCaught, type ScobaInstance } from "../src/sim/scoba";
import { SPECIES, speciesMoves, type Species } from "../src/sim/species";
import { rngFrom } from "../src/sim/rng";
import {
  boxOf,
  partyOf,
  reorderParty,
  sendToBox,
  takeFromBox,
  type SaveData,
} from "../src/save/save";

const wild = (species: string, level: number, seed: string): ScobaInstance =>
  makeWild(species, level, rngFrom(seed));

describe("the level ceiling", () => {
  it("stops xp at the cap and stops banking it there", () => {
    const s = wild("plib", 1, "x1");
    gainXp(s, 100000);
    expect(s.level).toBe(MAX_LEVEL);
    expect(s.xp).toBe(0);
    const again = gainXp(s, 100000);
    expect(again.levelsGained).toBe(0);
    expect(s.level).toBe(MAX_LEVEL);
  });

  it("settles a catch to the cap and then a level or two under it", () => {
    for (let i = 0; i < 40; i++) {
      const caught = wild("cactunny", 9, `c${i}`);
      settleCaught(caught, rngFrom(`r${i}`));
      expect(caught.level).toBeGreaterThanOrEqual(MAX_LEVEL - 2);
      expect(caught.level).toBeLessThanOrEqual(MAX_LEVEL - 1);
      expect(caught.hp).toBe(maxHp(caught));
    }
  });

  it("never drops a low catch below level 1", () => {
    const runt = wild("catsquito", 1, "runt");
    settleCaught(runt, rngFrom("r"));
    expect(runt.level).toBe(1);
  });
});

describe("spending Aetus", () => {
  it("buys a level up to the ceiling, and only with the price in hand", () => {
    const s = wild("meepa", 2, "a1");
    expect(levelUpError(s, LEVEL_COST - 1)).toMatch(/Costs/);
    expect(levelUpError(s, LEVEL_COST)).toBeNull();
    while (s.level < MAX_LEVEL) levelUp(s);
    expect(levelUpError(s, 9999)).toMatch(new RegExp(`level ${MAX_LEVEL}`));
  });

  it("keeps the damage a Scoba was carrying when it grows", () => {
    const s = wild("obera", 2, "a2");
    s.hp = 4;
    const before = maxHp(s);
    levelUp(s);
    expect(s.hp).toBe(4 + (maxHp(s) - before));
  });

  it("refuses to evolve a line that has nothing to evolve into", () => {
    const s = wild("plib", 3, "a3");
    expect(evolveError(s, EVOLVE_COST)).toMatch(/nothing to evolve into/i);
  });

  it("evolves into the next form, keeping the Scoba and refitting the shape", () => {
    // No line has a second form drawn yet, so the plumbing is checked against
    // a stand-in pair rather than shipped content.
    const base = SPECIES["catsquito"]!;
    const next: Species = { ...SPECIES["cactunny"]!, id: "test-bloom", name: "Test Bloom", stage: 2 };
    SPECIES[next.id] = next;
    SPECIES[base.id] = { ...base, evolvesTo: next.id };
    try {
      const s = wild("catsquito", 4, "a4");
      s.nickname = "Bitey";
      const genes = { ...s.genes };
      expect(evolveError(s, EVOLVE_COST - 1)).toMatch(/Costs/);
      expect(evolveError(s, EVOLVE_COST)).toBeNull();
      evolve(s);
      expect(s.speciesId).toBe(next.id);
      expect(s.nickname).toBe("Bitey");
      expect(s.level).toBe(4);
      expect(s.genes).toEqual(genes);
      expect(s.moves).toEqual(speciesMoves(next));
      expect(next.secondaryPool).toContain(s.secondaryAbility);
      // A second form is raised by evolving into it, not by buying levels.
      expect(levelUpError(s, 9999)).toMatch(/first form/i);
    } finally {
      SPECIES[base.id] = base;
      delete SPECIES[next.id];
    }
  });
});

describe("the roster", () => {
  const saveWith = (party: ScobaInstance[], box: ScobaInstance[] = []): SaveData => ({
    version: 12, createdAt: 0, updatedAt: 0, worldSeed: "w", localSlot: "A",
    partnerJoined: false,
    characters: {} as SaveData["characters"],
    party, box, bag: {}, money: 0, aetus: 0,
    story: { chapter: 0, flags: {} }, quests: {}, sentinels: {},
    pos: { map: "demo", x: 0, y: 0 },
    special: {} as SaveData["special"],
  });
  const owned = (species: string, seed: string, owner: "A" | "B" = "A"): ScobaInstance =>
    ({ ...wild(species, 3, seed), owner });

  it("moves one of a character's own party members without disturbing the other's", () => {
    const save = saveWith([
      owned("plib", "p1"), owned("cresce", "b1", "B"), owned("obera", "p2"), owned("grima", "p3"),
    ]);
    const second = save.party[2]!;
    expect(reorderParty(save, "A", second.uid, -1)).toBe(true);
    expect(partyOf(save, "A").map((s) => s.speciesId)).toEqual(["obera", "plib", "grima"]);
    expect(partyOf(save, "B").map((s) => s.speciesId)).toEqual(["cresce"]);
    // Nothing moves off the ends.
    expect(reorderParty(save, "A", partyOf(save, "A")[0]!.uid, -1)).toBe(false);
  });

  it("swaps between party and box, and never empties a party", () => {
    const save = saveWith([owned("plib", "p1"), owned("obera", "p2")], [owned("meepa", "x1")]);
    const boxed = save.box[0]!;
    expect(takeFromBox(save, boxed.uid)).toBe(true);
    expect(partyOf(save, "A")).toHaveLength(3);
    expect(boxOf(save, "A")).toHaveLength(0);
    // Full party: the next one has nowhere to go.
    save.box.push(owned("cactunny", "x2"));
    expect(takeFromBox(save, save.box[0]!.uid)).toBe(false);

    for (const s of [...partyOf(save, "A")].slice(0, 2)) expect(sendToBox(save, s.uid)).toBe(true);
    const last = partyOf(save, "A")[0]!;
    expect(sendToBox(save, last.uid)).toBe(false);
    expect(partyOf(save, "A")).toHaveLength(1);
  });
});
