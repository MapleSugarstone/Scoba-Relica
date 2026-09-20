import { describe, expect, it } from "vitest";
import {
  basicPower, combatantMaxHp, combatantStats, mitigation, resolveTurn, startBattle,
  type BattleState, type Choice,
} from "../src/sim/battle";
import { MOVES, SPECIES } from "../src/sim/species";
import { stacksOf } from "../src/sim/status";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { STAT_BUDGET, statTotal } from "../src/sim/types";

const wild = (id: string, lv = 30, seed = id): ScobaInstance => makeWild(id, lv, rngFrom(seed));

/** Poba and an ally against as many enemies as asked for, every bar full. */
function field(enemies = ["pieble"], slots: 1 | 2 = 1): BattleState {
  const st = startBattle(
    "poba",
    [wild("poba"), wild("pieble", 30, "ally")],
    enemies.map((e, i) => wild(e, 30, `e${i}`)),
    { slots },
  );
  for (const c of st.teams[0]) c.mana = 100;
  return st;
}

const cast = (id: string, at: { side: 0 | 1; index: number } | null = { side: 1, index: 0 }): Choice =>
  ({ kind: "spell", side: 0, slot: 0, moveId: id, picks: [at] });
const hold: Choice[] = [{ kind: "block", side: 1, slot: 0 }];
const swing = (side: 0 | 1, slot: number, at: { side: 0 | 1; index: number }): Choice =>
  ({ kind: "attack", side, slot, picks: [at] });
const said = (events: { text: string }[]): string[] => events.map((e) => e.text);

describe("the Poba line", () => {
  it("hatches as Plib and grows into Poba", () => {
    const baby = SPECIES["plib"]!;
    expect(baby.baby).toBe(true);
    expect(baby.evolvesTo).toBe("poba");
    expect(baby.starter).toBe(true);
    expect(statTotal(baby.genes)).toBe(300);
    const grown = SPECIES["poba"]!;
    expect(statTotal(grown.genes)).toBe(STAT_BUDGET);
    expect(grown.genes.mag).toBe(0);
    expect(grown.genes.str).toBeGreaterThan(grown.genes.def);
    // Both forms fight with the same four.
    expect(baby.moves).toEqual(grown.moves);
    expect(grown.moves).toEqual(["punch", "yelp", "rock-throw", "squash"]);
  });

  it("costs what the kit says", () => {
    expect(["punch", "yelp", "rock-throw", "squash"].map((id) => MOVES[id]!.manaCost))
      .toEqual([20, 20, 40, 100]);
    expect(MOVES["yelp"]!.cooldown).toBe(1);
    expect(MOVES["punch"]!.type).toBe("plain");
  });
});

describe("Very Plain", () => {
  it("reaches a basic attack, which is a Plain hit like any other", () => {
    const st = field();
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    resolveTurn(st, [swing(0, 0, { side: 1, index: 0 }), ...hold]);
    const swung = before - foe.hp;

    // The same swing with nothing powering Plain, which is the only difference.
    const bare = field();
    bare.teams[0][0]!.statuses = bare.teams[0][0]!.statuses.filter((s) => s.id !== "very-plain");
    const them = bare.teams[1][0]!;
    const was = them.hp;
    resolveTurn(bare, [swing(0, 0, { side: 1, index: 0 }), ...hold]);
    expect(swung / (was - them.hp)).toBeCloseTo(1.25, 1);

    // Half again for swinging with its own element, a quarter again from Very
    // Plain, then the target's Defense and its block, the same as any hit.
    const power = basicPower(me.scoba.level, combatantStats(me).str);
    const armor = mitigation(combatantStats(foe).def);
    expect(swung).toBe(Math.max(1, Math.floor(Math.max(1, Math.floor(power * 1.5 * 1.25 * armor)) * 0.5)));
  });

  it("makes its Plain damage a quarter stronger", () => {
    const st = field();
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    resolveTurn(st, [cast("punch"), ...hold]);
    const withIt = before - foe.hp;

    const plain = field();
    // The same fight without the passive, which is the only difference.
    plain.teams[0][0]!.statuses = plain.teams[0][0]!.statuses.filter((s) => s.id !== "very-plain");
    const bare = plain.teams[1][0]!;
    const was = bare.hp;
    resolveTurn(plain, [cast("punch"), ...hold]);
    expect(withIt / (was - bare.hp)).toBeCloseTo(1.25, 1);
  });
});

describe("Self-Defense", () => {
  it("answers physical damage with a free basic attack", () => {
    const st = field();
    expect(stacksOf(st.teams[0][0]!.statuses, "on-guard")).toBe(1);
    const events = resolveTurn(st, [
      { kind: "block", side: 0, slot: 0 },
      swing(1, 0, { side: 0, index: 0 }),
    ]);
    expect(said(events).filter((t) => t === "Poba attacks!")).toHaveLength(1);
  });

  it("spends a stack with each answer, and answers nothing once they are gone", () => {
    const st = field();
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, ...hold]);
    expect(stacksOf(me.statuses, "on-guard")).toBe(4);
    const answered: number[] = [];
    for (let i = 0; i < 6; i++) {
      me.hp = combatantMaxHp(me);
      foe.hp = combatantMaxHp(foe);
      const events = resolveTurn(st, [
        { kind: "block", side: 0, slot: 0 },
        swing(1, 0, { side: 0, index: 0 }),
      ]);
      answered.push(said(events).filter((t) => t === "Poba attacks!").length);
    }
    // One blow answered per stack, four stacks deep, and then nothing.
    expect(answered).toEqual([1, 1, 1, 1, 0, 0]);
    expect(stacksOf(me.statuses, "on-guard")).toBe(0);
  });

  it("says nothing to a magical hit", () => {
    const st = field(["cresce"]);
    const events = resolveTurn(st, [
      { kind: "block", side: 0, slot: 0 },
      { kind: "spell", side: 1, slot: 0, moveId: "moonbeam", picks: [{ side: 0, index: 0 }] },
    ]);
    expect(said(events).some((t) => t === "Poba attacks!")).toBe(false);
  });
});

describe("Hyper-Mode", () => {
  it("opens with a swing and stands three more stacks on guard", () => {
    const st = field();
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    const events = resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, ...hold]);
    expect(said(events)).toContain("Poba attacks!");
    expect(foe.hp).toBeLessThan(before);
    expect(stacksOf(st.teams[0][0]!.statuses, "on-guard")).toBe(4);
  });

  it("dents whatever it swings at, five stacks deep", () => {
    const st = field();
    const foe = st.teams[1][0]!;
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }, ...hold]);
    const was = combatantStats(foe).def;
    for (let i = 0; i < 8; i++) {
      foe.hp = combatantMaxHp(foe);
      resolveTurn(st, [swing(0, 0, { side: 1, index: 0 }), ...hold]);
    }
    expect(stacksOf(foe.statuses, "dented")).toBe(5);
    expect(combatantStats(foe).def).toBeLessThan(was);
  });
});

describe("the four moves", () => {
  it("Yelp stacks strength four deep", () => {
    const st = field();
    const me = st.teams[0][0]!;
    const before = combatantStats(me).str;
    for (let i = 0; i < 6; i++) {
      me.mana = 100;
      me.cds = {};
      resolveTurn(st, [cast("yelp", null), ...hold]);
    }
    expect(stacksOf(me.statuses, "yelped")).toBe(4);
    expect(combatantStats(me).str).toBeGreaterThan(before);
  });

  it("Rock Throw bounces on to the enemy beside its target", () => {
    const st = field(["pieble", "pieble"], 2);
    const first = st.teams[1][0]!;
    const second = st.teams[1][1]!;
    // The same Scoba twice, so what the bounce is worth is the only thing
    // between the two numbers.
    second.scoba = { ...first.scoba, uid: second.scoba.uid };
    second.statuses = structuredClone(first.statuses);
    second.hp = combatantMaxHp(second);
    const hp = [first.hp, second.hp];
    resolveTurn(st, [
      cast("rock-throw"),
      { kind: "block", side: 0, slot: 1 },
      { kind: "block", side: 1, slot: 0 },
      { kind: "block", side: 1, slot: 1 },
    ]);
    const took = [hp[0]! - first.hp, hp[1]! - second.hp];
    expect(took[0]).toBeGreaterThan(0);
    expect(took[1]).toBeGreaterThan(0);
    expect(took[1]! / took[0]!).toBeCloseTo(0.7, 1);
  });

  it("throws the rock from the first enemy to the next, ahead of the blow", () => {
    const st = field(["pieble", "pieble"], 2);
    const events = resolveTurn(st, [
      cast("rock-throw"),
      { kind: "block", side: 0, slot: 1 },
      { kind: "block", side: 1, slot: 0 },
      { kind: "block", side: 1, slot: 1 },
    ]);
    // The rock leaves the enemy it bounced off rather than the caster.
    const bounce = events.findIndex((e) => e.kind === "show" && e.off !== undefined);
    expect(bounce).toBeGreaterThan(-1);
    const leg = events[bounce]!;
    expect(leg.off).toEqual({ side: 1, index: 0 });
    expect(leg.to).toEqual([{ side: 1, index: 1 }]);
    // And it lands before the damage it delivers.
    const second = events.findIndex((e) => e.kind === "hit" && e.at?.index === 1);
    expect(second).toBeGreaterThan(bounce);
  });

  it("Squash counts the whole of the target's HP bar", () => {
    const st = field();
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    resolveTurn(st, [cast("squash"), ...hold]);
    const took = before - foe.hp;

    // The same blow with nothing but Strength behind it, which is what the
    // HP bar is worth on top of.
    const plain = field();
    const bare = plain.teams[1][0]!;
    const was = bare.hp;
    resolveTurn(plain, [cast("punch"), ...hold]);
    expect(took).toBeGreaterThan(was - bare.hp);
  });
});
