import { describe, expect, it } from "vitest";
import {
  REFERENCE, TEMPLATES, blankSpecies, idTaken, insertLine, isId, linesUsing, recordsUsing, slug,
  speciesRecord, unclaimedArt, type RefGroup,
} from "../src/dev/authoring";
import { checkSpecies } from "../src/sim/content/validate";
import { FILE_RECORD, SCRIPT_FILES, brokenRefs, type ScriptFile } from "../src/sim/script/content";
import { readScript } from "../src/sim/script/read";
import { MOVES, SPECIES } from "../src/sim/species";
import { FIELDS, STATUSES } from "../src/sim/status";

/** What is wrong with a record, once every id it names is checked too. */
function wrong(file: ScriptFile, text: string): string[] {
  const read = readScript(text, FILE_RECORD[file]);
  const own = read.problems.map((p) => `line ${p.line}: ${p.says}`);
  if (own.length > 0) return own;
  return brokenRefs(read.refs.map((r) => ({ ...r, file })), {
    moves: MOVES, statuses: STATUSES, species: SPECIES, fields: FIELDS,
  }).map((p) => `line ${p.line}: ${p.says}`);
}

describe("naming a record", () => {
  it("turns a name into an id the script reads", () => {
    expect(slug("Ice Cream Soup")).toBe("ice-cream-soup");
    expect(slug("Queen's Guard")).toBe("queens-guard");
    expect(slug("  Third  Eye! ")).toBe("third-eye");
    expect(isId(slug("Roll the Wheel"))).toBe(true);
    expect(isId("Roll")).toBe(false);
  });

  it("refuses an id another record holds, passives and statuses sharing one table", () => {
    expect(idTaken("moves", "crush")).toContain("move");
    expect(idTaken("statuses", "fire")).toContain("status");
    expect(idTaken("statuses", "swift")).toContain("passive");
    expect(idTaken("passives", "fire")).toContain("status");
    expect(idTaken("fields", "sunblessed")).toContain("field");
    expect(idTaken("moves", "brand-new")).toBeNull();
  });
});

describe("the templates a new record starts from", () => {
  for (const file of SCRIPT_FILES) {
    it(`every ${file} template reads clean and holds the record it was named as`, () => {
      for (const t of TEMPLATES[file]) {
        const text = t.text("brand-new", "Brand \"New\"");
        expect(wrong(file, text), `${file}: ${t.label}`).toEqual([]);
        const read = readScript(text, FILE_RECORD[file]);
        const ids = [...read.moves, ...read.abilities, ...read.fields, ...read.statuses].map((r) => r.id);
        expect(ids, `${file}: ${t.label}`).toContain("brand-new");
        const names = [...read.moves, ...read.abilities, ...read.fields, ...read.statuses].map((r) => r.name);
        expect(names, `${file}: ${t.label}`).toContain("Brand \"New\"");
      }
    });
  }
});

/** A palette example put into a record that gives it what it needs around it. */
function around(group: RefGroup, example: string, file: ScriptFile): string | null {
  const moveHead = ["move t \"T\"", "  type sun", "  costs 10 mana"];
  const cast = (steps: string[]): string => [...moveHead, "  aim any enemy", "  aim any ally as target2", "  cast:", ...steps.map((s) => `    ${s}`)].join("\n");
  const carried = (kind: "status" | "passive", lines: string[]): string =>
    [`${kind} t "T"`, ...(kind === "status" ? ["  bad"] : []), ...lines.map((l) => `  ${l}`)].join("\n");
  const indented = (s: string): string[] => s.split("\n");
  switch (group.label) {
    case "Move lines":
      if (example === "cast:") return null;
      return [...moveHead.filter((l) => !example.startsWith(l.trim().split(" ")[0]!)), `  ${example}`, "  aim any enemy", "  cast:", "    caster lunge"].join("\n");
    case "Aims":
      return [...moveHead, `  ${example}`, "  cast:", "    caster lunge"].join("\n");
    case "Status lines":
      return carried("status", example === "bad" ? [] : [example]);
    case "Passive lines":
      return carried("passive", [example]);
    case "Field lines":
      if (example === "while standing:") return null;
      return ["field t \"T\"", "  tint #000000", "  begins \"a\"", "  ends \"b\"", `  ${example}`].filter((l, i, all) => all.indexOf(l) === i && !(i < 4 && example.startsWith(l.trim().split(" ")[0]!))).join("\n");
    case "Triggers":
      return carried("status", [example, "  heal holder 10% of their max hp"]);
    case "Standing effects":
      return carried(file === "passives" ? "passive" : "status", ["while carried:", ...indented(example).map((l) => `  ${l}`)]);
    case "Field effects":
      return ["field t \"T\"", "  tint #000000", "  begins \"a\"", "  ends \"b\"", "  while standing:", `    ${example}`].join("\n");
    case "Who":
    case "Blocks":
    case "Shares":
      return null;
    default: {
      // A step. It is written for a move where it names the caster or a target,
      // and for a status where it names the holder.
      const forMove = /\b(caster|target\d?)\b/.test(example) || example === "refund";
      const lead: string[] = [];
      if (/drawn card/.test(example)) lead.push("draw a card");
      if (/picked move/.test(example)) lead.push("pick a random move");
      const steps = [...lead, ...indented(example)];
      if (example.endsWith(":") && !example.startsWith("change")) steps.push("  refund");
      if (forMove) return cast(steps);
      return carried("status", ["when a turn ends:", ...steps.map((s) => `  ${s}`)]);
    }
  }
}

describe("the palette", () => {
  it("lists only lines the game reads, in a record that takes them", () => {
    let checked = 0;
    for (const group of REFERENCE) {
      for (const line of group.lines) {
        const file = group.in[0]!;
        const text = around(group, line.example, file);
        if (text === null) continue;
        const kind: ScriptFile = text.startsWith("move") ? "moves"
          : text.startsWith("status") ? "statuses"
            : text.startsWith("passive") ? "passives" : "fields";
        expect(wrong(kind, text), `${group.label}: ${line.form}\n${text}`).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it("puts a line in under the caret's line, one level in under a block", () => {
    const text = "move x \"X\"\n  cast:\n    caster lunge";
    const atCast = text.indexOf("cast:") + 2;
    const under = insertLine(text, atCast, "hit target 100% magic");
    expect(under.text).toBe("move x \"X\"\n  cast:\n    hit target 100% magic\n    caster lunge");
    expect(under.text.slice(0, under.caret)).toMatch(/hit target 100% magic$/);
    const atEnd = insertLine(text, text.length, "sound confirm");
    expect(atEnd.text).toBe(`${text}\n    sound confirm`);
    const onBlank = insertLine("a\n\nb", 2, "c");
    expect(onBlank.text).toBe("a\nc\nb");
  });
});

describe("a new line", () => {
  it("writes a record the game checks clean, with only what was set", () => {
    const draft = blankSpecies();
    Object.assign(draft, {
      name: "Testoba", id: "testoba", art: "testoba", primaryAbility: "swift", secondaryPool: ["brawn"],
      moves: ["crush", "slam"], blurb: "  A test.  ", type2: "sun",
    });
    const sp = speciesRecord(draft);
    expect(checkSpecies(sp)).toEqual([]);
    expect(sp.moves).toEqual(["crush", "slam"]);
    expect(sp.blurb).toBe("A test.");
    expect(sp.type2).toBe("sun");
    expect("hyperAbility" in sp).toBe(false);
    expect("starter" in sp).toBe(false);
    expect("baby" in sp).toBe(false);
    // A baby has no Hyper-Mode, whatever was picked.
    expect("hyperAbility" in speciesRecord({ ...draft, baby: true, hyperAbility: "swift" })).toBe(false);
    // A second type the same as the first is no second type.
    expect("type2" in speciesRecord({ ...draft, type2: draft.type })).toBe(false);
  });

  it("offers the drawings no line has claimed", () => {
    const free = unclaimedArt(["cresce", "testoba", "hyper-allin", "newone"]);
    expect(free).toEqual(["newone", "testoba"]);
  });
});

describe("who uses a record", () => {
  it("finds the lines that know a move and the records that leave a status", () => {
    expect(linesUsing("moves", "crush").map((sp) => sp.id)).toContain("cresce");
    expect(linesUsing("passives", "swift").map((sp) => sp.id)).toContain("flarea");
    expect(recordsUsing("statuses", "fire").map((r) => r.id)).toContain("ember");
    expect(recordsUsing("fields", "sunblessed").map((r) => r.id)).toContain("sun-bloom");
    expect(recordsUsing("moves", "cherry-on-top").map((r) => r.id)).toContain("cherry-on-top");
    // A status reaches a line through the moves and passives that leave it.
    expect(linesUsing("statuses", "fire").map((sp) => sp.id)).toContain("flarea");
    expect(linesUsing("moves", "no-such-move")).toEqual([]);
  });
});
