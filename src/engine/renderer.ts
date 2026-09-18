// Pixel-art renderer. The scene is drawn into an offscreen buffer at ART
// device px per world unit, so the 16 px placeholder tiles blow up to 64 px
// and character art, which is drawn at ART px per world unit, lands at its own
// resolution. The buffer is then blitted to the visible canvas in one
// integer-scaled draw; compositing in one pass avoids tile seams on fractional
// DPR.
//
// The game lives in a frame of fixed size rather than filling the window. The
// frame shows the same stretch of world and lays the interface out in the
// same box on every screen, scaled as a whole to fit, with the page's ground
// showing round it where the window is the wrong shape.

/** Device px per world unit inside the scene buffer. */
import { crispPixels } from "./crisp";
export const ART = 4;

/** What the frame shows in world units. A window held upright gets a prompt to turn, not a frame of its own. */
export const LANDSCAPE = { w: 400, h: 225 } as const;

/** Interface px per world unit: the interface is laid out at twice the world's resolution. */
export const UI_PER_UNIT = 2;

/** Share of the window a whole scale step has to cover before it is preferred to filling it. */
const FILL_FLOOR = 0.8;

export interface Viewport {
  /** The window is taller than it is wide, which is when the turn-it prompt covers the frame. */
  portrait: boolean;
  /** World units the frame shows. */
  world: { w: number; h: number };
  /** The interface box, in the CSS px the interface is laid out in. */
  ui: { w: number; h: number };
  /** Device px per world unit. A whole multiple of ART wherever a whole step fills enough of the window. */
  k: number;
  /** Device px per interface px. */
  u: number;
  /** The root zoom that makes one interface px worth `u` device px. */
  zoom: number;
  /** True when the window is smaller than the art's own size and the frame is shrunk to fit, the one case that softens. */
  soft: boolean;
}

/**
 * The frame the window gets. Measured in device px, so zooming the browser,
 * which trades CSS px for density, leaves the frame exactly where it was.
 * Every whole multiple of the art's own size keeps each art pixel a whole
 * number of device pixels; below one, the frame is drawn at native size and
 * shrunk.
 */
const FALLBACK: Viewport = {
  portrait: false, world: LANDSCAPE, ui: { w: 800, h: 450 }, k: ART, u: ART / UI_PER_UNIT, zoom: 1, soft: false,
};
/** The last frame worked out from a real window, kept for the moments the window reads as nothing. */
let lastGood: Viewport = FALLBACK;

export function viewport(): Viewport {
  if (typeof window === "undefined") return FALLBACK;
  // A window mid-load or in a hidden tab can report a size of a pixel or
  // two, and a frame fitted to that is a zoom of nothing. Hold the last real
  // layout until the window is back.
  if (window.innerWidth < 64 || window.innerHeight < 64) return lastGood;
  const dpr = window.devicePixelRatio || 1;
  const devW = window.innerWidth * dpr;
  const devH = window.innerHeight * dpr;
  const portrait = devH > devW;
  const world = LANDSCAPE;
  const fit = Math.min(devW / (world.w * ART), devH / (world.h * ART));
  // A whole step keeps every art pixel a whole number of device pixels, and
  // is taken whenever it covers most of the window. Where it would leave more
  // than a fifth of the window empty, which is what a phone at two device
  // pixels per CSS pixel gets, the frame scales to fill instead and the art
  // pixels come out a device pixel uneven.
  const whole = Math.floor(fit);
  // Held to a whole step, a window is left with a border round the game and
  // every art pixel, panel edge and letter lands on the device grid. Filling
  // it instead resamples all three, and text goes soft first.
  const held = crispPixels() ? whole >= 1 : whole >= 1 && whole / fit >= FILL_FLOOR;
  const k = held ? ART * whole : ART * fit;
  const u = k / UI_PER_UNIT;
  lastGood = {
    portrait,
    world,
    ui: { w: world.w * UI_PER_UNIT, h: world.h * UI_PER_UNIT },
    k,
    u,
    zoom: u / dpr,
    soft: k < ART,
  };
  return lastGood;
}

/**
 * Device pixels per drawn interface pixel. The art is drawn with a three
 * pixel outline, so this is a whole number wherever the window allows one,
 * and it is the same number on the canvas and in the DOM, or a panel's border
 * and the outline of the Scoba inside it are drawn with different brushes.
 */
export function pixelStep(): number {
  return viewport().u;
}

/**
 * What the interface is scaled by to sit on that grid. Anything measured off
 * the screen has to be divided by this before it is used as a size inside the
 * interface.
 */
export function uiZoom(): number {
  return viewport().zoom;
}

/**
 * Lays the frame out: the root zoom that puts the interface on the pixel
 * grid, the frame's size for the stylesheet, and which way the window is
 * held. Called on every resize, and by the renderer before it draws.
 */
export function holdUiScale(): void {
  if (typeof document === "undefined") return;
  const v = viewport();
  const root = document.documentElement;
  root.style.zoom = String(v.zoom);
  root.style.setProperty("--ui-w", `${v.ui.w}px`);
  root.style.setProperty("--ui-h", `${v.ui.h}px`);
  root.classList.toggle("portrait", v.portrait);
  root.classList.toggle("soft", v.soft);
}

/**
 * Where the frame sits on the screen, in the same coordinates a pointer event
 * and `getBoundingClientRect` report, for anything that has to stay inside it.
 */
export function frameRect(): DOMRect {
  const frame = typeof document === "undefined" ? null : document.getElementById("frame");
  if (frame) return frame.getBoundingClientRect();
  return new DOMRect(0, 0, typeof window === "undefined" ? 0 : window.innerWidth, typeof window === "undefined" ? 0 : window.innerHeight);
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private screen: CanvasRenderingContext2D;
  private buffer: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Buffer-to-screen blit factor. */
  scale = 1;
  /** Buffer size in device px. */
  bufferW = LANDSCAPE.w * ART;
  bufferH = LANDSCAPE.h * ART;
  /** View size in world units. */
  width: number = LANDSCAPE.w;
  height: number = LANDSCAPE.h;
  private laidOut = "";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.screen = canvas.getContext("2d")!;
    this.buffer = document.createElement("canvas");
    this.ctx = this.buffer.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.visualViewport?.addEventListener("resize", () => this.resize());
  }

  resize(): void {
    const v = viewport();
    holdUiScale();
    this.laidOut = `${v.portrait}:${v.k}:${v.zoom}`;
    this.width = v.world.w;
    this.height = v.world.h;
    this.bufferW = v.world.w * ART;
    this.bufferH = v.world.h * ART;
    this.buffer.width = this.bufferW;
    this.buffer.height = this.bufferH;
    // The same whole number of device pixels per drawn pixel the interface
    // uses, so the scene and the panels over it share one brush. Whatever is
    // left over, up or down, is the canvas's own CSS size scaling the result.
    this.scale = Math.max(1, Math.floor(v.k / ART));
    this.canvas.width = this.bufferW * this.scale;
    this.canvas.height = this.bufferH * this.scale;
    // Resizing resets context state, so the world transform is set here.
    this.ctx.setTransform(ART, 0, 0, ART, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.screen.imageSmoothingEnabled = false;
  }

  /** Call before drawing a frame: heals missed resize events (hidden tab at
   * load, rotation). Must run before scene draw, not after — resizing wipes
   * the buffer. */
  ensureSize(): void {
    const v = viewport();
    if (this.laidOut !== `${v.portrait}:${v.k}:${v.zoom}`) this.resize();
  }

  present(): void {
    this.screen.imageSmoothingEnabled = false;
    this.screen.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.screen.drawImage(
      this.buffer,
      0, 0, this.bufferW, this.bufferH,
      0, 0, this.bufferW * this.scale, this.bufferH * this.scale,
    );
  }
}
