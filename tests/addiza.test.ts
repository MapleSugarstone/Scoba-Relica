import { describe, expect, it } from "vitest";
import {
  FUSION_SLOT, combatantMaxHp, combatantStats, resolveTurn, startBattle,
  type BattleEvent, type BattleState, type Choice, type Combatant,
} from "../src/sim/battle";
import { stacksOf } from "../src/sim/status";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const wild = (id: string, lv: number, owner?: "A" | "B"): ScobaInstance => ({
  ...makeWild(id, lv, rngFrom(`${id}:${lv}:${owner ?? "-"}`)),
  ...(owner ? { owner } : {}),
});

/** Addiza for A and a Plib for B, against two sturdy wilds. */
function pair(ally = "pieble"): BattleState {
  const st = startBattle(
    "addiza",
    [wild("addiza", 30, "A"), wild(ally, 30, "B")],
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

/** The HP each event left on whoever it struck, by team index on side 1. */
const struck = (events: BattleEvent[]): number[] =>
  events.filter((e) => e.kind === "hit" && e.at?.side === 1).map((e) => e.at!.index);

describe("Addiza", () => {
  it("bounces Moon Ball onto the other enemy Scoba", () => {
    const st = pair();
    const events = resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "moon-ball", picks: [{ side: 1, index: 0 }] },
      { kind: "block", side: 0, slot: 1 }, ...brace,
    ]);
    expect(struck(events)).toEqual([0, 1]);
  });

  it("bounces Moon Ball back onto the same Scoba when it stands alone", () => {
    const st = startBattle("addiza", [wild("addiza", 30, "A")], [wild("obera", 30)], { slots: 1 });
    st.teams[0][0]!.mana = 100;
    const events = resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "moon-ball", picks: [{ side: 1, index: 0 }] },
      { kind: "block", side: 1, slot: 0 },
    ]);
    expect(struck(events)).toEqual([0, 0]);
  });

  it("heals the other ally Scoba whenever it casts, and itself where there is none", () => {
    const st = pair();
    const plib = st.teams[0][1]!;
    plib.hp = 1;
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "moon-blast", picks: [{ side: 1, index: 0 }] },
      { kind: "block", side: 0, slot: 1 }, ...brace,
    ]);
    expect(plib.hp).toBeGreaterThan(1);

    const solo = startBattle("addiza", [wild("addiza", 30, "A")], [wild("obera", 30)], { slots: 1 });
    const me = solo.teams[0][0]!;
    me.mana = 100;
    me.hp = 1;
    resolveTurn(solo, [
      { kind: "spell", side: 0, slot: 0, moveId: "moon-blast", picks: [{ side: 1, index: 0 }] },
      { kind: "block", side: 1, slot: 0 },
    ]);
    expect(me.hp).toBeGreaterThan(1);
  });

  it("adds a level's worth of HP to every heal an ally receives while Addiza stands", () => {
    const heal = (withSum: boolean): number => {
      const st = pair();
      const addiza = st.teams[0][0]!;
      if (!withSum) addiza.statuses = addiza.statuses.filter((s) => s.id !== "sum");
      const plib = st.teams[0][1]!;
      plib.hp = 1;
      resolveTurn(st, [
        { kind: "spell", side: 0, slot: 0, moveId: "add-everyone", picks: [null] },
        { kind: "block", side: 0, slot: 1 }, ...brace,
      ]);
      return plib.hp;
    };
    // Add Everyone and Add's own heal both land on Plib, each 30 more at level 30.
    expect(heal(true) - heal(false)).toBe(60);
  });

  it("doubles its magic for 4 turns with Meditation", () => {
    const st = pair();
    const addiza = st.teams[0][0]!;
    const before = combatantStats(addiza).mag;
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "meditation", picks: [null] },
      { kind: "block", side: 0, slot: 1 }, ...brace,
    ]);
    expect(combatantStats(addiza).mag).toBeGreaterThanOrEqual(before * 2 - 1);
    expect(addiza.statuses.find((s) => s.id === "meditating")?.turnsLeft).toBe(4);
  });

  it("turns the basic attack into a Moon Shot in Hyper-Mode, still a basic attack", () => {
    const st = pair();
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, { kind: "block", side: 0, slot: 1 }, ...brace]);
    const events = resolveTurn(st, [
      { kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] },
      { kind: "block", side: 0, slot: 1 }, ...brace,
    ]);
    const hit = events.find((e) => e.kind === "hit" && e.at?.side === 1);
    expect(hit?.moveId).toBe("moon-shot");
    expect(stacksOf(st.teams[0][0]!.statuses, "ultimate-addition")).toBe(1);
  });

  it("fuses with Poki through the two marks, whichever goes Hyper first", () => {
    for (const first of [0, 1] as const) {
      const st = pair("poki");
      const other = first === 0 ? 1 : 0;
      resolveTurn(st, [{ kind: "hyper", side: 0, slot: first }, { kind: "block", side: 0, slot: other }, ...brace]);
      expect(st.active[0][FUSION_SLOT]).toBe(-1);
      st.teams[0][other]!.mana = 100;
      resolveTurn(st, [{ kind: "hyper", side: 0, slot: other }, { kind: "block", side: 0, slot: first }, ...brace]);
      const body = st.teams[0][st.active[0][FUSION_SLOT]!] as Combatant | undefined;
      expect(body?.scoba.speciesId).toBe("equalizea");
      expect(combatantMaxHp(body!)).toBeGreaterThan(0);
    }
  });
});
