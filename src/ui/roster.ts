// The two screens that manage Scobas out of a fight: the Box, which is where
// everything caught is kept and where the fielded three are put in order, and
// the Party, which is where Aetus is spent and where a Scoba is named.
//
// Both work on one character at a time. Playing solo means holding both, so
// they offer a switch; once a second player has joined, each client only ever
// arranges its own.
import type { Art } from "../engine/assets";
import { sfx } from "../engine/sfx";
import { critterPortrait } from "../game/critters";
import { displayName } from "../sim/battle";
import { face, openBrowser } from "./browser";
import { typeIcons } from "./typeicon";
import {
  EVOLVE_COST,
  LEVEL_COST,
  evolve,
  evolveError,
  levelUp,
  levelUpError,
} from "../sim/growth";
import { maxHp, type ScobaInstance } from "../sim/scoba";
import { SPECIES, evolutionOf } from "../sim/species";
import type { SaveData, SlotId } from "../save/save";
import {
  boxOf,
  partyHasRoom,
  partyOf,
  reorderParty,
  sendToBox,
  takeFromBox,
} from "../save/save";
import type { UI } from "./screens";

/** Longest a nickname can be, so a card and a battle plate still fit it. */
export const MAX_NICKNAME = 14;

export interface RosterHooks {
  /** Back to the menu. */
  onBack: () => void;
  /** The roster changed: write the save and rebuild who walks with whom. */
  onChange: () => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const pill = (label: string, onClick: (() => void) | null, cls = ""): HTMLButtonElement => {
  const b = el("button", `pill${cls ? ` ${cls}` : ""}`, label);
  if (onClick) {
    b.addEventListener("click", () => {
      sfx.tap();
      onClick();
    });
  } else {
    b.disabled = true;
  }
  return b;
};

const bigBtn = (label: string, onClick: () => void, primary = false): HTMLButtonElement => {
  const b = el("button", `big${primary ? " primary" : ""}`, label);
  b.addEventListener("click", () => {
    sfx.tap();
    onClick();
  });
  return b;
};

/** Portrait at list size, cropped to the critter and wearing its own mask. */
function portrait(art: Art, s: ScobaInstance, px: number): HTMLElement {
  const sp = SPECIES[s.speciesId];
  const wrap = el("div", "pface");
  if (!sp) return wrap;
  const cv = critterPortrait(art, sp, s.tint, s.shiny);
  cv.style.height = `${px}px`;
  cv.style.width = "auto";
  wrap.appendChild(cv);
  return wrap;
}

function nameBlock(s: ScobaInstance): HTMLElement {
  const sp = SPECIES[s.speciesId];
  const box = el("div", "pname");
  box.appendChild(el("strong", undefined, displayName(s)));
  const line = el("div", "pnameLine");
  line.appendChild(el("span", "dim", `Lv ${s.level}`));
  if (s.shiny) {
    const star = el("span", "shiny", "★");
    star.title = "Shiny";
    line.appendChild(star);
  }
  if (sp) line.appendChild(typeIcons(sp));
  box.appendChild(line);
  return box;
}

/** The character whose Scobas a screen is showing, and the row that swaps it. */
function ownerRow(save: SaveData, owner: SlotId, onPick: (o: SlotId) => void): HTMLElement | null {
  // With a second player in, the other character's Scobas are theirs to order.
  if (save.partnerJoined) return null;
  const row = el("div", "row");
  for (const slot of ["A", "B"] as SlotId[]) {
    row.appendChild(pill(save.characters[slot].name, slot === owner ? null : () => onPick(slot),
      slot === owner ? "sel" : ""));
  }
  return row;
}

/**
 * The Box: everything a character has caught, with the three that field laid
 * along the bottom. The grid holds the boxed ones and the strip holds the
 * party, and a Scoba is moved between them by picking it and pressing Add or
 * Drop. The arrows between the party faces put them in order, which is the
 * order they are fielded and walked in.
 */
export function openBox(ui: UI, art: Art, save: SaveData, hooks: RosterHooks): void {
  /** Which of the fielded three the strip has highlighted, for Drop. */
  let held: string | null = null;
  openBrowser(ui, art, save, {
    title: "Box",
    memory: "box",
    ownerSwitch: true,
    hint: "Pick a face to see what it is.",
    empty: "The box is empty. Everything caught goes here.",
    source: (owner) => boxOf(save, owner),
    onBack: hooks.onBack,
    foot: (ctx) => {
      const owner = ctx.owner();
      const party = partyOf(save, owner);
      const strip = el("div", "bxPanel bxParty");

      const changed = (): void => {
        sfx.confirm();
        hooks.onChange();
        ctx.refresh();
      };

      const row = el("div", "bxPartyRow");
      party.forEach((m, i) => {
        const cell = el("button", `bxCell${m.uid === held ? " sel" : ""}`);
        cell.title = `${displayName(m)} · Lv ${m.level}`;
        cell.appendChild(face(art, m));
        cell.addEventListener("click", () => {
          sfx.tap();
          held = m.uid;
          // Borrow the readout, so a fielded Scoba can be read from here too.
          ctx.show(m);
        });
        row.appendChild(cell);
        // An arrow sits between two faces and swaps the pair it is between.
        if (i < party.length - 1) {
          const swap = el("button", "bxSwap", "↔");
          swap.title = "Swap these two";
          swap.addEventListener("click", () => {
            if (reorderParty(save, owner, m.uid, 1)) changed();
          });
          row.appendChild(swap);
        }
      });
      if (party.length === 0) row.appendChild(el("div", "dim", "Nobody fielded."));
      strip.appendChild(row);

      // Add works on the grid's pick, Drop on the strip's.
      const gridPick = ctx.gridPick();
      const partyPick = party.find((m) => m.uid === held) ?? null;
      const ops = el("div", "bxOps");
      const add = el("button", "bxWide", "Add");
      add.disabled = !gridPick || !partyHasRoom(save, owner);
      add.addEventListener("click", () => {
        if (gridPick && takeFromBox(save, gridPick.uid)) {
          held = gridPick.uid;
          ctx.show(gridPick);
          changed();
        }
      });
      const drop = el("button", "bxWide", "Drop");
      drop.disabled = !partyPick || party.length <= 1;
      drop.addEventListener("click", () => {
        if (!partyPick || !sendToBox(save, partyPick.uid)) return;
        held = null;
        ctx.show(null);
        changed();
      });
      ops.appendChild(add);
      ops.appendChild(drop);
      strip.appendChild(ops);
      return strip;
    },
  });
}

export function openParty(ui: UI, art: Art, save: SaveData, hooks: RosterHooks): void {
  let owner: SlotId = save.localSlot;

  const render = (): void => {
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, "Party"));
      s.appendChild(el("div", "sub", `${save.aetus} Aetus`));
      const owners = ownerRow(save, owner, (o) => {
        owner = o;
        render();
      });
      if (owners) s.appendChild(owners);

      for (const m of partyOf(save, owner)) {
        s.appendChild(memberCard(m));
      }
      s.appendChild(bigBtn("Back", hooks.onBack, true));
    });
  };

  const memberCard = (m: ScobaInstance): HTMLElement => {
    const card = el("div", "card");
    const head = el("div", "who");
    head.appendChild(portrait(art, m, 48));
    head.appendChild(nameBlock(m));
    card.appendChild(head);
    card.appendChild(el("div", "dim", `HP ${m.hp}/${maxHp(m)}`));

    const levelWhy = levelUpError(m, save.aetus);
    const evolveWhy = evolveError(m, save.aetus);
    const row = el("div", "row");
    row.appendChild(pill(`Level up · ${LEVEL_COST}`, levelWhy ? null : () => buyLevel(m)));
    row.appendChild(pill(`Evolve · ${EVOLVE_COST}`, evolveWhy ? null : () => buyEvolve(m)));
    row.appendChild(pill("Rename", () => renameScreen(m)));
    card.appendChild(row);

    const notes: string[] = [];
    if (levelWhy) notes.push(levelWhy);
    if (evolveWhy) notes.push(evolveWhy);
    if (notes.length > 0) card.appendChild(el("div", "dim", notes.join(" · ")));
    return card;
  };

  const buyLevel = (m: ScobaInstance): void => {
    if (levelUpError(m, save.aetus)) return;
    save.aetus -= LEVEL_COST;
    levelUp(m);
    sfx.confirm();
    hooks.onChange();
    ui.toast(`${displayName(m)} is level ${m.level}.`);
    render();
  };

  const buyEvolve = (m: ScobaInstance): void => {
    if (evolveError(m, save.aetus)) return;
    const was = displayName(m);
    const into = evolutionOf(SPECIES[m.speciesId]!);
    save.aetus -= EVOLVE_COST;
    evolve(m);
    sfx.confirm();
    hooks.onChange();
    ui.toast(`${was} became ${into?.name ?? displayName(m)}!`);
    render();
  };

  const renameScreen = (m: ScobaInstance): void => {
    const sp = SPECIES[m.speciesId];
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, `Name ${displayName(m)}`));
      const card = el("div", "card");
      card.appendChild(portrait(art, m, 64));
      const input = el("input");
      input.type = "text";
      input.maxLength = MAX_NICKNAME;
      input.value = m.nickname ?? "";
      input.placeholder = sp?.name ?? m.speciesId;
      card.appendChild(input);
      card.appendChild(el("div", "dim", `Up to ${MAX_NICKNAME} letters. Leave it empty to go back to ${sp?.name ?? m.speciesId}.`));
      s.appendChild(card);

      const row = el("div", "row");
      row.appendChild(pill("Save", () => {
        const name = input.value.trim().slice(0, MAX_NICKNAME);
        if (name === "") delete m.nickname;
        else m.nickname = name;
        sfx.confirm();
        hooks.onChange();
        render();
      }));
      row.appendChild(pill("Cancel", () => render()));
      s.appendChild(row);
      input.focus();
    });
  };

  render();
}
