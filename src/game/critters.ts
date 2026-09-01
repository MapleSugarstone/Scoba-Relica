import type { Art } from "../engine/assets";
import { DOLL_H, DOLL_PIVOT, DOLL_W, type WorldSprite } from "../engine/paperdoll";
import { ART } from "../engine/renderer";
import { hexToRgb, hueShift, paletteSwap } from "../engine/recolor";
import { sharedSwaps, type ColorCount } from "../sim/breeding";
import { SHINY_TURN, type ScobaInstance, type Summoner, type Tint } from "../sim/scoba";
import { SPECIES, type Species } from "../sim/species";
import { TYPE_COLORS } from "../sim/types";
import { Actor, type ActorSkin } from "./actors";

// Scoba art shares the character doll's canvas and feet line, so critters draw
// and animate through the same path the player does. Species whose art is not
// drawn yet get a blob in their type color, so it is obvious at a glance what
// is real art and what is standing in.

const placeholders = new Map<string, HTMLCanvasElement>();

function placeholderArt(sp: Species): HTMLCanvasElement {
  const hit = placeholders.get(sp.id);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = DOLL_W;
  cv.height = DOLL_H;
  const ctx = cv.getContext("2d")!;
  const cx = DOLL_PIVOT.x;
  const cy = DOLL_PIVOT.y - 24;

  ctx.lineJoin = "round";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 5;
  ctx.fillStyle = TYPE_COLORS[sp.type];
  ctx.beginPath();
  ctx.ellipse(cx, cy, 27, 23, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Feet, so it reads as standing on the same line as everything else.
  for (const dx of [-13, 13]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx, DOLL_PIVOT.y - 5, 8, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  for (const dx of [-9, 9]) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(cx + dx, cy - 4, 6, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.ellipse(cx + dx, cy - 3, 3, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  placeholders.set(sp.id, cv);
  return cv;
}

const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();

/** Opaque bounds of a sprite, so portraits can crop to the critter itself. */
function contentBox(key: string, img: CanvasImageSource, w: number, h: number) {
  const hit = boxes.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3]! < 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const box = maxX < 0
    ? { x: 0, y: 0, w, h }
    : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  boxes.set(key, box);
  return box;
}

type ScobaImage = HTMLCanvasElement | HTMLImageElement;

/** The species' own art, before anything is painted over it. */
function baseArt(art: Art, sp: Species): ScobaImage {
  return (sp.sprite.kind === "art" ? art.scobas[sp.sprite.art] : null) ?? placeholderArt(sp);
}

/**
 * Where a species' art actually sits, in world units, measured from the feet
 * it stands on and the centre it is mirrored about. Every species is drawn on
 * the same 118x139 canvas, so how big one looks is a question about which of
 * those pixels it fills, and nothing else can answer it.
 *
 * The battle scene hangs its arrows and its ring off this, so a marker sits
 * just over a head whatever size that head is.
 */
export interface CritterBounds {
  /** Left edge of the drawn pixels, from the sprite's own centre. */
  left: number;
  width: number;
  /** How far the topmost drawn pixel rises above the feet line. */
  top: number;
  height: number;
}

export function critterBounds(art: Art, sp: Species): CritterBounds {
  // A colour swap moves no pixels, so every mask of a species measures the same
  // and the species' own id is key enough.
  const box = contentBox(sp.id, baseArt(art, sp), DOLL_W, DOLL_H);
  return {
    left: (box.x - DOLL_PIVOT.x) / ART,
    width: box.w / ART,
    top: (DOLL_PIVOT.y - box.y) / ART,
    height: box.h / ART,
  };
}

const tinted = new Map<string, ScobaImage>();

function tintKey(sp: Species, tint?: Tint, shiny?: boolean): string {
  const base = tint ? `${sp.id}:${tint.from}>${tint.to}` : sp.id;
  return shiny ? `${base}:shiny` : base;
}

/**
 * Line art, never turned: white because a shiny that is mostly white has
 * nothing to show for it, black because it is the outline holding the drawing
 * together. The same pair breeding leaves alone.
 */
const LINE_ART = new Set(["#000000", "#ffffff"]);

/**
 * The colour a shiny turns. It is read off the sprite as it is actually drawn,
 * father's mark and all, so a bred Scoba turns the colour it is wearing rather
 * than the one its species was born with.
 */
export function shinyTint(art: Art, sp: Species, tint?: Tint): Tint | null {
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  // Greys have no hue to turn, so the pick walks past them to the commonest
  // colour that does. A Scoba drawn entirely in greys turns nothing, and shows
  // its shininess through the glitter and the star alone.
  for (const c of spriteColors(art, sp, tint)) {
    if (LINE_ART.has(c.hex)) continue;
    const [r, g, b] = hueShift(hexToRgb(c.hex), SHINY_TURN);
    const to = `#${hex(r)}${hex(g)}${hex(b)}`;
    if (to !== c.hex) return { from: c.hex, to };
  }
  return null;
}

/**
 * The image a Scoba is drawn from: the species art with its inherited colour
 * mask painted over it, and a shiny's turned colour over that. Masked art is
 * built once and kept, since a bred line wears the same swap for the rest of
 * the game.
 */
export function critterImage(art: Art, sp: Species, tint?: Tint, shiny?: boolean): ScobaImage {
  const base = baseArt(art, sp);
  if (!tint && !shiny) return base;
  const key = tintKey(sp, tint, shiny);
  const hit = tinted.get(key);
  if (hit) return hit;
  // Two passes rather than one map: the shiny turn reads the palette the tint
  // leaves behind, so the father's colour is what gets turned when it wins.
  let img = base;
  if (tint) img = paletteSwap(img, [[hexToRgb(tint.from), hexToRgb(tint.to)]]);
  if (shiny) {
    const turn = shinyTint(art, sp, tint);
    if (turn) img = paletteSwap(img, [[hexToRgb(turn.from), hexToRgb(turn.to)]]);
  }
  tinted.set(key, img);
  return img;
}

/** The overworld sprite: drawn art where there is any, a type blob where not. */
export function critterSprite(art: Art, sp: Species, tint?: Tint, shiny?: boolean): WorldSprite {
  return { img: critterImage(art, sp, tint, shiny), px: DOLL_PIVOT.x, py: DOLL_PIVOT.y };
}

export function critterSkin(art: Art, sp: Species, tint?: Tint, shiny?: boolean): ActorSkin {
  return { sprite: critterSprite(art, sp, tint, shiny), motion: sp.movement, sparkle: shiny };
}

/**
 * What a Pawn wears: whichever of its summoner's colour marks its own art has a
 * colour for, in the order the summoner wears them. A Pawn drawn in a palette
 * that shares nothing with the one that called it keeps its own colours and
 * does not glitter, however rare the summoner is.
 */
export function pawnLook(art: Art, sp: Species, from: Summoner): { swaps: Tint[]; shiny: boolean } {
  const summoner = SPECIES[from.speciesId];
  const worn = spriteColors(art, sp).map((c) => c.hex);
  // Both marks are offered in the order the summoner wears them, so the shiny
  // turn is matched against what the father's mark left behind.
  const offered: (Tint | null)[] = [
    from.tint ?? null,
    from.shiny && summoner ? shinyTint(art, summoner, from.tint) : null,
  ];
  const kept = sharedSwaps(worn, offered);
  return {
    swaps: kept.filter((t): t is Tint => t !== null),
    shiny: kept[1] !== null,
  };
}

const pawnImages = new Map<string, ScobaImage>();

/** A Pawn's art with its summoner's marks painted on, built once and kept. */
function pawnImage(art: Art, sp: Species, from: Summoner, swaps: Tint[]): ScobaImage {
  const base = baseArt(art, sp);
  if (swaps.length === 0) return base;
  const key = `${sp.id}<${from.speciesId}:${swaps.map((t) => `${t.from}>${t.to}`).join(",")}`;
  const hit = pawnImages.get(key);
  if (hit) return hit;
  // One pass each, in order: a swap has to be able to read what the one before
  // it left, the same way a shiny turn reads a father's mark on a bred Scoba.
  let img = base;
  for (const t of swaps) img = paletteSwap(img, [[hexToRgb(t.from), hexToRgb(t.to)]]);
  pawnImages.set(key, img);
  return img;
}

/**
 * The skin for one Scoba as it actually is: a Pawn takes its colours from
 * whoever called it and comes out small, everything else wears its own.
 */
export function critterLook(art: Art, sp: Species, s: ScobaInstance): ActorSkin {
  if (!s.summoner) return critterSkin(art, sp, s.tint, s.shiny);
  const look = pawnLook(art, sp, s.summoner);
  return {
    sprite: { img: pawnImage(art, sp, s.summoner, look.swaps), px: DOLL_PIVOT.x, py: DOLL_PIVOT.y },
    motion: sp.movement,
    sparkle: look.shiny,
  };
}

export function critterActor(
  art: Art, sp: Species, x: number, y: number, tint?: Tint, shiny?: boolean,
): Actor {
  return new Actor(x, y, critterSkin(art, sp, tint, shiny));
}

const palettes = new Map<string, ColorCount[]>();

/**
 * Every colour a Scoba is drawn in and how much of it there is, commonest
 * first. Transparent pixels are not a colour; a half-transparent one counts as
 * what it is, since nothing in this art is anti-aliased.
 */
export function spriteColors(art: Art, sp: Species, tint?: Tint): ColorCount[] {
  const key = tintKey(sp, tint);
  const hit = palettes.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = DOLL_W;
  cv.height = DOLL_H;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(critterImage(art, sp, tint), 0, 0);
  const px = ctx.getImageData(0, 0, DOLL_W, DOLL_H).data;
  const counts = new Map<string, number>();
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < 8) continue;
    const key2 = `#${hex(px[i]!)}${hex(px[i + 1]!)}${hex(px[i + 2]!)}`;
    counts.set(key2, (counts.get(key2) ?? 0) + 1);
  }
  const out = [...counts].map(([h, count]) => ({ hex: h, count }))
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
  palettes.set(key, out);
  return out;
}

/** Menu portrait, cropped to the critter itself and shown at world scale. */
export function critterPortrait(
  art: Art, sp: Species, tint?: Tint, shiny?: boolean,
): HTMLCanvasElement {
  const img = critterImage(art, sp, tint, shiny);
  // A colour swap moves no pixels, so every mask of a species crops the same.
  const box = contentBox(sp.id, img, DOLL_W, DOLL_H);
  const cv = document.createElement("canvas");
  cv.width = box.w;
  cv.height = box.h;
  const ctx = cv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  cv.style.width = `${box.w}px`;
  cv.style.height = `${box.h}px`;
  cv.className = "critter";
  return cv;
}
