import { describe, expect, it } from "vitest";
import {
  startBattle, resolveTurn, choiceError, castableMoves, combatantStats, combatantMaxHp,
  hyperError, formsOf, hyperBonus, HYPER_COST, type BattleState, type Choice,
} from "../src/sim/battle";
import { makeWild, statsAt, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { newStatus, stacksOf, HYPER_FLAT, HYPER_SCALE } from "../src/sim/status";
import { STAT_NAMES } from "../src/sim/types";
import { ABILITIES, MOVES, SPECIES, artNameFor } from "../src/sim/species";
import { accessoryOf } from "../src/game/critters";

const wild = (species: string, level: number, seed: string): ScobaInstance =>
  makeWild(species, level, rngFrom(seed));
const owned = (s: ScobaInstance): ScobaInstance => ({ ...s, owner: "A" });

/** One Octoshake and an ally, against three Plibs. */
function field(opts: { slots?: 1 | 2 } = {}): BattleState {
  const oct = owned(wild("octoshake", 30, "oct"));
  oct.secondaryAbility = "cherry-on-top";
  return startBattle("octo", [oct, owned(wild("plib", 30, "ally"))], [
    wild("plib", 30, "e1"), wild("plib", 30, "e2"), wild("plib", 30, "e3"),
  ], { slots: opts.slots ?? 1 });
}

const me = { side: 0 as const, index: 0 };
const cast = (moveId: string, picks: unknown[] = [{ side: 1, index: 0 }]): Choice =>
  ({ kind: "spell", side: 0, slot: 0, moveId, picks: picks as never });
const full = (st: BattleState, side: 0 | 1, index: number): void => {
  st.teams[side][index]!.mana = 100;
};

describe("Sticky Treat", () => {
  it("stops a Scoba hit by a spell from switching out next turn", () => {
    const st = field();
    full(st, 0, 0);
    resolveTurn(st, [cast("tentacle-slap")]);
    expect(st.teams[1][0]!.statuses.some((s) => s.id === "sticky")).toBe(true);
    const leave: Choice = { kind: "switch", side: 1, slot: 0, benchIndex: 1 };
    expect(choiceError(st, leave)).toMatch(/Sticky Treat holds it in place/);
  });

  it("lets go the turn after, so it costs exactly one switch", () => {
    const st = field();
    full(st, 0, 0);
    resolveTurn(st, [cast("tentacle-slap")]);
    resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    expect(choiceError(st, { kind: "switch", side: 1, slot: 0, benchIndex: 1 })).toBeNull();
  });

  it("does not stick to anything hit by a plain attack", () => {
    const st = field();
    resolveTurn(st, [{ kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] }]);
    expect(st.teams[1][0]!.statuses.some((s) => s.id === "sticky")).toBe(false);
  });
});

describe("Cherry on Top", () => {
  it("is offered as a fifth move without taking a slot", () => {
    const c = field().teams[0][0]!;
    expect(c.scoba.moves).toHaveLength(4);
    expect(castableMoves(c)).toHaveLength(5);
    expect(castableMoves(c)).toContain("cherry-on-top");
  });

  it("deals two per level flat, past Defense and the chart alike", () => {
    const st = field();
    const before = st.teams[1][0]!.hp;
    resolveTurn(st, [cast("cherry-on-top")]);
    expect(before - st.teams[1][0]!.hp).toBe(2 * 30);
  });

  it("costs nothing and fires once a battle", () => {
    const st = field();
    const mana = st.teams[0][0]!.mana;
    resolveTurn(st, [cast("cherry-on-top")]);
    expect(st.teams[0][0]!.mana).toBe(mana + 20);
    expect(choiceError(st, cast("cherry-on-top"))).toMatch(/Already used/);
  });

  it("goes before a faster Scoba's action", () => {
    const st = field();
    expect(combatantStats(st.teams[1][0]!).spd)
      .toBeGreaterThan(combatantStats(st.teams[0][0]!).spd);
    const ev = resolveTurn(st, [
      cast("cherry-on-top"),
      { kind: "attack", side: 1, slot: 0, picks: [me] },
    ]);
    const order = ev.filter((e) => e.kind === "spell").map((e) => e.text);
    expect(order[0]).toMatch(/Octoshake cast Cherry on Top/);
  });
});

describe("Hyper-Mode", () => {
  it("costs 60 mana and adds a quarter of its own line and a flat 15", () => {
    const st = field();
    const c = st.teams[0][0]!;
    full(st, 0, 0);
    const before = combatantStats(c);
    const bonus = hyperBonus(statsAt(c.scoba, true));
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }]);
    expect(c.hyper).toBe(true);
    const after = combatantStats(c);
    for (const k of STAT_NAMES) {
      expect([k, after[k]]).toEqual([k, before[k] + bonus[k]]);
      expect([k, bonus[k]]).toEqual([k, Math.round(before[k] * HYPER_SCALE) + HYPER_FLAT]);
    }
    expect(c.mana).toBe(100 - HYPER_COST + 20);
  });

  it("is worth the same however worn down the Scoba is when it enters", () => {
    // The same mode entered twice: once fresh, once with the fight already
    // having taken a bite out of its Speed.
    const gain = (slowFirst: boolean): number => {
      const st = field();
      const c = st.teams[0][0]!;
      full(st, 0, 0);
      if (slowFirst) {
        const mark = newStatus("slowed", { side: 1, index: 0 }, 40);
        c.statuses.push(mark!);
      }
      const before = combatantStats(c).spd;
      resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }]);
      return combatantStats(c).spd - before;
    };
    expect(gain(true)).toBe(gain(false));
  });

  it("keeps the same share of a bigger pool", () => {
    const st = field();
    const c = st.teams[0][0]!;
    full(st, 0, 0);
    c.hp = Math.floor(combatantMaxHp(c) / 2);
    const share = c.hp / combatantMaxHp(c);
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }]);
    expect(Math.abs(c.hp / combatantMaxHp(c) - share)).toBeLessThan(0.02);
  });

  it("is entered once and is offered to nothing that has no mode", () => {
    const st = field();
    full(st, 0, 0);
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }]);
    expect(hyperError(st.teams[0][0]!)).toMatch(/Already/);
    expect(hyperError(st.teams[0][1]!)).toMatch(/no Hyper-Mode/);
  });

  it("is refused without the mana for it", () => {
    const st = field();
    st.teams[0][0]!.mana = HYPER_COST - 1;
    expect(hyperError(st.teams[0][0]!)).toMatch(/Costs 60 mana/);
  });
});

describe("Sticky Mess", () => {
  it("leaves the mode's mark on for two turns rather than the passive's one", () => {
    const st = field();
    full(st, 0, 0);
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }]);
    const stuck = st.teams[1][0]!.statuses.find((s) => s.id === "sticky")!;
    expect(stuck.turnsLeft).toBe(2);
  });

  it("sticks every other Scoba and catches one on its way out", () => {
    const st = field();
    full(st, 0, 0);
    const ev = resolveTurn(st, [
      { kind: "hyper", side: 0, slot: 0 },
      { kind: "switch", side: 1, slot: 0, benchIndex: 1 },
    ]);
    expect(ev.some((e) => e.text.includes("is stuck fast"))).toBe(true);
    expect(st.active[1][0]).toBe(0);
    expect(st.teams[0][1]!.statuses.some((s) => s.id === "sticky")).toBe(true);
    expect(st.teams[0][0]!.statuses.some((s) => s.id === "sticky")).toBe(false);
  });
});

describe("the Octoshake spell list", () => {
  it("heals off the caster's Magic rather than the patient's pool", () => {
    // Both out, since a heal reaches an ally on the field rather than a bench.
    const st = field({ slots: 2 });
    const c = st.teams[0][0]!;
    const ally = st.teams[0][1]!;
    ally.hp = 10;
    full(st, 0, 0);
    resolveTurn(st, [cast("icecream-soup", [{ side: 0, index: 1 }])]);
    expect(ally.hp - 10).toBe(Math.floor(combatantStats(c).mag * 0.5));
  });

  it("takes 30% of the caster's Magic off the target's Speed", () => {
    const st = field();
    const c = st.teams[0][0]!;
    const target = st.teams[1][0]!;
    const before = combatantStats(target).spd;
    full(st, 0, 0);
    resolveTurn(st, [cast("tentacle-slap")]);
    // The share is kept whole and the floor lands once, at the end of the
    // stat line, so the drop can read a point either side of the share itself.
    const share = combatantStats(c).mag * 0.3;
    expect(Math.abs((before - combatantStats(target).spd) - share)).toBeLessThanOrEqual(1);
  });

  it("washes both enemies with Cold Wave and chills them on the turns after", () => {
    const st = field({ slots: 2 });
    full(st, 0, 0);
    const before = st.teams[1].slice(0, 2).map((c) => c.hp);
    resolveTurn(st, [cast("cold-wave", [null]), { kind: "block", side: 0, slot: 1 }]);
    expect(st.teams[1][0]!.hp).toBeLessThan(before[0]!);
    expect(st.teams[1][1]!.hp).toBeLessThan(before[1]!);
    const pass = (): void => {
      resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }, { kind: "block", side: 0, slot: 1 }]);
    };
    for (const i of [0, 1]) {
      expect(st.teams[1][i]!.statuses.some((s) => s.id === "cold")).toBe(true);
      // The wash landed this turn, so it has not bitten yet.
      expect(stacksOf(st.teams[1][i]!.statuses, "chill")).toBe(0);
    }
    // One bite a turn for the three turns after the one it landed on.
    pass();
    expect(stacksOf(st.teams[1][0]!.statuses, "chill")).toBe(1);
    pass();
    expect(stacksOf(st.teams[1][0]!.statuses, "chill")).toBe(2);
    pass();
    expect(stacksOf(st.teams[1][0]!.statuses, "chill")).toBe(3);
    // And then it is spent.
    pass();
    expect(st.teams[1][0]!.statuses.some((s) => s.id === "cold")).toBe(false);
    expect(stacksOf(st.teams[1][0]!.statuses, "chill")).toBe(3);
  });

  it("hands Tantalizing Sweets back when it kills", () => {
    const st = field();
    const c = st.teams[0][0]!;
    full(st, 0, 0);
    st.teams[1][0]!.hp = 1;
    resolveTurn(st, [cast("tantalizing-sweets")]);
    expect(st.teams[1][0]!.fainted).toBe(true);
    expect(c.mana).toBe(100);
    expect(c.cds["tantalizing-sweets"] ?? 0).toBe(0);
  });

  it("keeps the cooldown and the cost when it does not kill", () => {
    const st = field();
    const c = st.teams[0][0]!;
    full(st, 0, 0);
    resolveTurn(st, [cast("tantalizing-sweets")]);
    expect(st.teams[1][0]!.fainted).toBe(false);
    expect(c.cds["tantalizing-sweets"]).toBeGreaterThan(0);
    expect(c.mana).toBeLessThan(100);
  });
});

describe("what a Scoba is seen wearing", () => {
  const plib = SPECIES.plib!;
  const octo = SPECIES.octoshake!;

  it("puts the cherry on a line that inherited the passive", () => {
    expect(accessoryOf(plib, "cherry-on-top", [])).toBe("cherry");
  });

  it("leaves a line that has the passive of its own alone", () => {
    // Octoshake is drawn holding its cherry, so it wears no second one.
    expect(octo.secondaryPool).toContain("cherry-on-top");
    expect(accessoryOf(octo, "cherry-on-top", [])).toBeNull();
  });

  it("takes the cherry off the moment the move is spent", () => {
    expect(accessoryOf(plib, "cherry-on-top", ["cherryless"])).toBeNull();
  });

  it("costumes a line that has the cherry drawn in, for the same tag", () => {
    expect(artNameFor(octo, [])).toBe("octoshake");
    expect(artNameFor(octo, ["cherryless"])).toBe("octoshake-cherryless");
    expect(artNameFor(octo, ["hyper"])).toBe("hyper-octoshake");
    // Tags are sorted where they are read, so the order they arrive in is free.
    expect(artNameFor(octo, ["hyper", "cherryless"])).toBe("hyper-octoshake-cherryless");
    expect(artNameFor(octo, ["cherryless", "hyper"])).toBe("hyper-octoshake-cherryless");
  });

  it("names the tag on the move rather than anywhere that draws it", () => {
    const granted = ABILITIES["cherry-on-top"]!.grantsMove!;
    expect(MOVES[granted]!.spendsForm).toBe("cherryless");
  });

  it("tags a combatant as it spends the move and as it goes Hyper", () => {
    const st = field();
    const c = st.teams[0][0]!;
    expect(formsOf(c)).toEqual([]);
    resolveTurn(st, [cast("cherry-on-top")]);
    expect(formsOf(c)).toEqual(["cherryless"]);
    full(st, 0, 0);
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }]);
    expect(formsOf(c)).toEqual(["cherryless", "hyper"]);
  });
});
