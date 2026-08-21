import type { Art } from "../engine/assets";
import { packSheet, type Piece, type Sheet, type Turn } from "../engine/atlas";
import { SUB_FULL } from "../engine/tilemap";

// The island tileset, packed from the source art in `assets/Tiles`. The artist
// draws one edge and one corner; every other orientation is a turn of it.
//
// Tiles are drawn on a 65 px canvas whose last row repeats the first, so the
// pack crops to 64. At ART = 4 that is exactly one 16 unit tile.
export const TILE_SRC = 64;

/**
 * A 3x3 collision mask written as it looks: three rows of three, top row
 * first, `#` for a blocked subcell. Whitespace is ignored, so the rows can be
 * spaced apart to read as a picture of the tile.
 */
export function maskOf(rows: string): number {
  const cells = rows.replace(/\s+/g, "");
  let m = 0;
  for (let i = 0; i < 9; i++) if (cells[i] === "#") m |= 1 << i;
  return m;
}

/**
 * The four passes a painted tile can draw in, bottom to top. `ground` and
 * `overlay` go under everyone, `sort` interleaves with actors by its foot, and
 * `above` draws over the top of them. A wall is `sort` at its base and `above`
 * where you walk under it.
 */
export const LAYERS = ["ground", "overlay", "sort", "above"] as const;
export type LayerId = (typeof LAYERS)[number];

export const LAYER_LABEL: Record<LayerId, string> = {
  ground: "Ground",
  overlay: "Overlay",
  sort: "Sort",
  above: "Above",
};

export const LAYER_BLURB: Record<LayerId, string> = {
  ground: "Under everything. Floors, paths, water.",
  overlay: "Still under everyone, but over the ground. Rugs, cracks, shadows.",
  sort: "Sorts by its foot against actors, so you pass behind its top half.",
  above: "Over everyone. Roofs and treetops you walk under.",
};

/** One paintable tile: art, how it is turned, and what it blocks by default. */
export interface TileDesc {
  /** Sheet key, and what the tile layer stores in content. */
  key: string;
  label: string;
  group: string;
  /** Art file name in `assets/Tiles`, lower-cased. `@nest` is drawn at load. */
  art: string;
  turn?: Turn;
  flipX?: boolean;
  /** Collision it paints with, unless the content overrides the default. */
  solid: number;
  /** The layer the palette reaches for when this tile is picked. */
  layer: LayerId;
}

const OPEN = 0;
/** A rail across the middle: what a fence wants before anyone edits it. */
const RAIL = maskOf("... ### ...");

const DESCS: TileDesc[] = [
  // Water, in four turns so a wide ocean does not read as one stamp.
  { key: "sea0", label: "Ocean", group: "Water", art: "ocean", solid: SUB_FULL, layer: "ground" },
  { key: "sea1", label: "Ocean 1/4", group: "Water", art: "ocean", turn: 90, solid: SUB_FULL, layer: "ground" },
  { key: "sea2", label: "Ocean 1/2", group: "Water", art: "ocean", turn: 180, solid: SUB_FULL, layer: "ground" },
  { key: "sea3", label: "Ocean 3/4", group: "Water", art: "ocean", turn: 270, solid: SUB_FULL, layer: "ground" },

  // Island surface.
  { key: "dirt0", label: "Dirt 1", group: "Ground", art: "dirt1", solid: OPEN, layer: "ground" },
  { key: "dirt1", label: "Dirt 2", group: "Ground", art: "dirt2", solid: OPEN, layer: "ground" },
  { key: "dirt2", label: "Dirt 3", group: "Ground", art: "dirt3", solid: OPEN, layer: "ground" },
  { key: "dirt3", label: "Dirt 4", group: "Ground", art: "dirt4", solid: OPEN, layer: "ground" },
  { key: "edgeW", label: "Edge W", group: "Ground", art: "dirtside", solid: OPEN, layer: "ground" },
  { key: "edgeN", label: "Edge N", group: "Ground", art: "dirtside", turn: 90, solid: OPEN, layer: "ground" },
  { key: "edgeE", label: "Edge E", group: "Ground", art: "dirtside", turn: 180, solid: OPEN, layer: "ground" },
  { key: "edgeS", label: "Edge S", group: "Ground", art: "dirtside", turn: 270, solid: OPEN, layer: "ground" },
  { key: "cornerNW", label: "Corner NW", group: "Ground", art: "dirtcorner", solid: OPEN, layer: "ground" },
  { key: "cornerNE", label: "Corner NE", group: "Ground", art: "dirtcorner", turn: 90, solid: OPEN, layer: "ground" },
  { key: "cornerSE", label: "Corner SE", group: "Ground", art: "dirtcorner", turn: 180, solid: OPEN, layer: "ground" },
  { key: "cornerSW", label: "Corner SW", group: "Ground", art: "dirtcorner", turn: 270, solid: OPEN, layer: "ground" },

  // Cliff face, hanging below the island's south edge.
  { key: "cliff", label: "Cliff", group: "Cliff", art: "dirtbottom", solid: SUB_FULL, layer: "ground" },
  { key: "cliffW", label: "Cliff W", group: "Cliff", art: "dirtbottomside", solid: SUB_FULL, layer: "ground" },
  { key: "cliffE", label: "Cliff E", group: "Cliff", art: "dirtbottomside", flipX: true, solid: SUB_FULL, layer: "ground" },
  { key: "cliffEnd", label: "Cliff foot", group: "Cliff", art: "dirtbottominocean", solid: SUB_FULL, layer: "ground" },
  { key: "cliffEndW", label: "Cliff foot W", group: "Cliff", art: "dirtbottomsideinocean", solid: SUB_FULL, layer: "ground" },
  { key: "cliffEndE", label: "Cliff foot E", group: "Cliff", art: "dirtbottomsideinocean", flipX: true, solid: SUB_FULL, layer: "ground" },

  // Bridges. The cap's deck points at the run it belongs to.
  { key: "bridgeH", label: "Bridge -", group: "Bridge", art: "bridge", solid: OPEN, layer: "ground" },
  { key: "bridgeV", label: "Bridge |", group: "Bridge", art: "bridge", turn: 90, solid: OPEN, layer: "ground" },
  { key: "capW", label: "Cap W", group: "Bridge", art: "bridgeend", solid: OPEN, layer: "ground" },
  { key: "capE", label: "Cap E", group: "Bridge", art: "bridgeend", turn: 180, solid: OPEN, layer: "ground" },
  { key: "capN", label: "Cap N", group: "Bridge", art: "bridgeend", turn: 90, solid: OPEN, layer: "ground" },
  { key: "capS", label: "Cap S", group: "Bridge", art: "bridgeend", turn: 270, solid: OPEN, layer: "ground" },

  { key: "bush", label: "Bush", group: "Objects", art: "bush", solid: RAIL, layer: "sort" },
  { key: "barrel", label: "Barrel", group: "Objects", art: "fence", solid: maskOf("... .#. ..."), layer: "sort" },
  { key: "nest", label: "Nest", group: "Objects", art: "@nest", solid: OPEN, layer: "sort" },

  // Tiles that carry per-cell data. The art falls back to a drawn placeholder
  // until `Teleport.png`, `Sentinel.png` or `Sentinel2.png` lands in the
  // folder, at which point the file wins with no code change.
  { key: "teleport", label: "Teleport", group: "Special", art: "teleport", solid: OPEN, layer: "overlay" },
  { key: "sentinel", label: "Sentinel", group: "Special", art: "sentinel", solid: SUB_FULL, layer: "sort" },
  { key: "sentinel2", label: "Sentinel (open)", group: "Special", art: "sentinel2", solid: OPEN, layer: "sort" },
];

/** Tiles whose cell carries its own settings, and what those settings are. */
export const SPECIAL_TILES = ["teleport", "sentinel"] as const;
export type SpecialTile = (typeof SPECIAL_TILES)[number];

export function specialOf(key: string | null): SpecialTile | null {
  if (key === "teleport") return "teleport";
  if (key === "sentinel" || key === "sentinel2") return "sentinel";
  return null;
}

/**
 * A run of tiles that belong together: interchangeable interior variants, and
 * optionally the eight pieces that rim them. The rectangle tool reads this to
 * put edges on a border and scatter the variants inside.
 */
export interface TileFamily {
  id: string;
  label: string;
  /** Interior pieces, picked at random so a field does not read as one stamp. */
  fill: string[];
  edges?: {
    n: string; s: string; e: string; w: string;
    nw: string; ne: string; se: string; sw: string;
  };
}

export const TILE_FAMILIES: TileFamily[] = [
  {
    id: "dirt",
    label: "Dirt",
    fill: ["dirt0", "dirt1", "dirt2", "dirt3"],
    edges: {
      n: "edgeN", s: "edgeS", e: "edgeE", w: "edgeW",
      nw: "cornerNW", ne: "cornerNE", se: "cornerSE", sw: "cornerSW",
    },
  },
  { id: "sea", label: "Ocean", fill: ["sea0", "sea1", "sea2", "sea3"] },
];

/** The family a tile belongs to, whether it was picked as fill or as an edge. */
export function familyOf(key: string): TileFamily | null {
  for (const f of TILE_FAMILIES) {
    if (f.fill.includes(key)) return f;
    if (f.edges && Object.values(f.edges).includes(key)) return f;
  }
  return null;
}

/** Names a real PNG can take over, drawn in code until one shows up. */
const PLACEHOLDERS = ["teleport", "sentinel", "sentinel2"];

const TURN_LABEL: Record<number, string> = { 90: " 1/4", 180: " 1/2", 270: " 3/4" };

/**
 * Art files no descriptor claims, packed in all four turns. Drop a PNG in
 * `assets/Tiles` and it is paintable on the next reload, with a default
 * collision the palette can set.
 */
function extraDescs(art: Art): TileDesc[] {
  const claimed = new Set(DESCS.map((d) => d.art));
  const out: TileDesc[] = [];
  for (const name of Object.keys(art.tiles).sort()) {
    if (claimed.has(name)) continue;
    for (const turn of [0, 90, 180, 270] as const) {
      out.push({
        key: turn === 0 ? name : `${name}@${turn}`,
        label: name + (TURN_LABEL[turn] ?? ""),
        group: "New art",
        art: name,
        turn,
        solid: RAIL,
        layer: "sort",
      });
    }
  }
  return out;
}

/**
 * The layer a tile lands on when nothing says otherwise. Static, so loading a
 * document can place old tiles without any art to hand.
 */
export function defaultLayerOf(key: string): LayerId {
  return DESCS.find((d) => d.key === key)?.layer ?? "sort";
}

/** Everything the palette can paint, in the order it is packed. */
export function tileDescs(art: Art): TileDesc[] {
  return [...DESCS, ...extraDescs(art)];
}

const drawn = new Map<string, HTMLCanvasElement>();

/** A 64 px canvas cached under `name`, painted by `paint` the first time. */
function drawnArt(name: string, paint: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const had = drawn.get(name);
  if (had) return had;
  const cv = document.createElement("canvas");
  cv.width = TILE_SRC;
  cv.height = TILE_SRC;
  const ctx = cv.getContext("2d")!;
  paint(ctx);
  drawn.set(name, cv);
  return cv;
}

/** Stand-in art, on the tile grid, until the real PNG is drawn. */
function placeholder(name: string): HTMLCanvasElement {
  return drawnArt(name, (ctx) => {
    const mid = TILE_SRC / 2;
    if (name === "teleport") {
      // A pad with a spiral on it, so it reads as somewhere to step.
      ctx.fillStyle = "#2a1c3d";
      ctx.fillRect(4, 4, TILE_SRC - 8, TILE_SRC - 8);
      ctx.strokeStyle = "#7c9df0";
      ctx.lineWidth = 3;
      ctx.strokeRect(5.5, 5.5, TILE_SRC - 11, TILE_SRC - 11);
      ctx.strokeStyle = "#c9a6f5";
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * Math.PI * 3.4;
        const r = 4 + t * 2.6;
        const fn = i === 0 ? "moveTo" : "lineTo";
        ctx[fn](mid + Math.cos(t) * r, mid + Math.sin(t) * r);
      }
      ctx.stroke();
      return;
    }
    // Sentinel: a barred gate, shut or swung open.
    const open = name === "sentinel2";
    ctx.strokeStyle = "#2b2118";
    ctx.lineWidth = 3;
    ctx.fillStyle = open ? "#6f7c52" : "#8a5a3a";
    for (const x of [8, TILE_SRC - 20]) {
      ctx.fillRect(x, 12, 12, TILE_SRC - 20);
      ctx.strokeRect(x + 1.5, 13.5, 9, TILE_SRC - 23);
    }
    if (!open) {
      ctx.fillStyle = "#b8794c";
      for (const y of [22, 38]) {
        ctx.fillRect(14, y, TILE_SRC - 28, 8);
        ctx.strokeRect(15.5, y + 1.5, TILE_SRC - 31, 5);
      }
    } else {
      ctx.strokeStyle = "#9fb36a";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(20, 34);
      ctx.lineTo(29, 44);
      ctx.lineTo(46, 22);
      ctx.stroke();
    }
  });
}

let nestCanvas: HTMLCanvasElement | null = null;

/**
 * The special Scoba's nest, drawn rather than loaded: a twig bowl with an egg
 * in it, on the same 64 px grid as the tile art so it packs with everything
 * else. Stands in until the nest is drawn properly.
 */
function nestArt(): HTMLCanvasElement {
  if (nestCanvas) return nestCanvas;
  const cv = document.createElement("canvas");
  cv.width = TILE_SRC;
  cv.height = TILE_SRC;
  const ctx = cv.getContext("2d")!;
  const cx = TILE_SRC / 2;
  const cy = TILE_SRC * 0.62;

  // Egg first, so the near twigs sit over it.
  ctx.fillStyle = "#f6efdc";
  ctx.strokeStyle = "#2b2118";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, cy - 9, 11, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#d9c9a3";
  for (const [dx, dy] of [[-4, -12], [4, -6], [-2, -2]] as const) {
    ctx.beginPath();
    ctx.ellipse(cx + dx, cy + dy, 2.5, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Twig bowl: a filled half-ellipse, then a few strands laid across it.
  ctx.fillStyle = "#8a6134";
  ctx.beginPath();
  ctx.ellipse(cx, cy, 24, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "#5f4020";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (const [x1, y1, x2, y2] of [
    [-19, 2, -6, 7], [-8, 6, 7, 3], [4, 7, 19, 1], [-14, -3, -3, 1], [6, 0, 17, -4],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(cx + x1, cy + y1);
    ctx.lineTo(cx + x2, cy + y2);
    ctx.stroke();
  }
  nestCanvas = cv;
  return cv;
}

/**
 * Island silhouettes are two pieces stacked. The top surface sits on the land
 * cells themselves, edged on the north, west and east. Its south side is the
 * cliff face, which hangs into the water cell below the bottom land row, so an
 * island reads as a plateau rather than a flat sticker.
 */
export function islandSheet(art: Art): Sheet {
  const src = (name: string): CanvasImageSource => {
    if (name === "@nest") return nestArt();
    const img = art.tiles[name];
    if (img) return img;
    if (PLACEHOLDERS.includes(name)) return placeholder(name);
    throw new Error(`missing tile art: ${name}`);
  };

  const pieces: Piece[] = tileDescs(art).map((d) => ({
    key: d.key,
    img: src(d.art),
    size: TILE_SRC,
    turn: d.turn,
    flipX: d.flipX,
  }));

  return packSheet(pieces, TILE_SRC);
}
