import { SUB, SUB_PX, type TileMap } from "../engine/tilemap";

// A* over the sub-tile collision grid (3x3 subcells per tile, the same
// resolution fences block at). Cheap enough to run on demand when a follower
// gets stuck, and the node cap keeps the worst case bounded.

/** Body radius used when a caller does not name one. */
const BODY = 3.5;

/** Rings of subcells a blocked `near` goal may slide across. */
const NEAR_RINGS = 6;

const DIRS = [
  [1, 0], [0, 1], [-1, 0], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

/** World px of a subcell's center along one axis. */
function center(s: number): number {
  return s * SUB_PX + SUB_PX / 2;
}

/**
 * Subcell walkability for one body radius, answered once per cell and kept.
 * The corner rule asks about the same neighbors several times over and
 * `circleHits` is the whole cost of a search.
 */
class Grid {
  readonly cols: number;
  readonly rows: number;
  private readonly known: Uint8Array;

  constructor(private readonly map: TileMap, private readonly r: number) {
    this.cols = map.cols * SUB;
    this.rows = map.rows * SUB;
    this.known = new Uint8Array(this.cols * this.rows);
  }

  free(sx: number, sy: number): boolean {
    if (sx < 0 || sy < 0 || sx >= this.cols || sy >= this.rows) return false;
    const i = sy * this.cols + sx;
    let v = this.known[i]!;
    if (v === 0) {
      v = this.map.circleHits(center(sx), center(sy), this.r) ? 2 : 1;
      this.known[i] = v;
    }
    return v === 1;
  }
}

/** Min-heap of subcells ordered by f. Each push carries its own key, so a
 * cheaper route to a cell already in the heap can just be pushed again. */
class Heap {
  private cells: number[] = [];
  private keys: number[] = [];

  get size(): number { return this.cells.length; }

  push(cell: number, key: number): void {
    this.cells.push(cell);
    this.keys.push(key);
    let c = this.cells.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.keys[p]! <= this.keys[c]!) break;
      this.swap(p, c);
      c = p;
    }
  }

  pop(): number {
    const top = this.cells[0]!;
    const last = this.cells.length - 1;
    this.swap(0, last);
    this.cells.pop();
    this.keys.pop();
    let p = 0;
    for (;;) {
      const l = p * 2 + 1;
      let m = p;
      if (l < this.cells.length && this.keys[l]! < this.keys[m]!) m = l;
      if (l + 1 < this.cells.length && this.keys[l + 1]! < this.keys[m]!) m = l + 1;
      if (m === p) break;
      this.swap(p, m);
      p = m;
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const c = this.cells[a]!;
    this.cells[a] = this.cells[b]!;
    this.cells[b] = c;
    const k = this.keys[a]!;
    this.keys[a] = this.keys[b]!;
    this.keys[b] = k;
  }
}

/** Cost of the cheapest 8-directional run between two subcells. */
function octile(x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
}

/** Closest subcell to (sx, sy) the body fits in, within `rings`, or null. */
function nearestFree(grid: Grid, sx: number, sy: number, rings: number): { x: number; y: number } | null {
  for (let ring = 1; ring <= rings; ring++) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        if (!grid.free(sx + dx, sy + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x: sx + dx, y: sy + dy };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * True when a body of radius `r` can walk straight from one point to the
 * other. Companions use it to tell "you ran off" from "you went behind
 * something", which is when they need a real route instead of a heading.
 */
export function lineOfSight(
  map: TileMap,
  x0: number, y0: number,
  x1: number, y1: number,
  r = BODY,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, r / 2)));
  for (let i = 1; i <= steps; i++) {
    if (map.circleHits(x0 + (dx * i) / steps, y0 + (dy * i) / steps, r)) return false;
  }
  return true;
}

/**
 * Shortest 8-directional route between two world points, as world-px corner
 * points a body of radius `radius` fits through. Null when there is no route
 * within `maxNodes` or an endpoint is blocked. With `near`, a blocked goal
 * slides to the closest subcell the body fits in within two tiles, so a
 * follower can head for "beside the player" when the player hugs a wall.
 */
export function findPath(
  map: TileMap,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  opts: { near?: boolean; maxNodes?: number; radius?: number } = {},
): { x: number; y: number }[] | null {
  const r = opts.radius ?? BODY;
  const maxNodes = opts.maxNodes ?? 4000;
  const grid = new Grid(map, r);
  const cols = grid.cols;
  const startX = Math.floor(fromX / SUB_PX);
  const startY = Math.floor(fromY / SUB_PX);
  // The actor's own spot is clear whatever its subcell center reads, so the
  // start only faces a point test. Anything stricter wedges a cornered body.
  if (startX < 0 || startY < 0 || startX >= cols || startY >= grid.rows) return null;
  if (map.circleHits(center(startX), center(startY), 0)) return null;

  let goalX = Math.floor(toX / SUB_PX);
  let goalY = Math.floor(toY / SUB_PX);
  if (!grid.free(goalX, goalY)) {
    const slid = opts.near ? nearestFree(grid, goalX, goalY, NEAR_RINGS) : null;
    if (!slid) return null;
    goalX = slid.x;
    goalY = slid.y;
  }
  if (startX === goalX && startY === goalY) return [];

  const start = startY * cols + startX;
  const goal = goalY * cols + goalX;
  const cameFrom = new Int32Array(cols * grid.rows).fill(-1);
  const cost = new Float64Array(cols * grid.rows).fill(Infinity);
  const closed = new Uint8Array(cols * grid.rows);
  const open = new Heap();
  cost[start] = 0;
  open.push(start, octile(startX, startY, goalX, goalY));

  let expanded = 0;
  let found = false;
  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) {
      found = true;
      break;
    }
    if (++expanded >= maxNodes) break;
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!grid.free(nx, ny)) continue;
      const k = ny * cols + nx;
      if (closed[k]) continue;
      // A diagonal needs both of its orthogonal neighbors, or the route cuts
      // a corner the body clips on the way through.
      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal && (!grid.free(nx, cy) || !grid.free(cx, ny))) continue;
      const g = cost[cur]! + (diagonal ? Math.SQRT2 : 1);
      if (g >= cost[k]!) continue;
      cost[k] = g;
      cameFrom[k] = cur;
      open.push(k, g + octile(nx, ny, goalX, goalY));
    }
  }
  if (!found) return null;

  const back: number[] = [];
  for (let k = goal; k !== start; k = cameFrom[k]!) back.push(k);
  const pts: { x: number; y: number }[] = [{ x: fromX, y: fromY }];
  for (let i = back.length - 1; i >= 0; i--) {
    const k = back[i]!;
    const x = k % cols;
    pts.push({ x: center(x), y: center((k - x) / cols) });
  }

  // String-pull: keep only the points where the route has to bend, so a
  // follower walks its own line instead of tracing subcell centers.
  const route: { x: number; y: number }[] = [];
  let from = pts[0]!;
  let i = 1;
  while (i < pts.length) {
    let j = i;
    while (j + 1 < pts.length && lineOfSight(map, from.x, from.y, pts[j + 1]!.x, pts[j + 1]!.y, r)) j++;
    route.push(pts[j]!);
    from = pts[j]!;
    i = j + 1;
  }
  return route;
}
