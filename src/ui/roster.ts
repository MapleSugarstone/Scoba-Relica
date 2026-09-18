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
import { displayName } from "../sim/battle";
import { face, openBrowser, openScobaCard } from "./browser";
import { typeIcon, typeIcons } from "./typeicon";
import { devMode } from "../version";
import {
  EVOLVE_COST,
  LEVEL_COST,
  evolve,
  evolveError,
  levelUp,
  levelUpError,
} from "../sim/growth";
import { maxHp, speciesName, type ScobaInstance } from "../sim/scoba";
import { MOVES, SPECIES, evolutionOf, moveTypes } from "../sim/species";
import type { SaveData, SlotId } from "../save/save";
import {
  PARTY_PER_CHARACTER,
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

/**
 * What a purchase may draw on. A dev has all of it: raising a Scoba to the
 * ceiling costs 2900 Aetus, which is a great many fights to sit through before
 * anything at the top of the curve can be looked at.
 *
 * One place answers this, so what a button offers and what it charges cannot
 * disagree about what is affordable.
 */
function onHand(save: SaveData): number {
  return devMode() ? Number.MAX_SAFE_INTEGER : save.aetus;
}

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

/** HP as the party card reads it: the word, the bar, and what is left of what. */
function hpRow(m: ScobaInstance): HTMLElement {
  const row = el("div", "ptHp");
  row.appendChild(el("span", "dim", "HP"));
  const cap = maxHp(m);
  const frac = cap > 0 ? m.hp / cap : 0;
  const bar = el("div", "hpBar");
  bar.classList.toggle("warn", frac < 0.55 && frac >= 0.25);
  bar.classList.toggle("danger", frac < 0.25);
  const fill = el("i");
  fill.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
  bar.appendChild(fill);
  row.appendChild(bar);
  row.appendChild(el("span", "ptHpNum", `${m.hp}/${cap}`));
  return row;
}

/** One of the side column's buttons: live when there is something for it to do. */
function sideButton(label: string, onClick: (() => void) | null): HTMLButtonElement {
  const b = el("button", "bxWide", label);
  b.type = "button";
  if (onClick) {
    const sound = label === "Back" ? sfx.back : sfx.tap;
    b.addEventListener("click", () => {
      sound();
      onClick();
    });
  } else {
    b.disabled = true;
  }
  return b;
}

/**
 * The party: its three slots as cards across the screen, each Scoba on a stage
 * with its level, elements and HP, and a column beside them for whose party it
 * is and what can be done with the one picked. Laid out as the Box and the
 * index are, so the three screens read as one set.
 */
export function openParty(ui: UI, art: Art, save: SaveData, hooks: RosterHooks): void {
  let owner: SlotId = save.localSlot;
  /** The uid of the card holding the bright outline, or none picked yet. */
  let selected: string | null = null;

  const render = (): void => {
    if (!hooks.solo()) owner = save.localSlot;
    const members = partyOf(save, owner);
    const chosen = members.find((m) => m.uid === selected) ?? null;

    ui.screen((s) => {
      s.classList.add("tight");
      s.appendChild(el("h2", undefined, "Party"));
      s.appendChild(el("div", "sub", devMode()
        ? `${save.aetus} Aetus · dev, so nothing is spent`
        : `${save.aetus} Aetus`));

      const wrap = el("div", "ptBrowser");
      const cards = el("div", "ptCards");
      for (let i = 0; i < PARTY_PER_CHARACTER; i++) {
        const m = members[i];
        cards.appendChild(m ? memberCard(m) : el("div", "ptCell empty", "Empty"));
      }
      wrap.appendChild(cards);
      wrap.appendChild(sidePanel(chosen));
      s.appendChild(wrap);
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
    const card = el("button", `ptCell${m.uid === selected ? " sel" : ""}`);
    card.type = "button";
    card.title = displayName(m);
    // The face on the same stage its card puts it on, at the size it stands
    // in a fight.
    const stage = el("div", "bxPortrait ptStage");
    stage.appendChild(face(art, m));
    card.appendChild(stage);
    card.appendChild(el("div", "ptName", displayName(m)));
    const line = el("div", "ptLine");
    line.appendChild(el("span", "dim", `Lv ${m.level}`));
    if (m.shiny) line.appendChild(el("span", "ptShiny", "Shiny"));
    line.appendChild(typeIcons(m));
    card.appendChild(line);
    card.appendChild(hpRow(m));
    // What it can do in a fight, a line a move: its elements, then its name.
    const moves = el("div", "ptMoves");
    for (const id of m.moves) {
      const move = MOVES[id];
      if (!move) continue;
      const row = el("div", "ptMove");
      const marks = el("span", "ptMoveMarks");
      for (const t of moveTypes(move)) marks.appendChild(typeIcon(t));
      row.append(marks, el("span", "ptMoveName", move.name));
      moves.appendChild(row);
    }
    card.appendChild(moves);

    card.addEventListener("click", () => {
      sfx.tap();
      selected = m.uid === selected ? null : m.uid;
      render();
    });
    return card;
  };

  /**
   * Whose party it is, what the picked one is, and what can be done with it,
   * in a column that holds its shape whether anything is picked or not: every
   * button is there either way and only goes dead, and the line saying why
   * keeps its room when it has nothing to say.
   */
  const sidePanel = (m: ScobaInstance | null): HTMLElement => {
    const side = el("div", "bxPanel ptSide");
    if (hooks.solo()) {
      const whose = el("div", "bxPair");
      for (const slot of ["A", "B"] as SlotId[]) {
        const b = el("button", `bxOwnerBtn${slot === owner ? " sel" : ""}`, save.characters[slot].name);
        b.type = "button";
        b.addEventListener("click", () => {
          if (slot === owner) return;
          sfx.tap();
          owner = slot;
          selected = null;
          render();
        });
        whose.appendChild(b);
      }
      side.appendChild(whose);
    }

    // Only its name: its card already says the rest, and is lit.
    const read = el("div", "ptRead");
    if (m) {
      read.appendChild(el("div", "ptReadName", displayName(m)));
    } else {
      read.appendChild(el("div", "dim", "Pick a Scoba to see what you can do."));
    }
    side.appendChild(read);

    const theirs = m ? !yours(m) : false;
    const levelWhy = m ? levelUpError(m, onHand(save)) : null;
    const evolveWhy = m ? evolveError(m, onHand(save)) : null;
    const ops = el("div", "ptOps");
    ops.appendChild(sideButton(`Level up · ${LEVEL_COST}`, m && !levelWhy && !theirs ? () => buyLevel(m) : null));
    ops.appendChild(sideButton(`Evolve · ${EVOLVE_COST}`, m && !evolveWhy && !theirs ? () => buyEvolve(m) : null));
    ops.appendChild(sideButton("Rename", m && !theirs ? () => renameScreen(m) : null));
    ops.appendChild(sideButton("Info", m ? () => openScobaCard(ui, art, m, render) : null));
    side.appendChild(ops);

    const notes: string[] = [];
    if (m && theirs) notes.push(`${save.characters[owner].name} raises this one.`);
    if (levelWhy) notes.push(levelWhy);
    if (evolveWhy) notes.push(evolveWhy);
    side.appendChild(el("div", "ptNote", notes.join(" ")));
    side.appendChild(sideButton("Back", hooks.onBack));
    return side;
  };

  const buyLevel = (m: ScobaInstance): void => {
    if (levelUpError(m, onHand(save))) return;
    if (!devMode()) save.aetus -= LEVEL_COST;
    levelUp(m);
    sfx.confirm();
    hooks.onChange();
    ui.toast(`${displayName(m)} is level ${m.level}.`);
    render();
  };

  const buyEvolve = (m: ScobaInstance): void => {
    if (evolveError(m, onHand(save))) return;
    const was = displayName(m);
    const into = evolutionOf(SPECIES[m.speciesId]!);
    if (!devMode()) save.aetus -= EVOLVE_COST;
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
      const stage = el("div", "bxPortrait");
      stage.appendChild(face(art, m));
      card.appendChild(stage);
      const input = el("input");
      input.type = "text";
      input.maxLength = MAX_NICKNAME;
      input.value = m.nickname ?? "";
      input.placeholder = speciesName(m);
      card.appendChild(input);
      card.appendChild(el("div", "dim", `Up to ${MAX_NICKNAME} letters. Leave it empty to go back to ${speciesName(m)}.`));
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
