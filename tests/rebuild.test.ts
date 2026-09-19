import { describe, expect, it } from "vitest";
import { migrate } from "../src/save/save";
import { breed } from "../src/sim/breeding";
import { rebuildScoba, storedScoba } from "../src/sim/rebuild";
import { makeWild, maxHp, type ScobaInstance } from "../src/sim/scoba";
import { SPECIES, speciesMoves } from "../src/sim/species";
import { rngFrom } from "../src/sim/rng";

/** A save holding these, written the way the game writes one and read back the way it loads one. */
function reload(party: ScobaInstance[]): ScobaInstance[] {
  const written = JSON.parse(JSON.stringify({ version: 15, party: party.map(storedScoba), box: [], sentinels: {} }));
  return migrate(written)!.party;
}

describe("rebuilding a kept Scoba", () => {
  it("gives a Scoba kept under an old kit its line's moves, passive and stats", () => {
    const stale: ScobaInstance = {
      ...makeWild("poki", 21, rngFrom("stale")),
      moves: ["crush", "ember", "cinder-spit", "flame-burst"],
      secondaryAbility: "swift",
      genes: { hp: 90, str: 140, def: 80, res: 90, mag: 50, spd: 50 },
    };
    rebuildScoba(stale);
    expect(stale.moves).toEqual(speciesMoves(SPECIES["poki"]!));
    expect(stale.secondaryAbility).toBe("multiply-allies");
    expect(stale.genes).toEqual(SPECIES["poki"]!.genes);
    expect(stale.hp).toBeLessThanOrEqual(maxHp(stale));
  });

  it("keeps an unbred Scoba's own choices", () => {
    const wild = makeWild("obera", 12, rngFrom("keep"));
    const [back] = reload([wild]);
    expect(back!.moves).toEqual(wild.moves);
    expect(back!.secondaryAbility).toBe(wild.secondaryAbility);
    expect(back!.genes).toEqual(wild.genes);
    expect(back!.hobby).toBe(wild.hobby);
  });

  it("keeps everything that makes a Scoba its own through a save", () => {
    const wild: ScobaInstance = {
      ...makeWild("obera", 12, rngFrom("own")),
      nickname: "Sprout", shiny: true, teas: ["str", "spd"], met: { at: 1_700_000_000_000, by: "Robin" },
    };
    const [back] = reload([wild]);
    expect(back!.nickname).toBe("Sprout");
    expect(back!.shiny).toBe(true);
    expect(back!.teas).toEqual(["str", "spd"]);
    expect(back!.hobby).toBe(wild.hobby);
    expect(back!.met).toEqual({ at: 1_700_000_000_000, by: "Robin" });
  });

  it("writes a save without what it rebuilds", () => {
    const wild = makeWild("obera", 12, rngFrom("strip"));
    const kept = storedScoba(wild);
    expect(kept).not.toHaveProperty("moves");
    expect(kept).not.toHaveProperty("genes");
    expect(kept.secondaryAbility).toBe(wild.secondaryAbility);
  });

  it("rebuilds a hybrid around the move it took and the father it took it from", () => {
    const mom = makeWild("addiza", 30, rngFrom("mom"));
    const dad = makeWild("poki", 30, rngFrom("dad"));
    const child = breed(mom, dad, rngFrom("hatch"));
    expect(child.inherited).toBeDefined();
    const [back] = reload([child]);
    expect(back!.moves).toEqual(child.moves);
    expect(back!.genes).toEqual(child.genes);
    expect(back!.secondaryAbility).toBe(child.secondaryAbility);
    expect(back!.type2).toBe(child.type2);
  });

  it("reads the taken move off the moves of a hybrid kept before that was recorded", () => {
    const child = breed(makeWild("addiza", 30, rngFrom("m2")), makeWild("poki", 30, rngFrom("d2")), rngFrom("h2"));
    const was = { ...child.inherited! };
    delete child.inherited;
    rebuildScoba(child);
    expect(child.inherited).toEqual(was);
    expect(child.moves[was.slot]).toBe(was.move);
  });
});
