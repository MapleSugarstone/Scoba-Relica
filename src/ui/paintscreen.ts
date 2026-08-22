// Drawing your own pixels onto one layer of the character.
//
// The doll is composited whole, at its own 118x139, and the stage shows a
// window onto it blown up to whole screen pixels. Everything below the layer
// being worked on draws at full strength, everything above it fades back, and
// the layer itself sits between them exactly where it will end up.
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

/**
 * How far in the doll can be taken: the window of art pixels on show, and how
 * many screen pixels each is worth. The steps are chosen so the stage stays
 * about the same size on screen at every one of them, which is what stops the
 * page jumping under your finger when you zoom. The first shows all of it.
 */
const ZOOMS: { w: number; h: number; scale: number }[] = [
  { w: DOLL_W, h: DOLL_H, scale: 3 },
  { w: 59, h: 70, scale: 6 },
  { w: 39, h: 46, scale: 9 },
  { w: 29, h: 34, scale: 12 },
];

/**
 * The grid, in a light the art never uses. It has to read over the black line
 * work and over the empty background around the character, since accessories
 * are drawn out there, so a dark rule would go missing exactly where it is
 * needed most.
 */
const GRID_INK = "rgba(154, 160, 195, 0.4)";

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

  let tool: "brush" | "fill" | "move" = "brush";
  let size: BrushSize = 3;
  let erasing = false;
  let color = PAINT_COLORS[0]!;
  let showArea = false;
  let showGrid = false;
  let zoom = 0;
  /** Top-left art pixel of the window on show. Whole pixels, so the blit lands square. */
  let viewX = 0;
  let viewY = 0;

  const view = (): { w: number; h: number; scale: number } => ZOOMS[zoom]!;

  // The layer as it stands this instant, handed to the compositor in place of
  // whatever the look still holds. Rebuilt whole after every change: a doll is
  // 118x139, so redrawing all of it costs less than tracking what moved.
  const live = document.createElement("canvas");
  live.width = DOLL_W;
  live.height = DOLL_H;
  const liveCtx = live.getContext("2d")!;
  const liveData = liveCtx.createImageData(DOLL_W, DOLL_H);

  // The whole character at its own size, which the stage then takes a window of.
  const doll = document.createElement("canvas");
  doll.width = DOLL_W;
  doll.height = DOLL_H;
  const dollCtx = doll.getContext("2d")!;

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
  // drawing is what fills the stacks the buttons read.
  let syncTools = (): void => {};
  let syncSwatches = (): void => {};

  const stage = el("canvas", "paintStage") as HTMLCanvasElement;
  const stageCtx = stage.getContext("2d")!;

  const clampView = (): void => {
    const z = view();
    viewX = Math.max(0, Math.min(DOLL_W - z.w, Math.round(viewX)));
    viewY = Math.max(0, Math.min(DOLL_H - z.h, Math.round(viewY)));
  };

  const sizeStage = (): void => {
    const z = view();
    stage.width = z.w * z.scale;
    stage.height = z.h * z.scale;
    clampView();
  };

  /** Where in the doll a screen point falls, in fractional art pixels. */
  const artAt = (clientX: number, clientY: number): { ax: number; ay: number; fx: number; fy: number } => {
    const r = stage.getBoundingClientRect();
    const fx = (clientX - r.left) / r.width;
    const fy = (clientY - r.top) / r.height;
    const z = view();
    return { ax: viewX + fx * z.w, ay: viewY + fy * z.h, fx, fy };
  };

  const panBy = (dx: number, dy: number): void => {
    const wasX = viewX;
    const wasY = viewY;
    viewX += dx;
    viewY += dy;
    clampView();
    if (viewX !== wasX || viewY !== wasY) redraw();
  };

  /** How far one nudge of a key or a pad button moves the window. */
  const panStep = (): number => Math.max(1, Math.round(view().w / 8));

  const drawGrid = (): void => {
    const z = view();
    stageCtx.fillStyle = GRID_INK;
    for (let i = 1; i < z.w; i += 1) stageCtx.fillRect(i * z.scale, 0, 1, stage.height);
    for (let j = 1; j < z.h; j += 1) stageCtx.fillRect(0, j * z.scale, stage.width, 1);
  };

  const redraw = (): void => {
    paintPixels(grid, mask, liveData.data);
    liveCtx.putImageData(liveData, 0, 0);
    dollCtx.clearRect(0, 0, DOLL_W, DOLL_H);
    drawPaperdoll(dollCtx, art, look, 0, 0, {
      live: { slot, canvas: live },
      focus: slot,
      fade: FADE,
    });
    if (showArea && mask) dollCtx.drawImage(areaCv, 0, 0);

    const z = view();
    stageCtx.clearRect(0, 0, stage.width, stage.height);
    stageCtx.imageSmoothingEnabled = false;
    stageCtx.drawImage(doll, viewX, viewY, z.w, z.h, 0, 0, stage.width, stage.height);
    if (showGrid) drawGrid();
    // Drawing is the other thing that fills the undo stack, so the buttons that
    // read it have to be told from here as well as from the tool row.
    syncTools();
  };

  /**
   * `hold` is a point to keep still, from `artAt`. A wheel zoom passes the one
   * under the pointer, since that is what the eye is already on; a button press
   * has no pointer to speak of and holds the middle instead.
   */
  const setZoom = (next: number, hold?: { ax: number; ay: number; fx: number; fy: number }): void => {
    const clamped = Math.max(0, Math.min(ZOOMS.length - 1, next));
    if (clamped === zoom) return;
    const before = view();
    const anchor = hold ?? {
      ax: viewX + before.w / 2,
      ay: viewY + before.h / 2,
      fx: 0.5,
      fy: 0.5,
    };
    zoom = clamped;
    const after = view();
    viewX = anchor.ax - anchor.fx * after.w;
    viewY = anchor.ay - anchor.fy * after.h;
    // Nothing left to pan around once it all fits, so the hand goes back to a brush.
    if (zoom === 0 && tool === "move") tool = "brush";
    sizeStage();
    redraw();
  };

  const recentre = (): void => {
    const z = view();
    viewX = (DOLL_W - z.w) / 2;
    viewY = (DOLL_H - z.h) / 2;
    clampView();
    redraw();
  };

  // --- taking it back, and putting it back again ---

  const undo: PaintGrid[] = [];
  const redo: PaintGrid[] = [];

  /** Files the state a change started from. A new change ends any redo branch. */
  const commit = (before: PaintGrid): void => {
    undo.push(before);
    if (undo.length > UNDO_STEPS) undo.shift();
    redo.length = 0;
  };

  const stepBack = (): boolean => {
    const back = undo.pop();
    if (!back) return false;
    redo.push(grid.snapshot());
    grid.copyFrom(back);
    redraw();
    return true;
  };

  const stepForward = (): boolean => {
    const next = redo.pop();
    if (!next) return false;
    undo.push(grid.snapshot());
    grid.copyFrom(next);
    redraw();
    return true;
  };

  // --- drawing ---

  /** Art pixel under a pointer, through whatever window the stage is showing. */
  const cellAt = (e: PointerEvent): { x: number; y: number } => {
    const r = stage.getBoundingClientRect();
    const z = view();
    return {
      x: Math.floor(viewX + ((e.clientX - r.left) / r.width) * z.w),
      y: Math.floor(viewY + ((e.clientY - r.top) / r.height) * z.h),
    };
  };

  let last: { x: number; y: number } | null = null;
  /** Where the layer stood when the stroke in progress began, or null between strokes. */
  let started: PaintGrid | null = null;
  let moved = false;
  /** Resolved once per stroke: erasing must not add a colour to the palette. */
  let value = 0;
  let panning: { cx: number; cy: number; vx: number; vy: number } | null = null;

  /** Keeps a stroke alive when a finger wanders off the doll. */
  const hold = (e: PointerEvent): void => {
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      // A pointer already let go refuses it; the stroke carries on without.
    }
  };

  stage.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (tool === "move") {
      panning = { cx: e.clientX, cy: e.clientY, vx: viewX, vy: viewY };
      hold(e);
      return;
    }
    const { x, y } = cellAt(e);
    value = erasing ? 0 : grid.colorIndex(color);
    const before = grid.snapshot();
    if (tool === "fill") {
      if (grid.fill(x, y, value, mask)) commit(before);
      redraw();
      return;
    }
    started = before;
    moved = grid.dab(x, y, size, value, mask);
    last = { x, y };
    hold(e);
    redraw();
  });

  stage.addEventListener("pointermove", (e) => {
    if (panning) {
      const r = stage.getBoundingClientRect();
      const z = view();
      viewX = panning.vx - ((e.clientX - panning.cx) / r.width) * z.w;
      viewY = panning.vy - ((e.clientY - panning.cy) / r.height) * z.h;
      clampView();
      redraw();
      return;
    }
    if (!started || !last) return;
    const { x, y } = cellAt(e);
    if (x === last.x && y === last.y) return;
    if (grid.stroke(last.x, last.y, x, y, size, value, mask)) moved = true;
    last = { x, y };
    redraw();
  });

  // One stroke is one thing to take back, however many pointer events it took,
  // and a stroke that changed nothing is not a thing to take back at all.
  const endStroke = (): void => {
    panning = null;
    if (started && moved) commit(started);
    started = null;
    moved = false;
    last = null;
    syncTools();
  };
  stage.addEventListener("pointerup", endStroke);
  stage.addEventListener("pointercancel", endStroke);

  /**
   * The wheel drives the window: plain for up and down, shift for left and
   * right, and control (or command) to zoom about whatever the pointer is on.
   * The page keeps the wheel while the whole doll is on screen, since there is
   * nothing to scroll here then and taking it would strand the tools below.
   */
  const WHEEL_LINE = 16;
  stage.addEventListener("wheel", (e) => {
    const step = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? stage.height : 1;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      if (e.deltaY !== 0) setZoom(zoom + dir, artAt(e.clientX, e.clientY));
      return;
    }
    if (zoom === 0) return;
    e.preventDefault();
    const z = view();
    const dy = (e.deltaY * step) / z.scale;
    const dx = (e.deltaX * step) / z.scale;
    if (e.shiftKey) panBy(dy + dx, 0);
    else panBy(dx, dy);
  }, { passive: false });

  const PAN_KEYS: Record<string, [number, number]> = {
    w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
    arrowup: [0, -1], arrowleft: [-1, 0], arrowdown: [0, 1], arrowright: [1, 0],
  };

  /**
   * The shortcuts every drawing program has, plus WASD on the window. Held on
   * the window rather than the canvas, since nothing here takes focus, and
   * dropped as soon as the screen it belongs to is gone, however it went.
   */
  const onKey = (e: KeyboardEvent): void => {
    if (!stage.isConnected) {
      window.removeEventListener("keydown", onKey);
      return;
    }
    const key = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (key !== "z" && key !== "y") return;
      e.preventDefault();
      const forward = key === "y" || e.shiftKey;
      if (forward ? stepForward() : stepBack()) sfx.tap();
      else sfx.back();
      return;
    }
    if (e.altKey) return;
    // A letter typed into a field is that field's, not the camera's.
    const on = e.target as HTMLElement | null;
    if (on && /^(INPUT|TEXTAREA|SELECT)$/.test(on.tagName)) return;
    const pan = PAN_KEYS[key];
    // Nothing to move while it all fits, and the arrow keys are the page's
    // again in that case rather than being swallowed to no effect.
    if (!pan || zoom === 0) return;
    e.preventDefault();
    panBy(pan[0] * panStep(), pan[1] * panStep());
  };
  window.addEventListener("keydown", onKey);

  // --- the screen ---

  deps.screen((s) => {
    s.appendChild(el("h2", undefined, `Custom ${info.label.toLowerCase()}`));
    s.appendChild(el("div", "sub", nowhere ? info.missing : info.hint));

    const wrap = el("div", "dollWrap paintWrap");
    wrap.appendChild(stage);
    s.appendChild(wrap);

    const tools = el("div", "card");

    tools.appendChild(el("label", undefined, "View"));
    const viewRow = el("div", "row");
    const outBtn = el("button", "pill", "−");
    const zoomTag = el("button", "pill", "1×");
    const inBtn = el("button", "pill", "+");
    outBtn.addEventListener("click", () => { sfx.tap(); setZoom(zoom - 1); });
    inBtn.addEventListener("click", () => { sfx.tap(); setZoom(zoom + 1); });
    // The reading doubles as the way back out to the whole character.
    zoomTag.addEventListener("click", () => { sfx.tap(); setZoom(0); });
    viewRow.appendChild(outBtn);
    viewRow.appendChild(zoomTag);
    viewRow.appendChild(inBtn);
    const gridBtn = el("button", "pill", "Grid");
    gridBtn.addEventListener("click", () => {
      sfx.tap();
      showGrid = !showGrid;
      redraw();
    });
    viewRow.appendChild(gridBtn);
    tools.appendChild(viewRow);

    // A pad to shove the window about, for anyone without a wheel or a keyboard.
    // It sits apart from the Hand tool on purpose: nudging the view here does
    // not cost you the brush you are holding.
    const pad = el("div", "panPad");
    const padBtns: HTMLButtonElement[] = [];
    const nudge = (label: string, dx: number, dy: number): HTMLButtonElement => {
      const b = el("button", "pill", label);
      b.addEventListener("click", () => {
        sfx.tap();
        panBy(dx * panStep(), dy * panStep());
      });
      padBtns.push(b);
      return b;
    };
    const blank = (): HTMLElement => el("i", "gap");
    const middle = el("button", "pill", "▢");
    middle.title = "Centre";
    middle.addEventListener("click", () => {
      sfx.tap();
      recentre();
    });
    padBtns.push(middle);
    pad.append(
      blank(), nudge("▲", 0, -1), blank(),
      nudge("◀", -1, 0), middle, nudge("▶", 1, 0),
      blank(), nudge("▼", 0, 1), blank(),
    );
    tools.appendChild(pad);
    tools.appendChild(el("div", "dim",
      "Scroll to move, shift to go sideways, ctrl and scroll to zoom. WASD moves too."));

    tools.appendChild(el("label", undefined, "Tool"));
    const toolRow = el("div", "row");
    const toolBtns: { el: HTMLElement; on: () => boolean }[] = [];
    const addTool = (label: string, pick: () => void, on: () => boolean): HTMLButtonElement => {
      const b = el("button", "pill", label);
      b.addEventListener("click", () => {
        sfx.tap();
        pick();
        syncTools();
      });
      toolBtns.push({ el: b, on });
      toolRow.appendChild(b);
      return b;
    };
    for (const n of [3, 2, 1] as BrushSize[]) {
      addTool(`${n}×${n}`, () => { tool = "brush"; size = n; }, () => tool === "brush" && size === n);
    }
    addTool("Fill", () => { tool = "fill"; }, () => tool === "fill");
    const handBtn = addTool("Hand", () => { tool = "move"; }, () => tool === "move");
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
      if (stepBack()) sfx.tap();
      else sfx.back();
    });
    acts.appendChild(undoBtn);

    const redoBtn = el("button", "pill", "Redo");
    redoBtn.addEventListener("click", () => {
      if (stepForward()) sfx.tap();
      else sfx.back();
    });
    acts.appendChild(redoBtn);

    const clearBtn = el("button", "pill", "Clear");
    clearBtn.addEventListener("click", () => {
      sfx.tap();
      if (!grid.painted) return;
      const before = grid.snapshot();
      grid.clear();
      commit(before);
      redraw();
    });
    acts.appendChild(clearBtn);

    let areaBtn: HTMLElement | null = null;
    if (mask) {
      areaBtn = el("button", "pill", "Show area");
      areaBtn.addEventListener("click", () => {
        sfx.tap();
        showArea = !showArea;
        redraw();
      });
      acts.appendChild(areaBtn);
    }
    tools.appendChild(acts);
    s.appendChild(tools);

    syncTools = (): void => {
      for (const b of toolBtns) b.el.classList.toggle("sel", b.on());
      undoBtn.toggleAttribute("disabled", undo.length === 0);
      redoBtn.toggleAttribute("disabled", redo.length === 0);
      areaBtn?.classList.toggle("sel", showArea);
      gridBtn.classList.toggle("sel", showGrid);
      zoomTag.textContent = `${zoom + 1}×`;
      outBtn.toggleAttribute("disabled", zoom === 0);
      inBtn.toggleAttribute("disabled", zoom === ZOOMS.length - 1);
      // There is nothing to move about while the whole doll is on screen.
      handBtn.toggleAttribute("disabled", zoom === 0);
      for (const b of padBtns) b.toggleAttribute("disabled", zoom === 0);
    };
    syncSwatches = (): void => {
      for (const sw of swatches) sw.el.classList.toggle("sel", !erasing && sw.color === color);
    };

    const done = el("button", "big primary", "Done");
    done.addEventListener("click", () => {
      sfx.confirm();
      window.removeEventListener("keydown", onKey);
      onDone(grid.toLayer());
    });
    s.appendChild(done);

    sizeStage();
    syncSwatches();
    redraw();
  });
}
