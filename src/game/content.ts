// The designed world, as one JSON document. Until the dev editor touches it,
// `maps` is empty and the world stays procedural per save seed; the editor's
// first save snapshots the generated world into a map, and from then on every
// map, its props, zones, spawn, NPCs and quests are authored data. Dev edits
// live in localStorage; Export downloads the JSON, and `import-world.cmd`
// writes it into `src/game/content/world.json`, which ships with the game.
import type { Art } from "../engine/assets";
import type { Look } from "../engine/recolor";
import { TileMap, TILE, SUB_FULL } from "../engine/tilemap";
import {
  cloneZone, ZONE_DEFAULTS, zoneSpecies,
  type EncounterZone, type WorldDef, type ZoneSpecies,
} from "./world";
import {
  COLS, ROWS, CLIFF_H,
  buildIslandWorld, islandPainter, placeProp,
  PROP_KINDS, type PropKind,
} from "./islands";
import {
  defaultLayerOf, islandSheet, LAYERS, specialOf, tileDescs, TILE_SRC,
  type LayerId, type TileDesc,
} from "./islandart";
import { currentSpecies } from "../sim/species";
import type { Sheet } from "../engine/atlas";

export interface PropDef {
  kind: PropKind;
  /** Tile coords. */
  cx: number;
  cy: number;
}

export type NpcSkin =
  | { kind: "villager"; look: Look }
  | { kind: "scoba"; species: string };

export interface TrainerDef {
  team: { species: string; level: number }[];
  /** Money for beating them. */
  reward: number;
  /** Said before a non-quest battle, and again on rematch attempts. */
  intro: string[];
  /** Replaces their chat once beaten. */
  beaten: string[];
}

export interface NpcDef {
  id: string;
  name: string;
  /** Which map they stand on. */
  map: string;
  /** World px. */
  x: number;
  y: number;
  skin: NpcSkin;
  /** Default chat when no quest wants them. */
  lines: string[];
  /** Wander radius in world px; 0 stands still. */
  wander: number;
  trainer?: TrainerDef;
}

export type QuestStep =
  | { kind: "talk"; npcId: string; lines: string[] }
  | { kind: "reach"; map: string; x: number; y: number; r: number; label: string }
  | { kind: "defeat"; npcId: string; intro: string[] };

export interface QuestDef {
  id: string;
  name: string;
  /** Quest id that must be complete before this one appears. */
  after?: string;
  steps: QuestStep[];
  reward?: { money?: number; items?: Record<string, number> };
}

/** Per-tile authoring: what a tile blocks and whether it stands up. */
export interface TileRule {
  /** 9-bit subcell mask, replacing the tileset's built-in default. */
  solid?: number;
  /** The layer the palette reaches for, replacing the tileset's own. */
  layer?: LayerId;
}

/** Where a teleport tile puts you. */
export interface TeleportData {
  kind: "teleport";
  /** Name for this pad, unique across the world, so another can point at it. */
  id: string;
  /** Pad id this one sends you to. Empty means it only receives. */
  link: string;
  /** Where to go when `link` is empty: a map, and a point on it. */
  map: string;
  x: number;
  y: number;
}

/**
 * What a sentinel tile waits for. It blocks until `count` qualifying wins have
 * happened within `radius` world px of the tile, then swaps to its open art
 * and stops blocking.
 */
export interface SentinelData {
  kind: "sentinel";
  cond: "wild" | "trainer";
  count: number;
  radius: number;
  /** For `trainer`, a specific NPC; empty counts any trainer in range. */
  npcId: string;
  /** Shown while it is still shut. */
  label: string;
}

export type CellData = TeleportData | SentinelData;

/** One map: its grid, everything painted on it, and where you arrive. */
export interface MapDef {
  id: string;
  name: string;
  cols: number;
  rows: number;
  /** `rows` strings of `cols` chars: 'w' water, 'l' land, 'b' bridge deck. */
  terrain: string[];
  /** Parallel grid of '.' auto, 's' solid, 'o' force open. null = all auto. */
  collision: string[] | null;
  /** Painted tiles, one sparse "cx,cy" -> tileset key record per draw layer. */
  tiles: Record<LayerId, Record<string, string>>;
  /** "cx,cy" -> 9-bit subcell mask, a collision painted by hand on one cell. */
  subCollision: Record<string, number>;
  /** "cx,cy" -> settings for the special tile painted there. */
  cellData: Record<string, CellData>;
  props: PropDef[];
  zones: EncounterZone[];
  spawn: { x: number; y: number };
}

export interface WorldContent {
  version: 2;
  /** Empty until the editor snapshots the procgen world. */
  maps: MapDef[];
  /** Map a new save opens on. */
  startMap: string;
  /** Tileset key -> collision and sorting, shared by every map. */
  tileRules: Record<string, TileRule>;
  npcs: NpcDef[];
  quests: QuestDef[];
}

export const DEV_CONTENT_KEY = "scoba-skeeple-devmode-content";

export function emptyContent(): WorldContent {
  return {
    version: 2,
    maps: [],
    startMap: "",
    tileRules: {},
    npcs: [],
    quests: [],
  };
}

/** True once the editor has taken ownership of the world. */
export function contentOwned(c: WorldContent): boolean {
  return c.maps.length > 0;
}

export function mapById(c: WorldContent, id: string): MapDef | null {
  return c.maps.find((m) => m.id === id) ?? null;
}

/** The map a save should be on: the one it names, else the start, else first. */
export function resolveMapId(c: WorldContent, want: string): string {
  if (mapById(c, want)) return want;
  if (mapById(c, c.startMap)) return c.startMap;
  return c.maps[0]?.id ?? "";
}

export function emptyLayers(): Record<LayerId, Record<string, string>> {
  return Object.fromEntries(LAYERS.map((l) => [l, {}])) as Record<LayerId, Record<string, string>>;
}

export function blankMap(id: string, name: string, cols: number, rows: number): MapDef {
  return {
    id,
    name,
    cols,
    rows,
    terrain: new Array<string>(rows).fill("w".repeat(cols)),
    collision: null,
    tiles: emptyLayers(),
    subCollision: {},
    cellData: {},
    props: [],
    zones: [],
    spawn: { x: (cols / 2) * TILE, y: (rows / 2) * TILE },
  };
}

/** Crop or pad every layer to a new size, dropping whatever falls outside. */
export function resizeMap(m: MapDef, cols: number, rows: number): void {
  const fit = (grid: string[], pad: string): string[] => {
    const out: string[] = [];
    for (let y = 0; y < rows; y++) {
      const row = grid[y] ?? "";
      out.push(row.length >= cols ? row.slice(0, cols) : row + pad.repeat(cols - row.length));
    }
    return out;
  };
  m.terrain = fit(m.terrain, "w");
  if (m.collision) m.collision = fit(m.collision, ".");
  const inside = (key: string): boolean => {
    const [cx, cy] = key.split(",").map(Number);
    return cx! < cols && cy! < rows;
  };
  const keep = <T,>(rec: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => inside(k)));
  for (const layer of LAYERS) m.tiles[layer] = keep(m.tiles[layer]);
  m.subCollision = keep(m.subCollision);
  m.cellData = keep(m.cellData);
  m.props = m.props.filter((p) => p.cx < cols && p.cy < rows);
  m.cols = cols;
  m.rows = rows;
  m.spawn = {
    x: Math.min(m.spawn.x, cols * TILE - TILE / 2),
    y: Math.min(m.spawn.y, rows * TILE - TILE / 2),
  };
}

// --- terrain and collision grid codecs ---

export function encodeTerrain(land: boolean[], deck: boolean[], cols = COLS, rows = ROWS): string[] {
  const out: string[] = [];
  for (let y = 0; y < rows; y++) {
    let row = "";
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      row += land[i] ? "l" : deck[i] ? "b" : "w";
    }
    out.push(row);
  }
  return out;
}

export function decodeTerrain(rows: string[], cols = COLS): { land: boolean[]; deck: boolean[] } {
  const h = rows.length;
  const land = new Array<boolean>(cols * h).fill(false);
  const deck = new Array<boolean>(cols * h).fill(false);
  for (let y = 0; y < h; y++) {
    const row = rows[y] ?? "";
    for (let x = 0; x < cols; x++) {
      const ch = row[x];
      if (ch === "l") land[y * cols + x] = true;
      else if (ch === "b") deck[y * cols + x] = true;
    }
  }
  return { land, deck };
}

export function collisionAt(m: MapDef, cx: number, cy: number): "s" | "o" | "." {
  const ch = m.collision?.[cy]?.[cx];
  return ch === "s" || ch === "o" ? ch : ".";
}

export function setCollisionAt(m: MapDef, cx: number, cy: number, v: "s" | "o" | "."): void {
  if (!inBounds(m, cx, cy)) return;
  if (!m.collision) m.collision = new Array<string>(m.rows).fill(".".repeat(m.cols));
  const row = m.collision[cy] ?? ".".repeat(m.cols);
  m.collision[cy] = row.slice(0, cx) + v + row.slice(cx + 1);
}

export function terrainAt(m: MapDef, cx: number, cy: number): "l" | "b" | "w" {
  const ch = m.terrain[cy]?.[cx];
  return ch === "l" || ch === "b" ? ch : "w";
}

export function setTerrainAt(m: MapDef, cx: number, cy: number, v: "l" | "b" | "w"): void {
  if (!inBounds(m, cx, cy)) return;
  // The tileset has no cliff pieces for land in the bottom rows or on the
  // outermost columns, matching the procgen's own margins.
  if (v === "l" && (cx < 1 || cx >= m.cols - 1 || cy < 1 || cy >= m.rows - CLIFF_H - 1)) return;
  const row = m.terrain[cy] ?? "w".repeat(m.cols);
  m.terrain[cy] = row.slice(0, cx) + v + row.slice(cx + 1);
}

// --- tile layer, cell data and subcell collision ---

function inBounds(m: MapDef, cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < m.cols && cy < m.rows;
}

/** Sparse cell layers are keyed by "cx,cy", which JSON keeps readable. */
export function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

const descIndex = new WeakMap<Art, Map<string, TileDesc>>();

function descsFor(art: Art): Map<string, TileDesc> {
  let m = descIndex.get(art);
  if (!m) {
    m = new Map(tileDescs(art).map((d) => [d.key, d]));
    descIndex.set(art, m);
  }
  return m;
}

export function tileAt(m: MapDef, layer: LayerId, cx: number, cy: number): string | null {
  return m.tiles[layer][cellKey(cx, cy)] ?? null;
}

/** What is stacked on one cell, bottom layer first. */
export function stackAt(m: MapDef, cx: number, cy: number): { layer: LayerId; key: string }[] {
  const out: { layer: LayerId; key: string }[] = [];
  for (const layer of LAYERS) {
    const key = tileAt(m, layer, cx, cy);
    if (key !== null) out.push({ layer, key });
  }
  return out;
}

export function setTileAt(m: MapDef, layer: LayerId, cx: number, cy: number, key: string | null): void {
  if (!inBounds(m, cx, cy)) return;
  const cell = cellKey(cx, cy);
  if (key === null) delete m.tiles[layer][cell];
  else m.tiles[layer][cell] = key;
  // Settings belong to the special tile they were stamped for. They survive as
  // long as some layer still holds that kind, and go when the last one does.
  const data = m.cellData[cell];
  if (data && !stackAt(m, cx, cy).some((t) => specialOf(t.key) === data.kind)) delete m.cellData[cell];
}

export function cellDataAt(m: MapDef, cx: number, cy: number): CellData | null {
  return m.cellData[cellKey(cx, cy)] ?? null;
}

export function setCellDataAt(m: MapDef, cx: number, cy: number, data: CellData | null): void {
  if (!inBounds(m, cx, cy)) return;
  if (data === null) delete m.cellData[cellKey(cx, cy)];
  else m.cellData[cellKey(cx, cy)] = data;
}

/** What a tile blocks: the content's rule for it, else the tileset default. */
export function tileMask(art: Art, c: WorldContent, key: string): number {
  const rule = c.tileRules[key];
  if (rule?.solid !== undefined) return rule.solid;
  return descsFor(art).get(key)?.solid ?? 0;
}

/** The layer a tile is painted on unless the editor is pointed elsewhere. */
export function tileLayer(art: Art, c: WorldContent, key: string): LayerId {
  const rule = c.tileRules[key];
  if (rule?.layer !== undefined) return rule.layer;
  return descsFor(art).get(key)?.layer ?? defaultLayerOf(key);
}

export function subAt(m: MapDef, cx: number, cy: number): number | null {
  return m.subCollision[cellKey(cx, cy)] ?? null;
}

export function setSubAt(m: MapDef, cx: number, cy: number, mask: number | null): void {
  if (!inBounds(m, cx, cy)) return;
  if (mask === null) delete m.subCollision[cellKey(cx, cy)];
  else m.subCollision[cellKey(cx, cy)] = mask & SUB_FULL;
}

/** A teleport pad, with the map and cell it was found on. */
export interface Pad {
  data: TeleportData;
  map: MapDef;
  cx: number;
  cy: number;
}

/** Every teleport pad in the world, in map order. */
export function pads(c: WorldContent): Pad[] {
  const out: Pad[] = [];
  for (const m of c.maps) {
    for (const [cell, data] of Object.entries(m.cellData)) {
      if (data.kind !== "teleport") continue;
      const comma = cell.indexOf(",");
      out.push({
        data, map: m,
        cx: Number(cell.slice(0, comma)),
        cy: Number(cell.slice(comma + 1)),
      });
    }
  }
  return out;
}

export function padById(c: WorldContent, id: string): Pad | null {
  if (id === "") return null;
  return pads(c).find((p) => p.data.id === id) ?? null;
}

/** A pad name nothing has taken yet. */
export function freshPadId(c: WorldContent): string {
  const taken = new Set(pads(c).map((p) => p.data.id));
  let i = 1;
  while (taken.has(`pad${i}`)) i += 1;
  return `pad${i}`;
}

/** Where a pad sends you: the pad it links to, else its own map and point. */
export function teleportTarget(
  c: WorldContent, data: TeleportData,
): { map: string; x: number; y: number } | null {
  const linked = padById(c, data.link);
  if (linked) {
    return {
      map: linked.map.id,
      x: linked.cx * TILE + TILE / 2,
      y: linked.cy * TILE + TILE / 2,
    };
  }
  if (data.link !== "") return null;
  const dest = mapById(c, data.map);
  if (!dest) return null;
  return data.x || data.y ? { map: dest.id, x: data.x, y: data.y } : { map: dest.id, ...dest.spawn };
}

/** Whether the sentinel on a cell has already been satisfied in this save. */
export type SentinelOpen = (mapId: string, cell: string) => boolean;

const ALL_SHUT: SentinelOpen = () => false;

/** The tile a cell actually shows, which for a passed sentinel is its open art. */
export function drawnTileAt(m: MapDef, layer: LayerId, cx: number, cy: number, open: SentinelOpen): string | null {
  const key = tileAt(m, layer, cx, cy);
  if (key === "sentinel" && open(m.id, cellKey(cx, cy))) return "sentinel2";
  return key;
}

/**
 * One cell's collision as a 9-bit subcell mask, most specific source first: a
 * mask painted on the cell, then the cell's whole-tile Solid/Open override,
 * then the painted tile's own rule, then the terrain (water blocks).
 */
/** A sentinel stands on this cell and its condition has been met. */
export function sentinelPassed(m: MapDef, cx: number, cy: number, open: SentinelOpen): boolean {
  const data = m.cellData[cellKey(cx, cy)];
  return data?.kind === "sentinel" && open(m.id, cellKey(cx, cy));
}

export function cellMask(
  art: Art,
  c: WorldContent,
  m: MapDef,
  land: boolean[],
  deck: boolean[],
  cx: number,
  cy: number,
  open: SentinelOpen = ALL_SHUT,
): number {
  // A sentinel that has been satisfied opens its cell whatever was painted on
  // it by hand. Shaping the gate's hitbox is exactly what hand-painting it is
  // for, and that shape has to leave with the gate or it never opens at all.
  if (!sentinelPassed(m, cx, cy, open)) {
    const hand = subAt(m, cx, cy);
    if (hand !== null) return hand;
    const ov = collisionAt(m, cx, cy);
    if (ov === "s") return SUB_FULL;
    if (ov === "o") return 0;
  }
  // Stacked tiles block together: a roof over a wall blocks what the wall does.
  let painted = false;
  let mask = 0;
  for (const layer of LAYERS) {
    const tile = drawnTileAt(m, layer, cx, cy, open);
    if (tile === null) continue;
    painted = true;
    mask |= tileMask(art, c, tile);
  }
  if (painted) return mask;
  const i = cy * m.cols + cx;
  return land[i] || deck[i] ? 0 : SUB_FULL;
}

// --- validation / io ---

/** Species ids as they stand today, retired ones translated and gaps dropped. */
function speciesList(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const now = currentSpecies(id);
    if (now && !out.includes(now)) out.push(now);
  }
  return out;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normNpc(raw: unknown, fallbackMap: string): NpcDef | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n["id"] !== "string" || typeof n["x"] !== "number" || typeof n["y"] !== "number") return null;
  const skinRaw = n["skin"] as Record<string, unknown> | undefined;
  const skin: NpcSkin = skinRaw?.["kind"] === "scoba" && typeof skinRaw["species"] === "string"
    ? { kind: "scoba", species: skinRaw["species"] }
    : { kind: "villager", look: (skinRaw?.["look"] ?? {}) as Look };
  const trainerRaw = n["trainer"] as Record<string, unknown> | undefined;
  const team = Array.isArray(trainerRaw?.["team"])
    ? (trainerRaw["team"] as Record<string, unknown>[])
      .filter((m) => typeof m["species"] === "string" && typeof m["level"] === "number")
      .map((m) => ({ species: currentSpecies(m["species"] as string), level: m["level"] as number }))
      .filter((m): m is { species: string; level: number } => m.species !== null)
    : [];
  return {
    id: n["id"],
    name: typeof n["name"] === "string" ? n["name"] : n["id"],
    map: typeof n["map"] === "string" && n["map"] !== "" ? n["map"] : fallbackMap,
    x: n["x"],
    y: n["y"],
    skin,
    lines: strArr(n["lines"]),
    wander: num(n["wander"], 0),
    trainer: trainerRaw && team.length > 0
      ? {
        team,
        reward: num(trainerRaw["reward"], 0),
        intro: strArr(trainerRaw["intro"]),
        beaten: strArr(trainerRaw["beaten"]),
      }
      : undefined,
  };
}

function normStep(raw: unknown, fallbackMap: string): QuestStep | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s["kind"] === "talk" && typeof s["npcId"] === "string") {
    return { kind: "talk", npcId: s["npcId"], lines: strArr(s["lines"]) };
  }
  if (s["kind"] === "reach" && typeof s["x"] === "number" && typeof s["y"] === "number") {
    return {
      kind: "reach",
      map: typeof s["map"] === "string" && s["map"] !== "" ? s["map"] : fallbackMap,
      x: s["x"],
      y: s["y"],
      r: num(s["r"], 24),
      label: typeof s["label"] === "string" ? s["label"] : "",
    };
  }
  if (s["kind"] === "defeat" && typeof s["npcId"] === "string") {
    return { kind: "defeat", npcId: s["npcId"], intro: strArr(s["intro"]) };
  }
  return null;
}

function normQuest(raw: unknown, fallbackMap: string): QuestDef | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  if (typeof q["id"] !== "string") return null;
  const rewardRaw = q["reward"] as Record<string, unknown> | undefined;
  return {
    id: q["id"],
    name: typeof q["name"] === "string" ? q["name"] : q["id"],
    after: typeof q["after"] === "string" && q["after"] !== "" ? q["after"] : undefined,
    steps: (Array.isArray(q["steps"]) ? q["steps"] : [])
      .map((s) => normStep(s, fallbackMap))
      .filter((s): s is QuestStep => s !== null),
    reward: rewardRaw
      ? {
        money: typeof rewardRaw["money"] === "number" ? rewardRaw["money"] : undefined,
        items: (rewardRaw["items"] ?? undefined) as Record<string, number> | undefined,
      }
      : undefined,
  };
}

/** Entries of a "cx,cy" keyed layer whose cell is actually on the map. */
function cellEntries(v: unknown, cols: number, rows: number): [string, unknown][] {
  if (!v || typeof v !== "object") return [];
  return Object.entries(v as Record<string, unknown>).filter(([k]) => {
    const m = /^(\d+),(\d+)$/.exec(k);
    return m !== null && Number(m[1]) < cols && Number(m[2]) < rows;
  });
}

function normTileRules(v: unknown): Record<string, TileRule> {
  const out: Record<string, TileRule> = {};
  if (!v || typeof v !== "object") return out;
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const rule: TileRule = {};
    if (typeof r["solid"] === "number") rule.solid = r["solid"] & SUB_FULL;
    if (LAYERS.includes(r["layer"] as LayerId)) rule.layer = r["layer"] as LayerId;
    // Before there were layers a rule only said whether the tile stood up.
    else if (r["tall"] === true) rule.layer = "sort";
    else if (r["tall"] === false) rule.layer = "ground";
    if (rule.solid !== undefined || rule.layer !== undefined) out[key] = rule;
  }
  return out;
}

/**
 * Painted tiles, per layer. A document from before layers had one flat record,
 * which splits by whatever each tile's rule (or the tileset) said about
 * standing up, so a wall painted then still sorts now.
 */
function normLayers(
  raw: unknown, rules: unknown, cols: number, rows: number,
): Record<LayerId, Record<string, string>> {
  const out = emptyLayers();
  if (!raw || typeof raw !== "object") return out;
  const byLayer = raw as Record<string, unknown>;
  const layered = LAYERS.some((l) => byLayer[l] !== undefined);
  if (layered) {
    for (const layer of LAYERS) {
      for (const [cell, v] of cellEntries(byLayer[layer], cols, rows)) {
        if (typeof v === "string") out[layer][cell] = v;
      }
    }
    return out;
  }
  const ruleFor = (rules ?? {}) as Record<string, { tall?: unknown; layer?: unknown }>;
  for (const [cell, v] of cellEntries(raw, cols, rows)) {
    if (typeof v !== "string") continue;
    const rule = ruleFor[v];
    const layer = LAYERS.includes(rule?.layer as LayerId)
      ? rule!.layer as LayerId
      : rule?.tall === true ? "sort"
        : rule?.tall === false ? "ground"
          : defaultLayerOf(v);
    out[layer][cell] = v;
  }
  return out;
}

function normCellData(raw: unknown): CellData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d["kind"] === "teleport") {
    return {
      kind: "teleport",
      id: typeof d["id"] === "string" ? d["id"] : "",
      link: typeof d["link"] === "string" ? d["link"] : "",
      map: typeof d["map"] === "string" ? d["map"] : "",
      x: num(d["x"], 0),
      y: num(d["y"], 0),
    };
  }
  if (d["kind"] === "sentinel") {
    return {
      kind: "sentinel",
      cond: d["cond"] === "trainer" ? "trainer" : "wild",
      count: Math.max(1, Math.round(num(d["count"], 2))),
      radius: Math.max(TILE, num(d["radius"], 96)),
      npcId: typeof d["npcId"] === "string" ? d["npcId"] : "",
      label: typeof d["label"] === "string" ? d["label"] : "",
    };
  }
  return null;
}

/**
 * A zone's roster. Before every kind carried its own settings this was a list
 * of ids with one level range over all of them, which lifts to an entry each.
 */
function normZoneSpecies(z: Record<string, unknown>): ZoneSpecies[] {
  const raw = z["species"];
  const wideMin = num(z["minLv"], ZONE_DEFAULTS.minLv);
  const wideMax = num(z["maxLv"], ZONE_DEFAULTS.maxLv);
  const out: ZoneSpecies[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const flat = typeof entry === "string";
    if (!flat && (!entry || typeof entry !== "object")) continue;
    const e = (flat ? {} : entry) as Record<string, unknown>;
    const wanted = flat ? entry : e["species"];
    const id = typeof wanted === "string" ? currentSpecies(wanted) : null;
    if (id === null || out.some((s) => s.species === id)) continue;
    const min = Math.max(1, Math.round(num(e["minLv"], wideMin)));
    const max = Math.max(min, Math.round(num(e["maxLv"], wideMax)));
    out.push({
      species: id,
      minLv: min,
      maxLv: max,
      // A rate of zero is a kind that never comes out, which is a fair thing
      // to author, so only a missing number falls back to the default.
      ratePerSec: Math.max(0, Math.min(10, num(e["ratePerSec"], ZONE_DEFAULTS.ratePerSec))),
      max: Math.max(0, Math.round(num(e["max"], ZONE_DEFAULTS.max))),
      speed: Math.max(1, num(e["speed"], ZONE_DEFAULTS.speed)),
      detect: Math.max(0, num(e["detect"], ZONE_DEFAULTS.detect)),
      tiles: strArr(e["tiles"]),
    });
  }
  return out;
}

function normZones(v: unknown): EncounterZone[] {
  if (!Array.isArray(v)) return [];
  return (v as Record<string, unknown>[])
    .filter((z) => typeof z["x"] === "number" && typeof z["y"] === "number"
      && typeof z["w"] === "number" && typeof z["h"] === "number")
    .map((z) => ({
      x: z["x"] as number, y: z["y"] as number, w: z["w"] as number, h: z["h"] as number,
      max: Math.max(0, Math.round(num(z["max"], ZONE_DEFAULTS.zoneMax))),
      species: normZoneSpecies(z),
    }))
    // A zone with nothing left to spawn is no zone at all.
    .filter((z) => z.species.length > 0);
}

function normProps(v: unknown): PropDef[] {
  if (!Array.isArray(v)) return [];
  return (v as Record<string, unknown>[])
    .filter((p) => PROP_KINDS.includes(p["kind"] as PropKind)
      && typeof p["cx"] === "number" && typeof p["cy"] === "number")
    .map((p) => ({ kind: p["kind"] as PropKind, cx: p["cx"] as number, cy: p["cy"] as number }));
}

function normMap(raw: unknown, index: number, docRules: unknown): MapDef | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const terrain = strArr(d["terrain"]);
  if (terrain.length === 0) return null;
  const rows = terrain.length;
  const cols = terrain[0]!.length;
  if (cols === 0 || !terrain.every((r) => r.length === cols)) return null;
  const id = typeof d["id"] === "string" && d["id"] !== "" ? d["id"] : `map${index + 1}`;
  const collision = strArr(d["collision"]);
  const tiles = normLayers(d["tiles"], docRules, cols, rows);
  const cellData: Record<string, CellData> = {};
  for (const [k, v] of cellEntries(d["cellData"], cols, rows)) {
    const data = normCellData(v);
    if (data) cellData[k] = data;
  }
  const spawn = d["spawn"] as Record<string, unknown> | undefined;
  return {
    id,
    name: typeof d["name"] === "string" && d["name"] !== "" ? d["name"] : id,
    cols,
    rows,
    terrain,
    collision: collision.length === rows && collision.every((r) => r.length === cols) ? collision : null,
    tiles,
    subCollision: Object.fromEntries(
      cellEntries(d["subCollision"], cols, rows)
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => [k, (v as number) & SUB_FULL]),
    ),
    cellData,
    props: normProps(d["props"]),
    zones: normZones(d["zones"]),
    spawn: {
      x: num(spawn?.["x"], (cols / 2) * TILE),
      y: num(spawn?.["y"], (rows / 2) * TILE),
    },
  };
}

/**
 * A pre-multi-map document, whose one map lived at the top level. Everything
 * that used to be null there meant "still procedural", so a document with no
 * terrain converts to no maps at all and stays procedural.
 */
function migrateV1(d: Record<string, unknown>): MapDef | null {
  const terrain = strArr(d["terrain"]);
  if (terrain.length !== ROWS || !terrain.every((r) => r.length === COLS)) return null;
  return normMap({
    id: "island",
    name: "Island",
    terrain,
    collision: d["collision"],
    tiles: d["tiles"],
    subCollision: d["subCollision"],
    cellData: {},
    props: d["props"] ?? [],
    zones: d["zones"] ?? [],
    spawn: d["spawn"],
  }, 0, d["tileRules"]);
}

/** Bring untrusted JSON (bundled file, import, localStorage) up to shape. */
export function normalizeContent(raw: unknown): WorldContent {
  const c = emptyContent();
  if (!raw || typeof raw !== "object") return c;
  const d = raw as Record<string, unknown>;

  if (Array.isArray(d["maps"])) {
    c.maps = d["maps"].map((m, i) => normMap(m, i, d["tileRules"])).filter((m): m is MapDef => m !== null);
  } else {
    const one = migrateV1(d);
    if (one) c.maps = [one];
  }
  // Two maps sharing an id would make every lookup ambiguous.
  const seen = new Set<string>();
  c.maps = c.maps.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

  nameEveryPad(c);

  const wantStart = typeof d["startMap"] === "string" ? d["startMap"] : "";
  c.startMap = seen.has(wantStart) ? wantStart : c.maps[0]?.id ?? "";
  c.tileRules = normTileRules(d["tileRules"]);
  c.npcs = (Array.isArray(d["npcs"]) ? d["npcs"] : [])
    .map((n) => normNpc(n, c.startMap))
    .filter((n): n is NpcDef => n !== null);
  c.quests = (Array.isArray(d["quests"]) ? d["quests"] : [])
    .map((q) => normQuest(q, c.startMap))
    .filter((q): q is QuestDef => q !== null);
  return c;
}

/**
 * Pads authored before they had names, or two claiming the same name, would
 * make links ambiguous. First claim wins; everyone else gets a fresh name.
 */
function nameEveryPad(c: WorldContent): void {
  const taken = new Set<string>();
  for (const pad of pads(c)) {
    if (pad.data.id !== "" && !taken.has(pad.data.id)) {
      taken.add(pad.data.id);
      continue;
    }
    let i = 1;
    while (taken.has(`pad${i}`)) i += 1;
    pad.data.id = `pad${i}`;
    taken.add(pad.data.id);
  }
  // A link to a pad that is gone would strand anyone stepping on it.
  for (const pad of pads(c)) {
    if (pad.data.link !== "" && !taken.has(pad.data.link)) pad.data.link = "";
  }
}

export function loadDevContent(): WorldContent | null {
  try {
    const raw = localStorage.getItem(DEV_CONTENT_KEY);
    if (!raw) return null;
    return normalizeContent(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveDevContent(c: WorldContent): void {
  localStorage.setItem(DEV_CONTENT_KEY, JSON.stringify(c));
}

export function clearDevContent(): void {
  localStorage.removeItem(DEV_CONTENT_KEY);
}

// --- world building ---

const sheets = new WeakMap<Art, Sheet>();

/** The packed island tileset for this art, built once and kept. */
export function tileSheet(art: Art): Sheet {
  let s = sheets.get(art);
  if (!s) {
    s = islandSheet(art);
    sheets.set(art, s);
  }
  return s;
}

/** Rebuild map.props (and the nest interactable) from content prop defs. */
export function applyProps(map: TileMap, art: Art, props: PropDef[]): void {
  map.props = [];
  map.interactables = map.interactables.filter((it) => it.id !== "nest");
  const sheet = tileSheet(art);
  for (const p of props) placeProp(map, sheet, p.kind, p.cx, p.cy);
}

/**
 * Rebuild the painted tile layer. Flat tiles become decals, drawn over the
 * auto-tiled ground; tall ones join the props so actors sort against them.
 * Call after `applyProps`, which owns the start of the prop list.
 */
/** Layers the editor is showing. Undefined means all of them. */
export type LayerFilter = (layer: LayerId) => boolean;

const ALL_LAYERS: LayerFilter = () => true;

export function applyTiles(
  map: TileMap, art: Art, m: MapDef,
  open: SentinelOpen = ALL_SHUT, visible: LayerFilter = ALL_LAYERS,
): void {
  map.decals = [];
  map.canopy = [];
  const sheet = tileSheet(art);
  for (const layer of LAYERS) {
    if (!visible(layer)) continue;
    for (const cell of Object.keys(m.tiles[layer])) {
      const comma = cell.indexOf(",");
      const cx = Number(cell.slice(0, comma));
      const cy = Number(cell.slice(comma + 1));
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const tile = drawnTileAt(m, layer, cx, cy, open);
      const spot = tile === null ? null : sheet.at(tile);
      if (!tile || !spot) continue;
      const x = cx * TILE;
      const y = cy * TILE;
      const piece = {
        img: sheet.canvas,
        sx: spot.x, sy: spot.y, sw: TILE_SRC, sh: TILE_SRC,
        x, y, dw: TILE, dh: TILE,
      };
      if (layer === "sort") {
        map.props.push({ ...piece, baseY: y + TILE - 2, kind: tile });
        if (tile === "nest") map.interactables.push({ x: x + 8, y: y + 12, r: 22, id: "nest" });
      } else if (layer === "above") {
        map.canopy.push(piece);
      } else {
        map.decals.push(piece);
      }
    }
  }
}

/** Props then tiles, the one order that keeps the prop list consistent. */
export function applyArt(
  map: TileMap, art: Art, m: MapDef,
  open: SentinelOpen = ALL_SHUT, visible: LayerFilter = ALL_LAYERS,
): void {
  applyProps(map, art, m.props);
  applyTiles(map, art, m, open, visible);
}

/** Recompute one cell's collision from terrain, tiles and the paint layers. */
export function applySolidCell(
  map: TileMap, art: Art, c: WorldContent, m: MapDef,
  land: boolean[], deck: boolean[], cx: number, cy: number, open: SentinelOpen = ALL_SHUT,
): void {
  if (!inBounds(m, cx, cy)) return;
  map.setCellMask(cx, cy, cellMask(art, c, m, land, deck, cx, cy, open));
}

/** The whole grid at once, for a fresh build or after a bulk change. */
export function applyAllCollision(
  map: TileMap, art: Art, c: WorldContent, m: MapDef,
  land: boolean[], deck: boolean[], open: SentinelOpen = ALL_SHUT,
): void {
  map.subSolid.clear();
  for (let cy = 0; cy < m.rows; cy++) {
    for (let cx = 0; cx < m.cols; cx++) applySolidCell(map, art, c, m, land, deck, cx, cy, open);
  }
}

/** The world one authored map describes. */
export function buildContentWorld(
  art: Art, c: WorldContent, m: MapDef, open: SentinelOpen = ALL_SHUT,
): WorldDef {
  const { land, deck } = decodeTerrain(m.terrain, m.cols);
  const map = new TileMap(m.cols, m.rows);
  map.painter = islandPainter(tileSheet(art), land, deck, m.cols, m.rows);
  applyArt(map, art, m, open);
  applyAllCollision(map, art, c, m, land, deck, open);
  return {
    map,
    spawn: { ...m.spawn },
    encounters: m.zones.map(cloneZone),
    layout: { land, deck },
  };
}

/** The world the game should run: the named authored map, else procgen. */
export function resolveWorld(
  art: Art, seed: string, c: WorldContent, mapId: string, open: SentinelOpen = ALL_SHUT,
): WorldDef {
  const m = mapById(c, resolveMapId(c, mapId));
  if (m) return buildContentWorld(art, c, m, open);
  return buildIslandWorld(art, seed);
}

/** Capture a procgen world into content, so the editor edits what is there. */
export function snapshotWorld(c: WorldContent, world: WorldDef): string {
  const layout = world.layout;
  if (!layout || contentOwned(c)) return c.startMap;
  const m = blankMap("island", "Island", COLS, ROWS);
  m.terrain = encodeTerrain(layout.land, layout.deck, COLS, ROWS);
  m.props = world.map.props
    .filter((p): p is typeof p & { kind: PropKind } => PROP_KINDS.includes(p.kind as PropKind))
    .map((p) => ({ kind: p.kind, cx: Math.round(p.x / TILE), cy: Math.round(p.y / TILE) }));
  m.zones = world.encounters.map(cloneZone);
  m.spawn = { ...world.spawn };
  c.maps = [m];
  c.startMap = m.id;
  for (const n of c.npcs) if (!n.map) n.map = m.id;
  return m.id;
}
