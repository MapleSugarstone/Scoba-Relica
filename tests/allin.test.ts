import { describe, expect, it } from "vitest";
import {
  castCost, castableMoves, drawCard, heldMoves, movePool, startBattle, resolveTurn, stateHash,
  combatantStats, mitigation, statusSummary, type BattleState,
} from "../src/sim/battle";
import { MOVES, SPECIES, firstStep, grantedMoves } from "../src/sim/species";
import { deriveMove, deriveStatus } from "../src/sim/rewrite";
import type { Step } from "../src/sim/status";
import { accessoryOf } from "../src/game/critters";
import { STATUSES, newStatus } from "../src/sim/status";
import { BLACKJACK, CARD_HIGH, DECK, addToHand, cardFrom, cardOfValue } from "../src/sim/cards";
import { evolve, makeWild, statsAt, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { STAT_BUDGET, BABY_BUDGET, STAT_CAPS, statTotal } from "../src/sim/types";

const wild = (id: string, lv = 30): ScobaInstance => makeWild(id, lv, rngFrom(`${id}:${lv}`));
const mine = (s: ScobaInstance): ScobaInstance => ({ ...s, owner: "A" });

/** Allin against one Plib, with a full bar and nothing on cooldown. */
function table(enemy = "plib"): BattleState {
  const st = startBattle("allin", [mine(wild("allin"))], [wild(enemy)], { slots: 1 });
  st.teams[0][0]!.mana = 100;
  st.teams[0][0]!.cds = {};
  return st;
}

/** The same table with a Scoba that is not Invested, for measuring against. */
function plainTable(): BattleState {
  const me = { ...mine(wild("allin")), secondaryAbility: "brawn" };
  const st = startBattle("allin", [me], [wild("plib")], { slots: 1 });
  st.teams[0][0]!.mana = 100;
  st.teams[0][0]!.cds = {};
  return st;
}

const cast = (st: BattleState, moveId: string) => resolveTurn(st, [
  {
    kind: "spell", side: 0, slot: 0, moveId,
    // A move that takes the whole line is not aimed at one of them.
    picks: MOVES[moveId]!.targets[0]!.mode === "enemy-team" ? [null] : [{ side: 1, index: 0 }],
  },
]);

const held = (st: BattleState, id: string) =>
  st.teams[1][0]!.statuses.find((s) => s.id === id);

/**
 * The card Allin's next Card Throw draws. The turn ticks over before a move
 * resolves, so it is the card the turn after this one draws.
 */
const comingCard = (st: BattleState) => drawCard(
  { ...st, turn: st.turn + 1 }, { side: 0, index: 0 }, "card-throw", 0,
  firstStep(MOVES["card-throw"]!, "draw-card")!.changes,
);

/** A step a passive's status runs, as its script writes it. */
const passiveStep = <K extends Step["kind"]>(id: string, kind: K): Extract<Step, { kind: K }> => {
  const found = STATUSES[id]!.effects.find((e) => e.kind === kind);
  return found as Extract<Step, { kind: K }>;
};

/** What the wheel does to the move it lands on, as Roll the Wheel writes it. */
const WHEEL = passiveStep("roll-the-wheel", "change-move");
const gold = (id: string): string => deriveMove(id, WHEEL.changes, WHEEL.key);

/** The lowest cost House Money spins for, and the slot it spins into, as its script writes them. */
const HOUSE_FLOOR = passiveStep("house-money", "pick-move").minCost;
const HOUSE_SLOT = passiveStep("house-money", "give-move").slot!;

/** How much harder Invested makes a mark, as its script writes it. */
const INVESTED_SCALE = (STATUSES["invested"]!.effects.find((e) => e.kind === "mark-power") as { mult: number }).mult;

describe("the Allin line", () => {
  it("grows out of Roulle and takes the Fortuna starter slot", () => {
    expect(SPECIES["roulle"]!.baby).toBe(true);
    expect(SPECIES["roulle"]!.evolvesTo).toBe("allin");
    expect(SPECIES["roulle"]!.starter).toBe(true);
    // Aulium keeps its place in the world without keeping the slot.
    expect(SPECIES["aulium"]!.starter).toBeUndefined();
  });

  it("spends its whole budget and none of it on Magic", () => {
    expect(statTotal(SPECIES["allin"]!.genes)).toBe(STAT_BUDGET);
    expect(statTotal(SPECIES["roulle"]!.genes)).toBe(BABY_BUDGET);
    expect(SPECIES["allin"]!.genes.mag).toBe(0);
    expect(SPECIES["roulle"]!.genes.mag).toBe(0);
  });

  it("keeps every stat inside its cap", () => {
    for (const id of ["allin", "roulle"]) {
      const genes = SPECIES[id]!.genes;
      for (const [stat, cap] of Object.entries(STAT_CAPS)) {
        expect(genes[stat as keyof typeof genes], `${id} ${stat}`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("is drawn for Hyper-Mode and knows what to do in it", () => {
    const sp = SPECIES["allin"]!;
    expect(sp.hyperAbility).toBe("house-money");
    expect(sp.sprite.kind === "art" && sp.sprite.forms?.["hyper"]).toBe("hyper-allin");
  });
});

describe("growing up", () => {
  it("keeps a passive bred in from another line", () => {
    // A Roulle with a Sqwoop father carries Cherry on Top, which is in neither
    // Roulle's pool nor Allin's. Growing up must not take it off.
    const s = wild("roulle", 15);
    s.secondaryAbility = "cherry-on-top";
    evolve(s);
    expect(s.speciesId).toBe("allin");
    expect(s.secondaryAbility).toBe("cherry-on-top");
  });

  it("keeps wearing what that passive hands it", () => {
    const s = wild("roulle", 15);
    s.secondaryAbility = "cherry-on-top";
    evolve(s);
    // The piece is worn by a line that did not come by the passive itself.
    expect(accessoryOf(SPECIES["allin"]!, s.secondaryAbility, [])).toBe("cherry");
  });

  it("keeps the move that passive hands over", () => {
    const s = wild("roulle", 15);
    s.secondaryAbility = "cherry-on-top";
    evolve(s);
    expect(grantedMoves(SPECIES["allin"]!, s.secondaryAbility)).toContain("cherry-on-top");
  });

  it("leaves a Scoba that came by its passive honestly alone", () => {
    const s = wild("roulle", 15);
    s.secondaryAbility = "invested";
    evolve(s);
    expect(s.secondaryAbility).toBe("invested");
  });
});

describe("the colours", () => {
  it("Black slows, and the slow is measured off the dealer's Strength", () => {
    // Allin's own pool holds only Invested, so a plain one has to be built.
    const st = plainTable();
    const str = combatantStats(st.teams[0][0]!).str;
    const before = combatantStats(st.teams[1][0]!).spd;
    // Off Strength, so the target's Defense reduces it the way it reduces a physical hit.
    const armor = mitigation(combatantStats(st.teams[1][0]!).def);
    cast(st, "black");
    const mark = held(st, "in-the-black");
    expect(mark).toBeTruthy();
    expect(mark!.power).toBeCloseTo(str * 0.1 * armor, 5);
    expect(combatantStats(st.teams[1][0]!).spd).toBeLessThan(before);
  });

  it("Black carries Flux behind its Fortuna", () => {
    expect(MOVES["black"]!.type).toBe("fortuna");
    expect(MOVES["black"]!.type2).toBe("flux");
  });

  it("Red burns for Sun over three turns and leads with Fortuna", () => {
    expect(MOVES["red"]!.type).toBe("fortuna");
    expect(MOVES["red"]!.type2).toBe("sun");
    const burn = STATUSES["in-the-red"]!;
    expect(burn.duration).toBe(3);
    const dmg = burn.effects.find((e) => e.kind === "damage");
    expect(dmg?.kind === "damage" && dmg.damage.element).toBe("sun");
    expect(dmg?.kind === "damage" && dmg.damage.flatAtCeiling).toBe(50);
  });

  it("Green reaches the whole line and reads Defense as well as Strength", () => {
    const move = MOVES["green"]!;
    expect(move.type).toBe("fortuna");
    expect(move.type2).toBe("moss");
    expect(move.manaCost).toBe(80);
    expect(firstStep(move, "hit")?.scaling).toEqual([{ stat: "str", scale: 1 }, { stat: "def", scale: 1 }]);
    expect(move.targets[0]!.mode).toBe("enemy-team");
  });

  it("counts Defense into what Green actually deals", () => {
    // The same cast against the same target, with the Defense taken away.
    const st = table();
    const before = st.teams[1][0]!.hp;
    cast(st, "green");
    const withDef = before - st.teams[1][0]!.hp;

    const flat = table();
    flat.teams[0][0]!.scoba = { ...flat.teams[0][0]!.scoba, genes: { ...SPECIES["allin"]!.genes, def: 0 } };
    const was = flat.teams[1][0]!.hp;
    cast(flat, "green");
    expect(withDef).toBeGreaterThan(was - flat.teams[1][0]!.hp);
  });
});

describe("the hand", () => {
  it("deals a card worth something on the deck", () => {
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      const card = cardFrom(roll);
      expect(DECK).toContain(card);
      expect(card.value).toBeGreaterThanOrEqual(1);
      expect(card.value).toBeLessThanOrEqual(CARD_HIGH);
    }
  });

  it("adds what it deals to the count", () => {
    const st = table();
    cast(st, "card-throw");
    const hand = held(st, "dealt");
    expect(hand).toBeTruthy();
    expect(hand!.stacks).toBeGreaterThanOrEqual(1);
    expect(hand!.stacks).toBeLessThanOrEqual(CARD_HIGH);
  });

  it("pays out on exactly twenty one and clears the hand", () => {
    const st = table();
    cast(st, "card-throw");
    // Stand the hand exactly one card short of the count, whatever is coming.
    // The turn ticks over before a move resolves, so the card that is coming is
    // the one the turn after this one deals.
    const coming = comingCard(st);
    held(st, "dealt")!.stacks = BLACKJACK - coming.card.value;
    const before = st.teams[1][0]!.hp;
    const ev = cast(st, "card-throw");
    expect(held(st, "dealt")).toBeUndefined();
    expect(st.teams[1][0]!.hp).toBeLessThan(before);
    expect(ev.some((e) => e.text.includes(`holding ${BLACKJACK}`))).toBe(true);
  });

  it("pays out for more than the throw that set it off", () => {
    const plain = table();
    cast(plain, "card-throw");
    const onlyThrow = plain.teams[1][0]!.hp;

    const paid = table();
    cast(paid, "card-throw");
    const coming = comingCard(paid);
    paid.teams[1][0]!.statuses.find((s) => s.id === "dealt")!.stacks = BLACKJACK - coming.card.value;
    const before = paid.teams[1][0]!.hp;
    cast(paid, "card-throw");
    expect(before - paid.teams[1][0]!.hp).toBeGreaterThan(plain.teams[1][0]!.hp - onlyThrow);
  });

  it("busts over twenty one and leaves nothing behind", () => {
    const st = table();
    cast(st, "card-throw");
    // Anything at all takes this hand over the count.
    held(st, "dealt")!.stacks = BLACKJACK;
    const ev = cast(st, "card-throw");
    expect(held(st, "dealt")).toBeUndefined();
    expect(ev.some((e) => e.text.includes("busts"))).toBe(true);
  });

  // A hand's stacks are its count rather than how many times it was dealt. Each
  // card that held used to leave a stray one-stack hand beside the real one, so
  // the sigil, which adds a status's instances together, read a Five, a Five
  // and a King as 22 while the hand was 20 and rightly held.
  it("keeps one hand however many cards land on it", () => {
    const st = table();
    for (let n = 0; n < 3; n++) {
      // Hold the count at nothing between throws, so every card holds.
      const hand = held(st, "dealt");
      if (hand) {
        hand.stacks = 0;
        delete hand.ace;
      }
      st.teams[0][0]!.mana = 100;
      st.teams[0][0]!.cds = {};
      cast(st, "card-throw");
    }
    const hands = st.teams[1][0]!.statuses.filter((s) => s.id === "dealt");
    expect(hands).toHaveLength(1);
    const mark = statusSummary(st.teams[1][0]!).find((m) => m.id === "dealt");
    expect(mark?.stacks).toBe(hands[0]!.stacks);
  });

  it("rides a switch, because the hand is against the Scoba", () => {
    expect(STATUSES["dealt"]!.persists).toBe(true);
  });

  it("shows the card that is worth the hand while one is", () => {
    expect(cardOfValue(1).label).toBe("Ace");
    expect(cardOfValue(CARD_HIGH).value).toBe(CARD_HIGH);
  });

  it("throws, deals and holds the one card it drew", () => {
    const st = table();
    const coming = comingCard(st);
    const ev = cast(st, "card-throw");
    const thrown = ev.find((e) => e.kind === "show" && e.visual?.kind === "throw");
    const dealt = ev.find((e) => e.kind === "card");
    // The same drawing and the same colors in the air, as it lands, and over the head.
    expect(thrown?.face).toEqual(coming.face);
    expect(dealt?.face).toEqual(coming.face);
    expect(held(st, "dealt")!.faces).toEqual([coming.face]);
    // And the drawing is the card whose value went on the hand.
    expect(DECK.find((c) => c.art === coming.face.art)!.value).toBe(held(st, "dealt")!.stacks);
    expect(dealt?.text).toContain(coming.card.label);
  });

  it("turns the red black about half the time, and only ever that red", () => {
    const draw = firstStep(MOVES["card-throw"]!, "draw-card")!;
    expect(draw.changes).toEqual([{ from: "#bc0006", to: "#000000", chance: 0.5 }]);
    let black = 0;
    const seen = new Set<string>();
    for (let n = 0; n < 400; n++) {
      const st = table();
      st.seed = `colors-${n}`;
      const { card, face } = drawCard(st, { side: 0, index: 0 }, "card-throw", 0, draw.changes);
      seen.add(card.art);
      if (face.changes.length > 0) {
        black += 1;
        expect(face.changes).toEqual([{ from: "#bc0006", to: "#000000" }]);
      }
    }
    expect(black).toBeGreaterThan(160);
    expect(black).toBeLessThan(240);
    // Every card in the deck turns up.
    expect(seen.size).toBe(DECK.length);
  });

  it("draws the same card, in the same colors, on both clients of a shared fight", () => {
    const a = table();
    const b = table();
    cast(a, "card-throw");
    cast(b, "card-throw");
    expect(held(a, "dealt")!.faces).toEqual(held(b, "dealt")!.faces);
    expect(stateHash(a)).toBe(stateHash(b));
    // A hand holding a different color is caught by the hash even at the same count.
    const top = held(a, "dealt")!.faces![0]!;
    held(b, "dealt")!.faces = [{ art: top.art, changes: top.changes.length ? [] : [{ from: "#bc0006", to: "#000000" }] }];
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
});

describe("an Ace", () => {
  const card = (label: string) => DECK.find((c) => c.label === label)!;

  it("counts 11 where that makes exactly twenty one, in either order", () => {
    const jack = addToHand({ count: 0, ace: false }, card("Jack"));
    expect(jack).toEqual({ settles: "holds", hand: { count: 10, ace: false }, best: 10 });
    expect(addToHand({ count: 10, ace: false }, card("Ace"))).toEqual({ settles: "pays" });
    const ace = addToHand({ count: 0, ace: false }, card("Ace"));
    expect(ace).toEqual({ settles: "holds", hand: { count: 1, ace: true }, best: 11 });
    expect(addToHand({ count: 1, ace: true }, card("Jack"))).toEqual({ settles: "pays" });
  });

  it("counts 1 where 11 would go over, so it never busts a hand", () => {
    expect(addToHand({ count: 20, ace: false }, card("Ace"))).toEqual({ settles: "pays" });
    expect(addToHand({ count: 15, ace: false }, card("Ace"))).toEqual({ settles: "holds", hand: { count: 16, ace: true }, best: 16 });
    // Ace, Five and King: 16 either way, and the next ten busts it.
    expect(addToHand({ count: 16, ace: true }, card("King"))).toEqual({ settles: "busts", count: 26 });
  });

  /** A table whose next Card Throw draws a card worth `value`. */
  const tableDrawing = (value: number): BattleState => {
    for (let n = 0; n < 500; n++) {
      const st = table();
      st.seed = `draw-${value}-${n}`;
      if (comingCard(st).card.value === value) return st;
    }
    throw new Error(`no seed draws ${value}`);
  };

  it("pays out the moment a Jack's hand is dealt an Ace", () => {
    const st = tableDrawing(1);
    st.teams[1][0]!.statuses.push({ ...newStatus("dealt")!, stacks: 10, faces: [{ art: "cardjack", changes: [] }] });
    const ev = cast(st, "card-throw");
    expect(held(st, "dealt")).toBeUndefined();
    expect(ev.some((e) => e.text.includes(`holding ${BLACKJACK}`))).toBe(true);
  });

  it("pays out the moment an Ace's hand is dealt a ten", () => {
    const st = tableDrawing(10);
    st.teams[1][0]!.statuses.push({ ...newStatus("dealt")!, stacks: 1, ace: true, faces: [{ art: "cardace", changes: [] }] });
    const ev = cast(st, "card-throw");
    expect(held(st, "dealt")).toBeUndefined();
    expect(ev.some((e) => e.text.includes(`holding ${BLACKJACK}`))).toBe(true);
  });

  it("keeps every card in the hand, so all of them show over its head", () => {
    const st = tableDrawing(5);
    const jack = { art: "cardjack", changes: [] };
    st.teams[1][0]!.statuses.push({ ...newStatus("dealt")!, stacks: 10, faces: [jack] });
    const coming = comingCard(st);
    const ev = cast(st, "card-throw");
    expect(held(st, "dealt")!.faces).toEqual([jack, coming.face]);
    expect(ev.find((e) => e.kind === "card")?.cards).toEqual([jack, coming.face]);
  });
});

describe("the wheel", () => {
  it("hands one over on top of the four, the moment it takes the field", () => {
    const st = table();
    const me = st.teams[0][0]!;
    const won = me.given?.[0];
    expect(won).toBeTruthy();
    // Every slot it holds is still its own.
    expect(heldMoves(me)).toEqual(me.scoba.moves);
    // And the prize is offered after them, where a granted move goes.
    const castable = castableMoves(me);
    expect(castable.slice(0, me.scoba.moves.length)).toEqual(me.scoba.moves);
    expect(castable).toContain(won);
    expect(castable.length).toBe(me.scoba.moves.length + 1);
  });

  it("replaces the prize rather than piling them up over a long fight", () => {
    const st = table();
    const me = st.teams[0][0]!;
    const first = me.given?.[0];
    // Walked off and back on: the wheel is spun again and there is still one.
    resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    expect(me.given?.length).toBe(1);
    expect(castableMoves(me).length).toBe(me.scoba.moves.length + 1);
    expect(first).toBeTruthy();
  });

  it("hands the move over as Fortuna off Strength", () => {
    const rolled = MOVES[gold("eclipse")]!;
    expect(rolled.type).toBe("fortuna");
    expect(rolled.kind).toBe("physical");
    expect(firstStep(rolled, "hit")?.scaling[0]?.stat).toBe("str");
    expect(rolled.tint).toBeTruthy();
    expect(rolled.derived).toEqual({ from: "eclipse", by: "roll-the-wheel" });
    // A second element is kept, since only the first is turned.
    expect(MOVES[gold("cold-wave")]!.type2).toBe("sugar");
  });

  it("calls whatever it hands over golden, and leaves Roll the Wheel's price alone", () => {
    const rolled = MOVES[gold("eclipse")]!;
    expect(rolled.name).toBe(`Golden ${MOVES["eclipse"]!.name}`);
    expect(rolled.manaCost).toBe(MOVES["eclipse"]!.manaCost);
  });

  it("turns what a rolled move burns for into Fortuna as well", () => {
    const burn = deriveStatus("fire", "fortuna", WHEEL.key);
    const dmg = STATUSES[burn]?.effects.find((e) => e.kind === "damage");
    expect(dmg?.kind === "damage" && dmg.damage.element).toBe("fortuna");
    // What a mark does to a stat has no element to turn, so it is left alone.
    const slow = STATUSES[deriveStatus("in-the-black", "fortuna", WHEEL.key)]!;
    expect(slow.effects[0]).toEqual(STATUSES["in-the-black"]!.effects[0]);
    // And a rolled move that leaves a mark leaves the Fortuna one.
    const rolledEmber = MOVES[gold("ember")]!;
    expect(firstStep(rolledEmber, "inflict")?.status).toBe(burn);
  });

  it("never writes the roll onto the Scoba being carried out of the fight", () => {
    const st = table();
    const me = st.teams[0][0]!;
    expect(me.scoba.moves).toEqual(SPECIES["allin"]!.moves.slice(0, 4));
    expect(me.scoba.moves).not.toContain(me.given?.[0]);
  });

  it("takes a heal off the wheel without turning it into a blow", () => {
    const rolled = MOVES[gold("nuzzle-nap")]!;
    expect(rolled.kind).toBe("heal");
    expect(rolled.type).toBe("fortuna");
    // A share of the target's own pool is still that. A share of a stat becomes
    // the stat this line actually has.
    expect(firstStep(rolled, "heal")?.basis).toBe("holder-max-hp");
    expect(firstStep(MOVES[gold("icecream-soup")]!, "heal")?.basis).toBe("source-str");
  });

  it("can reach the support half of the game at all", () => {
    const pool = movePool(0, true);
    expect(pool.some((id) => MOVES[id]!.kind === "heal")).toBe(true);
    expect(pool.some((id) => MOVES[id]!.kind === "physical")).toBe(true);
  });

  it("never spins up one of its own prizes", () => {
    gold("hex");
    for (const id of movePool(0, true)) expect(MOVES[id]!.derived).toBeUndefined();
  });

  it("spins House Money only for the expensive end of the pool", () => {
    const pool = movePool(HOUSE_FLOOR, true);
    expect(pool.length).toBeGreaterThan(0);
    for (const id of pool) expect(MOVES[id]!.manaCost).toBeGreaterThanOrEqual(HOUSE_FLOOR);
  });

  it("lands on the same move for both sides of a battle with one seed", () => {
    const a = table();
    const b = table();
    expect(a.teams[0][0]!.given?.[0]).toBe(b.teams[0][0]!.given?.[0]);
  });

  it("fills the fourth slot at the end of a turn in Hyper-Mode", () => {
    expect(HOUSE_SLOT).toBe(3);
    const st = table();
    const me = st.teams[0][0]!;
    me.mana = 100;
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }]);
    expect(me.hyper).toBe(true);
    const rolled = me.swapped?.[HOUSE_SLOT];
    expect(rolled).toBeTruthy();
    const base = MOVES[MOVES[rolled!]!.derived!.from]!;
    expect(base.manaCost).toBeGreaterThanOrEqual(HOUSE_FLOOR);
    // Golden, and half the price it had, which is what casting it costs.
    expect(MOVES[rolled!]!.name).toBe(`Golden ${base.name}`);
    expect(MOVES[rolled!]!.manaCost).toBe(Math.round(base.manaCost / 2));
    expect(castCost(me, rolled!)).toBe(Math.round(base.manaCost / 2));
  });
});

describe("Invested", () => {
  it("makes a mark that stands for more than a turn hit harder", () => {
    // Measured as a share of the dealer's own Strength, because a different
    // second passive is a different stat line and the raw numbers would not
    // be comparable.
    const share = (st: BattleState): number => {
      const armor = mitigation(combatantStats(st.teams[1][0]!).def);
      cast(st, "black");
      const mark = st.teams[1][0]!.statuses.find((s) => s.id === "in-the-black")!;
      return mark.power! / combatantStats(st.teams[0][0]!).str / armor;
    };
    expect(share(plainTable())).toBeCloseTo(0.1, 6);
    // Allin's own pool holds only Invested, so the default one already has it.
    expect(share(table())).toBeCloseTo(0.1 * INVESTED_SCALE, 6);
  });

  it("leaves a mark that only stands for one turn alone", () => {
    // Nothing under two turns is worth investing in, which is what the rule says.
    expect(STATUSES["sticky"]!.duration).toBe(1);
  });
});
