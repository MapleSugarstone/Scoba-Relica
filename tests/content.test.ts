import { describe, expect, it } from "vitest";
import {
  blankMap, cellMask, decodeTerrain, emptyContent, encodeTerrain, normalizeContent,
  padById, pads, resizeMap, setCollisionAt, setTerrainAt, teleportTarget, terrainAt,
} from "../src/game/content";
import { COLS, ROWS, islandLayout } from "../src/game/islands";
import { SUB_FULL, TILE } from "../src/engine/tilemap";
import type { Art } from "../src/engine/assets";

/** The tile catalog only reads `tiles` off the art, so a bare stub is enough. */
const art = { tiles: {} } as unknown as Art;

describe("terrain codec", () => {
  it("round-trips a procgen layout", () => {
    const layout = islandLayout("codec-seed");
    const rows = encodeTerrain(layout.land, layout.deck);
    expect(rows).toHaveLength(ROWS);
    expect(rows.every((r) => r.length === COLS)).toBe(true);
    const back = decodeTerrain(rows);
    expect(back.land).toEqual(layout.land);
    expect(back.deck).toEqual(layout.deck);
  });

  it("derives solids from terrain with overrides on top", () => {
    const layout = islandLayout("codec-seed");
    const c = emptyContent();
    const m = blankMap("island", "Island", COLS, ROWS);
    m.terrain = encodeTerrain(layout.land, layout.deck);
    c.maps = [m];
    // A land cell forced solid, a water cell forced open.
    const landIdx = layout.land.findIndex((v) => v);
    const waterIdx = layout.land.findIndex((v, i) => !v && !layout.deck[i]);
    setCollisionAt(m, landIdx % COLS, Math.floor(landIdx / COLS), "s");
    setCollisionAt(m, waterIdx % COLS, Math.floor(waterIdx / COLS), "o");
    const blocked = (i: number): boolean =>
      cellMask(art, c, m, layout.land, layout.deck, i % COLS, Math.floor(i / COLS)) === SUB_FULL;
    expect(blocked(landIdx)).toBe(true);
    expect(blocked(waterIdx)).toBe(false);
    // Everywhere else: water solid, land and decks walkable.
    for (let i = 0; i < COLS * ROWS; i++) {
      if (i === landIdx || i === waterIdx) continue;
      expect(blocked(i)).toBe(!layout.land[i] && !layout.deck[i]);
    }
  });

  it("refuses land where the tileset has no pieces", () => {
    const m = blankMap("m", "M", COLS, ROWS);
    setTerrainAt(m, 0, 5, "l"); // border column
    setTerrainAt(m, 5, ROWS - 1, "l"); // cliff rows
    setTerrainAt(m, 5, 5, "l");
    expect(terrainAt(m, 0, 5)).toBe("w");
    expect(terrainAt(m, 5, ROWS - 1)).toBe("w");
    expect(terrainAt(m, 5, 5)).toBe("l");
  });
});

describe("map sizing", () => {
  it("starts blank at the size it was asked for", () => {
    const m = blankMap("m", "M", 12, 9);
    expect(m.terrain).toHaveLength(9);
    expect(m.terrain.every((r) => r === "w".repeat(12))).toBe(true);
  });

  it("crops what falls outside and pads with water", () => {
    const m = blankMap("m", "M", 12, 9);
    setTerrainAt(m, 5, 5, "l");
    m.tiles.ground = { "3,3": "dirt0", "10,8": "dirt0" };
    m.subCollision = { "3,3": 7, "11,2": 7 };
    m.props = [{ kind: "bush", cx: 2, cy: 2 }, { kind: "bush", cx: 11, cy: 2 }];

    resizeMap(m, 8, 6);
    expect(m.cols).toBe(8);
    expect(m.rows).toBe(6);
    expect(m.terrain).toHaveLength(6);
    expect(m.terrain.every((r) => r.length === 8)).toBe(true);
    expect(terrainAt(m, 5, 5)).toBe("l");
    expect(m.tiles.ground).toEqual({ "3,3": "dirt0" });
    expect(m.subCollision).toEqual({ "3,3": 7 });
    expect(m.props).toEqual([{ kind: "bush", cx: 2, cy: 2 }]);

    resizeMap(m, 10, 8);
    expect(m.terrain[7]).toBe("w".repeat(10));
    expect(m.terrain[0]!.length).toBe(10);
  });
});

describe("normalizeContent", () => {
  it("returns empty content for garbage", () => {
    expect(normalizeContent(null)).toEqual(emptyContent());
    expect(normalizeContent("nope")).toEqual(emptyContent());
    expect(normalizeContent({ maps: [{ terrain: ["ll", "l"] }] }).maps).toEqual([]);
  });

  it("reads a map's size off its own terrain rows", () => {
    const c = normalizeContent({
      maps: [{ id: "cave", name: "Cave", terrain: ["wwwww", "wlllw", "wwwww"] }],
    });
    expect(c.maps).toHaveLength(1);
    expect(c.maps[0]).toMatchObject({ id: "cave", name: "Cave", cols: 5, rows: 3 });
    expect(c.startMap).toBe("cave");
  });

  it("drops a second map claiming an id already taken", () => {
    const c = normalizeContent({
      maps: [
        { id: "a", terrain: ["ww", "ww"] },
        { id: "a", terrain: ["lll", "lll"] },
        { id: "b", terrain: ["ww", "ww"] },
      ],
      startMap: "b",
    });
    expect(c.maps.map((m) => m.id)).toEqual(["a", "b"]);
    expect(c.maps[0]!.cols).toBe(2);
    expect(c.startMap).toBe("b");
  });

  it("falls back to the first map when startMap names nothing", () => {
    const c = normalizeContent({ maps: [{ id: "a", terrain: ["ww", "ww"] }], startMap: "gone" });
    expect(c.startMap).toBe("a");
  });

  it("lifts a pre-multi-map document into one map", () => {
    const terrain = new Array<string>(ROWS).fill("w".repeat(COLS));
    const c = normalizeContent({
      version: 1,
      terrain,
      tiles: { "3,4": "dirt0" },
      subCollision: { "3,4": 5 },
      spawn: { x: 10, y: 20 },
      npcs: [{ id: "a", name: "A", x: 1, y: 2, skin: {}, lines: [], wander: 0 }],
      quests: [{ id: "q", steps: [{ kind: "reach", x: 1, y: 2 }] }],
    });
    expect(c.maps).toHaveLength(1);
    expect(c.maps[0]).toMatchObject({ id: "island", cols: COLS, rows: ROWS });
    expect(c.maps[0]!.tiles.ground).toEqual({ "3,4": "dirt0" });
    expect(c.maps[0]!.spawn).toEqual({ x: 10, y: 20 });
    // Everything that had no map before belongs to the one map there now.
    expect(c.npcs[0]!.map).toBe("island");
    expect(c.quests[0]!.steps[0]).toMatchObject({ kind: "reach", map: "island" });
  });

  it("stays procedural when a v1 document never had terrain", () => {
    const c = normalizeContent({ version: 1, terrain: null, npcs: [], quests: [] });
    expect(c.maps).toEqual([]);
    expect(c.startMap).toBe("");
  });

  it("keeps valid npcs and quests, drops broken ones", () => {
    const c = normalizeContent({
      maps: [{ id: "m", terrain: ["ww", "ww"] }],
      npcs: [
        { id: "a", name: "A", map: "m", x: 1, y: 2, skin: { kind: "villager", look: {} }, lines: ["hi"], wander: 5 },
        { name: "no id", x: 1, y: 2 },
        {
          id: "t", x: 3, y: 4,
          trainer: { team: [{ species: "plib", level: 3 }], reward: 10, intro: [], beaten: [] },
        },
      ],
      quests: [
        {
          id: "q", name: "Q",
          steps: [
            { kind: "talk", npcId: "a", lines: ["x"] },
            { kind: "reach", x: 10, y: 20 },
            { kind: "defeat", npcId: "t", intro: [] },
            { kind: "nonsense" },
          ],
        },
        { name: "no id" },
      ],
    });
    expect(c.npcs.map((n) => n.id)).toEqual(["a", "t"]);
    expect(c.npcs[1]!.trainer?.team).toEqual([{ species: "plib", level: 3 }]);
    expect(c.quests).toHaveLength(1);
    expect(c.quests[0]!.steps).toHaveLength(3);
    expect(c.quests[0]!.steps[1]).toEqual({ kind: "reach", map: "m", x: 10, y: 20, r: 24, label: "" });
  });

  it("keeps cell data only where it names a real kind", () => {
    const c = normalizeContent({
      maps: [{
        id: "m",
        terrain: ["wwww", "wwww", "wwww", "wwww"],
        cellData: {
          "1,1": { kind: "teleport", map: "cave", x: 8, y: 9 },
          "2,2": { kind: "sentinel", cond: "trainer", count: 3, radius: 200, npcId: "npc1", label: "Halt." },
          "3,3": { kind: "nonsense" },
          "9,9": { kind: "teleport", map: "cave" },
        },
      }],
    });
    const cells = c.maps[0]!.cellData;
    expect(Object.keys(cells).sort()).toEqual(["1,1", "2,2"]);
    expect(cells["1,1"]).toEqual({ kind: "teleport", id: "pad1", link: "", map: "cave", x: 8, y: 9 });
    expect(cells["2,2"]).toEqual({
      kind: "sentinel", cond: "trainer", count: 3, radius: 200, npcId: "npc1", label: "Halt.",
    });
  });

  it("names every pad, breaking ties on a shared name", () => {
    const c = normalizeContent({
      maps: [
        {
          id: "a",
          terrain: ["wwww", "wwww"],
          cellData: {
            "0,0": { kind: "teleport", id: "door" },
            "1,0": { kind: "teleport" },
            "2,0": { kind: "teleport", id: "door" },
          },
        },
        {
          id: "b",
          terrain: ["ww", "ww"],
          cellData: { "0,0": { kind: "teleport", id: "pad1" } },
        },
      ],
    });
    const names = pads(c).map((pad) => pad.data.id);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("door");
    // The one that claimed "door" first keeps it; the other gets a new name.
    expect(c.maps[0]!.cellData["0,0"]).toMatchObject({ id: "door" });
    expect(c.maps[0]!.cellData["2,0"]).not.toMatchObject({ id: "door" });
  });

  it("drops a link to a pad that is not there", () => {
    const c = normalizeContent({
      maps: [{
        id: "a",
        terrain: ["ww", "ww"],
        cellData: { "0,0": { kind: "teleport", id: "here", link: "gone" } },
      }],
    });
    expect(c.maps[0]!.cellData["0,0"]).toMatchObject({ id: "here", link: "" });
  });

  it("floors a sentinel's numbers at something workable", () => {
    const c = normalizeContent({
      maps: [{
        id: "m",
        terrain: ["ww", "ww"],
        cellData: { "0,0": { kind: "sentinel", count: 0, radius: 1 } },
      }],
    });
    expect(c.maps[0]!.cellData["0,0"]).toMatchObject({ cond: "wild", count: 1, radius: TILE });
  });
});

describe("teleport links", () => {
  const linked = (): ReturnType<typeof normalizeContent> => normalizeContent({
    maps: [
      {
        id: "island",
        terrain: ["wwwwww", "wwwwww", "wwwwww"],
        cellData: { "2,1": { kind: "teleport", id: "mouth", link: "throat" } },
      },
      {
        id: "cave",
        terrain: ["wwww", "wwww", "wwww", "wwww"],
        spawn: { x: 32, y: 32 },
        cellData: { "1,3": { kind: "teleport", id: "throat", link: "mouth" } },
      },
    ],
    startMap: "island",
  });

  it("finds a pad anywhere in the world by name", () => {
    const c = linked();
    expect(pads(c).map((p) => p.data.id).sort()).toEqual(["mouth", "throat"]);
    expect(padById(c, "throat")!.map.id).toBe("cave");
    expect(padById(c, "nobody")).toBeNull();
  });

  it("sends you to the middle of the pad it links to", () => {
    const c = linked();
    const to = teleportTarget(c, padById(c, "mouth")!.data)!;
    // Pad "throat" sits at cell 1,3 on the cave.
    expect(to).toEqual({ map: "cave", x: 1 * TILE + TILE / 2, y: 3 * TILE + TILE / 2 });
  });

  it("follows a pad that moves, since only the name is stored", () => {
    const c = linked();
    const throat = padById(c, "throat")!;
    delete throat.map.cellData["1,3"];
    throat.map.cellData["3,0"] = throat.data;
    const to = teleportTarget(c, padById(c, "mouth")!.data)!;
    expect(to).toEqual({ map: "cave", x: 3 * TILE + TILE / 2, y: 0 * TILE + TILE / 2 });
  });

  it("falls back to a plain place when nothing is linked", () => {
    const c = normalizeContent({
      maps: [
        { id: "a", terrain: ["ww", "ww"], cellData: { "0,0": { kind: "teleport", id: "p", map: "b", x: 7, y: 9 } } },
        { id: "b", terrain: ["ww", "ww"], spawn: { x: 16, y: 16 } },
      ],
    });
    expect(teleportTarget(c, padById(c, "p")!.data)).toEqual({ map: "b", x: 7, y: 9 });
  });

  it("arrives on the map's spawn when the place has no point", () => {
    const c = normalizeContent({
      maps: [
        { id: "a", terrain: ["ww", "ww"], cellData: { "0,0": { kind: "teleport", id: "p", map: "b" } } },
        { id: "b", terrain: ["ww", "ww"], spawn: { x: 24, y: 40 } },
      ],
    });
    expect(teleportTarget(c, padById(c, "p")!.data)).toEqual({ map: "b", x: 24, y: 40 });
  });

  it("has nowhere to send you when it names neither", () => {
    const c = normalizeContent({
      maps: [{ id: "a", terrain: ["ww", "ww"], cellData: { "0,0": { kind: "teleport", id: "p" } } }],
    });
    expect(teleportTarget(c, padById(c, "p")!.data)).toBeNull();
  });
});
