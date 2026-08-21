// NPCs placed by the dev editor: villagers drawn on the paperdoll or a Scoba
// standing in as a character. They amble inside a small home radius the same
// way roamers do, freeze while a dialog is open, and draw a quest marker when
// a quest step wants them.
import type { Art } from "../engine/assets";
import { worldSprite } from "../engine/paperdoll";
import { DEFAULT_LOOK, type Look } from "../engine/recolor";
import type { TileMap } from "../engine/tilemap";
import { SPECIES } from "../sim/species";
import { Actor } from "./actors";
import { critterSkin } from "./critters";
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
  return new Actor(def.x, def.y, { sprite: worldSprite(art.doll, npcLook(def)), motion: "hop" });
}

export function buildNpcs(art: Art, content: WorldContent, mapId: string): NpcRuntime[] {
  return content.npcs.filter((def) => def.map === mapId).map((def) => ({
    def,
    actor: makeActor(art, def),
    wanderT: Math.random() * 2,
    dx: 0,
    dy: 0,
  }));
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
