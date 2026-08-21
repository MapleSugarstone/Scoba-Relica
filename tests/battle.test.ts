import { describe, expect, it } from "vitest";
import {
  startBattle,
  resolveTurn,
  joinBattle,
  benchFor,
  slotOf,
  slotsAwaitingChoice,
  emptySlots,
  sendIn,
  choiceError,
  stateHash,
  moveReady,
  catchChance,
  combatantStats,
  combatantMaxHp,
  START_MANA,
  type BattleState,
  type Choice,
} from "../src/sim/battle";
import { enemyChoices } from "../src/sim/ai";
import { makeWild, statsAt, maxHp, type ScobaInstance } from "../src/sim/scoba";
import { MOVES, SPECIES } from "../src/sim/species";
import { rngFrom } from "../src/sim/rng";
import { TYPES, effectiveness } from "../src/sim/types";

const wild = (species: string, level: number, seed: string) => makeWild(species, level, rngFrom(seed));
const owned = (s: ScobaInstance, owner: "A" | "B"): ScobaInstance => ({ ...s, owner });
/** The team index standing in a slot, which is how a choice names a target. */
const at = (st: BattleState, side: 0 | 1, slot: number) => ({ side, index: st.active[side][slot]! });

describe("stats", () => {
  it("start at the species genes and gain +1 per level; effective HP is HP x 2.8", () => {
    const genes = SPECIES["plib"]!.genes;
    const s = wild("plib", 1, "s1");
    expect(statsAt(s, false)).toEqual(genes);
    // Passives are statuses, folded in the same way in a battle and out of
    // one, so a Scoba's pool reads the same on both sides of the door.
    expect(maxHp({ ...s, secondaryAbility: "hearty" }))
      .toBe(Math.floor(Math.floor(genes.hp * 1.15) * 2.8));
    const s10 = wild("plib", 10, "s2");
    expect(statsAt(s10, false).str).toBe(genes.str + 9);
  });
});

describe("battle", () => {
  it("type chart matches the design table", () => {
    expect(effectiveness("moon", "sun")).toBe(2);
    expect(effectiveness("moss", "moon")).toBe(2);
    expect(effectiveness("sun", "moss")).toBe(2);
    expect(effectiveness("flux", "moss")).toBe(2);
    expect(effectiveness("mystic", "flux")).toBe(2);
    expect(effectiveness("sugar", "cipher")).toBe(2);
    expect(effectiveness("cipher", "mystic")).toBe(2);
    expect(effectiveness("fortuna", "sugar")).toBe(2);
    expect(effectiveness("moon", "moss")).toBe(0.5);
    expect(effectiveness("flux", "sugar")).toBe(0.5);
    expect(effectiveness("fortuna", "cipher")).toBe(0.5);
  });

  it("every type resists itself except Plain, which only Fortuna beats", () => {
    for (const t of TYPES) {
      expect(effectiveness(t, t)).toBe(t === "plain" ? 1 : 0.5);
      expect(effectiveness("plain", t)).toBe(1);
      expect(effectiveness(t, "plain")).toBe(t === "fortuna" ? 2 : 1);
    }
  });

  it("basic attack deals 100% Strength mitigated by Defense", () => {
    const a = wild("plib", 10, "a");
    a.secondaryAbility = "brawn";
    const b = wild("grima", 10, "b");
    b.secondaryAbility = "thick-coat";
    const st = startBattle("basic", [a], [b], { wild: true });
    const hpBefore = st.teams[1][0]!.hp;
    const events = resolveTurn(st, [
      { kind: "attack", side: 0, slot: 0, picks: [at(st, 1, 0)] },
      { kind: "block", side: 1, slot: 0 },
    ]);
    // Strength over Defense, halved by the block. The hit is read off its own
    // event, so nothing later in the turn colours the number.
    const str = combatantStats(st.teams[0][0]!).str;
    const def = combatantStats(st.teams[1][0]!).def;
    const expected = Math.max(1, Math.floor((str / (1 + def / 100)) * 0.5));
    const hit = events.find((e) => e.kind === "hit")!;
    expect(hpBefore - hit.hp!).toBe(expected);
  });

  it("spells cost mana, respect cooldowns and starting cooldowns", () => {
    const a = wild("cresce", 12, "c"); // knows crush, cleanse, moonbeam, eclipse(start cd 1)
    const b = wild("obera", 12, "d");
    const st = startBattle("mana", [a], [b], { wild: true });
    const me = st.teams[0][0]!;
    expect(me.mana).toBe(START_MANA);
    // eclipse has startCooldown 1: locked on turn 1.
    expect(moveReady(me, "eclipse").ok).toBe(false);
    expect(choiceError(st, { kind: "spell", side: 0, slot: 0, moveId: "eclipse", picks: [at(st, 1, 0)] })).toMatch(/cooldown/i);
    // moonbeam costs 35: affordable at 40.
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "moonbeam", picks: [at(st, 1, 0)] },
      { kind: "block", side: 1, slot: 0 },
    ]);
    expect(me.mana).toBe(START_MANA - 35 + 20); // spent, then +20 regen
    // Turn 2: eclipse now off its starting cooldown but costs 55 > 25.
    expect(moveReady(me, "eclipse").ok).toBe(false);
    expect(moveReady(me, "eclipse").why).toMatch(/mana/i);
    resolveTurn(st, [
      { kind: "block", side: 0, slot: 0 },
      { kind: "block", side: 1, slot: 0 },
    ]);
    expect(me.mana).toBe(45);
    resolveTurn(st, [
      { kind: "block", side: 0, slot: 0 },
      { kind: "block", side: 1, slot: 0 },
    ]);
    expect(me.mana).toBe(65);
    // Turn 3: cast eclipse (cooldown 2) and verify it locks after use.
    // The target is propped up so the blow does not end the fight, since a
    // finished battle stops ticking cooldowns at all.
    st.teams[1][0]!.hp = 500;
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "eclipse", picks: [at(st, 1, 0)] },
      { kind: "block", side: 1, slot: 0 },
    ]);
    expect(me.cds["eclipse"]).toBe(2);
    expect(moveReady(me, "eclipse").ok).toBe(false);
  });

  it("ends the moment a side is wiped, without playing out the rest of the turn", () => {
    const me = wild("plib", 40, "imm1");
    me.moves = ["nuzzle-nap"];
    const st = startBattle("immediate", [me], [wild("obera", 2, "imm2")], { wild: true });
    st.teams[0][0]!.hp = 1;
    st.teams[1][0]!.hp = 1;
    const events = resolveTurn(st, [{ kind: "attack", side: 0, slot: 0, picks: [at(st, 1, 0)] }]);
    expect(st.winner).toBe(0);
    // The win is announced straight after the faint, and nothing follows it:
    // no end-of-turn regen, no ability healing, no status ticks.
    const faint = events.findIndex((e) => e.kind === "faint");
    const win = events.findIndex((e) => e.kind === "win");
    expect(win).toBe(faint + 1);
    expect(win).toBe(events.length - 1);
    // Mana did not regenerate, because the turn stopped when the fight did.
    expect(st.teams[0][0]!.mana).toBe(START_MANA);
  });

  it("rejects passing with an active Scoba", () => {
    const st = startBattle("nopass", [wild("plib", 5, "e")], [wild("flarea", 5, "f")], { wild: true });
    expect(choiceError(st, { kind: "pass", side: 1, slot: 0 })).toMatch(/pass/i);
    expect(choiceError(st, { kind: "pass", side: 0, slot: 1 })).toBeNull(); // empty slot
  });

  it("computes STAB + effectiveness + heart ability damage", () => {
    const a = wild("flarea", 20, "g");
    a.secondaryAbility = "swift";
    const b = wild("obera", 20, "h");
    b.secondaryAbility = "hearty";
    const st = startBattle("stab2", [a], [b], { wild: true });
    const hpBefore = st.teams[1][0]!.hp;
    const events = resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "cinder-spit", picks: [at(st, 1, 0)] },
      { kind: "block", side: 1, slot: 0 },
    ]);
    const mag = combatantStats(st.teams[0][0]!).mag;
    const res = combatantStats(st.teams[1][0]!).res;
    // 1.2 scale, STAB 1.5, super effective 2, Sun Heart 1.25, mitigated by
    // res, halved by block. Obera mends a little at end of turn, so the hit
    // is read off its own event rather than off the HP left standing.
    const raw = ((mag * 1.2 * 1.5 * 2 * 1.25) / (1 + res / 100)) * 0.5;
    const hit = events.find((e) => e.kind === "hit")!;
    expect(hpBefore - hit.hp!).toBe(Math.max(1, Math.floor(raw)));
  });

  it("is deterministic and detects divergence via stateHash", () => {
    const mk = () => startBattle("det", [wild("plib", 8, "x1"), wild("obera", 8, "x2")], [wild("flarea", 8, "y1"), wild("grima", 8, "y2")], { slots: 2 });
    const s1 = mk();
    const s2 = mk();
    for (let i = 0; i < 10 && s1.winner === -1; i++) {
      const c1 = playerAuto(s1).concat(enemyChoices(s1));
      const c2 = playerAuto(s2).concat(enemyChoices(s2));
      const e1 = resolveTurn(s1, c1);
      const e2 = resolveTurn(s2, c2);
      expect(e2.map((e) => e.text)).toEqual(e1.map((e) => e.text));
      expect(stateHash(s2)).toBe(stateHash(s1));
    }
  });

  it("plays to a winner with the AI driving both sides", () => {
    const st = startBattle("winner", [wild("plib", 10, "p1"), wild("grima", 10, "p2")], [wild("flarea", 9, "q1"), wild("flarea", 9, "q2")], { slots: 2 });
    let guard = 300;
    while (st.winner === -1 && guard-- > 0) {
      resolveTurn(st, playerAuto(st).concat(enemyChoices(st)));
    }
    expect(st.winner === 0 || st.winner === 1).toBe(true);
  });

  it("opens with everyone whole, whatever shape they walked in with", () => {
    const hurt = wild("plib", 10, "heal1");
    hurt.hp = 0;
    const st = startBattle("healed", [hurt], [wild("flarea", 10, "heal2")], { wild: true });
    const me = st.teams[0][0]!;
    expect(me.fainted).toBe(false);
    expect(me.hp).toBe(combatantMaxHp(me));
    expect(me.mana).toBe(START_MANA);
    expect(st.active[0][0]).toBe(0);
  });

  it("calls a mutual wipe a defeat, so the party is never left with nothing", () => {
    const st = startBattle("wipe", [wild("plib", 10, "w1")], [wild("flarea", 10, "w2")], { wild: true });
    // Both last Scobas go down in the same turn, which is the only way to
    // reach this state now that a battle opens with everyone standing.
    for (const side of [0, 1] as const) {
      const c = st.teams[side][0]!;
      c.hp = 0;
      c.fainted = true;
      st.active[side][0] = -1;
    }
    resolveTurn(st, [{ kind: "pass", side: 0, slot: 0 }, { kind: "pass", side: 1, slot: 0 }]);
    expect(st.winner).toBe(1);
  });

  it("gives each character their own slot and their own bench", () => {
    const a1 = owned(wild("plib", 8, "a1"), "A");
    const a2 = owned(wild("grima", 8, "a2"), "A");
    const b1 = owned(wild("flarea", 8, "b1"), "B");
    const st = startBattle("coop", [a1, a2, b1], [wild("obera", 8, "e1")], {
      slots: 2,
      owners: ["A", "B"],
    });
    expect(st.active[0][0]).toBe(0);
    expect(st.active[0][1]).toBe(2);
    // A can reach their own second Scoba, B has nobody spare.
    expect(benchFor(st, 0, 0)).toEqual([1]);
    expect(benchFor(st, 0, 1)).toEqual([]);
    expect(choiceError(st, { kind: "switch", side: 0, slot: 0, benchIndex: 1 })).toBeNull();
    expect(choiceError(st, { kind: "switch", side: 0, slot: 1, benchIndex: 1 })).toMatch(/other player/);
  });

  it("holds a slot open in co-op and fills it when that player joins", () => {
    const a1 = owned(wild("plib", 8, "j1"), "A");
    const b1 = owned(wild("flarea", 8, "j2"), "B");
    const st = startBattle("join", [a1], [wild("obera", 8, "j3")], {
      slots: 2,
      owners: ["A", null],
    });
    expect(st.active[0][1]).toBe(-1);
    expect(slotsAwaitingChoice(st, 0)).toEqual([0]);
    expect(choiceError(st, { kind: "switch", side: 0, slot: 1, benchIndex: 0 })).toMatch(/Nobody is playing/);

    expect(slotOf("B")).toBe(1);
    joinBattle(st, "B", [b1]);
    expect(st.slotOwner[1]).toBe("B");
    expect(st.teams[0]).toHaveLength(2);
    expect(st.active[0][1]).toBe(1);
    expect(slotsAwaitingChoice(st, 0)).toEqual([0, 1]);
    // Joining twice cannot steal a slot that is already taken.
    expect(joinBattle(st, "B", [b1])).toEqual([]);
    expect(st.teams[0]).toHaveLength(2);
  });

  it("resolves a doubles round where both characters act", () => {
    const st = startBattle(
      "double",
      [owned(wild("plib", 12, "d1"), "A"), owned(wild("flarea", 12, "d2"), "B")],
      [wild("obera", 10, "d3"), wild("grima", 10, "d4")],
      { slots: 2, owners: ["A", "B"] },
    );
    const before = st.teams[1].map((c) => c.hp);
    resolveTurn(st, [
      { kind: "attack", side: 0, slot: 0, picks: [at(st, 1, 0)] },
      { kind: "attack", side: 0, slot: 1, picks: [at(st, 1, 1)] },
    ]);
    expect(st.teams[1][0]!.hp).toBeLessThan(before[0]!);
    expect(st.teams[1][1]!.hp).toBeLessThan(before[1]!);
  });

  it("lets one character fight on after the other is wiped", () => {
    const st = startBattle(
      "solo-left",
      [owned(wild("plib", 8, "k1"), "A"), owned(wild("flarea", 8, "k2"), "B")],
      [wild("obera", 8, "k3")],
      { slots: 2, owners: ["A", "B"] },
    );
    // A's only Scoba has gone down, leaving their slot empty for good.
    const down = st.teams[0][0]!;
    down.hp = 0;
    down.fainted = true;
    st.active[0][0] = -1;
    expect(st.winner).toBe(-1);
    expect(st.active[0][0]).toBe(-1);
    // A has nobody to send in, so only B is asked for a choice.
    expect(benchFor(st, 0, 0)).toEqual([]);
    expect(slotsAwaitingChoice(st, 0)).toEqual([1]);
    resolveTurn(st, [{ kind: "attack", side: 0, slot: 1, picks: [at(st, 1, 0)] }]);
    expect(st.winner).toBe(-1);
  });

  it("replaces what fell between rounds, and the newcomer acts in the next one", () => {
    const front = owned(wild("plib", 10, "r1"), "A");
    const spare = owned(wild("grima", 10, "r2"), "A");
    const st = startBattle("replace", [front, spare], [wild("flarea", 10, "r3")], {
      slots: 1, wild: true, owners: ["A", null],
    });
    // The one out front goes down during the round.
    st.teams[0][0]!.hp = 1;
    resolveTurn(st, [
      { kind: "block", side: 0, slot: 0 },
      { kind: "attack", side: 1, slot: 0, picks: [at(st, 0, 0)] },
    ]);
    expect(st.teams[0][0]!.fainted).toBe(true);
    expect(st.active[0][0]).toBe(-1);
    expect(st.winner).toBe(-1);

    // The emptied slot is not asked about: a replacement costs no turn, so
    // nothing is picked for a slot with nobody in it.
    expect(slotsAwaitingChoice(st, 0)).toEqual([]);
    expect(emptySlots(st, 0)).toEqual([0]);

    // It walks on after the round rather than as one.
    const events = sendIn(st, 0, 0, 1);
    expect(st.active[0][0]).toBe(1);
    expect(events.some((e) => e.kind === "switch")).toBe(true);
    expect(emptySlots(st, 0)).toEqual([]);
    expect(slotsAwaitingChoice(st, 0)).toEqual([0]);

    // And picks a move in the very next round, having spent no turn arriving.
    const before = st.teams[1][0]!.hp;
    resolveTurn(st, [
      { kind: "attack", side: 0, slot: 0, picks: [at(st, 1, 0)] },
      { kind: "block", side: 1, slot: 0 },
    ]);
    expect(st.teams[1][0]!.hp).toBeLessThan(before);
  });

  it("refuses to send one in where somebody is already standing", () => {
    const st = startBattle("nosend", [owned(wild("plib", 8, "s1"), "A"), owned(wild("grima", 8, "s2"), "A")],
      [wild("flarea", 8, "s3")], { slots: 1, wild: true, owners: ["A", null] });
    expect(sendIn(st, 0, 0, 1)).toEqual([]);
    expect(st.active[0][0]).toBe(0);
  });

  it("rejects illegal choices: unknown spells, no mana, wrong context", () => {
    const st = startBattle("cheat", [wild("plib", 10, "r1")], [wild("flarea", 10, "r2")], { wild: false });
    expect(choiceError(st, { kind: "spell", side: 0, slot: 0, moveId: "flame-burst", picks: [at(st, 1, 0)] })).toMatch(/does not know/);
    expect(choiceError(st, { kind: "catch", side: 0, slot: 0 })).toMatch(/wild/);
    // Walking away is open to either kind of fight now, but only to the
    // side that walked into it.
    expect(choiceError(st, { kind: "flee", side: 1, slot: 0 })).toMatch(/challenger/);
    expect(choiceError(st, { kind: "flee", side: 0, slot: 0 })).toBeNull();
    const me = st.teams[0][0]!;
    me.mana = 10;
    expect(choiceError(st, { kind: "spell", side: 0, slot: 0, moveId: "crush", picks: [at(st, 1, 0)] })).toMatch(/mana/i);
    expect(() => resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "crush", picks: [at(st, 1, 0)] }])).toThrow(/illegal/);
  });

  it("catching is deterministic per seed and ends the battle", () => {
    const a = wild("plib", 30, "s");
    const b = wild("flarea", 3, "t");
    const st = startBattle("catchme", [a], [b], { wild: true });
    st.teams[1][0]!.hp = 1; // nearly fainted: ~85% catch chance
    expect(catchChance(st.teams[1][0]!)).toBeGreaterThan(0.75);
    let guard = 10;
    while (st.outcome === "" && guard-- > 0) {
      resolveTurn(st, [{ kind: "catch", side: 0, slot: 0 }, ...enemyChoices(st)]);
    }
    expect(st.outcome).toBe("caught");
  });

  it("fleeing ends a wild battle immediately", () => {
    const st = startBattle("run", [wild("plib", 5, "u")], [wild("flarea", 5, "v")], { wild: true });
    resolveTurn(st, [{ kind: "flee", side: 0, slot: 0 }, ...enemyChoices(st)]);
    expect(st.outcome).toBe("fled");
  });
});

function playerAuto(st: BattleState): Choice[] {
  const out: Choice[] = [];
  const side = 0 as const;
  for (const slot of [0, 1] as const) {
    const idx = st.active[side][slot]!;
    if (idx < 0) {
      if (slot === 1 && st.slots === 1) continue;
      const bench = st.teams[side].findIndex((c, i) => !c.fainted && !st.active[side].includes(i));
      if (bench >= 0) out.push({ kind: "switch", side, slot, benchIndex: bench });
      continue;
    }
    const c = st.teams[side][idx]!;
    if (c.fainted) continue;
    const targetSlot = st.active[1][0]! >= 0 ? 0 : 1;
    if (st.active[1][targetSlot]! < 0) continue;
    const picks = [{ side: 1 as const, index: st.active[1][targetSlot]! }];
    // Only moves that aim at a single enemy: the picks above suit no other shape.
    const usable = c.scoba.moves.filter(
      (m) => moveReady(c, m).ok && MOVES[m]?.targets.length === 1 && MOVES[m]?.targets[0]?.mode === "any-enemy",
    );
    if (usable.length > 0) {
      out.push({ kind: "spell", side, slot, moveId: usable[0]!, picks });
    } else {
      out.push({ kind: "attack", side, slot, picks });
    }
  }
  return out;
}
