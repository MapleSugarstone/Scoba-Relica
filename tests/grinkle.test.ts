import { describe, expect, it } from "vitest";
import {
  choiceError, combatantMaxHp, combatantStats, displayName, landingLine, previewMove, resolveTurn, startBattle,
  statusSummary, type BattleEvent, type BattleState, type Choice, type Combatant,
} from "../src/sim/battle";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { stacksOf } from "../src/sim/status";
import { sigilText } from "../src/ui/sigil";
import { rngFrom } from "../src/sim/rng";
import { STAT_NAMES } from "../src/sim/types";

const wild = (id: string, lv: number): ScobaInstance => makeWild(id, lv, rngFrom(`${id}:${lv}`));

/** A level 30 Grinkle Pylon against a sturdy wild that only ever blocks. */
function field(pylon: ScobaInstance = wild("grinkle-pylon", 30)): BattleState {
  return startBattle("grinkle", [pylon], [wild("obera", 30)], { slots: 1 });
}

const brace: Choice = { kind: "block", side: 1, slot: 0 };
const spawn: Choice = { kind: "attack", side: 0, slot: 0, picks: [null] };
const pylonOf = (st: BattleState): Combatant => st.teams[0][0]!;
const grinklings = (st: BattleState): Combatant[] => st.teams[0].filter((c) => c.pawn && !c.fainted);

describe("Grinkle Pylon", () => {
  it("cannot cast its own abilities", () => {
    const st = field();
    pylonOf(st).mana = 100;
    const foe = { side: 1 as const, index: 0 };
    expect(choiceError(st, { kind: "spell", side: 0, slot: 0, moveId: "plonk", picks: [foe] })).toMatch(/Pylon/);
    expect(choiceError(st, spawn)).toBeNull();
  });

  it("spawns a Grinkling at 60% of its level with its moves and statuses, for 30% of its max HP", () => {
    const st = field();
    const pylon = pylonOf(st);
    const max = combatantMaxHp(pylon);
    resolveTurn(st, [spawn, brace]);
    const [g] = grinklings(st);
    expect(g?.scoba.speciesId).toBe("grinkling");
    expect(g!.scoba.level).toBe(18);
    expect(g!.scoba.moves).toEqual(pylon.scoba.moves);
    const held = g!.statuses.map((s) => s.id);
    expect(held).toContain("power-grid");
    expect(held).not.toContain("pylon");
    expect(pylon.hp).toBe(max - Math.floor(max * 0.3));
    // Answers to its owner, so the player picks what it does.
    expect(choiceError(st, { kind: "spell", side: 0, slot: 2, moveId: "silly-dance", picks: [null] })).toBeNull();
  });

  it("spawns nothing and loses nothing once every Pawn mark is full", () => {
    const st = field();
    for (let i = 0; i < 3; i++) resolveTurn(st, [spawn, brace]);
    expect(grinklings(st)).toHaveLength(3);
    const before = pylonOf(st).hp;
    resolveTurn(st, [spawn, brace]);
    expect(grinklings(st)).toHaveLength(3);
    expect(pylonOf(st).hp).toBe(before);
  });

  it("spawns two at once in Hyper-Mode, for the one 30%", () => {
    const st = field();
    const pylon = pylonOf(st);
    pylon.mana = 100;
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, brace]);
    const before = pylon.hp;
    const max = combatantMaxHp(pylon);
    resolveTurn(st, [spawn, brace]);
    const spawned = grinklings(st);
    expect(spawned).toHaveLength(2);
    expect(pylon.hp).toBe(before - Math.floor(max * 0.3));
    // Hyper-Mode and its passive stay with the Pylon.
    for (const g of spawned) {
      expect(g.statuses.map((s) => s.id)).not.toContain("hyper");
      expect(g.statuses.map((s) => s.id)).not.toContain("double-spawn");
    }
  });

  it("hands its bred lean on to what it spawns", () => {
    // Bred toward Strength and Speed, the way a Poki father would lean it.
    const bred = { ...wild("grinkle-pylon", 30), genes: { hp: 198, str: 42, def: 20, res: 20, mag: 0, spd: 21 } };
    const st = field(bred);
    resolveTurn(st, [spawn, brace]);
    const [g] = grinklings(st);
    expect(g!.scoba.genes.str).toBeGreaterThan(80);
    expect(g!.scoba.genes.spd).toBeGreaterThan(80);
    expect(g!.scoba.genes.hp).toBeLessThan(80);
    const pure = field();
    resolveTurn(pure, [spawn, brace]);
    const [plain] = grinklings(pure);
    for (const name of STAT_NAMES) expect(plain!.scoba.genes[name]).toBe(80);
  });

  it("charges its ally Pawns every turn, up to 30", () => {
    const st = field();
    resolveTurn(st, [spawn, brace]);
    const [g] = grinklings(st);
    expect(stacksOf(g!.statuses, "charged")).toBeGreaterThan(0);
    expect(statusSummary(g!).map((m) => m.id)).toContain("charged");
    for (let i = 0; i < 20; i++) resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }, { kind: "block", side: 0, slot: 2 }, brace]);
    expect(stacksOf(g!.statuses, "charged")).toBe(30);
    // 1 to every stat a stack at the ceiling, scaled by the level of whoever
    // charged it: the Pylon at the ceiling, or the Grinkling at 60% of it.
    const mark = statusSummary(g!).find((m) => m.id === "charged");
    const measured = g!.statuses.filter((s) => s.id === "charged").reduce((sum, s) => sum + (s.power ?? 0) * s.stacks, 0);
    expect(mark?.shift?.stats).toHaveLength(6);
    expect(mark?.shift?.amount).toBeCloseTo(measured, 5);
    expect(measured).toBeGreaterThan(18);
    expect(measured).toBeLessThanOrEqual(30);
    // The window names the total, and hovering it shows the stacks behind it.
    const said = sigilText(mark!);
    expect(said.desc).toMatch(/^Increases all stats by \d+\.$/);
    const number = said.said.find((p) => p.work)!;
    expect(number.work!.at(-1)).toEqual({ label: "Total", value: number.text });
  });

  it("charges a whole court in one run of landings, read as one line", () => {
    const st = field();
    for (let i = 0; i < 3; i++) resolveTurn(st, [spawn, brace]);
    const events = resolveTurn(st, [
      { kind: "block", side: 0, slot: 0 },
      ...[2, 3, 4].map((slot): Choice => ({ kind: "block", side: 0, slot })),
      brace,
    ]);
    const charged = events.map((e, i) => (e.status === "charged" && e.stacks !== undefined ? i : -1)).filter((i) => i >= 0);
    // The Pylon and all three Grinklings charge all three: twelve landings, back to back.
    expect(charged).toHaveLength(12);
    expect(charged[charged.length - 1]! - charged[0]!).toBe(11);
    const line = landingLine(charged.map((i) => events[i]!), (ref) => displayName(st.teams[ref.side][ref.index]!.scoba));
    // They arrived on different turns and carry different counts, so none is given.
    expect(line).toBe("All 3 Grinklings are Charged.");
  });
});

describe("landings read as one line", () => {
  const land = (index: number, stacks: number): BattleEvent => ({
    text: "", kind: "status", at: { side: 0, index }, status: "charged", stacks,
  });
  const names = ["Grinkle Pylon", "Grinkling", "Grinkling", "Poki"];
  const nameOf = (ref: { index: number }): string => names[ref.index] ?? "";

  it("names one Scoba landed on again and again once, with where it ended up", () => {
    expect(landingLine([land(1, 1), land(1, 2), land(1, 3)], nameOf)).toBe("Grinkling is Charged x3.");
  });

  it("counts Scobas of one name, and lists Scobas of different names", () => {
    expect(landingLine([land(1, 2), land(2, 2)], nameOf)).toBe("Both Grinklings are Charged x2.");
    expect(landingLine([land(1, 2), land(3, 1)], nameOf)).toBe("Grinkling and Poki are Charged.");
  });
});

describe("the Grinkling's moves", () => {
  function withGrinkling(): { st: BattleState; g: Combatant } {
    const st = field();
    resolveTurn(st, [spawn, brace]);
    return { st, g: grinklings(st)[0]! };
  }

  it("lands Plonk as physical against Defense and magic against Resistance", () => {
    const { st } = withGrinkling();
    const at = { side: 0 as const, index: st.teams[0].length - 1 };
    const foe = st.teams[1][0]!;
    const target = { side: 1 as const, index: 0 };
    const base = previewMove(st, at, "plonk", target)!.damage!;
    foe.scoba.genes = { ...foe.scoba.genes, def: foe.scoba.genes.def + 200 };
    const walled = previewMove(st, at, "plonk", target)!.damage!;
    foe.scoba.genes = { ...foe.scoba.genes, def: foe.scoba.genes.def - 200, res: foe.scoba.genes.res + 200 };
    const warded = previewMove(st, at, "plonk", target)!.damage!;
    expect(walled).toBeLessThan(base);
    expect(warded).toBeLessThan(base);
  });

  it("raises its Speed with Silly Dance, up to 3 stacks", () => {
    const { st, g } = withGrinkling();
    const before = combatantStats(g).spd;
    for (let i = 0; i < 4; i++) {
      g.mana = 100;
      resolveTurn(st, [
        { kind: "block", side: 0, slot: 0 },
        { kind: "spell", side: 0, slot: 2, moveId: "silly-dance", picks: [null] },
        brace,
      ]);
    }
    expect(stacksOf(g.statuses, "dancing")).toBe(3);
    expect(combatantStats(g).spd).toBeGreaterThan(before);
  });

  it("doubles every stat with Mass and keeps its share of HP", () => {
    const { st, g } = withGrinkling();
    g.mana = 100;
    const before = combatantStats(g);
    const share = g.hp / combatantMaxHp(g);
    resolveTurn(st, [
      { kind: "block", side: 0, slot: 0 },
      { kind: "spell", side: 0, slot: 2, moveId: "mass", picks: [null] },
      brace,
    ]);
    const after = combatantStats(g);
    expect(after.str).toBeGreaterThanOrEqual(before.str * 2 - 1);
    expect(g.hp / combatantMaxHp(g)).toBeCloseTo(share, 1);
  });
});
