import { describe, expect, it } from "vitest";
import {
  describeAbility, describeField, describeMove, describeMoveCost, describeMoveEffects, describeStatus,
} from "../src/sim/describe";
import { ABILITIES, MOVES, type Move } from "../src/sim/species";
import { STATUSES, type StatusDef } from "../src/sim/status";

const move = (over: Partial<Move>): Move => ({
  id: "test", name: "Test", type: "sun", kind: "magical", scale: 1, manaCost: 30, cooldown: 0, startCooldown: 0,
  targets: [{ mode: "any-enemy" }], cast: [],
  ...over,
});

const status = (over: Partial<StatusDef>): StatusDef => ({
  id: "t", name: "T", polarity: "good", trigger: { on: "passive" }, duration: null, charges: null,
  stacks: false, maxStacks: 1, persists: true, effects: [],
  ...over,
});

describe("the rule, on the shapes it was written from", () => {
  it("a hit on a whole side, then an immediate follow-on", () => {
    const table = {
      ...STATUSES,
      "mana-up": status({
        id: "mana-up", trigger: { on: "battle-start" }, effects: [{ kind: "mana", on: "self", amount: 10 }],
      }),
    };
    const m = move({
      targets: [{ mode: "enemy-team" }, { mode: "ally-team" }],
      cast: [
        { kind: "hit", to: { aim: 0 }, scaling: [{ stat: "mag", scale: 1 }] },
        { kind: "heal", to: { aim: 1 }, basis: "holder-max-hp", frac: 0.1 },
      ],
    });
    expect(describeMove(m, { statuses: table })).toBe(
      "Deals 100% Sun magic damage to all enemies. Then heals all allies for 10% of their max HP. (30% mana)",
    );
  });

  it("a hit, then a triggered clause with no Then", () => {
    const table = {
      ...STATUSES,
      "kill-heal": status({
        id: "kill-heal", trigger: { on: "kill-attack" },
        effects: [{ kind: "heal", to: "self", basis: "holder-max-hp", frac: 1 }],
      }),
    };
    const m = move({
      type: "plain", kind: "physical", scale: 0.1,
      targets: [{ mode: "any-enemy" }, { mode: "self" }],
      cast: [
        { kind: "hit", to: { aim: 0 }, scaling: [{ stat: "str", scale: 0.1 }] },
        { kind: "inflict", status: "kill-heal", on: { aim: 1 } },
      ],
    });
    expect(describeMove(m, { statuses: table })).toBe(
      "Deals 10% Plain physical damage to an enemy. On kill, heals to full. (30% mana)",
    );
  });

  it("a heal, then a lasting heal with its clock", () => {
    const table = {
      ...STATUSES,
      regen: status({
        id: "regen", trigger: { on: "turn-end" }, duration: 3,
        effects: [{ kind: "heal", to: "self", basis: "holder-mag", frac: 0.1 }],
      }),
    };
    const m = move({
      kind: "heal", scale: 0.2, manaCost: 15,
      targets: [{ mode: "self" }],
      cast: [
        { kind: "heal", to: { aim: 0 }, basis: "holder-max-hp", frac: 0.2 },
        { kind: "inflict", status: "regen", on: { aim: 0 } },
      ],
    });
    expect(describeMove(m, { statuses: table })).toBe(
      "Heals for 20% of its max HP. At the end of each turn, heals for 10% Magic for 3 turns. (15% mana)",
    );
  });
});

describe("the moves in the game", () => {
  const line = (id: string): string => describeMove(MOVES[id]!);

  it("names the target once and refers back to it", () => {
    expect(line("crush")).toBe("Deals 110% Plain physical damage to an enemy. (30% mana)");
    expect(line("ember")).toBe(
      "Deals 70% Sun magic damage to an enemy. At the end of each turn, it takes 15% Sun magic damage for 3 turns. Stacks. (30% mana, cooldown 1)",
    );
    expect(line("hairline")).toBe(
      "Deals 80% Cipher magic damage to an enemy. When hit, it takes 10% of its max HP as true damage, up to 3 times for 5 turns. (35% mana, cooldown 2)",
    );
  });

  it("reads a whole side as all of them", () => {
    expect(line("scatter-shot")).toBe("Deals 80% Flux magic damage to all enemies. (50% mana, cooldown 2, first ready on turn 2)");
    expect(line("rally")).toBe("Heals all allies for 25% of their max HP. (55% mana, cooldown 3, first ready on turn 2)");
  });

  it("gives and gains what a status grants", () => {
    expect(line("fury")).toBe("Gains Strength +25% per stack, up to 6 stacks. Lost on switching out. (25% mana, cooldown 1)");
    expect(line("brace-up")).toBe("Gives an ally Defense +25% for 3 turns. Lost on switching out. (30% mana, cooldown 2)");
  });

  it("walks a transfer from one target to the other", () => {
    expect(line("blood-pact")).toBe(
      "Takes 25% of another ally's current HP. Then deals it to all enemies as true damage, split between them. (40% mana, cooldown 3, first ready on turn 2)",
    );
    expect(line("tithe")).toBe("Takes 20% of its current HP. Then heals another ally for that much. (35% mana, cooldown 2)");
  });

  it("says what the rest do", () => {
    expect(line("mirror-mark")).toBe("Copies anyone's statuses onto an ally. (45% mana, cooldown 3, first ready on turn 2)");
    expect(line("cleanse")).toBe("Clears bad statuses from an ally. (35% mana, cooldown 2)");
    expect(line("call-swarm")).toBe("Calls a level 5 Catsquito to its side. (60% mana, cooldown 4, first ready on turn 3)");
    expect(line("court-call")).toBe("Calls up a Cottlecorn Pawn at its level. (50% mana, cooldown 2)");
    expect(line("forage")).toBe("Finds 1 Snare. (20% mana, cooldown 3)");
  });

  it("describes every move without a hole", () => {
    for (const m of Object.values(MOVES)) {
      const text = describeMoveEffects(m);
      expect(text, m.id).toMatch(/^[A-Z].*\.$/);
      expect(text, m.id).not.toMatch(/undefined|NaN|\[object/);
      expect(describeMoveCost(m), m.id).toMatch(/^\(\d+% mana.*\)$/);
    }
  });
});

describe("statuses, passives and fields", () => {
  it("reads a standing effect bare and a fired one off its trigger", () => {
    expect(describeStatus("rage")).toBe("Strength +25% per stack, up to 6 stacks. Lost on switching out.");
    expect(describeStatus("fire")).toBe("At the end of each turn, takes 15% Sun magic damage for 3 turns. Stacks.");
    expect(describeStatus("fire", { duration: false })).toBe("At the end of each turn, takes 15% Sun magic damage. Stacks.");
    expect(describeStatus("second-wind")).toBe("When below 50% HP, heals for 10% of its max HP, once a battle.");
    expect(describeStatus("moonward")).toBe("Takes no Moon damage for 2 turns.");
    expect(describeStatus("spite")).toBe("On fainting, passes its statuses to whoever struck it down.");
  });

  it("folds an inflicted status into the trigger that lays it", () => {
    expect(describeAbility("piercing-horn")).toBe(
      "On a basic attack, gives the target Resistance -5% per stack, up to 6 stacks until it switches out.",
    );
    expect(describeAbility("queens-guard")).toBe(
      "On blocking, gains Speed +10% of Magic per stack, up to 6 stacks until it switches out.",
    );
    expect(describeAbility("sun-bloom")).toBe(
      "On entering the field, gives both sides Sun moves +25% for 5 turns, once a battle.",
    );
    expect(describeAbility("rooted")).toBe("Defense +10%. At the end of each turn, heals for 6% of its max HP.");
    expect(describeAbility("thirst")).toBe("On a basic attack, heals for 100% Magic.");
    expect(describeAbility("sun-ward")).toBe("Absorbs one Sun hit a battle.");
  });

  it("describes every passive and status without a hole", () => {
    for (const id of Object.keys(ABILITIES)) {
      expect(describeAbility(id), id).toMatch(/^[A-Z].*\.$/);
    }
    for (const id of Object.keys(STATUSES)) {
      const text = describeStatus(id);
      expect(text, id).toMatch(/^[A-Z].*\.$/);
      expect(text, id).not.toMatch(/undefined|NaN/);
    }
    expect(describeField("sunblessed")).toBe("Sun moves +25%.");
  });
});
