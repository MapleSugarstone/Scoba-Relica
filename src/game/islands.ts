import type { Art } from "../engine/assets";
import type { Sheet } from "../engine/atlas";
import { TileMap, TILE, type GroundPainter } from "../engine/tilemap";
import { rngFrom } from "../sim/rng";
import { islandSheet, TILE_SRC } from "./islandart";
import { ZONE_DEFAULTS, zoneSpecies, type EncounterZone, type WorldDef } from "./world";

// A scatter of little islands in the ocean, joined by plank bridges. Islands
// are superellipse blobs on a loose lattice, so they come out rounded and
// varied but never so close that a bridge has nowhere to land.

/** Rows of cliff face hanging below an island's south edge. */
export const CLIFF_H = 2;
export const COLS = 46;
export const ROWS = 36;
/** Islands across and down. */
const GRID_X = 3;
const GRID_Y = 3;

export interface Island {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  cells: number[];
}

export interface IslandLayout {
  cols: number;
  rows: number;
  land: boolean[];
  deck: boolean[];
  islands: Island[];
  home: Island;
  spawn: { x: number; y: number };
}

/** The map itself: no art, no canvas, so it can be checked without a browser. */
export function islandLayout(seed: string): IslandLayout {
  const rng = rngFrom(seed + ":islands");
  const land: boolean[] = new Array(COLS * ROWS).fill(false);
  const deck: boolean[] = new Array(COLS * ROWS).fill(false);

  const cellW = COLS / GRID_X;
  const cellH = ROWS / GRID_Y;
  const islands: Island[] = [];

  for (let gy = 0; gy < GRID_Y; gy++) {
    for (let gx = 0; gx < GRID_X; gx++) {
      const cx = Math.round((gx + 0.5) * cellW + (rng() - 0.5) * 3);
      const cy = Math.round((gy + 0.5) * cellH + (rng() - 0.5) * 2) - 1;
      const rx = 2.6 + rng() * 2.2;
      const ry = 2.2 + rng() * 1.4;
      const cells: number[] = [];
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          if (x < 1 || y < 1 || x >= COLS - 1 || y >= ROWS - CLIFF_H - 1) continue;
          const nx = (x - cx) / rx;
          const ny = (y - cy) / ry;
          // Cubed rather than squared: a rounded rectangle, not an ellipse.
          if (Math.abs(nx) ** 3 + Math.abs(ny) ** 3 > 1) continue;
          land[y * COLS + x] = true;
          cells.push(y * COLS + x);
        }
      }
      islands.push({ cx, cy, rx, ry, cells });
    }
  }

  // Bridge every island to its neighbour east and south of it. Both ends sit
  // on a row (or column) the two islands share, so a deck never starts on a
  // cliff face or in open water.
  const bridge = (a: Island, b: Island, dir: "e" | "s"): void => {
    if (dir === "e") {
      const lo = Math.max(Math.round(a.cy - a.ry + 1), Math.round(b.cy - b.ry + 1));
      const hi = Math.min(Math.round(a.cy + a.ry - 1), Math.round(b.cy + b.ry - 1));
      if (hi < lo) return;
      const row = Math.floor((lo + hi) / 2);
      for (let x = a.cx; x <= b.cx; x++) {
        if (!land[row * COLS + x]) deck[row * COLS + x] = true;
      }
    } else {
      const lo = Math.max(Math.round(a.cx - a.rx + 1), Math.round(b.cx - b.rx + 1));
      const hi = Math.min(Math.round(a.cx + a.rx - 1), Math.round(b.cx + b.rx - 1));
      if (hi < lo) return;
      const col = Math.floor((lo + hi) / 2);
      for (let y = a.cy; y <= b.cy; y++) {
        if (!land[y * COLS + col]) deck[y * COLS + col] = true;
      }
    }
  };

  for (let gy = 0; gy < GRID_Y; gy++) {
    for (let gx = 0; gx < GRID_X; gx++) {
      const here = islands[gy * GRID_X + gx]!;
      if (gx + 1 < GRID_X) bridge(here, islands[gy * GRID_X + gx + 1]!, "e");
      if (gy + 1 < GRID_Y) bridge(here, islands[(gy + 1) * GRID_X + gx]!, "s");
    }
  }

  // A land cell with water both east and west has no tile that can draw it:
  // the set has one side edge, not a two-sided sliver. Shave those spits off
  // until none are left, and drop them from the island they came from.
  for (let pass = 0; pass < 4; pass++) {
    const doomed: number[] = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        if (!land[i]) continue;
        const w = x > 0 && land[i - 1];
        const e = x < COLS - 1 && land[i + 1];
        if (!w && !e) doomed.push(i);
      }
    }
    if (doomed.length === 0) break;
    for (const i of doomed) land[i] = false;
    for (const island of islands) island.cells = island.cells.filter((c) => land[c]);
  }

  const home = islands[Math.floor(islands.length / 2)]!;
  return {
    cols: COLS,
    rows: ROWS,
    land,
    deck,
    islands,
    home,
    spawn: { x: home.cx * TILE + TILE / 2, y: home.cy * TILE + TILE / 2 },
  };
}

export function buildIslandWorld(art: Art, seed: string): WorldDef {
  const rng = rngFrom(seed + ":islandProps");
  const { land, deck, islands, home, spawn } = islandLayout(seed);
  const map = new TileMap(COLS, ROWS);

  // Walk on land and on planks; everything else is water or cliff face.
  for (let i = 0; i < COLS * ROWS; i++) map.solid[i] = !land[i] && !deck[i];

  const sheet = islandSheet(art);
  map.painter = islandPainter(sheet, land, deck);

  // Scenery: bushes and barrels inland, never where a bridge meets the shore.
  const nearDeck = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        if (deck[ny * COLS + nx]) return true;
      }
    }
    return false;
  };

  for (const island of islands) {
    for (const cell of island.cells) {
      const x = cell % COLS;
      const y = Math.floor(cell / COLS);
      if (nearDeck(x, y)) continue;
      if (Math.hypot(x * TILE - spawn.x, y * TILE - spawn.y) < 3 * TILE) continue;
      const roll = rng();
      if (roll > 0.94) placeProp(map, sheet, "bush", x, y);
      else if (roll > 0.91) placeProp(map, sheet, "barrel", x, y);
    }
  }

  // The special Scoba's nest, on the island the pair start from.
  placeProp(map, sheet, "nest", home.cx + 2, home.cy);

  // Wilds on the islands away from home.
  const encounters: EncounterZone[] = [];
  // Cottlequeen never comes alone: meeting one is meeting her court as well,
  // which is what makes a Pawn something you run into rather than read about.
  const pool = ["catsquito", "meepa", "cactunny", "cottlequeen"];
  islands.forEach((island, i) => {
    if (island === home || i % 2 === 1) return;
    encounters.push({
      x: (island.cx - island.rx) * TILE,
      y: (island.cy - island.ry) * TILE,
      w: island.rx * 2 * TILE,
      h: island.ry * 2 * TILE,
      max: ZONE_DEFAULTS.zoneMax,
      species: pool.map((id) => ({
        ...zoneSpecies(id),
        minLv: 2 + Math.floor(i / 3),
        maxLv: 4 + Math.floor(i / 3),
      })),
    });
  });

  return { map, spawn, encounters, layout: { land, deck } };
}

/** The prop kinds a map (procgen or content) can place, all one tile wide. */
export const PROP_KINDS = ["bush", "barrel", "nest"] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export function placeProp(map: TileMap, sheet: Sheet, kind: PropKind, cx: number, cy: number): void {
  const x = cx * TILE;
  const y = cy * TILE;
  const spot = sheet.at(kind);
  if (!spot) return;
  map.props.push({
    img: sheet.canvas,
    sx: spot.x, sy: spot.y, sw: TILE_SRC, sh: TILE_SRC,
    x, y, dw: TILE, dh: TILE,
    baseY: y + TILE - 2,
    solid: kind === "barrel" ? { x: x + 5, y: y + 6, w: 6, h: 7 } : undefined,
    kind,
  });
  if (kind === "nest") map.interactables.push({ x: x + 8, y: y + 12, r: 22, id: "nest" });
}

export function islandPainter(
  sheet: Sheet, land: boolean[], deck: boolean[], cols = COLS, rows = ROWS,
): GroundPainter {
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < cols && y < rows && land[y * cols + x]!;
  const onDeck = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < cols && y < rows && deck[y * cols + x]!;

  return (_map, ctx, camX, camY, viewW, viewH) => {
    const put = (key: string, cx: number, cy: number): void => {
      const spot = sheet.at(key);
      if (!spot) return;
      ctx.drawImage(
        sheet.canvas, spot.x, spot.y, TILE_SRC, TILE_SRC,
        Math.round(cx * TILE - camX), Math.round(cy * TILE - camY), TILE, TILE,
      );
    };
    const x0 = Math.max(0, Math.floor(camX / TILE));
    const y0 = Math.max(0, Math.floor(camY / TILE));
    const x1 = Math.min(cols - 1, Math.ceil((camX + viewW) / TILE));
    const y1 = Math.min(rows - 1, Math.ceil((camY + viewH) / TILE));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Turning the one water tile keeps a wide ocean from reading as a grid.
        put(`sea${(x * 7 + y * 5) % 4}`, x, y);
      }
    }

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!at(x, y)) continue;
        const n = at(x, y - 1);
        const w = at(x - 1, y);
        const e = at(x + 1, y);
        // The south side is left to the cliff, so it never takes a rim here.
        if (!n && !w) put("cornerNW", x, y);
        else if (!n && !e) put("cornerNE", x, y);
        else if (!n) put("edgeN", x, y);
        else if (!w) put("edgeW", x, y);
        else if (!e) put("edgeE", x, y);
        else put(`dirt${(x * 5 + y * 3) % 4}`, x, y);
      }
    }

    for (let y = y0; y <= y1 + CLIFF_H; y++) {
      for (let x = x0; x <= x1; x++) {
        if (at(x, y)) continue;
        for (let d = 0; d < CLIFF_H; d++) {
          if (!at(x, y - 1 - d)) continue;
          const w = at(x - 1, y - 1 - d);
          const e = at(x + 1, y - 1 - d);
          const last = d === CLIFF_H - 1;
          const suffix = !w ? "W" : !e ? "E" : "";
          put(last ? `cliffEnd${suffix}` : `cliff${suffix}`, x, y);
          break;
        }
      }
    }

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!onDeck(x, y)) continue;
        const across = onDeck(x - 1, y) || onDeck(x + 1, y) || at(x - 1, y) || at(x + 1, y);
        put(across ? "bridgeH" : "bridgeV", x, y);
        // The cap belongs on the shore tile, not the last plank: an island's
        // east, west and north edges hold their dirt a quarter tile in from
        // the cell boundary, so a cap stopping at the water would leave a gap.
        // Its south edge runs flush to the boundary, where the cliff takes
        // over, so a bridge arriving from the north caps on the water instead.
        if (across) {
          if (!onDeck(x - 1, y)) put("capW", at(x - 1, y) ? x - 1 : x, y);
          if (!onDeck(x + 1, y)) put("capE", at(x + 1, y) ? x + 1 : x, y);
        } else {
          if (!onDeck(x, y - 1)) put("capN", x, y);
          if (!onDeck(x, y + 1)) put("capS", x, at(x, y + 1) ? y + 1 : y);
        }
      }
    }
  };
}
