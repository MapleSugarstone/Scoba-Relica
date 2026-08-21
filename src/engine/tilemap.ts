export const TILE = 16;
/** Collision runs three subcells to a tile on each axis. */
export const SUB = 3;
/** Every subcell blocked: the whole tile is solid. */
export const SUB_FULL = 0b111111111;

/** Bit for one subcell of a 9-bit mask. */
export function subBit(sx: number, sy: number): number {
  return 1 << (sy * SUB + sx);
}

export function maskHas(mask: number, sx: number, sy: number): boolean {
  return (mask & subBit(sx, sy)) !== 0;
}

export function maskWith(mask: number, sx: number, sy: number, on: boolean): number {
  return on ? mask | subBit(sx, sy) : mask & ~subBit(sx, sy);
}

export interface Decal {
  /** Where it is cut from: a packed tileset atlas, or art drawn at load. */
  img: CanvasImageSource;
  sx: number; sy: number; sw: number; sh: number;
  x: number; y: number; // world px, top-left
  /** Draw size, when the art is denser than one source px per world unit. */
  dw?: number; dh?: number;
}

export interface Prop extends Decal {
  /** y-sort baseline (world px). Entities above it draw behind the prop. */
  baseY: number;
  solid?: { x: number; y: number; w: number; h: number };
  /** Content id ("bush", "nest"), so the dev editor can snapshot and edit it. */
  kind?: string;
}

export interface Interactable {
  x: number; y: number; r: number;
  id: string;
}

/** Every map brings its own tileset and paints its own ground. */
export type GroundPainter = (
  map: TileMap,
  ctx: CanvasRenderingContext2D,
  camX: number, camY: number,
  viewW: number, viewH: number,
) => void;

export class TileMap {
  cols: number;
  rows: number;
  /** Fences carry no art of their own; they are collision, drawn as props. */
  fence: boolean[];
  solid: boolean[];
  /** Sub-tile collision: 9-bit mask per tile (3x3 subcells, bit = subY*3+subX).
   * Lets thin obstacles like fence rails block only the band they occupy. */
  subSolid: Map<number, number> = new Map();
  decals: Decal[] = [];
  /** Drawn after the y-sorted pass, so it covers actors: roofs, treetops. */
  canopy: Decal[] = [];
  props: Prop[] = [];
  interactables: Interactable[] = [];
  waterAnimT = 0;
  /** Paints the ground under everything; set by the map that owns the tileset. */
  painter: GroundPainter | null = null;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.fence = new Array(cols * rows).fill(false);
    this.solid = new Array(cols * rows).fill(false);
  }

  get widthPx(): number { return this.cols * TILE; }
  get heightPx(): number { return this.rows * TILE; }

  idx(cx: number, cy: number): number { return cy * this.cols + cx; }

  private mask(layer: boolean[], cx: number, cy: number, oobSame: boolean): number {
    const at = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return oobSame;
      return layer[this.idx(x, y)] ?? false;
    };
    return (at(cx, cy - 1) ? 1 : 0) | (at(cx + 1, cy) ? 2 : 0) | (at(cx, cy + 1) ? 4 : 0) | (at(cx - 1, cy) ? 8 : 0);
  }

  isSolidAt(px: number, py: number): boolean {
    const cx = Math.floor(px / TILE);
    const cy = Math.floor(py / TILE);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return true;
    const idx = this.idx(cx, cy);
    if (this.solid[idx]) return true;
    const mask = this.subSolid.get(idx);
    if (mask) {
      const subX = Math.min(SUB - 1, Math.floor((px - cx * TILE) / (TILE / SUB)));
      const subY = Math.min(SUB - 1, Math.floor((py - cy * TILE) / (TILE / SUB)));
      if (maskHas(mask, subX, subY)) return true;
    }
    for (const p of this.props) {
      const s = p.solid;
      if (s && px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h) return true;
    }
    return false;
  }

  /** A cell's collision as a 9-bit subcell mask, whole-tile solids included. */
  cellMask(cx: number, cy: number): number {
    const idx = this.idx(cx, cy);
    if (this.solid[idx]) return SUB_FULL;
    return this.subSolid.get(idx) ?? 0;
  }

  /** Write a cell's collision, keeping the whole-tile fast path in step. */
  setCellMask(cx: number, cy: number, mask: number): void {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return;
    const idx = this.idx(cx, cy);
    this.solid[idx] = mask === SUB_FULL;
    if (mask === 0 || mask === SUB_FULL) this.subSolid.delete(idx);
    else this.subSolid.set(idx, mask);
  }

  /** Build fence sub-collision from connectivity: the post blocks the center
   * subcell, rails extend it toward connected neighbors. Call after the fence
   * layer is final. */
  finalizeFences(): void {
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const idx = this.idx(cx, cy);
        if (!this.fence[idx]) continue;
        const m = this.mask(this.fence, cx, cy, false);
        let bits = 1 << 4; // center
        if (m & 1) bits |= 1 << 1; // N -> top-middle
        if (m & 2) bits |= 1 << 5; // E -> middle-right
        if (m & 4) bits |= 1 << 7; // S -> bottom-middle
        if (m & 8) bits |= 1 << 3; // W -> middle-left
        this.subSolid.set(idx, (this.subSolid.get(idx) ?? 0) | bits);
      }
    }
  }

  /** Circle-vs-tiles collision resolve, axis at a time. Returns new position. */
  moveCircle(x: number, y: number, dx: number, dy: number, r: number): { x: number; y: number } {
    let nx = x + dx;
    if (this.hitsSolid(nx, y, r)) nx = x;
    let ny = y + dy;
    if (this.hitsSolid(nx, ny, r)) ny = y;
    return { x: nx, y: ny };
  }

  private hitsSolid(x: number, y: number, r: number): boolean {
    return (
      this.isSolidAt(x - r, y) || this.isSolidAt(x + r, y) ||
      this.isSolidAt(x, y - r) || this.isSolidAt(x, y + r) ||
      this.isSolidAt(x - r * 0.7, y - r * 0.7) || this.isSolidAt(x + r * 0.7, y - r * 0.7) ||
      this.isSolidAt(x - r * 0.7, y + r * 0.7) || this.isSolidAt(x + r * 0.7, y + r * 0.7)
    );
  }

  drawGround(ctx: CanvasRenderingContext2D, camX: number, camY: number, viewW: number, viewH: number): void {
    this.painter?.(this, ctx, camX, camY, viewW, viewH);
    drawDecals(this.decals, ctx, camX, camY, viewW, viewH);
  }

  /** The pass over the top of everyone, for whatever you walk under. */
  drawCanopy(ctx: CanvasRenderingContext2D, camX: number, camY: number, viewW: number, viewH: number): void {
    drawDecals(this.canopy, ctx, camX, camY, viewW, viewH);
  }
}

function drawDecals(
  list: Decal[], ctx: CanvasRenderingContext2D,
  camX: number, camY: number, viewW: number, viewH: number,
): void {
  for (const d of list) {
    const dw = d.dw ?? d.sw;
    const dh = d.dh ?? d.sh;
    const dx = Math.round(d.x - camX);
    const dy = Math.round(d.y - camY);
    if (dx + dw < 0 || dy + dh < 0 || dx > viewW || dy > viewH) continue;
    ctx.drawImage(d.img, d.sx, d.sy, d.sw, d.sh, dx, dy, dw, dh);
  }
}
