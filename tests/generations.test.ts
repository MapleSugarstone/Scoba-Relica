import { describe, expect, it } from "vitest";
import { breed, canBreed } from "../src/sim/breeding";
import { makeWild, scobaTypes, sireOf, speciesName } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { SPECIES } from "../src/sim/species";

const wild = (id: string, seed: string) => makeWild(id, 20, rngFrom(seed));
const cross = (mom: ReturnType<typeof wild>, dad: ReturnType<typeof wild>, seed: string) =>
  breed(mom, dad, rngFrom(seed));

describe("a hybrid is one generation deep", () => {
  it("records its father as a species id and nothing else", () => {
    // Obera x Wispen: the child wears Wispen and is part Mystic.
    const first = cross(wild("obera", "a"), wild("wispen", "b"), "1");
    expect(first.sire).toBe("wispen");
    expect(first.type2).toBe("mystic");
    expect(typeof first.sire).toBe("string");
    expect(SPECIES[first.sire!]).toBeDefined();
    expect(JSON.stringify(first.sire)).toBe('"wispen"');
  });

  it("is its mother's species underneath, whatever it is called", () => {
    const first = cross(wild("obera", "a"), wild("wispen", "b"), "1");
    expect(sireOf(first)).toBe("obera");
    expect(scobaTypes(first)).toEqual(["moss", "mystic"]);
    expect(speciesName(first)).not.toBe("Obera");
  });

  it("goes no further, because a hybrid cannot breed", () => {
    const first = cross(wild("obera", "a"), wild("wispen", "b"), "1");
    expect(canBreed(first, wild("plib", "c"))).toMatch(/hybrid/);
    expect(canBreed(wild("plib", "c"), first)).toMatch(/hybrid/);
    expect(() => cross(wild("plib", "c"), first, "2")).toThrow(/hybrid/);
  });
});
