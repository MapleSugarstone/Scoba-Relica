// Character customization is an exact palette swap. The layered character art
// paints every wearer-chosen region in pure red (255,16,0) and keys face flesh
// on its own peach: red on the base shirt is the shirt color, red on a shirt
// overlay is the detail color, red on hair is the hair color. Black is line art
// everywhere and is never swapped. Replacement art must keep one flat color per
// region. On top of that a player may paint their own pixels; see `paint.ts`.
import { sanitizePaintSet, type PaintSet } from "./paint";

export interface Look {
  skin: string;
  hair: string;
  shirt: string;
  shirtDetail: string;
  /** Part indices into the paperdoll catalogs; -1 leaves the part off. */
  hairStyle: number;
  eyeStyle: number;
  shirtStyle: number;
  /**
   * Anything the player painted by hand, per layer. Absent on every look made
   * before there was a painter, which is why it stays optional rather than
   * costing a save migration.
   */
  paint?: PaintSet;
}

export type RGB = [number, number, number];

/** Keyed colors in the source art. */
export const KEY = {
  tint: [255, 16, 0] as RGB,
  flesh: [255, 171, 130] as RGB,
};

export const SKIN_COLORS: string[] = [
  "#ffe0c4", "#ffab82", "#e8a06a", "#cd8552",
  "#a9663f", "#7d4a2c", "#5a3520", "#3a2216",
  "#d8b9a0", "#b9c98a", "#8fd0c4", "#dba7d6",
];

export const HAIR_COLORS: string[] = [
  "#2a2530", "#4a3428", "#7a4a32", "#b4553d",
  "#e09a4e", "#eae178", "#f2e9d8", "#c8cdd6",
  "#7aa74a", "#4f8fba", "#8d63c0", "#d977b8",
];

export const SHIRT_COLORS: string[] = [
  "#f3f2c0", "#ffffff", "#d9553f", "#e7a03c",
  "#eae178", "#7aa74a", "#4f8fba", "#7c9df0",
  "#8d63c0", "#e58ab8", "#5c4e92", "#3f4a66",
];

export const DETAIL_COLORS: string[] = [
  "#171b2c", "#3f4a66", "#5c4e92", "#7c9df0",
  "#4f8fba", "#7aa74a", "#eae178", "#e7a03c",
  "#d9553f", "#e58ab8", "#f3f2c0", "#ffffff",
];

export const DEFAULT_LOOK: Look = {
  skin: SKIN_COLORS[1]!,
  hair: HAIR_COLORS[4]!,
  shirt: SHIRT_COLORS[5]!,
  shirtDetail: DETAIL_COLORS[0]!,
  hairStyle: 0,
  eyeStyle: 0,
  shirtStyle: 0,
};

const HEX = /^#[0-9a-f]{6}$/;

/**
 * A look from somewhere unchecked: the other player's profile, or an imported
 * save. Everything that fails to read is replaced from the default rather than
 * refused, so a stranger with a corrupted hat still turns up wearing a face.
 */
export function sanitizeLook(value: unknown, w: number, h: number): Look {
  const src = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const color = (key: keyof Look, fallback: string): string => {
    const v = src[key];
    return typeof v === "string" && HEX.test(v.toLowerCase()) ? v.toLowerCase() : fallback;
  };
  // A part index is wrapped into its catalog when it is drawn, so any whole
  // number is safe here; only a negative one has a meaning, and it is "off".
  const part = (key: keyof Look, fallback: number): number => {
    const v = src[key];
    return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
  };
  const paint = sanitizePaintSet(src["paint"], w, h);
  const look: Look = {
    skin: color("skin", DEFAULT_LOOK.skin),
    hair: color("hair", DEFAULT_LOOK.hair),
    shirt: color("shirt", DEFAULT_LOOK.shirt),
    shirtDetail: color("shirtDetail", DEFAULT_LOOK.shirtDetail),
    hairStyle: part("hairStyle", DEFAULT_LOOK.hairStyle),
    eyeStyle: part("eyeStyle", DEFAULT_LOOK.eyeStyle),
    shirtStyle: part("shirtStyle", DEFAULT_LOOK.shirtStyle),
  };
  if (paint) look.paint = paint;
  return look;
}

export function hexToRgb(c: string): RGB {
  return [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ];
}

/**
 * The same colour turned `turns` of the way round the wheel, keeping how light
 * and how strong it is. Grey has no hue to turn, so it comes back unchanged.
 */
export function hueShift([r, g, b]: RGB, turns: number): RGB {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [r, g, b];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === rn
    ? (gn - bn) / d + (gn < bn ? 6 : 0)
    : max === gn
      ? (bn - rn) / d + 2
      : (rn - gn) / d + 4;
  h = (h / 6 + turns) % 1;
  if (h < 0) h += 1;

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let v = t;
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

/** Exact-match palette swap onto a fresh canvas. Transparent pixels are kept. */
export function paletteSwap(
  img: HTMLImageElement | HTMLCanvasElement,
  map: [RGB, RGB][],
): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  if (map.length === 0) return cv;
  const data = ctx.getImageData(0, 0, cv.width, cv.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    for (const [from, to] of map) {
      if (px[i] === from[0] && px[i + 1] === from[1] && px[i + 2] === from[2]) {
        px[i] = to[0];
        px[i + 1] = to[1];
        px[i + 2] = to[2];
        break;
      }
    }
  }
  ctx.putImageData(data, 0, 0);
  return cv;
}
