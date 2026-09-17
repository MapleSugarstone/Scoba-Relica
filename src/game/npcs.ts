// NPCs placed by the dev editor: villagers drawn on the paperdoll or a Scoba
// standing in as a character. They amble inside a small home radius the same
// way roamers do, freeze while a dialog is open, and draw a quest marker when
// a quest step wants them.
import type { Art } from "../engine/assets";
import { worldSprite } from "../engine/paperdoll";
import { DEFAULT_LOOK, type Look } from "../engine/recolor";
import { TILE, type TileMap } from "../engine/tilemap";
import type { Island } from "./islands";
import { SPECIES } from "../sim/species";
import { Actor } from "./actors";
import { critterSkin, personSkin } from "./critters";
import type { NpcDef, WorldContent } from "./content";

const WANDER_SPEED = 20;

export interface NpcRuntime {
  def: NpcDef;
  actor: Actor;
  wanderT: number;
  dx: number;
  dy: number;
}

export function npcLook(def: NpcDef): Look {
  const look = def.skin.kind === "villager" ? def.skin.look : {};
  return { ...DEFAULT_LOOK, ...look };
}

function makeActor(art: Art, def: NpcDef): Actor {
  if (def.skin.kind === "scoba") {
    const sp = SPECIES[def.skin.species];
    if (sp) {
      const actor = new Actor(def.x, def.y, critterSkin(art, sp));
      actor.radius = 3;
      return actor;
    }
  }
  return new Actor(def.x, def.y, personSkin(art, npcLook(def)));
}

/**
 * A free spot near a point, found by trying rings outward from it. Used for an
 * NPC with no written position, which is every NPC on a generated map: an
 * island is laid out fresh for every save, so a written spot is as likely to be
 * water as ground.
 */
function clearOf(map: TileMap, at: { x: number; y: number }): { x: number; y: number } {
  for (let ring = 1; ring <= SPOT_RINGS; ring++) {
    for (let i = 0; i < SPOT_TRIES; i++) {
      const a = (i / SPOT_TRIES) * Math.PI * 2;
      const spot = { x: at.x + Math.cos(a) * ring * SPOT_STEP, y: at.y + Math.sin(a) * ring * SPOT_STEP };
      if (!map.circleHits(spot.x, spot.y, NPC_RADIUS)) return spot;
    }
  }
  return at;
}

/**
 * The middle of an island the pair do not start on, so somebody stood there is
 * a trip away rather than a step. The furthest one from home, which on a map of
 * two islands is simply the other one. Null where there is only home.
 */
function awayIsland(world: WorldWithIslands): { x: number; y: number } | null {
  const set = world.islands;
  if (!set) return null;
  const far = set.all
    .filter((i) => i !== set.home)
    .sort((a, b) => Math.hypot(b.cx - set.home.cx, b.cy - set.home.cy)
      - Math.hypot(a.cx - set.home.cx, a.cy - set.home.cy))[0];
  return far ? { x: far.cx * TILE + TILE / 2, y: far.cy * TILE + TILE / 2 } : null;
}

/** How far out each ring sits, how many rings are tried, and how many spots on each. */
const SPOT_STEP = 18;
const SPOT_RINGS = 8;
const SPOT_TRIES = 12;
/** What an NPC has to fit in, matching the body the overworld walks about. */
const NPC_RADIUS = 4;

type WorldWithIslands = {
  map: TileMap;
  spawn: { x: number; y: number };
  islands?: { all: Island[]; home: Island };
};

export function buildNpcs(
  art: Art, content: WorldContent, mapId: string, world?: WorldWithIslands,
): NpcRuntime[] {
  return content.npcs.filter((def) => def.map === mapId).map((def) => {
    const actor = makeActor(art, def);
    if (def.stands && world) {
      // An island to itself where one was asked for and there is one to be had,
      // and the spawn otherwise, so they are always somewhere reachable.
      const want = def.stands === "away" ? awayIsland(world) ?? world.spawn : world.spawn;
      const at = clearOf(world.map, want);
      actor.x = at.x;
      actor.y = at.y;
    }
    return { def, actor, wanderT: Math.random() * 2, dx: 0, dy: 0 };
  });
}

export function updateNpcs(npcs: NpcRuntime[], dt: number, map: TileMap, frozen: boolean): void {
  for (const n of npcs) {
    if (frozen || n.def.wander <= 0) {
      n.actor.step(dt, 0, 0, map);
      continue;
    }
    n.wanderT -= dt;
    if (n.wanderT <= 0) {
      n.wanderT = 1.2 + Math.random() * 2.4;
      if (Math.random() < 0.55) {
        n.dx = 0;
        n.dy = 0;
      } else {
        const a = Math.random() * Math.PI * 2;
        n.dx = Math.cos(a);
        n.dy = Math.sin(a);
      }
      const away = Math.hypot(n.actor.x - n.def.x, n.actor.y - n.def.y);
      if (away > n.def.wander) {
        n.dx = (n.def.x - n.actor.x) / away;
        n.dy = (n.def.y - n.actor.y) / away;
      }
    }
    const oldSpeed = n.actor.speed;
    n.actor.speed = WANDER_SPEED;
    n.actor.step(dt, n.dx, n.dy, map);
    n.actor.speed = oldSpeed;
  }
}

/** A pixel "!" over anyone a quest wants, bobbing so it reads as alive. */
export function drawNpcMarker(ctx: CanvasRenderingContext2D, sx: number, sy: number, t: number): void {
  const bob = Math.round(Math.sin(t * 3.4) * 1.5);
  const x = Math.round(sx) - 2;
  const y = Math.round(sy) + bob;
  ctx.fillStyle = "#171b2c";
  ctx.fillRect(x - 1, y - 1, 6, 14);
  ctx.fillStyle = "#eae178";
  ctx.fillRect(x, y, 4, 8);
  ctx.fillRect(x, y + 10, 4, 3);
}

/** A bobbing diamond over an active `reach` quest target. */
export function drawReachMarker(ctx: CanvasRenderingContext2D, sx: number, sy: number, t: number): void {
  const bob = Math.sin(t * 3) * 2;
  const x = Math.round(sx);
  const y = Math.round(sy - 14 + bob);
  ctx.fillStyle = "#171b2c";
  for (let i = -1; i <= 1; i++) ctx.fillRect(x - 6 + Math.abs(i) * 2, y + i * 3 - 2, 12 - Math.abs(i) * 4, 4);
  ctx.fillStyle = "#e58ab8";
  for (let i = -1; i <= 1; i++) ctx.fillRect(x - 5 + Math.abs(i) * 2, y + i * 3 - 1, 10 - Math.abs(i) * 4, 2);
}

/** A clashing-swords ring over a co-op battle the other player can join. */
export function drawBattleMarker(ctx: CanvasRenderingContext2D, sx: number, sy: number, t: number): void {
  const x = Math.round(sx);
  const y = Math.round(sy);
  const pulse = 10 + Math.sin(t * 4) * 2;
  ctx.strokeStyle = "#171b2c";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "#e7a03c";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, pulse, 0, Math.PI * 2);
  ctx.stroke();
  const bob = Math.round(Math.sin(t * 3.4) * 1.5);
  ctx.fillStyle = "#171b2c";
  ctx.fillRect(x - 6, y - 22 + bob, 12, 10);
  ctx.fillStyle = "#e7a03c";
  ctx.fillRect(x - 5, y - 21 + bob, 10, 8);
  ctx.fillStyle = "#171b2c";
  ctx.fillRect(x - 3, y - 19 + bob, 2, 4);
  ctx.fillRect(x + 1, y - 19 + bob, 2, 4);
}
