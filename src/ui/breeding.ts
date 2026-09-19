import type { Art } from "../engine/assets";
import { sfx } from "../engine/sfx";
import {
  breed,
  canBreed,
  droppableFrom,
  inheritableFrom,
  makesHybrid,
  pickTints,
  type MoveSwap,
} from "../sim/breeding";
import { displayName } from "../sim/battle";
import { critterPortrait, lookOf, spriteColors } from "../game/critters";
import { openBrowser } from "./browser";
import { costOf, maxHp, moveName, scobaTypes, speciesName, statsAt, unnaturalMoves, type ScobaInstance } from "../sim/scoba";
import { proseBox } from "./prose";
import { ABILITIES, SPECIAL, SPECIES } from "../sim/species";
import { abilityText } from "../game/texts";
import { rngFrom } from "../sim/rng";
import type { SaveData } from "../save/save";
import { addToParty, writeSave } from "../save/save";
import type { UI } from "./screens";

export function openBreeding(ui: UI, art: Art, save: SaveData, onClose: () => void): void {
  const pool = (): ScobaInstance[] => [...save.party, ...save.box];

  /**
   * Debug: hatch it shiny rather than rolling for it. Off by default: a shiny
   * is meant to be a surprise, and a nest that handed one out every time would
   * stop being able to show you an ordinary child.
   */
  let forceShiny = false;

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

  /** Everything that could be a parent at all: no special Scobas, no Pawns, no hybrids. */
  const eligible = (): ScobaInstance[] => pool().filter((m) => {
    const sp = SPECIES[m.speciesId];
    return !!sp && !sp.special && !sp.pawn && !sp.fusion && !m.hybrid;
  });

  /**
   * The debug switch, as a button that says what it is currently doing. It
   * repaints itself rather than rebuilding the screen around it: rebuilding
   * dropped the father that was picked, and the screen it came back as took
   * him for the mother.
   */
  const debugToggle = (
    on: () => boolean,
    flip: () => void,
    says: (on: boolean) => string,
  ): HTMLElement => {
    const b = el("button", "bxDebug");
    const paint = (): void => {
      b.className = `bxDebug${on() ? " on" : ""}`;
      b.textContent = says(on());
    };
    b.addEventListener("click", () => {
      flip();
      sfx.tap();
      paint();
    });
    paint();
    return b;
  };

  /** The debug switches, as buttons that say what they are currently doing. */
  const debugSwitches = (): HTMLElement => {
    const wrap = el("div", "bxDebugRow");
    wrap.appendChild(debugToggle(
      () => forceShiny,
      () => { forceShiny = !forceShiny; },
      (on) => on
        ? "Debug: always hatching shiny. Tap for the real 1 in 300 roll."
        : "Debug: rolling shiny at the real 1 in 300. Tap to always hatch shiny.",
    ));
    return wrap;
  };

  /** One big button under the grid, live once a face is picked. */
  const selectFoot = (
    label: (s: ScobaInstance) => string,
    onPick: (s: ScobaInstance) => void,
    debug = false,
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
    // Offered on the father's screen, since picking him is the last step before a same-line baby hatches.
    if (debug) wrap.appendChild(debugSwitches());
    return wrap;
  };

  const pickMom = (): void => {
    openBrowser(ui, art, {
      title: `${SPECIAL.name}'s Nest`,
      memory: "nest-mom",
      hint: "Pick a mother. The child hatches as the first form of her line.",
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
      hint: "Pick a father. From her own line, the child is a plain baby of that line. From another line, it is a hybrid that takes one of his moves, his passive, his element and his colors, and it cannot breed.",
      empty: "Nobody will pair with her.",
      source: () => pool().filter((d) => d.uid !== mom.uid && canBreed(mom, d) === null),
      onBack: pickMom,
      foot: selectFoot(
        (d) => `Father: ${displayName(d)}${makesHybrid(mom, d) ? " · hybrid" : ""}`,
        (d) => (makesHybrid(mom, d) ? pickDrop(mom, d) : hatch(mom, d)),
        true,
      ),
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
      back.addEventListener("click", () => {
        sfx.back();
        pickDad(mom);
      });
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
      back.addEventListener("click", () => {
        sfx.back();
        pickDrop(mom, dad);
      });
      s.appendChild(back);
    });
  };

  const hatch = (mom: ScobaInstance, dad: ScobaInstance, swap?: MoveSwap): void => {
    const child = breed(
      mom, dad, rngFrom(`${save.worldSeed}:breed:${Date.now().toString(36)}`), swap, { forceShiny },
    );
    child.hp = maxHp(child);
    const toParty = addToParty(save, child, save.localSlot) === "party";
    writeSave(save);
    sfx.confirm();
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, `${displayName(child)} hatched!`));
      const card = el("div", "card");
      const face = critterPortrait(art, SPECIES[child.speciesId]!, child.sire, child.shiny,
        lookOf(SPECIES[child.speciesId]!, child));
      face.style.height = "72px";
      face.style.width = "auto";
      card.appendChild(face);
      card.appendChild(el("div", undefined, `${speciesName(child)} · Lv 1${child.hybrid ? " · Hybrid" : ""}`));
      card.appendChild(el("div", undefined, `Spells: ${child.moves.map(moveName).join(", ")}`));
      const ability = ABILITIES[child.secondaryAbility];
      card.appendChild(el("div", undefined,
        `Ability: ${ability?.name ?? child.secondaryAbility}${child.hybrid ? " · its father's" : ""}`));
      if (forceShiny) card.appendChild(el("div", "dim", "Debug: it was hatched shiny rather than rolled for."));
      if (ability) card.appendChild(proseBox(abilityText(ability.id), {
        stats: statsAt(child), level: child.level, types: scobaTypes(child),
      }, "dim"));
      if (child.hybrid) card.appendChild(el("div", "dim", "It takes his colors and his element too. A hybrid cannot breed."));
      card.appendChild(el("div", "sub", toParty ? "Joined the party." : "Sent to the box."));
      s.appendChild(card);
      const done = el("button", "big primary", "Done");
      done.addEventListener("click", close);
      s.appendChild(done);
    });
  };

  pickMom();
}
