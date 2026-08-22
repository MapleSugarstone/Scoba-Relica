import type { Art } from "../engine/assets";
import {
  DEFAULT_LOOK,
  DETAIL_COLORS,
  HAIR_COLORS,
  SHIRT_COLORS,
  SKIN_COLORS,
  type Look,
} from "../engine/recolor";
import {
  DOLL_H,
  DOLL_W,
  EYE_URLS,
  HAIR_URLS,
  HEAD_BOX,
  SHIRT_URLS,
  TORSO_BOX,
  drawPaperdoll,
} from "../engine/paperdoll";
import { sfx } from "../engine/sfx";
import { newCareState, advanceCare, feed, wash, careLevel, type CareState } from "../sim/care";
import { makeWild, moveCost, statsAt, maxHp } from "../sim/scoba";
import { critterPortrait } from "../game/critters";
import { typeIcons } from "./typeicon";
import { ABILITIES, MOVES, SPECIAL, SPECIES, STARTER_IDS, rosterSpecies } from "../sim/species";
import { rngFrom } from "../sim/rng";
import {
  PRONOUN_PRESETS,
  type CharacterDef,
  type SaveData,
  type SlotId,
} from "../save/save";
import type { WorldContent } from "../game/content";
import { questLog } from "../game/quests";
export { freshRoomCode, normalizeRoomCode } from "../net/roomcode";
import { freshRoomCode, normalizeRoomCode } from "../net/roomcode";
import { mountInstallCard } from "./install";

export interface DialogLine {
  who?: string;
  text: string;
}

/**
 * One animation frame. Falls back to a timer so a hidden tab, where animation
 * frames stop firing, cannot leave the cover up forever.
 */
function frame(): Promise<void> {
  if ((window as { __scobaFast?: boolean }).__scobaFast) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => finish());
    window.setTimeout(finish, 120);
  });
}

/**
 * Waits until a style change has actually reached the screen.
 *
 * One animation frame is not enough: the callback runs before that frame is
 * painted, so anything awaiting it still runs ahead of the pixels. Two means
 * the frame the change was made in has been painted by the time the second
 * fires.
 */
async function painted(): Promise<void> {
  await frame();
  await frame();
}

export class UI {
  private uiRoot = document.getElementById("ui")!;
  private hudEl = document.getElementById("hud")!;
  private dialogEl = document.getElementById("dialog")!;
  private toastEl = document.getElementById("toast")!;
  private screenEl: HTMLElement | null = null;
  private lines: DialogLine[] = [];
  private lineIdx = 0;
  private dialogDone: (() => void) | null = null;
  private toastTimer = 0;
  private fadeEl = document.getElementById("fade")!;
  private fadeTimer = 0;
  /** Locked screens (battles, prompts) ignore Escape and the menu button. */
  locked = false;
  /**
   * True while the black is solid. Nothing simulates: the scene behind is
   * being built and must not be caught half done.
   */
  covered = false;
  /**
   * True until the cover has finished fading, which outlasts `covered`.
   * Nothing is pressable in that window, but the scene underneath is already
   * running, so its opening animation plays as the black clears rather than
   * waiting for it to be gone.
   */
  transitioning = false;
  /** The doors the bag folds out, in the order they hang under it. */
  private bagDoors: BagDoor[] = [];
  private bagEl = document.getElementById("bag")!;
  private bagBtn = document.getElementById("bagBtn") as HTMLButtonElement;
  private bagMenu = document.getElementById("bagMenu")!;

  constructor() {
    this.bagBtn.addEventListener("click", () => {
      sfx.tap();
      this.toggleBag();
    });
    // Anywhere else closes it, the way a real flap falls shut.
    window.addEventListener("pointerdown", (e) => {
      if (!this.bagOpen()) return;
      if (this.bagEl.contains(e.target as Node)) return;
      this.closeBag();
    }, { capture: true });
    this.dialogEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.advanceDialog();
    });
  }

  /**
   * Covers the screen in black, runs the handover, waits for the new scene to
   * actually draw a frame behind the cover, then fades it away.
   *
   * `work` is whatever swaps one thing for the next: building the overworld,
   * opening a battle, closing one. It runs with nothing else moving, so it
   * cannot be caught half done.
   */
  async transition(work: () => void, ms = 180): Promise<void> {
    this.cover();
    // Nothing is built until the black is genuinely on screen, or the handover
    // is what the player watches happen.
    await painted();
    work();
    // And nothing is revealed until the new scene has been drawn behind it.
    await painted();
    await this.reveal(ms);
  }

  // --- the bag, and the doors it folds out ---

  /** Hangs a set of doors under the bag. Rebuilt whenever the set changes. */
  setBagDoors(doors: BagDoor[]): void {
    this.bagDoors = doors;
    this.bagMenu.innerHTML = "";
    for (const door of doors) {
      const b = el("button", undefined, door.label);
      b.addEventListener("click", () => {
        sfx.confirm();
        this.closeBag();
        door.open();
      });
      this.bagMenu.appendChild(b);
    }
  }

  bagOpen(): boolean {
    return !this.bagMenu.hidden;
  }

  toggleBag(): void {
    if (this.bagOpen()) this.closeBag();
    else this.openBag();
  }

  openBag(): void {
    if (this.bagDoors.length === 0 || this.screenOpen()) return;
    this.bagMenu.hidden = false;
    this.bagBtn.classList.add("on");
    this.bagBtn.setAttribute("aria-expanded", "true");
  }

  closeBag(): void {
    if (!this.bagOpen()) return;
    this.bagMenu.hidden = true;
    this.bagBtn.classList.remove("on");
    this.bagBtn.setAttribute("aria-expanded", "false");
  }

  /** Drops the cover instantly. */
  cover(): void {
    this.covered = true;
    this.transitioning = true;
    window.clearTimeout(this.fadeTimer);
    this.fadeEl.style.transition = "none";
    this.fadeEl.classList.add("on", "busy");
    // Force the style through now rather than leaving it batched behind
    // whatever the handover is about to do to the DOM.
    void this.fadeEl.offsetHeight;
  }

  /** Fades the cover away; resolves once it is gone. */
  reveal(ms = 180): Promise<void> {
    // The tests and the fast-forward hook skip the wait entirely.
    if ((window as { __scobaFast?: boolean }).__scobaFast) ms = 0;
    return new Promise((resolve) => {
      this.fadeEl.style.transition = ms > 0 ? `opacity ${ms}ms linear` : "none";
      this.fadeEl.classList.remove("on");
      // The scene starts moving the moment the black starts clearing; only
      // the pointer stays blocked until it is fully gone.
      this.covered = false;
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = window.setTimeout(() => {
        this.fadeEl.classList.remove("busy");
        this.transitioning = false;
        resolve();
      }, ms);
    });
  }

  hud(on: boolean): void {
    this.hudEl.classList.toggle("on", on);
  }

  screen(build: (el: HTMLElement) => void): HTMLElement {
    this.closeBag();
    this.closeScreen();
    const el = document.createElement("div");
    el.className = "screen";
    build(el);
    this.uiRoot.appendChild(el);
    this.screenEl = el;
    return el;
  }

  closeScreen(): void {
    this.screenEl?.remove();
    this.screenEl = null;
    this.locked = false;
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  screenOpen(): boolean {
    return this.screenEl !== null;
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.style.opacity = "1";
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.style.opacity = "0";
    }, 2200);
  }

  openDialog(lines: DialogLine[], onDone?: () => void): void {
    this.lines = lines;
    this.lineIdx = 0;
    this.dialogDone = onDone ?? null;
    this.renderDialog();
  }

  dialogOpen(): boolean {
    return this.dialogEl.style.display === "block";
  }

  advanceDialog(): void {
    sfx.talk();
    this.lineIdx += 1;
    if (this.lineIdx >= this.lines.length) {
      this.dialogEl.style.display = "none";
      const done = this.dialogDone;
      this.dialogDone = null;
      done?.();
      return;
    }
    this.renderDialog();
  }

  private renderDialog(): void {
    const line = this.lines[this.lineIdx];
    if (!line) return;
    this.dialogEl.innerHTML = "";
    if (line.who) {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = line.who;
      this.dialogEl.appendChild(who);
    }
    const body = document.createElement("div");
    body.textContent = line.text;
    this.dialogEl.appendChild(body);
    const next = document.createElement("div");
    next.className = "next";
    next.textContent = this.lineIdx < this.lines.length - 1 ? "tap ▸" : "tap to close";
    this.dialogEl.appendChild(next);
    this.dialogEl.style.display = "block";
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function bigBtn(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el("button", `big${primary ? " primary" : ""}`, label);
  b.addEventListener("click", () => {
    sfx.confirm();
    onClick();
  });
  return b;
}

export function titleScreen(
  ui: UI,
  opts: { hasSave: boolean; onContinue: () => void; onNew: () => void; onImport: () => void },
): void {
  ui.screen((s) => {
    s.appendChild(el("h1", undefined, "Scoba Relica"));
    s.appendChild(el("div", "sub", "A two-player Scoba adventure."));
    if (opts.hasSave) s.appendChild(bigBtn("Continue", opts.onContinue, true));
    s.appendChild(bigBtn("New Game", opts.onNew, !opts.hasSave));
    s.appendChild(bigBtn("Import Save", opts.onImport));
    // Only once there is a save to lose: a first-time player has nothing to
    // protect yet, and the title screen is their first look at the game.
    if (opts.hasSave) mountInstallCard(s);
  });
}

const DEFAULTS: Record<SlotId, CharacterDef> = {
  A: { name: "Robin", pronouns: PRONOUN_PRESETS[2]!, look: { ...DEFAULT_LOOK }, starter: "cresce" },
  B: {
    name: "Sage",
    pronouns: PRONOUN_PRESETS[2]!,
    look: {
      ...DEFAULT_LOOK,
      skin: SKIN_COLORS[4]!,
      hair: HAIR_COLORS[0]!,
      shirt: SHIRT_COLORS[6]!,
      shirtDetail: DETAIL_COLORS[6]!,
      hairStyle: 2,
      eyeStyle: 3,
      shirtStyle: 1,
    },
    starter: "grima",
  },
};

type ColorKey = "shirt" | "shirtDetail" | "skin" | "hair";
type PartKey = "hairStyle" | "eyeStyle" | "shirtStyle";
type Box = { x: number; y: number; w: number; h: number };

const CHANNELS: { key: ColorKey; label: string; colors: string[] }[] = [
  { key: "shirt", label: "Shirt", colors: SHIRT_COLORS },
  { key: "shirtDetail", label: "Shirt details", colors: DETAIL_COLORS },
  { key: "skin", label: "Skin", colors: SKIN_COLORS },
  { key: "hair", label: "Hair", colors: HAIR_COLORS },
];

const PARTS: { key: PartKey; label: string; count: number; none: boolean; box: Box }[] = [
  { key: "hairStyle", label: "Hair", count: HAIR_URLS.length, none: true, box: HEAD_BOX },
  { key: "eyeStyle", label: "Eyes", count: EYE_URLS.length, none: false, box: HEAD_BOX },
  { key: "shirtStyle", label: "Shirt", count: SHIRT_URLS.length, none: true, box: TORSO_BOX },
];

/** Thumbnail of one part option: the doll cropped to the region it changes. */
function partThumb(art: Art, look: Look, box: Box): HTMLCanvasElement {
  const cv = el("canvas") as HTMLCanvasElement;
  cv.width = box.w;
  cv.height = box.h;
  cv.style.height = "54px";
  cv.style.width = `${Math.round((box.w * 54) / box.h)}px`;
  drawPaperdoll(cv.getContext("2d")!, art.doll, look, -box.x, -box.y);
  return cv;
}

function customizeScreen(
  ui: UI,
  art: Art,
  slot: SlotId,
  def: CharacterDef,
  heading: string,
  note: string | null,
  onDone: (def: CharacterDef) => void,
): void {
  const d: CharacterDef = { name: def.name, pronouns: { ...def.pronouns }, look: { ...def.look }, starter: def.starter };
  let channel = 0;

  ui.screen((s) => {
    s.appendChild(el("h2", undefined, heading));
    if (note) s.appendChild(el("div", "sub", note));

    const stage = el("div", "dollWrap");
    const preview = el("canvas", "doll") as HTMLCanvasElement;
    preview.width = DOLL_W;
    preview.height = DOLL_H;
    stage.appendChild(preview);
    s.appendChild(stage);

    const idCard = el("div", "card");
    idCard.appendChild(el("label", undefined, "Name"));
    const name = el("input") as HTMLInputElement;
    name.type = "text";
    name.maxLength = 12;
    name.value = d.name;
    idCard.appendChild(name);

    idCard.appendChild(el("label", undefined, "Pronouns"));
    const pronRow = el("div", "row");
    const renderProns = (): void => {
      pronRow.innerHTML = "";
      PRONOUN_PRESETS.forEach((p) => {
        const sel = d.pronouns.subject === p.subject;
        const b = el("button", `pill${sel ? " sel" : ""}`, `${p.subject}/${p.object}`);
        b.addEventListener("click", () => {
          sfx.tap();
          d.pronouns = { ...p };
          renderProns();
        });
        pronRow.appendChild(b);
      });
    };
    renderProns();
    idCard.appendChild(pronRow);
    s.appendChild(idCard);

    // Parts: one thumbnail row per layer, rebuilt whenever a color changes so
    // the options always show the colors currently picked.
    const partsCard = el("div", "card");
    const partRows: (() => void)[] = [];
    for (const part of PARTS) {
      partsCard.appendChild(el("label", undefined, part.label));
      const row = el("div", "thumbs");
      partsCard.appendChild(row);
      const render = (): void => {
        row.innerHTML = "";
        const options = part.none ? [-1] : [];
        for (let i = 0; i < part.count; i++) options.push(i);
        for (const i of options) {
          const b = el("button", `thumb${d.look[part.key] === i ? " sel" : ""}`);
          const look: Look = { ...d.look };
          look[part.key] = i;
          b.appendChild(partThumb(art, look, part.box));
          b.addEventListener("click", () => {
            sfx.tap();
            d.look[part.key] = i;
            redrawArt();
          });
          row.appendChild(b);
        }
      };
      partRows.push(render);
    }
    s.appendChild(partsCard);

    // Colors: a channel picker, that channel's swatches, and a free color well.
    const colorCard = el("div", "card");
    let dots: HTMLElement[] = [];
    let swatches: { el: HTMLElement; color: string }[] = [];

    const syncColors = (): void => {
      CHANNELS.forEach((c, i) => {
        dots[i]!.style.background = d.look[c.key];
      });
      const cur = d.look[CHANNELS[channel]!.key].toLowerCase();
      for (const sw of swatches) sw.el.classList.toggle("sel", sw.color.toLowerCase() === cur);
    };

    const redrawArt = (): void => {
      const ctx = preview.getContext("2d")!;
      ctx.clearRect(0, 0, DOLL_W, DOLL_H);
      drawPaperdoll(ctx, art.doll, d.look);
      for (const render of partRows) render();
      syncColors();
    };

    const renderColors = (): void => {
      colorCard.innerHTML = "";
      dots = [];
      swatches = [];
      colorCard.appendChild(el("label", undefined, "Colors"));

      const tabs = el("div", "row");
      CHANNELS.forEach((c, i) => {
        const b = el("button", `pill chan${i === channel ? " sel" : ""}`);
        const dot = el("i");
        dot.style.background = d.look[c.key];
        b.appendChild(dot);
        b.appendChild(el("span", undefined, c.label));
        b.addEventListener("click", () => {
          sfx.tap();
          channel = i;
          renderColors();
          syncColors();
        });
        dots.push(dot);
        tabs.appendChild(b);
      });
      colorCard.appendChild(tabs);

      const ch = CHANNELS[channel]!;
      const grid = el("div", "swatches");
      for (const color of ch.colors) {
        const b = el("button", "swatch");
        b.style.setProperty("--fill", color);
        b.addEventListener("click", () => {
          sfx.tap();
          d.look[ch.key] = color;
          redrawArt();
        });
        swatches.push({ el: b, color });
        grid.appendChild(b);
      }
      colorCard.appendChild(grid);

      const custom = el("label", "custom");
      const well = el("input") as HTMLInputElement;
      well.type = "color";
      well.value = d.look[ch.key];
      // Dragging in the OS picker fires input continuously, so this handler
      // must not rebuild the card the well lives in.
      well.addEventListener("input", () => {
        d.look[ch.key] = well.value;
        redrawArt();
      });
      custom.appendChild(well);
      custom.appendChild(el("span", undefined, `Custom ${ch.label.toLowerCase()}`));
      colorCard.appendChild(custom);
    };

    renderColors();
    redrawArt();
    s.appendChild(colorCard);

    s.appendChild(
      bigBtn("Next", () => {
        d.name = name.value.trim() || DEFAULTS[slot].name;
        onDone(d);
      }, true),
    );
  });
}

/** A badge per type, so a two-type Scoba wears both. */
function typeBadge(id: string): HTMLElement {
  return typeIcons(SPECIES[id]!);
}

/**
 * One starter per primary type, picked by one character at a time. The second
 * picker sees the first one's choice locked out.
 */
function starterScreen(
  ui: UI,
  art: Art,
  who: CharacterDef,
  taken: { id: string; by: string } | null,
  onPick: (speciesId: string) => void,
): void {
  let chosen: string | null = null;
  ui.screen((s) => {
    s.appendChild(el("h2", undefined, `${who.name}, pick a Scoba.`));
    s.appendChild(el("div", "sub", taken
      ? `${taken.by} took ${SPECIES[taken.id]!.name}. Everyone else is fair game.`
      : "One for each primary type. Your partner picks from the rest."));

    const grid = el("div", "starters");
    const detail = el("div", "card");
    const confirm = bigBtn("Choose", () => {
      if (chosen) onPick(chosen);
    }, true);
    confirm.disabled = true;

    const renderDetail = (): void => {
      detail.innerHTML = "";
      if (!chosen) {
        detail.appendChild(el("div", "sub", "Tap one to see what it is."));
        return;
      }
      const sp = SPECIES[chosen]!;
      const head = el("div", "row");
      head.appendChild(el("strong", undefined, sp.name));
      head.appendChild(typeBadge(sp.id));
      detail.appendChild(head);
      if (sp.blurb) detail.appendChild(el("div", "sub", sp.blurb));
      const ability = ABILITIES[sp.primaryAbility];
      if (ability) detail.appendChild(el("div", "dim", `Passive: ${ability.name} — ${ability.desc}`));
      const g = sp.genes;
      detail.appendChild(el("div", "dim",
        `HP ${g.hp} · Str ${g.str} · Def ${g.def} · Res ${g.res} · Mag ${g.mag} · Spd ${g.spd}`));
      detail.appendChild(el("div", "dim",
        `Starts with ${sp.learnset.filter((l) => l.level <= 5).map((l) => MOVES[l.move]?.name ?? l.move).join(", ")}`));
    };

    const renderGrid = (): void => {
      grid.innerHTML = "";
      for (const id of STARTER_IDS) {
        const sp = SPECIES[id]!;
        const isTaken = taken?.id === id;
        const b = el("button", `starter${chosen === id ? " sel" : ""}${isTaken ? " taken" : ""}`);
        b.disabled = isTaken;
        const stage = el("div", "stage");
        stage.appendChild(critterPortrait(art, sp));
        b.appendChild(stage);
        b.appendChild(el("div", "nm", sp.name));
        b.appendChild(typeBadge(id));
        if (isTaken) b.appendChild(el("div", "dim", "taken"));
        b.addEventListener("click", () => {
          sfx.tap();
          chosen = id;
          confirm.disabled = false;
          confirm.textContent = `Choose ${sp.name}`;
          renderGrid();
          renderDetail();
        });
        grid.appendChild(b);
      }
    };

    renderGrid();
    renderDetail();
    s.appendChild(grid);
    s.appendChild(detail);
    s.appendChild(confirm);
  });
}

export function newGameFlow(ui: UI, art: Art, onStart: (save: SaveData) => void): void {
  ui.screen((s) => {
    s.appendChild(el("h2", undefined, "Pick your character."));
    s.appendChild(el("div", "sub", "A friend can join later as the other one."));
    const row = el("div", "row");
    for (const slot of ["A", "B"] as SlotId[]) {
      row.appendChild(bigBtn(`Character ${slot}`, () => pickSlot(slot), slot === "A"));
    }
    s.appendChild(row);
  });

  const pickSlot = (localSlot: SlotId): void => {
    const other: SlotId = localSlot === "A" ? "B" : "A";
    customizeScreen(ui, art, localSlot, DEFAULTS[localSlot], `Your character (${localSlot})`, null, (localDef) => {
      customizeScreen(
        ui, art, other, DEFAULTS[other],
        `Partner (${other})`,
        "They can redesign this when they join.",
        (otherDef) => {
          // Whoever player one is picks first; the other takes from the rest.
          starterScreen(ui, art, localDef, null, (localStarter) => {
            localDef.starter = localStarter;
            starterScreen(ui, art, otherDef, { id: localStarter, by: localDef.name }, (otherStarter) => {
              otherDef.starter = otherStarter;
              onStart(buildSave(localSlot, localDef, otherDef));
            });
          });
        },
      );
    });
  };
}

function buildSave(localSlot: SlotId, localDef: CharacterDef, otherDef: CharacterDef): SaveData {
  const other: SlotId = localSlot === "A" ? "B" : "A";
  const now = Date.now();
  const worldSeed = Math.random().toString(36).slice(2, 10);
  const mine = makeWild(localDef.starter, 5, rngFrom(`${worldSeed}:starter:${localSlot}`));
  mine.owner = localSlot;
  const theirs = makeWild(otherDef.starter, 5, rngFrom(`${worldSeed}:starter:${other}`));
  theirs.owner = other;
  return {
    version: 12,
    createdAt: now,
    updatedAt: now,
    worldSeed,
    localSlot,
    partnerJoined: false,
    characters: {
      A: localSlot === "A" ? localDef : otherDef,
      B: localSlot === "B" ? localDef : otherDef,
    },
    party: [mine, theirs],
    box: [],
    bag: { snare: 8, "skee-berry": 3 },
    money: 200,
    aetus: 0,
    story: { chapter: 0, flags: {} },
    quests: {},
    pos: { map: "", x: 0, y: 0 },
    sentinels: {},
    special: newCareState(now),
  };
}

function meter(label: string, value: number): HTMLElement {
  const wrap = el("div", "meter");
  const lbl = el("div", "lbl");
  lbl.appendChild(el("span", undefined, label));
  lbl.appendChild(el("span", undefined, String(Math.round(value))));
  const bar = el("div", "bar");
  const fill = el("i");
  fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  if (value < 25) fill.style.background = "#d9553f";
  else if (value < 55) fill.style.background = "#e7a03c";
  bar.appendChild(fill);
  wrap.appendChild(lbl);
  wrap.appendChild(bar);
  return wrap;
}

/** One entry in the bag's fold-out. */
export interface BagDoor {
  label: string;
  open: () => void;
}

/**
 * The quest log. Its own door on the bag rather than a card on a menu, since
 * checking what you are meant to be doing is a thing you do on its own.
 */
export function questScreen(ui: UI, save: SaveData, content: WorldContent, onBack: () => void): void {
  ui.screen((s) => {
    s.appendChild(el("h2", undefined, "Quests"));
    const log = questLog(content, save);
    if (log.length === 0) {
      s.appendChild(el("div", "sub", "Nothing on the go. Talk to people and something will turn up."));
    } else {
      const card = el("div", "card");
      const list = el("div", "list");
      for (const q of log) {
        const item = el("div", "item");
        const left = el("div");
        left.appendChild(el("div", undefined, q.name));
        left.appendChild(el("div", "dim", q.objective));
        item.appendChild(left);
        if (q.done) {
          item.appendChild(el("span", "badge", "done"));
          item.style.opacity = "0.55";
        }
        list.appendChild(item);
      }
      card.appendChild(list);
      s.appendChild(card);
    }
    s.appendChild(bigBtn("Back", onBack, true));
  });
}

/**
 * Relica: the special Scoba, and everything you do for it. Its meters carry on
 * running whether or not this is open, so opening it advances the clock first.
 */
/**
 * The reminders control, handed in rather than reached for, so this file stays
 * clear of the push and relay code. `label` is what the pill should say and
 * `note` the line under it, both worked out from the real permission state.
 */
export interface ReminderControl {
  read(): Promise<{ label: string; note: string; actionable: boolean }>;
  toggle(): Promise<{ note: string }>;
}

export function relicaScreen(
  ui: UI,
  save: SaveData,
  cb: {
    onBack: () => void;
    onCareChange: (s: CareState) => void;
    onPlay: () => void;
    reminders?: ReminderControl;
  },
): void {
  ui.screen((s) => {
    s.appendChild(el("h2", undefined, "Relica"));
    const card = el("div", "card");
    const render = (): void => {
      card.innerHTML = "";
      const c = save.special;
      const head = el("div", "row");
      head.appendChild(el("strong", undefined, `${SPECIAL.name} · care lv ${careLevel(c)}`));
      if (c.hibernating) head.appendChild(el("span", "badge", "hibernating"));
      card.appendChild(head);
      card.appendChild(meter("Hunger", c.hunger));
      card.appendChild(meter("Clean", c.clean));
      card.appendChild(meter("Mood", c.happy));
      const actions = el("div", "row");
      const act = (label: string, fn: (st: CareState) => CareState): HTMLElement => {
        const b = el("button", "pill", label);
        b.addEventListener("click", () => {
          sfx.confirm();
          save.special = fn(advanceCare(save.special, Date.now()));
          cb.onCareChange(save.special);
          render();
        });
        return b;
      };
      actions.appendChild(act("Feed", feed));
      actions.appendChild(act("Wash", wash));
      const playB = el("button", "pill", "Play");
      playB.addEventListener("click", () => {
        sfx.tap();
        cb.onPlay();
      });
      actions.appendChild(playB);
      card.appendChild(actions);
    };
    render();
    s.appendChild(card);

    if (cb.reminders) {
      const control = cb.reminders;
      const remind = el("div", "card");
      remind.appendChild(el("strong", undefined, "Reminders"));
      const note = el("div", "dim", "Checking...");
      const button = el("button", "pill", "...");
      button.disabled = true;
      // The permission state is only knowable asynchronously, so the card goes
      // up straight away and fills itself in rather than holding the screen.
      const refresh = (): void => {
        void control.read().then(({ label, note: text, actionable }) => {
          if (!remind.isConnected) return;
          button.textContent = label;
          button.disabled = !actionable;
          note.textContent = text;
        });
      };
      button.addEventListener("click", () => {
        sfx.confirm();
        button.disabled = true;
        void control.toggle().then(({ note: text }) => {
          if (!remind.isConnected) return;
          note.textContent = text;
          refresh();
        });
      });
      remind.appendChild(button);
      remind.appendChild(note);
      s.appendChild(remind);
      refresh();
    }

    s.appendChild(bigBtn("Back", cb.onBack, true));
  });
}

/**
 * The index: every Scoba there is, and how much of each one you have met.
 * Owning one tells you everything; having only run into it gives you its face
 * and its name; the rest are blanks, so the list reads as something to fill.
 */
export function indexScreen(ui: UI, art: Art, save: SaveData, onBack: () => void): void {
  const owned = new Set([...save.party, ...save.box].map((s2) => s2.speciesId));
  const seen = new Set([...(save.seen ?? []), ...owned]);
  const all = rosterSpecies();
  ui.screen((s) => {
    s.appendChild(el("h2", undefined, "Index"));
    s.appendChild(el("div", "sub", `${owned.size} kept · ${seen.size} met · ${all.length} in all`));
    const card = el("div", "card");
    const list = el("div", "list");
    for (const sp of all) {
      const item = el("div", "item");
      const left = el("div");
      const head = el("div", "who");
      if (seen.has(sp.id)) {
        head.appendChild(el("span", undefined, sp.name));
        head.appendChild(typeIcons(sp));
        if (owned.has(sp.id)) head.appendChild(el("span", "badge", "kept"));
        left.appendChild(head);
        left.appendChild(el("div", "dim", owned.has(sp.id)
          ? `Str ${sp.genes.str} · Def ${sp.genes.def} · Res ${sp.genes.res} · Mag ${sp.genes.mag} · Spd ${sp.genes.spd}`
          : "Met in the wild. Keep one to read its numbers."));
      } else {
        head.appendChild(el("span", "dim", "??????"));
        left.appendChild(head);
        left.appendChild(el("div", "dim", "Not met yet."));
      }
      item.appendChild(left);
      if (seen.has(sp.id)) item.appendChild(critterPortrait(art, sp));
      list.appendChild(item);
    }
    card.appendChild(list);
    s.appendChild(card);
    s.appendChild(bigBtn("Back", onBack, true));
  });
}

/**
 * Connect: host a room and read out its code, or type someone else's in. The
 * screen reads out where the connection currently stands rather than claiming
 * a room is shared the moment a code is typed.
 */
export function connectScreen(
  ui: UI,
  save: SaveData,
  cb: {
    onBack: () => void;
    onChange: () => void;
    /** Read when the screen is built, so reopening it refreshes the reading. */
    relay: () => { status: string; partnerHere: boolean };
  },
): void {
  ui.screen((s) => {
    s.appendChild(el("h2", undefined, "Connect"));

    const link = cb.relay();
    const reading = (room: string | undefined): string => {
      if (!room) return "Two players share one campaign. One hosts, the other joins with the code.";
      if (link.status === "live") {
        return link.partnerHere
          ? `Room ${room}. The other player is here.`
          : `Room ${room}. Connected, waiting on the other player.`;
      }
      if (link.status === "connecting") return `Room ${room}. Connecting.`;
      return `Room ${room}. Not connected.`;
    };
    const status = el("div", "sub", reading(save.room));
    s.appendChild(status);

    const card = el("div", "card");
    card.appendChild(el("strong", undefined, "Host"));
    const codeRow = el("div", "row");
    const codeOut = el("div", "code", save.room ?? "------");
    codeRow.appendChild(codeOut);
    const hostB = el("button", "pill", save.room ? "New code" : "Host a game");
    hostB.addEventListener("click", () => {
      sfx.confirm();
      save.room = freshRoomCode();
      codeOut.textContent = save.room;
      status.textContent = `Room ${save.room}. Connecting.`;
      cb.onChange();
    });
    codeRow.appendChild(hostB);
    card.appendChild(codeRow);
    card.appendChild(el("div", "dim", "Read the code out to the other player."));
    s.appendChild(card);

    const join = el("div", "card");
    join.appendChild(el("strong", undefined, "Join"));
    const field = el("input") as HTMLInputElement;
    field.type = "text";
    field.placeholder = "Their code";
    field.maxLength = 7;
    field.autocapitalize = "characters";
    field.spellcheck = false;
    join.appendChild(field);
    const joinB = el("button", "pill", "Join with this code");
    joinB.addEventListener("click", () => {
      const code = normalizeRoomCode(field.value);
      if (!code) {
        sfx.back();
        ui.toast("A code is six letters and numbers.");
        return;
      }
      sfx.confirm();
      save.room = code;
      codeOut.textContent = code;
      status.textContent = `Room ${code}. Connecting.`;
      cb.onChange();
      ui.toast("Joining that room.");
    });
    join.appendChild(joinB);
    s.appendChild(join);

    if (save.room) {
      const drop = el("button", "big", "Leave the room");
      drop.addEventListener("click", () => {
        sfx.back();
        save.room = undefined;
        cb.onChange();
        connectScreen(ui, save, cb);
      });
      s.appendChild(drop);
    }
    s.appendChild(el("div", "sub",
      "The Relica is shared: whoever feeds or washes it, the other sees it that way too."));
    s.appendChild(bigBtn("Back", cb.onBack, true));
  });
}

/** A labelled 0-100 bar. Returns the row, already wired to its setter. */
function levelBar(label: string, value: number, onChange: (v: number) => void): HTMLElement {
  const row = el("label", "setBar");
  row.appendChild(el("span", "setBarName", label));
  const slider = el("input") as HTMLInputElement;
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = String(Math.round(value * 100));
  const num = el("span", "setBarNum", `${slider.value}%`);
  slider.addEventListener("input", () => {
    num.textContent = `${slider.value}%`;
    onChange(Number(slider.value) / 100);
  });
  row.appendChild(slider);
  row.appendChild(num);
  return row;
}

export function settingsScreen(
  ui: UI,
  save: SaveData,
  cb: { onBack: () => void; onExport: () => void; onQuit: () => void; onEzChange: () => void },
): void {
  ui.screen((s) => {
    s.appendChild(el("h2", undefined, "Settings"));

    const audio = el("div", "card");
    audio.appendChild(el("strong", undefined, "Sound"));
    audio.appendChild(levelBar("Sound", sfx.volume(), (v) => {
      sfx.setVolume(v);
      // A blip on the way past, so the bar is heard as well as seen.
      sfx.tap();
    }));
    audio.appendChild(levelBar("Music", sfx.musicVolume(), (v) => sfx.setMusicVolume(v)));
    audio.appendChild(el("div", "dim", "There is no music yet. The bar keeps its level for when there is."));
    s.appendChild(audio);

    const play = el("div", "card");
    play.appendChild(el("strong", undefined, "Playing"));
    const ezRow = el("div", "row");
    const ezB = el("button", "pill", save.ez ? "EZ Mode on" : "EZ Mode off");
    ezB.addEventListener("click", () => {
      sfx.confirm();
      save.ez = !save.ez;
      ezB.textContent = save.ez ? "EZ Mode on" : "EZ Mode off";
      cb.onEzChange();
    });
    ezRow.appendChild(ezB);
    play.appendChild(ezRow);
    play.appendChild(el("div", "dim",
      "In battle, your Scobas count every level as 4 to each stat instead of 1. It is hung on them as the fight opens and goes with it, so nothing about them changes outside a battle and turning this off takes it straight back. Wild Scobas and other trainers' are left alone."));
    s.appendChild(play);

    const saveCard = el("div", "card");
    saveCard.appendChild(el("strong", undefined, "This save"));
    saveCard.appendChild(el("div", "dim", "The game saves itself as you play. Export writes a copy you can keep."));
    const saveRow = el("div", "row");
    const exportB = el("button", "pill", "Export a copy");
    exportB.addEventListener("click", () => {
      sfx.confirm();
      cb.onExport();
    });
    saveRow.appendChild(exportB);
    saveCard.appendChild(saveRow);
    s.appendChild(saveCard);

    s.appendChild(bigBtn("Back", cb.onBack, true));
    const quit = el("button", "big", "Quit to Title");
    quit.addEventListener("click", () => {
      sfx.back();
      cb.onQuit();
    });
    s.appendChild(quit);
  });
}
