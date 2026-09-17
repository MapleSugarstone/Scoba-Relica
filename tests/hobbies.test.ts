import { describe, expect, it } from "vitest";
import { HOBBIES, HOBBY_IDS, hobbyDoing } from "../src/sim/status";
import {
  MAX_LEVEL, TEAS_MAX, TEA_AT_CEILING, makeWild, statsAt, teaWorth, type ScobaInstance,
} from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { STAT_NAMES, type StatName, type Stats } from "../src/sim/types";
import { HOBBY_MARK, hobbyFor, sparringScoba, teasFor } from "../src/sim/kit";
import { SPECIES, evolutionOf } from "../src/sim/species";

/** A Scoba with nothing on it, for measuring one thing at a time. */
const plain = (): ScobaInstance =>
  ({ ...makeWild("plib", MAX_LEVEL, rngFrom("hobby")), hobby: "unmotivated" });

const withHobby = (id: string): ScobaInstance => ({ ...plain(), hobby: id });

describe("hobbies", () => {
  it("gives every one a name for the hut and a line for the card", () => {
    expect(HOBBY_IDS.length).toBe(52);
    for (const id of HOBBY_IDS) {
      const h = HOBBIES[id]!;
      expect(h.name, id).not.toBe("");
      expect(h.doing, id).not.toBe("");
      expect(h.text, id).not.toBe("");
    }
  });

  it("names what the Scoba is doing, and nothing for one with no hobby", () => {
    expect(hobbyDoing("crochet")).toBe("Crocheting");
    expect(hobbyDoing(undefined)).toBe("");
    expect(hobbyDoing("not-a-hobby")).toBe("");
  });

  it("raises one stat by half and takes a quarter off another", () => {
    const bare = statsAt(plain(), false);
    const got = statsAt(withHobby("crochet"), false);
    expect(got.str).toBe(Math.floor(bare.str * 1.5));
    expect(got.def).toBe(Math.floor(bare.def * 0.75));
    // Nothing else moves, HP included: no hobby ever touches it.
    for (const name of STAT_NAMES) {
      if (name !== "str" && name !== "def") expect(got[name], name).toBe(bare[name]);
    }
  });

  it("raises two stats with a flat bonus on top and takes a fifth off a third", () => {
    const bare = statsAt(plain(), false);
    const got = statsAt(withHobby("hylic"), false);
    expect(got.str).toBe(Math.floor(bare.str * 1.35) + 15);
    expect(got.def).toBe(Math.floor(bare.def * 1.35) + 15);
    expect(got.res).toBe(Math.floor(bare.res * 0.8));
  });

  it("leaves an unmotivated Scoba exactly as it was", () => {
    const sc = plain();
    expect(statsAt({ ...sc, hobby: undefined }, false)).toEqual(statsAt(sc, false));
  });

  it("lifts all five fighting stats for a jack of all trades, and never HP", () => {
    const bare = statsAt(plain(), false);
    const got = statsAt(withHobby("jack-of-all-trades"), false);
    for (const name of ["str", "def", "res", "mag", "spd"] as StatName[]) {
      expect(got[name], name).toBe(Math.floor(bare[name] * 1.25) + 10);
    }
    expect(got.hp).toBe(bare.hp);
  });

  it("hands one out to every Scoba that is made", () => {
    for (const seed of ["a", "b", "c", "d"]) {
      const sc = makeWild("plib", 12, rngFrom(seed));
      expect(sc.hobby, seed).toBeDefined();
      expect(HOBBY_IDS, seed).toContain(sc.hobby);
    }
  });
});

describe("teas", () => {
  it("is worth its full amount at the ceiling and a share of it below", () => {
    expect(teaWorth(MAX_LEVEL)).toBe(TEA_AT_CEILING);
    expect(teaWorth(MAX_LEVEL / 2)).toBe(Math.round(TEA_AT_CEILING / 2));
    expect(teaWorth(1)).toBe(Math.round(TEA_AT_CEILING / MAX_LEVEL));
  });

  it("adds to the stat it was drunk for, one per tea", () => {
    const bare = statsAt(plain(), false);
    const one = statsAt({ ...plain(), teas: ["mag"] }, false);
    const three = statsAt({ ...plain(), teas: ["hp", "hp", "hp"] }, false);
    const mixed = statsAt({ ...plain(), teas: ["mag", "str", "str"] }, false);
    expect(one.mag).toBe(bare.mag + 15);
    expect(three.hp).toBe(bare.hp + 45);
    expect(mixed.mag).toBe(bare.mag + 15);
    expect(mixed.str).toBe(bare.str + 30);
  });

  it("pours no more than a Scoba can hold", () => {
    const bare = statsAt(plain(), false);
    const over = statsAt({ ...plain(), teas: ["str", "str", "str", "str", "str"] }, false);
    expect(over.str).toBe(bare.str + TEAS_MAX * 15);
  });

  it("is poured after the hobby, so a hobby never multiplies it", () => {
    const bare = statsAt(plain(), false);
    const both = statsAt({ ...withHobby("crochet"), teas: ["str"] }, false);
    // The hobby takes the line, the tea goes on top of what it left.
    expect(both.str).toBe(Math.floor(bare.str * 1.5) + 15);
  });
});

describe("picking a hobby to suit a Scoba", () => {
  const line = (over: Partial<Record<StatName, number>>): Stats =>
    ({ hp: 999, str: 100, def: 100, res: 100, mag: 100, spd: 100, ...over });

  it("lifts the two stats over the mark and gives up the weakest", () => {
    // Strength and Defense are over the mark and Speed is the weakest, which
    // is Tanks. Drop Resistance lowest instead and the same pair gives Hylic.
    expect(HOBBIES[hobbyFor(line({ str: 200, def: 190, spd: 40 }))]!.name).toBe("Tanks");
    expect(shape(HOBBIES[hobbyFor(line({ str: 200, def: 190, spd: 40 }))]!))
      .toEqual({ up: ["str", "def"], down: "spd" });
    expect(HOBBIES[hobbyFor(line({ str: 200, def: 190, res: 40 }))]!.name).toBe("Hylic");
  });

  it("lifts the one stat over the mark hardest, and still drops the weakest", () => {
    const got = HOBBIES[hobbyFor(line({ str: 200, spd: 40 }))]!;
    expect(got.name).toBe("Tauntcraft");
    expect(shape(got)).toEqual({ up: ["str"], down: "spd" });
  });

  it("takes a little of everything where nothing is over the mark", () => {
    expect(HOBBIES[hobbyFor(line({}))]!.name).toBe("Jack of all Trades");
    expect(HOBBIES[hobbyFor(line({ str: HOBBY_MARK }))]!.name).toBe("Jack of all Trades");
  });

  it("reads HP over the mark as nothing at all, since no hobby touches it", () => {
    expect(HOBBIES[hobbyFor(line({ hp: 400 }))]!.name).toBe("Jack of all Trades");
  });
});

describe("pouring teas for a Scoba", () => {
  it("pours three, over what it is best at or into Speed", () => {
    const rng = rngFrom("teas");
    const stats = { hp: 999, str: 200, def: 60, res: 60, mag: 190, spd: 50 };
    const got = teasFor(stats, rng);
    expect(got).toHaveLength(TEAS_MAX);
    for (const t of got) expect(["str", "mag", "spd"]).toContain(t);
  });
});

describe("a Scoba built for a sparring partner", () => {
  it("brings a line that has finished evolving, kitted to what it is", () => {
    const rng = rngFrom("sparring");
    for (let i = 0; i < 25; i++) {
      const sc = sparringScoba(30, rng);
      expect(evolutionOf(SPECIES[sc.speciesId]!), sc.speciesId).toBeNull();
      expect(sc.level).toBe(30);
      expect(sc.teas).toHaveLength(TEAS_MAX);
      // The hobby is the one the rule picks for the line it ended up with.
      expect(sc.hobby).toBe(hobbyFor(statsAt({ ...sc, hobby: undefined, teas: [] }, false)));
    }
  });

  it("brings hybrids about half the time", () => {
    const rng = rngFrom("mix");
    const made = Array.from({ length: 60 }, () => sparringScoba(30, rng));
    const hybrids = made.filter((s) => s.hybrid === true).length;
    expect(hybrids).toBeGreaterThan(10);
    expect(hybrids).toBeLessThan(50);
  });
});

/** What a hobby does, for reading a pick back. */
function shape(def: (typeof HOBBIES)[string]): { up: StatName[]; down: StatName | null } {
  const up: StatName[] = [];
  let down: StatName | null = null;
  for (const e of def.effects) {
    if (e.kind !== "stat-scale") continue;
    if (e.mult > 1) up.push(e.stat);
    if (e.mult < 1) down = e.stat;
  }
  return { up, down };
}
