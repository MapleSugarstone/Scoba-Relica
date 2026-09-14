import { afterEach, describe, expect, it } from "vitest";
import REFERENCE from "../docs/move-script.md?raw";
import { readScript } from "../src/sim/script/read";
import { withTextLine, writeField, writeMove, writePassive, writeStatus } from "../src/sim/script/write";
import { joinBlocks, readLines, splitBlocks } from "../src/sim/script/lines";
import { brokenRefs, readContent, SCRIPT_FILES } from "../src/sim/script/content";
import { missingWords } from "../src/sim/script/words";
import { SCRIPT_TEXT } from "../src/sim/content/tables";
import { ABILITIES, MOVES, SPECIES } from "../src/sim/species";
import { FIELDS, STATUSES } from "../src/sim/status";
import { resolveTurn, startBattle } from "../src/sim/battle";
import { makeWild } from "../src/sim/scoba";
import { forgetDerived, restoreDerived } from "../src/sim/rewrite";
import { rngFrom } from "../src/sim/rng";

const clean = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** The first problem reading some script turns up, or null for none. */
function mistake(text: string, kind: "move" | "status" | "passive" | "field" = "move"): string | null {
  const read = readScript(text, kind);
  const p = read.problems[0];
  return p ? `line ${p.line}: ${p.says}` : null;
}

const MOVE = (cast: string, head = ""): string => [
  "move test-move \"Test Move\"",
  "  type sun",
  "  costs 30 mana",
  "  aim any enemy",
  ...(head ? [head] : []),
  "  cast:",
  ...cast.split("\n").map((l) => `    ${l}`),
].join("\n");

describe("the files the game ships", () => {
  it("have a word for every value the game can hold", () => {
    expect(missingWords()).toEqual([]);
  });

  it("read without a single mistake, and every id they name exists", () => {
    const read = readContent(SCRIPT_TEXT);
    expect(read.problems).toEqual([]);
    expect(brokenRefs(read.refs, { moves: MOVES, statuses: STATUSES, species: SPECIES, fields: FIELDS })).toEqual([]);
  });

  it("write every record back as the same record", () => {
    for (const m of Object.values(MOVES).filter((x) => !x.derived)) {
      const back = readScript(writeMove(m), "move");
      expect(back.problems, m.id).toEqual([]);
      expect(clean(back.moves[0]), m.id).toEqual(clean(m));
    }
    for (const a of Object.values(ABILITIES)) {
      const own = a.statuses === undefined ? STATUSES[a.id] ?? null : null;
      const back = readScript(writePassive(a, own), "passive");
      expect(back.problems, a.id).toEqual([]);
      expect(clean(back.abilities[0]), a.id).toEqual(clean(a));
      expect(clean(back.statuses[0] ?? null), a.id).toEqual(clean(own));
    }
    const passiveIds = new Set(Object.keys(ABILITIES));
    for (const s of Object.values(STATUSES).filter((x) => !passiveIds.has(x.id) && !x.id.includes("@"))) {
      const back = readScript(writeStatus(s), "status");
      expect(back.problems, s.id).toEqual([]);
      expect(clean(back.statuses[0]), s.id).toEqual(clean(s));
    }
    for (const f of Object.values(FIELDS)) {
      const back = readScript(writeField(f), "field");
      expect(back.problems, f.id).toEqual([]);
      expect(clean(back.fields[0]), f.id).toEqual(clean(f));
    }
  });

  it("cut into records and join back into the same file", () => {
    for (const file of SCRIPT_FILES) {
      const text = SCRIPT_TEXT[file].replace(/\r\n/g, "\n");
      expect(joinBlocks(splitBlocks(text)), file).toBe(text.endsWith("\n") ? text : `${text}\n`);
    }
  });
});

describe("rewriting a record's text line", () => {
  const move = [
    "# A note above it.",
    "move sample \"Sample\"",
    "  type plain",
    "  costs 10 mana",
    "  aim any enemy",
    "  cast:",
    "    say \"text in a step\"",
    "    hit target 50% strength",
  ].join("\n");

  it("puts a new one before the cast, where the writer puts it", () => {
    const next = withTextLine(move, "Says \"hi\" [damage].");
    expect(next.split("\n")[5]).toBe("  text \"Says \\\"hi\\\" [damage].\"");
    const read = readScript(next, "move");
    expect(read.problems).toEqual([]);
    expect(read.moves[0]!.text).toBe("Says \"hi\" [damage].");
  });

  it("replaces the one there, and takes it out again, leaving every other line alone", () => {
    const once = withTextLine(move, "First.");
    expect(withTextLine(once, "Second.")).toBe(withTextLine(move, "Second."));
    expect(withTextLine(once, null)).toBe(move);
    expect(withTextLine(move, null)).toBe(move);
  });

  it("puts a passive's under its header", () => {
    const passive = "passive sample \"Sample\"\n  wears cherry";
    expect(withTextLine(passive, "Wears it.")).toBe("passive sample \"Sample\"\n  text \"Wears it.\"\n  wears cherry");
  });
});

describe("the reference in docs/move-script.md", () => {
  it("shows only records the game can read", () => {
    const blocks = [...REFERENCE.replace(/\r\n/g, "\n").matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]!);
    let checked = 0;
    for (const block of blocks) {
      const kind = /^(move|status|passive|field) /m.exec(block)?.[1] as "move" | "status" | "passive" | "field" | undefined;
      if (!kind || !block.startsWith(kind)) continue;
      const read = readScript(block, kind);
      expect(read.problems, block).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});

describe("reading lines", () => {
  it("takes notes out and keeps quoted text whole", () => {
    const [head] = readLines([
      "# a note",
      "move x \"Say \\\"hi\\\", then go\"",
      "  # another note",
      "  text \"One, two\"",
    ].join("\n"));
    expect(head!.clauses[0]!.map((w) => w.text)).toEqual(["move", "x", "Say \"hi\", then go"]);
    expect(head!.children).toHaveLength(1);
    expect(head!.children[0]!.clauses).toHaveLength(1);
  });

  it("reads clauses written on the lines under a step the same as after commas", () => {
    const inline = readScript(MOVE("pick a random move, costing at least 80, skip once per battle"), "move");
    const stacked = readScript(MOVE("pick a random move\n  costing at least 80\n  skip once per battle"), "move");
    expect(inline.problems).toEqual([]);
    expect(clean(stacked.moves)).toEqual(clean(inline.moves));
  });
});

describe("saying what is wrong, and where", () => {
  it("guesses a step that is spelled wrong", () => {
    expect(mistake(MOVE("hitt target 100% magic"))).toMatch(/^line 6: "hitt" does not start a step\. Did you mean "hit"\?/);
  });

  it("guesses who a step was meant to reach", () => {
    expect(mistake(MOVE("hit enemy 100% magic"))).toContain('"enemy" is not who it reaches. Did you mean "enemies"?');
  });

  it("names an element that does not exist", () => {
    expect(mistake(MOVE("caster lunge").replace("type sun", "type fire"))).toContain('"fire" is not an element');
  });

  it("wants a percentage where a share goes", () => {
    expect(mistake(MOVE("hit target 1.2 magic"))).toContain('expected "per level"');
    expect(mistake(MOVE("heal target half of their max hp"))).toContain("should be a percentage");
  });

  it("points at words left over at the end of a line", () => {
    expect(mistake(MOVE("hit target 100% magic twice"))).toContain('has "twice" left over');
  });

  it("asks for the lines a move cannot do without", () => {
    expect(mistake("move x \"X\"\n  type sun\n  aim any enemy\n  cast:\n    caster lunge"))
      .toContain('needs a "costs <n> mana" line');
    expect(mistake("move x \"X\"\n  type sun\n  costs 10 mana\n  aim any enemy"))
      .toContain('needs a "cast:" block');
  });

  it("asks for the colon a block needs", () => {
    expect(mistake("move x \"X\"\n  type sun\n  costs 10 mana\n  aim any enemy\n  cast\n    caster lunge"))
      .toContain("should end in a colon");
  });

  it("catches a quote that never closes", () => {
    expect(mistake("move x \"X\n  type sun")).toContain("never closed");
  });

  it("names a trigger that does not exist", () => {
    expect(mistake("status x \"X\"\n  bad\n  when the moon rises:\n    heal holder 10% of their max hp", "status"))
      .toContain("is not a trigger");
  });

  it("reports an id that names nothing once every file is in", () => {
    const read = readScript(MOVE("inflict frozen-solid on target"), "move");
    expect(read.problems).toEqual([]);
    const broken = brokenRefs(read.refs.map((r) => ({ ...r, file: "moves" as const })), {
      moves: MOVES, statuses: STATUSES, species: SPECIES, fields: FIELDS,
    });
    expect(broken.map((b) => b.says)).toEqual(['names a status called "frozen-solid", and there is none']);
  });

  it("reads a rewrite's cost and name, and says what is wrong with either", () => {
    const pickAndChange = (change: string): string => MOVE([
      "pick a random move",
      "change picked move:",
      `  ${change}`,
    ].join("\n"));
    expect(mistake(pickAndChange("set cost x0.5"))).toBeNull();
    expect(mistake(pickAndChange("set name \"Golden {name}\""))).toBeNull();
    expect(mistake(pickAndChange("set cost 0.5"))).toContain("should be a multiplier like x1.5");
    expect(mistake(pickAndChange("set name Golden"))).toContain("should be in double quotes");
  });

  it("asks for a card to be drawn before one is thrown or dealt", () => {
    expect(mistake(MOVE("throw drawn card as toss to target"))).toContain('nothing has been drawn yet');
    expect(mistake(MOVE("deal drawn card to target, hand dealt, 21 pays 230% strength")))
      .toContain('nothing has been drawn yet');
    expect(mistake(MOVE("deal a card to target, hand dealt, 21 pays 230% strength")))
      .toContain('Write "draw a card" above this line');
    expect(mistake(MOVE("draw a card, swap red for #000000 50% of the time"))).toContain("should be a color like #bc0006");
    expect(mistake(MOVE([
      "draw a card, swap #bc0006 for #000000 50% of the time",
      "throw drawn card as toss to target",
      "deal drawn card to target, hand dealt, 21 pays 230% strength",
    ].join("\n")))).toBeNull();
  });

  it("keeps reading after a broken record, so one mistake does not hide the rest", () => {
    const read = readScript(`${MOVE("hitt target")}\n\n${MOVE("hit target 100% magic").replace("test-move", "fine")}`, "move");
    expect(read.problems).toHaveLength(1);
    expect(read.moves.map((m) => m.id)).toEqual(["fine"]);
  });
});

describe("mechanics a passive can reuse", () => {
  const added: { statuses: string[]; abilities: string[] } = { statuses: [], abilities: [] };
  afterEach(() => {
    for (const id of added.statuses) delete STATUSES[id];
    for (const id of added.abilities) delete ABILITIES[id];
    added.statuses = [];
    added.abilities = [];
  });

  /** Reads a passive into the game for one test. */
  const install = (text: string): void => {
    const read = readScript(text, "passive");
    expect(read.problems).toEqual([]);
    for (const a of read.abilities) {
      ABILITIES[a.id] = a;
      added.abilities.push(a.id);
    }
    for (const s of read.statuses) {
      STATUSES[s.id] = s;
      added.statuses.push(s.id);
    }
  };

  it("picks a move, rewrites it and hands it over, all from the script", () => {
    install([
      "passive moon-wheel \"Moon Wheel\"",
      "  when it takes the field:",
      "    pick a random move, costing at least 60, skip once per battle",
      "    change picked move:",
      "      set type moon",
      "      set damage magic",
      "      scale off magic",
      "    give holder picked move as extra",
      "    say \"{self} is handed {picked}.\"",
    ].join("\n"));
    const me = { ...makeWild("plib", 20, rngFrom("mw")), owner: "A" as const, secondaryAbility: "moon-wheel" };
    const st = startBattle("moon-wheel", [me], [makeWild("obera", 20, rngFrom("mw2"))], { slots: 1 });
    const given = st.teams[0][0]!.given?.[0];
    expect(given).toBeTruthy();
    const move = MOVES[given!]!;
    expect(move.type).toBe("moon");
    expect(move.manaCost).toBeGreaterThanOrEqual(60);
    expect(move.derived?.by).toBe("moon-wheel");
    if (move.kind !== "heal" && move.kind !== "utility") expect(move.kind).toBe("magical");
    expect(st.opening.some((e) => e.kind === "info" && e.text.endsWith(`is handed ${move.name}.`))).toBe(true);
  });

  it("rebuilds the rewrites a handed-over battle names, the same as the client that made them", () => {
    const me = { ...makeWild("allin", 30, rngFrom("rd")), owner: "A" as const };
    const st = startBattle("restore", [me], [makeWild("obera", 30, rngFrom("rd2"))], { slots: 1 });
    const given = st.teams[0][0]!.given![0]!;
    const built = clean(MOVES[given]);
    // A fresh client has none of this battle's rewrites filed yet.
    forgetDerived();
    expect(MOVES[given]).toBeUndefined();
    const handed = JSON.parse(JSON.stringify(st)) as typeof st;
    restoreDerived(handed);
    expect(clean(MOVES[given])).toEqual(built);
  });

  it("runs a move's steps in the order they are written", () => {
    const read = readScript(MOVE([
      "inflict fire on target",
      "caster rear",
      "hit target 50% magic",
    ].join("\n")), "move");
    expect(read.problems).toEqual([]);
    const move = read.moves[0]!;
    MOVES[move.id] = move;
    try {
      const me = { ...makeWild("plib", 20, rngFrom("ord")), owner: "A" as const, moves: [move.id] };
      const st = startBattle("order", [me], [makeWild("obera", 20, rngFrom("ord2"))], { slots: 1 });
      st.teams[0][0]!.mana = 100;
      const events = resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: move.id, picks: [{ side: 1, index: 0 }] }]);
      const kinds = events.map((e) => (e.kind === "show" ? e.visual!.kind : e.kind));
      expect(kinds.indexOf("status")).toBeLessThan(kinds.indexOf("motion"));
      expect(kinds.indexOf("motion")).toBeLessThan(kinds.indexOf("hit"));
    } finally {
      delete MOVES[move.id];
    }
  });
});
