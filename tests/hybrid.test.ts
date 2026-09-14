import { describe, expect, it } from "vitest";
import { migrate } from "../src/save/save";
import { blendNames } from "../src/sim/blend";
import { breed } from "../src/sim/breeding";
import WRITTEN from "../src/sim/content/hybrid-names.json";
import { makeWild, speciesName } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { SPECIES, sameLine } from "../src/sim/species";

describe("a hybrid's name", () => {
  it("matches names written by hand for the same pairings", () => {
    // From the rounds in claude-notes/hybrid-names.md.
    const written: [string, string, string][] = [
      ["Roulle", "Catsquito", "Rousquito"],
      ["Grima", "Catsquito", "Grisquito"],
      ["Cottlequeen", "Meepa", "Cotteepa"],
      ["Octoshake", "Clikkit", "Octokit"],
      ["Cactunny", "Meepa", "Cacteepa"],
      ["Wispen", "Octoshake", "Wisshake"],
      ["Allin", "Pieble", "Allieble"],
      ["Cottlequeen", "Pieble", "Cottieble"],
      ["Octoshake", "Plib", "Octoshib"],
      ["Meepa", "Plib", "Meelib"],
      ["Sqwoop", "Allin", "Sqwolin"],
    ];
    for (const [mother, father, name] of written) expect([mother, father, blendNames(mother, father)]).toEqual([mother, father, name]);
  });

  it("never triples a letter or runs three vowels together", () => {
    const names = Object.values(SPECIES).filter((sp) => !sp.special && !sp.pawn).map((sp) => sp.name);
    for (const mother of names) {
      for (const father of names) {
        if (mother === father) continue;
        // The u after a q is part of the consonant, so "queen" has two vowels.
        const name = blendNames(mother, father);
        const sounds = name.toLowerCase().replace(/qu/g, "q");
        expect([mother, father, /(.)\1\1/.test(sounds) || /[aeiouy]{3}/.test(sounds)]).toEqual([mother, father, false]);
        expect([mother, father, name.length >= 3]).toEqual([mother, father, true]);
      }
    }
  });

  it("never splits the qu in a name", () => {
    expect(blendNames("Cottlequeen", "Aulium")).not.toMatch(/q(?!u)/i);
    expect(blendNames("Roulle", "Catsquito")).not.toMatch(/q(?!u)/i);
  });

  it("uses a name written for the pairing over the blend", () => {
    const mom = makeWild("cactunny", 20, rngFrom("wm"));
    const dad = makeWild("pieble", 20, rngFrom("wd"));
    const child = breed(mom, dad, rngFrom("wc"));
    // The blend alone gives Cactule.
    expect(blendNames("Cactunny", "Pieble")).not.toBe("Cactieble");
    expect(speciesName(child)).toBe("Cactieble");
  });

  it("writes names only for pairings that make a hybrid", () => {
    for (const [key, name] of Object.entries(WRITTEN)) {
      const [mother, father] = key.split(":");
      expect([key, SPECIES[mother!] !== undefined, SPECIES[father!] !== undefined]).toEqual([key, true, true]);
      expect([key, sameLine(SPECIES[mother!]!, SPECIES[father!]!)]).toEqual([key, false]);
      expect([key, /^[A-Z][a-z]+$/.test(name)]).toEqual([key, true]);
    }
  });

  it("names the same pairing the same way every time", () => {
    expect(blendNames("Grima", "Meepa")).toBe(blendNames("Grima", "Meepa"));
    expect(blendNames("Obera", "Obera")).toBe("Obera");
  });
});

describe("saves from before hybrids", () => {
  const scoba = (breedCount: number) => ({ ...makeWild("obera", 5, rngFrom(`b${breedCount}`)), breedCount });

  it("marks everything bred under the old rules a hybrid, and drops the breed count", () => {
    const old = { version: 14, party: [scoba(0), scoba(1)], box: [scoba(2)], sentinels: {} };
    const save = migrate(old);
    expect(save?.version).toBe(15);
    const [wild, once] = save!.party;
    expect(wild!.hybrid).toBeUndefined();
    expect(once!.hybrid).toBe(true);
    expect(save!.box[0]!.hybrid).toBe(true);
    for (const s of [...save!.party, ...save!.box]) expect(s).not.toHaveProperty("breedCount");
  });
});
