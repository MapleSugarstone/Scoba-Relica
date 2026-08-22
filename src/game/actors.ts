import type { TileMap } from "../engine/tilemap";
import {
  bounce, drawDoll, drawSparks, shedSparks, stepSparks, type Motion, type Spark,
} from "../engine/sprite";
import type { MovementStyle } from "../sim/species";
import type { WorldSprite } from "../engine/paperdoll";

export interface ActorSkin {
  sprite: WorldSprite;
  motion: MovementStyle;
  /** Wears a shiny's glitter. */
  sparkle?: boolean;
}

/** The gaits a doll sprite can walk with. Species pick one; the player hops. */
export const MOTIONS: Record<MovementStyle, Motion> = {
  hop: { rate: 4, hop: 15, tilt: 0.13, float: 0, idle: 0 },
  scamper: { rate: 5.6, hop: 13, tilt: 0.13, float: 0, idle: 0 },
  hover: { rate: 1.3, hop: 5, tilt: 0.04, float: 9, idle: 1 },
  skitter: { rate: 8, hop: 6, tilt: 0, float: 0, idle: 0 },
};

/**
 * How far an actor has to travel before the y-sorted pass accepts that it is at
 * a different depth, in world units. Two of them milling about on the same
 * baseline would otherwise swap order every frame as their positions crossed
 * and re-crossed, which reads as one clipping in and out of the other.
 */
const DEPTH_SLACK = 4;

export class Actor {
  x: number;
  y: number;
  /**
   * The baseline the y-sorted pass reads, which is not quite where the actor
   * is. It catches up in whole steps once the actor has moved far enough to be
   * somewhere else in the scene, so a companion weaving along beside you holds
   * whichever side of you it is drawn on instead of flickering across it.
   */
  depthY: number;
  dir: 1 | -1 = 1; // last horizontal direction, for mirroring
  moving = false;
  speed = 72;
  radius = 4;
  /**
   * How much of the walking bounce keeps going while standing still, on top
   * of whatever the gait already does at rest. Battles set it so a Scoba
   * stays on its toes; a hovering one is unaffected, since its gait already
   * runs at full while still.
   */
  idleMix = 0;
  /**
   * How solid it is, 0 to 1. A wild one rises into the field rather than
   * appearing whole, so a Scoba never pops into being under your nose.
   */
  fade = 1;
  /**
   * Kept out of the scene entirely rather than faded out. The other player
   * standing on a different map is not somewhere dim, they are somewhere else,
   * and leaving a ghost where they were last seen reads as a bug.
   */
  hidden = false;
  private fadeRate = 0;
  /**
   * Points of light this one has shed. They live in world space, so they stay
   * where they fell instead of riding along, and a shiny leaves a trail.
   */
  private sparks: Spark[] = [];
  private sparkCarry = 0;
  // The hop keeps its phase at rest and eases its height instead, so
  // characters land and settle rather than snapping flat.
  private hopT = 0;
  private hopEase = 0;
  skin: ActorSkin;

  constructor(x: number, y: number, skin: ActorSkin) {
    this.x = x;
    this.y = y;
    this.depthY = y;
    this.skin = skin;
  }

  /**
   * Offsets where this actor is in its own bob, so a group standing together
   * does not rise and fall as one block.
   */
  desync(phase: number): void {
    this.hopT += phase;
  }

  private motion(): Motion {
    return MOTIONS[this.skin.motion];
  }

  /** Move by an axis vector with collision; updates direction and hop state. */
  /** Start it see-through and let it come in over `secs`. */
  ghostIn(secs = 0.7): void {
    this.fade = 0;
    this.fadeRate = 1 / Math.max(0.01, secs);
  }

  step(dt: number, ax: number, ay: number, map: TileMap): void {
    if (this.fade < 1) this.fade = Math.min(1, this.fade + this.fadeRate * dt);
    if (this.skin.sparkle) {
      this.sparkCarry = shedSparks(this.sparks, this.x, this.y, this.sparkCarry, dt);
    }
    if (this.sparks.length > 0) stepSparks(this.sparks, dt);
    const len = Math.hypot(ax, ay);
    this.moving = len > 0.15;
    if (this.moving) {
      const nx = ax / Math.max(1, len);
      const ny = ay / Math.max(1, len);
      const pos = map.moveCircle(this.x, this.y, nx * this.speed * dt, ny * this.speed * dt, this.radius);
      this.x = pos.x;
      this.y = pos.y;
      if (Math.abs(ax) > Math.abs(ay) * 0.9) this.dir = ax < 0 ? -1 : 1;
    }
    // A walk, a placement and a mark on the battle stage all land the same way
    // here: the depth follows once it is a whole step behind.
    if (Math.abs(this.y - this.depthY) >= DEPTH_SLACK) this.depthY = this.y;
    this.hopT += dt * this.motion().rate;
    this.hopEase += ((this.moving ? 1 : this.idleMix) - this.hopEase) * Math.min(1, dt * 9);
  }

  /**
   * Walk toward a point, stopping within `slack`; returns the distance left.
   * Pace eases off over the last stretch so nothing jitters on its target, and
   * is capped at `maxPace`, which never goes above 1: nobody outruns their own
   * legs to catch up.
   */
  /**
   * Walk toward a point, returning how far off it was to start with.
   *
   * The pace eases off over the last stretch, which is what makes a companion
   * settle rather than stop dead. `minPace` puts a floor under that, for a
   * walk that has somewhere to be: without one the approach is asymptotic and
   * the last unit takes longer than the first twenty.
   *
   * The final stride is clipped to whatever is left, so a walk lands on its
   * mark instead of stepping past it and jittering back.
   */
  seek(
    dt: number, tx: number, ty: number, slack: number, map: TileMap,
    maxPace = 1, minPace = 0,
  ): number {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= slack) {
      this.step(dt, 0, 0, map);
      return dist;
    }
    const boost = Math.max(minPace, Math.min(maxPace, dist / 24));
    const oldSpeed = this.speed;
    this.speed = Math.min(oldSpeed * boost, dt > 0 ? dist / dt : oldSpeed * boost);
    this.step(dt, dx / dist, dy / dist, map);
    this.speed = oldSpeed;
    return dist;
  }

  draw(ctx: CanvasRenderingContext2D, camX: number, camY: number): void {
    if (this.hidden) return;
    const sx = this.x - camX;
    const sy = this.y - camY;
    // No walk cycles: one static sprite, motion reads through the hop and
    // the left/right mirror.
    const solid = this.fade >= 1;
    if (!solid) ctx.globalAlpha = this.fade;
    drawDoll(ctx, this.skin.sprite, sx, sy, this.dir, bounce(this.motion(), this.hopT, this.hopEase));
    if (!solid) ctx.globalAlpha = 1;
    // Shed light is drawn where it fell, so the camera offsets go in raw.
    if (this.sparks.length > 0) drawSparks(ctx, this.sparks, camX, camY, this.fade);
  }
}

/**
 * The path a character has walked, as breadcrumbs a few px apart. Companions
 * that lose sight of someone rejoin by snapping onto it and walking it in.
 * Indices are global and stay valid as old crumbs fall off the back.
 */
export class Trail {
  private pts: { x: number; y: number }[] = [];
  private base = 0;

  reset(x: number, y: number): void {
    this.pts = [{ x, y }];
    this.base = 0;
  }

  push(x: number, y: number): void {
    const last = this.pts[this.pts.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 4) return;
    this.pts.push({ x, y });
    if (this.pts.length > 400) {
      this.pts.shift();
      this.base += 1;
    }
  }

  /** Index of the newest crumb, or -1 when empty. */
  head(): number {
    return this.base + this.pts.length - 1;
  }

  at(i: number): { x: number; y: number } | null {
    return this.pts[i - this.base] ?? null;
  }

  /** Newest-first index of the first crumb matching, or -1. */
  findBack(test: (p: { x: number; y: number }) => boolean): number {
    for (let k = this.pts.length - 1; k >= 0; k--) {
      if (test(this.pts[k]!)) return this.base + k;
    }
    return -1;
  }
}
