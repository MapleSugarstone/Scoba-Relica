import { describe, expect, it } from "vitest";
import { SUB_PX, TileMap, TILE } from "../src/engine/tilemap";
import { maskOf } from "../src/game/islandart";
import { findPath, lineOfSight } from "../src/game/pathfind";

/** Length of a route walked from `from`, so a detour tells from a shortcut. */
function walked(from: { x: number; y: number }, path: { x: number; y: number }[]): number {
  let total = 0;
  let prev = from;
  for (const p of path) {
    total += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return total;
}

// 10x10 open map with a horizontal fence wall across row 5, gate at column 7.
function fencedMap(): TileMap {
  const map = new TileMap(10, 10);
  for (let x = 0; x < 10; x++) {
    if (x === 7) continue;
    map.fence[map.idx(x, 5)] = true;
  }
  map.finalizeFences();
  return map;
}

describe("findPath", () => {
  it("routes through the gate in a fence wall", () => {
    const map = fencedMap();
    const from = { x: 2 * TILE + 8, y: 2 * TILE + 8 };
    const to = { x: 2 * TILE + 8, y: 8 * TILE + 8 };
    const path = findPath(map, from.x, from.y, to.x, to.y);
    expect(path).not.toBeNull();
    // The path must swing through the gate column (tile 7).
    const throughGate = path!.some((p) => Math.floor(p.x / TILE) === 7);
    expect(throughGate).toBe(true);
  });

  it("returns null when the target is walled off", () => {
    const map = new TileMap(6, 6);
    // Solid ring around (4,4).
    for (const [x, y] of [[3, 3], [4, 3], [5, 3], [3, 4], [5, 4], [3, 5], [4, 5], [5, 5]]) {
      map.solid[map.idx(x!, y!)] = true;
    }
    const path = findPath(map, TILE + 8, TILE + 8, 4 * TILE + 8, 4 * TILE + 8);
    expect(path).toBeNull();
  });

  it("returns an empty path when start and goal share a subcell", () => {
    const map = new TileMap(4, 4);
    expect(findPath(map, 10, 10, 10.5, 10.4)).toEqual([]);
  });

  it("near: routes to beside a goal that sits inside a wall", () => {
    const map = new TileMap(6, 6);
    map.solid[map.idx(4, 4)] = true;
    const to = { x: 4 * TILE + 8, y: 4 * TILE + 8 };
    expect(findPath(map, TILE + 8, TILE + 8, to.x, to.y)).toBeNull();
    const path = findPath(map, TILE + 8, TILE + 8, to.x, to.y, { near: true });
    expect(path).not.toBeNull();
    const end = path![path!.length - 1]!;
    expect(Math.hypot(end.x - to.x, end.y - to.y)).toBeLessThan(TILE * 1.5);
  });

  it("near: still null when nothing walkable is in reach of the goal", () => {
    const map = new TileMap(12, 12);
    // Solid right half; goal deep inside it, farther than the search range.
    for (let y = 0; y < 12; y++) {
      for (let x = 6; x < 12; x++) map.solid[map.idx(x, y)] = true;
    }
    const path = findPath(map, TILE + 8, TILE + 8, 10 * TILE + 8, 6 * TILE + 8, { near: true });
    expect(path).toBeNull();
  });

  it("collapses an open straight run to one waypoint on the goal", () => {
    const map = new TileMap(12, 12);
    const to = { x: 9 * TILE + 8, y: 9 * TILE + 8 };
    const path = findPath(map, 2 * TILE + 8, 2 * TILE + 8, to.x, to.y);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(1);
    expect(Math.hypot(path![0]!.x - to.x, path![0]!.y - to.y)).toBeLessThan(SUB_PX);
  });

  it("turns one corner around a block in at most three waypoints", () => {
    const map = new TileMap(12, 12);
    map.solid[map.idx(6, 5)] = true;
    const from = { x: 2 * TILE + 8, y: 5 * TILE + 8 };
    const path = findPath(map, from.x, from.y, 9 * TILE + 8, 5 * TILE + 8, { radius: 3.5 })!;
    expect(path).not.toBeNull();
    expect(path.length).toBeLessThanOrEqual(3);
    for (const p of path) expect(map.circleHits(p.x, p.y, 3.5)).toBe(false);
  });

  it("keeps line of sight from one waypoint to the next", () => {
    const map = fencedMap();
    const from = { x: 2 * TILE + 8, y: 2 * TILE + 8 };
    const path = findPath(map, from.x, from.y, 2 * TILE + 8, 8 * TILE + 8, { radius: 3.5 })!;
    expect(path).not.toBeNull();
    let prev = from;
    for (const p of path) {
      expect(lineOfSight(map, prev.x, prev.y, p.x, p.y, 3.5)).toBe(true);
      prev = p;
    }
  });

  it("threads a gap the body fits and refuses one it does not", () => {
    const map = new TileMap(12, 12);
    for (let x = 0; x < 12; x++) map.solid[map.idx(x, 5)] = true;
    // Tile 6 keeps its right column solid: a hole two subcells wide, 10.7 px.
    map.setCellMask(6, 5, maskOf("..# ..# ..#"));
    const from = { x: 6 * TILE + 3, y: 2 * TILE + 8 };
    const to = { x: 6 * TILE + 3, y: 8 * TILE + 8 };
    const small = findPath(map, from.x, from.y, to.x, to.y, { radius: 2 })!;
    expect(small).not.toBeNull();
    for (const p of small) expect(map.circleHits(p.x, p.y, 2)).toBe(false);
    expect(small.some((p) => p.y > 5 * TILE + TILE)).toBe(true);
    expect(findPath(map, from.x, from.y, to.x, to.y, { radius: 6 })).toBeNull();
    // Sampling subcell centers costs up to half a subcell of clearance, so the
    // widest body this hole admits is 2.67 px rather than the 5.3 it fits.
    expect(findPath(map, from.x, from.y, to.x, to.y, { radius: 3 })).toBeNull();
  });

  it("refuses to cut the corner two blocks share", () => {
    const map = new TileMap(12, 12);
    map.solid[map.idx(5, 5)] = true;
    map.solid[map.idx(6, 6)] = true;
    const from = { x: 5 * TILE + 8, y: 6 * TILE + 8 };
    const to = { x: 6 * TILE + 8, y: 5 * TILE + 8 };
    expect(lineOfSight(map, from.x, from.y, to.x, to.y, 1)).toBe(false);
    const path = findPath(map, from.x, from.y, to.x, to.y, { radius: 1 })!;
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(1);
    // Straight through the shared corner is 22.6 px; around a block is far more.
    expect(walked(from, path)).toBeGreaterThan(TILE * 2.5);
  });

  it("gives up when the node cap is smaller than the route", () => {
    const map = fencedMap();
    const path = findPath(map, 2 * TILE + 8, 2 * TILE + 8, 2 * TILE + 8, 8 * TILE + 8, { maxNodes: 5 });
    expect(path).toBeNull();
  });
});

describe("lineOfSight", () => {
  it("stops at a fence rail and runs clear along open ground", () => {
    const map = fencedMap();
    expect(lineOfSight(map, 2 * TILE + 8, 2 * TILE + 8, 2 * TILE + 8, 8 * TILE + 8, 4)).toBe(false);
    expect(lineOfSight(map, 2 * TILE + 8, 2 * TILE + 8, 8 * TILE + 2, 2 * TILE + 8, 4)).toBe(true);
  });
});
