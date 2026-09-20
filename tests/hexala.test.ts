import { describe, expect, it } from "vitest";
import {
  resolveTurn, startBattle,
  type Answer, type BattleState, type Choice,
} from "../src/sim/battle";
import { MOVES, SPECIES } from "../src/sim/species";
import { stacksOf } from "../src/sim/status";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { statTotal } from "../src/sim/types";

const wild = (id: string, lv = 30, seed = id): ScobaInstance => makeWild(id, lv, rngFrom(seed));

/** Hexala against two sturdy wilds, every bar full. */
function field(answers: Answer[] = [], id = "hexala"): BattleState {
  const st = startBattle(
    "hexala",
    [wild(id), wild("pieble")],
    [wild("pieble", 30, "foeA"), wild("pieble", 30, "foeB")],
    { slots: 2, answers },
  );
  for (const c of st.teams[0]) c.mana = 100;
  return st;
}

const brace: Choice[] = [
  { kind: "block", side: 0, slot: 1 },
  { kind: "block", side: 1, slot: 0 },
  { kind: "block", side: 1, slot: 1 },
];
const hold: Choice = { kind: "block", side: 0, slot: 0 };
const FIRST = { side: 1 as const, index: 0 };
const SECOND = { side: 1 as const, index: 1 };
const spell = (id: string, at = FIRST): Choice => ({ kind: "spell", side: 0, slot: 0, moveId: id, picks: [at] });

describe("the Hexala line", () => {
  it("hatches as Wispen and grows into Hexala", () => {
    const baby = SPECIES["wispen"]!;
    expect(baby.baby).toBe(true);
    expect(baby.evolvesTo).toBe("hexala");
    expect(baby.starter).toBe(true);
    expect(statTotal(baby.genes)).toBe(300);
    const grown = SPECIES["hexala"]!;
    expect(statTotal(grown.genes)).toBe(500);
    expect(grown.genes.str).toBe(0);
    // Both forms fight with the same four.
    expect(baby.moves).toEqual(grown.moves);
    expect(grown.moves).toEqual(["minor-curse", "fireball", "lightning-bolt", "crystal-ball"]);
  });

  it("costs what the kit says", () => {
    expect(["minor-curse", "fireball", "lightning-bolt", "crystal-ball"].map((id) => MOVES[id]!.manaCost))
      .toEqual([15, 20, 30, 60]);
    expect(MOVES["minor-curse"]!.cooldown).toBe(1);
    expect(MOVES["crystal-ball"]!.cooldown).toBe(5);
    expect(MOVES["lightning-bolt"]!.type2).toBe("cipher");
    expect(MOVES["fireball"]!.type).toBe("firework");
  });
});

describe("Hex", () => {
  it("stops the opening to ask which enemy it is for", () => {
    const st = field();
    expect(st.asking).toHaveLength(1);
    const [q] = st.asking!;
    expect(q!.at).toEqual({ side: 0, index: 0 });
    expect(q!.prompt).toBe("Who do you hex?");
    expect(q!.options.map((o) => o.index)).toEqual([0, 1]);
    // Nothing is hexed until it is answered.
    expect(st.teams[1].some((c) => stacksOf(c.statuses, "hexed") > 0)).toBe(false);
  });

  it("lands on whoever was picked, and on nobody else", () => {
    const st = field([{ pick: SECOND }]);
    expect(st.asking).toBeUndefined();
    expect(stacksOf(st.teams[1][1]!.statuses, "hexed")).toBe(1);
    expect(stacksOf(st.teams[1][0]!.statuses, "hexed")).toBe(0);
  });

  it("takes a share of Magic off the hexed one at the end of each turn, and does not stack", () => {
    const st = field([{ pick: FIRST }]);
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    resolveTurn(st, [hold, ...brace]);
    const lost = before - foe.hp;
    expect(lost).toBeGreaterThan(0);
    expect(stacksOf(foe.statuses, "hexed")).toBe(1);
    // Seven turns of it, and no second stack however long it stands.
    resolveTurn(st, [hold, ...brace]);
    expect(stacksOf(foe.statuses, "hexed")).toBe(1);
    expect(before - foe.hp).toBeGreaterThan(lost);
  });

  it("asks again on going Hyper, and hexes both enemies once it is answered", () => {
    const stopped = field([{ pick: FIRST }]);
    const hyper: Choice[] = [{ kind: "hyper", side: 0, slot: 0 }, ...brace];
    resolveTurn(stopped, hyper);
    // Hyper-Mode is an entry of its own, so Hex asks where it is going this time.
    expect(stopped.asking).toHaveLength(1);

    const st = field([{ pick: FIRST }]);
    resolveTurn(st, hyper, [{ pick: SECOND }]);
    expect(st.asking).toBeUndefined();
    expect(st.teams[1].every((c) => stacksOf(c.statuses, "hexed") > 0)).toBe(true);
  });
});

describe("Ward Bubble", () => {
  it("opens a bubble on entry that cuts the next hit, once a battle", () => {
    const st = field([{ pick: FIRST }]);
    const me = st.teams[0][0]!;
    expect(stacksOf(me.statuses, "bubble")).toBe(1);
    resolveTurn(st, [hold, { kind: "block", side: 0, slot: 1 },
      { kind: "attack", side: 1, slot: 0, picks: [{ side: 0, index: 0 }] },
      { kind: "block", side: 1, slot: 1 }]);
    // Spent on the hit it caught.
    expect(stacksOf(me.statuses, "bubble")).toBe(0);
  });
});

describe("the three spells", () => {
  it("curses, burns in stacks, and slows", () => {
    const st = field([{ pick: FIRST }]);
    const foe = st.teams[1][0]!;
    resolveTurn(st, [spell("minor-curse"), ...brace]);
    expect(stacksOf(foe.statuses, "cursed")).toBe(1);

    st.teams[0][0]!.mana = 100;
    resolveTurn(st, [spell("fireball"), ...brace]);
    st.teams[0][0]!.mana = 100;
    resolveTurn(st, [spell("fireball"), ...brace]);
    expect(stacksOf(foe.statuses, "burned")).toBe(2);

    st.teams[0][0]!.mana = 100;
    resolveTurn(st, [spell("lightning-bolt"), ...brace]);
    expect(stacksOf(foe.statuses, "jolted")).toBe(1);
  });

});

const ball: Choice = { kind: "spell", side: 0, slot: 0, moveId: "crystal-ball", picks: [null] };

describe("Crystal Ball", () => {
  it("stops the round before anything else happens", () => {
    const st = field();
    const events = resolveTurn(st, [ball, ...brace]);
    expect(events.map((e) => e.text).filter((t) => t !== "")).toEqual(["Hexala cast Crystal Ball!"]);
    expect(st.asking?.length).toBe(1);
    expect(st.asking?.[0]!.kind).toBe("act");
    expect(st.asking?.[0]!.at).toEqual({ side: 0, index: 0 });
  });

  it("takes the action it was answered with, and pays for both", () => {
    // Under a full bar, so what the turn's own mana adds is not capped away.
    const st = field();
    st.teams[0][0]!.mana = 80;
    resolveTurn(st, [ball, ...brace], [{ pick: null, act: spell("minor-curse") }]);
    expect(st.asking).toBeUndefined();
    expect(stacksOf(st.teams[1][0]!.statuses, "cursed")).toBe(1);

    const plain = field();
    plain.teams[0][0]!.mana = 80;
    resolveTurn(plain, [spell("minor-curse"), ...brace]);
    expect(st.teams[0][0]!.mana).toBe(plain.teams[0][0]!.mana - MOVES["crystal-ball"]!.manaCost);
  });

  it("holds still where nobody answers it, or where the answer will not stand", () => {
    const quiet = field();
    const events = resolveTurn(quiet, [ball, ...brace], [{ pick: null }]);
    expect(events.some((e) => e.text === "Hexala braces.")).toBe(true);

    // Sixty of sixty mana on the ball leaves nothing to curse with.
    const broke = field();
    broke.teams[0][0]!.mana = MOVES["crystal-ball"]!.manaCost;
    const poor = resolveTurn(broke, [ball, ...brace], [{ pick: null, act: spell("minor-curse") }]);
    expect(poor.some((e) => e.text === "Hexala braces.")).toBe(true);
    expect(stacksOf(broke.teams[1][0]!.statuses, "cursed")).toBe(0);
  });

  it("can be answered with flight, which the round has not checked for yet", () => {
    const st = field();
    resolveTurn(st, [ball, ...brace], [{ pick: null, act: { kind: "flee", side: 0, slot: 0 } }]);
    expect(st.outcome).toBe("fled");
  });

  it("files the round under what it did instead, so a rewind does not ask again", () => {
    const st = field();
    resolveTurn(st, [ball, ...brace], [{ pick: null, act: spell("fireball") }]);
    const filed = st.history!.at(-1)!.choices;
    expect(filed.some((c) => c.kind === "spell" && c.moveId === "crystal-ball")).toBe(false);
    expect(filed.some((c) => c.kind === "spell" && c.moveId === "fireball")).toBe(true);
  });
});
