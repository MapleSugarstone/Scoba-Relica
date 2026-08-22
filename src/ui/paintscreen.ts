// Drawing your own pixels onto one layer of the character.
//
// The doll is shown whole so a stroke is judged against the character rather
// than against an empty square: everything below the layer being worked on
// draws at full strength, everything above it fades back, and the layer itself
// sits between them exactly where it will end up.
import { sfx } from "../engine/sfx";
import {
  DOLL_H,
  DOLL_W,
  drawPaperdoll,
  paintRegion,
  type PaperdollArt,
} from "../engine/paperdoll";
import {
  PAINT_COLORS,
  PaintGrid,
  paintPixels,
  type BrushSize,
  type PaintLayer,
  type PaintSlot,
} from "../engine/paint";
import type { Look } from "../engine/recolor";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * The order the creator offers them in, which runs down the character rather
 * than up the stack the way the compositor needs them.
 */
export const PAINT_MENU: PaintSlot[] = ["face", "eyes", "hair", "shirt", "extras"];

/** How each layer reads on its own screen, and what it is allowed to cover. */
export const SLOT_INFO: Record<PaintSlot, { label: string; hint: string; missing: string }> = {
  face: {
    label: "Face",
    hint: "Paint over the skin. The outline stays where it is.",
    missing: "There is no skin to paint on.",
  },
  eyes: {
    label: "Eyes",
    hint: "Draw your own eyes. They take the place of the stock pair, over the face.",
    missing: "There is nowhere to draw.",
  },
  hair: {
    label: "Hair",
    hint: "Paint over the hair's colour. The outline stays where it is.",
    missing: "No hair to paint on. Pick a hairstyle first, then come back.",
  },
  shirt: {
    label: "Shirt",
    hint: "Paint over the shirt and its trim. The outline stays where it is.",
    missing: "There is no shirt to paint on.",
  },
  extras: {
    label: "Accessories",
    hint: "Anywhere you like, over everything else.",
    missing: "There is nowhere to draw.",
  },
};

export interface PaintScreenDeps {
  screen(build: (root: HTMLElement) => void): HTMLElement;
}

/** Strokes you can take back. Each one is a copy of the whole layer. */
const UNDO_STEPS = 24;

/** Layers stacked above the one being worked on, so you can see under them. */
const FADE = 0.3;

export function paintScreen(
  deps: PaintScreenDeps,
  art: PaperdollArt,
  look: Look,
  slot: PaintSlot,
  onDone: (layer: PaintLayer | undefined) => void,
): void {
  const info = SLOT_INFO[slot];
  const mask = paintRegion(art, look, slot);
  // A part that is not being worn leaves nothing to paint over, which has to
  // be said: the alternative is a screen where every stroke silently fails.
  const nowhere = !!mask && !mask.some((bit) => bit !== 0);
  const grid = PaintGrid.from(look.paint?.[slot], DOLL_W, DOLL_H);
  const undo: PaintGrid[] = [];

  let tool: "brush" | "fill" = "brush";
  let size: BrushSize = 3;
  let erasing = false;
  let color = PAINT_COLORS[0]!;
  let showArea = false;

  // The layer as it stands this instant, handed to the compositor in place of
  // whatever the look still holds. Rebuilt whole after every change: a doll is
  // 118x139, so redrawing all of it costs less than tracking what moved.
  const live = document.createElement("canvas");
  live.width = DOLL_W;
  live.height = DOLL_H;
  const liveCtx = live.getContext("2d")!;
  const liveData = liveCtx.createImageData(DOLL_W, DOLL_H);

  // Everything the layer may not touch, dimmed. Built once, since nothing on
  // this screen can change which parts the character is wearing.
  const areaCv = document.createElement("canvas");
  areaCv.width = DOLL_W;
  areaCv.height = DOLL_H;
  if (mask) {
    const ctx = areaCv.getContext("2d")!;
    const data = ctx.createImageData(DOLL_W, DOLL_H);
    for (let i = 0; i < mask.length; i += 1) {
      if (mask[i]) continue;
      const o = i * 4;
      data.data[o] = 23;
      data.data[o + 1] = 27;
      data.data[o + 2] = 44;
      data.data[o + 3] = 150;
    }
    ctx.putImageData(data, 0, 0);
  }

  // Set when the screen is built. `redraw` calls the first of them, since
  // drawing is what fills the undo stack the tool row reads.
  let syncTools = (): void => {};
  let syncSwatches = (): void => {};

  const stage = el("canvas", "paintStage") as HTMLCanvasElement;
  stage.width = DOLL_W;
  stage.height = DOLL_H;
  const stageCtx = stage.getContext("2d")!;

  const redraw = (): void => {
    paintPixels(grid, mask, liveData.data);
    liveCtx.putImageData(liveData, 0, 0);
    stageCtx.clearRect(0, 0, DOLL_W, DOLL_H);
    drawPaperdoll(stageCtx, art, look, 0, 0, {
      live: { slot, canvas: live },
      focus: slot,
      fade: FADE,
    });
    if (showArea && mask) stageCtx.drawImage(areaCv, 0, 0);
    // Drawing is the other thing that fills the undo stack, so the button that
    // empties it has to be told from here as well as from the tool row.
    syncTools();
  };

  const remember = (): void => {
    undo.push(grid.snapshot());
    if (undo.length > UNDO_STEPS) undo.shift();
  };

  // --- drawing ---

  /** Art pixel under a pointer, whatever the stage has been scaled to. */
  const cellAt = (e: PointerEvent): { x: number; y: number } => {
    const r = stage.getBoundingClientRect();
    return {
      x: Math.floor(((e.clientX - r.left) / r.width) * DOLL_W),
      y: Math.floor(((e.clientY - r.top) / r.height) * DOLL_H),
    };
  };

  let drawing = false;
  let last: { x: number; y: number } | null = null;
  /** Resolved once per stroke: erasing must not add a colour to the palette. */
  let value = 0;

  stage.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const { x, y } = cellAt(e);
    remember();
    value = erasing ? 0 : grid.colorIndex(color);
    if (tool === "fill") {
      if (!grid.fill(x, y, value, mask)) undo.pop();
      redraw();
      return;
    }
    drawing = true;
    last = { x, y };
    // Capture keeps a stroke going when the finger wanders off the doll, but a
    // pointer that has already been let go refuses it, and that must not take
    // the stroke with it.
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      // Drawing carries on without it.
    }
    if (!grid.dab(x, y, size, value, mask)) undo.pop();
    redraw();
  });

  stage.addEventListener("pointermove", (e) => {
    if (!drawing || !last) return;
    const { x, y } = cellAt(e);
    if (x === last.x && y === last.y) return;
    grid.stroke(last.x, last.y, x, y, size, value, mask);
    last = { x, y };
    redraw();
  });

  const endStroke = (): void => {
    drawing = false;
    last = null;
  };
  stage.addEventListener("pointerup", endStroke);
  stage.addEventListener("pointercancel", endStroke);

  // --- the screen ---

  deps.screen((s) => {
    s.appendChild(el("h2", undefined, `Custom ${info.label.toLowerCase()}`));
    s.appendChild(el("div", "sub", nowhere ? info.missing : info.hint));

    const wrap = el("div", "dollWrap paintWrap");
    wrap.appendChild(stage);
    s.appendChild(wrap);

    const tools = el("div", "card");
    tools.appendChild(el("label", undefined, "Tool"));
    const toolRow = el("div", "row");
    const toolBtns: { el: HTMLElement; on: () => boolean }[] = [];
    const addTool = (label: string, pick: () => void, on: () => boolean): void => {
      const b = el("button", "pill", label);
      b.addEventListener("click", () => {
        sfx.tap();
        pick();
        syncTools();
      });
      toolBtns.push({ el: b, on });
      toolRow.appendChild(b);
    };
    for (const n of [3, 2, 1] as BrushSize[]) {
      addTool(`${n}×${n}`, () => { tool = "brush"; size = n; }, () => tool === "brush" && size === n);
    }
    addTool("Fill", () => { tool = "fill"; }, () => tool === "fill");
    // The eraser rides on whichever tool is chosen rather than being a fourth
    // one, so filling with it wipes a shape the same way the brush wipes a line.
    addTool("Eraser", () => { erasing = !erasing; }, () => erasing);
    tools.appendChild(toolRow);

    tools.appendChild(el("label", undefined, "Colour"));
    const grid8 = el("div", "swatches");
    const swatches: { el: HTMLElement; color: string }[] = [];
    for (const c of PAINT_COLORS) {
      const b = el("button", "swatch small");
      b.style.setProperty("--fill", c);
      b.addEventListener("click", () => {
        sfx.tap();
        color = c;
        // Picking a colour is what you do to stop erasing, so it says so.
        erasing = false;
        well.value = c;
        syncTools();
        syncSwatches();
      });
      swatches.push({ el: b, color: c });
      grid8.appendChild(b);
    }
    tools.appendChild(grid8);

    const custom = el("label", "custom");
    const well = el("input") as HTMLInputElement;
    well.type = "color";
    well.value = color;
    well.addEventListener("input", () => {
      color = well.value.toLowerCase();
      erasing = false;
      syncTools();
      syncSwatches();
    });
    custom.appendChild(well);
    custom.appendChild(el("span", undefined, "Any colour"));
    tools.appendChild(custom);

    const acts = el("div", "row");
    const undoBtn = el("button", "pill", "Undo");
    undoBtn.addEventListener("click", () => {
      const back = undo.pop();
      if (!back) {
        sfx.back();
        return;
      }
      sfx.tap();
      grid.copyFrom(back);
      redraw();
      syncTools();
    });
    acts.appendChild(undoBtn);

    const clearBtn = el("button", "pill", "Clear");
    clearBtn.addEventListener("click", () => {
      sfx.tap();
      remember();
      grid.clear();
      redraw();
      syncTools();
    });
    acts.appendChild(clearBtn);

    let areaBtn: HTMLElement | null = null;
    if (mask) {
      areaBtn = el("button", "pill", "Show area");
      areaBtn.addEventListener("click", () => {
        sfx.tap();
        showArea = !showArea;
        redraw();
        syncTools();
      });
      acts.appendChild(areaBtn);
    }
    tools.appendChild(acts);
    s.appendChild(tools);

    syncTools = (): void => {
      for (const b of toolBtns) b.el.classList.toggle("sel", b.on());
      undoBtn.toggleAttribute("disabled", undo.length === 0);
      areaBtn?.classList.toggle("sel", showArea);
    };
    syncSwatches = (): void => {
      for (const sw of swatches) sw.el.classList.toggle("sel", !erasing && sw.color === color);
    };

    const done = el("button", "big primary", "Done");
    done.addEventListener("click", () => {
      sfx.confirm();
      onDone(grid.toLayer());
    });
    s.appendChild(done);

    syncTools();
    syncSwatches();
    redraw();
  });
}
