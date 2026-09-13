// A line's kit, edited by picking rather than by hand: which passives it
// rolls and which moves it learns at which level.
//
// Every entry is an id into a shared table. A move added here is the same
// record every other line learns it by, so editing that record changes it
// for all of them. The same editor serves the Data section of an existing line
// and the form a new line is made with.
import { describeAbility } from "../sim/describe";
import type { ScriptFile } from "../sim/script/content";
import { ABILITIES, MAX_MOVES, MOVES, SPECIES, rosterSpecies, typeLabel, type Move } from "../sim/species";
import { TYPE_LABELS } from "../sim/types";
import type { Attach } from "./builder";
import { button, el } from "./dom";
import { buildPicker, type PickEntry } from "./pickers";

export interface KitState {
  primaryAbility: string;
  secondaryPool: string[];
  hyperAbility?: string;
  moves: string[];
}

export interface KitEditor {
  root: HTMLElement;
  /** Draws the kit again off `get`, after the state changed. */
  redraw(): void;
}

/** A move as the picker lists it. */
export function moveEntry(m: Move): PickEntry {
  const type = m.type2 ? `${TYPE_LABELS[m.type]}/${TYPE_LABELS[m.type2]}` : TYPE_LABELS[m.type];
  return { id: m.id, name: m.name, hint: `${type} · ${m.manaCost} mana · ${m.kind}` };
}

/** Every move that is written in a file rather than built during a battle. */
export const moveEntries = (): PickEntry[] => Object.values(MOVES).filter((m) => !m.derived).map(moveEntry);

const short = (s: string): string => (s.length > 72 ? `${s.slice(0, 70)}...` : s);

export const abilityEntries = (): PickEntry[] => Object.values(ABILITIES)
  .map((a) => ({ id: a.id, name: a.name, hint: short(a.text ?? describeAbility(a.id)) }));

/** Every line a player could keep, for picking what a line grows into. */
export const speciesEntries = (): PickEntry[] => rosterSpecies()
  .map((sp) => ({ id: sp.id, name: sp.name, hint: typeLabel(sp) }));

export interface KitOpts {
  /** Whether the line can carry a Hyper-Mode passive. A baby and a Pawn cannot. */
  hyper: boolean;
  /** Opens the builder on a new record bound for one slot, where the host has one. */
  create?: (file: ScriptFile, attach: Attach) => void;
}

export function buildKitEditor(
  get: () => KitState,
  set: (next: KitState, what: string) => void,
  opts: KitOpts,
): KitEditor {
  const root = el("div", "cosKit");

  /** The button that writes a new record straight into a slot. */
  const fresh = (file: ScriptFile, attach: Attach): HTMLElement | null =>
    (opts.create ? button("cosMini", "+ New", () => opts.create!(file, attach)) : null);
  const withFresh = (row: HTMLElement, file: ScriptFile, attach: Attach): void => {
    const b = fresh(file, attach);
    if (b) row.appendChild(b);
  };

  const chip = (name: string, id: string, remove: (() => void) | null): HTMLElement => {
    const c = el("span", "cosChip");
    c.appendChild(el("span", undefined, name));
    c.appendChild(el("span", "cosChipId", id));
    if (remove) c.appendChild(button("cosChipX", "×", remove));
    return c;
  };

  const redraw = (): void => {
    root.innerHTML = "";
    const kit = get();
    const known = new Set([kit.primaryAbility, ...kit.secondaryPool, kit.hyperAbility ?? ""]);

    // --- passives ---
    const passives = el("div", "cosKitBlock");
    passives.appendChild(el("div", "cosLabel", "Passives"));

    const first = el("div", "cosRow cosKitRow");
    first.appendChild(el("span", "cosKitWhat", "First"));
    const primary = ABILITIES[kit.primaryAbility];
    if (primary) first.appendChild(chip(primary.name, primary.id, null));
    else first.appendChild(el("span", "cosNote", kit.primaryAbility ? `${kit.primaryAbility} (no such passive)` : "none yet"));
    first.appendChild(buildPicker({
      placeholder: primary ? "Replace it" : "Pick a passive",
      entries: abilityEntries,
      exclude: () => new Set([kit.primaryAbility]),
      onPick: (id) => set({ ...get(), primaryAbility: id }, `first passive is ${ABILITIES[id]?.name ?? id}`),
    }).root);
    withFresh(first, "passives", { kind: "passive", slot: "primary" });
    passives.appendChild(first);

    const second = el("div", "cosRow cosKitRow");
    second.appendChild(el("span", "cosKitWhat", "Second"));
    for (const id of kit.secondaryPool) {
      second.appendChild(chip(ABILITIES[id]?.name ?? id, id, () => set(
        { ...get(), secondaryPool: get().secondaryPool.filter((x) => x !== id) },
        `${ABILITIES[id]?.name ?? id} taken out of the second pool`,
      )));
    }
    second.appendChild(buildPicker({
      placeholder: kit.secondaryPool.length === 0 ? "Pick a passive it can roll" : "Add another",
      entries: abilityEntries,
      exclude: () => new Set(get().secondaryPool),
      onPick: (id) => set({ ...get(), secondaryPool: [...get().secondaryPool, id] }, `${ABILITIES[id]?.name ?? id} added to the second pool`),
    }).root);
    withFresh(second, "passives", { kind: "passive", slot: "secondary" });
    passives.appendChild(second);

    if (opts.hyper) {
      const hyper = el("div", "cosRow cosKitRow");
      hyper.appendChild(el("span", "cosKitWhat", "Hyper"));
      if (kit.hyperAbility) {
        hyper.appendChild(chip(ABILITIES[kit.hyperAbility]?.name ?? kit.hyperAbility, kit.hyperAbility, () => {
          const next = { ...get() };
          delete next.hyperAbility;
          set(next, "Hyper-Mode passive taken off");
        }));
      } else {
        hyper.appendChild(el("span", "cosNote", "none, so it has no Hyper-Mode"));
      }
      hyper.appendChild(buildPicker({
        placeholder: kit.hyperAbility ? "Replace it" : "Pick a Hyper-Mode passive",
        entries: abilityEntries,
        exclude: () => new Set([get().hyperAbility ?? ""]),
        onPick: (id) => set({ ...get(), hyperAbility: id }, `Hyper-Mode passive is ${ABILITIES[id]?.name ?? id}`),
      }).root);
      withFresh(hyper, "passives", { kind: "passive", slot: "hyper" });
      passives.appendChild(hyper);
    }
    root.appendChild(passives);

    // --- moves ---
    const moves = el("div", "cosKitBlock");
    moves.appendChild(el("div", "cosLabel", `Moves (${kit.moves.length} of ${MAX_MOVES})`));
    kit.moves.forEach((id, i) => {
      const row = el("div", "cosRow cosKitRow");
      row.appendChild(el("span", "cosKitWhat", String(i + 1)));
      const m = MOVES[id];
      row.appendChild(chip(m?.name ?? id, id, () => set(
        { ...get(), moves: get().moves.filter((x) => x !== id) },
        `${m?.name ?? id} taken off`,
      )));
      if (m) row.appendChild(el("span", "cosNote", moveEntry(m).hint ?? ""));
      else row.appendChild(el("span", "cosNote", "no such move"));
      moves.appendChild(row);
    });
    if (kit.moves.length < MAX_MOVES) {
      const add = el("div", "cosRow cosKitRow");
      add.appendChild(el("span", "cosKitWhat", String(kit.moves.length + 1)));
      add.appendChild(buildPicker({
        placeholder: kit.moves.length === 0 ? "Pick a move it knows" : "Add a move it knows",
        entries: moveEntries,
        exclude: () => new Set(get().moves),
        onPick: (id) => set({ ...get(), moves: [...get().moves, id] }, `${MOVES[id]?.name ?? id} added`),
      }).root);
      withFresh(add, "moves", { kind: "teach" });
      moves.appendChild(add);
    } else if (kit.moves.length > MAX_MOVES) {
      moves.appendChild(el("div", "cosNote",
        `A Scoba holds ${MAX_MOVES} moves. With more listed, it keeps the ${MAX_MOVES} cheapest. Take some off to add another.`));
    }
    root.appendChild(moves);
  };

  redraw();
  return { root, redraw };
}

/** The lines that share a record, named, for saying how far an edit reaches. */
export function namesOf(ids: readonly string[]): string {
  return ids.map((id) => SPECIES[id]?.name ?? id).join(", ");
}
