// The Scoba browser: a search panel, a grid of faces, a scroll column and a
// strip along the bottom. The Box uses it to arrange a character's roster and
// the nest uses it to pick a parent, so the frame is built once here and each
// caller fills in what sits under the grid.
//
// Nothing re-renders wholesale. Typing in the name field, sliding a stat and
// picking a face all touch only the part they change, because rebuilding the
// screen would take the caret out of the field the player is typing in.
import type { Art } from "../engine/assets";
import { sfx } from "../engine/sfx";
import { critterPortrait } from "../game/critters";
import { displayName } from "../sim/battle";
import { START_MANA } from "../sim/battle";
import { MAX_BREED_COUNT } from "../sim/breeding";
import { STATUSES } from "../sim/status";
import { moveCost, passiveStatuses, statsAt, maxHp, type ScobaInstance } from "../sim/scoba";
import { ABILITIES, MOVES, SPECIES, typesOf, type Move } from "../sim/species";
import { TARGET_LABELS } from "../sim/targeting";
import { STAT_LABELS, TYPES, TYPE_COLORS, TYPE_LABELS, type ElementType, type StatName } from "../sim/types";
import type { UI } from "./screens";
import { typeIcon, typeIcons } from "./typeicon";

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
  b.addEventListener("click", () => {
    sfx.tap();
    onClick();
  });
  return b;
};

/**
 * A cropped face, wearing whatever mask it inherited, at the size it was drawn.
 * Never scaled: the art is drawn with a three pixel outline, and stretching it
 * to fill a frame would thicken that line past everything around it.
 */
export function face(art: Art, s: ScobaInstance): HTMLElement {
  const wrap = el("div", "bxFace");
  const sp = SPECIES[s.speciesId];
  if (!sp) return wrap;
  wrap.appendChild(critterPortrait(art, sp, s.tint, s.shiny));
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
    const sp = SPECIES[s.speciesId];
    const q = applied.name.trim().toLowerCase();
    if (q !== "" && !displayName(s).toLowerCase().includes(q)
      && !(sp?.name ?? s.speciesId).toLowerCase().includes(q)) return false;
    if (applied.types.size > 0 && !(sp && typesOf(sp).some((t) => applied.types.has(t)))) return false;
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
  const thumb = el("i", "bxThumb");

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

  const fillReadout = (): void => {
    readout.innerHTML = "";
    const s = selected();
    if (!s) {
      readout.appendChild(el("div", "dim", cfg.hint ?? "Pick one."));
      return;
    }
    const sp = SPECIES[s.speciesId];
    readout.appendChild(el("div", "bxReadName", displayName(s)));
    readout.appendChild(face(art, s));
    readout.appendChild(el("div", "dim", `Lv ${s.level}`));
    if (sp) readout.appendChild(typeIcons(sp));
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
      laterThumb();
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
    laterThumb();
  };

  /** The bar on the right says how far down a long box the grid is. */
  const syncThumb = (): void => {
    const room = grid.scrollHeight;
    const seen = grid.clientHeight;
    if (room <= seen + 1) {
      thumb.style.height = "100%";
      thumb.style.top = "0";
      return;
    }
    thumb.style.height = `${Math.max(14, (seen / room) * 100)}%`;
    thumb.style.top = `${(grid.scrollTop / room) * 100}%`;
  };
  /**
   * After a refill the grid has not been laid out yet, and on the first build
   * it is not even in the document, so the measurement waits a tick. A timer
   * rather than a frame, because a hidden tab stops handing out frames.
   */
  const laterThumb = (): void => {
    window.setTimeout(() => {
      // A screen that has just been built starts at the top; put it back where
      // this browser was left before measuring the bar against it.
      grid.scrollTop = Math.min(scrolledTo.get(memoryKey()) ?? 0, grid.scrollHeight - grid.clientHeight);
      syncThumb();
    }, 0);
  };
  grid.addEventListener("scroll", () => {
    scrolledTo.set(memoryKey(), grid.scrollTop);
    syncThumb();
  });

  const scrollBy = (dir: -1 | 1): void => {
    grid.scrollBy({ top: dir * 68, behavior: "auto" });
    syncThumb();
  };

  const track = el("div", "bxTrack");
  track.appendChild(thumb);

  /** Dragging the thumb: the grab point stays under the finger the whole way. */
  thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const room = grid.scrollHeight - grid.clientHeight;
    if (room <= 0) return;
    const rail = track.clientHeight - thumb.offsetHeight;
    if (rail <= 0) return;
    const grabbed = e.clientY - thumb.getBoundingClientRect().top;
    thumb.classList.add("held");
    // Tracked on the window rather than the thumb, so a finger that slides off
    // the bar keeps dragging it instead of dropping it.
    const move = (m: PointerEvent): void => {
      const at = m.clientY - track.getBoundingClientRect().top - grabbed;
      grid.scrollTop = (Math.min(Math.max(at, 0), rail) / rail) * room;
      syncThumb();
    };
    const drop = (): void => {
      thumb.classList.remove("held");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", drop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", drop);
  });

  /** Pressing the rail above or below the thumb pages the grid that way. */
  track.addEventListener("pointerdown", (e) => {
    if (e.target === thumb) return;
    const above = e.clientY < thumb.getBoundingClientRect().top;
    grid.scrollBy({ top: (above ? -1 : 1) * grid.clientHeight, behavior: "auto" });
    syncThumb();
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
        slider.addEventListener("input", () => {
          draft.stats[name] = Number(slider.value);
          num.textContent = draft.stats[name] === 0 ? "any" : slider.value;
        });
        row.appendChild(slider);
        row.appendChild(num);
        search.appendChild(row);
      }
      search.appendChild(button("bxWide", "Search", apply));
      search.appendChild(button("bxWide bxClear", "Clear search", reset));
      wrap.appendChild(search);

      // The grid itself.
      const gridPanel = el("div", "bxPanel bxGridPanel");
      gridPanel.appendChild(grid);
      wrap.appendChild(gridPanel);

      // Side column: the scroll controls.
      const side = el("div", "bxSide");
      side.appendChild(button("bxArrow", "▲", () => scrollBy(-1)));
      side.appendChild(track);
      side.appendChild(button("bxArrow", "▼", () => scrollBy(1)));
      wrap.appendChild(side);

      // Readout, and the button that opens the whole card.
      const info = el("div", "bxPanel bxInfo");
      info.appendChild(readout);
      info.appendChild(button("bxWide", "Info", () => {
        const s = selected();
        if (s) infoScreen(s);
      }));
      wrap.appendChild(info);

      wrap.appendChild(footWrap);
      screen.appendChild(wrap);
      screen.appendChild(button("big", "Back", cfg.onBack));

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

  /**
   * The whole card: the face and the numbers across the top, then a button for
   * each of the two passives and each move. Pressing one says what it does,
   * which is the only way to read a move outside a fight.
   */
  function infoScreen(s: ScobaInstance): void {
    const sp = SPECIES[s.speciesId];
    const stats = statsAt(s);
    let showing: { name: string; note: string; desc: string; type?: ElementType } | null = null;

    ui.screen((screen) => {
      const card = el("div", "bxCard");

      const head = el("div", "bxCardHead");
      const port = el("div", "bxPortrait");
      port.appendChild(face(art, s));
      head.appendChild(port);

      const facts = el("div", "bxFacts");
      const top = el("div", "bxFactsTop");
      const who = el("div", "bxWho");
      who.appendChild(el("div", "bxCardName", displayName(s)));
      who.appendChild(el("div", undefined, `HP: ${s.hp}/${maxHp(s)}`));
      top.appendChild(who);
      const corner = el("div", "bxCorner");
      corner.appendChild(el("div", undefined, `lv. ${s.level}`));
      corner.appendChild(el("div", undefined, `Mana: ${openingMana(s)}%`));
      top.appendChild(corner);
      facts.appendChild(top);

      const list = el("div", "bxStatList");
      for (const name of ["str", "def", "res", "spd", "mag"] as StatName[]) {
        list.appendChild(el("div", undefined, `- ${SHORT[name]}: ${stats[name]}`));
      }
      facts.appendChild(list);

      const tail = el("div", "bxCardTail");
      const where = el("div", "bxCardWhere");
      if (sp) where.appendChild(typeIcons(sp));
      where.appendChild(el("div", "dim", `Bred ${s.breedCount}/${MAX_BREED_COUNT}`));
      tail.appendChild(where);
      tail.appendChild(button("bxCardBack", "Back", build));
      facts.appendChild(tail);
      head.appendChild(facts);
      card.appendChild(head);

      // Two passives on the first row, then the moves, as in the mock-up.
      const note = el("div", "bxNote");
      const slots = el("div", "bxSlots");
      const showSlot = (btn: HTMLElement, what: NonNullable<typeof showing>): void => {
        showing = what;
        for (const other of slots.querySelectorAll(".bxSlot")) other.classList.remove("sel");
        btn.classList.add("sel");
        fillNote();
      };
      const fillNote = (): void => {
        note.innerHTML = "";
        if (!showing) {
          note.appendChild(el("div", "dim", "Pick a passive or a move to read it."));
          return;
        }
        const head = el("div", "bxNoteHead");
        head.appendChild(el("strong", undefined, showing.name));
        if (showing.type) head.appendChild(typeIcon(showing.type));
        head.appendChild(el("span", "dim", showing.note));
        note.appendChild(head);
        note.appendChild(el("div", undefined, showing.desc));
      };

      const slot = (label: string, cost: string, what: NonNullable<typeof showing>): void => {
        const b = el("button", `bxSlot${what.type ? " typed" : ""}`);
        // A move button wears the colour of what it is.
        if (what.type) b.style.background = TYPE_COLORS[what.type];
        b.appendChild(el("span", "bxSlotName", label));
        b.appendChild(el("span", "bxSlotCost", cost));
        b.addEventListener("click", () => {
          sfx.tap();
          showSlot(b, what);
        });
        slots.appendChild(b);
      };

      for (const id of [sp?.primaryAbility, s.secondaryAbility]) {
        const ability = id ? ABILITIES[id] : undefined;
        if (!ability) continue;
        slot(ability.name, "passive", { name: ability.name, note: "passive", desc: ability.desc });
      }
      for (const id of s.moves) {
        const move = MOVES[id];
        if (!move) continue;
        const cost = moveCost(s, id);
        slot(move.name, `${cost}%`, {
          name: move.name,
          note: cost > move.manaCost ? `${move.kind} · worked` : move.kind,
          desc: moveLine(move),
          type: move.type,
        });
      }
      card.appendChild(slots);
      fillNote();
      card.appendChild(note);
      screen.appendChild(card);
    });
  }

  build();
}

/** What a move does, in the words the ability readout would use. */
function moveLine(move: Move): string {
  const parts: string[] = [];
  if (move.kind === "heal") parts.push(`Heals ${Math.round(move.scale * 100)}% of the target's pool.`);
  else if (move.kind !== "utility") {
    parts.push(`${Math.round(move.scale * 100)}% ${move.kind === "physical" ? "Strength" : "Magic"}.`);
  }
  parts.push(`Aimed at ${TARGET_LABELS[move.targets[0]?.mode ?? "any-enemy"]}.`);
  if (move.cooldown > 0) parts.push(`${move.cooldown} turn cooldown.`);
  for (const effect of move.effects ?? []) {
    if (effect.kind === "status") parts.push(`Leaves ${STATUSES[effect.status]?.name ?? effect.status}.`);
    if (effect.kind === "cleanse") parts.push("Clears what ails it.");
    if (effect.kind === "summon") parts.push("Calls something in.");
    if (effect.kind === "grant-item") parts.push("Turns something up.");
  }
  return parts.join(" ");
}

/**
 * The mana a Scoba opens a battle on: everyone starts the same, and a passive
 * carrying a mana effect (Meepa's Moonwell) tops that up.
 */
function openingMana(s: ScobaInstance): number {
  let mana = START_MANA;
  for (const inst of passiveStatuses(s)) {
    for (const effect of STATUSES[inst.id]?.effects ?? []) {
      if (effect.kind === "mana") mana += effect.amount;
    }
  }
  return mana;
}

