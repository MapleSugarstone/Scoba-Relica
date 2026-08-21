import { describe, expect, it } from "vitest";
import { islandLayout } from "../src/game/islands";
import { TILE } from "../src/engine/tilemap";

const SEEDS = ["seed1", "kx91z", "aaaa", "9f2b", "islands", "zzz"];

/** Everything a walker can reach from the spawn, over land and planks. */
function reachable(cols: number, rows: number, open: boolean[], from: number): Set<number> {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const x = at % cols;
    const y = Math.floor(at / cols);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const next = ny * cols + nx;
      if (!open[next] || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

describe("islandLayout", () => {
  it("spawns on land", () => {
    for (const seed of SEEDS) {
      const l = islandLayout(seed);
      const cell = Math.floor(l.spawn.y / TILE) * l.cols + Math.floor(l.spawn.x / TILE);
      expect(l.land[cell], seed).toBe(true);
    }
  });

  it("never leaves a land cell the tileset cannot draw", () => {
    // One side edge exists, so a cell with water to both east and west would
    // have to draw a two-sided sliver that was never drawn.
    for (const seed of SEEDS) {
      const l = islandLayout(seed);
      for (let y = 0; y < l.rows; y++) {
        for (let x = 0; x < l.cols; x++) {
          if (!l.land[y * l.cols + x]) continue;
          const w = x > 0 && l.land[y * l.cols + x - 1];
          const e = x < l.cols - 1 && l.land[y * l.cols + x + 1];
          expect(w || e, `${seed} @ ${x},${y}`).toBe(true);
        }
      }
    }
  });

  it("bridges every island to the one the players start on", () => {
    for (const seed of SEEDS) {
      const l = islandLayout(seed);
      const open = l.land.map((v, i) => v || l.deck[i]!);
      const start = Math.floor(l.spawn.y / TILE) * l.cols + Math.floor(l.spawn.x / TILE);
      const seen = reachable(l.cols, l.rows, open, start);
      for (const island of l.islands) {
        expect(island.cells.length, seed).toBeGreaterThan(4);
        expect(island.cells.some((c) => seen.has(c)), `${seed} island at ${island.cx},${island.cy}`).toBe(true);
      }
    }
  });

  it("keeps planks off the land they connect", () => {
    for (const seed of SEEDS) {
      const l = islandLayout(seed);
      for (let i = 0; i < l.land.length; i++) {
        expect(l.land[i] && l.deck[i], seed).toBeFalsy();
      }
    }
  });
});
