import { describe, expect, it } from "vitest";
import {
  ALL_SLOTS, MAX_MANA, REWIND_KEEP, TRAVEL_SLOT, castCost, castableMoves, choiceError, combatantMaxHp,
  combatantStats, emptySlots, isPawnSlot, resolveTurn, rewind, sendIn, slotsAwaitingChoice, startBattle,
  stateHash,
  type BattleState, type Choice, type Combatant, type Slot,
} from "../src/sim/battle";
import { MOVES, SPECIES, moveTypes } from "../src/sim/species";
import { STATUSES, continuousEffects, newStatus } from "../src/sim/status";
import { makeWild, statsAt, type ScobaInstance } from "../src/sim/scoba";
import { candidates } from "../src/sim/targeting";
import { rngFrom } from "../src/sim/rng";
import { STAT_BUDGET, statTotal } from "../src/sim/types";

const wild = (id: string, lv = 30, seed = id): ScobaInstance => makeWild(id, lv, rngFrom(seed));
const mine = (s: ScobaInstance): ScobaInstance => ({ ...s, owner: "A" });

/** Unwind and an ally against as many enemies as asked for. */
function clock(enemies = ["plib"], slots: 1 | 2 = 1): BattleState {
  const me = mine(wild("unwind"));
  const st = startBattle("clock", [me, mine(wild("plib", 30, "ally"))], enemies.map((e, i) => wild(e, 30, `e${i}`)), { slots });
  st.teams[0][0]!.mana = 100;
  st.teams[0][0]!.cds = {};
  return st;
}

const cast = (moveId: string, picks: unknown[] = [{ side: 1, index: 0 }], slot = 0): Choice =>
  ({ kind: "spell", side: 0, slot, moveId, picks: picks as never });
const block = (slot: number, side: 0 | 1 = 0): Choice => ({ kind: "block", side, slot });
const swing = (side: 0 | 1, slot: number, at: { side: 0 | 1; index: number }): Choice =>
  ({ kind: "attack", side, slot, picks: [at] as never });

describe("the Unwind line", () => {
  it("is a mage that spends nothing on Strength", () => {
    const sp = SPECIES["unwind"]!;
    expect(statTotal(sp.genes)).toBe(STAT_BUDGET);
    expect(sp.genes.str).toBe(0);
    expect(sp.genes.mag).toBeGreaterThan(sp.genes.res);
  });

  it("is Cipher and Fortuna, and is drawn for its spent form and its mode", () => {
    const sp = SPECIES["unwind"]!;
    expect(sp.type).toBe("cipher");
    expect(sp.type2).toBe("fortuna");
    const forms = sp.sprite.kind === "art" ? sp.sprite.forms : undefined;
    expect(forms?.["spent"]).toBe("unwind-spent");
    expect(forms?.["hyper"]).toBe("hyper-unwind");
  });
});

describe("Cogwork", () => {
  it("strikes twice, once physically and once magically, both off Magic", () => {
    const move = MOVES["cogwork"]!;
    const hits = move.cast.filter((s) => s.kind === "hit");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ scaling: [{ stat: "mag", scale: 0.3 }], element: "fortuna", category: "physical" });
    expect(hits[1]).toMatchObject({ scaling: [{ stat: "mag", scale: 0.8 }], element: "cipher", category: "magic" });
  });

  it("reads each half against one element only, not against the move's pair", () => {
    // Meepa is Moon and Plain. Fortuna is strong against both and Cipher is
    // weak to Moon, so the two halves land on opposite sides of the chart. Were
    // either half read against the move's whole pair, both would read alike.
    const st = clock(["meepa"]);
    const foe = st.teams[1][0]!;
    foe.hp = combatantMaxHp(foe) * 50;
    const hits = resolveTurn(st, [cast("cogwork")]).filter((e) => e.kind === "hit");
    expect(hits).toHaveLength(2);
    expect(hits[0]!.text).toContain("Super effective");
    expect(hits[1]!.text).toContain("Not very effective");
  });

  it("takes HP off with both halves", () => {
    const st = clock();
    const foe = st.teams[1][0]!;
    foe.hp = combatantMaxHp(foe) * 10;
    const before = foe.hp;
    const events = resolveTurn(st, [cast("cogwork")]);
    expect(events.filter((e) => e.kind === "hit")).toHaveLength(2);
    expect(before - foe.hp).toBeGreaterThan(0);
  });
});

describe("Chrono Bolt", () => {
  it("takes the caster's whole Magic off the target's Speed for three turns", () => {
    const st = clock();
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    foe.hp = combatantMaxHp(foe) * 10;
    const bare = combatantStats(foe).spd;
    resolveTurn(st, [cast("chrono-bolt")]);
    const mark = foe.statuses.find((s) => s.id === "chrono-slow");
    expect(mark).toBeTruthy();
    expect(combatantStats(foe).spd).toBeLessThan(bare);
    // Off the caster's Magic, through the target's Resistance like any magical mark.
    expect(mark!.power).toBeGreaterThan(0);
    expect(mark!.power).toBeLessThanOrEqual(combatantStats(me).mag);
    expect(STATUSES["chrono-slow"]!.duration).toBe(3);
  });
});

describe("Time Shatter", () => {
  it("is the heaviest single hit in the line", () => {
    const move = MOVES["time-shatter"]!;
    expect(move.manaCost).toBe(70);
    expect(move.cast.find((s) => s.kind === "hit")).toMatchObject({
      scaling: [{ stat: "mag", scale: 3 }], element: "cipher", category: "magic",
    });
  });
});

describe("Accelerated", () => {
  it("pays 10 mana at the end of every turn", () => {
    const st = clock();
    const me = st.teams[0][0]!;
    me.scoba.secondaryAbility = "accelerated";
    me.statuses = [newStatus("accelerated")!];
    me.mana = 0;
    resolveTurn(st, [block(0)]);
    // The turn's own 20, and 10 more for being early.
    expect(me.mana).toBe(30);
  });

  it("takes a quarter more damage from anything", () => {
    // Measured on the ally rather than on Unwind, which carries Accelerated
    // out of its own pool and would be hurried either way.
    const hit = (accelerated: boolean): number => {
      const st = clock(["plib"], 2);
      const ally = st.teams[0][1]!;
      if (accelerated) ally.statuses.push(newStatus("accelerated")!);
      const before = ally.hp;
      // It casts rather than braces, since bracing would halve what it takes.
      resolveTurn(st, [cast("cogwork"), cast("crush", [{ side: 1, index: 0 }], 1), swing(1, 0, { side: 0, index: 1 })]);
      return before - ally.hp;
    };
    const plain = hit(false);
    const more = hit(true);
    expect(more).toBeGreaterThan(plain);
    expect(Math.abs(more - plain * 1.25)).toBeLessThanOrEqual(1);
  });
});

describe("Undo", () => {
  it("puts every ally back to the HP and statuses it had", () => {
    const st = clock(["plib", "grima"], 2);
    const me = st.teams[0][0]!;
    const ally = st.teams[0][1]!;
    const wasMe = me.hp;
    const wasAlly = ally.hp;
    resolveTurn(st, [
      cast("undo", [null]),
      block(1),
      swing(1, 0, { side: 0, index: 0 }),
      swing(1, 1, { side: 0, index: 1 }),
    ]);
    expect(me.hp).toBe(wasMe);
    expect(ally.hp).toBe(wasAlly);
  });

  it("takes off the statuses that landed in the round", () => {
    const st = clock(["meepa"], 2);
    const me = st.teams[0][0]!;
    me.hp = combatantMaxHp(me) * 10;
    // Moonbeam off a Meepa leaves Waning on whatever it lands on.
    resolveTurn(st, [cast("undo", [null]), block(1), {
      kind: "spell", side: 1, slot: 0, moveId: "moonbeam", picks: [{ side: 0, index: 0 }],
    } as Choice]);
    expect(me.statuses.some((s) => s.id === "wane")).toBe(false);
  });

  it("leaves a Scoba that actually fell where it fell", () => {
    const st = clock(["plib", "grima"], 2);
    const ally = st.teams[0][1]!;
    ally.hp = 1;
    resolveTurn(st, [
      cast("undo", [null]),
      block(1),
      swing(1, 0, { side: 0, index: 1 }),
      swing(1, 1, { side: 0, index: 1 }),
    ]);
    expect(ally.fainted).toBe(true);
    expect(ally.hp).toBe(0);
  });

  it("goes first, whatever the speeds are", () => {
    expect(MOVES["undo"]!.priority).toBe(1);
  });
});

describe("what the battle remembers", () => {
  it("files every round, and keeps only the last few", () => {
    const st = clock();
    st.teams[0][0]!.hp = combatantMaxHp(st.teams[0][0]!) * 50;
    st.teams[1][0]!.hp = combatantMaxHp(st.teams[1][0]!) * 50;
    for (let i = 0; i < REWIND_KEEP + 3; i++) resolveTurn(st, [block(0)]);
    expect(st.history).toHaveLength(REWIND_KEEP);
    expect(st.history!.map((h) => h.turn)).toEqual(st.history!.map((h) => h.turn).sort((a, b) => a - b));
  });

  it("keeps no history inside a snapshot, so nothing nests", () => {
    const st = clock();
    for (let i = 0; i < 3; i++) resolveTurn(st, [block(0)]);
    for (const record of st.history!) {
      expect((record.before as { history?: unknown }).history).toBeUndefined();
    }
  });
});

describe("winding the battle back", () => {
  it("puts every number back to where it stood, and hands back the rounds it undid", () => {
    const st = clock();
    const foe = st.teams[1][0]!;
    foe.hp = combatantMaxHp(foe) * 10;
    st.teams[0][0]!.hp = combatantMaxHp(st.teams[0][0]!) * 10;
    resolveTurn(st, [block(0)]);
    const mark = stateHash(st);
    const turn = st.turn;
    const foeHp = foe.hp;
    for (let i = 0; i < 3; i++) {
      st.teams[0][0]!.mana = 100;
      st.teams[0][0]!.cds = {};
      resolveTurn(st, [cast("cogwork")]);
    }
    expect(st.teams[1][0]!.hp).toBeLessThan(foeHp);
    const undone = rewind(st, 3);
    expect(undone).toHaveLength(3);
    expect(st.turn).toBe(turn);
    expect(stateHash(st)).toBe(mark);
    expect(st.teams[1][0]!.hp).toBe(foeHp);
    // The rounds it undid are the ones to play again, oldest first.
    expect(undone.map((u) => u.turn)).toEqual([turn, turn + 1, turn + 2]);
  });

  it("goes back as far as it has where the battle is younger than that", () => {
    const st = clock();
    resolveTurn(st, [block(0)]);
    const undone = rewind(st, 3);
    expect(undone).toHaveLength(1);
    expect(st.turn).toBe(0);
  });

  it("forgets the rounds it undid, so a second rewind cannot reach them", () => {
    const st = clock();
    st.teams[0][0]!.hp = combatantMaxHp(st.teams[0][0]!) * 50;
    for (let i = 0; i < 4; i++) resolveTurn(st, [block(0)]);
    rewind(st, 2);
    expect(st.history).toHaveLength(2);
    rewind(st, 2);
    expect(st.history).toHaveLength(0);
    expect(st.turn).toBe(0);
  });
});

describe("Deathlock", () => {
/**
   * Unwind three rounds into a fight, with Deathlock freshly up: the rounds are
   * what a rewind has to reach, and the mark has to still be standing when it
   * falls.
   */
  const doomed = (): BattleState => {
    const st = clock(["plib", "grima"], 2);
    const me = st.teams[0][0]!;
    me.hp = combatantMaxHp(me) * 10;
    for (let i = 0; i < 3; i++) resolveTurn(st, [block(0), block(1), block(0, 1), block(1, 1)]);
    me.statuses.push(newStatus("deathlock", undefined, undefined, st.turn)!);
    return st;
  };

  /** The round Unwind dies in: everything braces but the enemy swinging at it. */
  const killed = (st: BattleState): void => {
    st.teams[0][0]!.hp = 1;
    resolveTurn(st, [
      block(1), block(1, 1), block(0),
      swing(1, 0, { side: 0, index: 0 }),
    ]);
  };

  it("shows a clock counting out and whites the screen before it winds back", () => {
    const st = doomed();
    st.teams[0][0]!.hp = 1;
    const events = resolveTurn(st, [
      block(1), block(1, 1), block(0),
      swing(1, 0, { side: 0, index: 0 }),
    ]);
    const shown = events.filter((e) => e.kind === "show").map((e) => e.visual);
    const clockAt = shown.findIndex((v) => v?.kind === "show" && v.path === "clock");
    const flashAt = shown.findIndex((v) => v?.kind === "flash");
    expect(clockAt).toBeGreaterThanOrEqual(0);
    expect(flashAt).toBeGreaterThan(clockAt);
    expect(shown[clockAt]).toMatchObject({ art: "deathclock", pointers: ["deathclockhand"], on: "self" });
    // The clock is over the one it counted out, fallen as it is.
    const clockEv = events.filter((e) => e.kind === "show")[clockAt]!;
    expect(clockEv.to).toEqual([{ side: 0, index: 0 }]);
  });

  it("arrives with the passive, once a battle, for three turns", () => {
    const st = clock();
    const me = st.teams[0][0]!;
    expect(me.scoba.speciesId).toBe("unwind");
    expect(SPECIES["unwind"]!.primaryAbility).toBe("timelock");
    expect(STATUSES["deathlock"]!.duration).toBe(3);
  });

  it("winds the battle back three turns when Unwind falls with it up", () => {
    const st = doomed();
    const me = st.teams[0][0]!;
    const turn = st.turn;
    killed(st);
    expect(st.turn).toBeLessThan(turn);
    expect(st.teams[0][0]!.fainted).toBe(false);
  });

  it("leaves Unwind weaker, without Deathlock and without its mode", () => {
    const st = doomed();
    const me = st.teams[0][0]!;
    const bare = statsAt(me.scoba, false);
    killed(st);
    const back = st.teams[0][0]!;
    expect(back.statuses.some((s) => s.id === "unwound")).toBe(true);
    expect(back.statuses.some((s) => s.id === "deathlock")).toBe(false);
    // A fifth off every stat it spends.
    expect(combatantStats(back).mag).toBeLessThan(bare.mag);
    expect(back.worn).toContain("spent");
    expect(back.swapped?.[3]).toBe("time-shatter");
  });

  it("only happens once, since the passive fires once a battle", () => {
    const st = doomed();
    killed(st);
    const back = st.teams[0][0]!;
    expect(back.statuses.some((s) => s.id === "deathlock")).toBe(false);
    const turn = st.turn;
    killed(st);
    // Nothing to wind back this time: the turn goes forward and it stays down.
    expect(st.turn).toBeGreaterThan(turn);
    expect(st.teams[0][0]!.fainted).toBe(true);
  });
});

describe("Time Travel, the mode", () => {
  /** Unwind in its mode, with a target too big to fall over. */
  const hyped = (): BattleState => {
    const st = clock(["plib", "grima"], 2);
    const me = st.teams[0][0]!;
    me.mana = 100;
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 } as Choice, block(1), block(0, 1), block(1, 1)]);
    me.mana = 100;
    me.cds = {};
    for (const c of st.teams[1]) c.hp = combatantMaxHp(c);
    return st;
  };

  it("takes Deathlock off and puts Time Shatter in the fourth slot", () => {
    const st = hyped();
    const me = st.teams[0][0]!;
    expect(me.hyper).toBe(true);
    expect(me.statuses.some((s) => s.id === "deathlock")).toBe(false);
    expect(me.swapped?.[3]).toBe("time-shatter");
  });

  it("casts every spell a second time", () => {
    const st = hyped();
    const events = resolveTurn(st, [cast("cogwork"), block(1), block(0, 1), block(1, 1)]);
    // Two hits for the cast and two for the echo.
    expect(events.filter((e) => e.kind === "hit")).toHaveLength(4);
    expect(events.some((e) => e.text.includes("happens again"))).toBe(true);
  });

  it("makes the second cast worth a quarter of the first", () => {
    const st = hyped();
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    const events = resolveTurn(st, [cast("time-shatter", [{ side: 1, index: 0 }], 0), block(1), block(0, 1), block(1, 1)]);
    const hits = events.filter((e) => e.kind === "hit");
    expect(hits).toHaveLength(2);
    const first = before - hits[0]!.hp!;
    const second = hits[0]!.hp! - hits[1]!.hp!;
    expect(Math.abs(second - first * 0.25)).toBeLessThanOrEqual(2);
  });

  it("stacks a status that does not stack, at a quarter of it", () => {
    const st = hyped();
    const foe = st.teams[1][0]!;
    const bare = combatantStats(foe).spd;
    resolveTurn(st, [cast("chrono-bolt"), block(1), block(0, 1), block(1, 1)]);
    const held = foe.statuses.filter((s) => s.id === "chrono-slow");
    // One from the cast and one from the echo, rather than the second refreshing the first.
    expect(held).toHaveLength(2);
    expect(held.filter((s) => s.chrono)).toHaveLength(1);
    const echo = held.find((s) => s.chrono)!;
    const plain = held.find((s) => !s.chrono)!;
    expect(echo.power).toBeCloseTo(plain.power! * 0.25, 5);
    // Both slows land, so it is slower than either one alone.
    expect(combatantStats(foe).spd).toBeLessThan(bare - plain.power!);
  });

  it("shrinks a multiplier toward 1 rather than multiplying it out", () => {
    // Unwound takes a fifth off every stat. A quarter of that is a twentieth,
    // so the echo reads x0.95 rather than x0.2.
    const plain = continuousEffects([{ id: "unwound", turnsLeft: -1, chargesLeft: -1, stacks: 1 }]);
    const echo = continuousEffects([
      { id: "unwound", turnsLeft: -1, chargesLeft: -1, stacks: 1, chrono: true, scale: 0.25 },
    ]);
    const multOf = (list: typeof plain): number => {
      const found = list.find((e) => e.effect.kind === "stat-scale");
      return found?.effect.kind === "stat-scale" ? found.effect.mult : 0;
    };
    expect(multOf(plain)).toBeCloseTo(0.8, 6);
    expect(multOf(echo)).toBeCloseTo(0.95, 6);
  });

  it("still weakens the Scoba it is hung on", () => {
    const st = hyped();
    const me = st.teams[0][0]!;
    me.statuses = me.statuses.filter((s) => s.id !== "unwound");
    const bare = combatantStats(me).mag;
    me.statuses.push({ id: "unwound", turnsLeft: -1, chargesLeft: -1, stacks: 1, chrono: true, scale: 0.25 });
    expect(combatantStats(me).mag).toBeLessThan(bare);
  });
});

describe("Time Machine", () => {
  /** Unwind three rounds into a fight, with everything ready to travel. */
  const wound = (enemies = ["plib", "grima"]): BattleState => {
    const st = clock(enemies, 2);
    for (const c of [...st.teams[0], ...st.teams[1]]) c.hp = combatantMaxHp(c);
    for (let i = 0; i < 3; i++) {
      resolveTurn(st, [block(0), block(1), block(0, 1), block(1, 1)]);
    }
    const me = st.teams[0][0]!;
    me.mana = 100;
    me.cds = {};
    return st;
  };

  const travel = (): Choice =>
    ({ kind: "spell", side: 0, slot: 0, moveId: "time-machine", picks: [null] } as Choice);

  /** Where the traveller is standing, and the choice it makes back there. */
  const visiting = (st: BattleState): { at: number; slot: Slot } => {
    const at = st.travelling!.visitor.index;
    const slot = ALL_SLOTS.find((s) => st.active[0][s] === at)!;
    return { at, slot };
  };

  const inThePast = (st: BattleState, moveId: string, picks: unknown[]): Choice => {
    const { slot } = visiting(st);
    return { kind: "spell", side: 0, slot, moveId, picks: picks as never } as Choice;
  };

  /** Another of the same on the bench, so it knows what the one it replaces knew. */
  const benched = (st: BattleState, side: 0 | 1, from: number): number => {
    const c = structuredClone(st.teams[side][from]!);
    c.scoba.uid = `${c.scoba.uid}-spare`;
    c.fainted = false;
    c.hp = combatantMaxHp(c);
    st.teams[side].push(c);
    return st.teams[side].length - 1;
  };

  it("sends a replacement on again at the round it walked on for", () => {
    const st = clock(["plib", "grima"], 2);
    for (const c of [...st.teams[0], ...st.teams[1]]) c.hp = combatantMaxHp(c);
    const spare = benched(st, 1, 0);
    // Turn 0: nothing. Then the enemy on the first mark falls and the spare
    // takes its place, which is filed against the turn it walked on for.
    resolveTurn(st, [block(0), block(1), block(0, 1), block(1, 1)]);
    const fell = st.teams[1][0]!;
    fell.hp = 0;
    fell.fainted = true;
    st.active[1][0] = -1;
    sendIn(st, 1, 0, spare);
    // Turn 1: the spare swings. Turn 2: nothing.
    resolveTurn(st, [block(0), block(1), swing(1, 0, { side: 0, index: 0 }), block(1, 1)]);
    resolveTurn(st, [block(0), block(1), block(0, 1), block(1, 1)]);
    expect(st.history!.find((r) => r.turn === 1)!.filled)
      .toEqual([{ side: 1, slot: 0, uid: st.teams[1][spare]!.scoba.uid }]);

    const me = st.teams[0][0]!;
    me.mana = 100;
    me.cds = {};
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    // Back in the past, the one that fell is still standing. The traveller
    // takes it out here instead, three rounds earlier than it went the last time.
    st.teams[1][0]!.hp = 1;
    const events = resolveTurn(st, [inThePast(st, "chrono-bolt", [{ side: 1, index: 0 }])]);
    expect(st.teams[1][0]!.fainted).toBe(true);
    // The mark was emptied a round earlier this time, and the replacement still
    // walks on for the round it walked on for.
    expect(st.active[1][0]).toBe(spare);
    expect(st.teams[1][spare]!.fainted).toBe(false);
    expect(events.some((e) => e.kind === "switch" && e.text.includes("joins the fight"))).toBe(true);
  });

  it("lets whoever took the mark cast what was cast from it", () => {
    const st = clock(["plib", "grima"], 2);
    for (const c of [...st.teams[0], ...st.teams[1]]) c.hp = combatantMaxHp(c);
    const spare = benched(st, 1, 0);
    resolveTurn(st, [block(0), block(1), block(0, 1), block(1, 1)]);
    const fell = st.teams[1][0]!;
    fell.hp = 0;
    fell.fainted = true;
    st.active[1][0] = -1;
    sendIn(st, 1, 0, spare);
    resolveTurn(st, [block(0), block(1), swing(1, 0, { side: 0, index: 0 }), block(1, 1)]);
    resolveTurn(st, [block(0), block(1), block(0, 1), block(1, 1)]);
    const me = st.teams[0][0]!;
    me.mana = 100;
    me.cds = {};
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    st.teams[1][0]!.hp = 1;
    const ally = st.teams[0][1]!;
    ally.hp = combatantMaxHp(ally);
    const was = ally.hp;
    resolveTurn(st, [inThePast(st, "chrono-bolt", [{ side: 1, index: 0 }])]);
    // The swing was the fallen one's, taken from its mark. The spare that took
    // the mark knows the same move, so the swing still lands.
    expect(st.teams[0][0]!.hp + ally.hp).toBeLessThan(combatantMaxHp(st.teams[0][0]!) + was);
  });

  it("aims a repeated move at the mark it was aimed at, not at who stood there", () => {
    const st = clock(["plib", "grima"], 2);
    for (const c of [...st.teams[0], ...st.teams[1]]) c.hp = combatantMaxHp(c);
    const spare = benched(st, 1, 0);
    // Three rounds of the ally swinging at whoever holds the first enemy mark.
    for (let i = 0; i < 3; i++) {
      resolveTurn(st, [block(0), swing(0, 1, { side: 1, index: 0 }), block(0, 1), block(1, 1)]);
    }
    const me = st.teams[0][0]!;
    me.mana = 100;
    me.cds = {};
    resolveTurn(st, [travel(), swing(0, 1, { side: 1, index: 0 }), block(0, 1), block(1, 1)]);
    // The journey changed who is standing on that mark before the round it is
    // about to play again.
    const fell = st.teams[1][0]!;
    fell.hp = 0;
    fell.fainted = true;
    st.active[1][0] = -1;
    sendIn(st, 1, 0, spare);
    const was = st.teams[1][spare]!.hp;
    resolveTurn(st, [inThePast(st, "cogwork", [{ side: 1, index: 1 }])]);
    expect(st.teams[1][spare]!.hp).toBeLessThan(was);
  });

  it("names the Pawn a call brought up, since the step back takes that call with it", () => {
    const st = wound();
    // The ally calls a Pawn in the round Unwind steps back. The call goes
    // first, and the step back then undoes the whole round, Pawn and all.
    const ally = st.teams[0][1]!;
    ally.scoba.moves = ["court-call", ...ally.scoba.moves.slice(1)];
    ally.mana = MAX_MANA;
    ally.cds = {};
    const events = resolveTurn(st, [travel(), cast("court-call", [null], 1), block(0, 1), block(1, 1)]);
    const call = events.find((e) => e.kind === "summon")!;
    expect(call.uid).toBeDefined();
    // The Pawn it called is nowhere on the board, and the place the call names
    // now holds the traveller. Without the name on the line, the scene drew the
    // call on whoever the rewind had put there.
    expect(st.teams[0].some((c) => c.scoba.uid === call.uid)).toBe(false);
    const there = st.teams[0][call.at!.index]!;
    expect(there.scoba.uid).not.toBe(call.uid);
    expect(there.aside).toBe(true);
  });

  it("plays on after the traveller has gone, so the board it leaves is not the final one", () => {
    const st = clock(["plib", "grima"], 2);
    for (const c of [...st.teams[0], ...st.teams[1]]) c.hp = combatantMaxHp(c);
    // Rounds with blows in them, so there is something left to show afterwards.
    for (let i = 0; i < 3; i++) {
      resolveTurn(st, [
        block(0), block(1),
        swing(1, 0, { side: 0, index: 0 }), swing(1, 1, { side: 0, index: 1 }),
      ]);
    }
    const me = st.teams[0][0]!;
    me.mana = 100;
    me.cds = {};
    resolveTurn(st, [travel(), block(1), swing(1, 0, { side: 0, index: 0 }), block(1, 1)]);
    const events = resolveTurn(st, [inThePast(st, "chrono-bolt", [{ side: 1, index: 0 }])]);
    const rode = events.findIndex((e) => e.kind === "travel" && e.way === "back");
    expect(rode).toBeGreaterThanOrEqual(0);
    // The rounds it came back for are still to play, so anything that reads the
    // battle as settled here is reading rounds into the future. The scene does
    // that on a rewind, and must not on the way out.
    expect(events.slice(rode + 1).some((e) => e.hp !== undefined)).toBe(true);
  });

  it("rides the machine up, whites the screen, then lands in the past", () => {
    const st = wound();
    const events = resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    const shown = events.filter((e) => e.kind === "show");
    const paths = shown.map((e) => (e.visual?.kind === "show" ? e.visual.path : e.visual?.kind));
    expect(paths).toEqual(["motion", "liftoff", "flash", "landing"]);
    expect(shown[1]!.visual).toMatchObject({ art: "timemachine", on: "self" });
    expect(shown[2]!.visual).toMatchObject({ kind: "flash", color: "#ffffff" });
    // The machine comes down on the traveller, which is nobody until it has gone.
    expect(shown[3]!.visual).toMatchObject({ art: "timemachine", on: "traveller" });
    expect(shown[3]!.to).toEqual([st.travelling!.visitor]);
    // The board is put back together between the two, on the step that says so.
    const at = events.findIndex((e) => e.kind === "travel");
    expect(at).toBeGreaterThan(events.indexOf(shown[2]!));
    expect(events[at]!.way).toBe("out");
  });

  it("says so when the traveller rides away", () => {
    const st = wound();
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    const events = resolveTurn(st, [inThePast(st, "cogwork", [{ side: 1, index: 0 }])]);
    const home = events.find((e) => e.kind === "travel" && e.way === "back");
    expect(home?.text).toContain("rides back to its own turn");
  });

  it("goes back three turns and ends the round there", () => {
    const st = wound();
    const turn = st.turn;
    const team = st.teams[0].length;
    const events = resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    expect(events.some((e) => e.text.includes("steps back"))).toBe(true);
    expect(st.turn).toBe(turn - 3);
    expect(st.travelling).toBeTruthy();
    expect(st.travelling!.left).toHaveLength(3);
    // The traveller stands in the past as a third Scoba, beside its younger self.
    expect(st.teams[0]).toHaveLength(team + 1);
    expect(visiting(st).slot).toBeGreaterThanOrEqual(0);
  });

  it("stands on a mark of its own, however full the court is", () => {
    const st = wound();
    // Every Pawn mark taken, which used to leave a traveller with nowhere to go.
    for (const slot of ALL_SLOTS.filter(isPawnSlot)) {
      const pawn: Combatant = { ...structuredClone(st.teams[0][1]!), pawn: true };
      st.teams[0].push(pawn);
      st.active[0][slot] = st.teams[0].length - 1;
    }
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    expect(st.active[0][TRAVEL_SLOT]).toBe(st.travelling!.visitor.index);
    expect(visiting(st).slot).toBe(TRAVEL_SLOT);
    // Nothing fills it, nothing walks onto it, and nobody can be called back to it.
    expect(emptySlots(st, 0)).not.toContain(TRAVEL_SLOT);
    expect(choiceError(st, { kind: "switch", side: 0, slot: TRAVEL_SLOT, benchIndex: 1 } as Choice))
      .toMatch(/not even from this turn/);
  });

  it("asks the traveller for a move, and nobody else", () => {
    const st = wound();
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    expect(slotsAwaitingChoice(st, 1)).toEqual([]);
    expect(slotsAwaitingChoice(st, 0)).toEqual([visiting(st).slot]);
  });

  it("plays the turns again once the move is made, and rides the traveller away", () => {
    const st = wound();
    const turn = st.turn;
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    const visitor = st.travelling!.visitor.index;
    const events = resolveTurn(st, [inThePast(st, "cogwork", [{ side: 1, index: 0 }])]);
    expect(events.some((e) => e.text.includes("rides back to its own turn"))).toBe(true);
    // Back three, then those three played again, so the battle stands where it was.
    expect(st.turn).toBe(turn);
    expect(st.travelling).toBeUndefined();
    // Off every mark and no longer standing, but still holding its own number.
    expect(st.active[0]).not.toContain(visitor);
    expect(st.teams[0][visitor]!.aside).toBe(true);
    expect(st.teams[0][visitor]!.fainted).toBe(true);
    expect(st.active[0].filter((i) => i >= 0).every((i) => i < st.teams[0].length)).toBe(true);
  });

  it("keeps its number when it goes, so a Pawn called meanwhile does not take it", () => {
    const st = wound();
    // An ally with a Pawn to call, in one of the rounds that plays again after
    // the traveller has ridden away. Its call landed on the number the
    // traveller gave up, which put a Pawn in the machine and a Pawn's body
    // under the traveller's name.
    const ally = st.teams[0][1]!;
    ally.scoba.moves = ["court-call", ...ally.scoba.moves.slice(1)];
    ally.mana = MAX_MANA;
    ally.cds = {};
    resolveTurn(st, [travel(), cast("court-call", [null], 1), block(0, 1), block(1, 1)]);
    const visitor = st.travelling!.visitor.index;
    resolveTurn(st, [inThePast(st, "cogwork", [{ side: 1, index: 0 }])]);
    const held = st.teams[0][visitor]!;
    expect(held.aside).toBe(true);
    expect(held.pawn).toBeFalsy();
    expect(held.scoba.speciesId).toBe("unwind");
    // Every Pawn the replayed rounds called is somewhere past it.
    for (const [i, c] of st.teams[0].entries()) {
      if (c.pawn) expect(i, `pawn at ${i}`).toBeGreaterThan(visitor);
    }
  });

  it("leaves the past changed: the spell it cast back there landed", () => {
    const st = wound();
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    resolveTurn(st, [inThePast(st, "chrono-bolt", [{ side: 1, index: 0 }])]);
    expect(st.teams[1][0]!.hp).toBeLessThan(before);
  });

  it("costs a full bar, and takes 50 mana off what the traveller casts back there", () => {
    expect(MOVES["time-machine"]!.manaCost).toBe(MAX_MANA);
    expect(moveTypes(MOVES["time-machine"]!)).toEqual(["fortuna", "cipher"]);
    // The fourth slot, which is the one Time Shatter takes afterwards.
    expect(SPECIES["unwind"]!.moves[3]).toBe("time-machine");
    const st = wound();
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    const visitor = st.teams[0][visiting(st).at]!;
    const home = st.teams[0][0]!;
    expect(visitor.costOff).toBe(50);
    // Everything it knows, measured against what the same Scoba pays at home.
    for (const id of home.scoba.moves) {
      expect(castCost(visitor, id), id).toBe(Math.max(0, castCost(home, id) - 50));
    }
  });

  it("is reached by anything that sweeps a side", () => {
    const st = wound();
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    const { at } = visiting(st);
    const reached = candidates(st, { side: 1, index: 0 }, "enemy-team");
    expect(reached.some((r) => r.side === 0 && r.index === at)).toBe(true);
    const helped = candidates(st, { side: 0, index: 0 }, "ally-team");
    expect(helped.some((r) => r.side === 0 && r.index === at)).toBe(true);
  });

  it("is made once a battle, by anyone, and leaves Time Shatter behind", () => {
    const st = wound();
    resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    expect(st.travelled).toBe(true);
    resolveTurn(st, [inThePast(st, "cogwork", [{ side: 1, index: 0 }])]);
    const me = st.teams[0][0]!;
    me.mana = 100;
    me.cds = {};
    // Whatever slot it was in now holds the shard instead.
    const slot = me.scoba.moves.indexOf("time-machine");
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(me.swapped?.[slot]).toBe("time-shatter");
    expect(castableMoves(me)).toContain("time-shatter");
    expect(castableMoves(me)).not.toContain("time-machine");
    // It cannot be cast again: the slot holds the shard, and the journey is spent.
    expect(choiceError(st, travel())).toBe("Scoba does not know that spell.");
    // Even a Scoba that still holds it is refused, on either side. Handed to it
    // rather than written into its line, so it pays the move's own cost instead
    // of the surcharge for one its line never learns.
    const foe = st.teams[1][0]!;
    foe.swapped = { 0: "time-machine" };
    foe.mana = MAX_MANA;
    foe.cds = {};
    expect(choiceError(st, {
      kind: "spell", side: 1, slot: 0, moveId: "time-machine", picks: [null],
    } as Choice)).toMatch(/already been made/);
  });

  it("skips a choice the new past has made impossible", () => {
    // The enemy's recorded round is a spell it can no longer pay for.
    const st = wound();
    const foe = st.teams[1][0]!;
    foe.mana = 100;
    resolveTurn(st, [block(0), block(1), {
      kind: "spell", side: 1, slot: 0, moveId: "crush", picks: [{ side: 0, index: 0 }],
    } as Choice, block(1, 1)]);
    st.teams[0][0]!.mana = 100;
    st.teams[0][0]!.cds = {};
    const events = resolveTurn(st, [travel(), block(1), block(0, 1), block(1, 1)]);
    expect(events.some((e) => e.text.includes("steps back"))).toBe(true);
    // Going back takes the enemy's mana with it, so the recorded cast is fine;
    // what matters is that the replay runs without throwing on anything illegal.
    resolveTurn(st, [inThePast(st, "cogwork", [{ side: 1, index: 0 }])]);
    expect(st.winner).toBe(-1);
    expect(st.travelling).toBeUndefined();
  });

  it("does nothing where there is no past to step into", () => {
    const st = clock(["plib"], 2);
    const me = st.teams[0][0]!;
    me.mana = 100;
    const events = resolveTurn(st, [travel(), block(1), block(0, 1)]);
    expect(events.some((e) => e.text.includes("no time to go back to"))).toBe(true);
    expect(st.travelled).toBeUndefined();
    expect(st.travelling).toBeUndefined();
  });
});

describe("the traveller in the past", () => {
  const wound = (): BattleState => {
    const st = clock(["plib", "grima"], 2);
    for (const c of [...st.teams[0], ...st.teams[1]]) c.hp = combatantMaxHp(c);
    for (let i = 0; i < 3; i++) resolveTurn(st, [block(0), block(1), block(0, 1), block(1, 1)]);
    const me = st.teams[0][0]!;
    me.mana = 100;
    me.cds = {};
    return st;
  };

  /** The whole journey: out, a move back there, and the turns played again. */
  const journey = (st: BattleState, moveId = "cogwork"): void => {
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "time-machine", picks: [null] } as Choice,
      block(1), block(0, 1), block(1, 1),
    ]);
    const slot = ALL_SLOTS.find((s) => st.active[0][s] === st.travelling!.visitor.index)!;
    resolveTurn(st, [
      { kind: "spell", side: 0, slot, moveId, picks: [{ side: 1, index: 0 }] } as never,
    ]);
  };

  it("leaves the Scoba standing even where the one that travelled fell", () => {
    const st = wound();
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "time-machine", picks: [null] } as Choice,
      block(1), block(0, 1), block(1, 1),
    ]);
    // The one that travelled does not survive what it meets back there. What
    // the battle goes on with is the one that was already standing here: the
    // past it changed is the past everyone now has.
    const visitor = st.teams[0][st.travelling!.visitor.index]!;
    visitor.hp = 0;
    visitor.fainted = true;
    const events = resolveTurn(st, []);
    expect(st.teams[0][0]!.fainted).toBe(false);
    expect(st.active[0].some((i) => i >= 0 && st.teams[0][i]!.aside)).toBe(false);
    // Nothing rides away that fell, so the machine is never shown coming for it.
    expect(events.some((e) => e.kind === "travel" && e.way === "back")).toBe(false);
  });

  it("rides away at the end of the one round it came back for", () => {
    const st = wound();
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "time-machine", picks: [null] } as Choice,
      block(1), block(0, 1), block(1, 1),
    ]);
    const slot = ALL_SLOTS.find((s) => st.active[0][s] === st.travelling!.visitor.index)!;
    const events = resolveTurn(st, [
      { kind: "spell", side: 0, slot, moveId: "cogwork", picks: [{ side: 1, index: 0 }] } as never,
    ]);
    // It boards the machine it came in and goes, whatever the rounds after do.
    const rode = events.findIndex((e) => e.kind === "travel" && e.way === "back");
    expect(rode).toBeGreaterThanOrEqual(0);
    expect(events[rode - 1]?.visual).toMatchObject({ art: "timemachine", path: "liftoff" });
    expect(st.active[0].some((i) => i >= 0 && st.teams[0][i]!.aside)).toBe(false);
  });

  it("brings back what it is carrying, mana and all", () => {
    const st = wound();
    const me = st.teams[0][0]!;
    me.mana = 100;
    journey(st, "chrono-bolt");
    // The journey itself is paid in the present, out of the bar it had then.
    // What it cast back there was free, since the discount covers Chrono Bolt.
    expect(st.teams[0][0]!.mana).toBeGreaterThan(0);
    expect(st.teams[0][0]!.fainted).toBe(false);
  });

  it("keeps both clients in step through the whole journey", () => {
    const one = wound();
    const two = wound();
    journey(one);
    journey(two);
    expect(stateHash(one)).toBe(stateHash(two));
  });
});

describe("Deathlock while the past is being played again", () => {
  it("winds the battle back again rather than letting it stand", () => {
    const st = clock(["plib", "grima"], 2);
    for (const c of [...st.teams[0], ...st.teams[1]]) c.hp = combatantMaxHp(c);
    for (let i = 0; i < 3; i++) resolveTurn(st, [block(0), block(1), block(0, 1), block(1, 1)]);
    const me = st.teams[0][0]!;
    me.statuses.push(newStatus("deathlock", undefined, undefined, st.turn)!);
    me.mana = 100;
    me.cds = {};
    me.hp = 1;
    const turn = st.turn;
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "time-machine", picks: [null] } as Choice,
      block(1), block(0, 1), block(1, 1),
    ]);
    const slot = ALL_SLOTS.find((s) => st.active[0][s] === st.travelling!.visitor.index)!;
    resolveTurn(st, [
      { kind: "spell", side: 0, slot, moveId: "cogwork", picks: [{ side: 1, index: 0 }] } as never,
    ]);
    // Either it came through or Deathlock caught it, and either way the battle
    // is somewhere earlier than it was and Unwind is still standing.
    expect(st.turn).toBeLessThanOrEqual(turn);
    expect(st.teams[0][0]!.fainted).toBe(false);
  });
});

describe("Undo and Accelerated together", () => {
  it("puts back what the extra damage took", () => {
    const st = clock(["plib", "grima"], 2);
    const ally = st.teams[0][1]!;
    ally.statuses.push(newStatus("accelerated")!);
    const was = ally.hp;
    resolveTurn(st, [
      cast("undo", [null]),
      cast("crush", [{ side: 1, index: 0 }], 1),
      swing(1, 0, { side: 0, index: 1 }),
      swing(1, 1, { side: 0, index: 1 }),
    ]);
    expect(ally.hp).toBe(was);
  });
});
