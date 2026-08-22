import type { Art } from "../engine/assets";
import { sfx } from "../engine/sfx";
import {
  breed,
  canBreed,
  droppableFrom,
  inheritableFrom,
  pickTint,
  MAX_BREED_COUNT,
  type MoveSwap,
} from "../sim/breeding";
import { displayName } from "../sim/battle";
import { critterPortrait, spriteColors } from "../game/critters";
import { openBrowser } from "./browser";
import { costOf, maxHp, moveName, unnaturalMoves, type ScobaInstance } from "../sim/scoba";
import { ABILITIES, SPECIAL, SPECIES } from "../sim/species";
import { rngFrom } from "../sim/rng";
import type { SaveData } from "../save/save";
import { addToParty, writeSave } from "../save/save";
import type { UI } from "./screens";

export function openBreeding(ui: UI, art: Art, save: SaveData, onClose: () => void): void {
  const pool = (): ScobaInstance[] => [...save.party, ...save.box];

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const close = (): void => {
    ui.closeScreen();
    onClose();
  };

  /** Everything that could be a parent at all: no special Scobas, not bred out. */
  const eligible = (): ScobaInstance[] => pool().filter((m) => {
    const sp = SPECIES[m.speciesId];
    return !!sp && !sp.special && m.breedCount < MAX_BREED_COUNT;
  });

  /** One big button under the grid, live once a face is picked. */
  const selectFoot = (
    label: (s: ScobaInstance) => string,
    onPick: (s: ScobaInstance) => void,
  ) => (ctx: { selected: () => ScobaInstance | null }): HTMLElement => {
    const wrap = el("div", "bxPanel bxPick");
    const chosen = ctx.selected();
    const b = el("button", "bxWide", chosen ? label(chosen) : "Select");
    (b as HTMLButtonElement).disabled = !chosen;
    b.addEventListener("click", () => {
      if (!chosen) return;
      sfx.tap();
      onPick(chosen);
    });
    wrap.appendChild(b);
    return wrap;
  };

  const pickMom = (): void => {
    openBrowser(ui, art, {
      title: `${SPECIAL.name}'s Nest`,
      memory: "nest-mom",
      hint: "Pick a mother. The child takes her species.",
      empty: "Nothing here can breed yet. Catch a few more.",
      // A parent with nobody to pair with is no parent.
      source: () => eligible().filter((m) => pool().some((d) => d.uid !== m.uid && canBreed(m, d) === null)),
      onBack: close,
      foot: selectFoot((m) => `Mother: ${displayName(m)}`, (m) => pickDad(m)),
    });
  };

  const pickDad = (mom: ScobaInstance): void => {
    openBrowser(ui, art, {
      title: `Mother: ${displayName(mom)}`,
      memory: "nest-dad",
      hint: "Pick a father. His ability, and his colours, may carry over.",
      empty: "Nobody will pair with her.",
      source: () => pool().filter((d) => d.uid !== mom.uid && canBreed(mom, d) === null),
      onBack: pickMom,
      foot: selectFoot((d) => `Father: ${displayName(d)}`, (d) => pickDrop(mom, d)),
    });
  };

  /**
   * A child keeps its mother's set bar one slot. Which slot, and what lands on
   * it, is the player's call; a father with nothing new to teach skips both
   * steps.
   */
  const pickDrop = (mom: ScobaInstance, dad: ScobaInstance): void => {
    const offered = inheritableFrom(mom, dad);
    if (offered.length === 0) return hatch(mom, dad);
    // A mother already working a move can only pass on that slot, since a
    // Scoba holds one worked move at most.
    const droppable = droppableFrom(mom);
    const forced = unnaturalMoves(mom).length > 0;
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, "What does the child give up?"));
      s.appendChild(el("div", "sub", forced
        ? `${displayName(mom)} works ${moveName(droppable[0]!)}, and a Scoba works one move at most. That is the slot on offer.`
        : `${displayName(mom)}'s set, one slot of which goes to its father.`));
      const row = el("div", "bactions");
      for (const id of droppable) {
        const b = el("button", "act");
        b.appendChild(el("span", undefined, moveName(id)));
        b.appendChild(el("span", "sub", "give this up"));
        b.addEventListener("click", () => {
          sfx.tap();
          pickTake(mom, dad, id, offered);
        });
        row.appendChild(b);
      }
      s.appendChild(row);
      const back = el("button", "big", "Back");
      back.addEventListener("click", () => pickDad(mom));
      s.appendChild(back);
    });
  };

  const pickTake = (mom: ScobaInstance, dad: ScobaInstance, drop: string, offered: string[]): void => {
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, `What takes ${moveName(drop)}'s place?`));
      s.appendChild(el("div", "sub", `What ${displayName(dad)} knows and ${displayName(mom)} does not. A move her line does not learn is worked, and costs more for good.`));
      const row = el("div", "bactions");
      for (const id of offered) {
        const b = el("button", "act");
        b.appendChild(el("span", undefined, moveName(id)));
        // What it will cost the child, which is dearer than what it costs him.
        b.appendChild(el("span", "sub", `${costOf(mom.speciesId, id)}% mana`));
        b.addEventListener("click", () => {
          sfx.tap();
          hatch(mom, dad, { drop, take: id });
        });
        row.appendChild(b);
      }
      s.appendChild(row);
      const back = el("button", "big", "Back");
      back.addEventListener("click", () => pickDrop(mom, dad));
      s.appendChild(back);
    });
  };

  /**
   * The father's mark: a child that took his ability wears one of his colours
   * over one of its own. What the mark comes to is decided in
   * `sim/breeding.ts`; all that happens here is reading the two palettes off
   * the sprites, his as he is actually drawn and the child's off its species.
   */
  const applyTint = (dad: ScobaInstance, child: ScobaInstance): void => {
    const dadSp = SPECIES[dad.speciesId];
    const childSp = SPECIES[child.speciesId];
    if (!dadSp || !childSp) return;
    const tint = pickTint(spriteColors(art, dadSp, dad.tint), spriteColors(art, childSp));
    if (tint) child.tint = tint;
  };

  const hatch = (mom: ScobaInstance, dad: ScobaInstance, swap?: MoveSwap): void => {
    const { child, fromDad } = breed(
      mom, dad, rngFrom(`${save.worldSeed}:breed:${Date.now().toString(36)}`), swap,
    );
    if (fromDad) applyTint(dad, child);
    child.hp = maxHp(child);
    const toParty = addToParty(save, child, save.localSlot) === "party";
    writeSave(save);
    sfx.confirm();
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, `${displayName(child)} hatched!`));
      const card = el("div", "card");
      const face = critterPortrait(art, SPECIES[child.speciesId]!, child.tint, child.shiny);
      face.style.height = "72px";
      face.style.width = "auto";
      card.appendChild(face);
      card.appendChild(el("div", undefined, `${SPECIES[child.speciesId]!.name} · Lv 1 · bred ${child.breedCount}/${MAX_BREED_COUNT}`));
      card.appendChild(el("div", undefined, `Spells: ${child.moves.map(moveName).join(", ")}`));
      // Named and placed: a pool can hold the same ability as the other
      // parent's, so which one it came from is worth saying outright.
      const ability = ABILITIES[child.secondaryAbility];
      card.appendChild(el("div", undefined,
        `Ability: ${ability?.name ?? child.secondaryAbility} · ${fromDad ? "its father's" : "its mother's"}`));
      if (ability) card.appendChild(el("div", "dim", ability.desc));
      if (child.tint) card.appendChild(el("div", "dim", "It takes his colours, too."));
      card.appendChild(el("div", "sub", toParty ? "Joined the party." : "Sent to the box."));
      s.appendChild(card);
      const done = el("button", "big primary", "Done");
      done.addEventListener("click", close);
      s.appendChild(done);
    });
  };

  pickMom();
}
