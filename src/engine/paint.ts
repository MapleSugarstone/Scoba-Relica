// Hand-painted layers on top of the palette-swapped character art.
//
// A layer is one indexed-colour bitmap the size of the doll: cell 0 is clear,
// anything else is an index into the layer's own small palette. Nothing here
// touches the DOM, so the encoding and the drawing rules are unit-testable.
//
// Where a layer is allowed to land is decided by a mask handed in from the
// paperdoll, never stored: a mask follows the part that is currently worn, so
// swapping hair reclips paint that was laid down over a different one.

/** The slots a player can paint, in the order they stack on the doll. */
export const PAINT_SLOTS = ["shirt", "face", "eyes", "hair", "extras"] as const;
export type PaintSlot = (typeof PAINT_SLOTS)[number];
export type PaintSet = Partial<Record<PaintSlot, PaintLayer>>;

/**
 * One painted layer, small enough to sit in a save and ride the wire inside a
 * character profile. `p` holds the colours, indexed from one; `d` is the run
 * length encoding over the doll's cells, row by row.
 */
export interface PaintLayer {
  p: string[];
  d: string;
}

/**
 * Run heads, one character each. Digits are deliberately excluded: a run's
 * length follows its colour as plain decimal and is left off entirely when it
 * is one, so a stretch of pixels that alternate every cell costs one character
 * each rather than three. That is what bounds a layer at the doll's cell count
 * and keeps five of them well inside the relay's message ceiling.
 */
const HEADS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/";

/** Colours one layer can hold. The first head is the clear run. */
export const MAX_PAINT_COLORS = HEADS.length - 1;

/** Brush footprints, in pixels across. */
export type BrushSize = 1 | 2 | 3;

/**
 * The painter's own swatches. Pure black and pure white lead, since they are
 * the two a pixel artist reaches for first and neither is anywhere else in the
 * game's palette: black is the line art, and white is the highlight over it.
 * The rest run neutrals, flesh, warms and cools, eight to a row.
 */
export const PAINT_COLORS: string[] = [
  "#000000", "#ffffff", "#171b2c", "#3f4a66", "#6b7196", "#9aa0c3", "#c8cdd6", "#ded9ee",
  "#2a2530", "#5a3520", "#7d4a2c", "#a9663f", "#cd8552", "#e8a06a", "#ffab82", "#ffe0c4",
  "#d9553f", "#b4553d", "#e7a03c", "#eae178", "#f3f2c0", "#5f843a", "#7aa74a", "#b9c98a",
  "#8fd0c4", "#4f8fba", "#7c9df0", "#5c4e92", "#8d63c0", "#dba7d6", "#e58ab8", "#d977b8",
];

const HEX = /^#[0-9a-f]{6}$/;

function rgbOf(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** A canvas-sized bitmap of painted cells, and the palette they index. */
export class PaintGrid {
  readonly cells: Uint8Array;
  palette: string[] = [];

  constructor(readonly w: number, readonly h: number) {
    this.cells = new Uint8Array(w * h);
  }

  /**
   * Decodes a stored layer. Anything malformed is skipped rather than thrown
   * on: a layer can arrive from the other player, and a bad one should cost
   * them their hat, not the whole character.
   */
  static from(layer: PaintLayer | undefined | null, w: number, h: number): PaintGrid {
    const g = new PaintGrid(w, h);
    if (!layer || typeof layer.d !== "string" || !Array.isArray(layer.p)) return g;
    g.palette = layer.p
      .filter((c): c is string => typeof c === "string" && HEX.test(c.toLowerCase()))
      .slice(0, MAX_PAINT_COLORS)
      .map((c) => c.toLowerCase());
    const d = layer.d;
    let at = 0;
    let i = 0;
    while (i < d.length && at < g.cells.length) {
      const head = HEADS.indexOf(d[i]!);
      i += 1;
      if (head < 0) continue;
      let len = 0;
      let digits = 0;
      while (i < d.length) {
        const code = d.charCodeAt(i);
        if (code < 48 || code > 57) break;
        len = len * 10 + (code - 48);
        i += 1;
        digits += 1;
      }
      const end = Math.min(at + (digits > 0 ? len : 1), g.cells.length);
      if (head > 0 && head <= g.palette.length) g.cells.fill(head, at, end);
      at = end;
    }
    return g;
  }

  /** True once a single cell has been painted. */
  get painted(): boolean {
    return this.cells.some((c) => c !== 0);
  }

  /**
   * Back to a storable layer, dropping colours nothing uses any more so
   * erasing the last of a colour actually shrinks what gets saved.
   */
  toLayer(): PaintLayer | undefined {
    const remap = new Uint8Array(256);
    const p: string[] = [];
    for (const c of this.cells) {
      if (c === 0 || remap[c]) continue;
      p.push(this.palette[c - 1] ?? "#000000");
      remap[c] = p.length;
    }
    if (p.length === 0) return undefined;
    // A layer is mostly empty and its tail always is, so the last clear run is
    // left off and read back as "the rest of the canvas".
    let last = this.cells.length;
    while (last > 0 && this.cells[last - 1] === 0) last -= 1;
    let d = "";
    let i = 0;
    while (i < last) {
      const v = this.cells[i]!;
      let n = 1;
      while (i + n < last && this.cells[i + n] === v) n += 1;
      d += HEADS[v === 0 ? 0 : remap[v]!]! + (n > 1 ? String(n) : "");
      i += n;
    }
    return { p, d };
  }

  /**
   * The index to paint with for a colour, adding it to the palette. A layer
   * that has run out of room snaps to its nearest existing colour rather than
   * refusing the stroke.
   */
  colorIndex(hex: string): number {
    const c = hex.toLowerCase();
    const at = this.palette.indexOf(c);
    if (at >= 0) return at + 1;
    if (this.palette.length < MAX_PAINT_COLORS) {
      this.palette.push(c);
      return this.palette.length;
    }
    const [r, g, b] = rgbOf(c);
    let best = 0;
    let bestD = Infinity;
    this.palette.forEach((other, i) => {
      const [r2, g2, b2] = rgbOf(other);
      const dist = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    return best + 1;
  }

  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.cells[y * this.w + x]!;
  }

  /** One cell, refused outside the canvas or outside the mask. */
  set(x: number, y: number, value: number, mask: Uint8Array | null): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    const i = y * this.w + x;
    if (mask && !mask[i]) return false;
    if (this.cells[i] === value) return false;
    this.cells[i] = value;
    return true;
  }

  /**
   * A square brush footprint. The 3 px one is centred; the smaller two hang
   * off the cell under the finger, which is what makes a 1 px brush land where
   * it is pointed.
   */
  dab(x: number, y: number, size: BrushSize, value: number, mask: Uint8Array | null): boolean {
    const from = size === 3 ? -1 : 0;
    const to = size === 1 ? 0 : 1;
    let changed = false;
    for (let dy = from; dy <= to; dy += 1) {
      for (let dx = from; dx <= to; dx += 1) {
        if (this.set(x + dx, y + dy, value, mask)) changed = true;
      }
    }
    return changed;
  }

  /**
   * A brush dragged from one sample to the next. Pointer events arrive far
   * apart on a fast drag, so the gap between two of them is walked rather than
   * left as a dotted line.
   */
  stroke(
    x0: number, y0: number, x1: number, y1: number,
    size: BrushSize, value: number, mask: Uint8Array | null,
  ): boolean {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    let changed = false;
    for (let i = 0; i <= steps; i += 1) {
      const t = steps === 0 ? 0 : i / steps;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);
      if (this.dab(x, y, size, value, mask)) changed = true;
    }
    return changed;
  }

  /** Flood fill over cells of one value, held inside the mask. */
  fill(x: number, y: number, value: number, mask: Uint8Array | null): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    const start = y * this.w + x;
    if (mask && !mask[start]) return false;
    const target = this.cells[start]!;
    if (target === value) return false;
    const stack = [start];
    this.cells[start] = value;
    while (stack.length > 0) {
      const i = stack.pop()!;
      const cx = i % this.w;
      const cy = (i / this.w) | 0;
      const push = (nx: number, ny: number): void => {
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) return;
        const n = ny * this.w + nx;
        if (mask && !mask[n]) return;
        if (this.cells[n] !== target) return;
        this.cells[n] = value;
        stack.push(n);
      };
      push(cx - 1, cy);
      push(cx + 1, cy);
      push(cx, cy - 1);
      push(cx, cy + 1);
    }
    return true;
  }

  clear(): void {
    this.cells.fill(0);
  }

  copyFrom(other: PaintGrid): void {
    this.cells.set(other.cells);
    this.palette = other.palette.slice();
  }

  snapshot(): PaintGrid {
    const g = new PaintGrid(this.w, this.h);
    g.copyFrom(this);
    return g;
  }
}

/**
 * A grid as straight RGBA, clipped to the mask. Cells the mask rejects are
 * left clear rather than dropped, so paint laid over one hairstyle comes back
 * when that hairstyle does.
 */
export function paintPixels(
  grid: PaintGrid,
  mask: Uint8Array | null,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const px = out ?? new Uint8ClampedArray(grid.w * grid.h * 4);
  const rgb = grid.palette.map(rgbOf);
  for (let i = 0; i < grid.cells.length; i += 1) {
    const o = i * 4;
    const v = grid.cells[i]!;
    const c = v > 0 && (!mask || mask[i]) ? rgb[v - 1] : undefined;
    if (!c) {
      px[o] = 0;
      px[o + 1] = 0;
      px[o + 2] = 0;
      px[o + 3] = 0;
      continue;
    }
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
    px[o + 3] = 255;
  }
  return px;
}

/** A stable cache key for one layer. Two equal layers share a rendering. */
export function layerKey(layer: PaintLayer): string {
  return `${layer.p.join(",")}~${layer.d}`;
}

export function hasPaint(set: PaintSet | undefined, slot: PaintSlot): boolean {
  const layer = set?.[slot];
  return !!layer && layer.p.length > 0 && layer.d.length > 0;
}

/**
 * A paint set from somewhere that is not trusted: the other player's profile,
 * or a save file somebody has edited. Anything unrecognisable is dropped, and
 * the run data is capped at what a full canvas can possibly encode, so a
 * hostile layer cannot be made to decode into work without end.
 */
export function sanitizePaintSet(value: unknown, w: number, h: number): PaintSet | undefined {
  if (!value || typeof value !== "object") return undefined;
  const src = value as Record<string, unknown>;
  const out: PaintSet = {};
  let any = false;
  for (const slot of PAINT_SLOTS) {
    const raw = src[slot];
    if (!raw || typeof raw !== "object") continue;
    const layer = raw as { p?: unknown; d?: unknown };
    if (!Array.isArray(layer.p) || typeof layer.d !== "string") continue;
    const p = layer.p
      .filter((c): c is string => typeof c === "string" && HEX.test(c.toLowerCase()))
      .slice(0, MAX_PAINT_COLORS)
      .map((c) => c.toLowerCase());
    if (p.length === 0) continue;
    // Every cell as its own run is the worst an honest encoder can do.
    const clean = PaintGrid.from({ p, d: layer.d.slice(0, w * h * 2) }, w, h).toLayer();
    if (!clean) continue;
    out[slot] = clean;
    any = true;
  }
  return any ? out : undefined;
}
