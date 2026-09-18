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
  sanitizeDollLook,
} from "../engine/paperdoll";
import { hasPaint, type PaintSet, type PaintSlot } from "../engine/paint";
import { PAINT_MENU, SLOT_INFO, paintScreen } from "./paintscreen";
import { sfx } from "../engine/sfx";
import { newCareState, advanceCare, feed, wash, careLevel, type CareState } from "../sim/care";
import { MAX_LEVEL, makeWild, moveCost, statsAt, maxHp, type ScobaInstance } from "../sim/scoba";
import { critterPortrait } from "../game/critters";
import { typeIcons } from "./typeicon";
import {
  MOVES, SPECIAL, SPECIES, STARTER_IDS, rosterSpecies, speciesMoves, typeLabel, typesOf, type Species,
} from "../sim/species";
import { TYPE_COLORS } from "../sim/types";
import { speciesText } from "../game/texts";
import { speciesFace } from "./browser";
import { moveSlot, openCard, passiveSlot } from "./infocard";
import type { StarterTurn } from "../net/lobby";
import { rngFrom } from "../sim/rng";
import {
  PRONOUN_PRESETS,
  type CharacterDef,
  type SaveData,
  type SlotId,
} from "../save/save";
import type { WorldContent } from "../game/content";
import { questLog } from "../game/quests";
import { BUILD_VERSION } from "../version";
import { PROTOCOL_VERSION } from "../net/protocol";
export { freshRoomCode, normalizeRoomCode } from "../net/roomcode";
import { freshRoomCode, normalizeRoomCode } from "../net/roomcode";
import { mountInstallCard } from "./install";
import { PACES, setStagePace, stagePace } from "../game/pace";
import { crispPixels, setCrispPixels } from "../engine/crisp";
import { ART, holdUiScale, viewport } from "../engine/renderer";

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
  /** The row for each door, in the same order, so a key or a hover can find it. */
  private bagRows: HTMLButtonElement[] = [];
  /** Which row the triangle mark sits on. */
  private bagIndex = 0;
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
    // Escape is handled by the caller, which already knows whether a screen
    // or the bag itself is what should close; this only ever moves the mark
    // or confirms the door it is on.
    window.addEventListener("keydown", (e) => {
      if (!this.bagOpen()) return;
      const k = e.key;
      if (k === "ArrowDown" || k === "s" || k === "S") {
        e.preventDefault();
        this.moveBagCursor(1);
      } else if (k === "ArrowUp" || k === "w" || k === "W") {
        e.preventDefault();
        this.moveBagCursor(-1);
      } else if (k === "Enter" || k === "e" || k === "E") {
        e.preventDefault();
        this.chooseDoor(this.bagIndex);
      }
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
    this.bagRows = doors.map((door, i) => {
      const row = el("button", "doorRow", door.label);
      row.type = "button";
      // Hovering moves the mark without confirming, the way the keys do.
      row.addEventListener("mouseenter", () => {
        this.bagIndex = i;
        this.markBagCursor();
      });
      row.addEventListener("click", () => this.chooseDoor(i));
      this.bagMenu.appendChild(row);
      return row;
    });
    this.bagIndex = 0;
    this.markBagCursor();
  }

  /** Moves the highlighted row by `delta`, wrapping at either end. */
  private moveBagCursor(delta: number): void {
    if (this.bagRows.length === 0) return;
    this.bagIndex = (this.bagIndex + delta + this.bagRows.length) % this.bagRows.length;
    this.markBagCursor();
  }

  private markBagCursor(): void {
    this.bagRows.forEach((row, i) => row.classList.toggle("cur", i === this.bagIndex));
  }

  private chooseDoor(i: number): void {
    const door = this.bagDoors[i];
    if (!door) return;
    sfx.confirm();
    this.closeBag();
    door.open();
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
    // Every open starts the mark back at the top door.
    this.bagIndex = 0;
    this.markBagCursor();
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
      // Stepped, so the black lifts in six flat bands rather than a blend.
      this.fadeEl.style.transition = ms > 0 ? `opacity ${ms}ms steps(6, end)` : "none";
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
  // Leaving a screen sounds different from choosing something on it.
  const sound = label === "Back" ? sfx.back : sfx.confirm;
  b.addEventListener("click", () => {
    sound();
    onClick();
  });
  return b;
}

export function titleScreen(
  ui: UI,
  art: Art,
  opts: {
    hasSave: boolean;
    onContinue: () => void;
    onNew: () => void;
    onJoin: () => void;
    onImport: () => void;
  },
): void {
  ui.screen((s) => {
    // The name over the game's own art rather than over an empty page. The
    // Scoba the game is named for stands on a plate under the title, which is
    // the one place a player meets the art before they have chosen anything.
    const crest = el("div", "crest");
    crest.appendChild(el("h1", undefined, "Scoba Relica"));
    crest.appendChild(el("div", "sub", "A two-player Scoba adventure."));
    const plinth = el("div", "plinth");
    // Three whole art pixels to the screen pixel. A whole step only, since
    // half of one would put the sprite's outline across pixel edges.
    const face = critterPortrait(art, SPECIAL);
    face.style.width = `${face.width * 3}px`;
    face.style.height = `${face.height * 3}px`;
    plinth.appendChild(face);
    crest.appendChild(plinth);
    // The crest and the ways in stand side by side: stacked, the plate and
    // three buttons ran past the foot of the frame.
    const cols = el("div", "titleCols");
    cols.appendChild(crest);
    s.appendChild(cols);

    // One way in stands ahead of the others, so the screen has a first button
    // rather than four of equal weight. Which one it is depends on whether
    // there is anything to come back to.
    const ways = el("div", "ways");
    if (opts.hasSave) ways.appendChild(bigBtn("Continue", opts.onContinue, true));
    // The two ways in. Which one you pick decides which character you are, so
    // two people setting up separately can no longer both end up as the same
    // one and spend the evening unable to see each other.
    ways.appendChild(bigBtn("Start new adventure", opts.onNew, !opts.hasSave));
    ways.appendChild(bigBtn("Join someone's adventure", opts.onJoin));

    // A rarely used door, kept at the weight it deserves rather than at the
    // weight of the three routes into the game.
    const imp = el("button", "pill", "Import a save");
    imp.addEventListener("click", () => {
      sfx.confirm();
      opts.onImport();
    });
    ways.appendChild(imp);
    cols.appendChild(ways);
    // Small and out of the way, but on screen: a tester saying "it broke" is
    // worth much more when they can also say which build broke.
    s.appendChild(el("div", "buildTag", `v${PROTOCOL_VERSION} · ${BUILD_VERSION}`));
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

/** The stock style picker a custom-art tab stands in front of, where one exists. */
const PART_BY_SLOT: Partial<Record<PaintSlot, PartKey>> = {
  hair: "hairStyle",
  eyes: "eyeStyle",
  shirt: "shirtStyle",
};

/** Which of the creator's tabs is open: a custom-art slot or a colour channel. */
type CreatorTab = { kind: "part"; slot: PaintSlot } | { kind: "color"; index: number };

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
  const d: CharacterDef = {
    name: def.name,
    pronouns: { ...def.pronouns },
    look: { ...def.look, ...(def.look.paint ? { paint: { ...def.look.paint } } : {}) },
    starter: def.starter,
  };
  // Which tab is open, kept across a rebuild so returning from the painter
  // or picking a name does not reset it back to the first one.
  let sel: CreatorTab = { kind: "part", slot: PAINT_MENU[0]! };
  // Painting a layer takes over the screen, so coming back rebuilds this one.
  // Everything it shows lives in `d`, which outlives the rebuild; only where
  // the page had been scrolled to has to be carried over by hand.
  let scrolled = 0;

  const openPainter = (target: PaintSlot): void => {
    paintScreen({ screen: (build) => ui.screen(build) }, art.doll, d.look, target, (layer) => {
      const paint: PaintSet = { ...d.look.paint };
      if (layer) paint[target] = layer;
      else delete paint[target];
      d.look.paint = Object.keys(paint).length > 0 ? paint : undefined;
      render();
    });
  };

  const render = (): void => {
    const root = ui.screen((s) => {
      s.classList.add("tight");
      s.appendChild(el("h2", undefined, heading));
      if (note) s.appendChild(el("div", "sub", note));

      const layout = el("div", "creator");

      // Left: the doll, name and pronouns. Fixed contents, so this column
      // never changes height while the right one is switching tabs.
      const left = el("div", "creatorLeft");
      const stage = el("div", "dollWrap");
      const preview = el("canvas", "doll") as HTMLCanvasElement;
      preview.width = DOLL_W;
      preview.height = DOLL_H;
      stage.appendChild(preview);
      left.appendChild(stage);

      const idCard = el("div", "card");
      idCard.appendChild(el("label", undefined, "Name"));
      const name = el("input") as HTMLInputElement;
      name.type = "text";
      name.maxLength = 12;
      name.value = d.name;
      name.addEventListener("input", () => { d.name = name.value; });
      idCard.appendChild(name);

      idCard.appendChild(el("label", undefined, "Pronouns"));
      const pronRow = el("div", "row");
      const renderProns = (): void => {
        pronRow.innerHTML = "";
        PRONOUN_PRESETS.forEach((p) => {
          const on = d.pronouns.subject === p.subject;
          const b = el("button", `pill sm${on ? " sel" : ""}`, `${p.subject}/${p.object}`);
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
      left.appendChild(idCard);
      layout.appendChild(left);

      // Right: one row of tabs, custom art and stock parts first and then
      // the colour channels, and under it the grid the open tab owns. The
      // grid holds its height across every tab so nothing below it moves.
      const right = el("div", "creatorRight");
      const tabs = el("div", "creatorTabs");
      const partTabs = el("div", "choices");
      const colorTabs = el("div", "choices wide");
      tabs.appendChild(partTabs);
      tabs.appendChild(colorTabs);
      right.appendChild(tabs);
      const detail = el("div", "creatorGrid");
      right.appendChild(detail);
      layout.appendChild(right);
      s.appendChild(layout);

      let dots: HTMLElement[] = [];

      const renderTabs = (): void => {
        partTabs.innerHTML = "";
        for (const slot of PAINT_MENU) {
          const on = sel.kind === "part" && sel.slot === slot;
          const b = el("button", `pill${on ? " sel" : ""}`, SLOT_INFO[slot].label);
          b.addEventListener("click", () => {
            sfx.tap();
            sel = { kind: "part", slot };
            renderTabs();
            renderDetail();
          });
          partTabs.appendChild(b);
        }

        colorTabs.innerHTML = "";
        dots = [];
        CHANNELS.forEach((c, i) => {
          const on = sel.kind === "color" && sel.index === i;
          const b = el("button", `pill chan${on ? " sel" : ""}`);
          const dot = el("i");
          dot.style.background = d.look[c.key];
          b.appendChild(dot);
          b.appendChild(el("span", undefined, c.label));
          b.addEventListener("click", () => {
            sfx.tap();
            sel = { kind: "color", index: i };
            renderTabs();
            renderDetail();
          });
          dots.push(dot);
          colorTabs.appendChild(b);
        });
      };

      const syncDots = (): void => {
        CHANNELS.forEach((c, i) => { dots[i]!.style.background = d.look[c.key]; });
      };

      const renderDetail = (): void => {
        detail.innerHTML = "";

        if (sel.kind === "color") {
          const ch = CHANNELS[sel.index]!;
          const cur = d.look[ch.key].toLowerCase();
          const grid = el("div", "swatches");
          const swatches: { el: HTMLElement; color: string }[] = [];
          for (const color of ch.colors) {
            const b = el("button", `swatch${color.toLowerCase() === cur ? " sel" : ""}`);
            b.style.setProperty("--fill", color);
            b.addEventListener("click", () => {
              sfx.tap();
              d.look[ch.key] = color;
              redrawArt();
            });
            swatches.push({ el: b, color });
            grid.appendChild(b);
          }
          detail.appendChild(grid);

          const custom = el("label", "custom");
          const well = el("input") as HTMLInputElement;
          well.type = "color";
          well.value = d.look[ch.key];
          // Dragging in the OS picker fires input continuously, so this
          // handler must not rebuild the card the well lives in.
          well.addEventListener("input", () => {
            d.look[ch.key] = well.value;
            const ctx = preview.getContext("2d")!;
            ctx.clearRect(0, 0, DOLL_W, DOLL_H);
            drawPaperdoll(ctx, art.doll, d.look);
            syncDots();
            const now = well.value.toLowerCase();
            for (const sw of swatches) sw.el.classList.toggle("sel", sw.color.toLowerCase() === now);
          });
          custom.appendChild(well);
          custom.appendChild(el("span", undefined, `Custom ${ch.label.toLowerCase()}`));
          detail.appendChild(custom);
          return;
        }

        const paintSlot = sel.slot;
        const partKey = PART_BY_SLOT[paintSlot];
        const part = partKey ? PARTS.find((p) => p.key === partKey) : undefined;
        // Hand-drawn eyes replace the stock pair outright, so a row of
        // options that nothing on the doll would show would be a lie.
        const eyesCustom = paintSlot === "eyes" && hasPaint(d.look.paint, "eyes");

        if (part && !eyesCustom) {
          const row = el("div", "thumbs");
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
          detail.appendChild(row);
        } else {
          detail.appendChild(el("div", "dim", eyesCustom ? "Custom eyes are on." : SLOT_INFO[paintSlot].hint));
        }

        const artBtn = el("button", `pill${hasPaint(d.look.paint, paintSlot) ? " sel" : ""}`, "Draw your own");
        artBtn.addEventListener("click", () => {
          sfx.tap();
          scrolled = root.scrollTop;
          openPainter(paintSlot);
        });
        detail.appendChild(artBtn);
      };

      const redrawArt = (): void => {
        const ctx = preview.getContext("2d")!;
        ctx.clearRect(0, 0, DOLL_W, DOLL_H);
        drawPaperdoll(ctx, art.doll, d.look);
        syncDots();
        renderDetail();
      };

      renderTabs();
      redrawArt();

      s.appendChild(
        bigBtn("Next", () => {
          d.name = name.value.trim() || DEFAULTS[slot].name;
          onDone(d);
        }, true),
      );
    });
    // Reading the height forces the layout the scroll would otherwise be
    // clamped against, so a return from the painter lands where it left.
    void root.scrollHeight;
    root.scrollTop = scrolled;
  };

  render();
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
  /**
   * Setting up together, where character A picks first, so B arrives here
   * before their turn. They can read about all five while they wait; the
   * button only comes alive once A's choice has landed.
   */
  gate?: () => StarterTurn,
): void {
  let chosen: string | null = null;
  let locked = taken;
  let myTurn = true;
  let waitingOn: string | null = null;
  let theyLeft = false;

  const readGate = (): void => {
    if (!gate) return;
    const t = gate();
    myTurn = t.yours;
    waitingOn = t.who;
    theyLeft = !t.here;
    if (t.taken) locked = { id: t.taken, by: t.who ?? "The other player" };
  };
  readGate();

  ui.screen((s) => {
    s.classList.add("tight");
    const heading = el("h2");
    const sub = el("div", "sub");
    s.appendChild(heading);
    s.appendChild(sub);

    const top = el("div", "starterTop");
    const grid = el("div", "starters");
    const detail = el("div", "card pick");

    /**
     * Debug: start with any line on the roster rather than one of the nine.
     * Typing filters by name, and picking one selects it the same way tapping
     * a face does, so the button under it reads and behaves the same.
     */
    const search = el("div", "dbgSearch");
    const field = document.createElement("input");
    field.type = "search";
    field.className = "dbgField";
    field.placeholder = "Debug: search every Scoba";
    field.autocomplete = "off";
    const hits = el("div", "dbgHits");
    search.appendChild(field);
    search.appendChild(hits);

    const renderHits = (): void => {
      hits.innerHTML = "";
      const q = field.value.trim().toLowerCase();
      if (q === "") return;
      const found = rosterSpecies()
        .filter((sp) => sp.name.toLowerCase().includes(q) || sp.id.includes(q))
        .slice(0, 8);
      if (found.length === 0) {
        hits.appendChild(el("div", "dim", "Nothing by that name."));
        return;
      }
      for (const sp of found) {
        const taken = locked?.id === sp.id;
        const b = el("button", `dbgHit${chosen === sp.id ? " sel" : ""}`);
        b.appendChild(el("span", undefined, sp.name));
        b.appendChild(el("span", "sub", taken ? "taken" : typeLabel(sp)));
        (b as HTMLButtonElement).disabled = taken || !myTurn;
        b.addEventListener("click", () => {
          sfx.tap();
          chosen = sp.id;
          renderGrid();
          renderDetail();
          renderState();
          renderHits();
        });
        hits.appendChild(b);
      }
    };
    field.addEventListener("input", renderHits);
    const confirm = bigBtn("Choose", () => {
      if (chosen && myTurn) onPick(chosen);
    }, true);

    const renderDetail = (): void => {
      detail.innerHTML = "";
      if (!chosen) {
        detail.appendChild(el("div", "sub", "Tap one to see what it is."));
        return;
      }
      const sp = SPECIES[chosen]!;
      const stage = el("div", "pickStage");
      const face = critterPortrait(art, sp);
      face.style.width = `${face.width * 2}px`;
      face.style.height = `${face.height * 2}px`;
      stage.appendChild(face);
      detail.appendChild(stage);
      detail.appendChild(el("div", "pickName", sp.name));
      detail.appendChild(typeBadge(sp.id));
    };

    const renderGrid = (): void => {
      grid.innerHTML = "";
      for (const id of STARTER_IDS) {
        const sp = SPECIES[id]!;
        const isTaken = locked?.id === id;
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
          renderGrid();
          renderDetail();
          renderState();
        });
        grid.appendChild(b);
      }
    };

    /** Heading, note and button, all of which change when their turn ends. */
    const renderState = (): void => {
      const them = waitingOn ?? "the other player";
      heading.textContent = myTurn
        ? `${who.name}, pick a Scoba.`
        : `${who.name}, hold on a moment.`;
      sub.textContent = !myTurn
        ? `You are picking second, so ${them} chooses first.` + (theyLeft
          ? " They have dropped out for a moment."
          : " Have a look at the lot while you wait.")
        : locked
          ? `${locked.by} took ${SPECIES[locked.id]!.name}. Everyone else is fair game.`
          : "One for each primary type. Your partner picks from the rest.";
      confirm.disabled = !myTurn || !chosen;
      confirm.textContent = !myTurn
        ? `Waiting for ${them}...`
        : chosen
          ? `Choose ${SPECIES[chosen]!.name}`
          : "Choose";
    };

    renderGrid();
    renderDetail();
    renderState();
    top.appendChild(grid);
    top.appendChild(search);
    s.appendChild(top);
    s.appendChild(detail);
    s.appendChild(confirm);

    if (gate && !myTurn) {
      // Nothing tells this screen that the other player has chosen, so while
      // it is waiting it keeps looking.
      const watch = window.setInterval(() => {
        if (!grid.isConnected) {
          clearInterval(watch);
          return;
        }
        const was = myTurn;
        readGate();
        if (locked && chosen === locked.id) chosen = null;
        renderGrid();
        renderDetail();
        renderState();
        if (myTurn && !was) {
          clearInterval(watch);
          sfx.confirm();
          ui.toast(locked
            ? `${locked.by} took ${SPECIES[locked.id]!.name}. Your turn.`
            : "Your turn.");
        }
      }, 400);
    }
  });
}

/**
 * Starting your own adventure. You are character A and you host: the code is
 * minted here and stays with the save, so a friend can join at any point
 * without either of you setting anything up again.
 *
 * `withFriend` opens a waiting room first and does the character making with
 * both of you connected, so you walk into the world at the same moment. Alone,
 * you make both characters yourself as before, and somebody can still join
 * later; they simply arrive after the beginning.
 */
/**
 * The two steps of making a character, exposed so setting up with somebody can
 * drive them and report progress between each one.
 */
export function makeCharacterFlow(
  ui: UI,
  art: Art,
  slot: SlotId,
  turn: () => StarterTurn,
  onNamed: (p: { name: string; look: unknown; starter: string }) => void,
  onDone: (p: { name: string; look: unknown; starter: string }) => void,
): void {
  customizeScreen(ui, art, slot, DEFAULTS[slot], `Your character (${slot})`, null, (def) => {
    onNamed({ name: def.name, look: def.look, starter: "" });
    // Both make their character at once, because nothing about that clashes.
    // Only the Scoba is taken in turn, and the screen holds the second player
    // there until the first has chosen.
    starterScreen(ui, art, def, null, (starter) => {
      def.starter = starter;
      onDone({ name: def.name, look: def.look, starter });
    }, turn);
  });
}

export function newGameFlow(
  ui: UI,
  art: Art,
  onStart: (save: SaveData) => void,
  opts?: { onWaitForFriend?: (code: string) => void },
): void {
  if (opts?.onWaitForFriend) {
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, "Who is playing?"));
      s.appendChild(el("div", "sub", "Two of you share one story, one Relica and one world."));
      s.appendChild(bigBtn("With a friend", () => {
        // Together means waiting for them before anyone makes anybody, so the
        // start of the story happens to both of you at once.
        opts.onWaitForFriend!(freshRoomCode());
      }, true));
      s.appendChild(bigBtn("On my own for now", () => pickSlot("A")));
      s.appendChild(el("div", "dim",
        "On your own, you make both characters and a friend can still join later."));
    });
    return;
  }
  pickSlot("A");

  function pickSlot(localSlot: SlotId): void {
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
              const save = buildSave(localSlot, localDef, otherDef);
              // Hosting from the moment it exists, so "Connect" later is just
              // reading the code out rather than setting anything up.
              save.room = freshRoomCode();
              onStart(save);
            });
          });
        },
      );
    });
  }
}

/**
 * Joining somebody else's adventure. You are character B, and the world you
 * walk into is theirs: the seed comes over the wire before anything is built,
 * because a save made with its own seed would be a different map wearing the
 * same name.
 */
export function joinGameFlow(
  ui: UI,
  art: Art,
  deps: {
    /** Where to go when the host is still setting up and wants you in the lobby. */
    onLobby?: (room: string) => void;
    knock: (room: string) => Promise<{
      ok: boolean;
      adventure?: { worldSeed: string; host: { name: string; look: unknown; starter: string } };
      failure?: string;
      reason?: string;
    }>;
    onBack: () => void;
    onStart: (save: SaveData) => void;
  },
): void {
  ui.screen((s) => {
    s.appendChild(el("h2", undefined, "Join someone's adventure"));
    s.appendChild(el("div", "sub", "Ask them for the code on their Connect screen."));

    const card = el("div", "card");
    const field = el("input") as HTMLInputElement;
    field.type = "text";
    field.placeholder = "Their code";
    field.maxLength = 7;
    field.autocapitalize = "characters";
    field.spellcheck = false;
    card.appendChild(field);

    const note = el("div", "dim", "They need to have the game open.");
    card.appendChild(note);
    s.appendChild(card);

    const go = bigBtn("Knock", () => {
      const code = normalizeRoomCode(field.value);
      if (!code) {
        sfx.back();
        ui.toast("A code is six letters and numbers.");
        return;
      }
      go.disabled = true;
      note.textContent = "Knocking...";
      void deps.knock(code).then((res) => {
        // Their adventure has not started yet: they are sitting in the waiting
        // room. Join them there and make characters together rather than
        // arriving into a world that does not exist.
        if (res.failure === "setting-up" && deps.onLobby) {
          deps.onLobby(code);
          return;
        }
        if (!res.ok || !res.adventure) {
          go.disabled = false;
          note.textContent = res.failure === "nobody-there"
            ? "Nobody is in that room. Check the code, and that they have the game open."
            : res.reason ?? "No answer. Check the code and try again.";
          sfx.back();
          return;
        }
        // Their world, their character. Only ours is still to make.
        const theirs: CharacterDef = {
          ...DEFAULTS.A,
          name: res.adventure.host.name,
          look: sanitizeDollLook(res.adventure.host.look),
          starter: res.adventure.host.starter,
        };
        customizeScreen(ui, art, "B", DEFAULTS.B, "Your character (B)", null, (mine) => {
          starterScreen(ui, art, mine, { id: theirs.starter, by: theirs.name }, (starter) => {
            mine.starter = starter;
            const save = buildSave("B", mine, theirs);
            save.worldSeed = res.adventure!.worldSeed;
            save.room = code;
            // Bound from the start: there is somebody on the other end, and
            // the save knows who without anyone typing a code again.
            save.partnerJoined = true;
            deps.onStart(save);
          });
        });
      });
    }, true);
    s.appendChild(go);
    s.appendChild(bigBtn("Back", deps.onBack));
  });
}

/**
 * A save for two people who set the adventure up together. Both build one from
 * the same seed at the same moment, so they start the story side by side.
 */
export function buildJoinedSave(
  mine: SlotId,
  worldSeed: string,
  mineProfile: { name: string; look: unknown; starter: string },
  theirProfile: { name: string; look: unknown; starter: string },
  room: string,
): SaveData {
  const other: SlotId = mine === "A" ? "B" : "A";
  const asDef = (p: { name: string; look: unknown; starter: string }, slot: SlotId): CharacterDef => ({
    ...DEFAULTS[slot],
    name: p.name,
    // One of these two came off the wire, and neither knows which.
    look: sanitizeDollLook(p.look),
    starter: p.starter,
  });
  const save = buildSave(mine, asDef(mineProfile, mine), asDef(theirProfile, other));
  save.worldSeed = worldSeed;
  save.room = room;
  // They are already standing next to you; there is nobody to wait for.
  save.partnerJoined = true;
  // The starters were rolled against the old seed, so they are rolled again
  // against the shared one or the two saves would hold different Scobas.
  const mineScoba = makeWild(mineProfile.starter, 5, rngFrom(`${worldSeed}:starter:${mine}`));
  mineScoba.owner = mine;
  const theirScoba = makeWild(theirProfile.starter, 5, rngFrom(`${worldSeed}:starter:${other}`));
  theirScoba.owner = other;
  save.party = mine === "A" ? [mineScoba, theirScoba] : [theirScoba, mineScoba];
  return save;
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
    version: 15,
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
    s.classList.add("tight");
    s.appendChild(el("h2", undefined, "Relica"));
    const cols = el("div", "relicaCols");
    const card = el("div", "card");
    const render = (): void => {
      card.innerHTML = "";
      const c = save.special;
      const head = el("div", "cardHead");
      head.appendChild(el("strong", undefined, `${SPECIAL.name} · care lv ${careLevel(c)}`));
      if (c.hibernating) head.appendChild(el("span", "badge warn", "hibernating"));
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
    cols.appendChild(card);

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
      cols.appendChild(remind);
      refresh();
    }

    s.appendChild(cols);
    s.appendChild(bigBtn("Back", cb.onBack, true));
  });
}

/**
 * The index: every Scoba there is, as a grid of cells, and how much of each one
 * you have met. Keeping one tells you everything; having only run into it gives
 * you its face and its name but not its numbers; the rest are blanks, so the
 * grid reads as a set with gaps in it rather than as a list of what you have.
 */
export function indexScreen(
  ui: UI, art: Art, save: SaveData, onBack: () => void, picked: string | null = null,
): void {
  // A hybrid shows as a species of its own and is not in the index, so keeping
  // one does not count as keeping its mother's species.
  const owned = new Set([...save.party, ...save.box].filter((s2) => !s2.hybrid).map((s2) => s2.speciesId));
  const seen = new Set([...(save.seen ?? []), ...owned]);
  const all = rosterSpecies();
  const number = (i: number): string => `No. ${String(i + 1).padStart(3, "0")}`;
  let pick = picked;

  ui.screen((s) => {
    s.classList.add("tight");
    s.appendChild(el("h2", undefined, "Index"));
    s.appendChild(el("div", "sub", `${owned.size} kept · ${seen.size} met · ${all.length} in all`));
    const wrap = el("div", "ixBrowser");

    const panel = el("div", "bxPanel ixGridPanel");
    const grid = el("div", "bxGrid");
    panel.appendChild(grid);
    wrap.appendChild(panel);

    const side = el("div", "bxPanel ixSide");
    const stage = el("div", "bxPortrait ixStage");
    side.appendChild(stage);
    const read = el("div", "ixRead");
    side.appendChild(read);
    const ops = el("div", "bxPair");
    const info = el("button", "bxWide", "Info");
    const back = el("button", "bxWide", "Back");
    ops.append(info, back);
    side.appendChild(ops);
    wrap.appendChild(side);

    // Words and badges only, in a box that holds its height, the same as the
    // Box's readout: the picked face is already lit in the grid.
    const fillRead = (): void => {
      read.innerHTML = "";
      stage.innerHTML = "";
      const at = all.findIndex((sp) => sp.id === pick);
      const sp = all[at];
      info.disabled = !sp || !seen.has(sp.id);
      if (!sp) {
        read.appendChild(el("div", "dim", "Pick a face to read it."));
        return;
      }
      const met = seen.has(sp.id);
      stage.appendChild(met ? speciesFace(art, sp) : el("span", "ixQ", "?"));
      read.appendChild(el("div", "dim", number(at)));
      read.appendChild(el("div", "ixReadName", met ? sp.name : "??????"));
      const kinds = el("div", "ixReadKinds");
      if (met) kinds.appendChild(typeIcons(sp));
      read.appendChild(kinds);
      read.appendChild(el("div", "dim", owned.has(sp.id) ? "Kept" : met ? "Met in the wild" : "Not met yet"));
    };

    all.forEach((sp, i) => {
      const met = seen.has(sp.id);
      const cell = el("button", `bxCell ixCell${met ? "" : " blank"}${owned.has(sp.id) ? " kept" : ""}${sp.id === pick ? " sel" : ""}`);
      cell.title = met ? sp.name : "Not met yet";
      cell.appendChild(el("span", "ixNo", String(i + 1).padStart(3, "0")));
      cell.appendChild(met ? speciesFace(art, sp) : el("span", "ixQ", "?"));
      cell.addEventListener("click", () => {
        sfx.tap();
        pick = sp.id;
        for (const c of grid.children) c.classList.toggle("sel", c === cell);
        fillRead();
      });
      grid.appendChild(cell);
    });

    info.addEventListener("click", () => {
      const at = all.findIndex((sp) => sp.id === pick);
      const sp = all[at];
      if (!sp || !seen.has(sp.id)) return;
      sfx.tap();
      speciesCard(ui, art, sp, number(at), owned.has(sp.id), () => indexScreen(ui, art, save, onBack, sp.id));
    });
    back.addEventListener("click", () => {
      sfx.back();
      onBack();
    });

    fillRead();
    s.appendChild(wrap);
  });
}

/**
 * A line's card in the index. Its stats are a plain one at the level ceiling,
 * with no hobby, tea or passive, drawn darker than a Scoba's own so the shape
 * reads as what the line is rather than as one you have. A line only met in
 * the wild keeps its numbers hidden, as the index always has, until one is kept.
 */
function speciesCard(ui: UI, art: Art, sp: Species, no: string, kept: boolean, onBack: () => void): void {
  const plain: ScobaInstance = {
    uid: "", speciesId: sp.id, level: MAX_LEVEL, xp: 0, genes: { ...sp.genes },
    moves: [], secondaryAbility: "", hp: 0,
  };
  const stats = statsAt(plain, false);
  const types = typesOf(sp);
  const pool = sp.secondaryPool;
  openCard(ui, {
    face: speciesFace(art, sp),
    name: sp.name,
    tag: no,
    kinds: [typeIcons(sp), el("span", "dim", kept ? "Kept" : "Met in the wild")],
    bio: speciesText(sp),
    hex: { stats, color: TYPE_COLORS[types[0] ?? sp.type], look: kept ? "dim" : "hidden" },
    passives: [
      ...passiveSlot(sp.primaryAbility),
      // Every one of the line rolls its second passive from here.
      ...pool.flatMap((id) => passiveSlot(id, pool.length > 1 ? `one of ${pool.length}` : "passive")),
    ],
    moves: speciesMoves(sp).flatMap((id) => {
      const move = MOVES[id];
      return move ? [moveSlot(move, move.manaCost)] : [];
    }),
    hint: kept
      ? `The shape is a ${sp.name} at level ${MAX_LEVEL}, with no hobby, tea or passive. Pick a passive or a move to read it.`
      : "Keep one to read its numbers. Pick a passive or a move to read it.",
    // Without stats a damage line says what it scales with instead of a
    // number, which is what keeps an unkept line's numbers hidden in its moves.
    prose: kept ? { stats, level: MAX_LEVEL, types } : { types },
    onBack,
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

    const reading = (room: string | undefined): string => {
      if (!room) return "Two players share one campaign. One hosts, the other joins with the code.";
      // Read fresh every time. Capturing it once meant the line said
      // "Connecting." for as long as the screen was open, whatever the
      // connection was actually doing, which reads as a hang.
      const link = cb.relay();
      if (link.status === "live") {
        return link.partnerHere
          ? `Room ${room}. The other player is here.`
          : `Room ${room}. Connected, waiting on the other player.`;
      }
      if (link.status === "connecting") return `Room ${room}. Connecting...`;
      return `Room ${room}. Not connected.`;
    };
    const status = el("div", "sub", reading(save.room));
    s.appendChild(status);

    // Connecting, and the other player arriving, both happen while this screen
    // is up and neither of them is something the screen asks for, so it keeps
    // looking rather than waiting to be told. It stops as soon as the screen
    // is gone.
    const watch = window.setInterval(() => {
      if (!status.isConnected) {
        clearInterval(watch);
        return;
      }
      const now = reading(save.room);
      if (status.textContent !== now) status.textContent = now;
    }, 400);

    const partnerName = save.characters[save.localSlot === "A" ? "B" : "A"].name;
    const host = save.localSlot === "A";

    const card = el("div", "card");
    card.appendChild(el("strong", undefined, host ? "Your code" : "Their code"));
    const codeOut = el("div", "code", save.room ?? "------");
    card.appendChild(codeOut);
    card.appendChild(el("div", "dim", host
      ? `Read this out to ${partnerName} so they can join your adventure.`
      : `You joined ${partnerName}'s adventure with this code.`));
    s.appendChild(card);

    // No code entry any more. Which adventure this save belongs to was settled
    // when it was made, and which character you are came with it, so two
    // players can no longer both pick the same one and never see each other.
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

/** Supplied by main so this file stays clear of the relay and push code. */
export interface DiagnosticsControl {
  read(): Promise<{ label: string; value: string; ok: boolean }[]>;
  asText(lines: { label: string; value: string }[]): string;
}

export function settingsScreen(
  ui: UI,
  save: SaveData,
  cb: {
    onBack: () => void;
    onExport: () => void;
    onQuit: () => void;
    onEzChange: () => void;
    diagnostics?: DiagnosticsControl;
  },
): void {
  ui.screen((s) => {
    s.classList.add("tight");
    s.appendChild(el("h2", undefined, "Settings"));

    const grid = el("div", "settingsGrid");

    const audio = el("div", "card");
    audio.appendChild(el("strong", undefined, "Sound"));
    audio.appendChild(levelBar("Sound", sfx.volume(), (v) => {
      sfx.setVolume(v);
      // A blip on the way past, so the bar is heard as well as seen.
      sfx.tap();
    }));
    audio.appendChild(levelBar("Music", sfx.musicVolume(), (v) => sfx.setMusicVolume(v)));
    audio.appendChild(el("div", "dim", "Music has no track yet. This bar is ready for it."));
    grid.appendChild(audio);

    const play = el("div", "card");
    play.appendChild(el("strong", undefined, "Playing"));
    // Speed and EZ mode are both a matter of taste rather than of the
    // campaign, so both live in one row of controls kept on the machine.
    const playRow = el("div", "row");
    const paceRow = el("div", "row");
    const renderPace = (): void => {
      paceRow.innerHTML = "";
      for (const [name, value] of Object.entries(PACES)) {
        const sel = Math.abs(stagePace() - value) < 0.01;
        const b = el("button", `pill${sel ? " sel" : ""}`, name === "fast" ? "Fast" : "Normal");
        b.addEventListener("click", () => {
          sfx.tap();
          setStagePace(value);
          renderPace();
        });
        paceRow.appendChild(b);
      }
    };
    renderPace();
    playRow.appendChild(paceRow);
    const ezB = el("button", "pill", save.ez ? "EZ Mode on" : "EZ Mode off");
    ezB.addEventListener("click", () => {
      sfx.confirm();
      save.ez = !save.ez;
      ezB.textContent = save.ez ? "EZ Mode on" : "EZ Mode off";
      cb.onEzChange();
    });
    playRow.appendChild(ezB);
    play.appendChild(playRow);
    play.appendChild(el("div", "dim", "Fast doubles the pace of every hit, walk and call."));
    play.appendChild(el("div", "dim",
      "Every level counts as 4 to each stat in battle. Wild Scobas and trainers are left alone."));
    grid.appendChild(play);

    const look = el("div", "card");
    look.appendChild(el("strong", undefined, "Picture"));
    const lookRow = el("div", "row");
    const crispB = el("button", "pill", crispPixels() ? "Sharp pixels" : "Fill the window");
    crispB.addEventListener("click", () => {
      sfx.confirm();
      setCrispPixels(!crispPixels());
      crispB.textContent = crispPixels() ? "Sharp pixels" : "Fill the window";
      // The frame is measured on the next resize, so it is asked for one.
      holdUiScale();
      window.dispatchEvent(new Event("resize"));
    });
    lookRow.appendChild(crispB);
    look.appendChild(lookRow);
    look.appendChild(el("div", "dim",
      "Sharp holds the game to whole pixels, which can leave a border round it."
      + " Filling uses the whole window and softens the art and the writing."));
    // What the window is actually getting. Whether writing can be sharp at all
    // is a number, and without it on the screen it is a matter of opinion.
    const reading = el("div", "dim");
    const readScale = (): void => {
      const v = viewport();
      const per = v.k / ART;
      const whole = Number.isInteger(per);
      reading.textContent = whole
        ? `${per} screen pixels to each drawn pixel. Sharp.`
        : `${per.toFixed(2)} screen pixels to each drawn pixel, so everything is resampled.`
          + (per < 1
            ? " The window is smaller than the game is drawn, which is the one case sharp cannot help."
            : " A larger window reaches the next whole step.");
    };
    readScale();
    look.appendChild(reading);
    crispB.addEventListener("click", () => readScale());
    window.addEventListener("resize", readScale);
    grid.appendChild(look);

    const saveCard = el("div", "card");
    const saveHead = el("div", "cardHead");
    saveHead.appendChild(el("strong", undefined, "This save"));
    const exportB = el("button", "pill tiny", "Export a copy");
    exportB.addEventListener("click", () => {
      sfx.confirm();
      cb.onExport();
    });
    saveHead.appendChild(exportB);
    saveCard.appendChild(saveHead);
    saveCard.appendChild(el("div", "dim", "The game saves itself. Export keeps a copy for you."));
    grid.appendChild(saveCard);

    if (cb.diagnostics) {
      const control = cb.diagnostics;
      const diag = el("div", "card diag");
      const diagHead = el("div", "cardHead");
      diagHead.appendChild(el("strong", undefined, "Diagnostics"));
      const copyB = el("button", "pill tiny", "Copy");
      diagHead.appendChild(copyB);
      const refreshB = el("button", "pill tiny", "Refresh");
      diagHead.appendChild(refreshB);
      diag.appendChild(diagHead);
      diag.appendChild(el("div", "dim", "Screenshot this if something is not working."));
      const rows = el("div", "diagRows");
      rows.appendChild(el("div", "dim", "Reading..."));
      diag.appendChild(rows);

      let latest: { label: string; value: string; ok: boolean }[] = [];
      const fill = (): void => {
        void control.read().then((lines) => {
          if (!diag.isConnected) return;
          latest = lines;
          rows.innerHTML = "";
          for (const line of lines) {
            const row = el("div", `diagRow${line.ok ? "" : " bad"}`);
            row.appendChild(el("span", "diagName", line.label));
            row.appendChild(el("span", "diagVal", line.value));
            rows.appendChild(row);
          }
        });
      };
      copyB.addEventListener("click", () => {
        sfx.tap();
        const text = control.asText(latest);
        // Clipboard access is refused often enough on phones that the fallback
        // matters: the text goes on screen to be selected by hand instead.
        void navigator.clipboard?.writeText(text).then(
          () => ui.toast("Copied."),
          () => ui.toast("Could not copy. Screenshot it instead."),
        );
      });
      refreshB.addEventListener("click", () => {
        sfx.tap();
        fill();
      });
      grid.appendChild(diag);
      fill();
    }

    s.appendChild(grid);

    const ways = el("div", "settingsWays");
    ways.appendChild(bigBtn("Back", cb.onBack, true));
    const quit = el("button", "big", "Quit to Title");
    quit.addEventListener("click", () => {
      sfx.back();
      cb.onQuit();
    });
    ways.appendChild(quit);
    s.appendChild(ways);
  });
}
