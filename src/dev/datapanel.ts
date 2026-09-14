// The game's data, for the Scoba on screen, as text you can edit in place.
//
// Every record the line depends on is listed: the line itself, its passives and
// the statuses they leave, and its moves and the statuses those leave. Moves,
// statuses, passives and fields are shown as the move script they are written
// in, exactly as it sits in its file under `src/sim/content`. The line itself is
// shown as the JSON it is written in. `docs/move-script.md` describes the script.
//
// Above the boxes, the line's kit is edited by picking: which passives it rolls
// and which moves it learns, out of the shared tables. A record is shared by id,
// so an edit to a move here is the move every other line learns too. New records
// are written in the builder and filed into the same tables.
//
// An edit is checked as it is typed and applied the moment the game can read it.
// Nothing reaches the files until Save, and Reset puts one record back to what
// was last saved.
import { rememberStep, type Undoable } from "../game/cosmetics";
import type { TextKind } from "../game/texts";
import { checkSpecies, type Problem } from "../sim/content/validate";
import { SCRIPT_TEXT } from "../sim/content/tables";
import { joinBlocks, splitBlocks, type Blocks } from "../sim/script/lines";
import { readScript } from "../sim/script/read";
import { withTextLine } from "../sim/script/write";
import { FILE_RECORD, SCRIPT_FILES, brokenRefs, type ScriptFile } from "../sim/script/content";
import { forgetDerived } from "../sim/rewrite";
import { ABILITIES, MOVES, SPECIES, allSteps, type Species } from "../sim/species";
import { FIELDS, STATUSES, isContinuous, type Step } from "../sim/status";
import { linesUsing, recordsUsing } from "./authoring";
import { attachLabel, buildBuilder, checkNew, type Attach } from "./builder";
import { button, el } from "./dom";
import { abilityEntries, buildKitEditor, moveEntries } from "./kit";
import { buildPicker, type PickEntry } from "./pickers";
import { indentWithTab } from "./textbox";

export interface DataPanel {
  root: HTMLElement;
  /** Lists the records for a line, or nothing for a subject with none. */
  show(sp: Species | null): void;
  /**
   * Brings every box up to date with its record, after something other than
   * the box itself changed one, which is what Undo and Redo do.
   */
  sync(): void;
  /** Whether any record differs from what was last saved. */
  dirty(): boolean;
  /** Writes every file with a changed record in it, and says what it did. */
  save(): Promise<string>;
  /** Files a new line. Returns what is wrong, or nothing. */
  addSpecies(sp: Species): string[];
  /** Files a new record without handing it to anyone. Returns what is wrong, or nothing. */
  addRecord(file: ScriptFile, text: string): string[];
  /** A move's or a passive's `text` line, or a line's blurb, or null where it has none. */
  words(kind: TextKind, id: string): string | null;
  /** The same, as it was last saved. */
  savedWords(kind: TextKind, id: string): string | null;
  /** Rewrites that one line of a record as one step. Empty takes it out. Returns what is wrong, or nothing. */
  setWords(kind: TextKind, id: string, text: string): string[];
}

interface Host {
  note(text: string): void;
  /** Called after a record is applied, so everything reading it redraws. */
  changed(): void;
}

type Kind = ScriptFile | "species";

/** One record the line depends on, and why it is listed. */
interface Entry {
  kind: Kind;
  id: string;
  /** What it is to the line, for the heading over the box. */
  role: string;
}

const KIND_NAME: Record<Kind, string> = {
  moves: "Move",
  statuses: "Status",
  passives: "Passive",
  fields: "Field",
  species: "Scoba",
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

/** The statuses and fields a list of steps reaches. */
function reachedBySteps(steps: Step[], by: string): Entry[] {
  const out: Entry[] = [];
  for (const s of allSteps(steps)) {
    if (s.kind === "inflict") out.push({ kind: "statuses", id: s.status, role: `left by ${by}` });
    if (s.kind === "deal-card") out.push({ kind: "statuses", id: s.hand, role: `counted by ${by}` });
    if (s.kind === "field") out.push({ kind: "fields", id: s.field, role: `laid by ${by}` });
  }
  return out;
}

/** What a status's own steps reach. */
function reachedByStatus(id: string): Entry[] {
  const def = STATUSES[id];
  if (!def) return [];
  const steps = def.effects.filter((e): e is Step => !isContinuous(e.kind));
  return reachedBySteps(steps, def.name);
}

/** How far an edit to a record reaches, for the line under its box. */
function sharedWith(entry: Entry): string {
  if (entry.kind === "species") return "";
  const parts: string[] = [];
  const records = recordsUsing(entry.kind, entry.id);
  if (records.length > 0) {
    const how = entry.kind === "moves" ? "Granted by" : entry.kind === "fields" ? "Laid by" : "Left by";
    parts.push(`${how} ${records.map((r) => r.name).join(", ")}.`);
  }
  const lines = linesUsing(entry.kind, entry.id);
  if (lines.length > 0) parts.push(`Used by ${lines.map((sp) => sp.name).join(", ")}.`);
  if (parts.length === 0) return "Used by no line yet.";
  return `${parts.join(" ")} An edit here reaches all of them.`;
}

export function buildDataPanel(host: Host): DataPanel {
  const root = el("div", "cosData");

  /** Each script file as the editor opened it or last saved it, cut into records. */
  const saved = Object.fromEntries(
    SCRIPT_FILES.map((file) => [file, splitBlocks(SCRIPT_TEXT[file])]),
  ) as Record<ScriptFile, Blocks>;
  /** The same files as they stand now, with every applied edit in them. */
  const live = clone(saved);
  const savedSpecies = clone(SPECIES) as Record<string, unknown>;

  const blockOf = (parts: Blocks, id: string) => parts.blocks.find((b) => b.id === id);

  /** Whether a passive file holds this id, so its status is shown inside the passive. */
  const isPassive = (id: string): boolean => blockOf(live.passives, id) !== undefined;

  /** Records opened by name or just made, listed after the ones the line reaches. */
  let opened: Entry[] = [];
  let openedFor: string | null = null;

  /** Every record a line depends on, each listed once, in the order it is met. */
  const entriesFor = (sp: Species): Entry[] => {
    const out: Entry[] = [];
    const seen = new Set<string>();
    const add = (e: Entry): void => {
      const key = `${e.kind}:${e.id}`;
      if (seen.has(key)) return;
      // A passive's own status is written inside the passive.
      if (e.kind === "statuses" && isPassive(e.id)) return;
      seen.add(key);
      out.push(e);
      if (e.kind === "statuses") for (const next of reachedByStatus(e.id)) add(next);
    };

    add({ kind: "species", id: sp.id, role: "the line itself" });
    const passives = [
      { id: sp.primaryAbility, role: "first passive" },
      ...sp.secondaryPool.map((id) => ({ id, role: "second passive" })),
      ...(sp.hyperAbility ? [{ id: sp.hyperAbility, role: "Hyper-Mode passive" }] : []),
    ];
    for (const p of passives) {
      if (!ABILITIES[p.id]) continue;
      add({ kind: "passives", id: p.id, role: p.role });
      for (const next of reachedByStatus(p.id)) add(next);
    }
    sp.moves.forEach((id, i) => {
      const move = MOVES[id];
      if (!move) return;
      add({ kind: "moves", id: move.id, role: `move ${i + 1}` });
      for (const next of reachedBySteps(move.cast, move.name)) add(next);
    });
    for (const e of opened) {
      if (e.kind === "species") continue;
      add(e);
      if (e.kind === "moves" && MOVES[e.id]) for (const next of reachedBySteps(MOVES[e.id]!.cast, MOVES[e.id]!.name)) add(next);
      if (e.kind === "passives") for (const next of reachedByStatus(e.id)) add(next);
    }
    return out;
  };

  // --- script records ---

  /** What is wrong with a script record's text, or nothing where it can be applied. */
  const scriptProblems = (file: ScriptFile, id: string, text: string): { line: number; says: string }[] => {
    const read = readScript(text, FILE_RECORD[file]);
    if (read.problems.length > 0) return read.problems;
    const ids = file === "moves" ? read.moves.map((m) => m.id)
      : file === "statuses" ? read.statuses.map((s) => s.id)
        : file === "passives" ? read.abilities.map((a) => a.id)
          : read.fields.map((f) => f.id);
    // A record is filed under its id, so a box holds exactly the one it was opened on.
    if (ids.length !== 1) return [{ line: 1, says: `should hold exactly one record, and holds ${ids.length}` }];
    if (ids[0] !== id) return [{ line: 1, says: `has to keep the id "${id}", since everything else names it by that` }];
    return brokenRefs(read.refs.map((r) => ({ ...r, file })), {
      moves: MOVES, statuses: STATUSES, species: SPECIES, fields: FIELDS,
    });
  };

  /** Puts a script record's text into the running game. The text has already been checked. */
  const applyScript = (file: ScriptFile, id: string, text: string): void => {
    const read = readScript(text, FILE_RECORD[file]);
    switch (file) {
      case "moves":
        MOVES[id] = read.moves[0]!;
        break;
      case "statuses":
        STATUSES[id] = read.statuses[0]!;
        break;
      case "passives":
        ABILITIES[id] = read.abilities[0]!;
        if (read.statuses[0]) STATUSES[id] = read.statuses[0];
        else delete STATUSES[id];
        break;
      case "fields":
        FIELDS[id] = read.fields[0]!;
        break;
    }
    const block = blockOf(live[file], id);
    if (block) block.text = text;
    // A rewrite made from the old record would be handed out in its place.
    forgetDerived();
  };

  /** Takes a record out of its file and out of the tables, which is what undoing its creation does. */
  const removeScript = (file: ScriptFile, id: string): void => {
    live[file].blocks = live[file].blocks.filter((b) => b.id !== id);
    switch (file) {
      case "moves": delete MOVES[id]; break;
      case "statuses": delete STATUSES[id]; break;
      case "passives":
        delete ABILITIES[id];
        delete STATUSES[id];
        break;
      case "fields": delete FIELDS[id]; break;
    }
    forgetDerived();
  };

  /** One script record as a thing a step in the history can copy and put back. Empty is gone. */
  const blockTarget = (file: ScriptFile, id: string): Undoable => ({
    read: () => blockOf(live[file], id)?.text ?? "",
    write: (state) => {
      if (state === "") return removeScript(file, id);
      if (!blockOf(live[file], id)) live[file].blocks.push({ kind: FILE_RECORD[file], id, text: state, firstLine: 0 });
      applyScript(file, id, state);
    },
  });

  // --- the line itself ---

  const speciesText = (id: string): string => (SPECIES[id] ? pretty(SPECIES[id]) : "");

  const speciesProblems = (id: string, text: string): Problem[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return [{ at: "", says: `is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }];
    }
    const found = checkSpecies(parsed);
    if ((parsed as { id?: unknown })?.id !== id) found.push({ at: "id", says: `has to stay "${id}"` });
    return found;
  };

  /** One line as a thing a step in the history can copy and put back. Empty is gone. */
  const speciesTarget = (id: string): Undoable => ({
    read: () => speciesText(id),
    write: (state) => {
      if (state === "") delete SPECIES[id];
      else SPECIES[id] = JSON.parse(state) as Species;
    },
  });

  /** Several things as one step, so making a record and handing it over come back off together. */
  const together = (targets: Undoable[]): Undoable => ({
    read: () => JSON.stringify(targets.map((t) => t.read())),
    write: (state) => {
      const states = JSON.parse(state) as string[];
      targets.forEach((t, i) => t.write(states[i] ?? ""));
    },
  });

  /** Replaces a line's record, as one step. */
  const changeSpecies = (id: string, next: Species, what: string): void => {
    rememberStep(`data:species:${id}`, speciesTarget(id));
    SPECIES[id] = next;
    host.changed();
    host.note(`${what}. Save to write it.`);
  };

  const addSpecies = (sp: Species): string[] => {
    if (SPECIES[sp.id]) return [`"${sp.id}" is already a line.`];
    rememberStep(`data:species:${sp.id}`, speciesTarget(sp.id));
    SPECIES[sp.id] = clone(sp);
    host.changed();
    host.note(`${sp.name} added. Save to write it to species.json.`);
    return [];
  };

  // --- the words a player reads ---

  const scriptFileOf = (kind: "move" | "ability"): ScriptFile => (kind === "move" ? "moves" : "passives");

  const words = (kind: TextKind, id: string): string | null => {
    if (kind === "species") return SPECIES[id]?.blurb ?? null;
    return (kind === "move" ? MOVES[id]?.text : ABILITIES[id]?.text) ?? null;
  };

  const savedWords = (kind: TextKind, id: string): string | null => {
    if (kind === "species") return (savedSpecies[id] as Species | undefined)?.blurb ?? null;
    const file = scriptFileOf(kind);
    const block = blockOf(saved[file], id);
    if (!block) return null;
    const read = readScript(block.text, FILE_RECORD[file]);
    return (kind === "move" ? read.moves[0]?.text : read.abilities[0]?.text) ?? null;
  };

  const setWords = (kind: TextKind, id: string, text: string): string[] => {
    // A script line cannot hold a line break, and a blurb is one line wherever it is shown.
    const said = text.replace(/\s+/g, " ").trim();
    if (said === (words(kind, id) ?? "")) return [];
    if (kind === "species") {
      const sp = SPECIES[id];
      if (!sp) return [`There is no line called ${id}.`];
      const next = clone(sp);
      if (said === "") delete next.blurb;
      else next.blurb = said;
      changeSpecies(id, next, `${sp.name}'s blurb changed`);
      return [];
    }
    const file = scriptFileOf(kind);
    const block = blockOf(live[file], id);
    if (!block) return [`There is no ${KIND_NAME[file].toLowerCase()} called ${id}.`];
    const next = withTextLine(block.text, said === "" ? null : said);
    const found = scriptProblems(file, id, next);
    if (found.length > 0) return found.map((p) => `${id} line ${p.line} ${p.says}.`);
    rememberStep(`data:${file}:${id}`, blockTarget(file, id));
    applyScript(file, id, next);
    host.changed();
    host.note(`${id} text changed. Save to write it to ${file}.txt.`);
    return [];
  };

  // --- one box per record ---

  const textOf = (entry: Entry): string => (entry.kind === "species"
    ? speciesText(entry.id)
    : blockOf(live[entry.kind], entry.id)?.text ?? "");

  const savedTextOf = (entry: Entry): string => (entry.kind === "species"
    ? (savedSpecies[entry.id] ? pretty(savedSpecies[entry.id]) : "")
    : blockOf(saved[entry.kind], entry.id)?.text ?? "");

  /** One record, as a thing a step in the history can copy and put back. */
  const recordTarget = (entry: Entry): Undoable =>
    (entry.kind === "species" ? speciesTarget(entry.id) : blockTarget(entry.kind, entry.id));

  /** Every box's label, so a save can tell them all they are saved now. */
  let marks: (() => void)[] = [];

  /** Every box's way of catching up with a record changed out from under it. */
  let syncs: (() => void)[] = [];

  /** The line on screen, so a record that changes the list can list it again. */
  let showing: Species | null = null;

  /** The records listed for it, to tell whether an edit changed the list. */
  let listed = "";

  /** The records on screen, for leaving them out of the box that opens one. */
  let entriesShown: Entry[] = [];

  /** What a line's list would hold now: every record it reaches that exists. */
  const listKey = (sp: Species): string =>
    entriesFor(sp).filter((e) => textOf(e) !== "").map((e) => `${e.kind}:${e.id}`).join(",");

  const box = (entry: Entry): HTMLElement => {
    const wrap = el("div", "cosDataBox cosWell");
    const head = el("div", "cosWordHead");
    const name = entry.kind === "species" ? SPECIES[entry.id]?.name
      : entry.kind === "moves" ? MOVES[entry.id]?.name
        : entry.kind === "passives" ? ABILITIES[entry.id]?.name
          : entry.kind === "statuses" ? STATUSES[entry.id]?.name
            : FIELDS[entry.id]?.name;
    head.appendChild(el("div", "cosWordWho", `${KIND_NAME[entry.kind]} · ${name ?? entry.id}`));
    const state = el("div", "cosNote");
    head.appendChild(state);
    const back = el("button", "cosMini", "Reset");
    head.appendChild(back);
    wrap.appendChild(head);
    const file = entry.kind === "species" ? "species.json" : `${entry.kind}.txt`;
    wrap.appendChild(el("div", "cosDataRole", `${entry.id} in ${file}, ${entry.role}`));
    const shared = sharedWith(entry);
    if (shared !== "") wrap.appendChild(el("div", "cosNote cosShared", shared));

    const field = document.createElement("textarea");
    field.className = "cosField cosDataText";
    field.spellcheck = false;
    field.value = textOf(entry);
    field.rows = Math.min(28, Math.max(4, field.value.split("\n").length + 1));
    indentWithTab(field);
    wrap.appendChild(field);

    /**
     * The record as this box last put it on screen. A draft typed over it and
     * not yet applied differs from the field but not from the record, which is
     * how catching up after an Undo tells the two apart and leaves the draft be.
     */
    let known = field.value;

    const said = el("div", "cosDataSaid");
    wrap.appendChild(said);

    const mark = (): void => {
      const dirty = textOf(entry) !== savedTextOf(entry);
      state.textContent = dirty ? (savedTextOf(entry) === "" ? "new" : "changed") : "saved";
      back.disabled = !dirty || savedTextOf(entry) === "";
    };

    const check = (): string[] => {
      const found = entry.kind === "species"
        ? speciesProblems(entry.id, field.value).map((p) => {
          // A message that already ends in a question or a stop keeps its own.
          const end = /[.?!]$/.test(p.says) ? "" : ".";
          return `${p.at === "" ? "This" : p.at} ${p.says}${end}`;
        })
        : scriptProblems(entry.kind, entry.id, field.value).map((p) => {
          const end = /[.?!]$/.test(p.says) ? "" : ".";
          return `Line ${p.line} ${p.says}${end}`;
        });
      said.innerHTML = "";
      field.classList.toggle("bad", found.length > 0);
      for (const line of found) said.appendChild(el("div", "cosDataProblem", line));
      return found;
    };

    const apply = (text: string): void => {
      if (entry.kind === "species") SPECIES[entry.id] = JSON.parse(text) as Species;
      else applyScript(entry.kind, entry.id, text);
    };

    field.addEventListener("input", () => void check());
    field.addEventListener("change", () => {
      if (check().length > 0) {
        host.note(`${entry.id} is not applied until it is fixed.`);
        return;
      }
      const next = entry.kind === "species" ? pretty(JSON.parse(field.value)) : field.value;
      // Writing a record back to exactly what it holds is not a change, and is
      // not worth a step in the history.
      if (next === textOf(entry)) return;
      rememberStep(`data:${entry.kind}:${entry.id}`, recordTarget(entry));
      apply(next);
      known = field.value;
      mark();
      host.changed();
      host.note(`${entry.id} applied. Save to write it to its file.`);
      // A record can change what else is listed: a move learned, a passive
      // swapped or a status left brings records in. The list is only built
      // again when it has changed, since building it takes the focus away.
      queueMicrotask(() => {
        if (!showing) return;
        const line = SPECIES[showing.id] ?? showing;
        if (listKey(line) !== listed) show(line);
      });
    });
    back.addEventListener("click", () => {
      rememberStep(`data:${entry.kind}:${entry.id}`, recordTarget(entry));
      apply(savedTextOf(entry));
      field.value = textOf(entry);
      known = field.value;
      check();
      mark();
      host.changed();
      host.note(`${entry.id} is back to what was saved.`);
    });

    mark();
    marks.push(mark);
    // Catches up with a record something else changed. A record that still
    // reads as this box left it is left alone, draft and all.
    syncs.push(() => {
      const now = textOf(entry);
      if (now === known) return;
      field.value = now;
      known = now;
      check();
      mark();
    });
    return wrap;
  };

  // --- making records ---

  /**
   * Files a record, hands it to the line on screen where `attach` says so, and
   * lists it under that line where `open` says so. A record made for a line
   * that does not exist yet is filed and listed nowhere until the line does.
   */
  const createRecord = (file: ScriptFile, text: string, attach: Attach | null, open: boolean): string[] => {
    const { problems, id } = checkNew(file, text);
    if (problems.length > 0 || !id) return problems;
    const sp = showing ? SPECIES[showing.id] ?? null : null;
    const handed = attach !== null && sp !== null;
    const targets = [blockTarget(file, id), ...(handed ? [speciesTarget(sp.id)] : [])];
    rememberStep(`data:new:${file}:${id}`, together(targets));
    live[file].blocks.push({ kind: FILE_RECORD[file], id, text, firstLine: 0 });
    applyScript(file, id, text);
    if (handed) {
      const next = clone(sp);
      if (attach.kind === "teach") next.moves = [...next.moves, id];
      else if (attach.slot === "primary") next.primaryAbility = id;
      else if (attach.slot === "secondary") next.secondaryPool = [...next.secondaryPool, id];
      else next.hyperAbility = id;
      SPECIES[sp.id] = next;
    }
    if (open) opened.push({ kind: file, id, role: "just made" });
    host.changed();
    return [];
  };

  const builder = buildBuilder({
    subject: () => (showing ? SPECIES[showing.id] ?? showing : null),
    create: (file, _id, text, attach) => createRecord(file, text, attach, true),
    note: (text) => host.note(text),
  });

  /** Every record in the game, for opening one the line does not reach. */
  const recordEntries = (): PickEntry[] => [
    ...moveEntries().map((e) => ({ ...e, id: `moves:${e.id}`, hint: `Move · ${e.hint ?? ""}` })),
    ...abilityEntries().map((e) => ({ ...e, id: `passives:${e.id}`, hint: `Passive · ${e.hint ?? ""}` })),
    ...Object.values(STATUSES)
      .filter((s) => !ABILITIES[s.id] && !s.id.includes("@"))
      .map((s) => ({ id: `statuses:${s.id}`, name: s.name, hint: `Status · ${s.polarity}` })),
    ...Object.values(FIELDS).map((f) => ({ id: `fields:${f.id}`, name: f.name, hint: "Field" })),
  ];

  const opener = buildPicker({
    placeholder: "Open any move, passive, status or field by name",
    entries: recordEntries,
    exclude: () => new Set(entriesShown.map((e) => `${e.kind}:${e.id}`)),
    onPick: (key) => {
      const at = key.indexOf(":");
      const kind = key.slice(0, at) as ScriptFile;
      const id = key.slice(at + 1);
      opened.push({ kind, id, role: "opened by name" });
      if (showing) show(SPECIES[showing.id] ?? showing);
    },
  });

  const show = (sp: Species | null): void => {
    root.innerHTML = "";
    marks = [];
    syncs = [];
    showing = sp;
    root.hidden = sp === null;
    listed = "";
    entriesShown = [];
    if (!sp) return;
    if (openedFor !== sp.id) {
      opened = [];
      openedFor = sp.id;
    }

    root.appendChild(el("div", "cosLabel", "Kit"));
    root.appendChild(el("div", "cosNote",
      "Which passives it rolls and which four moves it knows, picked out of the shared tables. A"
      + " move or a passive is one record however many lines use it, so editing one below changes"
      + " it for every one of them."));
    const kit = buildKitEditor(
      () => SPECIES[sp.id] ?? sp,
      (next, what) => {
        const line = clone(SPECIES[sp.id] ?? sp);
        line.primaryAbility = next.primaryAbility;
        line.secondaryPool = next.secondaryPool;
        line.moves = next.moves;
        if (next.hyperAbility) line.hyperAbility = next.hyperAbility;
        else delete line.hyperAbility;
        changeSpecies(sp.id, line, what);
      },
      {
        hyper: !sp.baby && !sp.pawn,
        create: (file, attach) => {
          builder.open(file, { attach, label: attachLabel(sp.name, attach) });
          builder.root.scrollIntoView({ block: "nearest" });
        },
      },
    );
    root.appendChild(kit.root);

    root.appendChild(el("div", "cosLabel", "New record"));
    const make = el("div", "cosRow");
    make.appendChild(button("cosMini", "+ Move", () => builder.open("moves")));
    make.appendChild(button("cosMini", "+ Passive", () => builder.open("passives")));
    make.appendChild(button("cosMini", "+ Status", () => builder.open("statuses")));
    make.appendChild(button("cosMini", "+ Field", () => builder.open("fields")));
    make.appendChild(opener.root);
    root.appendChild(make);
    root.appendChild(builder.root);

    root.appendChild(el("div", "cosLabel", "Data"));
    root.appendChild(el("div", "cosNote",
      "Each record exactly as it is written in its file. Moves, statuses, passives and fields are"
      + " move script, described in docs/move-script.md. An edit is checked as you type and applied"
      + " once the game can read it. Nothing is written until you save. A record keeps its id,"
      + " since everything else names it by that id."));
    entriesShown = entriesFor(sp).filter((e) => textOf(e) !== "");
    listed = listKey(sp);
    for (const entry of entriesShown) root.appendChild(box(entry));
  };

  const sync = (): void => {
    if (!showing) return;
    // Undo can take the line itself away, and the host picks another to show.
    const line = SPECIES[showing.id];
    if (!line) return;
    // Undo can put a line's own record back to a version with other moves or
    // passives in it, which changes what belongs in the list at all. So does
    // a record just made, taken back, or made again.
    if (listKey(line) !== listed || pretty(line) !== pretty(showing)) {
      show(line);
      return;
    }
    for (const catchUp of syncs) catchUp();
  };

  const changedFiles = (): ScriptFile[] =>
    SCRIPT_FILES.filter((file) => joinBlocks(live[file]) !== joinBlocks(saved[file]));

  const speciesChanged = (): boolean => pretty(SPECIES) !== pretty(savedSpecies);

  const dirty = (): boolean => changedFiles().length > 0 || speciesChanged();

  const save = async (): Promise<string> => {
    const files = changedFiles();
    const withSpecies = speciesChanged();
    if (files.length === 0 && !withSpecies) return "No data changed.";
    const post = async (name: string, body: string): Promise<void> => {
      const res = await fetch(`/api/content/${name}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body,
      });
      const text = (await res.text()).trim();
      if (!res.ok) throw new Error(text || `could not save ${name} (${res.status})`);
    };
    // Sent together, so every file is on its way before any of them lands.
    await Promise.all([
      ...files.map(async (file) => {
        const text = joinBlocks(live[file]);
        await post(file, text);
        saved[file] = splitBlocks(text);
      }),
      ...(withSpecies
        ? [(async () => {
          await post("species", JSON.stringify(Object.values(SPECIES)));
          for (const id of Object.keys(savedSpecies)) if (!SPECIES[id]) delete savedSpecies[id];
          for (const [id, sp] of Object.entries(SPECIES)) savedSpecies[id] = clone(sp);
        })()]
        : []),
    ]);
    // What was changed is saved now, so every box reads as saved again.
    for (const mark of marks) mark();
    const names = [...files.map((f) => `${f}.txt`), ...(withSpecies ? ["species.json"] : [])];
    return `Saved ${names.join(", ")}.`;
  };

  return {
    root, show, sync, dirty, save, addSpecies, words, savedWords, setWords,
    addRecord: (file, text) => createRecord(file, text, null, false),
  };
}
