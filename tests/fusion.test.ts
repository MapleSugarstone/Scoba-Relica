import { describe, expect, it } from "vitest";
import {
  FUSION_SHARE, FUSION_SLOT, castCost, choiceError, combatantMaxHp, emptySlots, formsOf, fusionBars, hyperBonus,
  resolveTurn, slotsAwaitingChoice, startBattle, stateHash, statusSummary,
  type BattleState, type Choice, type Combatant,
} from "../src/sim/battle";
import { pieceWorn } from "../src/game/critters";
import { SPECIES } from "../src/sim/species";
import { makeWild, scobaTypes, statsAt, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { STAT_NAMES, type Stats } from "../src/sim/types";

const wild = (id: string, lv: number, owner?: "A" | "B"): ScobaInstance => ({
  ...makeWild(id, lv, rngFrom(`${id}:${lv}:${owner ?? "-"}`)),
  ...(owner ? { owner } : {}),
});

/**
 * Addiza for character A and Poki for character B, each with a Scoba on the
 * bench, against two sturdy wilds, every bar full.
 */
function field(): BattleState {
  const st = startBattle(
    "fusion",
    [wild("addiza", 12, "A"), wild("poki", 12, "B"), wild("plib", 12, "A"), wild("plib", 12, "B")],
    [wild("obera", 30), wild("obera", 30)],
    { slots: 2, owners: ["A", "B"] },
  );
  for (const c of st.teams[0]) c.mana = 100;
  return st;
}

const brace: Choice[] = [
  { kind: "block", side: 1, slot: 0 },
  { kind: "block", side: 1, slot: 1 },
];

/** Both halves go Hyper in one round, which is what fuses them. */
function fused(): BattleState {
  const st = field();
  resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, { kind: "hyper", side: 0, slot: 1 }, ...brace]);
  return st;
}

const body = (st: BattleState): Combatant => st.teams[0][st.active[0][FUSION_SLOT]!]!;

/** A Scoba's own line with its Hyper-Mode in it, the way the test expects it pooled. */
const hyperLine = (s: ScobaInstance): Stats => {
  const own = statsAt(s, false);
  const bonus = hyperBonus(statsAt(s, true));
  const out = {} as Stats;
  for (const name of STAT_NAMES) out[name] = own[name] + bonus[name];
  return out;
};

describe("fusion", () => {
  it("forms once both are in Hyper-Mode on the field, and not before", () => {
    const st = field();
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, { kind: "block", side: 0, slot: 1 }, ...brace]);
    expect(st.active[0][FUSION_SLOT]).toBe(-1);
    st.teams[0][1]!.mana = 100;
    const events = resolveTurn(st, [
      { kind: "block", side: 0, slot: 0 }, { kind: "hyper", side: 0, slot: 1 }, ...brace,
    ]);
    expect(events.some((e) => e.kind === "fuse")).toBe(true);
    const f = body(st);
    expect(f.scoba.speciesId).toBe("equalizea");
    expect(st.teams[0][0]!.fusedInto).toBe(st.active[0][FUSION_SLOT]);
    expect(st.teams[0][1]!.fusedInto).toBe(st.active[0][FUSION_SLOT]);
  });

  it("adds the levels, joins the types and cuts the pooled stats to three quarters", () => {
    const st = field();
    const [a, b] = [st.teams[0][0]!.scoba, st.teams[0][1]!.scoba];
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, { kind: "hyper", side: 0, slot: 1 }, ...brace]);
    const f = body(st);
    expect(f.scoba.level).toBe(a.level + b.level);
    expect(scobaTypes(f.scoba)).toEqual(["moon", "sun"]);
    const [la, lb] = [hyperLine(a), hyperLine(b)];
    for (const name of ["str", "def", "res", "mag"] as const) {
      expect(f.fusion!.line[name]).toBe(Math.floor(FUSION_SHARE * (la[name] + lb[name])));
    }
    // Each half keeps its own Speed rather than a pooled one.
    expect(f.fusion!.spd).toEqual([la.spd, lb.spd]);
  });

  it("carries both halves' passives and its own", () => {
    const st = fused();
    const ids = body(st).statuses.map((s) => s.id);
    for (const id of ["add", "moon-cannon", "multiply-enemies", "flame-blade", "twin-mana"]) expect(ids).toContain(id);
    expect(ids).not.toContain("hyper");
    expect(st.teams[0][0]!.statuses).toEqual([]);
  });

  it("carries a half's Cherry on Top, sigil and cherry, until the cherry is thrown", () => {
    const poki = { ...wild("poki", 12, "B"), secondaryAbility: "cherry-on-top" };
    const st = startBattle(
      "fusion",
      [wild("addiza", 12, "A"), poki, wild("plib", 12, "A"), wild("plib", 12, "B")],
      [wild("obera", 30), wild("obera", 30)],
      { slots: 2, owners: ["A", "B"] },
    );
    for (const c of st.teams[0]) c.mana = 100;
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, { kind: "hyper", side: 0, slot: 1 }, ...brace]);
    const f = body(st);
    const worn = (): string | null => pieceWorn(SPECIES["equalizea"]!, f.statuses.map((s) => s.id), formsOf(f));
    expect(statusSummary(f).map((m) => m.id)).toContain("cherry-on-top");
    expect(worn()).toBe("cherry");
    const foe = { side: 1 as const, index: 0 };
    resolveTurn(st, [
      { kind: "attack", side: 0, slot: 0, picks: [foe] },
      { kind: "spell", side: 0, slot: 1, moveId: "cherry-on-top", picks: [foe] },
      ...brace,
    ]);
    expect(f.statuses.map((s) => s.id)).not.toContain("cherry-on-top");
    expect(worn()).toBeNull();
  });

  it("drops the two marks it fused on, and its own entry does not give them back", () => {
    const st = field();
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, { kind: "block", side: 0, slot: 1 }, ...brace]);
    expect(st.teams[0][0]!.statuses.map((s) => s.id)).toContain("ultimate-addition");
    st.teams[0][1]!.mana = 100;
    resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }, { kind: "hyper", side: 0, slot: 1 }, ...brace]);
    const ids = body(st).statuses.map((s) => s.id);
    expect(ids).not.toContain("ultimate-addition");
    expect(ids).not.toContain("ultimate-multiplication");
  });

  it("asks each half for a move from its own set, and never the fusion's mark", () => {
    const st = fused();
    expect(slotsAwaitingChoice(st, 0)).toEqual([0, 1]);
    const foe = { side: 1 as const, index: 0 };
    const [a, b] = [st.teams[0][0]!, st.teams[0][1]!];
    expect(choiceError(st, { kind: "spell", side: 0, slot: 0, moveId: "moon-blast", picks: [foe] })).toBeNull();
    expect(choiceError(st, { kind: "spell", side: 0, slot: 1, moveId: "moon-blast", picks: [foe] })).not.toBeNull();
    a.mana = 60;
    b.mana = 60;
    const [costA, costB] = [castCost(a, "moon-blast"), castCost(b, "fire-scratch")];
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "moon-blast", picks: [foe] },
      { kind: "spell", side: 0, slot: 1, moveId: "fire-scratch", picks: [foe] },
      ...brace,
    ]);
    // Each paid from its own bar, and each bar took its own 20 back at the end.
    expect([a.mana, b.mana]).toEqual([60 - costA + 20, 60 - costB + 20]);
  });

  it("cannot block or be switched out, and nobody else can come in", () => {
    const st = fused();
    expect(choiceError(st, { kind: "block", side: 0, slot: 0 })).not.toBeNull();
    expect(choiceError(st, { kind: "switch", side: 0, slot: 0, benchIndex: 2 })).not.toBeNull();
    expect(emptySlots(st, 0)).toEqual([]);
  });

  it("fills each mana bar by 20 a turn, the second through its passive", () => {
    const st = fused();
    const [a, b] = [st.teams[0][0]!, st.teams[0][1]!];
    a.mana = 0;
    b.mana = 0;
    const foe = { side: 1 as const, index: 0 };
    resolveTurn(st, [
      { kind: "attack", side: 0, slot: 0, picks: [foe] },
      { kind: "attack", side: 0, slot: 1, picks: [foe] },
      ...brace,
    ]);
    expect([a.mana, b.mana]).toEqual([20, 20]);
  });

  it("takes the first slot's bar first, and a hit that empties it goes no further", () => {
    const st = fused();
    const f = body(st);
    const secondFull = fusionBars(f)![1]!.max;
    f.hp = 1;
    const at = { side: 0 as const, index: st.active[0][FUSION_SLOT]! };
    resolveTurn(st, [
      { kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] },
      { kind: "attack", side: 0, slot: 1, picks: [{ side: 1, index: 0 }] },
      { kind: "attack", side: 1, slot: 0, picks: [at] },
      { kind: "block", side: 1, slot: 1 },
    ]);
    const bars = fusionBars(f)!;
    expect(f.fainted).toBe(false);
    expect(bars[0]!.hp).toBe(0);
    expect(bars[1]!.hp).toBe(secondFull);
    expect(combatantMaxHp(f)).toBe(secondFull);
  });

  it("falls with both halves when the second bar empties, and frees both marks", () => {
    const st = fused();
    const f = body(st);
    const at = { side: 0 as const, index: st.active[0][FUSION_SLOT]! };
    const hit: Choice[] = [
      { kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] },
      { kind: "attack", side: 0, slot: 1, picks: [{ side: 1, index: 0 }] },
      { kind: "attack", side: 1, slot: 0, picks: [at] },
      { kind: "attack", side: 1, slot: 1, picks: [at] },
    ];
    f.hp = 1;
    resolveTurn(st, hit);
    f.hp = 1;
    resolveTurn(st, hit);
    expect(f.fainted).toBe(true);
    expect(st.teams[0][0]!.fainted).toBe(true);
    expect(st.teams[0][1]!.fainted).toBe(true);
    expect(st.active[0][FUSION_SLOT]).toBe(-1);
    expect(emptySlots(st, 0)).toEqual([0, 1]);
  });

  it("comes out the same on two clients", () => {
    const one = fused();
    const two = fused();
    expect(stateHash(one)).toBe(stateHash(two));
  });
});
