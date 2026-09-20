import { describe, expect, it } from "vitest";
import {
  MANA_PER_TURN, START_MANA, combatantMaxHp, resolveTurn, startBattle, statusSummary,
  type BattleState, type Choice, type Combatant,
} from "../src/sim/battle";
import { MOVES, SPECIES } from "../src/sim/species";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { statTotal } from "../src/sim/types";

const wild = (id: string, lv = 30, seed = id): ScobaInstance => makeWild(id, lv, rngFrom(seed));

/** Obera and a Plib against one sturdy wild, with a bench to switch to. */
function field(): BattleState {
  const st = startBattle(
    "obera",
    [wild("obera"), wild("plib"), wild("pieble")],
    [wild("pieble", 30, "foe")],
    { slots: 2 },
  );
  for (const c of st.teams[0]) c.mana = 100;
  return st;
}

const obera = (st: BattleState): Combatant => st.teams[0][0]!;
const foe = (st: BattleState): Combatant => st.teams[1][0]!;
const brace: Choice = { kind: "block", side: 1, slot: 0 };
const hold = (slot: number): Choice => ({ kind: "block", side: 0, slot });
const FOE = { side: 1 as const, index: 0 };

describe("the Obera line", () => {
  it("hatches as Faelae and grows into Obera", () => {
    const baby = SPECIES["faelae"]!;
    expect(baby.baby).toBe(true);
    expect(baby.evolvesTo).toBe("obera");
    expect(baby.starter).toBe(true);
    expect(statTotal(baby.genes)).toBe(300);
    expect(statTotal(SPECIES["obera"]!.genes)).toBe(500);
    // Both forms are Spring, and neither leans on Strength.
    expect(SPECIES["obera"]!.type).toBe("spring");
    expect(SPECIES["obera"]!.genes.str).toBe(0);
  });

  it("costs what the kit says", () => {
    expect(["mote", "faefire", "innervate", "fairy-bomb"].map((id) => MOVES[id]!.manaCost))
      .toEqual([10, 20, 50, 80]);
    expect(MOVES["faefire"]!.cooldown).toBe(3);
    expect(MOVES["innervate"]!.cooldown).toBe(3);
    expect(MOVES["mote"]!.type).toBe("spring");
    expect(MOVES["faefire"]!.type2).toBe("firework");
  });
});

describe("Grove", () => {
  it("grows on every ally Scoba's mark as Obera takes the field", () => {
    const st = field();
    expect(st.ground.map((p) => `${p.side}.${p.slot}:${p.status.id}`).sort())
      .toEqual(["0.0:grove-patch", "0.1:grove-patch"]);
    // Planted rather than carried: neither Scoba holds it.
    expect(obera(st).statuses.map((s) => s.id)).not.toContain("grove-patch");
  });

  it("heals whoever is standing on it at the end of each turn", () => {
    const st = field();
    const ally = st.teams[0][1]!;
    ally.hp = 10;
    resolveTurn(st, [hold(0), hold(1), brace]);
    expect(ally.hp).toBeGreaterThan(10);
  });

  it("stays on the mark when the Scoba standing on it leaves, and heals the one that comes in", () => {
    const st = field();
    const bench = st.teams[0][2]!;
    bench.hp = 10;
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 1, benchIndex: 2 }, hold(0), brace]);
    expect(st.ground).toHaveLength(2);
    expect(bench.hp).toBeGreaterThan(10);
  });

  it("stands for five turns and then fades", () => {
    const st = field();
    for (let i = 0; i < 5; i++) resolveTurn(st, [hold(0), hold(1), brace]);
    expect(st.ground).toEqual([]);
  });

  it("is read off the mark as a sigil rather than off the Scoba", () => {
    const st = field();
    expect(statusSummary(obera(st)).map((m) => m.id)).not.toContain("grove-patch");
  });
});

describe("Faefire", () => {
  it("takes mana off every enemy and leaves them taking more damage", () => {
    const st = field();
    foe(st).mana = 40;
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "faefire", picks: [null] },
      hold(1),
      brace,
    ]);
    expect(foe(st).mana).toBe(40 - 5 + 20);
    expect(foe(st).statuses.map((s) => s.id)).toContain("faefire");
  });
});

describe("Faeblade", () => {
  it("adds Spring magic to a basic attack and saps the enemy's mana", () => {
    const plain = field();
    const lit = field();
    // Faeblade is the line's only second passive, so the plain one has it taken off.
    plain.teams[0][0]!.statuses = plain.teams[0][0]!.statuses.filter((s) => s.id !== "faeblade");
    const swing = (st: BattleState): number => {
      foe(st).mana = 50;
      const before = foe(st).hp;
      resolveTurn(st, [{ kind: "attack", side: 0, slot: 0, picks: [FOE] }, hold(1), brace]);
      return before - foe(st).hp;
    };
    const bladed = swing(lit);
    expect(bladed).toBeGreaterThan(swing(plain));
    // The turn hands 20 mana back, so 5 off reads as 15 up.
    expect(foe(lit).mana).toBe(50 - 5 + 20);
  });
});

describe("Fae Court", () => {
  it("calls up two Retainers at half its level in Hyper-Mode", () => {
    const st = field();
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, hold(1), brace]);
    const court = st.teams[0].filter((c) => c.scoba.speciesId === "fae-retainer");
    expect(court).toHaveLength(2);
    for (const one of court) {
      expect(one.scoba.level).toBe(15);
      expect(one.pawn).toBe(true);
      // Its Obera's second passive and nothing else it carries: no Grove of
      // its own, no statuses off the Scoba that called it, and its own moves.
      expect(one.scoba.secondaryAbility).toBe("faeblade");
      expect(one.statuses.map((s) => s.id)).toContain("faeblade");
      expect(one.statuses.map((s) => s.id)).not.toContain("grove");
      expect(one.statuses.map((s) => s.id)).not.toContain("fae-court");
      expect(one.scoba.moves).toEqual(["stab", "rally", "rotten-slice", "groveborn-eviscerate"]);
      expect(combatantMaxHp(one)).toBeGreaterThan(0);
      // It fights its first turn on the mana it arrived with, not that and the turn's.
      expect(one.mana).toBe(START_MANA);
    }
    resolveTurn(st, [hold(0), hold(1), ...court.map((c): Choice => ({ kind: "block", side: 0, slot: st.active[0].indexOf(st.teams[0].indexOf(c)) })), brace]);
    for (const one of court) expect(one.mana).toBe(START_MANA + MANA_PER_TURN);
  });
});
