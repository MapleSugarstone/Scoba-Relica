import { loadImage } from "./image";
import { KEY, hexToRgb, paletteSwap, type Look, type RGB } from "./recolor";

// Layered standing portrait used by the character creator. Every layer is a
// full-canvas 118x139 overlay, so compositing is just stacking them in order:
// base body, shirt, shirt trim, skin, eyes, hair.
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

export function drawPaperdoll(
  ctx: CanvasRenderingContext2D,
  art: PaperdollArt,
  look: Look,
  dx = 0,
  dy = 0,
): void {
  const skin = hexToRgb(look.skin);
  const shirt = hexToRgb(look.shirt);
  const detail = hexToRgb(look.shirtDetail);
  const hair = hexToRgb(look.hair);

  ctx.drawImage(art.body, dx, dy);
  ctx.drawImage(tinted(art.baseShirt, [[KEY.tint, shirt]]), dx, dy);
  const shirtLayer = pick(art.shirts, look.shirtStyle);
  if (shirtLayer) ctx.drawImage(tinted(shirtLayer, [[KEY.tint, detail]]), dx, dy);
  ctx.drawImage(tinted(art.skin, [[KEY.flesh, skin]]), dx, dy);
  const eyeLayer = pick(art.eyes, look.eyeStyle);
  if (eyeLayer) ctx.drawImage(eyeLayer, dx, dy);
  const hairLayer = pick(art.hairs, look.hairStyle);
  if (hairLayer) ctx.drawImage(tinted(hairLayer, [[KEY.tint, hair]]), dx, dy);
}

/** Standalone composite, for callers that want an image rather than a draw. */
export function renderPaperdoll(art: PaperdollArt, look: Look): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = DOLL_W;
  cv.height = DOLL_H;
  drawPaperdoll(cv.getContext("2d")!, art, look);
  return cv;
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
    look.hairStyle, look.eyeStyle, look.shirtStyle,
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
