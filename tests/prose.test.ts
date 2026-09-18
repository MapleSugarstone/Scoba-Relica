import { describe, expect, it } from "vitest";
import { TOKENS, flattenProse, parseProse, readToken } from "../src/sim/prose";
import { describeAbility, describeField, describeMoveEffects, describeStatus } from "../src/sim/describe";
import { ABILITIES, MOVES, allSteps, type Move } from "../src/sim/species";
import { FIELDS, STATUSES, powerCategory } from "../src/sim/status";
import type { Stats } from "../src/sim/types";
import { makeWild, scobaTypes, statsAt } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const coldWave = MOVES["cold-wave"]!;
const cardThrow = MOVES["card-throw"]!;

/** A stat line with the ones a case cares about filled in. */
const statsFor = (some: Partial<Stats>): Stats =>
  ({ hp: 0, str: 0, def: 0, res: 0, mag: 0, spd: 0, ...some });

const labels = (template: string, move = coldWave): string[] =>
  parseProse(template, { move }).filter((p) => p.kind === "token").map((p) => p.label);
const details = (template: string, move = coldWave): string[] =>
  parseProse(template, { move }).filter((p) => p.kind === "token").map((p) => p.detail);

describe("reading one bracket", () => {
  it("knows the ones it is meant to know", () => {
    expect(readToken("damage")?.token).toEqual({ of: "damage" });
    expect(readToken("heal")?.token).toEqual({ of: "heal" });
    expect(readToken("status:cold")?.token).toEqual({ of: "status", id: "cold" });
  });

  it("reads a number after the colon as a place in the cast", () => {
    expect(readToken("damage:2")?.token).toEqual({ of: "damage", nth: 2 });
    expect(readToken("heal:3")?.token).toEqual({ of: "heal", nth: 3 });
    expect(readToken("damage:in-the-red")?.token).toEqual({ of: "damage", id: "in-the-red" });
  });

  it("has nothing for the cost or the type, which are shown beside the name", () => {
    expect(readToken("cost")).toBeNull();
    expect(readToken("type")).toBeNull();
  });

  it("takes a word of your own to show in place of the name", () => {
    const read = readToken("status:cold|slows");
    expect(read?.token).toEqual({ of: "status", id: "cold" });
    expect(read?.label).toBe("slows");
  });

  it("ignores the spaces around what is written", () => {
    expect(readToken(" status : cold | slows ")?.token).toEqual({ of: "status", id: "cold" });
  });

  it("says no to anything it does not know", () => {
    expect(readToken("")).toBeNull();
    expect(readToken("wobble")).toBeNull();
    expect(readToken("status")).toBeNull();
    expect(readToken("status:")).toBeNull();
  });
});

describe("the lines the moves ship with", () => {
  const written = Object.values(MOVES).filter((m) => m.text !== undefined && !m.derived);

  it("covers every move", () => {
    const bare = Object.values(MOVES).filter((m) => m.text === undefined && !m.derived);
    expect(bare.map((m) => m.id)).toEqual([]);
  });

  it("reads as a sentence", () => {
    for (const move of written) {
      expect(move.text, move.id).toMatch(/^[A-Z]/);
      expect(move.text, move.id).toMatch(/\.$/);
    }
  });

  it("leaves no bracket the parser cannot read", () => {
    for (const move of written) {
      // Every bracket in a shipped line has to resolve. One that does not would
      // print as literal brackets in the middle of the sentence.
      for (const inside of move.text!.match(/\[[^\]]*\]/g) ?? []) {
        expect(readToken(inside.slice(1, -1)), `${move.id} ${inside}`).not.toBeNull();
      }
      expect(flattenProse(move.text!, { move }), move.id).not.toContain("[");
    }
  });

  it("names only marks that exist", () => {
    for (const move of written) {
      for (const inside of move.text!.match(/\[status:[^\]]*\]/g) ?? []) {
        const read = readToken(inside.slice(1, -1));
        const id = read?.token.of === "status" ? read.token.id : "";
        expect(STATUSES[id], `${move.id} ${inside}`).toBeTruthy();
      }
    }
  });

  it("says what a move that hits for something hits for", () => {
    for (const move of written) {
      if (move.kind === "physical" || move.kind === "magical") {
        expect(move.text, move.id).toContain("[damage]");
      }
      if (move.kind === "heal") expect(move.text, move.id).toContain("[heal]");
    }
  });

  it("names every mark a move actually leaves", () => {
    for (const move of written) {
      for (const e of allSteps(move.cast)) {
        if (e.kind !== "inflict") continue;
        expect(move.text, `${move.id} leaves ${e.status}`).toContain(`[status:${e.status}`);
      }
    }
  });
});

describe("the lines the passives ship with", () => {
  const written = Object.values(ABILITIES).filter((a) => a.text !== undefined);

  it("covers every passive", () => {
    const bare = Object.values(ABILITIES).filter((a) => a.text === undefined);
    expect(bare.map((a) => a.id)).toEqual([]);
  });

  it("reads as a sentence", () => {
    for (const ability of written) {
      expect(ability.text, ability.id).toMatch(/^[A-Z]/);
      expect(ability.text, ability.id).toMatch(/\.$/);
    }
  });

  it("leaves no bracket the parser cannot read", () => {
    for (const ability of written) {
      for (const inside of ability.text!.match(/\[[^\]]*\]/g) ?? []) {
        expect(readToken(inside.slice(1, -1)), `${ability.id} ${inside}`).not.toBeNull();
      }
      expect(flattenProse(ability.text!, {}), ability.id).not.toContain("[");
    }
  });

  it("names only marks and fields that exist", () => {
    for (const ability of written) {
      for (const inside of ability.text!.match(/\[(status|damage|heal):[^\]]*\]/g) ?? []) {
        const part = parseProse(inside, {})[0];
        expect(part?.kind, `${ability.id} ${inside}`).toBe("token");
        expect(part && part.kind === "token" ? part.detail : "", `${ability.id} ${inside}`)
          .not.toMatch(/^No /);
      }
    }
  });
});

describe("the note on a number", () => {
  // The share it scales off, then at most what reduces it. Nothing about the
  // move or the mark the number belongs to.
  const SCALING_ONLY = /^\d[^.]*(\.\d[^.]*)*\.( (Physical|Magical) (damage|statuses) (is|are) reduced by the target's (Defense|Resistance)\.| True damage ignores target's defenses\.)?$/;

  it("explains the scaling and nothing else", () => {
    const notes: [string, string][] = [];
    for (const move of Object.values(MOVES)) {
      for (const part of parseProse("[damage] [heal] [scaling:1] [scaling:2] [scaling:3] [damage:2]", { move })) {
        if (part.kind === "token" && part.label !== "?") notes.push([move.id, part.detail]);
      }
    }
    for (const id of Object.keys(STATUSES)) {
      for (const part of parseProse(`[damage:${id}] [heal:${id}] [power:${id}]`, {})) {
        if (part.kind === "token" && !part.detail.startsWith("No ")) notes.push([id, part.detail]);
      }
    }
    expect(notes.length).toBeGreaterThan(20);
    expect(notes.filter(([, note]) => !SCALING_ONLY.test(note))).toEqual([]);
  });
});

describe("words the game does not use", () => {
  const BANNED = /\bbites?\b|as it arrives/i;

  it("keeps them out of every line and note a player can read", () => {
    const lines: [string, string][] = [];
    for (const move of Object.values(MOVES)) {
      if (move.text) lines.push([`${move.id} text`, move.text]);
      lines.push([`${move.id} described`, describeMoveEffects(move)]);
      for (const part of parseProse("[damage] [heal] [scaling:1] [scaling:2] [scaling:3]", { move })) {
        if (part.kind === "token") lines.push([`${move.id} note`, part.detail]);
      }
    }
    for (const ability of Object.values(ABILITIES)) {
      if (ability.text) lines.push([`${ability.id} text`, ability.text]);
      lines.push([`${ability.id} described`, describeAbility(ability.id)]);
    }
    for (const id of Object.keys(STATUSES)) {
      lines.push([`${id} described`, describeStatus(id)]);
      for (const part of parseProse(`[damage:${id}] [heal:${id}] [power:${id}]`, {})) {
        if (part.kind === "token") lines.push([`${id} note`, part.detail]);
      }
    }
    for (const id of Object.keys(FIELDS)) lines.push([`${id} described`, describeField(id)]);
    for (const token of TOKENS) lines.push([token.form, token.says]);
    expect(lines.filter(([, text]) => BANNED.test(text))).toEqual([]);
  });
});

describe("a mark's power, and every scaled number in order", () => {
  const black = MOVES["black"]!;

  it("reads the new brackets", () => {
    expect(readToken("power:in-the-black")?.token).toEqual({ of: "power", id: "in-the-black" });
    expect(readToken("scaling:2")?.token).toEqual({ of: "scaling", nth: 2 });
    expect(readToken("scaling")?.token).toEqual({ of: "scaling", nth: 1 });
    expect(readToken("power")).toBeNull();
    expect(readToken("scaling:two")).toBeNull();
  });

  it("reads what a mark's power takes off a stat", () => {
    const part = parseProse("[power:in-the-black]", {})[0];
    expect(part).toMatchObject({ label: "10% Strength" });
    expect(part?.kind === "token" && part.detail).toContain("10% of the caster's Strength");
    expect(parseProse("[power:in-the-black]", { stats: statsFor({ str: 200 }) })[0]).toMatchObject({ label: "20" });
    expect(parseProse("[power:in-the-green]", {})[0]).toMatchObject({ label: "30% Strength" });
  });

  /** The last line of a token's working, which is what the number meets. */
  const meets = (token: string): string | undefined => {
    const part = parseProse(token, {})[0];
    return part?.kind === "token" ? part.work?.at(-1)?.label : undefined;
  };

  it("says what reduces a mark the way a hit's note does, by the stat it scales off", () => {
    // The opening line says where the number comes from; what it meets is the
    // last line of the working, the same way a hit's is.
    expect(parseProse("[power:in-the-black]", {})[0]).toMatchObject({
      tone: "physical",
      detail: "10% of the caster's Strength.",
    });
    expect(meets("[power:in-the-black]")).toBe("Physical statuses are reduced by the target's Defense.");
    expect(parseProse("[power:slowed]", {})[0]).toMatchObject({
      tone: "magic",
      detail: "30% of the caster's Magic.",
    });
    expect(meets("[power:slowed]")).toBe("Magical statuses are reduced by the target's Resistance.");
    expect(meets("[damage:in-the-red]")).toBe("Magical statuses are reduced by the target's Resistance.");
    expect(details("[damage:in-the-red]")[0]).toBe(
      "20% of the caster's Strength plus 1.67 damage per level.",
    );
  });

  it("colours and notes true damage as ignoring defenses", () => {
    STATUSES["probe-true"] = {
      ...STATUSES["in-the-red"]!,
      id: "probe-true",
      effects: [{
        kind: "damage",
        to: "self",
        damage: {
          basis: "holder-max-hp", frac: 0.1, element: "plain", category: "true",
          damageClass: "attack", triggersOnHit: false, snapshot: false,
        },
      }],
    } as never;
    try {
      expect(parseProse("[damage:probe-true]", {})[0]).toMatchObject({
        tone: "true",
        detail: "10% of its own maximum HP.",
      });
      expect(meets("[damage:probe-true]")).toBe("True damage ignores target's defenses.");
    } finally {
      delete STATUSES["probe-true"];
    }
    // Flat damage is only a flat base, and the hit is reduced like any other.
    expect(parseProse("[damage]", { move: MOVES["cherry-on-top"]! })[0]).toMatchObject({
      tone: "physical",
      detail: "2 damage per level of the caster. Physical damage is reduced by the target's Defense.",
    });
    // A mark that only raises a stat meets no armor, so it reads as true.
    const lift = { ...STATUSES["in-the-black"]!, effects: [{ kind: "stat-power" as const, stat: "spd" as const, mult: 1 }] };
    expect(powerCategory(lift)).toBe("true");
    expect(powerCategory(STATUSES["in-the-black"]!)).toBe("physical");
  });

  it("says so where a mark has no power", () => {
    expect(parseProse("[power:in-the-red]", {})[0]).toMatchObject({ label: "in-the-red" });
  });

  it("counts the hit and then the mark it leaves", () => {
    expect(labels("[scaling:1] and [scaling:2]", black)).toEqual(["100% Strength", "10% Strength"]);
    // Red's mark has no power, so its second number is its burn.
    expect(labels("[scaling:2]", MOVES["red"]!)).toEqual(["20% Strength + 1.67 damage per level"]);
    expect(labels("[scaling:2]", cardThrow)).toEqual(["230% Strength"]);
  });

  it("says so where a move has no number in that place", () => {
    expect(labels("[scaling:3]", black)).toEqual(["?"]);
    expect(details("[scaling:3]", black)[0]).toBe("Black has no scaling number 3.");
  });

  it("follows a mark into the marks it leaves in turn", () => {
    // Cold has no number of its own. It leaves Chill each turn, and Chill's power is the slow.
    expect(labels("[scaling:1] and [scaling:2]", coldWave)).toEqual(["100% Magic", "10% Magic"]);
    expect(labels("[scaling:3]", coldWave)).toEqual(["?"]);
  });

  it("counts a mark that leaves itself once, rather than without end", () => {
    STATUSES["probe-loop"] = {
      ...STATUSES["chill"]!,
      id: "probe-loop",
      effects: [
        ...STATUSES["chill"]!.effects,
        { kind: "inflict", status: "probe-loop", on: "self" } as never,
      ],
    };
    const move = { ...black, name: "Probe", cast: [{ kind: "inflict", status: "probe-loop", on: { aim: 0 } }] } as never;
    try {
      expect(labels("[scaling:1] [scaling:2]", move)).toEqual(["10% Magic", "?"]);
    } finally {
      delete STATUSES["probe-loop"];
    }
  });
});

describe("a mark's own numbers", () => {
  it("reads a burn off the mark rather than off the move", () => {
    const at = { stats: statsFor({ str: 200 }), level: 30 };
    // In the Red: a fifth of Strength, and a flat 50 at the ceiling.
    expect(parseProse("[damage:in-the-red]", at)[0]).toMatchObject({ label: "90", tone: "magic" });
  });

  it("scales the flat share down below the ceiling", () => {
    const at = { stats: statsFor({ str: 200 }), level: 15 };
    expect(parseProse("[damage:in-the-red]", at)[0]).toMatchObject({ label: "65" });
  });

  it("reads a regen off the mark as a share of what holds it", () => {
    const part = parseProse("[heal:rooted]", {})[0];
    expect(part).toMatchObject({ label: "6% max HP" });
    expect(part && part.kind === "token" ? part.detail : "").toContain("its own maximum HP");
  });

  it("names the stat and the flat share with no caster to read", () => {
    // The script writes 50 at the level ceiling of 30, which reads as what each level adds.
    const part = parseProse("[damage:in-the-red]", {})[0];
    expect(part).toMatchObject({ label: "20% Strength + 1.67 damage per level" });
    expect(part?.kind === "token" && part.detail).toContain("plus 1.67 damage per level");
  });

  it("reads a move's flat damage the same way", () => {
    const part = parseProse("[damage]", { move: MOVES["cherry-on-top"]! })[0];
    expect(part).toMatchObject({ label: "2 damage per level" });
  });

  it("says so where a mark does no such thing", () => {
    expect(parseProse("[damage:rooted]", {})[0]).toMatchObject({ label: "rooted" });
    expect(parseProse("[heal:cold]", {})[0]).toMatchObject({ label: "cold" });
  });

  it("puts several numbers and marks in one line", () => {
    const line = "Deals [damage] damage, then [damage:in-the-red] a turn while it is"
      + " [status:in-the-red|burning].";
    const parts = parseProse(line, { move: MOVES["red"]!, stats: statsFor({ str: 200 }), level: 30 });
    expect(parts.filter((p) => p.kind === "token")).toHaveLength(3);
    expect(parts.filter((p) => p.kind === "token").map((p) => p.label))
      .toEqual(["220", "90", "burning"]);
  });

  it("names a field the same way it names a mark", () => {
    const part = parseProse("[status:sunblessed]", {})[0];
    expect(part).toMatchObject({ label: "Sunblessed" });
    expect(part && part.kind === "token" ? part.detail : "").toContain("Sun");
  });
});

describe("a written line", () => {
  it("comes back whole when it has no brackets in it", () => {
    const parts = parseProse("A cold attack that hits the whole line.", { move: coldWave });
    expect(parts).toEqual([{ kind: "text", text: "A cold attack that hits the whole line." }]);
  });

  it("splits the words off the numbers", () => {
    const parts = parseProse("Deals [damage], and leaves them [status:cold].", { move: coldWave });
    expect(parts.map((p) => p.kind)).toEqual(["text", "token", "text", "token", "text"]);
    expect(parts[0]).toEqual({ kind: "text", text: "Deals " });
    expect(parts[4]).toEqual({ kind: "text", text: "." });
  });

  it("shows the mark's own name, or the word you gave it", () => {
    expect(labels("[status:cold]")).toEqual(["Cold"]);
    expect(labels("[status:cold|slowed]")).toEqual(["slowed"]);
  });

  it("shows the number it deals when the caster is in hand", () => {
    // The Octoshake on the card: 148 Magic, and Cold Wave reads all of it.
    const at = { move: coldWave, stats: statsFor({ mag: 148 }), level: 30 };
    expect(parseProse("[damage]", at)[0]).toMatchObject({ label: "148", tone: "magic" });
  });

  it("counts a second stat into the number", () => {
    const at = { move: MOVES["green"]!, stats: statsFor({ str: 100, def: 40 }), level: 30 };
    expect(parseProse("[damage]", at)[0]).toMatchObject({ label: "140", tone: "physical" });
  });

  it("falls back to the share of the stat with no caster to read", () => {
    expect(labels("[damage]")).toEqual(["100% Magic"]);
    expect(labels("[damage]", cardThrow)).toEqual(["30% Strength"]);
  });

  it("puts the scaling behind the number rather than in the sentence", () => {
    expect(details("[damage]")[0]!).toContain("100% of the caster's Magic");
  });

  /** Every line of the working behind a hit's number. */
  const work = (token: string, move: Move = coldWave): string[] => {
    const part = parseProse(token, { move })[0];
    return part?.kind === "token" ? (part.work ?? []).map((w) => w.label) : [];
  };

  it("names the armour that actually reduces it, on the working rather than the line", () => {
    // The opening line says where the number comes from; what it meets on the
    // way in is the last line of the working, beneath the rest of the sum.
    expect(work("[damage]").at(-1)).toContain("reduced by the target's Resistance");
    expect(work("[damage]", cardThrow).at(-1)).toContain("reduced by the target's Defense");
    expect(details("[damage]", MOVES["green"]!)[0]).toContain("of its Defense");
  });

  it("gives a mark the caster's element match, where the caster is known", () => {
    // Corali is Moon and Flux and Dead Coral lands as Flux, so its tick is
    // worth half again on it. A screen that read the line without saying whose
    // it was showed the number the mark would deal for nobody in particular.
    const c = makeWild("corali", 6, rngFrom("corali"));
    const at = { stats: statsAt(c), level: c.level };
    const withCaster = parseProse("[damage:dead-coral]", { ...at, types: scobaTypes(c) })[0];
    const without = parseProse("[damage:dead-coral]", at)[0];
    const row = (p: typeof withCaster, label: string): string | undefined =>
      p?.kind === "token" ? p.work?.find((w) => w.label === label)?.value : undefined;
    expect(scobaTypes(c)).toContain("flux");
    expect(row(withCaster, "Elemental Synergy")).toBe("1.5x");
    expect(row(without, "Elemental Synergy")).toBe("1x");
    expect(Number(withCaster?.kind === "token" ? withCaster.label : 0))
      .toBeGreaterThan(Number(without?.kind === "token" ? without.label : 0));
  });

  it("totals what the caster brings, with no target to read the rest off", () => {
    const part = parseProse("[damage]", {
      move: coldWave, stats: statsFor({ mag: 200 }), level: 30, types: ["moon"],
    })[0];
    const rows = part?.kind === "token" ? part.work ?? [] : [];
    const synergy = rows.find((r) => r.label === "Elemental Synergy");
    const total = rows.find((r) => r.label === "Total");
    expect(synergy).toBeDefined();
    expect(total).toBeDefined();
    // Cold Wave is Moon, so a Moon caster gets the half again and the total
    // carries it. Nothing past it: there is nobody to read a chart against.
    expect(synergy!.value).toBe("1.5x");
    expect(total!.value).toBe("300");
    expect(rows.some((r) => r.label === "Elemental Weakness Modifier")).toBe(false);
  });

  it("takes the colour its kind of damage has everywhere else", () => {
    expect(parseProse("[damage]", { move: coldWave })[0]).toMatchObject({ tone: "magic" });
    expect(parseProse("[damage]", { move: cardThrow })[0]).toMatchObject({ tone: "physical" });
    // A flat hit is coloured by its category like any other hit.
    expect(parseProse("[damage]", { move: MOVES["cherry-on-top"]! })[0])
      .toMatchObject({ tone: "physical" });
  });

  it("reads the second damage off the payout that follows the hit", () => {
    expect(labels("[damage:1] then [damage:2]", cardThrow)).toEqual(["30% Strength", "230% Strength"]);
    const at = { move: cardThrow, stats: statsFor({ str: 120 }), level: 30 };
    expect(parseProse("[damage:2]", at)[0]).toMatchObject({ label: "276", tone: "physical" });
    expect(details("[damage:2]", cardThrow)[0]).toBe("230% of the caster's Strength. Physical damage is reduced by the target's Defense.");
  });

  it("says so where a move has no damage in that place", () => {
    expect(labels("[damage:3]", cardThrow)).toEqual(["?"]);
    expect(details("[damage:3]", cardThrow)[0]).toBe("Card Throw has no damage number 3.");
  });

  it("counts flat damage off the level rather than a stat", () => {
    const at = { move: MOVES["cherry-on-top"]!, level: 30 };
    expect(parseProse("[damage]", at)[0]).toMatchObject({ label: "60" });
  });

  it("shows what a heal comes to as well", () => {
    const at = { move: MOVES["icecream-soup"]!, stats: statsFor({ mag: 148 }), level: 30 };
    expect(parseProse("[heal]", at)[0]).toMatchObject({ label: "74" });
  });

  it("says what a mark actually does", () => {
    expect(details("[status:cold]")[0]).toBe(
      parseProse("[status:cold]", { move: coldWave }).find((p) => p.kind === "token")!.detail,
    );
    expect(details("[status:in-the-red]")[0]).toContain("Sun");
  });

  it("leaves a bracket it does not understand exactly as it was typed", () => {
    const text = "Deals [wobble] damage [to] everyone.";
    expect(parseProse(text, { move: coldWave })).toEqual([{ kind: "text", text }]);
    expect(flattenProse(text, { move: coldWave })).toBe(text);
  });

  it("survives a bracket that is never closed", () => {
    const text = "Deals [damage and leaves them cold.";
    expect(flattenProse(text, { move: coldWave })).toBe(text);
  });

  it("survives a bracket naming a mark that does not exist", () => {
    expect(labels("[status:nonsense]")).toEqual(["nonsense"]);
    expect(details("[status:nonsense]")[0]).toContain("No mark");
  });

  it("flattens to something readable where there is nowhere to hover", () => {
    expect(flattenProse("Deals [damage], and [status:cold|slows] them.", { move: coldWave }))
      .toBe("Deals 100% Magic, and slows them.");
  });

  it("leaves a cost written in brackets as plain words", () => {
    // It is shown beside the move's name already, so writing it in the sentence
    // is writing it twice.
    expect(flattenProse("Costs [cost].", { move: coldWave })).toBe("Costs [cost].");
  });

  it("has nothing to read a move token off a passive's line", () => {
    expect(labels("[damage]", null as never)).toEqual(["?"]);
  });
});
