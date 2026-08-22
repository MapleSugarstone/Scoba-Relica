import { describe, expect, it } from "vitest";
import {
  boxOf,
  lend,
  lentOut,
  partyOf,
  recallLent,
  sendToBox,
  takeBack,
  takeFromBox,
  type SaveData,
} from "../src/save/save";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const scoba = (species: string, seed: string, owner?: "A" | "B"): ScobaInstance => {
  const s = makeWild(species, 5, rngFrom(seed));
  s.owner = owner;
  return s;
};

const saveWith = (party: ScobaInstance[], box: ScobaInstance[]): SaveData =>
  ({ party, box, localSlot: "A" }) as unknown as SaveData;

describe("lending to the other character", () => {
  it("moves one out of your box into their party and keeps it yours", () => {
    const mine = scoba("obera", "a2", "A");
    const save = saveWith([scoba("plib", "a1", "A"), scoba("flarea", "b1", "B")], [mine]);

    expect(lend(save, mine.uid)).toBe(true);
    expect(partyOf(save, "B").map((s) => s.uid)).toEqual([save.party[1]!.uid, mine.uid]);
    expect(boxOf(save, "A")).toHaveLength(0);
    expect(mine.owner).toBe("B");
    expect(mine.lentBy).toBe("A");
    expect(lentOut(save).map((s) => s.uid)).toEqual([mine.uid]);
  });

  it("refuses once their party is full, and never touches their box", () => {
    const spare = scoba("grima", "a4", "A");
    const save = saveWith([
      scoba("plib", "a1", "A"),
      scoba("flarea", "b1", "B"),
      scoba("obera", "b2", "B"),
      scoba("cresce", "b3", "B"),
    ], [spare]);

    expect(lend(save, spare.uid)).toBe(false);
    expect(boxOf(save, "A").map((s) => s.uid)).toEqual([spare.uid]);
    expect(boxOf(save, "B")).toHaveLength(0);
  });

  it("will not lend what is not yours", () => {
    const theirs = scoba("obera", "b2", "B");
    const save = saveWith([scoba("plib", "a1", "A"), scoba("flarea", "b1", "B")], [theirs]);
    expect(lend(save, theirs.uid)).toBe(false);
    expect(theirs.owner).toBe("B");
  });

  it("takes a loan back into your own box, not theirs", () => {
    const mine = scoba("obera", "a2", "A");
    const save = saveWith([scoba("plib", "a1", "A"), scoba("flarea", "b1", "B")], [mine]);
    lend(save, mine.uid);

    expect(takeBack(save, mine.uid)).toBe(true);
    expect(boxOf(save, "A").map((s) => s.uid)).toEqual([mine.uid]);
    expect(partyOf(save, "B")).toHaveLength(1);
    expect(mine.owner).toBe("A");
    expect(mine.lentBy).toBeUndefined();
    // Only a loan comes back this way; their own stays where it is.
    expect(takeBack(save, save.party[1]!.uid)).toBe(false);
  });

  it("keeps a loan out of the borrower's box", () => {
    const mine = scoba("obera", "a2", "A");
    const save = saveWith([scoba("plib", "a1", "A"), scoba("flarea", "b1", "B")], [mine]);
    lend(save, mine.uid);

    expect(sendToBox(save, mine.uid)).toBe(false);
    expect(partyOf(save, "B").map((s) => s.uid)).toContain(mine.uid);
    expect(save.box).toHaveLength(0);
  });

  it("brings every loan home when a second player arrives", () => {
    const first = scoba("obera", "a2", "A");
    const second = scoba("grima", "a3", "A");
    const save = saveWith([scoba("plib", "a1", "A"), scoba("flarea", "b1", "B")], [first, second]);
    lend(save, first.uid);
    lend(save, second.uid);
    expect(partyOf(save, "B")).toHaveLength(3);

    expect(recallLent(save).map((s) => s.uid)).toEqual([first.uid, second.uid]);
    expect(lentOut(save)).toHaveLength(0);
    expect(partyOf(save, "B").map((s) => s.speciesId)).toEqual(["flarea"]);
    expect(boxOf(save, "A").map((s) => s.uid)).toEqual([first.uid, second.uid]);
    // Home again, and yours to field as usual.
    expect(takeFromBox(save, first.uid)).toBe(true);
    expect(partyOf(save, "A")).toHaveLength(2);
  });

  it("has nothing to bring home when nothing was lent", () => {
    const save = saveWith([scoba("plib", "a1", "A"), scoba("flarea", "b1", "B")], []);
    expect(recallLent(save)).toHaveLength(0);
    expect(partyOf(save, "B")).toHaveLength(1);
  });
});
