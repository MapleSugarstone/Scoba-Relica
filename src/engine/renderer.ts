// Pixel-art renderer. The scene is drawn into an offscreen buffer at ART
// device px per world unit, so the 16 px placeholder tiles blow up to 64 px
// and character art, which is drawn at ART px per world unit, lands at its own
// resolution. The buffer is then blitted to the visible canvas in one
// integer-scaled draw; compositing in one pass avoids tile seams on fractional
// DPR.

/** Device px per world unit inside the scene buffer. */
export const ART = 4;

const density = (): number => Math.min(window.devicePixelRatio || 1, 3);
const displayKey = (): string => `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`;

/**
 * Pixel density as the screen itself has it, held apart from browser zoom.
 * Zoom multiplies into `devicePixelRatio`, so pinning this is what keeps
 * zooming from resizing the game. A different screen is a different density
 * though, so moving the window to one re-reads it.
 */
let baseDpr = typeof window === "undefined" ? 1 : density();
let baseDisplay = typeof window === "undefined" ? "" : displayKey();

function screenDensity(): number {
  if (displayKey() !== baseDisplay) {
    baseDisplay = displayKey();
    baseDpr = density();
  }
  return baseDpr;
}

/**
 * Device pixels per drawn pixel, for the scene and the interface alike. The
 * art is drawn with a three pixel outline, so this has to be a whole number or
 * that line lands across pixel edges and comes out uneven; and it has to be
 * the same number on the canvas and in the DOM, or a panel's border and the
 * outline of the Scoba inside it are drawn with different brushes.
 */
export function pixelStep(): number {
  if (typeof window === "undefined") return 1;
  const shortCss = Math.max(1, Math.min(window.innerWidth, window.innerHeight));
  return Math.max(1, Math.round((shortCss * screenDensity()) / (176 * ART)));
}

/**
 * Holds the DOM on that same grid. Zooming the browser changes the device
 * pixels a CSS pixel is worth; this cancels it out, so one CSS pixel is always
 * `pixelStep()` device pixels and the interface neither grows nor blurs.
 */
export function holdUiScale(): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.zoom = String(uiZoom());
}

/**
 * What the interface is scaled by to sit on that grid. Anything measured off
 * the canvas, which is not scaled, has to be divided by this before it is used
 * as a position inside the interface.
 */
export function uiZoom(): number {
  if (typeof window === "undefined") return 1;
  return pixelStep() / density();
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private screen: CanvasRenderingContext2D;
  private buffer: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Buffer-to-screen blit factor. */
  scale = 1;
  /** Buffer size in device px. */
  bufferW = 320;
  bufferH = 180;
  /** View size in world units. */
  width = 80;
  height = 45;

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
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    // The same whole number of device pixels per drawn pixel the interface
    // uses, so the scene and the panels over it share one brush.
    this.scale = pixelStep();
    this.bufferW = Math.ceil(this.canvas.width / this.scale);
    this.bufferH = Math.ceil(this.canvas.height / this.scale);
    this.buffer.width = this.bufferW;
    this.buffer.height = this.bufferH;
    this.width = this.bufferW / ART;
    this.height = this.bufferH / ART;
    // Resizing resets context state, so the world transform is set here.
    this.ctx.setTransform(ART, 0, 0, ART, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.screen.imageSmoothingEnabled = false;
  }

  /** Call before drawing a frame: heals missed resize events (hidden tab at
   * load, rotation). Must run before scene draw, not after — resizing wipes
   * the buffer. */
  ensureSize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (
      this.canvas.width !== Math.round(Math.max(1, window.innerWidth) * dpr) ||
      this.canvas.height !== Math.round(Math.max(1, window.innerHeight) * dpr)
    ) {
      this.resize();
    }
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
