import { describe, expect, it } from "vitest";
import {
  startBattle,
  resolveTurn,
  benchFor,
  choiceError,
  combatantMaxHp,
  combatantStats,
  emptySlots,
  selfRunning,
  slotsAwaitingChoice,
  type BattleState,
  type Combatant,
} from "../src/sim/battle";
import { PAWN_SLOTS, SCOBA_SLOTS, candidates, isPawnSlot } from "../src/sim/targeting";
import { pawnChoices } from "../src/sim/ai";
import { stacksOf } from "../src/sim/status";
import { makeWild, passiveStatuses, type ScobaInstance } from "../src/sim/scoba";
import { SPECIES, rosterSpecies } from "../src/sim/species";
import { canBreed, sharedSwaps } from "../src/sim/breeding";
import { rngFrom } from "../src/sim/rng";

const wild = (species: string, level: number, seed: string) => makeWild(species, level, rngFrom(seed));
const owned = (s: ScobaInstance, owner: "A" | "B"): ScobaInstance => ({ ...s, owner });

/** The first Pawn mark, which is where a queen's first Cottlecorn lands. */
const FIRST_PAWN = SCOBA_SLOTS;

/**
 * A queen out with a spare behind her against one enemy, which is the smallest
 * fight that has both a bench and a court in it.
 */
function court(opts: { level?: number; enemy?: number; dress?: (q: ScobaInstance) => void } = {}): BattleState {
  const level = opts.level ?? 20;
  const queen = owned(wild("cottlequeen", level, "queen"), "A");
  opts.dress?.(queen);
  return startBattle(
    "court",
    [queen, owned(wild("plib", level, "spare"), "A")],
    [wild("plib", opts.enemy ?? level, "foe")],
    { slots: 1, owners: ["A", null] },
  );
}

const pawnAt = (st: BattleState, slot: number): Combatant | null => {
  const idx = st.active[0][slot] ?? -1;
  return idx >= 0 ? st.teams[0][idx] ?? null : null;
};

const pawnsOut = (st: BattleState, side: 0 | 1): number =>
  st.teams[side].filter((c) => c.pawn && !c.fainted).length;

describe("calling a Pawn", () => {
  it("brings one out with the queen, on a mark of its own", () => {
    const st = court();
    const pawn = pawnAt(st, FIRST_PAWN);
    expect(pawn?.scoba.speciesId).toBe("cottlecorn");
    expect(pawn?.pawn).toBe(true);
    expect(isPawnSlot(FIRST_PAWN)).toBe(true);
  });

  it("says so on the opening, so the scene has a call to play", () => {
    const st = court();
    const called = st.opening.filter((e) => e.kind === "summon");
    expect(called).toHaveLength(1);
    expect(called[0]!.at).toEqual({ side: 0, index: 2 });
    expect(called[0]!.by).toEqual({ side: 0, index: 0 });
  });

  it("comes out at whoever called it, and answers to them", () => {
    const st = court({ level: 12 });
    const pawn = pawnAt(st, FIRST_PAWN)!;
    expect(pawn.scoba.level).toBe(12);
    expect(pawn.scoba.owner).toBe("A");
  });

  it("only ever the once, however many times she takes the field", () => {
    const st = court();
    expect(pawnsOut(st, 0)).toBe(1);
    // Out and back in again: the passive has spent its charge for the battle.
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 0 }]);
    expect(pawnsOut(st, 0)).toBe(1);
  });

  it("keeps calling until the marks run out, and then says so", () => {
    const st = court();
    const queen = st.teams[0][0]!;
    for (let i = 0; i < PAWN_SLOTS + 1; i++) {
      queen.mana = 100;
      queen.cds = {};
      resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "court-call", picks: [null] }]);
    }
    expect(pawnsOut(st, 0)).toBe(PAWN_SLOTS);
  });
});

describe("what a Pawn is on the field", () => {
  it("can be aimed at by an ally and swept up by the enemy line", () => {
    const st = court();
    const ref = { side: 0 as const, index: 2 };
    expect(candidates(st, { side: 0, index: 0 }, "any-ally")).toContainEqual(ref);
    expect(candidates(st, { side: 1, index: 0 }, "enemy-team")).toContainEqual(ref);
    expect(candidates(st, { side: 1, index: 0 }, "random-enemy")).toContainEqual(ref);
  });

  it("is on nobody's bench and cannot be sent out", () => {
    const st = court();
    expect(benchFor(st, 0, 0)).toEqual([1]);
    expect(choiceError(st, { kind: "switch", side: 0, slot: 0, benchIndex: 2 }))
      .toBe("A Pawn cannot be sent out.");
  });

  it("cannot be called back off its own mark", () => {
    const st = court();
    expect(benchFor(st, 0, FIRST_PAWN)).toEqual([]);
    expect(choiceError(st, { kind: "switch", side: 0, slot: FIRST_PAWN, benchIndex: 1 }))
      .toBe("A Pawn cannot be called back.");
  });

  it("leaves an empty mark behind it, with nothing waiting to fill it", () => {
    const st = court();
    st.teams[0][2]!.fainted = true;
    st.active[0][FIRST_PAWN] = -1;
    expect(emptySlots(st, 0)).toEqual([]);
  });

  it("takes a turn like anything else standing there", () => {
    const st = court();
    expect(slotsAwaitingChoice(st, 0)).toEqual([0, FIRST_PAWN]);
  });

  it("draws on the same mana bar, so it can save for a spell that costs it all", () => {
    const st = court();
    const pawn = pawnAt(st, FIRST_PAWN)!;
    const before = pawn.mana;
    resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    expect(pawn.mana).toBeGreaterThan(before);
  });

  it("does not hold a side up once its summoner is gone", () => {
    const queen = owned(wild("cottlequeen", 4, "alone"), "A");
    const st = startBattle("wipe", [queen], [wild("plib", 20, "foe")], {
      slots: 1, owners: ["A", null],
    });
    expect(pawnsOut(st, 0)).toBe(1);
    st.teams[0][0]!.hp = 1;
    resolveTurn(st, [{ kind: "attack", side: 1, slot: 0, picks: [{ side: 0, index: 0 }] }]);
    expect(st.teams[0][0]!.fainted).toBe(true);
    expect(pawnsOut(st, 0)).toBe(1);
    expect(st.winner).toBe(1);
  });
});

describe("a Pawn nobody controls", () => {
  it("is the one the AI picks for, and the Scobas are not", () => {
    const st = court();
    expect(selfRunning(st.teams[0][2]!)).toBe(true);
    expect(selfRunning(st.teams[0][0]!)).toBe(false);
    const picks = pawnChoices(st, 0);
    expect(picks).toHaveLength(1);
    expect(picks[0]!.slot).toBe(FIRST_PAWN);
    expect(picks[0]!.side).toBe(0);
  });

  it("holds its mana back until it can afford the whole-bar spell, then spends it", () => {
    const st = court({ enemy: 20 });
    const foe = st.teams[1][0]!;
    const said: string[] = [];
    let topped = false;
    for (let turn = 0; turn < 15; turn++) {
      const pawn = pawnAt(st, FIRST_PAWN);
      if (!pawn) break;
      if (pawn.mana >= 100) topped = true;
      for (const ev of resolveTurn(st, pawnChoices(st, 0))) said.push(ev.text);
      // The enemy is a punching bag here: the point is the Pawn's own bar.
      foe.hp = combatantMaxHp(foe);
    }
    expect(topped).toBe(true);
    expect(said.some((line) => line.includes("Sunfall"))).toBe(true);
  });
});

describe("the Cottle passives", () => {
  it("wears a target's Res down with a basic attack, six stacks deep", () => {
    const st = court();
    const foe = st.teams[1][0]!;
    const before = combatantStats(foe).res;
    for (let i = 0; i < 8; i++) {
      foe.hp = combatantMaxHp(foe);
      resolveTurn(st, [
        { kind: "attack", side: 0, slot: FIRST_PAWN, picks: [{ side: 1, index: 0 }] },
      ]);
    }
    expect(stacksOf(foe.statuses, "gored")).toBe(6);
    expect(combatantStats(foe).res).toBeLessThan(before);
  });

  it("leaves nothing on a target a spell hit, since it is the swing that gores", () => {
    const st = court();
    const foe = st.teams[1][0]!;
    const pawn = pawnAt(st, FIRST_PAWN)!;
    pawn.mana = 100;
    pawn.cds = {};
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: FIRST_PAWN, moveId: "pawn-dart", picks: [{ side: 1, index: 0 }] },
    ]);
    expect(stacksOf(foe.statuses, "gored")).toBe(0);
  });

  it("pours a tenth of the queen's Magic into her Speed when she braces", () => {
    const st = court();
    const queen = st.teams[0][0]!;
    const mag = combatantStats(queen).mag;
    const spd = combatantStats(queen).spd;
    resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    expect(stacksOf(queen.statuses, "quickstep")).toBe(1);
    expect(combatantStats(queen).spd).toBe(Math.floor(spd + mag * 0.1));
    resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    expect(combatantStats(queen).spd).toBe(Math.floor(spd + mag * 0.2));
  });

  it("gives a Pawn one passive and no second, since its pool is empty", () => {
    const corn = wild("cottlecorn", 3, "corn");
    expect(corn.secondaryAbility).toBe("");
    expect(passiveStatuses(corn).map((s) => s.id)).toEqual(["piercing-horn"]);
  });
});

describe("what a Pawn wears", () => {
  it("records who called it, and nothing else when she is plain", () => {
    const st = court();
    expect(st.teams[0][2]!.scoba.summoner).toEqual({ speciesId: "cottlequeen" });
  });

  it("carries her shine and her father's mark along for the art to sort out", () => {
    const tint = { from: "#112233", to: "#445566" };
    const st = court({
      dress: (q) => {
        q.shiny = true;
        q.tint = tint;
      },
    });
    expect(st.teams[0][2]!.scoba.summoner).toEqual({
      speciesId: "cottlequeen", tint, shiny: true,
    });
  });

  it("keeps only the marks its own palette has a colour for", () => {
    const mark = { from: "#aa0000", to: "#00aa00" };
    const turn = { from: "#00aa00", to: "#0000aa" };
    // Shares the colour the mark paints over, so both stick: the turn is
    // matched against what the mark left behind.
    expect(sharedSwaps(["#aa0000", "#ffffff"], [mark, turn])).toEqual([mark, turn]);
    // Shares nothing, so it keeps its own colours and does not glitter.
    expect(sharedSwaps(["#123456"], [mark, turn])).toEqual([null, null]);
    // Shares only what the turn touches.
    expect(sharedSwaps(["#00aa00"], [mark, turn])).toEqual([null, turn]);
  });
});

describe("Pawns stay out of the roster", () => {
  it("is not in the index, the editor's list or the breeding pools", () => {
    const ids = rosterSpecies().map((sp) => sp.id);
    expect(ids).toContain("cottlequeen");
    expect(ids).not.toContain("cottlecorn");
    expect(ids).not.toContain("relica");
  });

  it("cannot be bred with", () => {
    const corn = wild("cottlecorn", 3, "corn");
    const plib = wild("plib", 3, "plib");
    expect(canBreed(corn, plib)).toBe("This Scoba cannot breed.");
    expect(canBreed(plib, corn)).toBe("This Scoba cannot breed.");
  });

  it("takes EZ mode's leg-up with the rest of the side, so the court keeps up", () => {
    const queen = owned(wild("cottlequeen", 5, "ez-queen"), "A");
    const st = startBattle("ez", [queen], [wild("plib", 5, "ez-foe")], {
      slots: 1, owners: ["A", null], ez: true,
    });
    const pawn = pawnAt(st, FIRST_PAWN)!;
    expect(pawn.statuses.some((s) => s.id === "ez")).toBe(true);
    // The enemy is left where it was, EZ mode or not.
    expect(st.teams[1][0]!.statuses.some((s) => s.id === "ez")).toBe(false);
  });

  it("is a Pawn species with an autonomous flag, which is what the AI reads", () => {
    expect(SPECIES["cottlecorn"]!.pawn).toBe(true);
    expect(SPECIES["cottlecorn"]!.autonomous).toBe(true);
    expect(SPECIES["cottlequeen"]!.pawn).toBeUndefined();
  });
});
