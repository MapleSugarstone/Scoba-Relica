import { describe, expect, it } from "vitest";
import {
  combatantStats, resolveTurn, startBattle, statusSummary, worthOf, type BattleState, type Choice, type Combatant,
} from "../src/sim/battle";
import { MOVES } from "../src/sim/species";
import { STATUSES, newStatus, onSwitchOut, stacksOf } from "../src/sim/status";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const wild = (id: string, lv: number, owner?: "A"): ScobaInstance => ({
  ...makeWild(id, lv, rngFrom(`${id}:${lv}`)),
  ...(owner ? { owner } : {}),
});

/** Poki, with a Plib on the bench, against one sturdy wild. */
function duel(): BattleState {
  const st = startBattle("poki", [wild("poki", 30, "A"), wild("plib", 30, "A")], [wild("pieble", 30)], { slots: 1 });
  st.teams[0][0]!.mana = 100;
  return st;
}

const poki = (st: BattleState): Combatant => st.teams[0][0]!;
const foe = (st: BattleState): Combatant => st.teams[1][0]!;
const FOE = { side: 1 as const, index: 0 };
const brace: Choice = { kind: "block", side: 1, slot: 0 };

const cast = (st: BattleState, moveId: string): void => {
  poki(st).mana = 100;
  const whole = MOVES[moveId]!.targets[0]!.mode === "enemy-team";
  resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId, picks: [whole ? null : FOE] }, brace]);
};

const goHyper = (st: BattleState): void => {
  poki(st).mana = 100;
  resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, brace]);
};

/** A status on the enemy as Poki would have left it, with a fixed power. */
const leave = (st: BattleState, id: string, power: number): void => {
  foe(st).statuses.push(newStatus(id, { side: 0, index: 0 }, power, 0)!);
};

describe("Poki", () => {
  it("costs what the kit says", () => {
    expect(["fire-scratch", "burn-slash", "poki-slam", "multiply-wounds"].map((id) => MOVES[id]!.manaCost))
      .toEqual([15, 30, 50, 80]);
    expect(MOVES["poki-slam"]!.type).toBe("plain");
    expect(MOVES["fire-scratch"]!.kind).toBe("physical");
  });

  it("sears on a firework physical hit only in Hyper-Mode, and not on a plain one", () => {
    const st = duel();
    cast(st, "fire-scratch");
    expect(stacksOf(foe(st).statuses, "seared")).toBe(0);
    goHyper(st);
    cast(st, "fire-scratch");
    expect(stacksOf(foe(st).statuses, "seared")).toBe(1);
    cast(st, "poki-slam");
    expect(stacksOf(foe(st).statuses, "seared")).toBe(1);
    expect(STATUSES["seared"]!.maxStacks).toBe(5);
    expect(STATUSES["seared"]!.duration).toBe(2);
  });

  it("stacks Burn Slash's strength on Poki up to 3 times, and loses it on switching out", () => {
    const st = duel();
    const before = combatantStats(poki(st)).str;
    for (let i = 0; i < 4; i++) cast(st, "burn-slash");
    expect(stacksOf(poki(st).statuses, "burning-edge")).toBe(3);
    expect(combatantStats(poki(st)).str).toBeGreaterThan(before);
    expect(stacksOf(onSwitchOut(poki(st).statuses), "burning-edge")).toBe(0);
  });

  it("makes an enemy's negative statuses 15% stronger while Poki stands, and stops when it leaves", () => {
    const st = duel();
    leave(st, "in-the-black", 20);
    const held = foe(st).statuses.find((s) => s.id === "in-the-black")!;
    expect(worthOf(foe(st), held)).toBeCloseTo(1.15);
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }, brace]);
    expect(worthOf(foe(st), held)).toBe(1);
  });

  it("makes Poki's own positive statuses 15% stronger, since Poki is its own ally", () => {
    const st = duel();
    cast(st, "burn-slash");
    const edge = poki(st).statuses.find((s) => s.id === "burning-edge")!;
    expect(worthOf(poki(st), edge)).toBeCloseTo(1.15);
  });

  it("leaves Multiplied, which makes their negative statuses 50% stronger on top and stays through a switch", () => {
    const st = duel();
    leave(st, "in-the-black", 20);
    cast(st, "multiply-wounds");
    expect(stacksOf(foe(st).statuses, "multiplied")).toBe(1);
    const held = foe(st).statuses.find((s) => s.id === "in-the-black")!;
    expect(worthOf(foe(st), held)).toBeCloseTo(1.5 * 1.15);
    expect(stacksOf(onSwitchOut(foe(st).statuses), "multiplied")).toBe(1);
  });

  it("reaches passives, but never Hyper-Mode or EZ mode", () => {
    const st = startBattle(
      "poki-pair",
      [{ ...wild("addiza", 30, "A") }, { ...wild("poki", 30), owner: "B" }],
      [wild("pieble", 30), wild("pieble", 30)],
      { slots: 2, owners: ["A", "B"] },
    );
    const addiza = st.teams[0][0]!;
    const sum = addiza.statuses.find((s) => s.id === "sum")!;
    expect(worthOf(addiza, sum)).toBeCloseTo(1.15);
    const ez = newStatus("ez")!;
    addiza.statuses.push(ez);
    expect(worthOf(addiza, ez)).toBe(1);
    addiza.mana = 100;
    resolveTurn(st, [
      { kind: "hyper", side: 0, slot: 0 }, { kind: "block", side: 0, slot: 1 },
      { kind: "block", side: 1, slot: 0 }, { kind: "block", side: 1, slot: 1 },
    ]);
    const hyper = addiza.statuses.find((s) => s.id === "hyper")!;
    expect(worthOf(addiza, hyper)).toBe(1);
  });

  it("shows its reach as a sigil on the Scobas it reaches, but not on Poki", () => {
    const st = startBattle(
      "poki-pair",
      [{ ...wild("addiza", 30, "A") }, { ...wild("poki", 30), owner: "B" }],
      [wild("pieble", 30), wild("pieble", 30)],
      { slots: 2, owners: ["A", "B"] },
    );
    const ids = (c: Combatant): string[] => statusSummary(c).map((m) => m.id);
    expect(ids(st.teams[1][0]!)).toContain("multiply-enemies-reach");
    expect(ids(st.teams[0][0]!)).toContain("multiply-allies-reach");
    expect(ids(st.teams[0][1]!)).not.toContain("multiply-allies-reach");
    expect(ids(st.teams[0][1]!)).toContain("multiply-allies");
  });

  it("stacks its reach sigil once for each Scoba reaching it", () => {
    const st = startBattle(
      "poki-twins",
      [{ ...wild("poki", 30, "A") }, { ...wild("poki", 30), owner: "B" }],
      [wild("pieble", 30), wild("pieble", 30)],
      { slots: 2, owners: ["A", "B"] },
    );
    const reach = (c: Combatant, id: string) => statusSummary(c).find((m) => m.id === id);
    expect(reach(st.teams[1][0]!, "multiply-enemies-reach")?.stacks).toBe(2);
    // Each Poki is reached by the other one and never by itself.
    expect(reach(st.teams[0][0]!, "multiply-allies-reach")?.stacks).toBe(1);
  });

  it("deals more per tick from a status that has been made stronger", () => {
    const lost = (multiplied: boolean): number => {
      const st = duel();
      leave(st, "seared", 60);
      if (multiplied) leave(st, "multiplied", 0);
      const hp = foe(st).hp;
      resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }, brace]);
      return hp - foe(st).hp;
    };
    expect(lost(true)).toBeGreaterThan(lost(false) * 1.4);
  });
});
