// The card a Scoba or a line is read on: its face on a stage, who it is and
// what it is like, its stats as a hexagon, its passives and its moves, and a
// note that reads out whichever of those was pressed. The Box shows one for a
// Scoba it holds and the index one for a line, so it is written once here and
// each of them only says what goes on it.
import { sfx } from "../engine/sfx";
import { abilityText, moveText } from "../game/texts";
import type { ProseFor } from "../sim/prose";
import { ABILITIES, moveTypes, type Move } from "../sim/species";
import type { ElementType, Stats } from "../sim/types";
import { actButton, moveSub } from "./actbutton";
import { proseBox } from "./prose";
import type { UI } from "./screens";
import { statHex, type HexLook } from "./stathex";
import { typeIcon } from "./typeicon";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** One passive or move on the card, and what pressing it reads out. */
export interface CardSlot {
  label: string;
  /** The line under its name. */
  sub: string;
  /** Said after its name in the note: "passive", "magical" and so on. */
  kind: string;
  /** What it does, as a written line with its numbers still to work out. */
  desc: string;
  move?: Move;
  /** Its elements, which colour its button; none for a passive. */
  types?: ElementType[];
}

export interface CardSpec {
  face: HTMLElement;
  name: string;
  /** Beside the name: a level, or a line's place in the index. */
  tag: string;
  /** The row under the name: badges and short marks. */
  kinds: HTMLElement[];
  bio: string;
  hex: { stats: Stats; color: string; look?: HexLook };
  passives: CardSlot[];
  moves: CardSlot[];
  /** What the note says before anything is pressed. */
  hint: string;
  /** What a number in a slot's line is worked out against. */
  prose: Omit<ProseFor, "move">;
  onBack: () => void;
}

/** A passive as a slot, or nothing for an id with no passive behind it. */
export function passiveSlot(id: string | undefined, sub = "passive"): CardSlot[] {
  const ability = id ? ABILITIES[id] : undefined;
  if (!ability) return [];
  return [{ label: ability.name, sub, kind: sub, desc: abilityText(ability.id) }];
}

/**
 * A move as a slot, at what it costs whoever it is read for. A cost over the
 * move's own is a move worked rather than known, and the note says so.
 */
export function moveSlot(move: Move, cost: number): CardSlot {
  return {
    label: move.name,
    // The same line the fight puts under it, less a rest still running,
    // which only a fight has.
    sub: moveSub(move, cost),
    kind: cost > move.manaCost ? `${move.kind} · worked` : move.kind,
    desc: moveText(move),
    move,
    types: moveTypes(move),
  };
}

export function openCard(ui: UI, spec: CardSpec): void {
  let showing: CardSlot | null = null;

  ui.screen((screen) => {
    screen.classList.add("tight");
    const card = el("div", "bxCard");

    // The face on its stage, who it is and what it is like, and its six
    // stats as a shape rather than as a list of numbers.
    const head = el("div", "bxCardHead");
    const port = el("div", "bxPortrait");
    port.appendChild(spec.face);
    head.appendChild(port);

    const facts = el("div", "bxFacts");
    const top = el("div", "bxFactsTop");
    const who = el("div", "bxWho");
    who.appendChild(el("span", "bxCardName", spec.name));
    who.appendChild(el("span", "dim", spec.tag));
    top.appendChild(who);
    const back = el("button", "bxCardBack", "Back");
    back.addEventListener("click", () => {
      sfx.back();
      spec.onBack();
    });
    top.appendChild(back);
    facts.appendChild(top);

    const kinds = el("div", "bxCardKinds");
    for (const k of spec.kinds) kinds.appendChild(k);
    facts.appendChild(kinds);
    if (spec.bio !== "") facts.appendChild(el("p", "bxBio", spec.bio));
    head.appendChild(facts);

    head.appendChild(statHex(spec.hex.stats, spec.hex.color, spec.hex.look));
    card.appendChild(head);

    // Nothing is marked on the board: the note under it opens with the name
    // of what it is reading, which is what says which one was pressed.
    const note = el("div", "bxNote");
    const fillNote = (): void => {
      note.innerHTML = "";
      if (!showing) {
        note.appendChild(el("div", "dim", spec.hint));
        return;
      }
      const noteHead = el("div", "bxNoteHead");
      noteHead.appendChild(el("strong", undefined, showing.label));
      for (const t of showing.types ?? []) noteHead.appendChild(typeIcon(t));
      noteHead.appendChild(el("span", "dim", showing.kind));
      note.appendChild(noteHead);
      // Read against whoever the card is for, so a damage line is the number
      // that Scoba, or that line at the level it is read at, would deal.
      note.appendChild(proseBox(showing.desc, { ...spec.prose, move: showing.move ?? null }));
    };

    // The same button the fight puts a move on, so a move reads as the same
    // thing wherever it is read: its element as its fill, its elements as
    // badges at its end, and a passive as a plain one.
    const row = (slots: CardSlot[], cols: number): HTMLElement => {
      const grid = el("div", "bxSlots");
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      for (const what of slots) {
        const [first, second] = what.types ?? [];
        grid.appendChild(actButton(what.label, what.sub, () => {
          showing = what;
          fillNote();
        }, {
          ...(first ? { type: first } : { alt: true }),
          ...(second ? { type2: second } : {}),
        }));
      }
      return grid;
    };
    // The passives share a row however many there are, which for a line with
    // two to roll its second from is three; the moves go two to a row.
    if (spec.passives.length > 0) card.appendChild(row(spec.passives, spec.passives.length));
    card.appendChild(row(spec.moves, 2));
    fillNote();
    card.appendChild(note);
    screen.appendChild(card);
  });
}
