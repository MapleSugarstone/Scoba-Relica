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
import { makeWild, moveCost, statsAt, maxHp } from "../sim/scoba";
import { critterPortrait } from "../game/critters";
import { typeIcons } from "./typeicon";
import { ABILITIES, MOVES, SPECIAL, SPECIES, STARTER_IDS, rosterSpecies } from "../sim/species";
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
    s.appendChild(crest);

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
    s.appendChild(ways);

    // A rarely used door, kept at the weight it deserves rather than at the
    // weight of the three routes into the game.
    const imp = el("button", "pill", "Import a save");
    imp.addEventListener("click", () => {
      sfx.confirm();
      opts.onImport();
    });
    s.appendChild(imp);
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
  let channel = 0;
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
      name.addEventListener("input", () => { d.name = name.value; });
      idCard.appendChild(name);

      idCard.appendChild(el("label", undefined, "Pronouns"));
      const pronRow = el("div", "choices");
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
        // Hand-drawn eyes replace the stock pair outright, so a row of options
        // that nothing on the doll would show would be a lie.
        if (part.key === "eyeStyle" && hasPaint(d.look.paint, "eyes")) {
          partsCard.appendChild(el("div", "dim", "Custom eyes are on."));
          continue;
        }
        const row = el("div", "thumbs");
        partsCard.appendChild(row);
        const renderRow = (): void => {
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
        partRows.push(renderRow);
      }
      s.appendChild(partsCard);

      const artCard = el("div", "card");
      artCard.appendChild(el("label", undefined, "Custom art"));
      const artRow = el("div", "choices");
      for (const target of PAINT_MENU) {
        const b = el("button", `pill${hasPaint(d.look.paint, target) ? " sel" : ""}`,
          SLOT_INFO[target].label);
        b.addEventListener("click", () => {
          sfx.tap();
          scrolled = root.scrollTop;
          openPainter(target);
        });
        artRow.appendChild(b);
      }
      artCard.appendChild(artRow);
      artCard.appendChild(el("div", "dim", "Draw your own pixels on any of these."));
      s.appendChild(artCard);

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

        const tabs = el("div", "choices wide");
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
    const heading = el("h2");
    const sub = el("div", "sub");
    s.appendChild(heading);
    s.appendChild(sub);

    const grid = el("div", "starters");
    const detail = el("div", "card");
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
    s.appendChild(grid);
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
    const list = el("div", "ixList");
    all.forEach((sp, i) => {
      const met = seen.has(sp.id);
      const kept = owned.has(sp.id);
      // Every entry keeps its number and its cell whether or not it has been
      // met, so the list reads as a set with gaps in it rather than as a short
      // list of what you happen to have.
      const row = el("div", `ixRow${met ? "" : " blank"}`);
      row.appendChild(el("div", "ixNo", String(i + 1).padStart(3, "0")));
      const face = el("div", "ixFace sunk");
      if (met) face.appendChild(critterPortrait(art, sp));
      else face.appendChild(el("span", "ixQ", "?"));
      row.appendChild(face);

      const body = el("div", "ixBody");
      const name = el("div", "ixName");
      name.appendChild(el("span", "ixWho", met ? sp.name : "??????"));
      if (met) name.appendChild(typeIcons(sp));
      body.appendChild(name);
      body.appendChild(el("div", "ixLine", !met
        ? "Not met yet."
        : kept
          ? `Str ${sp.genes.str} · Def ${sp.genes.def} · Res ${sp.genes.res} · Mag ${sp.genes.mag} · Spd ${sp.genes.spd}`
          : "Met in the wild. Keep one to read its numbers."));
      row.appendChild(body);
      // The mark holds its cell empty, so no row is a different height from
      // its neighbours and the column of faces stays a column.
      const mark = el("div", "ixMark");
      if (kept) mark.appendChild(el("span", "badge", "kept"));
      row.appendChild(mark);
      list.appendChild(row);
    });
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

    if (cb.diagnostics) {
      const control = cb.diagnostics;
      const diag = el("div", "card diag");
      diag.appendChild(el("strong", undefined, "Diagnostics"));
      diag.appendChild(el("div", "dim",
        "If something is not working, screenshot this and send it over."));
      const rows = el("div", "diagRows");
      rows.appendChild(el("div", "dim", "Reading..."));
      diag.appendChild(rows);

      const copyRow = el("div", "row");
      const copyB = el("button", "pill", "Copy as text");
      copyRow.appendChild(copyB);
      const refreshB = el("button", "pill", "Refresh");
      copyRow.appendChild(refreshB);
      diag.appendChild(copyRow);

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
      s.appendChild(diag);
      fill();
    }

    s.appendChild(bigBtn("Back", cb.onBack, true));
    const quit = el("button", "big", "Quit to Title");
    quit.addEventListener("click", () => {
      sfx.back();
      cb.onQuit();
    });
    s.appendChild(quit);
  });
}
