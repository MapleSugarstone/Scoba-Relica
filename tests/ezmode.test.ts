import { describe, expect, it } from "vitest";
import { makeWild, maxHp, statsAt, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { combatantMaxHp, combatantStats, startBattle } from "../src/sim/battle";
import { STAT_NAMES } from "../src/sim/types";

/**
 * One Scoba the player owns. Abilities both add to and scale stats, so every
 * case here compares a battle with EZ mode against the same one without it,
 * which is the only way to read what EZ mode itself is worth.
 */
function mine(level: number): ScobaInstance {
  return { ...makeWild("catsquito", level, rngFrom("mine")), level, owner: "A" };
}

function fight(team: ScobaInstance[], ez: boolean) {
  const foes = [makeWild("catsquito", 5, rngFrom("foe"))];
  return startBattle("seed", team, foes, { slots: 1, wild: true, ez });
}

const player = (team: ScobaInstance[], ez: boolean) => fight(team, ez).teams[0][0]!;

describe("EZ mode in battle", () => {
  it("adds nothing when it is off", () => {
    const s = mine(5);
    const c = player([s], false);
    expect(c.statuses.some((st) => st.id === "ez")).toBe(false);
    expect(combatantStats(c)).toEqual(combatantStats(player([s], false)));
  });

  it("hangs one stack per level past the first", () => {
    const c = player([mine(5)], true);
    const ez = c.statuses.find((st) => st.id === "ez");
    expect(ez?.stacks).toBe(4);
  });

  it("raises every stat while it is on", () => {
    const s = mine(5);
    const off = combatantStats(player([s], false));
    const on = combatantStats(player([s], true));
    for (const name of STAT_NAMES) expect(on[name]).toBeGreaterThan(off[name]);
  });

  it("makes a level worth four to a stat no ability touches", () => {
    // Defence is plain on this one: no ability adds to it or scales it, so
    // what lands there is exactly what EZ mode put there and nothing else.
    for (const level of [2, 3, 5]) {
      const s = mine(level);
      expect(combatantStats(player([s], false)).def).toBe(s.genes.def + (level - 1));
      expect(combatantStats(player([s], true)).def).toBe(s.genes.def + (level - 1) * 4);
    }
  });

  it("leaves the Scoba itself exactly as it was", () => {
    const s = mine(5);
    const before = { stats: statsAt(s, false), hp: s.hp, keys: Object.keys(s).sort() };
    fight([s], true);
    expect(statsAt(s, false)).toEqual(before.stats);
    expect(s.hp).toBe(before.hp);
    // Nothing is written onto it, so turning the setting off needs no undoing.
    expect(Object.keys(s).sort()).toEqual(before.keys);
  });

  it("opens the fight at the fuller pool the boost brings", () => {
    const c = player([mine(5)], true);
    expect(c.hp).toBe(combatantMaxHp(c));
    expect(c.hp).toBeGreaterThan(maxHp(mine(5)));
  });

  it("leaves the other side alone", () => {
    const st = fight([mine(5)], true);
    expect(st.teams[1][0]!.statuses.some((s) => s.id === "ez")).toBe(false);
  });

  it("passes over a Scoba on the players' side that nobody owns", () => {
    const stray = makeWild("catsquito", 5, rngFrom("stray"));
    const st = fight([stray], true);
    expect(st.teams[0][0]!.statuses.some((s) => s.id === "ez")).toBe(false);
  });

  it("gives a level one Scoba nothing, since it has no levels to count", () => {
    const s = mine(1);
    const c = player([s], true);
    expect(c.statuses.some((st) => st.id === "ez")).toBe(false);
    expect(combatantStats(c)).toEqual(combatantStats(player([s], false)));
  });
});
