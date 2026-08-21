import { describe, expect, it } from "vitest";
import { startBattle, resolveTurn, choiceError, specsFor, targetOptions, type BattleState } from "../src/sim/battle";
import { candidates, needsPick, resolveTargets, TARGET_LABELS, type TargetMode } from "../src/sim/targeting";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { MOVES } from "../src/sim/species";

const wild = (species: string, level: number, seed: string) => makeWild(species, level, rngFrom(seed));
const owned = (s: ScobaInstance, owner: "A" | "B"): ScobaInstance => ({ ...s, owner });

/** Two allies out, two enemies out, one on each bench. */
function field(): BattleState {
  return startBattle(
    "targets",
    [
      owned(wild("plib", 10, "a1"), "A"),
      owned(wild("grima", 10, "a2"), "A"),
      owned(wild("flarea", 10, "b1"), "B"),
    ],
    [wild("obera", 10, "e1"), wild("plib", 10, "e2"), wild("flarea", 10, "e3")],
    { slots: 2, owners: ["A", "B"] },
  );
}

const user = { side: 0 as const, index: 0 };

describe("targeting", () => {
  it("gives every mode a label, so nothing shows up unnamed", () => {
    for (const mode of Object.keys(TARGET_LABELS) as TargetMode[]) {
      expect(TARGET_LABELS[mode].length).toBeGreaterThan(0);
    }
  });

  it("offers the right menu for each mode", () => {
    const st = field();
    // Slot 0 is A's plib (index 0), slot 1 is B's flarea (index 2).
    expect(candidates(st, user, "self")).toEqual([user]);
    expect(candidates(st, user, "any-ally")).toEqual([{ side: 0, index: 0 }, { side: 0, index: 2 }]);
    expect(candidates(st, user, "other-ally")).toEqual([{ side: 0, index: 2 }]);
    expect(candidates(st, user, "any-enemy")).toEqual([{ side: 1, index: 0 }, { side: 1, index: 1 }]);
    expect(candidates(st, user, "any-scoba")).toHaveLength(4);
    expect(candidates(st, user, "benched-ally")).toEqual([{ side: 0, index: 1 }]);
    expect(candidates(st, user, "benched-enemy")).toEqual([{ side: 1, index: 2 }]);
  });

  it("asks for a pick only where there is a decision", () => {
    expect(needsPick("any-enemy")).toBe(true);
    expect(needsPick("benched-enemy")).toBe(true);
    expect(needsPick("self")).toBe(false);
    expect(needsPick("enemy-team")).toBe(false);
    expect(needsPick("random-enemy")).toBe(false);
  });

  it("still asks when only one target is possible", () => {
    const st = startBattle("one", [wild("plib", 10, "s1")], [wild("obera", 10, "s2")], { slots: 1 });
    const specs = specsFor({ kind: "attack", side: 0, slot: 0, picks: [] });
    expect(specs).toHaveLength(1);
    expect(needsPick(specs[0]!.mode)).toBe(true);
    expect(targetOptions(st, { side: 0, index: 0 }, specs[0]!)).toHaveLength(1);
    expect(choiceError(st, { kind: "attack", side: 0, slot: 0, picks: [] })).toMatch(/Wrong number/);
    expect(choiceError(st, { kind: "attack", side: 0, slot: 0, picks: [null] })).toMatch(/Pick a target/);
  });

  it("refuses a pick that is not on the menu", () => {
    const st = field();
    // Aiming a basic attack at an ally, or at a benched enemy, is not legal.
    expect(choiceError(st, { kind: "attack", side: 0, slot: 0, picks: [{ side: 0, index: 2 }] })).toMatch(/Not a legal/);
    expect(choiceError(st, { kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 2 }] })).toMatch(/Not a legal/);
    expect(choiceError(st, { kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 1 }] })).toBeNull();
  });

  it("spreads a team move over everyone standing", () => {
    const st = field();
    const spec = MOVES["scatter-shot"]!.targets[0]!;
    expect(resolveTargets(st, user, spec, null, rngFrom("r"))).toEqual([
      { side: 1, index: 0 },
      { side: 1, index: 1 },
    ]);
  });

  it("rolls a random target from the turn seed, the same way twice", () => {
    const st = field();
    const spec = MOVES["wild-bolt"]!.targets[0]!;
    const a = resolveTargets(st, user, spec, null, rngFrom("same"));
    const b = resolveTargets(st, user, spec, null, rngFrom("same"));
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(a[0]!.side).toBe(1);
  });

  it("hits every enemy with one cast of a team move", () => {
    const st = field();
    st.teams[0][0]!.scoba.moves = ["scatter-shot"];
    st.teams[0][0]!.mana = 100;
    const before = st.teams[1].slice(0, 2).map((c) => c.hp);
    resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "scatter-shot", picks: [null] }]);
    expect(st.teams[1][0]!.hp).toBeLessThan(before[0]!);
    expect(st.teams[1][1]!.hp).toBeLessThan(before[1]!);
    // The benched one is untouched: it was never standing.
    expect(st.teams[1][2]!.hp).toBe(st.teams[1][2]!.hp);
  });

  it("reaches a benched enemy that nothing else can touch", () => {
    const st = field();
    st.teams[0][0]!.scoba.moves = ["snipe"];
    st.teams[0][0]!.cds = {};
    st.teams[0][0]!.mana = 100;
    const before = st.teams[1][2]!.hp;
    resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "snipe", picks: [{ side: 1, index: 2 }] }]);
    expect(st.teams[1][2]!.hp).toBeLessThan(before);
  });

  it("runs a two-target move: draw from one, spend it on the others", () => {
    const st = field();
    st.teams[0][0]!.scoba.moves = ["blood-pact"];
    st.teams[0][0]!.cds = {};
    st.teams[0][0]!.mana = 100;
    const ally = st.teams[0][2]!;
    const allyBefore = ally.hp;
    const foesBefore = st.teams[1].slice(0, 2).map((c) => c.hp);
    resolveTurn(st, [{
      kind: "spell", side: 0, slot: 0, moveId: "blood-pact",
      picks: [{ side: 0, index: 2 }, null],
    }]);
    expect(ally.hp).toBeLessThan(allyBefore);
    expect(st.teams[1][0]!.hp).toBeLessThan(foesBefore[0]!);
    expect(st.teams[1][1]!.hp).toBeLessThan(foesBefore[1]!);
  });

  it("delivers a transfer as healing when the move says so", () => {
    const st = field();
    st.teams[0][0]!.scoba.moves = ["tithe"];
    st.teams[0][0]!.cds = {};
    st.teams[0][0]!.mana = 100;
    const me = st.teams[0][0]!;
    const ally = st.teams[0][2]!;
    ally.hp = 5;
    const mine = me.hp;
    resolveTurn(st, [{
      kind: "spell", side: 0, slot: 0, moveId: "tithe",
      picks: [null, { side: 0, index: 2 }],
    }]);
    expect(me.hp).toBeLessThan(mine);
    expect(ally.hp).toBeGreaterThan(5);
  });
});
