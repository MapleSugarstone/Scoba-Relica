// The two screens that manage Scobas out of a fight: the Box, which is where
// everything caught is kept and where the fielded three are put in order, and
// the Party, which is where Aetus is spent and where a Scoba is named.
//
// The grid is always your own box. With nobody else playing the other
// character you can still field them, by lending from that box; their box is
// never opened here, at either end of the loan. Both screens offer the switch
// only while you are alone, and drop it the moment a second player is in.
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
  lend,
  otherSlot,
  partyHasRoom,
  partyOf,
  reorderParty,
  sendToBox,
  takeBack,
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
  /** True while nobody else is playing the other character. */
  solo: () => boolean;
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
function ownerRow(save: SaveData, owner: SlotId, onPick: (o: SlotId) => void): HTMLElement {
  const row = el("div", "row");
  for (const slot of ["A", "B"] as SlotId[]) {
    row.appendChild(pill(save.characters[slot].name, slot === owner ? null : () => onPick(slot),
      slot === owner ? "sel" : ""));
  }
  return row;
}

/**
 * The Box: everything you have caught, with a party laid along the bottom. The
 * grid holds the boxed ones and the strip holds the party, and a Scoba is moved
 * between them by picking it and pressing Add or Drop. The arrows between the
 * party faces put them in order, which is the order they are fielded and walked
 * in.
 *
 * Playing alone, the strip can be swung round to the other character, and then
 * the same two buttons lend out of your box and take back what you lent. What
 * is theirs stays theirs: it cannot be dropped, because the only box on this
 * screen is yours.
 */
export function openBox(ui: UI, art: Art, save: SaveData, hooks: RosterHooks): void {
  /** Which of the fielded three the strip has highlighted, for Drop. */
  let held: string | null = null;
  /** Whose party the strip is showing, which is only ever swung round alone. */
  let stripOwner: SlotId = save.localSlot;
  openBrowser(ui, art, {
    title: "Box",
    memory: "box",
    hint: "Pick a face to see what it is.",
    empty: "The box is empty. Everything caught goes here.",
    source: () => boxOf(save, save.localSlot),
    onBack: hooks.onBack,
    foot: (ctx) => {
      // A partner arriving with the screen open takes their character back.
      if (!hooks.solo()) stripOwner = save.localSlot;
      const mine = stripOwner === save.localSlot;
      const party = partyOf(save, stripOwner);
      const strip = el("div", "bxPanel bxParty");

      const changed = (): void => {
        sfx.confirm();
        hooks.onChange();
        ctx.refresh();
      };

      if (hooks.solo()) {
        const swap = el("div", "bxOwner");
        for (const slot of [save.localSlot, otherSlot(save.localSlot)]) {
          const b = el("button", `bxOwnerBtn${slot === stripOwner ? " sel" : ""}`, save.characters[slot].name);
          b.addEventListener("click", () => {
            if (slot === stripOwner) return;
            sfx.tap();
            stripOwner = slot;
            held = null;
            ctx.show(null);
            ctx.refresh();
          });
          swap.appendChild(b);
        }
        strip.appendChild(swap);
      }

      const row = el("div", "bxPartyRow");
      party.forEach((m, i) => {
        const cell = el("button", `bxCell${m.uid === held ? " sel" : ""}`);
        cell.title = m.lentBy
          ? `${displayName(m)} · Lv ${m.level} · lent`
          : `${displayName(m)} · Lv ${m.level}`;
        cell.appendChild(face(art, m));
        if (m.lentBy) cell.appendChild(el("span", "bxLent", "lent"));
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
            if (reorderParty(save, stripOwner, m.uid, 1)) changed();
          });
          row.appendChild(swap);
        }
      });
      if (party.length === 0) row.appendChild(el("div", "dim", "Nobody fielded."));
      strip.appendChild(row);

      // Add works on the grid's pick, Drop on the strip's. Swung round to the
      // other character the same two buttons lend and take back.
      const gridPick = ctx.gridPick();
      const partyPick = party.find((m) => m.uid === held) ?? null;
      const ops = el("div", "bxOps");
      const add = el("button", "bxWide", mine ? "Add" : "Lend");
      add.disabled = !gridPick || !partyHasRoom(save, stripOwner);
      add.addEventListener("click", () => {
        // A partner who logged in with this screen open has taken their
        // character back, whatever the strip was left showing.
        if (!mine && !hooks.solo()) return ctx.refresh();
        if (!gridPick) return;
        if (!(mine ? takeFromBox(save, gridPick.uid) : lend(save, gridPick.uid))) return;
        held = gridPick.uid;
        ctx.show(gridPick);
        changed();
      });
      const drop = el("button", "bxWide", mine ? "Drop" : "Take back");
      drop.disabled = mine
        ? !partyPick || party.length <= 1
        : !partyPick?.lentBy;
      drop.addEventListener("click", () => {
        if (!mine && !hooks.solo()) return ctx.refresh();
        if (!partyPick) return;
        if (!(mine ? sendToBox(save, partyPick.uid) : takeBack(save, partyPick.uid))) return;
        held = null;
        ctx.show(null);
        changed();
      });
      ops.appendChild(add);
      ops.appendChild(drop);
      strip.appendChild(ops);
      if (!mine) {
        strip.appendChild(el("div", "dim bxLendNote", partyPick && !partyPick.lentBy
          ? `${displayName(partyPick)} is ${save.characters[stripOwner].name}'s own.`
          : `Lend from your box. Everything you lend comes home when ${save.characters[stripOwner].name} logs in.`));
      }
      return strip;
    },
  });
}

export function openParty(ui: UI, art: Art, save: SaveData, hooks: RosterHooks): void {
  let owner: SlotId = save.localSlot;

  const render = (): void => {
    if (!hooks.solo()) owner = save.localSlot;
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, "Party"));
      s.appendChild(el("div", "sub", `${save.aetus} Aetus`));
      if (hooks.solo()) {
        s.appendChild(ownerRow(save, owner, (o) => {
          owner = o;
          render();
        }));
      }

      for (const m of partyOf(save, owner)) {
        s.appendChild(memberCard(m));
      }
      s.appendChild(bigBtn("Back", hooks.onBack, true));
    });
  };

  /**
   * Whether raising this one is yours to pay for. A loan is, and so is every
   * Scoba in a save nobody has ever joined. A real partner's is not: they hold
   * the copy that counts, and Aetus spent here would go with their next login.
   */
  const yours = (m: ScobaInstance): boolean =>
    m.owner === save.localSlot || m.lentBy !== undefined || !save.partnerJoined;

  const memberCard = (m: ScobaInstance): HTMLElement => {
    const card = el("div", "card");
    const head = el("div", "who");
    head.appendChild(portrait(art, m, 48));
    head.appendChild(nameBlock(m));
    card.appendChild(head);
    card.appendChild(el("div", "dim", `HP ${m.hp}/${maxHp(m)}`));

    const theirs = !yours(m);
    const levelWhy = levelUpError(m, save.aetus);
    const evolveWhy = evolveError(m, save.aetus);
    const row = el("div", "row");
    row.appendChild(pill(`Level up · ${LEVEL_COST}`, levelWhy || theirs ? null : () => buyLevel(m)));
    row.appendChild(pill(`Evolve · ${EVOLVE_COST}`, evolveWhy || theirs ? null : () => buyEvolve(m)));
    row.appendChild(pill("Rename", theirs ? null : () => renameScreen(m)));
    card.appendChild(row);

    const notes: string[] = [];
    if (theirs) notes.push(`${save.characters[owner].name} raises this one.`);
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
