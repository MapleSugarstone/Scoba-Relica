import { TILE, type TileMap } from "../engine/tilemap";

// BFS over the sub-tile collision grid (3x3 subcells per tile, the same
// resolution fences block at). Cheap enough to run on demand when a follower
// gets stuck; the node cap keeps worst-case cost bounded.
const SUB = TILE / 3;

// Radius-aware: a subcell only counts as walkable if a follower's body fits,
// otherwise BFS threads gaps narrower than the actor and the path jams.
const BODY = 3.5;

function walkable(map: TileMap, sx: number, sy: number, r = BODY): boolean {
  if (sx < 0 || sy < 0 || sx >= map.cols * 3 || sy >= map.rows * 3) return false;
  const cx = sx * SUB + SUB / 2;
  const cy = sy * SUB + SUB / 2;
  if (map.isSolidAt(cx, cy)) return false;
  if (r <= 0) return true;
  return !(
    map.isSolidAt(cx - r, cy) || map.isSolidAt(cx + r, cy) ||
    map.isSolidAt(cx, cy - r) || map.isSolidAt(cx, cy + r)
  );
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
  const steps = Math.ceil(Math.hypot(dx, dy) / (SUB / 2));
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (dx * i) / steps;
    const y = y0 + (dy * i) / steps;
    if (
      map.isSolidAt(x, y) ||
      map.isSolidAt(x - r, y) || map.isSolidAt(x + r, y) ||
      map.isSolidAt(x, y - r) || map.isSolidAt(x, y + r)
    ) return false;
  }
  return true;
}

/** Closest walkable subcell to (sx, sy) within `range` rings, or null. */
function nearestWalkable(map: TileMap, sx: number, sy: number, range: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let ring = 1; ring <= range && !best; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        if (!walkable(map, sx + dx, sy + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x: sx + dx, y: sy + dy };
        }
      }
    }
  }
  return best;
}

/**
 * Shortest 4-directional path between two world points, as world-px
 * waypoints (subcell centers, collinear points dropped). Null when there is
 * no route within `maxNodes` or an endpoint is blocked. With `near`, a
 * blocked goal slides to the closest walkable subcell within two tiles, so a
 * follower can head for "beside the player" when the player hugs a wall.
 */
export function findPath(
  map: TileMap,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  opts: { near?: boolean; maxNodes?: number } = {},
): { x: number; y: number }[] | null {
  const maxNodes = opts.maxNodes ?? 4000;
  const cols = map.cols * 3;
  const start = { x: Math.floor(fromX / SUB), y: Math.floor(fromY / SUB) };
  let goal = { x: Math.floor(toX / SUB), y: Math.floor(toY / SUB) };
  // The start cell skips the body check so a wedged follower can still escape.
  if (!walkable(map, start.x, start.y, 0)) return null;
  if (!walkable(map, goal.x, goal.y)) {
    const g = opts.near ? nearestWalkable(map, goal.x, goal.y, 6) : null;
    if (!g) return null;
    goal = g;
  }
  if (start.x === goal.x && start.y === goal.y) return [];

  const key = (x: number, y: number): number => y * cols + x;
  const cameFrom = new Map<number, number>();
  cameFrom.set(key(start.x, start.y), -1);
  let frontier = [start];
  let found = false;
  let expanded = 0;

  while (frontier.length > 0 && !found && expanded < maxNodes) {
    const next: { x: number; y: number }[] = [];
    for (const cur of frontier) {
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const k = key(nx, ny);
        if (cameFrom.has(k) || !walkable(map, nx, ny)) continue;
        cameFrom.set(k, key(cur.x, cur.y));
        expanded += 1;
        if (nx === goal.x && ny === goal.y) {
          found = true;
          break;
        }
        next.push({ x: nx, y: ny });
      }
      if (found) break;
    }
    frontier = next;
  }
  if (!found) return null;

  const path: { x: number; y: number }[] = [];
  let k = key(goal.x, goal.y);
  while (k !== -1) {
    const x = k % cols;
    const y = Math.floor(k / cols);
    path.push({ x: x * SUB + SUB / 2, y: y * SUB + SUB / 2 });
    k = cameFrom.get(k)!;
  }
  path.reverse();

  // Drop collinear midpoints so followers walk straight runs smoothly.
  const simplified: { x: number; y: number }[] = [];
  for (let i = 0; i < path.length; i++) {
    const prev = simplified[simplified.length - 1];
    const next = path[i + 1];
    const cur = path[i]!;
    if (prev && next && ((prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y))) continue;
    simplified.push(cur);
  }
  return simplified;
}
