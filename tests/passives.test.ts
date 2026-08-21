import { describe, expect, it } from "vitest";
import {
  startBattle,
  resolveTurn,
  combatantStats,
  combatantMaxHp,
  statusSummary,
  MANA_PER_TURN,
  START_MANA,
  type BattleState,
  type Combatant,
} from "../src/sim/battle";
import { stacksOf } from "../src/sim/status";
import { makeWild, passiveStatuses, statsAt, type ScobaInstance } from "../src/sim/scoba";
import { MOVES, SPECIES, effectivenessAgainst, typeLabel } from "../src/sim/species";
import { rngFrom } from "../src/sim/rng";

const wild = (species: string, level: number, seed: string) => makeWild(species, level, rngFrom(seed));
const owned = (s: ScobaInstance, owner: "A" | "B"): ScobaInstance => ({ ...s, owner });

/** One Scoba out with a spare behind it, against one enemy with a spare too. */
function duel(mine: string, theirs: string, moves?: string[]): BattleState {
  const me = owned(wild(mine, 20, `${mine}-a`), "A");
  if (moves) me.moves = moves;
  const st = startBattle(
    `${mine}-vs-${theirs}`,
    [me, owned(wild("plib", 20, `${mine}-b`), "A")],
    [wild(theirs, 20, `${theirs}-a`), wild("plib", 20, `${theirs}-b`)],
    { slots: 1, owners: ["A", null] },
  );
  st.teams[0][0]!.mana = 100;
  st.teams[0][0]!.cds = {};
  return st;
}

const held = (c: Combatant): string[] => c.statuses.map((s) => s.id);

describe("passives as statuses", () => {
  it("hangs both abilities on a Scoba as it goes out, and keeps them off the tag row", () => {
    const st = duel("plib", "grima");
    const me = st.teams[0][0]!;
    const sp = SPECIES["plib"]!;
    expect(held(me)).toContain(sp.primaryAbility);
    expect(held(me)).toContain(me.scoba.secondaryAbility);
    // The card already names the abilities, so they are not repeated as marks.
    expect(statusSummary(me).map((m) => m.id)).toEqual([]);
  });

  it("reads the same stats out of a battle as in one", () => {
    const st = duel("obera", "grima");
    const me = st.teams[0][0]!;
    expect(combatantStats(me)).toEqual(statsAt(me.scoba));
    expect(passiveStatuses(me.scoba).map((s) => s.id)).toEqual(held(me));
  });

  it("survives switching out, since a Scoba does not lose what it was born with", () => {
    const st = duel("plib", "grima");
    const me = st.teams[0][0]!;
    const before = held(me);
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    expect(held(me)).toEqual(before);
  });
});

describe("the wild lines", () => {
  it("each carry two passives: a signature primary and a secondary that always comes with it", () => {
    const pairs: [string, string, string][] = [
      ["catsquito", "thirst", "restless"],
      ["meepa", "moonwane", "moonwell"],
      ["cactunny", "sun-bloom", "sun-ward"],
    ];
    for (const [id, primary, secondary] of pairs) {
      const sp = SPECIES[id]!;
      expect(sp.primaryAbility).toBe(primary);
      // One entry in the pool, so every one of the line is rolled with both.
      expect(sp.secondaryPool).toEqual([secondary]);
      const one = wild(id, 5, `pair-${id}`);
      expect(one.secondaryAbility).toBe(secondary);
      expect(passiveStatuses(one).map((st) => st.id)).toEqual([primary, secondary]);
    }
  });
});

describe("Catsquito", () => {
  it("drinks back its Magic on a basic attack, and carries +10% Speed and Strength", () => {
    const st = duel("catsquito", "grima");
    const me = st.teams[0][0]!;
    const raw = statsAt(me.scoba, false);
    // Thirst scales both, on top of whatever the second ability does.
    expect(combatantStats(me).spd).toBeGreaterThanOrEqual(Math.floor(raw.spd * 1.1));
    expect(combatantStats(me).str).toBeGreaterThanOrEqual(Math.floor(raw.str * 1.1));

    me.hp = Math.floor(combatantMaxHp(me) / 2);
    const before = me.hp;
    resolveTurn(st, [
      { kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] },
      { kind: "block", side: 1, slot: 0 },
    ]);
    expect(me.hp - before).toBe(combatantStats(me).mag);
  });
});

describe("Meepa", () => {
  it("opens the battle with 10 extra mana, once", () => {
    const st = startBattle(
      "meepa-mana",
      [owned(wild("meepa", 20, "mm1"), "A"), owned(wild("plib", 20, "mm2"), "A")],
      [wild("grima", 20, "mm3")],
      { slots: 1, owners: ["A", null] },
    );
    const meepa = st.teams[0][0]!;
    expect(meepa.mana).toBe(START_MANA + 10);
    expect(st.teams[1][0]!.mana).toBe(START_MANA);
    // Walking out and back in does not top it up a second time.
    meepa.mana = START_MANA;
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 0 }]);
    expect(meepa.mana).toBe(START_MANA + MANA_PER_TURN);
  });

  it("thins what magic damage lands on, up to ten times, and loses it on a switch", () => {
    const st = duel("meepa", "grima", ["moonbeam"]);
    const foe = st.teams[1][0]!;
    const before = combatantStats(foe).res;
    for (let i = 0; i < 12 && st.winner === -1; i++) {
      foe.hp = combatantMaxHp(foe);
      st.teams[0][0]!.mana = 100;
      resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "moonbeam", picks: [{ side: 1, index: 0 }] }]);
    }
    expect(stacksOf(foe.statuses, "wane")).toBe(10);
    expect(combatantStats(foe).res).toBeLessThan(before);
    // It is the enemy's mark, so the enemy walking out is what clears it.
    resolveTurn(st, [{ kind: "switch", side: 1, slot: 0, benchIndex: 1 }]);
    expect(stacksOf(foe.statuses, "wane")).toBe(0);
    expect(combatantStats(foe).res).toBe(before);
  });
});

describe("Cactunny", () => {
  it("calls up Sunblessed over both sides rather than marking anybody", () => {
    const st = duel("cactunny", "grima");
    for (const side of [0, 1] as const) {
      expect(st.fields[side]?.id).toBe("sunblessed");
      for (const c of st.teams[side]) expect(held(c)).not.toContain("sunblessed");
    }
  });

  it("turns one Sun hit aside, and only one", () => {
    const st = duel("grima", "cactunny", ["cinder-spit"]);
    const foe = st.teams[1][0]!;
    const full = foe.hp;
    resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "cinder-spit", picks: [{ side: 1, index: 0 }] }]);
    expect(foe.hp).toBe(full);
    expect(held(foe)).not.toContain("sun-ward");
    st.teams[0][0]!.mana = 100;
    resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "cinder-spit", picks: [{ side: 1, index: 0 }] }]);
    expect(foe.hp).toBeLessThan(full);
  });
});

describe("two-type Scobas", () => {
  it("multiplies the chart against both halves", () => {
    const cactunny = SPECIES["cactunny"]!;
    // Moss/Sun: Flux is strong into Moss and weak into Sun, so they cancel.
    expect(effectivenessAgainst("flux", cactunny)).toBe(1);
    // Sun into Moss is 2, into Sun is 0.5.
    expect(effectivenessAgainst("sun", cactunny)).toBe(1);
    // Moon into Moss is 0.5, into Sun is 2.
    expect(effectivenessAgainst("moon", cactunny)).toBe(1);
    // Plain is flat everywhere, so Meepa defends as pure Moon.
    const meepa = SPECIES["meepa"]!;
    expect(effectivenessAgainst("moss", meepa)).toBe(2);
    expect(typeLabel(meepa)).toBe("Moon/Plain");
  });

  it("gives same-type damage off either half", () => {
    const st = duel("meepa", "grima", ["crush"]);
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    const events = resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "crush", picks: [{ side: 1, index: 0 }] },
    ]);
    // Crush is Plain, Meepa's second type, so it lands at 1.5x.
    const str = combatantStats(me).str;
    const def = combatantStats(foe).def;
    const hit = events.find((e) => e.kind === "hit")!;
    const raw = (str * MOVES["crush"]!.scale * 1.5) / (1 + def / 100);
    expect(before - hit.hp!).toBe(Math.floor(raw));
  });
});
