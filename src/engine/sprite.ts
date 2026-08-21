import { ART } from "./renderer";
import type { WorldSprite } from "./paperdoll";

// Characters are one front-facing sprite with no back or side art: direction
// reads through the horizontal mirror, and movement reads as a hop, the way a
// board-game piece gets walked across a board. Nothing ever deforms.

export interface Motion {
  /** Hops per second. */
  rate: number;
  /** Arc height, in art px. */
  hop: number;
  /** Lean at the top of the arc, in radians; it alternates sides each hop. */
  tilt: number;
  /** Constant lift, in art px, for critters that never touch the ground. */
  float: number;
  /** How much of the motion keeps going while standing still, 0 to 1. */
  idle: number;
}

export interface Bounce {
  hop: number; // art px
  angle: number;
}

/** One hop per unit of `t`. `ease` fades the motion in and out as it walks. */
export function bounce(m: Motion, t: number, ease: number): Bounce {
  const e = m.idle + (1 - m.idle) * ease;
  return {
    hop: m.float + Math.abs(Math.sin(t * Math.PI)) * m.hop * e,
    angle: Math.sin(t * Math.PI) * m.tilt * e,
  };
}

export function drawDoll(
  ctx: CanvasRenderingContext2D,
  s: WorldSprite,
  x: number,
  y: number, // feet position, world-to-screen already applied
  dir: 1 | -1,
  b: Bounce,
): void {
  // Never anything but 1/ART. One pixel grid runs through the whole scene, and
  // a sprite drawn at a fraction of it would put its three-pixel outline across
  // pixel edges while everything beside it kept a hard one.
  const u = 1 / ART; // world units per art px
  // Snap to whole device px: the sprite has four times the world's pixel
  // density, so it can sit on quarter units without smearing.
  const dx = Math.round(x * ART) / ART;
  const dy = Math.round((y - b.hop * u) * ART) / ART;
  ctx.save();
  ctx.translate(dx, dy);
  if (b.angle !== 0) ctx.rotate(b.angle);
  ctx.scale(dir * u, u);
  ctx.drawImage(s.img, -s.px, -s.py);
  ctx.restore();
}

/** How often a shiny shows another point of light, in seconds. */
const SPARK_EVERY = 0.16;
/** Nothing keeps more than this many, however long a frame runs. */
const SPARK_CAP = 24;
/** How long one takes to swell up and fade away again. */
const SPARK_LIFE = 0.9;
/** How far out from the body one can appear, in world units. */
const SPARK_RANGE = 13;

/**
 * One point of light on a shiny. It appears somewhere near the body, swells,
 * fades and is gone: nothing moves it, and nothing pulls it down.
 */
export interface Spark {
  x: number;
  y: number;
  /** Height over the ground it hangs at. It stays there. */
  z: number;
  life: number;
  max: number;
  /** Cream or white, so a flurry is not all one colour. */
  warm: boolean;
}

/** A fresh point of light somewhere around a body standing at (x, y). */
export function emitSpark(x: number, y: number, rand: () => number = Math.random): Spark {
  const a = rand() * Math.PI * 2;
  // Square-rooted, so they scatter evenly over the circle instead of bunching
  // up in the middle of it.
  const r = Math.sqrt(rand()) * SPARK_RANGE;
  const life = SPARK_LIFE * (0.7 + rand() * 0.6);
  return {
    x: x + Math.cos(a) * r,
    // Halved down the screen: the ground reads as a plane seen at an angle, so
    // a circle drawn on it comes out squashed.
    y: y + Math.sin(a) * r * 0.5,
    z: 5 + rand() * 15,
    life,
    max: life,
    warm: rand() < 0.5,
  };
}

/** Age every point of light, dropping the ones that have faded out. */
export function stepSparks(list: Spark[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const sp = list[i]!;
    sp.life -= dt;
    if (sp.life <= 0) list.splice(i, 1);
  }
}

/**
 * The glitter: four-pointed stars that swell in and fade out where they are.
 * Drawn from axis-aligned rects at art resolution rather than as shapes, so
 * nothing here softens an edge the way the rest of the art never does.
 */
export function drawSparks(
  ctx: CanvasRenderingContext2D,
  list: Spark[],
  camX: number,
  camY: number,
  alpha = 1,
): void {
  const u = 1 / ART;
  for (const sp of list) {
    // Nothing at either end of its life, widest in the middle.
    const grow = Math.sin((1 - sp.life / sp.max) * Math.PI);
    if (grow <= 0.02) continue;
    const px = Math.round((sp.x - camX) * ART) / ART;
    const py = Math.round((sp.y - sp.z - camY) * ART) / ART;
    const arm = Math.max(1, Math.round(0.6 + grow * 4));
    ctx.fillStyle = sp.warm ? "#fff6c4" : "#ffffff";
    ctx.globalAlpha = alpha * grow;
    ctx.fillRect(px - arm * u, py - u / 2, arm * 2 * u, u);
    ctx.fillRect(px - u / 2, py - arm * u, u, arm * 2 * u);
  }
  ctx.globalAlpha = 1;
}

/**
 * Show points of light at a steady rate while `carry` counts up past the gap
 * between them. Returns the leftover, to be carried into the next frame.
 */
export function shedSparks(list: Spark[], x: number, y: number, carry: number, dt: number): number {
  let left = carry + dt;
  while (left >= SPARK_EVERY) {
    left -= SPARK_EVERY;
    if (list.length < SPARK_CAP) list.push(emitSpark(x, y));
  }
  return left;
}

// An earlier turn at the glitter, kept in case it is wanted back: each point
// turned around the spot it was shed from, spiralled outward, fell under
// gravity and left a fading mark where it hit the ground, so a walking shiny
// strung a trail behind it. Swap it back in wholesale; the four exported names
// and their signatures are the same.
//
// /** How often a shiny sheds another point of light, in seconds. */
// const SPARK_EVERY = 0.11;
// /** Nothing keeps more than this many, however long a frame runs. */
// const SPARK_CAP = 34;
// /**
//  * How long one lasts in the air, and how long its mark lasts once down. The
//  * pull is set so a spark reaches the ground well inside its life: one that
//  * winks out in mid-air leaves nothing behind, and the mark is the trail.
//  */
// const SPARK_LIFE = 1.9;
// const MARK_LIFE = 1.5;
// /** How hard they are pulled down, in world units per second per second. */
// const SPARK_GRAVITY = 26;
//
// /**
//  * One point of light a shiny has shed. It turns around the spot it came off
//  * rather than around the body, and that spot stays put in the world: a Scoba
//  * standing still wears a flurry, and one walking strings the flurry out behind
//  * it. `z` is height over the ground, so it draws at `y - z` and lands at 0.
//  */
// export interface Spark {
//   /** Where it was shed. Fixed, which is what leaves the trail behind. */
//   ax: number;
//   ay: number;
//   /** Where it is now, worked out from the orbit each step. */
//   x: number;
//   y: number;
//   z: number;
//   /** Its way round the anchor, how fast it goes, and how wide it swings. */
//   ang: number;
//   spin: number;
//   radius: number;
//   spread: number;
//   vz: number;
//   life: number;
//   /** Seconds since it touched down, or -1 while it is still in the air. */
//   down: number;
//   /** Cream or white, so a flurry is not all one colour. */
//   warm: boolean;
// }
//
// /** Where a spark sits, given its anchor and where it has got to in its turn. */
// function place(sp: Spark): void {
//   sp.x = sp.ax + Math.cos(sp.ang) * sp.radius;
//   // Halved down the screen: the ground reads as a plane seen at an angle, so
//   // a circle drawn on it comes out squashed.
//   sp.y = sp.ay + Math.sin(sp.ang) * sp.radius * 0.5;
// }
//
// /** A fresh point of light shed beside a body standing at (x, y). */
// export function emitSpark(x: number, y: number, rand: () => number = Math.random): Spark {
//   const sp: Spark = {
//     ax: x,
//     ay: y,
//     x,
//     y,
//     z: 8 + rand() * 12,
//     ang: rand() * Math.PI * 2,
//     spin: (rand() < 0.5 ? -1 : 1) * (1.6 + rand() * 2.6),
//     radius: 3 + rand() * 4,
//     // Spirals out a little as it drops, so it reads as flung off rather than
//     // running a lap.
//     spread: 1.5 + rand() * 3.5,
//     vz: 2 + rand() * 4,
//     life: SPARK_LIFE * (0.7 + rand() * 0.6),
//     down: -1,
//     warm: rand() < 0.5,
//   };
//   place(sp);
//   return sp;
// }
//
// /** Carry every point of light forward, dropping the ones that are done. */
// export function stepSparks(list: Spark[], dt: number): void {
//   for (let i = list.length - 1; i >= 0; i--) {
//     const sp = list[i]!;
//     if (sp.down >= 0) {
//       sp.down += dt;
//       if (sp.down > MARK_LIFE) list.splice(i, 1);
//       continue;
//     }
//     sp.ang += sp.spin * dt;
//     sp.radius += sp.spread * dt;
//     // The swing settles as it falls, so it spirals rather than flying apart.
//     sp.spread *= Math.max(0, 1 - 1.6 * dt);
//     sp.vz -= SPARK_GRAVITY * dt;
//     sp.z += sp.vz * dt;
//     sp.life -= dt;
//     place(sp);
//     if (sp.z <= 0) {
//       sp.z = 0;
//       sp.down = 0;
//     } else if (sp.life <= 0) {
//       list.splice(i, 1);
//     }
//   }
// }
//
// /**
//  * The glitter, drawn from axis-aligned rects at art resolution rather than as
//  * shapes, so nothing here softens an edge the way the rest of the art never
//  * does. In the air each point is a four-pointed star; once it is down it is a
//  * short mark on the ground that fades where it fell.
//  */
// export function drawSparks(
//   ctx: CanvasRenderingContext2D,
//   list: Spark[],
//   camX: number,
//   camY: number,
//   alpha = 1,
// ): void {
//   const u = 1 / ART;
//   for (const sp of list) {
//     const px = Math.round((sp.x - camX) * ART) / ART;
//     const py = Math.round((sp.y - sp.z - camY) * ART) / ART;
//     ctx.fillStyle = sp.warm ? "#fff6c4" : "#ffffff";
//     if (sp.down >= 0) {
//       const left = 1 - sp.down / MARK_LIFE;
//       ctx.globalAlpha = alpha * left * 0.9;
//       const wide = Math.max(1, Math.round(left * 3));
//       ctx.fillRect(px - wide * u, py - u / 2, wide * 2 * u, u);
//     } else {
//       // Swells in, then thins out again as it falls.
//       const grow = Math.sin(Math.min(1, 1 - sp.life / SPARK_LIFE) * Math.PI);
//       const arm = Math.max(1, Math.round(0.6 + grow * 4));
//       ctx.globalAlpha = alpha * (0.4 + grow * 0.6);
//       ctx.fillRect(px - arm * u, py - u / 2, arm * 2 * u, u);
//       ctx.fillRect(px - u / 2, py - arm * u, u, arm * 2 * u);
//     }
//   }
//   ctx.globalAlpha = 1;
// }
//
// /**
//  * Shed points of light at a steady rate while `carry` counts up past the gap
//  * between them. Returns the leftover, to be carried into the next frame.
//  */
// export function shedSparks(list: Spark[], x: number, y: number, carry: number, dt: number): number {
//   let left = carry + dt;
//   while (left >= SPARK_EVERY) {
//     left -= SPARK_EVERY;
//     if (list.length < SPARK_CAP) list.push(emitSpark(x, y));
//   }
//   return left;
// }
