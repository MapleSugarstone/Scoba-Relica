// The Scoba browser: a search panel, a grid of faces, and a strip along the
// bottom. The Box uses it to arrange a character's roster and the nest uses it
// to pick a parent, so the frame is built once here and each caller fills in
// what sits under the grid.
//
// Nothing re-renders wholesale. Typing in the name field, sliding a stat and
// picking a face all touch only the part they change, because rebuilding the
// screen would take the caret out of the field the player is typing in.
import type { Art } from "../engine/assets";
import { ART, UI_PER_UNIT } from "../engine/renderer";
import { sfx } from "../engine/sfx";
import { critterPortrait, lookOf } from "../game/critters";
import { displayName } from "../sim/battle";
import { moveCost, scobaTypes, speciesName, statsAt, type ScobaInstance } from "../sim/scoba";
import { hobbyDoing } from "../sim/status";
import { MOVES, SPECIES, type Species } from "../sim/species";
import { scobaText } from "../game/texts";
import { STAT_LABELS, TYPES, TYPE_COLORS, TYPE_LABELS, type ElementType, type StatName } from "../sim/types";
import type { UI } from "./screens";
import { typeIcon, typeIcons } from "./typeicon";
import { moveSlot, openCard, passiveSlot } from "./infocard";

/**
 * Where each browser was left scrolled, kept between opens so coming back to
 * the Box or a parent list puts the same faces under the eye that left them.
 * Detaching a screen resets its scroll, so the position is carried here rather
 * than read back off the element.
 */
const scrolledTo = new Map<string, number>();

/** The stat rows down the search panel, in the order the mock-up has them. */
const FILTER_STATS: StatName[] = ["hp", "str", "def", "res", "spd", "mag"];
/** Short labels, since the panel is narrow. */
const SHORT: Record<StatName, string> = {
  hp: "HP", str: "STR", def: "DEF", res: "RES", spd: "SPD", mag: "MGK",
};
/** A filter still has somewhere to travel when the box holds one flat Scoba. */
const MIN_STAT_RANGE = 5;
/** How wide a stat slider's handle is, in interface px, which is where its fill has to stop. */
const HANDLE = 8;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const button = (cls: string, label: string, onClick: () => void): HTMLButtonElement => {
  const b = el("button", cls, label);
  const sound = label === "Back" ? sfx.back : sfx.tap;
  b.addEventListener("click", () => {
    sound();
    onClick();
  });
  return b;
};

/**
 * Art pixels per interface pixel at the size a Scoba stands in a fight. The
 * art's three pixel outline comes out as wide as a panel's frame at this size
 * and no other, so it is the one size a face is shown at.
 */
const FIELD = ART / UI_PER_UNIT;

/**
 * A cropped face, wearing whatever mask it inherited, at the size it stands in
 * a fight. Shown at the size it was drawn, its outline came out twice the
 * weight of every frame on the screen and the tallest face overflowed its cell.
 */
export function face(art: Art, s: ScobaInstance): HTMLElement {
  const sp = SPECIES[s.speciesId];
  if (!sp) return el("div", "bxFace");
  return atField(critterPortrait(art, sp, s.sire, s.shiny, lookOf(sp, s)));
}

/** A line's own face, as it is drawn with nothing inherited, at the same size. */
export function speciesFace(art: Art, sp: Species): HTMLElement {
  return atField(critterPortrait(art, sp));
}

function atField(cv: HTMLCanvasElement): HTMLElement {
  const wrap = el("div", "bxFace");
  cv.style.width = `${cv.width / FIELD}px`;
  cv.style.height = `${cv.height / FIELD}px`;
  wrap.appendChild(cv);
  return wrap;
}

/** What the caller puts under the grid, and what it needs to build it. */
export interface FootContext {
  /** Whatever the readout is showing: the grid's pick, or the strip's. */
  selected: () => ScobaInstance | null;
  /** The grid's pick alone, which is the only thing the grid can act on. */
  gridPick: () => ScobaInstance | null;
  /** Put one of the strip's own Scobas in the readout instead. */
  show: (s: ScobaInstance | null) => void;
  /** Re-read everything: the grid, the strip and the readout. */
  refresh: () => void;
}

export interface BrowserConfig {
  title: string;
  /** Everything the grid can show, before any filter. */
  source: () => ScobaInstance[];
  /** The strip under the grid: the party for the Box, one button for the nest. */
  foot: (ctx: FootContext) => HTMLElement;
  onBack: () => void;
  /** What to file this browser's scroll position under. */
  memory: string;
  /** Shown in the readout when nothing is picked. */
  hint?: string;
  /** Shown in the grid when there is nothing to show at all. */
  empty?: string;
}

export function openBrowser(ui: UI, art: Art, cfg: BrowserConfig): void {
  let picked: string | null = null;
  // What the form is set to, which is not what is being searched until Search.
  const draft = { name: "", types: new Set<ElementType>(), stats: emptyStats() };
  let applied = snapshot();

  function emptyStats(): Record<StatName, number> {
    return { hp: 0, str: 0, def: 0, res: 0, mag: 0, spd: 0 };
  }
  function snapshot(): { name: string; types: Set<ElementType>; stats: Record<StatName, number> } {
    return { name: draft.name, types: new Set(draft.types), stats: { ...draft.stats } };
  }

  /**
   * How far each slider reaches: the best that character actually has, so the
   * far end of the bar is a Scoba in the box rather than a number nothing
   * scores. Rebuilt whenever the box it is filtering changes.
   */
  const ceilings = (): Record<StatName, number> => {
    const out = { hp: 0, str: 0, def: 0, res: 0, mag: 0, spd: 0 };
    for (const s of cfg.source()) {
      const stats = statsAt(s);
      for (const name of FILTER_STATS) out[name] = Math.max(out[name], stats[name]);
    }
    for (const name of FILTER_STATS) out[name] = Math.max(MIN_STAT_RANGE, out[name]);
    return out;
  };

  const shown = (): ScobaInstance[] => cfg.source().filter((s) => {
    const q = applied.name.trim().toLowerCase();
    if (q !== "" && !displayName(s).toLowerCase().includes(q)
      && !speciesName(s).toLowerCase().includes(q)) return false;
    if (applied.types.size > 0 && !scobaTypes(s).some((t) => applied.types.has(t))) return false;
    const stats = statsAt(s);
    return FILTER_STATS.every((name) => stats[name] >= applied.stats[name]);
  });

  const gridPick = (): ScobaInstance | null =>
    cfg.source().find((s) => s.uid === picked) ?? null;

  // The strip can borrow the readout for something the grid does not hold, so
  // a fielded Scoba can be read without being put back in the box first.
  let spotlight: ScobaInstance | null = null;
  const selected = (): ScobaInstance | null => spotlight ?? gridPick();

  // --- the pieces that get updated in place ---
  const grid = el("div", "bxGrid");
  const memoryKey = (): string => cfg.memory;
  const readout = el("div", "bxRead");
  const footWrap = el("div", "bxFoot");

  const ctx: FootContext = {
    selected,
    gridPick,
    show: (s) => {
      spotlight = s;
      fillReadout();
      fillFoot();
    },
    refresh: () => {
      fillGrid();
      fillFoot();
      fillReadout();
    },
  };

  const fillFoot = (): void => {
    footWrap.innerHTML = "";
    footWrap.appendChild(cfg.foot(ctx));
  };

  // Words and badges only, in a box that holds its height: the picked face is
  // already lit in the grid or the strip, and a second copy of it here made the
  // panel twice as tall and pushed the whole browser off the bottom of the frame.
  const fillReadout = (): void => {
    readout.innerHTML = "";
    const s = selected();
    if (!s) {
      readout.appendChild(el("div", "dim", cfg.hint ?? "Pick one."));
      return;
    }
    const top = el("div", "bxReadTop");
    top.appendChild(el("span", "bxReadName", displayName(s)));
    top.appendChild(el("span", "dim", `Lv ${s.level}`));
    readout.appendChild(top);
    if (SPECIES[s.speciesId]) readout.appendChild(typeIcons(s));
  };

  const pick = (s: ScobaInstance): void => {
    sfx.tap();
    spotlight = null;
    picked = s.uid;
    for (const cell of grid.querySelectorAll(".bxCell")) {
      cell.classList.toggle("sel", (cell as HTMLElement).dataset["uid"] === picked);
    }
    fillReadout();
    fillFoot();
  };

  const fillGrid = (): void => {
    grid.innerHTML = "";
    const list = shown();
    if (list.length === 0) {
      // An empty box and a search that found nothing read the same otherwise.
      grid.appendChild(el("div", "bxEmpty", cfg.source().length === 0
        ? (cfg.empty ?? "Nothing in here yet.")
        : "Nothing matches that search."));
      restoreScroll();
      return;
    }
    for (const s of list) {
      const cell = el("button", `bxCell${s.uid === picked ? " sel" : ""}`);
      cell.dataset["uid"] = s.uid;
      cell.title = `${displayName(s)} · Lv ${s.level}`;
      cell.appendChild(face(art, s));
      cell.addEventListener("click", () => pick(s));
      grid.appendChild(cell);
    }
    restoreScroll();
  };

  /**
   * A screen that has just been built starts at the top, so this puts the grid
   * back where this browser was left. After a refill the grid has not been laid
   * out yet, and on the first build it is not even in the document, so it waits
   * a tick: a timer rather than a frame, because a hidden tab stops handing out
   * frames. The grid scrolls under a wheel or a finger with no bar of its own.
   */
  const restoreScroll = (): void => {
    window.setTimeout(() => {
      grid.scrollTop = Math.min(scrolledTo.get(memoryKey()) ?? 0, grid.scrollHeight - grid.clientHeight);
    }, 0);
  };
  grid.addEventListener("scroll", () => {
    scrolledTo.set(memoryKey(), grid.scrollTop);
  });

  const reset = (): void => {
    draft.name = "";
    draft.types.clear();
    draft.stats = emptyStats();
    applied = snapshot();
    build();
  };

  // --- the frame, built once per open ---
  function build(): void {
    ui.screen((screen) => {
      // Tighter spacing than most screens: three panels deep has to fit the frame.
      screen.classList.add("tight");
      screen.appendChild(el("h2", undefined, cfg.title));
      const wrap = el("div", "browser");

      // Search panel.
      const search = el("div", "bxPanel bxSearch");
      const nameField = el("input", "bxName");
      nameField.type = "text";
      nameField.placeholder = "Name";
      nameField.value = draft.name;
      nameField.addEventListener("input", () => { draft.name = nameField.value; });
      nameField.addEventListener("keydown", (e) => {
        if (e.key === "Enter") apply();
      });
      search.appendChild(nameField);

      const chips = el("div", "bxTypes");
      for (const t of TYPES) {
        const chip = el("button", `bxChip${draft.types.has(t) ? " sel" : ""}`);
        chip.title = TYPE_LABELS[t];
        chip.appendChild(typeIcon(t));
        chip.addEventListener("click", () => {
          sfx.tap();
          if (draft.types.has(t)) draft.types.delete(t);
          else draft.types.add(t);
          chip.classList.toggle("sel", draft.types.has(t));
        });
        chips.appendChild(chip);
      }
      search.appendChild(chips);

      const top = ceilings();
      for (const name of FILTER_STATS) {
        const row = el("label", "bxStat");
        row.appendChild(el("span", "bxStatName", SHORT[name]));
        const slider = el("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = String(top[name]);
        // A box that shrank can leave a filter past the end of its own bar.
        draft.stats[name] = Math.min(draft.stats[name], top[name]);
        slider.value = String(draft.stats[name]);
        slider.title = `${STAT_LABELS[name]} at least`;
        const num = el("span", "bxStatNum", draft.stats[name] === 0 ? "any" : String(draft.stats[name]));
        // The bar fills up to the middle of the handle, so a filter that is set
        // reads as a bar with something in it and one that is not reads empty.
        const fill = (): void => {
          const share = top[name] > 0 ? draft.stats[name] / top[name] : 0;
          slider.style.setProperty("--at", draft.stats[name] === 0
            ? "0px"
            : `calc(${HANDLE / 2}px + ${share} * (100% - ${HANDLE}px))`);
        };
        fill();
        slider.addEventListener("input", () => {
          draft.stats[name] = Number(slider.value);
          num.textContent = draft.stats[name] === 0 ? "any" : slider.value;
          fill();
        });
        row.appendChild(slider);
        row.appendChild(num);
        search.appendChild(row);
      }
      // Side by side: the panel has to fit beside the grid in one screen.
      const ops = el("div", "bxPair");
      ops.appendChild(button("bxWide", "Search", apply));
      ops.appendChild(button("bxWide bxClear", "Clear", reset));
      search.appendChild(ops);
      wrap.appendChild(search);

      // The grid itself.
      const gridPanel = el("div", "bxPanel bxGridPanel");
      gridPanel.appendChild(grid);
      wrap.appendChild(gridPanel);

      // Readout, the button that opens the whole card, and the way back beside
      // it, which is the one place under the panels with room for it.
      const info = el("div", "bxPanel bxInfo");
      info.appendChild(readout);
      const infoOps = el("div", "bxPair");
      info.appendChild(infoOps);
      infoOps.appendChild(button("bxWide", "Info", () => {
        const s = selected();
        if (s) infoScreen(s);
      }));
      infoOps.appendChild(button("bxWide", "Back", cfg.onBack));
      wrap.appendChild(info);

      wrap.appendChild(footWrap);
      screen.appendChild(wrap);

      fillGrid();
      fillReadout();
      fillFoot();
    });
  }

  function apply(): void {
    sfx.tap();
    applied = snapshot();
    fillGrid();
  }

  function infoScreen(s: ScobaInstance): void {
    openScobaCard(ui, art, s, build);
  }

  build();
}

/** The card for one Scoba, with everything that is its own, wherever it is opened from. */
export function openScobaCard(ui: UI, art: Art, s: ScobaInstance, onBack: () => void): void {
  const sp = SPECIES[s.speciesId];
  // Its elements, and on the same line what it does with its time, which is
  // where its stat line comes from, so the line under them is the bio's.
  const kinds: HTMLElement[] = [];
  if (sp) kinds.push(typeIcons(s));
  if (s.hybrid) kinds.push(el("span", "dim", "Hybrid"));
  const doing = hobbyDoing(s.hobby);
  if (doing !== "") kinds.push(el("span", "dim bxDoing", doing));
  const [first] = scobaTypes(s);
  openCard(ui, {
    face: face(art, s),
    name: displayName(s),
    tag: `Lv ${s.level}`,
    kinds,
    bio: scobaText(s),
    hex: { stats: statsAt(s), color: first ? TYPE_COLORS[first] : "var(--p-dim)" },
    passives: [sp?.primaryAbility, s.secondaryAbility].flatMap((id) => passiveSlot(id)),
    moves: s.moves.flatMap((id) => {
      const move = MOVES[id];
      return move ? [moveSlot(move, moveCost(s, id))] : [];
    }),
    hint: "Pick a passive or a move to read it.",
    // Its own elements too: a number lands for half again where the Scoba
    // casting it shares one, and a line read without them said a move was
    // worth less than it is.
    prose: { stats: statsAt(s), level: s.level, types: scobaTypes(s) },
    onBack,
  });
}

