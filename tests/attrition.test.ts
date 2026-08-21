import { describe, expect, it } from "vitest";
import {
  startBattle,
  resolveTurn,
  choiceError,
  combatantMaxHp,
  combatantStats,
  attritionFrac,
  ATTRITION_AFTER,
  ATTRITION_STEP,
  type BattleState,
} from "../src/sim/battle";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const wild = (species: string, level: number, seed: string) => makeWild(species, level, rngFrom(seed));
const owned = (s: ScobaInstance, owner: "A" | "B"): ScobaInstance => ({ ...s, owner });

/** A battle parked at a given turn, with everyone at full and nothing to do. */
function stalled(turn: number, opts: { wild?: boolean } = {}): BattleState {
  const me = owned(wild("plib", 30, "s1"), "A");
  me.moves = [];
  const foe = wild("obera", 30, "s2");
  foe.moves = [];
  const st = startBattle("attrition", [me], [foe], { slots: 1, wild: opts.wild ?? true, owners: ["A", null] });
  st.turn = turn;
  return st;
}

describe("attrition", () => {
  it("costs nothing up to the limit, then grows a tenth a turn", () => {
    expect(attritionFrac(ATTRITION_AFTER)).toBe(0);
    expect(attritionFrac(ATTRITION_AFTER - 5)).toBe(0);
    expect(attritionFrac(ATTRITION_AFTER + 1)).toBeCloseTo(ATTRITION_STEP);
    expect(attritionFrac(ATTRITION_AFTER + 2)).toBeCloseTo(ATTRITION_STEP * 2);
    expect(attritionFrac(ATTRITION_AFTER + 5)).toBeCloseTo(ATTRITION_STEP * 5);
  });

  it("leaves a short fight alone", () => {
    const st = stalled(5);
    const before = [st.teams[0][0]!.hp, st.teams[1][0]!.hp];
    resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    expect(st.teams[0][0]!.hp).toBe(before[0]);
    expect(st.teams[1][0]!.hp).toBe(before[1]);
  });

  it("takes a tenth of each pool on the first turn past the limit", () => {
    const st = stalled(ATTRITION_AFTER);
    const mine = st.teams[0][0]!;
    const theirs = st.teams[1][0]!;
    const myMax = combatantMaxHp(mine);
    const theirMax = combatantMaxHp(theirs);
    resolveTurn(st, []);
    expect(st.turn).toBe(ATTRITION_AFTER + 1);
    expect(myMax - mine.hp).toBe(Math.floor(myMax * ATTRITION_STEP));
    expect(theirMax - theirs.hp).toBe(Math.floor(theirMax * ATTRITION_STEP));
  });

  it("grows each turn it keeps going", () => {
    const st = stalled(ATTRITION_AFTER);
    const mine = st.teams[0][0]!;
    const max = combatantMaxHp(mine);
    let last = mine.hp;
    const bites: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (st.winner !== -1) break;
      resolveTurn(st, []);
      bites.push(last - mine.hp);
      last = mine.hp;
    }
    expect(bites[0]).toBe(Math.floor(max * ATTRITION_STEP));
    expect(bites[1]).toBe(Math.floor(max * ATTRITION_STEP * 2));
    expect(bites[2]).toBe(Math.floor(max * ATTRITION_STEP * 3));
  });

  it("goes straight through a Scoba that braced", () => {
    const open = stalled(ATTRITION_AFTER);
    const braced = stalled(ATTRITION_AFTER);
    resolveTurn(open, []);
    resolveTurn(braced, [{ kind: "block", side: 0, slot: 0 }]);
    expect(combatantMaxHp(braced.teams[0][0]!) - braced.teams[0][0]!.hp)
      .toBe(combatantMaxHp(open.teams[0][0]!) - open.teams[0][0]!.hp);
  });

  it("wears down the slowest first", () => {
    const slow = owned(wild("plib", 30, "o1"), "A");
    slow.moves = [];
    const fast = wild("flarea", 30, "o2");
    fast.moves = [];
    const st = startBattle("order", [slow], [fast], { slots: 1, wild: true, owners: ["A", null] });
    st.turn = ATTRITION_AFTER;
    // Make the speed gap unambiguous rather than relying on species stats.
    slow.genes = { ...slow.genes, spd: 1 };
    fast.genes = { ...fast.genes, spd: 30 };
    expect(combatantStats(st.teams[0][0]!).spd).toBeLessThan(combatantStats(st.teams[1][0]!).spd);
    const events = resolveTurn(st, []);
    const worn = events.filter((e) => e.text.includes("is worn down"));
    expect(worn).toHaveLength(2);
    expect(worn[0]!.at).toEqual({ side: 0, index: 0 });
    expect(worn[1]!.at).toEqual({ side: 1, index: 0 });
  });

  it("ends a fight nobody else was going to end", () => {
    const st = stalled(ATTRITION_AFTER);
    let guard = 40;
    while (st.winner === -1 && st.outcome === "" && guard-- > 0) {
      resolveTurn(st, []);
    }
    expect(st.winner === 0 || st.winner === 1).toBe(true);
  });
});

describe("walking away", () => {
  it("lets you leave a trainer fight, not only a wild one", () => {
    const trainer = stalled(1, { wild: false });
    expect(choiceError(trainer, { kind: "flee", side: 0, slot: 0 })).toBeNull();
    const events = resolveTurn(trainer, [{ kind: "flee", side: 0, slot: 0 }]);
    expect(trainer.outcome).toBe("fled");
    expect(events.some((e) => e.kind === "flee")).toBe(true);
  });

  it("still keeps snares to wild fights", () => {
    const trainer = stalled(1, { wild: false });
    expect(choiceError(trainer, { kind: "catch", side: 0, slot: 0 })).toMatch(/wild/);
    const feral = stalled(1, { wild: true });
    expect(choiceError(feral, { kind: "catch", side: 0, slot: 0 })).toBeNull();
  });

  it("does not let the other side walk off with the fight", () => {
    const st = stalled(1);
    expect(choiceError(st, { kind: "flee", side: 1, slot: 0 })).toMatch(/challenger/);
  });
});
