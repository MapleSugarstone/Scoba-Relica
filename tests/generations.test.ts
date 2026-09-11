import { describe, expect, it } from "vitest";
import { breed, canBreed, MAX_BREED_COUNT } from "../src/sim/breeding";
import { makeWild, scobaTypes, sireOf } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { SPECIES } from "../src/sim/species";

const wild = (id: string, seed: string) => makeWild(id, 20, rngFrom(seed));
const cross = (mom: ReturnType<typeof wild>, dad: ReturnType<typeof wild>, seed: string) =>
  breed(mom, dad, rngFrom(seed), undefined, { forceDadAbility: true }).child;

describe("inheritance stops at one father", () => {
  it("hands on the father's own line, not what he is wearing", () => {
    // Obera x Wispen: the child wears Wispen and is part Mystic.
    const first = cross(wild("obera", "a"), wild("wispen", "b"), "1");
    expect(first.sire).toBe("wispen");
    expect(first.type2).toBe("mystic");

    // That child fathers another. What it hands on is Obera, which is what it
    // is, rather than the Wispen it took from its own father.
    const second = cross(wild("plib", "c"), first, "2");
    expect(sireOf(first)).toBe("obera");
    expect(second.sire).toBe("obera");
    expect(second.sire).not.toBe("wispen");
  });

  it("takes the element off the father's species, not off what he inherited", () => {
    const first = cross(wild("obera", "a"), wild("wispen", "b"), "1");
    expect(scobaTypes(first)).toEqual(["moss", "mystic"]);
    const second = cross(wild("plib", "c"), first, "2");
    // Obera is Moss. The Mystic its father picked up goes no further.
    expect(second.type2).toBe("moss");
    expect(scobaTypes(second)).toEqual(["plain", "moss"]);
  });

  it("is a species id and nothing else, so a Scoba records its father in a word", () => {
    const first = cross(wild("obera", "a"), wild("wispen", "b"), "1");
    expect(typeof first.sire).toBe("string");
    expect(SPECIES[first.sire!]).toBeDefined();
    expect(JSON.stringify(first.sire)).toBe('"wispen"');
  });

  it("runs out of generations after two", () => {
    const first = cross(wild("obera", "a"), wild("wispen", "b"), "1");
    expect(first.breedCount).toBe(1);
    const second = cross(first, wild("plib", "c"), "2");
    expect(second.breedCount).toBe(MAX_BREED_COUNT);
    expect(canBreed(second, wild("plib", "d"))).toMatch(/twice/);
  });
});
