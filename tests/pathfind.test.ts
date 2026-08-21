import { describe, expect, it } from "vitest";
import { TileMap, TILE } from "../src/engine/tilemap";
import { findPath } from "../src/game/pathfind";

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
});
