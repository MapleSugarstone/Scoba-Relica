// Writing a new move, passive, status or field in move script, with the
// language at hand: a template to start from, a palette of every line the
// language takes to put in at the caret, the record checked as it is typed,
// and the sentence the game would build from it.
import { describeMoveEffects, describeStatus } from "../sim/describe";
import { FILE_RECORD, brokenRefs, type ScriptFile } from "../sim/script/content";
import { readScript } from "../sim/script/read";
import { MAX_MOVES, MOVES, SPECIES, type Species } from "../sim/species";
import { FIELDS, STATUSES, type StatusDef } from "../sim/status";
import { proseNodes } from "../ui/prose";
import { TEMPLATES, idTaken, insertLine, isId, referenceFor, slug } from "./authoring";
import { button, el } from "./dom";
import { indentWithTab } from "./textbox";

/** Where a new record is put to use the moment it is made. */
export type Attach =
  | { kind: "teach" }
  | { kind: "passive"; slot: "primary" | "secondary" | "hyper" };

/** A destination decided before the builder opens, by the button that opened it. */
export interface Into {
  attach: Attach;
  /** What happens to the record as it is filed, shown in place of the choice. */
  label: string;
}

export interface BuilderHost {
  /** The line on screen, which a new move or passive can be handed to. */
  subject(): Species | null;
  /** Files the record and puts it to use. Returns what is wrong, or nothing. */
  create(file: ScriptFile, id: string, text: string, attach: Attach | null): string[];
  note(text: string): void;
}

export interface Builder {
  root: HTMLElement;
  /** Opens the builder on one kind of record, bound for one place where `into` says so. */
  open(file: ScriptFile, into?: Into): void;
}

const KIND_LABEL: Record<ScriptFile, string> = {
  moves: "move", passives: "passive", statuses: "status", fields: "field", hobbies: "hobby",
};

/** What a destination does to a line, for the builder's attach row. */
export function attachLabel(name: string, attach: Attach): string {
  if (attach.kind === "teach") return `Added to ${name}'s moves as it is filed.`;
  if (attach.slot === "primary") return `Becomes ${name}'s first passive as it is filed.`;
  if (attach.slot === "secondary") return `Goes into ${name}'s second pool as it is filed.`;
  return `Becomes ${name}'s Hyper-Mode passive as it is filed.`;
}

/** What is wrong with a new record's text, or nothing where it can be filed. */
export function checkNew(file: ScriptFile, text: string): { problems: string[]; id: string | null } {
  const read = readScript(text, FILE_RECORD[file]);
  const line = (p: { line: number; says: string }): string => `Line ${p.line} ${p.says}${/[.?!]$/.test(p.says) ? "" : "."}`;
  if (read.problems.length > 0) return { problems: read.problems.map(line), id: null };
  const ids = file === "moves" ? read.moves.map((m) => m.id)
    : file === "statuses" ? read.statuses.map((s) => s.id)
      : file === "passives" ? read.abilities.map((a) => a.id)
        : read.fields.map((f) => f.id);
  if (ids.length !== 1) return { problems: [`The box should hold exactly one ${KIND_LABEL[file]}, and holds ${ids.length}.`], id: null };
  const id = ids[0]!;
  const problems: string[] = [];
  const taken = idTaken(file, id);
  if (taken) problems.push(`The id is taken: ${taken}.`);
  for (const p of brokenRefs(read.refs.map((r) => ({ ...r, file })), {
    moves: MOVES, statuses: STATUSES, species: SPECIES, fields: FIELDS,
  })) problems.push(line(p));
  return { problems, id };
}

export function buildBuilder(host: BuilderHost): Builder {
  const root = el("div", "cosBuilder cosWell");
  root.hidden = true;
  let file: ScriptFile = "moves";
  /** Where the record goes, when the button that opened the builder decided that. */
  let into: Into | null = null;
  /** Whether the box holds something typed rather than a template, which a knob must not overwrite. */
  let touched = false;
  /** Whether the id was typed by hand, so the name stops filling it in. */
  let idTyped = false;

  const head = el("div", "cosWordHead");
  const title = el("div", "cosWordWho", "");
  head.appendChild(title);
  const closeB = button("cosMini", "Close", () => { root.hidden = true; });
  head.appendChild(closeB);
  root.appendChild(head);

  // --- name, id, template ---
  const knobs = el("div", "cosRow cosFormRow");
  const nameIn = document.createElement("input");
  nameIn.className = "cosField cosFormIn";
  nameIn.placeholder = "Name";
  nameIn.autocomplete = "off";
  const idIn = document.createElement("input");
  idIn.className = "cosField cosFormIn cosMono";
  idIn.placeholder = "id";
  idIn.autocomplete = "off";
  idIn.spellcheck = false;
  const templateSel = document.createElement("select");
  templateSel.className = "cosField cosFormSel";
  const startB = button("cosMini", "Start from template", () => fill(true));
  knobs.appendChild(el("span", "cosKitWhat", "Name"));
  knobs.appendChild(nameIn);
  knobs.appendChild(el("span", "cosKitWhat", "Id"));
  knobs.appendChild(idIn);
  knobs.appendChild(el("span", "cosKitWhat", "Template"));
  knobs.appendChild(templateSel);
  knobs.appendChild(startB);
  root.appendChild(knobs);
  const templateSays = el("div", "cosNote", "");
  root.appendChild(templateSays);

  // --- the box and the palette beside it ---
  const work = el("div", "cosBuildWork");
  const boxSide = el("div", "cosBuildBox");
  const field = document.createElement("textarea");
  field.className = "cosField cosDataText";
  field.spellcheck = false;
  field.rows = 16;
  indentWithTab(field);
  boxSide.appendChild(field);
  const said = el("div", "cosDataSaid");
  boxSide.appendChild(said);
  const reads = el("div", "cosBuildReads");
  boxSide.appendChild(reads);
  work.appendChild(boxSide);
  const palette = el("div", "cosPalette cosWell");
  work.appendChild(palette);
  root.appendChild(work);

  // --- where it goes, and the button ---
  const attachRow = el("div", "cosRow cosFormRow");
  root.appendChild(attachRow);
  const actions = el("div", "cosRow");
  const addB = button("cosGo", "Add", () => add());
  actions.appendChild(addB);
  actions.appendChild(button("cosMini", "Clear", () => {
    touched = false;
    fill(true);
  }));
  root.appendChild(actions);

  const currentId = (): string => (idTyped ? idIn.value.trim() : slug(nameIn.value));

  const templates = () => TEMPLATES[file];

  const fill = (force: boolean): void => {
    if (touched && !force) return;
    const t = templates()[Number(templateSel.value)] ?? templates()[0]!;
    const id = currentId() || `new-${KIND_LABEL[file]}`;
    const name = nameIn.value.trim() || `New ${KIND_LABEL[file]}`;
    field.value = t.text(id, name);
    touched = false;
    check();
  };

  const drawTemplates = (): void => {
    templateSel.innerHTML = "";
    templates().forEach((t, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = t.label;
      templateSel.appendChild(o);
    });
    templateSays.textContent = templates()[0]?.says ?? "";
  };

  /** Puts a line from the palette in at the caret. */
  const insert = (line: string): void => {
    const at = field.selectionStart;
    const next = insertLine(field.value, at, line);
    field.value = next.text;
    field.setSelectionRange(next.caret, next.caret);
    field.focus();
    touched = true;
    check();
  };

  const drawPalette = (): void => {
    palette.innerHTML = "";
    palette.appendChild(el("div", "cosLabel", "Put in a line"));
    palette.appendChild(el("div", "cosNote", "Click a line to put it in at the caret. Hover for what it does. Every line is described in docs/move-script.md."));
    for (const group of referenceFor(file)) {
      const box = document.createElement("details");
      box.className = "cosPalGroup";
      const sum = document.createElement("summary");
      sum.textContent = group.label;
      box.appendChild(sum);
      for (const line of group.lines) {
        const b = button("cosPalB", line.form, () => insert(line.example));
        b.title = `${line.says}\n\n${line.example}`;
        box.appendChild(b);
      }
      palette.appendChild(box);
    }
  };

  const drawAttach = (): void => {
    attachRow.innerHTML = "";
    if (into) {
      const bound = into;
      attachRow.appendChild(el("span", "cosNote", bound.label));
      attach = () => bound.attach;
      return;
    }
    attach = () => null;
    const sp = host.subject();
    if (!sp || (file !== "moves" && file !== "passives")) return;
    if (file === "moves") {
      const on = document.createElement("input");
      on.type = "checkbox";
      const room = sp.moves.length < MAX_MOVES;
      on.checked = room;
      const label = el("label", "cosRow");
      label.appendChild(on);
      label.appendChild(el("span", undefined, room
        ? `Give it to ${sp.name} (${sp.moves.length} of ${MAX_MOVES} moves)`
        : `Give it to ${sp.name}, which already lists ${sp.moves.length} moves`));
      attachRow.appendChild(label);
      attach = () => (on.checked ? { kind: "teach" } : null);
      return;
    }
    const sel = document.createElement("select");
    sel.className = "cosField cosFormSel";
    const choices: [string, string][] = [
      ["", `Do not hand it to ${sp.name}`],
      ["secondary", `Add it to ${sp.name}'s second pool`],
      ["primary", `Make it ${sp.name}'s first passive`],
      ...(sp.baby ? [] : [["hyper", `Make it ${sp.name}'s Hyper-Mode passive`] as [string, string]]),
    ];
    for (const [v, t] of choices) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      sel.appendChild(o);
    }
    sel.value = "secondary";
    attachRow.appendChild(sel);
    attach = () => (sel.value === "" ? null : { kind: "passive", slot: sel.value as "primary" | "secondary" | "hyper" });
  };
  let attach: () => Attach | null = () => null;

  /** The sentence the game would build, and the written line as a player reads it. */
  const preview = (): void => {
    reads.innerHTML = "";
    const read = readScript(field.value, FILE_RECORD[file]);
    if (read.problems.length > 0) return;
    // A status the record itself brings, so a passive's own status can be described.
    const statuses: Record<string, StatusDef> = { ...STATUSES };
    for (const s of read.statuses) statuses[s.id] = s;
    const say = (label: string, node: Node): void => {
      const row = el("div", "cosBuildRead");
      row.appendChild(el("span", "cosLabel", label));
      row.appendChild(node);
      reads.appendChild(row);
    };
    const move = read.moves[0];
    if (move) {
      say("The game would say", document.createTextNode(describeMoveEffects(move, { statuses })));
      if (move.text !== undefined) say("Written line", proseNodes(move.text, { move }));
      return;
    }
    const status = read.statuses[0];
    if (status) say("The game would say", document.createTextNode(describeStatus(status.id, { statuses }) || "Nothing yet: it has no effect."));
    const ability = read.abilities[0];
    if (ability) {
      const granted = ability.grantsMove ? MOVES[ability.grantsMove] : null;
      if (granted) say("Grants", document.createTextNode(`${granted.name}${granted.oncePerBattle ? ", once a battle" : ""}`));
      if (ability.text !== undefined) say("Written line", proseNodes(ability.text, {}));
    }
  };

  const check = (): string[] => {
    const { problems } = checkNew(file, field.value);
    said.innerHTML = "";
    field.classList.toggle("bad", problems.length > 0);
    for (const p of problems) said.appendChild(el("div", "cosDataProblem", p));
    addB.disabled = problems.length > 0;
    preview();
    return problems;
  };

  const add = (): void => {
    const { problems, id } = checkNew(file, field.value);
    if (problems.length > 0 || !id) {
      host.note(`The ${KIND_LABEL[file]} is not filed until it is fixed.`);
      return;
    }
    const wrong = host.create(file, id, field.value.replace(/\r\n/g, "\n").replace(/\s+$/, ""), attach());
    if (wrong.length > 0) {
      said.innerHTML = "";
      for (const p of wrong) said.appendChild(el("div", "cosDataProblem", p));
      return;
    }
    host.note(`${id} filed in ${file}.txt. Save to write it.`);
    touched = false;
    nameIn.value = "";
    idIn.value = "";
    idTyped = false;
    root.hidden = true;
  };

  nameIn.addEventListener("input", () => {
    if (!idTyped) idIn.value = slug(nameIn.value);
    fill(false);
  });
  idIn.addEventListener("input", () => {
    idTyped = idIn.value.trim() !== "";
    idIn.classList.toggle("bad", idIn.value.trim() !== "" && !isId(idIn.value.trim()));
    fill(false);
  });
  templateSel.addEventListener("change", () => {
    templateSays.textContent = templates()[Number(templateSel.value)]?.says ?? "";
    fill(false);
  });
  field.addEventListener("input", () => {
    touched = true;
    check();
  });

  const open = (kind: ScriptFile, bound?: Into): void => {
    const same = kind === file && !root.hidden;
    file = kind;
    into = bound ?? null;
    title.textContent = `New ${KIND_LABEL[file]}`;
    root.hidden = false;
    drawTemplates();
    drawPalette();
    drawAttach();
    if (!same) {
      touched = false;
      fill(true);
    }
    nameIn.focus();
  };

  return { root, open };
}
