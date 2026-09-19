// The form a new line is made with. It fills in what `species.json` needs and
// nothing more: everything else about a line can be edited in its JSON box
// once it exists.
import type { Art } from "../engine/assets";
import { checkSpecies } from "../sim/content/validate";
import type { ScriptFile } from "../sim/script/content";
import { SPECIES, type MovementStyle, type Species } from "../sim/species";
import { BABY_BUDGET, STAT_BUDGET, STAT_LABELS, STAT_NAMES, TYPES, TYPE_LABELS, statTotal, type ElementType } from "../sim/types";
import { blankSpecies, isId, slug, speciesRecord, unclaimedArt, type NewSpecies } from "./authoring";
import { attachLabel, buildBuilder } from "./builder";
import { button, el } from "./dom";
import { buildKitEditor, speciesEntries } from "./kit";
import { buildPicker } from "./pickers";

const GAITS: MovementStyle[] = ["hop", "scamper", "hover", "skitter", "moonhop"];

export interface NewScobaHost {
  /** Files the line. Returns what is wrong, or nothing. */
  create(sp: Species): string[];
  cancel(): void;
  /** Files a new move or passive written for the line. Returns what is wrong, or nothing. */
  file(file: ScriptFile, text: string): string[];
  note(text: string): void;
}

export interface NewScobaForm {
  root: HTMLElement;
  /** Starts the form over, empty. */
  reset(): void;
}

export function buildNewScoba(art: Art, host: NewScobaHost): NewScobaForm {
  const root = el("div", "cosNew cosWell");
  let draft: NewSpecies = blankSpecies();
  let idTyped = false;

  const head = el("div", "cosWordHead");
  head.appendChild(el("div", "cosWordWho", "New Scoba"));
  head.appendChild(button("cosMini", "Cancel", () => host.cancel()));
  root.appendChild(head);
  root.appendChild(el("div", "cosNote",
    "A line is its stats, its passives and its four moves. The art is a file in assets/Scobas by name,"
    + " and a line whose file is not drawn yet shows as a blob in its type's color until it is."));

  const select = (choices: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement => {
    const s = document.createElement("select");
    s.className = "cosField cosFormSel";
    for (const [v, label] of choices) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      s.appendChild(o);
    }
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };

  const labelled = (row: HTMLElement, what: string, control: HTMLElement): void => {
    row.appendChild(el("span", "cosKitWhat", what));
    row.appendChild(control);
  };

  // --- name and id ---
  const names = el("div", "cosRow cosFormRow");
  const nameIn = document.createElement("input");
  nameIn.className = "cosField cosFormIn";
  nameIn.placeholder = "Name";
  nameIn.autocomplete = "off";
  const idIn = document.createElement("input");
  idIn.className = "cosField cosFormIn cosMono";
  idIn.placeholder = "id";
  idIn.autocomplete = "off";
  idIn.spellcheck = false;
  nameIn.addEventListener("input", () => {
    draft.name = nameIn.value;
    if (!idTyped) {
      draft.id = slug(nameIn.value);
      idIn.value = draft.id;
      // A drawing named after the line is taken as its art until something else is picked.
      if (!artTouched) syncArt();
    }
  });
  idIn.addEventListener("input", () => {
    idTyped = idIn.value.trim() !== "";
    draft.id = idIn.value.trim();
    idIn.classList.toggle("bad", draft.id !== "" && !isId(draft.id));
    if (!artTouched) syncArt();
  });
  labelled(names, "Name", nameIn);
  labelled(names, "Id", idIn);
  root.appendChild(names);

  // --- type, art, gait ---
  const look = el("div", "cosRow cosFormRow");
  const typeChoices = TYPES.map((t): [string, string] => [t, TYPE_LABELS[t]]);
  const typeSel = select(typeChoices, draft.type, (v) => { draft.type = v as ElementType; });
  labelled(look, "Type", typeSel);
  const type2Sel = select([["", "none"], ...typeChoices], "", (v) => {
    if (v === "") delete draft.type2;
    else draft.type2 = v as ElementType;
  });
  labelled(look, "Second type", type2Sel);
  const artSel = document.createElement("select");
  artSel.className = "cosField cosFormSel";
  let artTouched = false;
  const drawArt = (): void => {
    artSel.innerHTML = "";
    const free = unclaimedArt(Object.keys(art.scobas));
    const own = document.createElement("option");
    own.value = "";
    own.textContent = "named after the id";
    artSel.appendChild(own);
    for (const name of free) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = `${name} (drawn, unclaimed)`;
      artSel.appendChild(o);
    }
  };
  /** Takes a drawing named after the id where there is one nobody has claimed. */
  const syncArt = (): void => {
    const free = unclaimedArt(Object.keys(art.scobas));
    artSel.value = free.includes(draft.id) ? draft.id : "";
    draft.art = artSel.value || draft.id;
  };
  artSel.addEventListener("change", () => {
    artTouched = artSel.value !== "";
    draft.art = artSel.value || draft.id;
  });
  labelled(look, "Art", artSel);
  const gaitSel = select(GAITS.map((g): [string, string] => [g, g]), draft.movement, (v) => { draft.movement = v as MovementStyle; });
  labelled(look, "Gait", gaitSel);
  root.appendChild(look);

  // --- stats ---
  const stats = el("div", "cosRow cosFormRow");
  const total = el("span", "cosNote", "");
  const budget = (): number => (draft.baby ? BABY_BUDGET : STAT_BUDGET);
  const drawTotal = (): void => {
    const sum = statTotal(draft.genes);
    total.textContent = `${sum} of ${budget()} points`;
    total.classList.toggle("cosOver", sum !== budget());
  };
  const statIns: HTMLInputElement[] = [];
  for (const stat of STAT_NAMES) {
    const n = document.createElement("input");
    n.type = "number";
    n.className = "cosField cosLevel";
    n.min = "0";
    n.value = String(draft.genes[stat]);
    n.addEventListener("input", () => {
      draft.genes[stat] = Math.max(0, Math.round(Number(n.value) || 0));
      drawTotal();
    });
    statIns.push(n);
    labelled(stats, STAT_LABELS[stat], n);
  }
  stats.appendChild(total);
  root.appendChild(stats);
  root.appendChild(el("div", "cosNote",
    `A standard line spends ${STAT_BUDGET} points at level 30 and a baby spends ${BABY_BUDGET}. See claude-notes/making-scobas.md.`));

  // --- what kind of line ---
  const flags = el("div", "cosRow cosFormRow");
  const boxes: HTMLInputElement[] = [];
  const flag = (what: string, onChange: (on: boolean) => void): HTMLElement => {
    const label = el("label", "cosRow");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => onChange(box.checked));
    boxes.push(box);
    label.appendChild(box);
    label.appendChild(el("span", undefined, what));
    return label;
  };
  flags.appendChild(flag("Starter", (on) => { draft.starter = on; }));
  flags.appendChild(flag("Baby (no Hyper-Mode, evolves at 15)", (on) => {
    draft.baby = on;
    drawTotal();
    kit.redraw();
  }));
  const evolves = el("span", "cosRow");
  const drawEvolves = (): void => {
    evolves.innerHTML = "";
    evolves.appendChild(el("span", "cosKitWhat", "Evolves into"));
    if (draft.evolvesTo) {
      const c = el("span", "cosChip");
      c.appendChild(el("span", undefined, SPECIES[draft.evolvesTo]?.name ?? draft.evolvesTo));
      c.appendChild(button("cosChipX", "×", () => {
        delete draft.evolvesTo;
        drawEvolves();
      }));
      evolves.appendChild(c);
    }
    evolves.appendChild(buildPicker({
      placeholder: draft.evolvesTo ? "Replace it" : "Nothing yet",
      entries: speciesEntries,
      onPick: (id) => {
        draft.evolvesTo = id;
        drawEvolves();
      },
    }).root);
  };
  drawEvolves();
  flags.appendChild(evolves);
  root.appendChild(flags);

  // --- passives and moves ---
  // A record written here is filed the moment it is added, whether or not the
  // line is. Undo takes it back out.
  const builder = buildBuilder({
    subject: () => null,
    create: (file, id, text, attach) => {
      const wrong = host.file(file, text);
      if (wrong.length > 0) return wrong;
      if (attach?.kind === "teach") draft.moves = [...draft.moves, id];
      else if (attach?.slot === "primary") draft.primaryAbility = id;
      else if (attach?.slot === "secondary") draft.secondaryPool = [...draft.secondaryPool, id];
      else if (attach?.slot === "hyper") draft.hyperAbility = id;
      kit.redraw();
      return [];
    },
    note: (text) => host.note(text),
  });
  const kit = buildKitEditor(
    () => draft,
    (next) => {
      draft = { ...draft, ...next };
      kit.redraw();
    },
    {
      hyper: true,
      create: (file, attach) => {
        builder.open(file, { attach, label: attachLabel(draft.name.trim() || "the new line", attach) });
        builder.root.scrollIntoView({ block: "nearest" });
      },
    },
  );
  root.appendChild(kit.root);
  root.appendChild(builder.root);

  // --- blurb ---
  const blurb = document.createElement("textarea");
  blurb.className = "cosField cosWordBox";
  blurb.rows = 2;
  blurb.placeholder = "Blurb for the index and the starter picker";
  blurb.addEventListener("input", () => { draft.blurb = blurb.value; });
  root.appendChild(blurb);

  // --- filing it ---
  const said = el("div", "cosDataSaid");
  root.appendChild(said);
  const actions = el("div", "cosRow");
  actions.appendChild(button("cosGo", "Create", () => {
    const problems: string[] = [];
    if (draft.name.trim() === "") problems.push("It needs a name.");
    if (!isId(draft.id)) problems.push("The id should be lower-case letters, digits and dashes.");
    else if (SPECIES[draft.id]) problems.push(`"${draft.id}" is already a line.`);
    if (draft.primaryAbility === "") problems.push("Pick its first passive.");
    if (draft.secondaryPool.length === 0) problems.push("Pick at least one passive for its second pool.");
    if (draft.moves.length === 0) problems.push("Pick its moves, or it has only a basic attack.");
    const sp = speciesRecord({ ...draft, name: draft.name.trim() });
    if (problems.length === 0) {
      for (const p of checkSpecies(sp)) problems.push(`${p.at === "" ? "It" : p.at} ${p.says}.`);
    }
    if (problems.length === 0) problems.push(...host.create(sp));
    said.innerHTML = "";
    for (const p of problems) said.appendChild(el("div", "cosDataProblem", p));
  }));
  root.appendChild(actions);

  const reset = (): void => {
    draft = blankSpecies();
    idTyped = false;
    artTouched = false;
    nameIn.value = "";
    idIn.value = "";
    blurb.value = "";
    said.innerHTML = "";
    typeSel.value = draft.type;
    type2Sel.value = "";
    gaitSel.value = draft.movement;
    for (const b of boxes) b.checked = false;
    drawArt();
    syncArt();
    statIns.forEach((n, i) => { n.value = String(draft.genes[STAT_NAMES[i]!]); });
    drawTotal();
    drawEvolves();
    kit.redraw();
  };
  reset();

  return { root, reset };
}
