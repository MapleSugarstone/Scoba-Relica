// The pot: three cups, whatever leaves you are holding, and one Scoba to serve.
//
// Leaves are spent when the tea is served rather than when they go in a cup,
// so a cup left half full costs nothing and the player can pour it back.
import type { Art } from "../engine/assets";
import { ART, UI_PER_UNIT } from "../engine/renderer";
import { sfx } from "../engine/sfx";
import { displayName } from "../sim/battle";
import { TEAS_MAX, TEA_AT_CEILING, statsAt, teaWorth, type ScobaInstance } from "../sim/scoba";
import {
  CUP_POINTS, cupFor, cupFull, cupPoints, emptyCups, everyLeaf, leafId, leafName, leavesOnHand, servedTeas,
  type Cup, type Leaf,
} from "../sim/tea";
import { STAT_LABELS, type StatName } from "../sim/types";
import { devMode } from "../version";
import type { SaveData } from "../save/save";
import { writeSave } from "../save/save";
import type { UI } from "./screens";

/**
 * The cup a stat is drunk from. One drawing per stat where there is one, and
 * the plain cup until then, so a new `Teacup-Str.png` in `assets/Tea` turns up
 * on its own, under the name of the stat it is for.
 */
function cupArt(art: Art, stat: StatName): HTMLCanvasElement | HTMLImageElement | null {
  return art.teas[`teacup-${stat}`] ?? art.teas["teacup"] ?? null;
}

/** Art px per interface px, the step a Scoba's own drawing is shown at. */
const FIELD = ART / UI_PER_UNIT;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** The cup as a canvas, cropped to the drawing. */
function cupCanvas(art: Art, stat: StatName): HTMLCanvasElement | null {
  const drawn = cupArt(art, stat);
  if (!drawn) return null;
  const copy = document.createElement("canvas");
  copy.width = drawn.width;
  copy.height = drawn.height;
  copy.getContext("2d")?.drawImage(drawn, 0, 0);
  return copy;
}

/**
 * One cup on a card, at the size a Scoba's own drawing is shown at, so its
 * outline is the same weight as the Scoba beside it. What it is for is on
 * hovering rather than written under it: three cups with three words under
 * them took more of the card than what they say is worth.
 */
export function teaMark(art: Art, stat: StatName): HTMLElement {
  const wrap = el("span", "teaCup");
  wrap.title = `${STAT_LABELS[stat]} tea`;
  const copy = cupCanvas(art, stat);
  if (copy) {
    copy.style.width = `${copy.width / FIELD}px`;
    copy.style.height = `${copy.height / FIELD}px`;
    wrap.appendChild(copy);
  }
  return wrap;
}

/** A cup with the stat under it, for the pot, where the stat is the choice. */
export function teaCup(art: Art, stat: StatName, height = 24): HTMLElement {
  const wrap = el("div", "teaCup teaNamed");
  const copy = cupCanvas(art, stat);
  if (copy) {
    // Its own proportions decide the width at whatever height it is asked for.
    copy.style.height = `${height}px`;
    copy.style.width = `${Math.round((copy.width / copy.height) * height)}px`;
    wrap.appendChild(copy);
  }
  wrap.appendChild(el("span", "sub", STAT_LABELS[stat]));
  return wrap;
}

/** The row of cups a Scoba is holding, or nothing at all where it holds none. */
export function teaRow(art: Art, s: ScobaInstance): HTMLElement | null {
  const teas = s.teas ?? [];
  if (teas.length === 0) return null;
  const row = el("div", "teaRow");
  for (const stat of teas) row.appendChild(teaMark(art, stat));
  return row;
}

export function openTeaPot(ui: UI, art: Art, save: SaveData, s: ScobaInstance, onClose: () => void): void {
  const cups: Cup[] = emptyCups();

  /** What is in the cups right now, counted by leaf, so the bag can show the rest. */
  const inCups = (leaf: Leaf): number =>
    cups.reduce((n, cup) => n + cup.leaves.filter((l) => l.stat === leaf.stat && l.rank === leaf.rank).length, 0);

  const render = (): void => {
    ui.screen((scr) => {
      scr.classList.add("tight");
      scr.appendChild(el("h2", undefined, `Brew for ${displayName(s)}`));
      // Everything that does not depend on the cups is said once, up here, so
      // the line under the pot is the only thing that changes as leaves go in.
      scr.appendChild(el("div", "sub",
        `Three points of one stat fill a cup, worth ${teaWorth(s.level)} at this level and ${TEA_AT_CEILING} at Lv 30. `
        + `Serving pours out whatever ${displayName(s)} is holding now.`));

      const top = el("div", "teaTop");

      // The pot: one column per cup.
      const pot = el("div", "teaPot");
      for (const [i, cup] of cups.entries()) {
        const slot = el("div", `teaSlot${cupFull(cup) ? " full" : ""}`);
        if (cup.stat) {
          slot.appendChild(teaCup(art, cup.stat, 34));
          slot.appendChild(el("div", "sub", `${cupPoints(cup)} / ${CUP_POINTS}`));
          const back = el("button", "pill", "Pour back");
          back.addEventListener("click", () => {
            sfx.back();
            cups[i] = { stat: null, leaves: [] };
            render();
          });
          slot.appendChild(back);
        } else {
          slot.appendChild(el("div", "teaEmpty", "Empty"));
        }
        pot.appendChild(slot);
      }

      // What is in the bag, minus whatever is already steeping. A dev has one
      // of everything on hand: brewing what a cup does costs a run of fights
      // to gather otherwise.
      const shelf = el("div", "teaShelf");
      const held = (devMode()
        ? everyLeaf().map((leaf) => ({ leaf, count: Number.MAX_SAFE_INTEGER }))
        : leavesOnHand(save.bag))
        .map((entry) => ({ leaf: entry.leaf, count: entry.count - inCups(entry.leaf) }))
        .filter((entry) => entry.count > 0);
      if (held.length === 0) {
        shelf.appendChild(el("div", "dim", "No Teeleevs. They turn up after a fight."));
      }
      if (devMode()) shelf.appendChild(el("div", "dim", "Dev: every Teeleev, and none of them spent."));
      for (const { leaf, count } of held) {
        const b = el("button", "dbgHit");
        b.append(el("span", undefined, leafName(leaf)), el("span", "sub", devMode() ? "plenty" : `x${count}`));
        const where = cupFor(cups, leaf);
        b.disabled = where < 0;
        b.addEventListener("click", () => {
          sfx.tap();
          const cup = cups[where];
          if (!cup) return;
          cup.stat = leaf.stat;
          cup.leaves.push(leaf);
          render();
        });
        shelf.appendChild(b);
      }

      top.append(pot, shelf);
      scr.appendChild(top);

      // What the Scoba holds now, and what it would hold after.
      const ready = servedTeas(cups);
      const now = el("div", "teaNow");
      now.appendChild(el("span", "sub", "Holding now:"));
      const holding = s.teas ?? [];
      if (holding.length === 0) now.appendChild(el("span", "dim", "nothing"));
      for (const stat of holding) now.appendChild(teaCup(art, stat, 20));
      scr.appendChild(now);
      // Always one line, so the buttons under it sit where they sat before a
      // leaf went in the pot.
      const after = statsAt({ ...s, teas: ready });
      const said = ready.length > 0
        ? `Serving ${ready.length} of ${TEAS_MAX}: ${ready.map((stat) => `${STAT_LABELS[stat]} ${after[stat]}`).join(", ")}.`
        : "Fill a cup to see what it makes.";
      scr.appendChild(el("div", "sub teaServing", said));

      const serve = el("button", "big primary", ready.length > 0 ? `Serve ${ready.length}` : "Serve");
      serve.disabled = ready.length === 0;
      serve.addEventListener("click", () => {
        if (ready.length === 0) return;
        // Only the leaves in the cups that were served are spent, and a dev
        // spends nothing at all.
        for (const cup of devMode() ? [] : cups) {
          if (!cupFull(cup)) continue;
          for (const leaf of cup.leaves) {
            const key = leafId(leaf.stat, leaf.rank);
            save.bag[key] = Math.max(0, (save.bag[key] ?? 0) - 1);
            if (save.bag[key] === 0) delete save.bag[key];
          }
        }
        s.teas = ready;
        writeSave(save);
        sfx.confirm();
        ui.toast(`${displayName(s)} drinks ${ready.map((stat) => STAT_LABELS[stat]).join(", ")}.`);
        close();
      });
      scr.appendChild(serve);

      const back = el("button", "big", "Back");
      back.addEventListener("click", () => {
        sfx.back();
        close();
      });
      const exit = el("div", "backRow");
      exit.appendChild(back);
      scr.appendChild(exit);
    });
  };

  const close = (): void => {
    ui.closeScreen();
    onClose();
  };

  render();
}
