import { describe, expect, it } from "vitest";
import { PARTY_PER_CHARACTER, addToParty, partyHasRoom, partyOf, type SaveData } from "../src/save/save";
import { makeWild } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const scoba = (species: string, seed: string, owner?: "A" | "B") => {
  const s = makeWild(species, 5, rngFrom(seed));
  s.owner = owner;
  return s;
};

const saveWith = (party: ReturnType<typeof scoba>[]): SaveData =>
  ({ party, box: [], localSlot: "A" }) as unknown as SaveData;

describe("party rosters", () => {
  it("splits the party by character and caps each at three", () => {
    const save = saveWith([
      scoba("plib", "a1", "A"),
      scoba("flarea", "b1", "B"),
      scoba("obera", "a2", "A"),
      scoba("grima", "a3", "A"),
      scoba("plib", "a4", "A"),
    ]);
    expect(partyOf(save, "A").map((s) => s.speciesId)).toEqual(["plib", "obera", "grima"]);
    expect(partyOf(save, "B").map((s) => s.speciesId)).toEqual(["flarea"]);
    expect(partyOf(save, "A")).toHaveLength(PARTY_PER_CHARACTER);
  });

  it("leaves the special Scoba out of both rosters", () => {
    const save = saveWith([scoba("relica", "s1", "A"), scoba("plib", "a1", "A")]);
    expect(partyOf(save, "A").map((s) => s.speciesId)).toEqual(["plib"]);
  });

  it("sends a catch to the box only once that character is full", () => {
    const save = saveWith([scoba("plib", "a1", "A"), scoba("flarea", "b1", "B")]);
    expect(addToParty(save, scoba("obera", "n1"), "A")).toBe("party");
    expect(addToParty(save, scoba("grima", "n2"), "A")).toBe("party");
    expect(partyHasRoom(save, "A")).toBe(false);
    expect(addToParty(save, scoba("plib", "n3"), "A")).toBe("box");
    // The other character still has room of their own.
    expect(partyHasRoom(save, "B")).toBe(true);
    expect(addToParty(save, scoba("obera", "n4"), "B")).toBe("party");
    expect(save.box).toHaveLength(1);
  });

  it("stamps the owner on whatever it takes in", () => {
    const save = saveWith([]);
    const caught = scoba("obera", "n5");
    addToParty(save, caught, "B");
    expect(caught.owner).toBe("B");
    expect(partyOf(save, "B")).toHaveLength(1);
  });
});
