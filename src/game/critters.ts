import type { Art } from "../engine/assets";
import { DOLL_H, DOLL_PIVOT, DOLL_W, worldSprite, type WorldSprite } from "../engine/paperdoll";
import type { Look } from "../engine/recolor";
import { ART } from "../engine/renderer";
import { hexToRgb, hueShift, paletteSwap, type RGB } from "../engine/recolor";
import {
  bodyColors, hueTurn, pairColors, pickTints, sharedSwaps, type ColorCount,
} from "../sim/breeding";
import { SHINY_TURN, type ScobaInstance, type Sire, type Summoner, type Tint } from "../sim/scoba";
import {
  ABILITIES, MOVES, SPECIES, artNameFor, babyOf, wornBy, type MovementStyle, type Species,
} from "../sim/species";
import {
  PLAYER_COSTUME, movementFor, placementFor, setupFor, shadowFor, type Placement, type Spot,
} from "./cosmetics";
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

/** How far a drawing's feet line sits above the bottom edge of its canvas. */
const FEET_UP = DOLL_H - DOLL_PIVOT.y;

/** A drawing's own size, which is not the doll's for a line drawn bigger. */
export function sizeOf(img: ScobaImage): { w: number; h: number } {
  const w = img instanceof HTMLCanvasElement ? img.width : img.naturalWidth || img.width;
  const h = img instanceof HTMLCanvasElement ? img.height : img.naturalHeight || img.height;
  return { w: w || DOLL_W, h: h || DOLL_H };
}

/**
 * Where a drawing stands on its own canvas: across the middle, with the feet
 * line the same distance above the bottom whatever the canvas measures. A line
 * drawn on a bigger sheet than the rest grows up and outward from the same spot
 * on the ground rather than sinking into it.
 */
export function pivotOf(size: { w: number; h: number }): { px: number; py: number } {
  return { px: size.w / 2, py: size.h - FEET_UP };
}

/** Opaque bounds of a sprite, so portraits can crop to the critter itself. */
export function contentBox(key: string, img: ScobaImage) {
  const hit = boxes.get(key);
  if (hit) return hit;
  const { w, h } = sizeOf(img);
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

/**
 * A costume a Scoba is currently seen in: `cherryless` once it has spent its
 * cherry, `hyper` while it is in Hyper-Mode. A line with nothing drawn for the
 * set it is wearing falls back to its own art.
 */
export type FormTag = string;

/**
 * The species' own art in the costume it is wearing, before anything is
 * painted over it. A Pawn's comes from `assets/Pawns` rather than
 * `assets/Scobas`.
 */
function baseArt(art: Art, sp: Species, forms: readonly FormTag[] = []): ScobaImage {
  const drawn = sp.pawn ? art.pawns : art.scobas;
  if (sp.sprite.kind !== "art") return placeholderArt(sp);
  const name = artNameFor(sp, forms);
  return (name ? drawn[name] : null) ?? drawn[sp.sprite.art] ?? placeholderArt(sp);
}

/**
 * What a Scoba wears over its art, or null for one wearing nothing. A passive
 * a line has of its own is already drawn into it, so only a Scoba that
 * inherited the passive from somewhere else puts the mark on.
 *
 * Spending the move the passive hands over takes the mark off, the same way it
 * changes the costume of a line that has the passive drawn in: both read the
 * one tag, so a cherry leaves a head exactly when it leaves a glass.
 */
export function accessoryOf(
  sp: Species, secondaryAbility: string, forms: readonly FormTag[] = [],
): string | null {
  const ability = ABILITIES[secondaryAbility];
  if (!ability?.accessory) return null;
  if (sp.secondaryPool.includes(secondaryAbility)) return null;
  const granted = ability.grantsMove ? MOVES[ability.grantsMove] : undefined;
  const spent = granted ? wornBy(granted) : null;
  if (spent && forms.includes(spent)) return null;
  return ability.accessory;
}

/**
 * Where on a sprite something sits on its head: the highest drawn pixel in the
 * middle third of it. Reading the whole width would put a hat on a raised arm,
 * and reading the exact centre misses a head that is drawn off to one side.
 */
function headTop(key: string, img: ScobaImage): { x: number; y: number } {
  const hit = heads.get(key);
  if (hit) return hit;
  const box = contentBox(key, img);
  const { w: imgW, h: imgH } = sizeOf(img);
  const cv = document.createElement("canvas");
  cv.width = imgW;
  cv.height = imgH;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, imgW, imgH).data;
  const from = box.x + Math.floor(box.w / 3);
  const to = box.x + Math.ceil((box.w * 2) / 3);
  let bestY = imgH;
  let runFrom = from;
  let runTo = to;
  for (let y = box.y; y < box.y + box.h; y++) {
    let first = -1;
    let last = -1;
    for (let x = from; x < to; x++) {
      if (px[(y * imgW + x) * 4 + 3]! < 8) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0) continue;
    bestY = y;
    runFrom = first;
    runTo = last;
    break;
  }
  // A sprite with nothing down its middle keeps to the content box.
  const out = bestY >= imgH
    ? { x: box.x + box.w / 2, y: box.y }
    : { x: (runFrom + runTo + 1) / 2, y: bestY };
  heads.set(key, out);
  return out;
}

const heads = new Map<string, { x: number; y: number }>();

/** How far an accessory sinks into the head it sits on. */
const ACCESSORY_SINK = 4;

/**
 * The art with something worn on it. Behind the Scoba by default, so the piece
 * reads as sitting against the back of a head rather than stuck to its face,
 * and in front where the line's placement asks for that.
 *
 * An accessory is drawn on the same canvas a Scoba is, so where it sits in its
 * own file says nothing about where it goes. Only the pixels are taken, and
 * they are placed against the head at the size they were drawn.
 */
function withAccessory(
  art: Art, costume: string, img: ScobaImage, worn: string,
): { img: ScobaImage; dx: number; dy: number } {
  const still = { img, dx: 0, dy: 0 };
  const piece = art.accessories[worn];
  if (!piece) return still;
  const from = contentBox(`accessory:${worn}`, piece);
  if (from.w <= 0 || from.h <= 0) return still;
  const at = accessorySpot(art, costume, img, worn);
  const body = sizeOf(img);
  // The canvas is grown to hold both rather than cropped to the body, so a
  // piece nudged off the edge of the sheet is still drawn whole. What it grew
  // by on the left and top is handed back, because the pivot moves with it.
  const dx = Math.max(0, -at.x);
  const dy = Math.max(0, -at.y);
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(Math.max(body.w + dx, at.x + dx + from.w));
  cv.height = Math.ceil(Math.max(body.h + dy, at.y + dy + from.h));
  const ctx = cv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const put = (): void =>
    ctx.drawImage(piece, from.x, from.y, from.w, from.h, at.x + dx, at.y + dy, from.w, from.h);
  // Behind by default, so the Scoba's own outline stays on top. A costume that
  // says otherwise wears it over the front instead.
  const front = placementFor(worn, costume)?.front === true;
  if (!front) put();
  ctx.drawImage(img, dx, dy);
  if (front) put();
  return { img: cv, dx, dy };
}

/**
 * Where a piece's drawn pixels go on a sprite: against the head the art layer
 * found, moved by whatever the cosmetics document says this costume needs. The
 * editor reads this too, so what it drags is what the game draws.
 */
export function accessorySpot(
  art: Art, costume: string, img: ScobaImage, worn: string,
  override?: Placement,
): { x: number; y: number } {
  const from = accessoryBox(art, worn);
  const head = headTop(costume, img);
  const off = override ?? placementFor(worn, costume) ?? { dx: 0, dy: 0 };
  return {
    x: Math.round(head.x - from.w / 2) + off.dx,
    y: Math.round(head.y + ACCESSORY_SINK - from.h) + off.dy,
  };
}

/**
 * Where a piece sits on a Scoba, in world units off the feet it stands on and
 * the centre it is mirrored about. The same measure `critterBounds` gives, so
 * the scene can hang something off it the way it hangs a marker off a head.
 *
 * Answered whether or not the Scoba is actually wearing the piece, because a
 * line with it drawn into its own art throws from where it is drawn all the
 * same.
 */
export function accessoryAnchor(
  art: Art, sp: Species, worn: string, forms: readonly FormTag[] = [],
): { x: number; y: number } {
  const costume = formKey(sp, forms);
  const body = critterArt(art, sp, undefined, false, { forms });
  const box = accessoryBox(art, worn);
  const at = accessorySpot(art, costume, body.img, worn);
  // The middle of the piece rather than its corner, which is what a throw
  // should leave from.
  return {
    x: (at.x + box.w / 2 - body.px) / ART,
    y: (body.py - (at.y + box.h / 2)) / ART,
  };
}

/**
 * Where a piece sits on a costume before anybody nudges it, in sprite pixels
 * off the feet. Each drawing of a line puts it somewhere of its own, which is
 * what a stored nudge is measured from. Anything wanting the same piece in the
 * same place on two drawings has to work the difference out through this.
 */
export function autoPieceSpot(
  art: Art, sp: Species, worn: string, forms: readonly FormTag[] = [],
): Spot {
  const drawn = critterArt(art, sp, undefined, false, { forms });
  const at = accessorySpot(art, formKey(sp, forms), drawn.img, worn, { dx: 0, dy: 0 });
  return { dx: at.x - drawn.px, dy: at.y - drawn.py };
}

/** The drawn pixels of a piece, which is what is placed rather than its file. */
export function accessoryBox(art: Art, worn: string): { x: number; y: number; w: number; h: number } {
  const piece = art.accessories[worn];
  if (!piece) return { x: 0, y: 0, w: 0, h: 0 };
  return contentBox(`accessory:`, piece);
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

export function critterBounds(art: Art, sp: Species, opts: LookOpts = {}): CritterBounds {
  // A colour swap moves no pixels, so every mask of a costume measures the same
  // and the costume's own name is key enough. A costume does move them, and so
  // does something worn over the art, so both are named in the key.
  const key = tintKey(sp, undefined, false, opts);
  const drawn = critterArt(art, sp, undefined, false, opts);
  const box = contentBox(key, drawn.img);
  return {
    left: (box.x - drawn.px) / ART,
    width: box.w / ART,
    top: (drawn.py - box.y) / ART,
    height: box.h / ART,
  };
}

/**
 * The middle of a drawing's own pixels, in sprite pixels off the feet pivot.
 * This is what a throw leaves from and what one lands on before anybody nudges
 * either, so a Scoba nobody has touched is hit in the body rather than at the
 * ankles, and follows its own art when it is redrawn.
 */
export function contentMiddle(art: Art, sp: Species, forms: readonly FormTag[]): Spot {
  const key = tintKey(sp, undefined, false, { forms });
  const drawn = critterArt(art, sp, undefined, false, { forms });
  const box = contentBox(key, drawn.img);
  return {
    dx: box.x + box.w / 2 - drawn.px,
    dy: box.y + box.h / 2 - drawn.py,
  };
}

const shift = (at: Spot, by: Spot | undefined): Spot =>
  by ? { dx: at.dx + by.dx, dy: at.dy + by.dy } : at;

/** A spot on a drawing, in world units off the feet, with up positive. */
const toWorld = (at: Spot): { x: number; y: number } => ({ x: at.dx / ART, y: -at.dy / ART });

/**
 * Where a throw leaves this costume from, in world units off its feet. The
 * middle of its drawn pixels unless the editor has moved it.
 */
export function originAnchor(
  art: Art, sp: Species, forms: readonly FormTag[] = [],
): { x: number; y: number } {
  const setup = setupFor(formKey(sp, forms));
  return toWorld(shift(contentMiddle(art, sp, forms), setup.origin));
}

/** Where a throw lands on this costume, measured the same way. */
export function centerAnchor(
  art: Art, sp: Species, forms: readonly FormTag[] = [],
): { x: number; y: number } {
  const setup = setupFor(formKey(sp, forms));
  return toWorld(shift(contentMiddle(art, sp, forms), setup.center));
}

/**
 * The sprite for the shadow a costume stands on, or nothing where it casts
 * none. Built as a sprite of its own with the offset folded into its pivot, so
 * whatever draws a body can draw its shadow through the same path.
 *
 * A shadow is drawn on the same canvas the bodies are and hangs from the same
 * feet, so it lands where it was drawn and a nudge moves it from there.
 */
export function shadowSprite(art: Art, costume: string): WorldSprite | null {
  const shadow = shadowFor(costume);
  const img = art.accessories[shadow.art];
  if (!img) return null;
  const own = pivotOf(sizeOf(img));
  return { img, px: own.px - shadow.dx, py: own.py - shadow.dy };
}

/** How a line carries itself: what the editor says, or what its species does. */
export function movementOf(sp: Species): MovementStyle {
  return movementFor(sp.id) ?? sp.movement;
}

/**
 * The pivot a drawing hangs from, which is its own feet unless the whole thing
 * has been moved off them.
 */
function bodyPivot(costume: string, img: ScobaImage): { px: number; py: number } {
  const body = setupFor(costume).body;
  const own = pivotOf(sizeOf(img));
  return {
    px: own.px - (body?.dx ?? 0),
    py: own.py - (body?.dy ?? 0),
  };
}

const tinted = new Map<string, CritterArt>();

/**
 * Drops every built image. The cosmetics editor moves a piece on a line that
 * may already be drawn somewhere, and a kept image would otherwise outlive the
 * placement it was built from.
 */
export function forgetBuiltArt(): void {
  tinted.clear();
  pawnImages.clear();
  palettes.clear();
  // Both are measured off a built drawing, and moving a piece changes the
  // pixels and now the size of the sheet they were measured on.
  boxes.clear();
  heads.clear();
}

/** What a Scoba is wearing on top of its species art. */
export interface LookOpts {
  /** Costumes it is currently seen in, in any order. */
  forms?: readonly FormTag[];
  /** Art worn over it, by file name, or null for nothing. */
  accessory?: string | null;
}

/** The costume a set of tags names, for keying anything built from it. */
function formKey(sp: Species, forms: readonly FormTag[] = []): string {
  return artNameFor(sp, forms) ?? sp.id;
}

/** A father's line, for keying anything built from his colours. */
function sireKey(sire?: Sire): string {
  return sire ? `<${sire}` : "";
}

function tintKey(sp: Species, sire?: Sire, shiny?: boolean, opts: LookOpts = {}): string {
  const base = `${formKey(sp, opts.forms)}${sireKey(sire)}`;
  const lit = shiny ? `${base}:shiny` : base;
  return opts.accessory ? `${lit}+${opts.accessory}` : lit;
}

/**
 * The swaps a Scoba wears on the sprite it is being drawn as.
 *
 * Worked out here rather than kept on the Scoba, so it follows it: a Sqwoop
 * that grows into an Octoshake, or an Octoshake that goes Hyper, is a
 * different drawing with a different palette, and a swap written against the
 * old one would find nothing to replace. Colours the two drawings share come
 * out the same, because the same rule is run over the same father.
 */
export function tintsFor(
  art: Art, sp: Species, sire?: Sire, forms: readonly FormTag[] = [],
): Tint[] {
  if (!sire) return [];
  const dadSp = SPECIES[sire];
  if (!dadSp) return [];
  const key = `${formKey(sp, forms)}${sireKey(sire)}`;
  const hit = swaps.get(key);
  if (hit) return hit;
  // His own art, with nothing on it that he picked up himself. Inheritance
  // does not compound: a father who wears another line's colours still hands
  // on the ones his species is drawn in.
  const his = spriteColors(art, dadSp);
  // Measured against the drawing the line starts as, so growing up keeps the
  // colours it already had and works out only the ones the new drawing brought
  // with it. A line with no baby form is its own starting point.
  const first = babyOf(sp) ?? sp;
  const base = spriteColors(art, first, undefined, false);
  const out = carriedTints(his, base, spriteColors(art, sp, undefined, false, forms));
  swaps.set(key, out);
  return out;
}

/**
 * The swaps one drawing takes, worked out from the ones another already takes.
 * This is how a costume follows the art it is a redrawing of, and how a grown
 * form follows the baby it grew out of.
 *
 * Either way it is the same Scoba: every colour the two drawings share keeps
 * the swap it already had, and one the first drawing keeps unpainted stays
 * unpainted here too. Only colours the new drawing brought with it are worked
 * out fresh, from whatever of the father's palette the shared ones did not
 * already spend.
 *
 * Computed against the new drawing alone instead and the two would disagree: a
 * body colour that happens to be the commonest in one and the second commonest
 * in the other would be kept in one and painted over in the other, which is
 * what a Scoba losing its colours on evolving looks like.
 */
function carriedTints(his: ColorCount[], base: ColorCount[], mine: ColorCount[]): Tint[] {
  const baseTints = pickTints(his, base);
  const here = new Set(mine.map((c) => c.hex));
  const kept = baseTints.filter((t) => here.has(t.from));
  // What the line's own art was left holding, which the costume holds too.
  const painted = new Set(baseTints.map((t) => t.from));
  const settled = new Set([...painted, ...base.map((c) => c.hex)]);
  const fresh = bodyColors(mine).filter((c) => !settled.has(c.hex));
  if (fresh.length === 0) return kept;
  const spent = new Set(kept.map((t) => t.to));
  const left = bodyColors(his).filter((c) => !spent.has(c.hex) && !here.has(c.hex));
  const primary = bodyColors(base)[0];
  const turn = primary && left[0] ? hueTurn(primary.hex, left[0].hex) : 0;
  return [...kept, ...pairColors(fresh, left, turn)];
}

const swaps = new Map<string, Tint[]>();

/**
 * Line art, never turned: white because a shiny that is mostly white has
 * nothing to show for it, black because it is the outline holding the drawing
 * together. The same pair breeding leaves alone.
 */
const LINE_ART = new Set(["#000000", "#ffffff"]);

/**
 * The colours a shiny turns: every one it is drawn in, each moved the same way
 * round the wheel, so the whole Scoba reads as a recolour rather than one patch
 * of it. They are read off the sprite as it is actually drawn, father's mark
 * and all, so a bred Scoba turns the colours it is wearing rather than the ones
 * its species was born with.
 *
 * Greys have no hue to turn and the outline holds the drawing together, so both
 * are left. A Scoba drawn entirely in greys turns nothing and shows what it is
 * through the glitter and the star alone.
 */
export function shinyTints(art: Art, sp: Species, sire?: Sire): Tint[] {
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  const out: Tint[] = [];
  for (const c of spriteColors(art, sp, sire)) {
    if (LINE_ART.has(c.hex)) continue;
    const [r, g, b] = hueShift(hexToRgb(c.hex), SHINY_TURN);
    const to = `#${hex(r)}${hex(g)}${hex(b)}`;
    if (to !== c.hex) out.push({ from: c.hex, to });
  }
  return out;
}

/** A drawing together with the point on it that stands on the ground. */
export interface CritterArt extends WorldSprite {
  img: ScobaImage;
}

/**
 * The drawing a Scoba is made of and where its feet are: the species art with
 * its inherited colour mask painted over it, a shiny's turned colour over that,
 * and anything it wears over the lot. Built once and kept, since a bred line
 * wears the same swap for the rest of the game.
 *
 * The pivot comes back with it because a piece worn off the edge of the sheet
 * grows the canvas, and a line drawn on a bigger sheet than the rest has its
 * own to begin with.
 */
export function critterArt(
  art: Art, sp: Species, sire?: Sire, shiny?: boolean, opts: LookOpts = {},
): CritterArt {
  const base = baseArt(art, sp, opts.forms);
  if (!sire && !shiny && !opts.accessory) return { img: base, ...pivotOf(sizeOf(base)) };
  const key = tintKey(sp, sire, shiny, opts);
  const hit = tinted.get(key);
  if (hit) return hit;
  const tints = tintsFor(art, sp, sire, opts.forms);
  // The father's marks all go on in one pass: each pixel takes the first swap
  // that matches it, so a colour he painted on cannot be painted over again by
  // a later one of his own. The shiny turn is a pass of its own after them,
  // because it reads the palette they left behind.
  let img = base;
  if (tints && tints.length > 0) {
    img = paletteSwap(img, tints.map((t): [RGB, RGB] => [hexToRgb(t.from), hexToRgb(t.to)]));
  }
  if (shiny) {
    // One pass for the lot: every pixel takes the turn its own colour asks for,
    // so a colour that has been turned is never turned again by another's.
    const turns = shinyTints(art, sp, sire);
    if (turns.length > 0) {
      img = paletteSwap(img, turns.map((t): [RGB, RGB] => [hexToRgb(t.from), hexToRgb(t.to)]));
    }
  }
  let pivot = pivotOf(sizeOf(img));
  if (opts.accessory) {
    const grown = withAccessory(art, formKey(sp, opts.forms), img, opts.accessory);
    img = grown.img;
    pivot = { px: pivot.px + grown.dx, py: pivot.py + grown.dy };
  }
  const built: CritterArt = { img, ...pivot };
  tinted.set(key, built);
  return built;
}

/** The pixels alone, for everything that measures a drawing rather than places it. */
export function critterImage(
  art: Art, sp: Species, sire?: Sire, shiny?: boolean, opts: LookOpts = {},
): ScobaImage {
  return critterArt(art, sp, sire, shiny, opts).img;
}

/** The overworld sprite: drawn art where there is any, a type blob where not. */
export function critterSprite(
  art: Art, sp: Species, sire?: Sire, shiny?: boolean, opts: LookOpts = {},
): WorldSprite {
  const drawn = critterArt(art, sp, sire, shiny, opts);
  // The drawing's own feet, moved by whatever the editor lifted the body by.
  const body = setupFor(formKey(sp, opts.forms ?? [])).body;
  return {
    img: drawn.img,
    px: drawn.px - (body?.dx ?? 0),
    py: drawn.py - (body?.dy ?? 0),
  };
}

/**
 * The skin for a character rather than a Scoba: the player, their partner and
 * every NPC. All of them are the one drawing in different clothes, so they
 * share a single entry in the cosmetics document and stand on the same shadow.
 */
export function personSkin(art: Art, look: Look): ActorSkin {
  const skin: ActorSkin = { sprite: worldSprite(art.doll, look), motion: "hop" };
  const shadow = shadowSprite(art, PLAYER_COSTUME);
  if (shadow) skin.shadow = shadow;
  return skin;
}

export function critterSkin(
  art: Art, sp: Species, sire?: Sire, shiny?: boolean, opts: LookOpts = {},
): ActorSkin {
  const skin: ActorSkin = {
    sprite: critterSprite(art, sp, sire, shiny, opts),
    motion: movementOf(sp),
    sparkle: shiny,
  };
  const shadow = shadowSprite(art, formKey(sp, opts.forms ?? []));
  if (shadow) skin.shadow = shadow;
  return skin;
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
  // turn is matched against what the father's mark left behind. The father's
  // marks are however many his palette needs, so the turn is found by where it
  // was put rather than at a fixed place in the list.
  const inherited = summoner ? tintsFor(art, summoner, from.sire) : [];
  const turns = from.shiny && summoner ? shinyTints(art, summoner, from.sire) : [];
  const kept = sharedSwaps(worn, [...inherited, ...turns]);
  return {
    swaps: kept.filter((t): t is Tint => t !== null),
    // It glitters if any of her turned colours reached it at all.
    shiny: kept.slice(inherited.length).some((t) => t !== null),
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
export function critterLook(
  art: Art, sp: Species, s: ScobaInstance, forms: readonly FormTag[] = [],
): ActorSkin {
  if (!s.summoner) {
    return critterSkin(art, sp, s.sire, s.shiny, lookOf(sp, s, forms));
  }
  const look = pawnLook(art, sp, s.summoner);
  const worn = pawnImage(art, sp, s.summoner, look.swaps);
  const skin: ActorSkin = {
    sprite: { img: worn, ...bodyPivot(formKey(sp, forms), worn) },
    motion: movementOf(sp),
    sparkle: look.shiny,
  };
  const shadow = shadowSprite(art, formKey(sp, forms));
  if (shadow) skin.shadow = shadow;
  return skin;
}

export function critterActor(
  art: Art, sp: Species, x: number, y: number, sire?: Sire, shiny?: boolean, opts: LookOpts = {},
): Actor {
  return new Actor(x, y, critterSkin(art, sp, sire, shiny, opts));
}

const palettes = new Map<string, ColorCount[]>();

/**
 * Every colour a Scoba is drawn in and how much of it there is, commonest
 * first. Transparent pixels are not a colour; a half-transparent one counts as
 * what it is, since nothing in this art is anti-aliased.
 */
export function spriteColors(
  art: Art, sp: Species, sire?: Sire, shiny = false, forms: readonly FormTag[] = [],
): ColorCount[] {
  const key = tintKey(sp, sire, shiny, { forms });
  const hit = palettes.get(key);
  if (hit) return hit;
  const img = critterImage(art, sp, sire, shiny, { forms });
  const { w, h } = sizeOf(img);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
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

/**
 * What one Scoba is wearing, for anywhere that has the Scoba rather than just
 * its species. `forms` is battle state and is passed in by whoever holds it.
 */
export function lookOf(sp: Species, s: ScobaInstance, forms: readonly FormTag[] = []): LookOpts {
  return { forms, accessory: accessoryOf(sp, s.secondaryAbility, forms) };
}

/** Menu portrait, cropped to the critter itself and shown at world scale. */
export function critterPortrait(
  art: Art, sp: Species, sire?: Sire, shiny?: boolean, opts: LookOpts = {},
): HTMLCanvasElement {
  const img = critterImage(art, sp, sire, shiny, opts);
  // A colour swap moves no pixels, so every mask of one costume crops the same.
  const box = contentBox(tintKey(sp, undefined, false, opts), img);
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
