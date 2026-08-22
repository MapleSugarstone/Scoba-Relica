import { Camera } from "../engine/camera";
import type { Renderer } from "../engine/renderer";
import type { Art } from "../engine/assets";
import type { Input } from "../engine/input";
import { worldSprite } from "../engine/paperdoll";
import { critterActor, critterSkin } from "./critters";
import { TILE, type TileMap } from "../engine/tilemap";
import { Actor, Trail } from "./actors";
import { findPath, lineOfSight } from "./pathfind";
import {
  cloneZone, WANDER_SHARE,
  type WorldDef, type EncounterZone, type ZoneSpecies,
} from "./world";
import {
  applyAllCollision, applyArt, applySolidCell, cellDataAt, cellKey, mapById, resolveMapId,
  resolveWorld, stackAt, teleportTarget, terrainAt,
  type LayerFilter, type MapDef, type NpcDef, type SentinelOpen, type SentinelData,
  type WorldContent,
} from "./content";
import { buildNpcs, drawBattleMarker, drawNpcMarker, drawReachMarker, updateNpcs, type NpcRuntime } from "./npcs";
import { advanceQuest, markTrainerBeaten, markedNpcs, npcAction, reachSteps } from "./quests";
import type { SaveData, SlotId } from "../save/save";
import { autosave, partyOf } from "../save/save";
import { advanceCompanionship, newCompanionship, type Companionship } from "../sim/companionship";
import { advanceCare } from "../sim/care";
import { makeWild, type ScobaInstance } from "../sim/scoba";
import { SPECIAL, SPECIES } from "../sim/species";
import { rngFrom } from "../sim/rng";
import type { UI } from "../ui/screens";

export interface OverworldHooks {
  /** Say who the Relica has gone off with, so the peer draws it in the same place. */
  shareCompanionship?(state: Companionship): void;
  /** False when the peer is the one deciding and this client just follows. */
  decidesCompanionship?(): boolean;
  onWildBattle(wild: ScobaInstance, at: { x: number; y: number }): void;
  onOpenNest(): void;
  onTrainerBattle(npc: NpcDef, result: (won: boolean) => void): void;
  /**
   * Where the other player is, when someone is playing them. Null means nobody
   * is on the other end and the partner goes back to following, which is what
   * single-machine play has always been.
   */
  peerAt?(): { x: number; y: number; dir: 1 | -1; moving: boolean; map: string } | null;
  /** Tell the peer where this player is. Called every frame; it decides what to send. */
  reportSelf?(state: { x: number; y: number; dir: 1 | -1; moving: boolean; map: string }): void;
}

/**
 * A co-op battle standing in the world while one player fights it. The other
 * player walks up and interacts to join. Only the fields the overworld needs;
 * `ui/battle.ts` owns the running fight.
 */
export interface WorldBattle {
  /**
   * Which fight this marker is for. Two can exist in a session: your own, and
   * the one your partner started while you were busy with yours. Without an id
   * the second was wiped the moment the first ended.
   */
  id: string;
  x: number;
  y: number;
  /** The character whose slot is still open, or null once nobody can join. */
  guest(): SlotId | null;
  join(owner: SlotId): boolean;
}

/** How close the other player must stand to join a battle in progress. */
const BATTLE_JOIN_DIST = 30;
const CONTACT_DIST = 11;

/** Nobody walks in a line: everyone keeps to a loose ring around what they
 * are anchored to. */
/** Pace while ambling. Everything else runs at a flat walking pace: a
 * companion never moves faster than the person it is following, so ground it
 * has lost is only won back on the corners or when you stop. */
const AMBLE = 0.55;
/** An anchor moving slower than this counts as standing still. */
const ROLLING = 12;
/** Seconds of the anchor's travel a companion aims ahead by, at the least and
 * at the most. Aiming at where you will be is what stops them stringing out
 * in a line behind you. */
const LEAD_MIN = 0.6;
const LEAD_MAX = 2;
/** How long a companion takes to notice it has been left, in seconds. Each
 * rolls its own, so a group sets off raggedly rather than as one. */
const REACT_MIN = 0.25;
const REACT_SPAN = 0.9;
/** Out to this range a companion keeps checking whether it could walk
 * straight to its anchor. Sight is what separates "fell behind" from
 * "walled off"; past this range the answer stops mattering. */
const SIGHT = 200;

/** True when a body of radius `r` cannot stand at (x, y). */
function blocked(map: TileMap, x: number, y: number, r: number): boolean {
  return (
    map.isSolidAt(x, y) ||
    map.isSolidAt(x - r, y) || map.isSolidAt(x + r, y) ||
    map.isSolidAt(x, y - r) || map.isSolidAt(x, y + r)
  );
}

/**
 * Someone tagging along. A companion keeps inside a loose ring around whatever
 * it is anchored to, picks its own spots inside that ring on its own timer, so
 * it drifts about even while you stand still, and only hurries when it has
 * been left behind. Sight decides how: with a clear line to its anchor it
 * chases on a straight line of its own, and with a wall in between it routes
 * around like a person heading for the door, dropping the route the moment
 * the way opens up again.
 */
class Companion {
  private path: { x: number; y: number }[] = [];
  /** Where the current path was drawn to, so a stale one gets redrawn. */
  private pathGoal: { x: number; y: number } | null = null;
  private stuckT = 0;
  private repathT = 0;
  private spot: { x: number; y: number } | null = null;
  private restT = Math.random() * 1.2;
  /** Where it rides relative to a moving anchor, as an offset it holds. */
  private slot: { ang: number; rad: number } | null = null;
  private slotT = 0;
  /** Set once it has decided it is out of range; cleared when back in it. */
  private following = false;
  private reactT = 0;
  /** Crumb it is walking toward after losing the anchor, or -1. */
  private crumb = -1;
  private crumbT = 0;
  private prevAnchor: { x: number; y: number } | null = null;
  private vel = { x: 0, y: 0 };

  constructor(
    readonly actor: Actor,
    /** Where it wants to be near, read fresh every frame. */
    readonly anchor: () => { x: number; y: number },
    readonly ring: { near: number; far: number },
    /** Past this it gives up on holding a spot and heads straight over. */
    readonly leash: number,
    /** The path it rejoins along after being left behind. */
    readonly trail: Trail,
    /** Which side of the chase it favors, in [-1, 1]. Keeps a group fanned
     * out on their own lines instead of stacked on the anchor's track. */
    readonly flank: number = (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.6),
    /** Set for party Scobas, so the list can be rebuilt without respawning. */
    readonly uid?: string,
  ) {}

  /** Range it is happy with: inside this it has no reason to move at all. */
  private get slack(): number {
    return this.ring.far + 6;
  }

  /** How far it has drifted from what it is anchored to. */
  away(): number {
    const a = this.anchor();
    return Math.hypot(this.actor.x - a.x, this.actor.y - a.y);
  }

  update(dt: number, map: TileMap, crowd: Actor[]): void {
    const a = this.anchor();
    this.trackAnchor(dt, a);
    const away = Math.hypot(this.actor.x - a.x, this.actor.y - a.y);
    const sees = away <= SIGHT &&
      lineOfSight(map, this.actor.x, this.actor.y, a.x, a.y, this.actor.radius);
    this.repathT = Math.max(0, this.repathT - dt);

    if (this.path.length > 0) {
      if (sees) {
        // The way is open again: drop the route and move like a follower.
        this.path = [];
        this.pathGoal = null;
      } else {
        this.followPath(dt, map, a);
        return;
      }
    }

    if (this.crumb >= 0) {
      this.walkTrail(dt, map, a, away, sees);
      return;
    }

    if (away <= this.slack) {
      if (sees) {
        // Close enough: potter about, and forget any hurry it was in.
        this.following = false;
        this.slot = null;
        this.idle(dt, map, crowd, a, away);
        return;
      }
      // Beside the anchor as the crow flies, but a wall is in between (left
      // inside a pen, say). Route round through the opening like a person.
      if (this.repathT <= 0) {
        this.repathT = 0.7;
        const route = this.route(map, a);
        if (route) {
          this.setPath(route, a);
          this.followPath(dt, map, a);
          return;
        }
      }
      this.actor.step(dt, 0, 0, map); // no route yet: wait, don't grind the wall
      return;
    }

    // Out of range. Take a beat to notice before setting off.
    if (!this.following) {
      this.following = true;
      this.reactT = REACT_MIN + Math.random() * REACT_SPAN;
      this.spot = null;
    }
    if (this.reactT > 0) {
      this.reactT -= dt;
      this.actor.step(dt, 0, 0, map);
      return;
    }

    const rolling = Math.hypot(this.vel.x, this.vel.y) > ROLLING;
    const center = rolling ? this.aheadOf(a, away, map) : a;
    this.slotT -= dt;
    if (!this.slot || this.slotT <= 0) {
      this.slot = this.pickSlot(map, crowd, center);
      this.slotT = 1 + Math.random() * 1.5;
    }
    // Far behind, converge on the anchor itself rather than an offset from
    // it, but each on its own side of the line: a group closing in fans out
    // instead of stringing along the anchor's own track.
    const goal = away > this.leash
      ? this.flanked(center, map)
      : {
        x: center.x + Math.cos(this.slot.ang) * this.slot.rad,
        y: center.y + Math.sin(this.slot.ang) * this.slot.rad,
      };

    // Losing sight of where it is headed means geometry is in the way, not
    // distance, and that is when it needs a real route.
    if (
      !lineOfSight(map, this.actor.x, this.actor.y, goal.x, goal.y, this.actor.radius) &&
      this.repathT <= 0
    ) {
      this.repathT = 0.6;
      const route = this.route(map, center);
      if (route) {
        this.setPath(route, center);
        return;
      }
    }

    const left = this.travel(dt, map, goal.x, goal.y, 3, 1);
    if (left > 6 && this.stuckT > 0.35 && this.repathT <= 0) {
      this.repathT = 0.8;
      const route = this.route(map, center);
      if (route) this.setPath(route, center);
    }
  }

  /** Walk the current BFS route, trimming corners and redrawing it stale. */
  private followPath(dt: number, map: TileMap, a: { x: number; y: number }): void {
    // Skip to the farthest of the next few waypoints in plain view; each
    // follower rounds the bends its own way instead of tracing grid centers.
    let cut = 0;
    const cap = Math.min(this.path.length - 1, 3);
    for (let i = 1; i <= cap; i++) {
      const p = this.path[i]!;
      if (!lineOfSight(map, this.actor.x, this.actor.y, p.x, p.y, this.actor.radius + 0.5)) break;
      cut = i;
    }
    if (cut > 0) this.path.splice(0, cut);

    // The anchor has moved on since this route was drawn: redraw it.
    if (
      this.repathT <= 0 && this.pathGoal &&
      Math.hypot(a.x - this.pathGoal.x, a.y - this.pathGoal.y) > 48
    ) {
      this.repathT = 0.6;
      const route = this.route(map, a);
      if (route) this.setPath(route, a);
    }

    const head = this.path[0];
    if (!head) return;
    const left = this.travel(dt, map, head.x, head.y, 2, 1);
    if (left <= 2.5) this.path.shift();
    if (this.stuckT > 0.6) {
      this.path = [];
      this.pathGoal = null;
      this.stuckT = 0;
    }
  }

  /** A route to near `to`, bent onto this one's own line, or null. */
  private route(map: TileMap, to: { x: number; y: number }): { x: number; y: number }[] | null {
    const raw = findPath(map, this.actor.x, this.actor.y, to.x, to.y, { near: true });
    if (!raw || raw.length === 0) return null;
    // Nudge waypoints to this one's side so two followers handed the same
    // route do not walk it single file. The last one stays exact.
    const r = this.actor.radius + 1;
    for (let i = 0; i < raw.length - 1; i++) {
      const p = raw[i]!;
      const q = raw[i + 1]!;
      const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const x = p.x - ((q.y - p.y) / d) * this.flank * 3;
      const y = p.y + ((q.x - p.x) / d) * this.flank * 3;
      if (!blocked(map, x, y, r)) {
        p.x = x;
        p.y = y;
      }
    }
    return raw;
  }

  private setPath(route: { x: number; y: number }[], goal: { x: number; y: number }): void {
    this.path = route;
    this.pathGoal = { x: goal.x, y: goal.y };
    this.stuckT = 0;
  }

  /** The chase goal pushed toward this one's own side of the pursuit line. */
  private flanked(center: { x: number; y: number }, map: TileMap): { x: number; y: number } {
    const dx = center.x - this.actor.x;
    const dy = center.y - this.actor.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return center;
    const r = this.actor.radius + 1;
    for (const off of [this.flank * Math.min(14, d * 0.3), this.flank * 6]) {
      const x = center.x - (dy / d) * off;
      const y = center.y + (dx / d) * off;
      if (!blocked(map, x, y, r)) return { x, y };
    }
    return center;
  }

  /** Drifting about near the anchor, on its own schedule. */
  private idle(
    dt: number,
    map: TileMap,
    crowd: Actor[],
    a: { x: number; y: number },
    away: number,
  ): void {
    if (this.spot) {
      const left = this.travel(dt, map, this.spot.x, this.spot.y, 3, AMBLE);
      if (left <= 4 || this.stuckT > 0.4) {
        this.spot = null;
        this.stuckT = 0;
        this.rest();
      }
      return;
    }
    this.actor.step(dt, 0, 0, map);
    this.restT -= dt;
    if (this.restT > 0) return;
    this.rest();
    if (away > this.ring.far || Math.random() < 0.6) this.spot = this.pickSpot(map, crowd, a);
  }

  /** True while it is rejoining along the path rather than following. */
  trailing(): boolean {
    return this.crumb >= 0;
  }

  /** Walking the anchor's own path back in after being left behind. */
  private walkTrail(dt: number, map: TileMap, a: { x: number; y: number }, away: number, sees: boolean): void {
    // Cut across the moment the way is clear: a friend rejoining does not
    // retrace your footsteps over open ground. Or give up on the path if it
    // has not brought this one home by now.
    this.crumbT -= dt;
    if (sees || this.crumbT <= 0) {
      this.crumb = -1;
      return;
    }
    // Advance past crumbs already reached, so it flows along instead of
    // stopping at each one.
    let target = this.trail.at(this.crumb);
    while (target && Math.hypot(this.actor.x - target.x, this.actor.y - target.y) < 6) {
      this.crumb += 1;
      target = this.trail.at(this.crumb);
    }
    // Round the trail's bends: skip to the farthest nearby crumb in plain
    // view, so each rejoiner cuts its corners its own way.
    const cap = Math.min(this.trail.head(), this.crumb + 15);
    for (let probe = cap; probe > this.crumb; probe -= 3) {
      const p = this.trail.at(probe);
      if (p && lineOfSight(map, this.actor.x, this.actor.y, p.x, p.y, this.actor.radius)) {
        this.crumb = probe;
        target = p;
        break;
      }
    }
    if (!target || this.crumb > this.trail.head() || away <= this.slack) {
      this.crumb = -1;
      return;
    }
    this.travel(dt, map, target.x, target.y, 2, 1);
  }

  /**
   * Put it back on the anchor's path, at the last crumb still off the screen,
   * and set it walking the trail in. Falls back to standing it behind the
   * anchor when there is no crumb out of sight.
   */
  snapToTrail(map: TileMap, crowd: Actor[], hidden: (x: number, y: number) => boolean, edge: number): void {
    const a = this.anchor();
    // A crumb has to be both out of sight and actually behind, or a camera
    // that has not caught up yet can drop it in the anchor's lap.
    // Bounded on both sides: past the screen edge, but not so far back that
    // rejoining means crossing the map. A crumb further out than that is a
    // stale stretch of path, and walking it in reads as the companion
    // teleporting somewhere it was never going.
    const reach = edge * 2;
    const r = this.actor.radius;
    const i = this.trail.findBack((p) => {
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      return hidden(p.x, p.y) && d > this.ring.far && d < reach && !blocked(map, p.x, p.y, r);
    });
    const at = i >= 0 ? this.trail.at(i) : null;
    if (!at) {
      this.placeBehind(map, crowd, edge);
      return;
    }
    this.teleportTo(at.x, at.y);
    this.crumb = i;
    this.crumbT = 12;
  }

  private rest(): void {
    this.restT = 0.3 + Math.random() * 1.3;
  }

  /** Step toward a point, tracking whether it is actually getting anywhere. */
  private travel(dt: number, map: TileMap, x: number, y: number, slack: number, pace: number): number {
    const bx = this.actor.x;
    const by = this.actor.y;
    const left = this.actor.seek(dt, x, y, slack, map, pace);
    const moved = Math.hypot(this.actor.x - bx, this.actor.y - by);
    // Measured against the step it meant to take, since seek eases off over
    // the last stretch and would otherwise read as stuck.
    const wanted = this.actor.speed * Math.min(pace, Math.max(left, 1) / 24) * dt;
    if (left > slack + 2 && moved < wanted * 0.25) this.stuckT += dt;
    else this.stuckT = 0;
    return left;
  }

  /** Smoothed velocity of whatever this one is anchored to. */
  private trackAnchor(dt: number, a: { x: number; y: number }): void {
    if (this.prevAnchor && dt > 0) {
      const dx = a.x - this.prevAnchor.x;
      const dy = a.y - this.prevAnchor.y;
      if (Math.hypot(dx, dy) > 40) {
        // A jump that big is a teleport, not a sprint.
        this.vel.x = 0;
        this.vel.y = 0;
      } else {
        const k = Math.min(1, dt * 4);
        this.vel.x += (dx / dt - this.vel.x) * k;
        this.vel.y += (dy / dt - this.vel.y) * k;
      }
    }
    this.prevAnchor = { x: a.x, y: a.y };
  }

  /**
   * Where the anchor is headed: its position plus a slice of its travel, more
   * of it the further behind this one has fallen. Falls back to the anchor
   * itself when it is standing still or the spot ahead is inside something.
   */
  private aheadOf(a: { x: number; y: number }, away: number, map: TileMap): { x: number; y: number } {
    if (Math.hypot(this.vel.x, this.vel.y) <= ROLLING) return a;
    const t = Math.max(LEAD_MIN, Math.min(LEAD_MAX, away / 90));
    const x = a.x + this.vel.x * t;
    const y = a.y + this.vel.y * t;
    if (blocked(map, x, y, this.actor.radius + 1)) return a;
    return { x, y };
  }

  /** A free spot in the ring, preferring room from everyone else. */
  private pickSpot(
    map: TileMap,
    crowd: Actor[],
    a: { x: number; y: number },
  ): { x: number; y: number } | null {
    const r = this.actor.radius + 1;
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = this.ring.near + Math.random() * (this.ring.far - this.ring.near);
      const x = a.x + Math.cos(ang) * rad;
      const y = a.y + Math.sin(ang) * rad;
      if (blocked(map, x, y, r)) continue;
      // A spot the anchor cannot see means a wall between: never idle there.
      if (!lineOfSight(map, a.x, a.y, x, y, 2)) continue;
      let score = 0;
      for (const other of crowd) {
        if (other === this.actor) continue;
        score += Math.min(Math.hypot(other.x - x, other.y - y), 24);
      }
      score -= Math.hypot(this.actor.x - x, this.actor.y - y) * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
    return best;
  }

  /** A free offset in the ring, preferring room from everyone else. */
  private pickSlot(map: TileMap, crowd: Actor[], center: { x: number; y: number }): { ang: number; rad: number } {
    const r = this.actor.radius + 1;
    let best = { ang: Math.random() * Math.PI * 2, rad: (this.ring.near + this.ring.far) / 2 };
    let bestScore = -Infinity;
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = this.ring.near + Math.random() * (this.ring.far - this.ring.near);
      const x = center.x + Math.cos(ang) * rad;
      const y = center.y + Math.sin(ang) * rad;
      let score = 0;
      if (blocked(map, x, y, r)) score -= 200;
      else if (!lineOfSight(map, center.x, center.y, x, y, 2)) score -= 150;
      for (const other of crowd) {
        if (other === this.actor) continue;
        score += Math.min(Math.hypot(other.x - x, other.y - y), 24);
      }
      if (score > bestScore) {
        bestScore = score;
        best = { ang, rad };
      }
    }
    return best;
  }

  /** Drop it back beside its anchor, for a warp or a fresh scene. */
  placeNear(map: TileMap, crowd: Actor[]): void {
    const a = this.anchor();
    // The anchor is not always somewhere anyone can stand: the special Scoba
    // is anchored to the midpoint between the two characters, which can sit
    // over water while both of them are on land.
    const spot = this.pickSpot(map, crowd, a) ?? this.nearestFree(map, a);
    this.teleportTo(spot.x, spot.y);
  }

  /** The closest point to `a` this actor can actually stand on. */
  private nearestFree(map: TileMap, a: { x: number; y: number }): { x: number; y: number } {
    const r = this.actor.radius + 1;
    if (!blocked(map, a.x, a.y, r)) return a;
    for (let rad = 8; rad <= 96; rad += 8) {
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2;
        const x = a.x + Math.cos(ang) * rad;
        const y = a.y + Math.sin(ang) * rad;
        if (!blocked(map, x, y, r)) return { x, y };
      }
    }
    return a;
  }

  /** Stand it `dist` behind the anchor, out of the way of where it is going. */
  placeBehind(map: TileMap, crowd: Actor[], dist: number): void {
    const a = this.anchor();
    const speed = Math.hypot(this.vel.x, this.vel.y);
    const ux = speed > 1 ? -this.vel.x / speed : (this.actor.x - a.x) / Math.max(1, this.away());
    const uy = speed > 1 ? -this.vel.y / speed : (this.actor.y - a.y) / Math.max(1, this.away());
    const r = this.actor.radius + 1;
    for (const back of [dist, dist * 0.8, dist * 0.6]) {
      for (const turn of [0, 0.5, -0.5, 1, -1]) {
        const cos = Math.cos(turn);
        const sin = Math.sin(turn);
        const x = a.x + (ux * cos - uy * sin) * back;
        const y = a.y + (ux * sin + uy * cos) * back;
        if (blocked(map, x, y, r)) continue;
        this.teleportTo(x, y);
        return;
      }
    }
    this.placeNear(map, crowd);
  }

  teleportTo(x: number, y: number): void {
    this.actor.x = x;
    this.actor.y = y;
    this.path = [];
    this.pathGoal = null;
    this.spot = null;
    this.stuckT = 0;
    this.prevAnchor = null;
    this.slot = null;
    this.crumb = -1;
    this.vel = { x: 0, y: 0 };
  }

  debug(): object {
    return {
      x: Math.round(this.actor.x),
      y: Math.round(this.actor.y),
      away: Math.round(this.away()),
      state: this.crumb >= 0 ? "trail" : this.path.length > 0 ? "route"
        : !this.following ? "idle" : this.reactT > 0 ? "noticing" : "following",
      pathLen: this.path.length,
      // Whether it reads as walking, which is what runs the bounce. A remote
      // character with this stuck false slides about with its legs frozen.
      moving: this.actor.moving,
      gait: Number(this.actor.gaitPhase().toFixed(2)),
    };
  }
}

interface Roamer {
  actor: Actor;
  scoba: ScobaInstance;
  zone: EncounterZone;
  /** The roster entry it came from, which carries how it moves. */
  kind: ZoneSpecies;
  wanderT: number;
  dx: number;
  dy: number;
  chasing: boolean;
  /** Fresh spawns idle briefly so they don't materialize mid-charge. */
  calm: number;
}

export class Overworld {
  private world: WorldDef;
  private player: Actor;
  private partner: Companion;
  /** The special Scoba: a third wheel that hangs between the two characters. */
  private special: Companion;
  private pets: Companion[] = [];
  private companions: Companion[] = [];
  /** Paths the two characters have walked, for companions rejoining them. */
  private trails: Record<SlotId, Trail> = { A: new Trail(), B: new Trail() };
  /**
   * Where the Relica is sitting between the two characters: 0 is beside the
   * one you play, 1 is beside the other. It eases rather than jumps, so
   * changing its mind reads as wandering over rather than teleporting.
   */
  private lean = 0.3;
  /** How near the two of them have to be for it to count them as together. */
  private static readonly REUNION_DIST = 90;
  /** True while the other player is walking the partner, not this client. */
  private peerDriven = false;
  /** Last computed reachability, for the debug readout. */
  private lastHere: { A: boolean; B: boolean } = { A: true, B: true };
  private cam = new Camera();
  private saveTimer = 0;
  private careTimer = 0;
  private encCooldown = 0;
  private roamers: Roamer[] = [];
  private zoneRespawn: number[] = [];
  private view = { x: 0, y: 0, w: 0, h: 0 };
  private npcs: NpcRuntime[] = [];
  /** When set (by the dev editor), the camera centers here instead of the
   * player, and the sim is paused by main. */
  devCam: { x: number; y: number } | null = null;
  /** Dev editor overlay, drawn last. */
  overlay: ((ctx: CanvasRenderingContext2D, camX: number, camY: number, w: number, h: number) => void) | null = null;
  /** Set while a co-op battle is running somewhere in the world. */
  private activeBattle: WorldBattle | null = null;
  /** Which authored map is loaded; empty while the world is procedural. */
  private mapId = "";
  /** Cell the player stood on when the last teleport fired, so arriving on a
   * pad in the new map does not bounce them straight back. */
  private teleportLock: string | null = null;
  /** Which draw layers are showing. The editor narrows it to isolate one. */
  private layerFilter: LayerFilter = () => true;

  constructor(
    private art: Art,
    private save: SaveData,
    private content: WorldContent,
    private input: Input,
    private ui: UI,
    private hooks: OverworldHooks,
  ) {
    this.mapId = resolveMapId(content, save.pos.map);
    this.world = resolveWorld(art, save.worldSeed, content, this.mapId, this.sentinelOpen);
    // A position saved on another map means nothing on this one.
    const sameMap = save.pos.map === this.mapId;
    let sp = sameMap && (save.pos.x || save.pos.y) ? { x: save.pos.x, y: save.pos.y } : this.world.spawn;
    // A saved position from before a map edit can now be inside a wall.
    if (blocked(this.world.map, sp.x, sp.y, 4)) sp = this.world.spawn;
    this.npcs = buildNpcs(art, content, this.mapId);

    const local = save.characters[save.localSlot];
    const other: SlotId = save.localSlot === "A" ? "B" : "A";
    this.player = new Actor(sp.x, sp.y, { sprite: worldSprite(art.doll, local.look), motion: "hop" });

    const partnerActor = new Actor(sp.x - 26, sp.y + 10, {
      sprite: worldSprite(art.doll, save.characters[other].look),
      motion: "hop",
    });
    partnerActor.speed = this.player.speed;
    // The partner picks a strong side of its own; the special stays looser
    // since it already weaves between the two characters.
    this.partner = new Companion(
      partnerActor, () => this.player, { near: 20, far: 46 }, 60,
      this.trails[save.localSlot], (Math.random() < 0.5 ? -1 : 1) * 0.85,
    );

    const specialActor = critterActor(art, SPECIAL, sp.x - 14, sp.y + 18);
    specialActor.speed = this.player.speed;
    specialActor.radius = 3;
    this.special = new Companion(
      specialActor, () => this.between(), { near: 6, far: 20 }, 66,
      this.trails[save.localSlot], (Math.random() < 0.5 ? -1 : 1) * 0.35,
    );

    this.buildPets();
    // Those constructor offsets are blind: at the west or south edge of an
    // island they land in the water, and a companion standing in the sea can
    // never take a step, so it sits there for the rest of the save. Everyone
    // gets put on a spot that was actually checked.
    this.placeCompanions();
    this.trails[save.localSlot].reset(this.player.x, this.player.y);
    this.trails[other].reset(partnerActor.x, partnerActor.y);

    this.save.special = advanceCare(this.save.special, Date.now());
  }

  /**
   * Up to three Scobas walk with each character, taken from the party by
   * owner. Existing companions are kept so nobody teleports on a rebuild.
   */
  private buildPets(): void {
    const keep = new Map(this.pets.filter((p) => p.uid).map((p) => [p.uid!, p]));
    this.pets = [];
    for (const slot of ["A", "B"] as SlotId[]) {
      const anchor = slot === this.save.localSlot
        ? (): Actor => this.player
        : (): Actor => this.partner.actor;
      const mine = partyOf(this.save, slot);
      for (let i = 0; i < mine.length; i++) {
        const inst = mine[i]!;
        const existing = keep.get(inst.uid);
        if (existing) {
          this.pets.push(existing);
          continue;
        }
        const spec = SPECIES[inst.speciesId];
        if (!spec) continue;
        const at = anchor();
        const actor = critterActor(this.art, spec, at.x, at.y, inst.tint, inst.shiny);
        actor.speed = this.player.speed;
        actor.radius = 3;
        // Alternate sides down the roster so each pet chases on its own line.
        const flank = (i % 2 === 0 ? 1 : -1) * (0.5 + 0.25 * Math.floor(i / 2) + Math.random() * 0.15);
        const pet = new Companion(actor, anchor, { near: 12, far: 40 }, 54, this.trails[slot], flank, inst.uid);
        pet.placeNear(this.world.map, [this.player, ...this.pets.map((p) => p.actor)]);
        this.pets.push(pet);
      }
    }
    this.companions = [this.partner, this.special, ...this.pets];
  }

  /** Call after the party changes, so new Scobas walk out with you. */
  refreshCompanions(): void {
    this.buildPets();
  }

  /** Stands every companion on a spot that has been checked for walls. */
  private placeCompanions(): void {
    const crowd = [this.player, ...this.companions.map((c) => c.actor)];
    for (const c of this.companions) c.placeNear(this.world.map, crowd);
  }

  /**
   * Where the Relica wants to be: beside whichever character it is currently
   * keeping company. `lean` eases between the two rather than snapping, so a
   * change of mind looks like it walking over.
   */
  private between(): { x: number; y: number } {
    const a = this.player;
    const b = this.partner.actor;
    return { x: a.x + (b.x - a.x) * this.lean, y: a.y + (b.y - a.y) * this.lean };
  }

  /**
   * Advance who it is walking with, and ease it over. Only one client decides:
   * both of them draw the same Relica, so if each picked for itself, each
   * player would see it beside them.
   */
  private updateCompanionship(dt: number): void {
    const mine = this.save.localSlot;
    const theirs: SlotId = mine === "A" ? "B" : "A";
    const state = this.save.companionship ?? newCompanionship(mine);

    if (this.hooks.decidesCompanionship?.() ?? true) {
      // Being together is a fact about the two characters, not about where the
      // Relica happens to be standing. Measuring from the Relica meant that
      // while it was chasing an absent player it drifted out of range of the
      // present one and counted neither as reachable, so no debt ever built.
      const them = this.partner.actor;
      const present: Record<SlotId, boolean> = mine === "A"
        ? { A: true, B: !them.hidden }
        : { A: !them.hidden, B: true };
      const together = !them.hidden &&
        Math.hypot(this.player.x - them.x, this.player.y - them.y) <= Overworld.REUNION_DIST;
      // Whoever it is already with stays reachable while they are on this map.
      // The other only counts once the two of them are actually together,
      // which is what makes it stay put when they split up.
      const here = {
        A: state.with === "A" ? present.A : together && present.A,
        B: state.with === "B" ? present.B : together && present.B,
      };
      this.lastHere = here;
      const next = advanceCompanionship(state, dt, here);
      if (next.with !== state.with) this.hooks.shareCompanionship?.(next);
      this.save.companionship = next;
    }

    // 0 is the character this player drives, 1 is the other one.
    const want = (this.save.companionship?.with ?? mine) === mine ? 0 : 1;
    // Slow on purpose: crossing over should take a few seconds of walking.
    const rate = 0.35 * dt;
    this.lean += Math.max(-rate, Math.min(rate, want - this.lean));
    void theirs;
  }

  update(dt: number): void {
    this.world.map.waterAnimT += dt;
    this.encCooldown = Math.max(0, this.encCooldown - dt);
    const dialog = this.ui.dialogOpen();

    if (this.ui.transitioning) {
      // The world keeps moving as the cover clears, but the player does not
      // steer it. Draining the interact keeps a press made under the black
      // from firing the moment it lifts.
      this.input.takeInteract();
      this.player.step(dt, 0, 0, this.world.map);
    } else if (dialog) {
      if (this.input.takeInteract()) this.ui.advanceDialog();
      this.player.step(dt, 0, 0, this.world.map);
    } else {
      const axis = this.input.axis();
      this.player.step(dt, axis.x, axis.y, this.world.map);
      if (this.input.takeInteract()) this.tryInteract();
    }

    // It used to drift between the two of them on a timer, which only made
    // sense while they were always together. Now it picks one and keeps them
    // company, and pays the other one back later.
    this.updateCompanionship(dt);

    const other: SlotId = this.save.localSlot === "A" ? "B" : "A";
    this.trails[this.save.localSlot].push(this.player.x, this.player.y);
    this.trails[other].push(this.partner.actor.x, this.partner.actor.y);

    // Say where we are before anything else moves, so what the peer receives is
    // this frame's position rather than last frame's.
    this.hooks.reportSelf?.({
      x: Math.round(this.player.x), y: Math.round(this.player.y),
      dir: this.player.dir, moving: this.player.moving, map: this.mapId,
    });
    const driven = this.applyPeerPosition(dt);
    this.peerDriven = driven;

    const crowd = [this.player, ...this.companions.map((c) => c.actor)];
    this.freeStuckCompanions(crowd);
    for (const c of this.companions) {
      // A partner someone else is walking does not get followed by its own AI:
      // the two would fight over the same actor and it would jitter between
      // where the peer put it and where the leash wants it.
      if (driven && c === this.partner) continue;
      c.update(dt, this.world.map, crowd);
    }
    this.recoverLostCompanions(crowd);
    this.updateRoamers(dt, dialog);
    updateNpcs(this.npcs, dt, this.world.map, dialog);
    if (!dialog && !this.ui.transitioning) {
      this.checkReachSteps();
      this.checkTeleport();
    }

    this.careTimer += dt;
    if (this.careTimer > 30) {
      this.careTimer = 0;
      this.save.special = advanceCare(this.save.special, Date.now());
    }

    this.saveTimer += dt;
    if (this.saveTimer > 4) {
      this.saveTimer = 0;
      this.save.pos = { map: this.mapId, x: Math.round(this.player.x), y: Math.round(this.player.y) };
      autosave(this.save);
    }
  }

  // --- maps, teleports and sentinels ---

  /** The map def the world was built from, or null while it is procedural. */
  private mapDef(): MapDef | null {
    return mapById(this.content, this.mapId);
  }

  /** Reads the save, so it can be handed to the content builders as-is. */
  private sentinelOpen: SentinelOpen = (mapId, cell) => {
    const data = mapById(this.content, mapId)?.cellData[cell];
    if (!data || data.kind !== "sentinel") return false;
    return (this.save.sentinels[`${mapId}:${cell}`] ?? 0) >= data.count;
  };

  /** Load another authored map and put everyone down on it. */
  enterMap(mapId: string, at?: { x: number; y: number }): void {
    const target = mapById(this.content, mapId);
    if (!target) return;
    this.mapId = mapId;
    this.world = resolveWorld(this.art, this.save.worldSeed, this.content, mapId, this.sentinelOpen);
    let sp = at ?? this.world.spawn;
    if (blocked(this.world.map, sp.x, sp.y, 4)) sp = this.world.spawn;
    this.player.x = sp.x;
    this.player.y = sp.y;
    this.roamers = [];
    this.zoneRespawn = [];
    this.activeBattle = null;
    this.npcs = buildNpcs(this.art, this.content, mapId);
    this.placeCompanions();
    const other: SlotId = this.save.localSlot === "A" ? "B" : "A";
    this.trails[this.save.localSlot].reset(this.player.x, this.player.y);
    this.trails[other].reset(this.partner.actor.x, this.partner.actor.y);
    this.teleportLock = cellKey(Math.floor(sp.x / TILE), Math.floor(sp.y / TILE));
    this.save.pos = { map: mapId, x: Math.round(this.player.x), y: Math.round(this.player.y) };
    autosave(this.save);
  }

  /** Step onto a teleport pad and the pad takes you where it points. */
  private checkTeleport(): void {
    const m = this.mapDef();
    if (!m) return;
    const cx = Math.floor(this.player.x / TILE);
    const cy = Math.floor(this.player.y / TILE);
    const key = cellKey(cx, cy);
    const data = cellDataAt(m, cx, cy);
    if (!data || data.kind !== "teleport") {
      this.teleportLock = null;
      return;
    }
    if (this.teleportLock === key) return;
    this.teleportLock = key;
    const to = teleportTarget(this.content, data);
    if (!to) {
      this.ui.toast(data.link
        ? `${data.id} links to "${data.link}", which is not a pad any more.`
        : `${data.id} has nowhere to send you yet.`);
      return;
    }
    void this.ui.transition(() => this.enterMap(to.map, { x: to.x, y: to.y }));
  }

  /**
   * Count a win toward every sentinel watching the spot it happened on. One
   * that fills up opens on the spot: its art swaps and it stops blocking.
   */
  creditSentinels(cond: SentinelData["cond"], at: { x: number; y: number }, npcId?: string): void {
    const m = this.mapDef();
    if (!m) return;
    let opened = 0;
    for (const [cell, data] of Object.entries(m.cellData)) {
      if (data.kind !== "sentinel" || data.cond !== cond) continue;
      if (cond === "trainer" && data.npcId && data.npcId !== npcId) continue;
      const key = `${m.id}:${cell}`;
      const done = this.save.sentinels[key] ?? 0;
      if (done >= data.count) continue;
      const [cx, cy] = cell.split(",").map(Number);
      const dx = (cx! + 0.5) * TILE - at.x;
      const dy = (cy! + 0.5) * TILE - at.y;
      if (Math.hypot(dx, dy) > data.radius) continue;
      const now = done + 1;
      this.save.sentinels[key] = now;
      if (now >= data.count) opened += 1;
      else if (data.label) this.ui.toast(`${data.label} (${now}/${data.count})`);
    }
    if (opened > 0) {
      this.rebuildMapArt();
      this.ui.toast(opened === 1 ? "Something up ahead gives way." : "Paths ahead give way.");
    }
    autosave(this.save);
  }

  /**
   * Dev: forget what has been done on this map and open it again from its
   * spawn. Sentinels shut, trainers stand back up, roamers clear out. Quest
   * progress is left alone, since the Quests tab resets that on its own.
   */
  resetMapState(): { sentinels: number; trainers: number } | null {
    const m = this.mapDef();
    if (!m) return null;
    let sentinels = 0;
    for (const key of Object.keys(this.save.sentinels)) {
      if (!key.startsWith(`${m.id}:`)) continue;
      delete this.save.sentinels[key];
      sentinels += 1;
    }
    let trainers = 0;
    for (const npc of this.content.npcs) {
      if (npc.map !== m.id) continue;
      if (this.save.story.flags[`beat:${npc.id}`] === undefined) continue;
      delete this.save.story.flags[`beat:${npc.id}`];
      trainers += 1;
    }
    this.encCooldown = 0;
    // Re-entering rebuilds the world, clears roamers and any standing battle,
    // and puts everyone down on the spawn.
    this.enterMap(m.id);
    return { sentinels, trainers };
  }

  /** Redraw and re-collide the whole map, for a sentinel changing state. */
  private rebuildMapArt(): void {
    const m = this.mapDef();
    const layout = this.world.layout;
    if (!m || !layout) return;
    applyArt(this.world.map, this.art, m, this.sentinelOpen, this.layerFilter);
    applyAllCollision(this.world.map, this.art, this.content, m, layout.land, layout.deck, this.sentinelOpen);
  }

  /**
   * A companion standing somewhere it cannot walk out of never gets anywhere,
   * however patient it is: every step it tries is refused by the wall it is
   * inside. Lift it back onto open ground.
   *
   * Kept apart from the trail recovery below, which needs a drawn frame to
   * know what is off screen. This one does not, and a companion that starts
   * the save in the sea should be out of it before the first frame.
   */
  private freeStuckCompanions(crowd: Actor[]): void {
    for (const c of this.companions) {
      // Never shove a character somebody else is walking. Their client decides
      // where they are, and standing in a corner reads as stuck here: we would
      // teleport them clear, their next update would put them back, and the two
      // of us would do that sixty times a second.
      if (this.peerDriven && c === this.partner) continue;
      if (!blocked(this.world.map, c.actor.x, c.actor.y, c.actor.radius)) continue;
      c.placeNear(this.world.map, crowd);
    }
  }

  /**
   * Anyone who has fallen off the screen snaps onto the path their character
   * walked, at the last point still out of sight, and follows it back in.
   */
  private recoverLostCompanions(crowd: Actor[]): void {
    if (this.view.w === 0) return; // no frame drawn yet
    const margin = 24; // clearly past the edge, not just clipped by it
    const hidden = (x: number, y: number): boolean =>
      x < this.view.x - margin || x > this.view.x + this.view.w + margin ||
      y < this.view.y - margin || y > this.view.y + this.view.h + margin;
    const edge = Math.max(this.view.w, this.view.h) / 2 + 24;
    for (const c of this.companions) {
      // The other player being off this screen is not them getting lost, it is
      // them walking somewhere else, which is the entire point of two people
      // moving separately. Snapping them back onto our trail fought their own
      // position every frame and flung them about.
      if (this.peerDriven && c === this.partner) continue;
      if (c.trailing()) continue; // already walking its way back
      if (c.away() < c.leash + 40) continue; // just clipped by the edge, not lost
      if (hidden(c.actor.x, c.actor.y)) c.snapToTrail(this.world.map, crowd, hidden, edge);
    }
  }

  private updateRoamers(dt: number, dialog: boolean): void {
    const map = this.world.map;
    this.world.encounters.forEach((zone, zi) => {
      this.zoneRespawn[zi] = Math.max(0, (this.zoneRespawn[zi] ?? 0) - dt);
      if (this.zoneRespawn[zi] > 0) return;
      const inZone = this.roamers.filter((r) => r.zone === zone);
      if (inZone.length >= zone.max) return;
      for (const kind of zone.species) {
        const mine = inZone.reduce((n, r) => n + (r.kind.species === kind.species ? 1 : 0), 0);
        if (mine >= kind.max) continue;
        if (Math.random() >= kind.ratePerSec * dt) continue;
        // One at a time: the next frame gets its own roll for the rest.
        if (this.spawnRoamer(zone, kind)) break;
      }
    });

    for (const r of this.roamers) {
      if (dialog) {
        r.actor.step(dt, 0, 0, map);
        continue;
      }
      const dx = this.player.x - r.actor.x;
      const dy = this.player.y - r.actor.y;
      const dist = Math.hypot(dx, dy);
      r.calm = Math.max(0, r.calm - dt);
      r.chasing = r.calm === 0 && dist < r.kind.detect;
      if (r.chasing) {
        r.actor.speed = r.kind.speed;
        r.actor.step(dt, dx / dist, dy / dist, map);
      } else {
        r.wanderT -= dt;
        if (r.wanderT <= 0) {
          r.wanderT = 0.8 + Math.random() * 1.6;
          if (Math.random() < 0.35) {
            r.dx = 0;
            r.dy = 0;
          } else {
            const a = Math.random() * Math.PI * 2;
            r.dx = Math.cos(a);
            r.dy = Math.sin(a);
          }
          // Drift back when it strays from its meadow.
          const cx = r.zone.x + r.zone.w / 2;
          const cy = r.zone.y + r.zone.h / 2;
          if (
            r.actor.x < r.zone.x - 8 || r.actor.x > r.zone.x + r.zone.w + 8 ||
            r.actor.y < r.zone.y - 8 || r.actor.y > r.zone.y + r.zone.h + 8
          ) {
            const home = Math.hypot(cx - r.actor.x, cy - r.actor.y);
            r.dx = (cx - r.actor.x) / home;
            r.dy = (cy - r.actor.y) / home;
          }
        }
        r.actor.speed = r.kind.speed * WANDER_SHARE;
        r.actor.step(dt, r.dx, r.dy, map);
      }

      if (dist < CONTACT_DIST && this.encCooldown === 0 && r.calm === 0) {
        const zi = this.world.encounters.indexOf(r.zone);
        this.roamers.splice(this.roamers.indexOf(r), 1);
        if (zi >= 0) this.zoneRespawn[zi] = 7;
        this.encCooldown = 2.5;
        this.hooks.onWildBattle(r.scoba, { x: r.actor.x, y: r.actor.y });
        break;
      }
    }
  }

  /**
   * Every cell inside the zone holding one of the tiles this kind rises from.
   * Cheap enough to walk on each spawn: a zone is tens of cells, and this runs
   * a few times a second at most.
   */
  private spawnCells(zone: EncounterZone, kind: ZoneSpecies): { x: number; y: number }[] {
    const m = this.mapDef();
    if (!m) return [];
    const out: { x: number; y: number }[] = [];
    const x0 = Math.max(0, Math.floor(zone.x / TILE));
    const y0 = Math.max(0, Math.floor(zone.y / TILE));
    const x1 = Math.min(m.cols - 1, Math.floor((zone.x + zone.w) / TILE));
    const y1 = Math.min(m.rows - 1, Math.floor((zone.y + zone.h) / TILE));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!stackAt(m, cx, cy).some((t) => kind.tiles.includes(t.key))) continue;
        out.push({ x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2 });
      }
    }
    return out;
  }

  private spawnRoamer(zone: EncounterZone, kind: ZoneSpecies): boolean {
    const map = this.world.map;
    const sp = SPECIES[kind.species];
    if (!sp) return false;
    // Named tiles are the only places it rises from; without any it is the
    // whole zone. Farthest walkable candidate from the player wins, and small
    // zones that can't offer much distance lean on the calm timer instead.
    const cells = kind.tiles.length > 0 ? this.spawnCells(zone, kind) : null;
    if (cells !== null && cells.length === 0) return false;
    let best: { x: number; y: number; d: number } | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const spot = cells === null
        ? {
          x: zone.x + 8 + Math.random() * (zone.w - 16),
          y: zone.y + 8 + Math.random() * (zone.h - 16),
        }
        : cells[Math.floor(Math.random() * cells.length)]!;
      if (blocked(map, spot.x, spot.y, 4)) continue;
      const d = Math.hypot(spot.x - this.player.x, spot.y - this.player.y);
      if (!best || d > best.d) best = { x: spot.x, y: spot.y, d };
    }
    if (!best || best.d < 48) return false;
    const level = kind.minLv + Math.floor(Math.random() * (kind.maxLv - kind.minLv + 1));
    const scoba = makeWild(kind.species, level, rngFrom(`${this.save.worldSeed}:roam:${Date.now().toString(36)}`));
    const actor = new Actor(best.x, best.y, critterSkin(this.art, sp, scoba.tint, scoba.shiny));
    // It comes up out of the field rather than being suddenly standing there.
    actor.ghostIn();
    this.roamers.push({ actor, scoba, zone, kind, wanderT: 0, dx: 0, dy: 0, chasing: false, calm: 1.2 });
    return true;
  }

  // --- co-op battles standing in the world ---

  /** One player has walked into a fight; mark where it is happening. */
  openActiveBattle(battle: WorldBattle): void {
    this.activeBattle = battle;
  }

  /**
   * Take the marker down, but only if it is the one being asked about. Ending
   * your own fight used to clear whatever marker was standing, including one
   * that had arrived for your partner's fight while you were in yours, so you
   * came out of a battle with nothing to walk to.
   */
  closeActiveBattle(id?: string): void {
    if (id !== undefined && this.activeBattle && this.activeBattle.id !== id) return;
    this.activeBattle = null;
  }

  activeBattleAt(): { x: number; y: number } | null {
    return this.activeBattle ? { x: this.activeBattle.x, y: this.activeBattle.y } : null;
  }

  /**
   * Put the partner where the other player has walked them. Returns whether
   * anyone is actually driving, so their follow AI can be left switched off.
   *
   * A peer on another map is not drawn at all rather than left standing at the
   * last place we saw them, which would be a ghost of someone who has gone.
   */
  private applyPeerPosition(dt: number): boolean {
    const at = this.hooks.peerAt?.() ?? null;
    if (!at) {
      this.partner.actor.hidden = false;
      return false;
    }
    if (at.map !== this.mapId) {
      this.partner.actor.hidden = true;
      return true;
    }
    this.partner.actor.hidden = false;
    // Placed rather than walked, but still animated: the gait has to be
    // advanced by hand or the character slides with its legs frozen.
    this.partner.actor.driveTo(dt, at.x, at.y, at.dir);
    return true;
  }

  /** Where a character is standing: the one you drive, or the one you follow. */
  private actorFor(owner: SlotId): Actor {
    return owner === this.save.localSlot ? this.player : this.partner.actor;
  }

  /**
   * A character walking into the battle their partner started. The interact
   * button calls this for the local character; the relay will call it for the
   * peer once their join arrives, since only their own client can see how far
   * they walked.
   */
  joinActiveBattleAs(owner: SlotId): boolean {
    const battle = this.activeBattle;
    if (!battle || battle.guest() !== owner) return false;
    const who = this.actorFor(owner);
    if (Math.hypot(battle.x - who.x, battle.y - who.y) > BATTLE_JOIN_DIST) return false;
    return battle.join(owner);
  }

  private joinActiveBattle(): boolean {
    if (!this.joinActiveBattleAs(this.save.localSlot)) return false;
    this.ui.toast("Joining the fight...");
    return true;
  }

  /** Testing hook: walks the other character onto the battle and joins it. */
  debugJoinBattle(): boolean {
    const guest = this.activeBattle?.guest() ?? null;
    if (!this.activeBattle || guest === null) return false;
    const who = this.actorFor(guest);
    who.x = this.activeBattle.x;
    who.y = this.activeBattle.y;
    return this.joinActiveBattleAs(guest);
  }

  /** Post-battle grace: no contact triggers for a bit, and any roamer still
   * on top of the player scatters back into its meadow. */
  encounterGrace(): void {
    this.encCooldown = 3;
    for (let i = this.roamers.length - 1; i >= 0; i--) {
      const r = this.roamers[i]!;
      if (Math.hypot(r.actor.x - this.player.x, r.actor.y - this.player.y) < 56) {
        const zi = this.world.encounters.indexOf(r.zone);
        this.roamers.splice(i, 1);
        if (zi >= 0) this.zoneRespawn[zi] = Math.max(this.zoneRespawn[zi] ?? 0, 4);
      }
    }
  }

  private questToasts(messages: string[]): void {
    if (messages.length === 0) return;
    this.ui.toast(messages.join(" · "));
    autosave(this.save);
  }

  private checkReachSteps(): void {
    for (const step of reachSteps(this.content, this.save, this.mapId)) {
      if (Math.hypot(this.player.x - step.x, this.player.y - step.y) > step.r) continue;
      this.questToasts(advanceQuest(this.content, this.save, step.questId));
    }
  }

  private npcInteract(npc: NpcDef): void {
    const say = (lines: string[], onDone?: () => void): void => {
      const shown = lines.length > 0 ? lines : ["..."];
      this.ui.openDialog(shown.map((text) => ({ who: npc.name, text })), onDone);
    };
    const action = npcAction(this.content, this.save, npc);
    if (action.kind === "chat") {
      say(action.lines);
    } else if (action.kind === "quest-talk") {
      say(action.lines, () => {
        this.questToasts(advanceQuest(this.content, this.save, action.questId));
      });
    } else {
      const questId = action.kind === "quest-battle" ? action.questId : null;
      say(action.intro, () => this.hooks.onTrainerBattle(npc, (won) => {
        if (!won) return;
        markTrainerBeaten(this.save, npc.id);
        this.creditSentinels("trainer", { x: this.player.x, y: this.player.y }, npc.id);
        if (questId) this.questToasts(advanceQuest(this.content, this.save, questId));
        else autosave(this.save);
      }));
    }
  }

  private tryInteract(): void {
    const px = this.player.x;
    const py = this.player.y;
    const partnerName = this.save.characters[this.save.localSlot === "A" ? "B" : "A"].name;

    if (this.joinActiveBattle()) return;

    let nearest: NpcRuntime | null = null;
    let nearestD = 26;
    for (const n of this.npcs) {
      const d = Math.hypot(n.actor.x - px, n.actor.y - py);
      if (d < nearestD) {
        nearest = n;
        nearestD = d;
      }
    }
    if (nearest) {
      this.npcInteract(nearest.def);
      return;
    }

    if (Math.hypot(this.partner.actor.x - px, this.partner.actor.y - py) < 26) {
      this.ui.openDialog([
        { who: partnerName, text: `The professor wants us past the meadow. ${SPECIAL.name} comes too.` },
        { who: partnerName, text: "Two of us, one path." },
      ]);
      return;
    }
    for (const it of this.world.map.interactables) {
      if (Math.hypot(it.x - px, it.y - py) > it.r) continue;
      if (it.id === "nest") {
        this.hooks.onOpenNest();
      } else if (it.id === "meadow") {
        this.ui.openDialog([{ text: "Wild Scobas prowl the flowers. Get close and they charge." }]);
      }
      return;
    }
  }

  /** Testing/debug teleport. */
  debugWarp(x: number, y: number): void {
    this.player.x = x;
    this.player.y = y;
    const crowd = [this.player, ...this.companions.map((c) => c.actor)];
    for (const c of this.companions) c.placeNear(this.world.map, crowd);
    for (const slot of ["A", "B"] as SlotId[]) {
      const at = slot === this.save.localSlot ? this.player : this.partner.actor;
      this.trails[slot].reset(at.x, at.y);
    }
  }

  /** Testing/debug teleport of the player only; companions must catch up. */
  debugWarpPlayer(x: number, y: number): void {
    this.player.x = x;
    this.player.y = y;
  }

  /** Testing/debug: is this point somewhere anyone could stand? */
  debugBlocked(x: number, y: number): boolean {
    return blocked(this.world.map, x, y, 4);
  }

  /** Testing/debug: drop the partner somewhere, walls and all. */
  debugPlacePartner(x: number, y: number): void {
    this.partner.teleportTo(x, y);
  }

  /** Testing/debug snapshot of actor state. */
  debugInfo(): object {
    return {
      player: { x: this.player.x, y: this.player.y, dir: this.player.dir },
      // Where a co-op fight is standing, so a test can tell whether the peer's
      // battle was heard about without walking to it.
      activeBattle: this.activeBattle
        ? { x: this.activeBattle.x, y: this.activeBattle.y, guest: this.activeBattle.guest() }
        : null,
      partner: this.partner.debug(),
      companionship: { ...(this.save.companionship ?? {}), here: this.lastHere },
      special: this.special.debug(),
      pets: this.pets.map((p) => p.debug()),
      roamers: this.roamers.map((r) => ({
        x: Math.round(r.actor.x),
        y: Math.round(r.actor.y),
        species: r.scoba.speciesId,
        level: r.scoba.level,
        chasing: r.chasing,
        shiny: r.scoba.shiny === true,
        fade: Number(r.actor.fade.toFixed(2)),
      })),
      view: this.view,
      zoneRespawn: [...this.zoneRespawn],
      encCooldown: this.encCooldown,
      care: this.save.special,
    };
  }

  // --- dev editor hooks ---

  /** Rebuild NPC actors after the editor changes content.npcs. */
  refreshNpcs(): void {
    this.npcs = buildNpcs(this.art, this.content, this.mapId);
  }

  devWorld(): WorldDef {
    return this.world;
  }

  devArt(): Art {
    return this.art;
  }

  devMapId(): string {
    return this.mapId;
  }

  /** Show only the layers the editor asks for, and redraw the map for it. */
  devShowLayers(filter: LayerFilter): void {
    this.layerFilter = filter;
    const m = this.mapDef();
    if (m) applyArt(this.world.map, this.art, m, this.sentinelOpen, this.layerFilter);
  }

  /** Point the editor (and the running scene) at another map. */
  devOpenMap(mapId: string): void {
    if (!mapById(this.content, mapId)) return;
    this.enterMap(mapId);
  }

  playerPos(): { x: number; y: number } {
    return { x: this.player.x, y: this.player.y };
  }

  /** The camera rect drawn last frame, for mapping pointer events to world. */
  viewRect(): { x: number; y: number; w: number; h: number } {
    return this.view;
  }

  /** Keep the water moving while the editor has the sim paused. */
  devTick(dt: number): void {
    this.world.map.waterAnimT += dt;
  }

  /** Pull one cell's terrain from content into the live layout arrays. */
  devApplyTerrain(cx: number, cy: number): void {
    const layout = this.world.layout;
    const m = this.mapDef();
    if (!layout || !m) return;
    const ch = terrainAt(m, cx, cy);
    const i = cy * this.world.map.cols + cx;
    layout.land[i] = ch === "l";
    layout.deck[i] = ch === "b";
    applySolidCell(this.world.map, this.art, this.content, m, layout.land, layout.deck, cx, cy, this.sentinelOpen);
  }

  devApplyCollision(cx: number, cy: number): void {
    const layout = this.world.layout;
    const m = this.mapDef();
    if (!layout || !m) return;
    applySolidCell(this.world.map, this.art, this.content, m, layout.land, layout.deck, cx, cy, this.sentinelOpen);
  }

  /** After a tile is painted: its art, and the collision it brings with it. */
  devApplyTile(cx: number, cy: number): void {
    const m = this.mapDef();
    if (m) applyArt(this.world.map, this.art, m, this.sentinelOpen, this.layerFilter);
    this.devApplyCollision(cx, cy);
  }

  /** After a tile's rule changes, since every cell holding it moves at once. */
  devRebuildCollision(): void {
    this.rebuildMapArt();
  }

  devRebuildProps(): void {
    const m = this.mapDef();
    if (m) applyArt(this.world.map, this.art, m, this.sentinelOpen, this.layerFilter);
  }

  devRebuildZones(): void {
    const m = this.mapDef();
    this.world.encounters = (m?.zones ?? []).map(cloneZone);
    this.roamers = [];
    this.zoneRespawn = [];
  }

  devSetSpawn(): void {
    const m = this.mapDef();
    if (m) this.world.spawn = { ...m.spawn };
  }

  /** Full rebuild from content, for undo restores, imports and resizes. */
  devReload(): void {
    this.mapId = resolveMapId(this.content, this.mapId);
    this.world = resolveWorld(this.art, this.save.worldSeed, this.content, this.mapId, this.sentinelOpen);
    this.roamers = [];
    this.zoneRespawn = [];
    this.refreshNpcs();
  }

  draw(r: Renderer): void {
    const ctx = r.ctx;
    const map = this.world.map;
    if (this.devCam) {
      // The editor's free camera: no smoothing, same world clamp.
      this.cam.x = this.devCam.x - r.width / 2;
      this.cam.y = this.devCam.y - r.height / 2;
      this.cam.follow(this.devCam.x, this.devCam.y, r.width, r.height, map.widthPx, map.heightPx);
    } else {
      this.cam.follow(this.player.x, this.player.y, r.width, r.height, map.widthPx, map.heightPx);
    }
    const camX = Math.round(this.cam.x);
    const camY = Math.round(this.cam.y);
    this.view = { x: camX, y: camY, w: r.width, h: r.height };

    ctx.fillStyle = "#4a90b8";
    ctx.fillRect(0, 0, r.width, r.height);
    map.drawGround(ctx, camX, camY, r.width, r.height);

    // Y-sorted pass: props and actors interleave by baseline.
    const items: { baseY: number; draw: () => void }[] = [];
    for (const p of map.props) {
      items.push({
        baseY: p.baseY,
        draw: () => ctx.drawImage(
          p.img, p.sx, p.sy, p.sw, p.sh,
          Math.round(p.x - camX), Math.round(p.y - camY), p.dw ?? p.sw, p.dh ?? p.sh,
        ),
      });
    }
    const actors = [
      this.player,
      ...this.companions.map((c) => c.actor),
      ...this.roamers.map((r2) => r2.actor),
      ...this.npcs.map((n) => n.actor),
    ];
    // Sorted on the lagging depth rather than the live position: two actors
    // walking abreast would otherwise trade places every frame.
    for (const actor of actors) {
      items.push({ baseY: actor.depthY, draw: () => actor.draw(ctx, camX, camY) });
    }
    items.sort((m, n) => m.baseY - n.baseY);
    for (const item of items) item.draw();

    map.drawCanopy(ctx, camX, camY, r.width, r.height);

    const t = map.waterAnimT;
    const marked = markedNpcs(this.content, this.save);
    for (const n of this.npcs) {
      if (!marked.has(n.def.id)) continue;
      drawNpcMarker(ctx, n.actor.x - camX, n.actor.y - 46 - camY, t);
    }
    for (const step of reachSteps(this.content, this.save, this.mapId)) {
      drawReachMarker(ctx, step.x - camX, step.y - camY, t);
    }
    if (this.activeBattle && this.activeBattle.guest() !== null) {
      drawBattleMarker(ctx, this.activeBattle.x - camX, this.activeBattle.y - camY, t);
    }

    this.overlay?.(ctx, camX, camY, r.width, r.height);
  }
}
