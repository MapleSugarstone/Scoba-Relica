import { describe, expect, it } from "vitest";
import { maskHas, maskWith, SUB_FULL, TileMap, TILE } from "../src/engine/tilemap";
import { maskOf } from "../src/game/islandart";
import type { Art } from "../src/engine/assets";
import {
  blankMap, cellMask, drawnTileAt, emptyContent, normalizeContent, setCellDataAt,
  setCollisionAt, setSubAt, setTileAt, stackAt, tileLayer, tileMask,
} from "../src/game/content";
import { COLS, ROWS } from "../src/game/islands";

/** The tile catalog only reads `tiles` off the art, so a bare stub is enough. */
const art = { tiles: {} } as unknown as Art;

/** Center of subcell (sx, sy) inside tile (cx, cy), in world px. */
function subPoint(cx: number, cy: number, sx: number, sy: number): { x: number; y: number } {
  const step = TILE / 3;
  return { x: cx * TILE + (sx + 0.5) * step, y: cy * TILE + (sy + 0.5) * step };
}

describe("mask helpers", () => {
  it("reads a written mask top row first", () => {
    expect(maskOf("#.. ... ...")).toBe(1);
    expect(maskOf("... ### ...")).toBe(0b000111000);
    expect(maskOf("### ### ###")).toBe(SUB_FULL);
    expect(maskOf("... ... ..#")).toBe(1 << 8);
  });

  it("sets and reads one subcell", () => {
    let m = 0;
    m = maskWith(m, 2, 1, true);
    expect(maskHas(m, 2, 1)).toBe(true);
    expect(maskHas(m, 1, 2)).toBe(false);
    expect(maskWith(m, 2, 1, false)).toBe(0);
  });
});

describe("TileMap subcell collision", () => {
  it("blocks only the subcells the mask names", () => {
    const map = new TileMap(6, 6);
    map.setCellMask(2, 2, maskOf("... ### ..."));
    for (let sx = 0; sx < 3; sx++) {
      const mid = subPoint(2, 2, sx, 1);
      expect(map.isSolidAt(mid.x, mid.y)).toBe(true);
      const top = subPoint(2, 2, sx, 0);
      expect(map.isSolidAt(top.x, top.y)).toBe(false);
    }
  });

  it("keeps the whole-tile flag in step with a full mask", () => {
    const map = new TileMap(6, 6);
    map.setCellMask(3, 3, SUB_FULL);
    expect(map.solid[map.idx(3, 3)]).toBe(true);
    expect(map.subSolid.has(map.idx(3, 3))).toBe(false);
    expect(map.cellMask(3, 3)).toBe(SUB_FULL);

    map.setCellMask(3, 3, 0);
    expect(map.solid[map.idx(3, 3)]).toBe(false);
    expect(map.subSolid.has(map.idx(3, 3))).toBe(false);
    expect(map.cellMask(3, 3)).toBe(0);
  });

  it("round-trips a partial mask", () => {
    const map = new TileMap(6, 6);
    const m = maskOf(".#. .#. ...");
    map.setCellMask(1, 1, m);
    expect(map.cellMask(1, 1)).toBe(m);
    expect(map.solid[map.idx(1, 1)]).toBe(false);
  });
});

describe("cellMask sources", () => {
  const land = new Array<boolean>(COLS * ROWS).fill(false);
  const deck = new Array<boolean>(COLS * ROWS).fill(false);
  land[5 * COLS + 5] = true;
  const fresh = (): { c: ReturnType<typeof emptyContent>; m: ReturnType<typeof blankMap> } => {
    const c = emptyContent();
    const m = blankMap("island", "Island", COLS, ROWS);
    c.maps = [m];
    c.startMap = m.id;
    return { c, m };
  };

  it("falls back to terrain", () => {
    const { c, m } = fresh();
    expect(cellMask(art, c, m, land, deck, 5, 5)).toBe(0);
    expect(cellMask(art, c, m, land, deck, 6, 5)).toBe(SUB_FULL);
  });

  it("takes a painted tile's rule over the terrain", () => {
    const { c, m } = fresh();
    setTileAt(m, "sort", 6, 5, "barrel");
    expect(cellMask(art, c, m, land, deck, 6, 5)).toBe(maskOf("... .#. ..."));
    c.tileRules["barrel"] = { solid: maskOf("### ... ...") };
    expect(cellMask(art, c, m, land, deck, 6, 5)).toBe(maskOf("### ... ..."));
  });

  it("takes a whole-tile override over the tile, and a painted cell over both", () => {
    const { c, m } = fresh();
    setTileAt(m, "sort", 6, 5, "barrel");
    setCollisionAt(m, 6, 5, "o");
    expect(cellMask(art, c, m, land, deck, 6, 5)).toBe(0);
    setSubAt(m, 6, 5, maskOf("... ... ###"));
    expect(cellMask(art, c, m, land, deck, 6, 5)).toBe(maskOf("... ... ###"));
    setSubAt(m, 6, 5, null);
    expect(cellMask(art, c, m, land, deck, 6, 5)).toBe(0);
  });

  it("opens a sentinel once its condition has been met", () => {
    const { c, m } = fresh();
    setTileAt(m, "sort", 6, 5, "sentinel");
    setCellDataAt(m, 6, 5, {
      kind: "sentinel", cond: "wild", count: 2, radius: 96, npcId: "", label: "",
    });
    const shut = (): boolean => false;
    const passed = (mapId: string, cell: string): boolean => mapId === "island" && cell === "6,5";
    expect(cellMask(art, c, m, land, deck, 6, 5, shut)).toBe(SUB_FULL);
    expect(drawnTileAt(m, "sort", 6, 5, shut)).toBe("sentinel");
    expect(cellMask(art, c, m, land, deck, 6, 5, passed)).toBe(0);
    expect(drawnTileAt(m, "sort", 6, 5, passed)).toBe("sentinel2");
  });

  it("opens a sentinel even where the cell was painted by hand", () => {
    const { c, m } = fresh();
    setTileAt(m, "sort", 6, 5, "sentinel");
    setCellDataAt(m, 6, 5, {
      kind: "sentinel", cond: "wild", count: 2, radius: 96, npcId: "", label: "",
    });
    // Shaping the gate's hitbox by hand is the point of hand-painting it, and
    // that shape has to leave with the gate or the way never opens.
    setSubAt(m, 6, 5, maskOf("... ... ###"));
    const shut = (): boolean => false;
    const passed = (): boolean => true;
    expect(cellMask(art, c, m, land, deck, 6, 5, shut)).toBe(maskOf("... ... ###"));
    expect(cellMask(art, c, m, land, deck, 6, 5, passed)).toBe(0);
  });

  it("keeps a hand mask on a cell with no sentinel on it", () => {
    const { c, m } = fresh();
    setTileAt(m, "sort", 6, 5, "barrel");
    setSubAt(m, 6, 5, maskOf("#.. ... ..."));
    expect(cellMask(art, c, m, land, deck, 6, 5, () => true)).toBe(maskOf("#.. ... ..."));
  });

  it("still blocks with the rest of the stack when a sentinel opens", () => {
    const { c, m } = fresh();
    setTileAt(m, "sort", 6, 5, "sentinel");
    setTileAt(m, "above", 6, 5, "sea0");
    setCellDataAt(m, 6, 5, {
      kind: "sentinel", cond: "wild", count: 1, radius: 96, npcId: "", label: "",
    });
    setSubAt(m, 6, 5, maskOf("... ... ###"));
    // The gate gives way; the wall stacked over it does not.
    expect(cellMask(art, c, m, land, deck, 6, 5, () => true)).toBe(SUB_FULL);
  });

  it("drops settings when a different kind of tile moves in", () => {
    const { m } = fresh();
    setTileAt(m, "overlay", 6, 5, "teleport");
    setCellDataAt(m, 6, 5, { kind: "teleport", id: "pad1", link: "", map: "cave", x: 1, y: 2 });
    setTileAt(m, "overlay", 6, 5, "sentinel");
    expect(m.cellData["6,5"]).toBeUndefined();
  });

  it("keeps settings while any layer still holds that kind", () => {
    const { m } = fresh();
    setTileAt(m, "overlay", 6, 5, "teleport");
    setCellDataAt(m, 6, 5, { kind: "teleport", id: "pad1", link: "", map: "cave", x: 1, y: 2 });
    // Laying ground under the pad must not take the pad's target with it.
    setTileAt(m, "ground", 6, 5, "dirt0");
    expect(m.cellData["6,5"]).toMatchObject({ id: "pad1" });
    setTileAt(m, "overlay", 6, 5, null);
    expect(m.cellData["6,5"]).toBeUndefined();
  });

  it("blocks with everything stacked on the cell", () => {
    const { c, m } = fresh();
    setTileAt(m, "ground", 6, 5, "dirt0");
    expect(cellMask(art, c, m, land, deck, 6, 5)).toBe(0);
    // A wall on top of walkable ground still walls it off.
    setTileAt(m, "sort", 6, 5, "barrel");
    expect(cellMask(art, c, m, land, deck, 6, 5)).toBe(maskOf("... .#. ..."));
    setTileAt(m, "above", 6, 5, "sea0");
    expect(cellMask(art, c, m, land, deck, 6, 5)).toBe(SUB_FULL);
  });

  it("lists what is stacked on a cell, bottom first", () => {
    const { m } = fresh();
    setTileAt(m, "above", 6, 5, "sea0");
    setTileAt(m, "ground", 6, 5, "dirt0");
    setTileAt(m, "sort", 6, 5, "bush");
    expect(stackAt(m, 6, 5)).toEqual([
      { layer: "ground", key: "dirt0" },
      { layer: "sort", key: "bush" },
      { layer: "above", key: "sea0" },
    ]);
  });

  it("reads tile rules with the tileset default underneath", () => {
    const { c } = fresh();
    expect(tileMask(art, c, "sea0")).toBe(SUB_FULL);
    expect(tileMask(art, c, "dirt0")).toBe(0);
    expect(tileLayer(art, c, "bush")).toBe("sort");
    expect(tileLayer(art, c, "dirt0")).toBe("ground");
    c.tileRules["dirt0"] = { layer: "above", solid: 5 };
    expect(tileMask(art, c, "dirt0")).toBe(5);
    expect(tileLayer(art, c, "dirt0")).toBe("above");
  });
});

describe("normalizeContent tile layers", () => {
  it("keeps on-map cells and drops the rest", () => {
    const c = normalizeContent({
      maps: [{
        id: "m",
        terrain: new Array<string>(ROWS).fill("w".repeat(COLS)),
        tiles: {
          ground: { "3,4": "dirt0", "999,0": "dirt0", "0,999": "dirt0", nope: "dirt0", "5,5": 7 },
          sort: { "2,2": "bush" },
        },
        subCollision: { "3,4": 1023, "1,1": "solid", "900,900": 1 },
      }],
      tileRules: { fence: { solid: 700, layer: "above" }, bush: { layer: "sort" }, junk: 5 },
    });
    expect(c.maps[0]!.tiles.ground).toEqual({ "3,4": "dirt0" });
    expect(c.maps[0]!.tiles.sort).toEqual({ "2,2": "bush" });
    expect(c.maps[0]!.subCollision).toEqual({ "3,4": SUB_FULL });
    expect(c.tileRules).toEqual({ fence: { solid: 188, layer: "above" }, bush: { layer: "sort" } });
  });

  it("leaves an unpainted world with every layer empty", () => {
    const c = normalizeContent({ maps: [{ id: "m", terrain: ["ww", "ww"] }] });
    expect(c.maps[0]!.tiles).toEqual({ ground: {}, overlay: {}, sort: {}, above: {} });
    expect(c.tileRules).toEqual({});
    expect(c.maps[0]!.subCollision).toEqual({});
  });

  it("splits a pre-layer document by what each tile said about standing up", () => {
    const c = normalizeContent({
      maps: [{
        id: "m",
        terrain: ["wwww", "wwww", "wwww", "wwww"],
        tiles: { "0,0": "dirt0", "1,0": "bush", "2,0": "capN", "3,0": "mystery" },
      }],
      tileRules: { capN: { tall: true } },
    });
    const tiles = c.maps[0]!.tiles;
    // Tileset defaults for the known ones, the old rule for capN, and art
    // nobody recognizes lands on sort, where it is at least visible.
    expect(tiles.ground).toEqual({ "0,0": "dirt0" });
    expect(tiles.sort).toEqual({ "1,0": "bush", "2,0": "capN", "3,0": "mystery" });
    expect(c.tileRules["capN"]).toEqual({ layer: "sort" });
  });
});
