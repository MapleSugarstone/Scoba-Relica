export const TILE = 16;
/** Collision runs three subcells to a tile on each axis. */
export const SUB = 3;
/** Every subcell blocked: the whole tile is solid. */
export const SUB_FULL = 0b111111111;
/** One subcell's width in world px. */
export const SUB_PX = TILE / SUB;
/** The band of a shore cell the ground art leaves as rim rather than dirt. */
export const RIM_PX = TILE / 4;

/** Gap kept between a body and what it rests against, so rounding never reads as a hit. */
const SKIN = 0.01;
/** Pushes a resolve makes before giving a body up as wedged. */
const MAX_PUSHES = 8;
/** Longest substep as a share of the body's radius; short enough that nothing is ever tunneled. */
const STEP_SHARE = 0.5;
/** Sideways share of a corner's normal below which a hit counts as dead on and gets no assist. */
const ASSIST_MIN = 0.05;
/** Sideways share at and above which the assist slides at full walking pace. */
const ASSIST_FULL = 0.5;

/** A resolved position, and the corner it came off if the deepest hit was one. */
interface Resolved {
  x: number;
  y: number;
  corner: { nx: number; ny: number } | null;
}

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

/**
 * Solid rectangles packed four numbers each (x, y, w, h), so a collision
 * query allocates nothing per frame.
 */
export type RectList = number[];

// One scratch list per query kind. A resolve calls nothing that gathers, and
// nearestFree only ever calls circleHits, so the two never overlap in use.
const HIT_SCRATCH: RectList = [];
const PUSH_SCRATCH: RectList = [];

/**
 * How far a body of radius `r` at (x, y) overlaps the rect at `i` in `rects`.
 * Zero or less means clear. A center inside the rect reports the radius plus
 * the distance to the nearest face, so the deepest overlap always sorts first.
 */
function overlap(x: number, y: number, r: number, rects: RectList, i: number): number {
  const rx = rects[i]!;
  const ry = rects[i + 1]!;
  const rw = rects[i + 2]!;
  const rh = rects[i + 3]!;
  const px = x < rx ? rx : x > rx + rw ? rx + rw : x;
  const py = y < ry ? ry : y > ry + rh ? ry + rh : y;
  const dx = x - px;
  const dy = y - py;
  const d2 = dx * dx + dy * dy;
  if (d2 > 0) return r - Math.sqrt(d2);
  const inside = x > rx && x < rx + rw && y > ry && y < ry + rh;
  if (!inside && r <= 0) return 0;
  return r + Math.min(x - rx, rx + rw - x, y - ry, ry + rh - y);
}

export class TileMap {
  cols: number;
  rows: number;
  /** Fences carry no art of their own; they are collision, drawn as props. */
  fence: boolean[];
  solid: boolean[];
  /** Sub-tile collision: 9-bit mask per tile (3x3 subcells, bit = subY*3+subX).
   * Lets thin obstacles like fence rails block only the band they occupy. */
  subSolid: Map<number, number> = new Map();
  /** Shore rims: sides of a land cell (bits N = 1, E = 2, W = 8) where the
   * ground art stops a quarter tile short of the boundary. Blocked as a thin
   * band, so feet stop where the dirt does rather than a step past it. */
  rims: Map<number, number> = new Map();
  decals: Decal[] = [];
  /** Drawn after the y-sorted pass, so it covers actors: roofs, treetops. */
  canopy: Decal[] = [];
  props: Prop[] = [];
  interactables: Interactable[] = [];
  waterAnimT = 0;
  /** Paints the ground under everything; set by the map that owns the tileset. */
  painter: GroundPainter | null = null;
  // The props that block, picked out once per prop list. Every rebuild starts
  // from a fresh array, so the array plus its length is enough to tell.
  private solidProps: Prop[] = [];
  private solidPropsOf: Prop[] | null = null;
  private solidPropsLen = -1;

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
      const subX = Math.min(SUB - 1, Math.floor((px - cx * TILE) / SUB_PX));
      const subY = Math.min(SUB - 1, Math.floor((py - cy * TILE) / SUB_PX));
      if (maskHas(mask, subX, subY)) return true;
    }
    const rim = this.rims.get(idx);
    if (rim) {
      const ox = px - cx * TILE;
      const oy = py - cy * TILE;
      if ((rim & 1 && oy < RIM_PX) || (rim & 2 && ox >= TILE - RIM_PX) || (rim & 8 && ox < RIM_PX)) return true;
    }
    for (const p of this.blockingProps()) {
      const s = p.solid!;
      if (px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h) return true;
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

  /** Write a cell's shore rim, as N = 1, E = 2, W = 8 bits; zero clears it. */
  setRim(cx: number, cy: number, bits: number): void {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return;
    const idx = this.idx(cx, cy);
    if (bits) this.rims.set(idx, bits);
    else this.rims.delete(idx);
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

  private blockingProps(): Prop[] {
    if (this.solidPropsOf !== this.props || this.solidPropsLen !== this.props.length) {
      this.solidProps = this.props.filter((p) => p.solid !== undefined);
      this.solidPropsOf = this.props;
      this.solidPropsLen = this.props.length;
    }
    return this.solidProps;
  }

  /**
   * Every solid rectangle that could touch the box: whole tiles, subcells,
   * prop hitboxes, and the ground past the map's edge. Fills and returns
   * `out`, packed four numbers to a rect.
   */
  solidsIn(x0: number, y0: number, x1: number, y1: number, out: RectList): RectList {
    out.length = 0;
    const cx0 = Math.floor(x0 / TILE);
    const cx1 = Math.floor(x1 / TILE);
    const cy0 = Math.floor(y0 / TILE);
    const cy1 = Math.floor(y1 / TILE);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) {
          out.push(cx * TILE, cy * TILE, TILE, TILE);
          continue;
        }
        const idx = this.idx(cx, cy);
        if (this.solid[idx]) {
          out.push(cx * TILE, cy * TILE, TILE, TILE);
          continue;
        }
        const rim = this.rims.get(idx);
        if (rim) {
          const tx = cx * TILE;
          const ty = cy * TILE;
          if (rim & 1) out.push(tx, ty, TILE, RIM_PX);
          if (rim & 2) out.push(tx + TILE - RIM_PX, ty, RIM_PX, TILE);
          if (rim & 8) out.push(tx, ty, RIM_PX, TILE);
        }
        const mask = this.subSolid.get(idx);
        if (!mask) continue;
        for (let sy = 0; sy < SUB; sy++) {
          const ry = cy * TILE + sy * SUB_PX;
          if (ry > y1 || ry + SUB_PX < y0) continue;
          for (let sx = 0; sx < SUB; sx++) {
            if (!(mask & (1 << (sy * SUB + sx)))) continue;
            const rx = cx * TILE + sx * SUB_PX;
            if (rx > x1 || rx + SUB_PX < x0) continue;
            out.push(rx, ry, SUB_PX, SUB_PX);
          }
        }
      }
    }
    for (const p of this.blockingProps()) {
      const s = p.solid!;
      if (s.x > x1 || s.x + s.w < x0 || s.y > y1 || s.y + s.h < y0) continue;
      out.push(s.x, s.y, s.w, s.h);
    }
    return out;
  }

  /**
   * True when a body of radius `r` standing at (x, y) overlaps anything
   * solid. Exact against the rectangles rather than sampled around the rim,
   * so a corner cannot slip between two samples. Zero radius is a point test.
   */
  circleHits(x: number, y: number, r: number): boolean {
    const rects = this.solidsIn(x - r, y - r, x + r, y + r, HIT_SCRATCH);
    for (let i = 0; i < rects.length; i += 4) {
      if (overlap(x, y, r, rects, i) > 0) return true;
    }
    return false;
  }

  /**
   * Push a body out of everything it overlaps, deepest first, until it is
   * clear. Deepest first is what keeps a body sliding along a wall built from
   * many cells from catching on the seams: the cell it is over always cuts
   * deeper than the corner of the cell beside it. Null when it is wedged.
   */
  private resolve(x: number, y: number, r: number): Resolved | null {
    let corner: { nx: number; ny: number } | null = null;
    for (let n = 0; n < MAX_PUSHES; n++) {
      const rects = this.solidsIn(x - r - 1, y - r - 1, x + r + 1, y + r + 1, PUSH_SCRATCH);
      let best = -1;
      let deepest = 0;
      for (let i = 0; i < rects.length; i += 4) {
        const d = overlap(x, y, r, rects, i);
        if (d > deepest) {
          deepest = d;
          best = i;
        }
      }
      if (best < 0) return { x, y, corner };
      const rx = rects[best]!;
      const ry = rects[best + 1]!;
      const rw = rects[best + 2]!;
      const rh = rects[best + 3]!;
      const px = x < rx ? rx : x > rx + rw ? rx + rw : x;
      const py = y < ry ? ry : y > ry + rh ? ry + rh : y;
      const dx = x - px;
      const dy = y - py;
      const d = Math.hypot(dx, dy);
      if (d > 1e-9) {
        // Off a face or round a corner: straight away from the nearest point.
        x += (dx / d) * (r - d + SKIN);
        y += (dy / d) * (r - d + SKIN);
        if (n === 0 && (px === rx || px === rx + rw) && (py === ry || py === ry + rh)) {
          corner = { nx: dx / d, ny: dy / d };
        }
        continue;
      }
      // The center is inside: out through whichever face is closest.
      const left = x - rx;
      const right = rx + rw - x;
      const top = y - ry;
      const bottom = ry + rh - y;
      const least = Math.min(left, right, top, bottom);
      if (least === left) x = rx - r - SKIN;
      else if (least === right) x = rx + rw + r + SKIN;
      else if (least === top) y = ry - r - SKIN;
      else y = ry + rh + r + SKIN;
    }
    return null;
  }

  /**
   * Move a body of radius `r` by (dx, dy) against the map and return where it
   * ends up. The step is taken in pieces no longer than half the radius and
   * each piece is pushed clear of whatever it overlaps, which is what lets a
   * body slide along a wall and round a corner it clips instead of stopping
   * dead on it. A body that starts the frame wedged is lifted to the nearest
   * open ground; a step that leads into a gap it cannot fit is refused.
   */
  moveCircle(x: number, y: number, dx: number, dy: number, r: number): { x: number; y: number } {
    const len = Math.hypot(dx, dy);
    const pieces = Math.max(1, Math.ceil(len / Math.max(0.5, r * STEP_SHARE)));
    const step = len / pieces;
    let cx = x;
    let cy = y;
    for (let i = 0; i < pieces; i++) {
      const at = this.resolve(cx + dx / pieces, cy + dy / pieces, r);
      if (!at) {
        if (i === 0 && this.circleHits(x, y, r)) return this.nearestFree(x, y, r, TILE * 3) ?? { x, y };
        return { x: cx, y: cy };
      }
      cx = at.x;
      cy = at.y;
      if (at.corner && len > 0) {
        // Corner assist. A body that clips a corner is pushed off it along
        // the corner's normal, which carries it sideways only in proportion
        // to how far past the corner it already is, so a near miss creeps
        // round. Sliding it the rest of the way at walking pace makes the
        // corner read as rounded. Only where that leaves it clear: two
        // corners closer than the body is wide still refuse it.
        const mx = dx / len;
        const my = dy / len;
        const along = at.corner.nx * mx + at.corner.ny * my;
        const ax = at.corner.nx - along * mx;
        const ay = at.corner.ny - along * my;
        const side = Math.hypot(ax, ay);
        if (side > ASSIST_MIN) {
          const slide = step * Math.min(1, side / ASSIST_FULL);
          const sx = cx + (ax / side) * slide;
          const sy = cy + (ay / side) * slide;
          if (!this.circleHits(sx, sy, r)) {
            cx = sx;
            cy = sy;
          }
        }
      }
    }
    return { x: cx, y: cy };
  }

  /**
   * The closest spot within `reach` px where a body of radius `r` stands
   * clear, or null when there is none. Searches outward in rings a half
   * subcell apart, so what comes back is the nearest open ground rather than
   * the first free tile.
   */
  nearestFree(x: number, y: number, r: number, reach = TILE * 2): { x: number; y: number } | null {
    if (!this.circleHits(x, y, r)) return { x, y };
    const step = SUB_PX / 2;
    for (let ring = step; ring <= reach; ring += step) {
      const count = Math.max(8, Math.ceil((Math.PI * 2 * ring) / step));
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const sx = x + Math.cos(a) * ring;
        const sy = y + Math.sin(a) * ring;
        if (!this.circleHits(sx, sy, r)) return { x: sx, y: sy };
      }
    }
    return null;
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
