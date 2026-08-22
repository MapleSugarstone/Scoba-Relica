import { loadImage } from "./image";
import { KEY, hexToRgb, paletteSwap, sanitizeLook, type Look, type RGB } from "./recolor";
import {
  PAINT_SLOTS,
  PaintGrid,
  hasPaint,
  layerKey,
  paintPixels,
  type PaintSlot,
} from "./paint";

// Layered standing portrait used by the character creator. Every layer is a
// full-canvas 118x139 overlay, so compositing is just stacking them in order:
// base body, shirt, shirt trim, skin, eyes, hair, with a painted layer riding
// over each of them and one more free layer over the lot.
export const DOLL_W = 118;
export const DOLL_H = 139;

/** Feet pivot in art px: canvas centre, bottom row of the base body. */
export const DOLL_PIVOT = { x: 59, y: 121 };

/** Head and torso boxes, for cropped option thumbnails. */
export const HEAD_BOX = { x: 22, y: 0, w: 74, h: 72 };
export const TORSO_BOX = { x: 30, y: 52, w: 58, h: 58 };

// Layers are read straight out of `assets/`, the folder the art is drawn in,
// rather than a copy of it. Redrawing a layer or adding a new one shows up on
// the next reload with nothing to sync, and the bundler fingerprints each file
// so a browser can never serve a stale one.
const LAYERS = import.meta.glob([
  "../../assets/Base_Body/*.png",
  "../../assets/Base_Shirt/*.png",
  "../../assets/Face Flesh/*.png",
  "../../assets/Eyes/*.png",
  "../../assets/Hairs/*.png",
  "../../assets/Shirts/*.png",
], { eager: true, query: "?url", import: "default" }) as Record<string, string>;

/** Every file in one asset folder, in natural filename order. */
function group(dir: string): string[] {
  const prefix = `../../assets/${dir}/`;
  return Object.keys(LAYERS)
    .filter((path) => path.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((path) => LAYERS[path]!);
}

export const HAIR_URLS = group("Hairs");
export const EYE_URLS = group("Eyes");
export const SHIRT_URLS = group("Shirts");

export interface PaperdollArt {
  body: HTMLImageElement;
  baseShirt: HTMLImageElement;
  skin: HTMLImageElement;
  eyes: HTMLImageElement[];
  hairs: HTMLImageElement[];
  shirts: HTMLImageElement[];
}

export async function loadPaperdoll(): Promise<PaperdollArt> {
  const [body, baseShirt, skin, eyes, hairs, shirts] = await Promise.all([
    loadImage(group("Base_Body")[0]!),
    loadImage(group("Base_Shirt")[0]!),
    loadImage(group("Face Flesh")[0]!),
    Promise.all(EYE_URLS.map((u) => loadImage(u))),
    Promise.all(HAIR_URLS.map((u) => loadImage(u))),
    Promise.all(SHIRT_URLS.map((u) => loadImage(u))),
  ]);
  return { body, baseShirt, skin, eyes, hairs, shirts };
}

const cache = new Map<string, HTMLCanvasElement>();

function tinted(img: HTMLImageElement, map: [RGB, RGB][]): HTMLCanvasElement {
  const key = img.src + "|" + map.map(([, to]) => to.join(",")).join("|");
  let cv = cache.get(key);
  if (!cv) {
    cv = paletteSwap(img, map);
    cache.set(key, cv);
  }
  return cv;
}

/** Wrap an index into a catalog; -1 (or any negative) means "leave it off". */
function pick<T>(list: T[], i: number): T | null {
  if (i < 0 || list.length === 0) return null;
  return list[i % list.length]!;
}

// --- where paint is allowed to land ---

/**
 * Which pixels of one art layer a player may paint over. `nonBlack` spares the
 * line art, which is what keeps a repainted shirt or head of hair still
 * looking drawn rather than smeared over.
 */
type MaskMode = "opaque" | "nonBlack";

const masks = new Map<string, Uint8Array>();

function maskOf(img: HTMLImageElement | HTMLCanvasElement, mode: MaskMode, key: string): Uint8Array {
  const hit = masks.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = DOLL_W;
  cv.height = DOLL_H;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, DOLL_W, DOLL_H).data;
  const bits = new Uint8Array(DOLL_W * DOLL_H);
  for (let i = 0; i < bits.length; i += 1) {
    const o = i * 4;
    if (px[o + 3] === 0) continue;
    if (mode === "nonBlack" && px[o] === 0 && px[o + 1] === 0 && px[o + 2] === 0) continue;
    bits[i] = 1;
  }
  masks.set(key, bits);
  return bits;
}

const EMPTY_MASK = new Uint8Array(DOLL_W * DOLL_H);

/** A mask and the key it caches under, since a union has neither on its own. */
interface Region {
  bits: Uint8Array | null;
  key: string;
}

/**
 * The region a slot may be painted in, for the parts this look is wearing.
 * Eyes and accessories are free: the eyes are drawn from nothing once the
 * stock pair is off, and accessories are meant to go anywhere at all.
 */
function region(art: PaperdollArt, look: Look, slot: PaintSlot): Region {
  if (slot === "eyes" || slot === "extras") return { bits: null, key: "free" };
  if (slot === "face") {
    const key = `face:${art.skin.src}`;
    return { bits: maskOf(art.skin, "opaque", key), key };
  }
  if (slot === "hair") {
    const hair = pick(art.hairs, look.hairStyle);
    // Nothing worn is nothing to paint on, rather than a free layer.
    if (!hair) return { bits: EMPTY_MASK, key: "hair:none" };
    const key = `hair:${hair.src}`;
    return { bits: maskOf(hair, "nonBlack", key), key };
  }
  // The shirt is one garment even though it is two files: paint goes over the
  // base and over whatever trim is worn, and stops at the line art of both.
  const base = maskOf(art.baseShirt, "nonBlack", `shirt:${art.baseShirt.src}`);
  const over = pick(art.shirts, look.shirtStyle);
  if (!over) return { bits: base, key: `shirt:${art.baseShirt.src}` };
  const key = `shirt:${art.baseShirt.src}+${over.src}`;
  const hit = masks.get(key);
  if (hit) return { bits: hit, key };
  const trim = maskOf(over, "nonBlack", `trim:${over.src}`);
  const both = new Uint8Array(base.length);
  for (let i = 0; i < both.length; i += 1) both[i] = base[i] || trim[i] ? 1 : 0;
  masks.set(key, both);
  return { bits: both, key };
}

// A painted layer costs a full canvas to rasterize, so equal ones share. The
// cap is what stops a long session in the painter piling up one per stroke.
const painted = new Map<string, HTMLCanvasElement>();
const PAINT_CACHE_MAX = 48;

function paintedLayer(look: Look, slot: PaintSlot, art: PaperdollArt): HTMLCanvasElement | null {
  const layer = look.paint?.[slot];
  if (!layer) return null;
  const { bits, key: regionKey } = region(art, look, slot);
  const key = `${slot}|${regionKey}|${layerKey(layer)}`;
  const hit = painted.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = DOLL_W;
  cv.height = DOLL_H;
  const ctx = cv.getContext("2d")!;
  const data = ctx.createImageData(DOLL_W, DOLL_H);
  paintPixels(PaintGrid.from(layer, DOLL_W, DOLL_H), bits, data.data);
  ctx.putImageData(data, 0, 0);
  if (painted.size >= PAINT_CACHE_MAX) painted.delete(painted.keys().next().value!);
  painted.set(key, cv);
  return cv;
}

/** The paintable region of one slot, for a painter that wants to show it. */
export function paintRegion(art: PaperdollArt, look: Look, slot: PaintSlot): Uint8Array | null {
  return region(art, look, slot).bits;
}

export interface DollOptions {
  /**
   * Draw this in place of the slot's stored paint, so the painter can show a
   * stroke that has not been committed to the look yet.
   */
  live?: { slot: PaintSlot; canvas: HTMLCanvasElement | null };
  /**
   * Everything stacked above this slot is drawn at `fade`, which is how the
   * painter lets you work on a face that hair would otherwise cover.
   */
  focus?: PaintSlot;
  fade?: number;
}

export function drawPaperdoll(
  ctx: CanvasRenderingContext2D,
  art: PaperdollArt,
  look: Look,
  dx = 0,
  dy = 0,
  opts?: DollOptions,
): void {
  const skin = hexToRgb(look.skin);
  const shirt = hexToRgb(look.shirt);
  const detail = hexToRgb(look.shirtDetail);
  const hair = hexToRgb(look.hair);

  const was = ctx.globalAlpha;
  let above = false;
  const put = (img: CanvasImageSource | null): void => {
    if (!img) return;
    ctx.globalAlpha = above ? was * (opts?.fade ?? 1) : was;
    ctx.drawImage(img, dx, dy);
  };
  const paint = (slot: PaintSlot): void => {
    put(opts?.live?.slot === slot ? opts.live.canvas : paintedLayer(look, slot, art));
    if (opts?.focus === slot) above = true;
  };

  put(art.body);
  put(tinted(art.baseShirt, [[KEY.tint, shirt]]));
  put(pickTinted(art.shirts, look.shirtStyle, detail));
  paint("shirt");
  put(tinted(art.skin, [[KEY.flesh, skin]]));
  paint("face");
  // Custom eyes replace the stock pair rather than sitting over them: drawing
  // your own on top of a face that already has eyes only ever gives it four.
  const wearsPainted = opts?.live?.slot === "eyes" || hasPaint(look.paint, "eyes");
  if (!wearsPainted) put(pick(art.eyes, look.eyeStyle));
  paint("eyes");
  put(pickTinted(art.hairs, look.hairStyle, hair));
  paint("hair");
  paint("extras");
  ctx.globalAlpha = was;
}

function pickTinted(list: HTMLImageElement[], i: number, to: RGB): HTMLCanvasElement | null {
  const img = pick(list, i);
  return img ? tinted(img, [[KEY.tint, to]]) : null;
}

/** A look off the wire or out of a file, clipped to what the doll can draw. */
export function sanitizeDollLook(value: unknown): Look {
  return sanitizeLook(value, DOLL_W, DOLL_H);
}

/** Standalone composite, for callers that want an image rather than a draw. */
export function renderPaperdoll(art: PaperdollArt, look: Look): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = DOLL_W;
  cv.height = DOLL_H;
  drawPaperdoll(cv.getContext("2d")!, art, look);
  return cv;
}

/** Every painted layer as one string, so a cache key can hold what was drawn. */
function paintKey(look: Look): string {
  if (!look.paint) return "";
  let key = "";
  for (const slot of PAINT_SLOTS) {
    const layer = look.paint[slot];
    if (layer) key += `${slot}~${layerKey(layer)}|`;
  }
  return key;
}

export interface WorldSprite {
  img: HTMLCanvasElement | HTMLImageElement;
  /** Feet pivot inside img, in art px: characters rotate about this point. */
  px: number;
  py: number;
}

const worldCache = new Map<string, WorldSprite>();

function lookKey(look: Look): string {
  return [
    look.skin, look.hair, look.shirt, look.shirtDetail,
    look.hairStyle, look.eyeStyle, look.shirtStyle, paintKey(look),
  ].join("|");
}

/** The doll as the overworld draws it: full resolution, cached per look. */
export function worldSprite(art: PaperdollArt, look: Look): WorldSprite {
  const key = lookKey(look);
  const hit = worldCache.get(key);
  if (hit) return hit;
  const sprite: WorldSprite = {
    img: renderPaperdoll(art, look),
    px: DOLL_PIVOT.x,
    py: DOLL_PIVOT.y,
  };
  worldCache.set(key, sprite);
  return sprite;
}
