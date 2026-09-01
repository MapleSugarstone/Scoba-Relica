// The battle as a scene rather than a card table: the two characters and
// their Scobas on the left, the enemy trainer or wild Scoba on the right,
// drawn on the same canvas and through the same sprite path the overworld
// uses. `ui/battle.ts` owns the fight; this owns how it looks.
//
// Everything the stage does is a queue of timed steps driven by the frame
// loop, and every step reports how long it wants. `instant` collapses them
// all to nothing, which is what lets the tests run a battle without waiting.
import type { Art } from "../engine/assets";
import type { Renderer } from "../engine/renderer";
import { ART } from "../engine/renderer";
import { DOLL_W, worldSprite } from "../engine/paperdoll";
import { sfx } from "../engine/sfx";
import { Actor, MOTIONS } from "./actors";
import { critterLook, critterBounds, type CritterBounds } from "./critters";
import type { BattleEvent, BattleState } from "../sim/battle";
import { animOf, vfxOf, MOVES, SPECIES, type CasterAnim, type MoveVfx } from "../sim/species";
import { FIELDS } from "../sim/status";
import { TYPE_COLORS } from "../sim/types";
import { ALL_SLOTS, SCOBA_SLOTS, isPawnSlot, type TargetRef } from "../sim/targeting";
import type { SaveData, SlotId } from "../save/save";

/** Where a fighter stands, as a share of the view. */
interface Anchor {
  x: number;
  y: number;
}

interface Fighter {
  actor: Actor;
  /** Slot it belongs to, which is what its anchor is computed from. */
  side: 0 | 1;
  slot: number;
  /** Standing on a Pawn mark: back off the line, and on a small card. */
  pawn: boolean;
  /** Where its art sits, in world units, so markers can find its head. */
  bounds: CritterBounds;
  /**
   * How far its head reaches above the mark it stands on, at the top of its
   * idle bob. Markers are hung off the highest the head goes rather than off
   * where it is this frame, so nothing ever bobs up through an arrow.
   */
  head: number;
  /** Team index, so the stage can be re-read off the battle state. */
  index: number;
  /** Offset from the anchor, which is what the move animations drive. */
  ox: number;
  oy: number;
  /** 0 hidden, 1 fully drawn. Blinking and fainting ride this. */
  alpha: number;
  /** Extra rattle, in world units. */
  shake: number;
  hurt: number;
  /**
   * Whether it is standing on its mark. A readout stays hidden while its
   * Scoba is still walking on and fades in once it arrives.
   */
  settled: boolean;
  /** What the readout is drawn at, eased toward where it should be. */
  plate: number;
  /**
   * Set when it has been called back: it walks off the field under its own
   * steam rather than standing there while its replacement arrives.
   */
  leaving: Retreat | null;
}

/** A walk off the field: out and down a little, then out and away. */
interface Retreat {
  leg: 0 | 1;
  /** Where the first short diagonal takes it. */
  turn: { x: number; y: number };
  /** Where the second one is headed, which is past the edge of the view. */
  exit: { x: number; y: number };
}

/**
 * What the readouts are currently showing. The battle resolves a whole round
 * in one go, so the live combatant is already at its end-of-round values
 * before a single animation has played. This is the lagging copy the plates
 * and the sprites read, advanced event by event as the round plays out.
 *
 * A value snaps to whatever the event left the combatant on, and its trail
 * follows it in, so what a hit took reads as a band draining out of the bar
 * rather than as the whole bar sliding.
 */
interface Shown {
  hp: number;
  hpTrail: number;
  mana: number;
  manaTrail: number;
  fainted: boolean;
}

/**
 * The field a side is drawn as standing under. Like the readouts this lags the
 * battle: the state has the new weather the moment the round resolves, and the
 * wash only comes up when the event that called it plays.
 *
 * One field at a time means one wash at a time. A field laid over another one
 * fades the old out before the new comes in, so the two never overlap into a
 * colour neither of them is.
 */
interface FieldWash {
  /** What is being drawn, which is not yet `want` while it is fading out. */
  id: string | null;
  /** 0 nothing, 1 full wash. */
  a: number;
  want: string | null;
}

interface Effect {
  kind: MoveVfx | "impact" | "poof";
  t: number;
  dur: number;
  from: Anchor;
  to: Anchor;
  color: string;
}

interface Step {
  dur: number;
  /** Called each frame with the progress 0..1 and the frame's delta. */
  run?: (k: number, dt: number) => void;
  start?: () => void;
  end?: () => void;
  /**
   * Keeps the step open past its time while this returns true, so a walk ends
   * where the walker is rather than being put on its mark. Bounded by `cap`
   * seconds, past which the queue moves on regardless.
   */
  hold?: () => boolean;
  cap?: number;
}

/** How fast the highlight behind a bar closes on the bar itself. */
const TRAIL_EASE = 5;

/**
 * How fast the stage plays, against the clock the rest of the game runs on.
 * Every duration, ease and walk on the stage reads its time through this, so
 * the one number paces the whole fight.
 */
const STAGE_PACE = 0.7;

/** Longest a step will wait for a walk that is running late. */
const HOLD_CAP = 4;

/**
 * Slack a walk is allowed to stop within, in world units. Small, because a
 * walk lands on its mark now rather than creeping up on it.
 */
const ARRIVED = 0.5;

/**
 * The floor under a stage walk's pace. Everyone here has somewhere to be and a
 * step to be there by, so nobody creeps the last stretch the way a companion
 * ambling after you is allowed to.
 */
const WALK_ON = 0.85;

/** Eases a trail toward the value in front of it, landing rather than creeping. */
function easeTrail(from: number, to: number, dt: number): number {
  if (Math.abs(to - from) < 0.05) return to;
  return from + (to - from) * Math.min(1, dt * TRAIL_EASE);
}

const CHAR_SPEED = 80;
/** How fast a Scoba takes the field. */
const ENTER_SPEED = 110;
/**
 * The stage's ranks, as shares of the room left above the action bar. They are
 * spread across the whole of it rather than bunched around one floor line,
 * which is what used to leave a third of the screen empty over their heads and
 * a band of nothing between them and the buttons.
 *
 * How much room there is depends on how tall the action bar has come out, so it
 * is measured rather than guessed at. That is also why there is one set of
 * these and not one per orientation: a portrait screen has a deeper bar and
 * gets a shorter band, which is all the old split was really saying.
 */
const RANK = {
  /** Where the far ground gives way to the near, behind the whole cast. */
  step: 0.45,
  back: 0.60,
  front: 0.71,
  /** The enemy trainer, opposite and a little behind their Scobas. */
  trainer: 0.65,
  castBack: 0.80,
  castFront: 0.87,
  /**
   * The court gathers at the very front of its own side, in a row down at the
   * bottom corner beside the buttons. Far enough back off the action bar that
   * the small cards under them still clear it.
   */
  pawns: 0.93,
};

/**
 * The sky is a strip off the top of the view rather than a share of the stage:
 * everything under it is ground, so the room a tall screen has to spare reads
 * as a field going away from you instead of as a hole above the fight.
 */
const SKY_SHARE = 0.06;
/**
 * How deep the stage ever gets, back rank to front, in world units. A phone has
 * half again as much height to give as a laptop does, and a fight stretched to
 * fill it is a fight with holes between its rows. Anything left over goes
 * behind the stage rather than in front of it: ground going away from you reads
 * as distance, where a gap between the front rank and the buttons only reads as
 * the fight having come loose from its controls.
 */
const STAGE_DEPTH = 260;

/**
 * Half the width the field ever spreads to, in world units. Past this the two
 * sides stop drifting apart: a fight on a very wide screen reads as a group of
 * people in the middle of it, not as two teams pinned to opposite edges.
 */
const FIELD_MAX = 185;
/**
 * How far out each mark stands, as a share of that half-width. The front pair
 * are well in from their own edges: they face each other across the middle,
 * and the room between them is what everything thrown gets to fly through.
 */
const SCOBA_ACROSS = [0.28, 0.62];

/**
 * How far in from its own edge a side's first person stands, in world units.
 * Half a doll and a little air, so nobody is drawn off the side of the view.
 */
const EDGE = DOLL_W / (2 * ART) + 3;
/**
 * The least the Pawn row ever spreads, in world units, for the frames before a
 * card has been measured.
 *
 * The step cannot be a constant. What must not collide is the readouts, and a
 * readout is a fixed number of interface pixels wide while a world unit is
 * worth a varying number of them: `pixelStep()` is a whole number and the
 * screen's density is not, so one machine gets 8 interface pixels to the world
 * unit and another gets 4. At 4 this constant put three cards 64 px apart when
 * each was 104 px wide, and the row overlapped itself by 40 px a side.
 * `ui/battle.ts` measures a card and `setPawnCard` turns it into the real
 * step.
 */
const PAWN_STEP = 16;
/** Air between two Pawn cards, and between the outermost one and the edge. */
const PAWN_GAP = 4;

/**
 * Slack around a Scoba's drawn pixels, in world units: air under the ring and
 * room for a thumb that lands beside a small one rather than on it.
 */
const TOUCH_PAD = 3;
/** How far over a head a marker floats, and how far it bobs. */
const MARKER_GAP = 2;
const MARKER_BOB = 1.5;
/** How thick the ring around a target is drawn, in art pixels. */
const RETICLE_BRUSH = 3;
/**
 * How high a shot is thrown over the line between its ends, per world unit of
 * ground it climbs, and the most it ever is. Enough to clear the readout of
 * anyone standing between the two.
 */
const ARC_PER_RANK = 0.55;
const ARC_MAX = 26;
/** How long a call takes, and how much of it is the caller rattling. */
const SUMMON_TIME = 0.85;
const SUMMON_CALL = 0.55;
/**
 * How long calling up a field takes, and how much of it is the caller
 * rattling. The wash starts coming in on the beat the rattle ends, the way a
 * summon's poof does, so what the Scoba did and what turned up read as one
 * thing rather than two.
 */
const FIELD_TIME = 0.95;
const FIELD_CALL = 0.5;
/** How fast a wash comes in and goes out, in full washes per second. */
const FIELD_FADE = 1.6;
/**
 * How strong a wash ever gets. It goes down as soft light rather than as paint,
 * so a warm field warms the ground and leaves the Scobas standing on it their
 * own colours; a flat fill strong enough to read as weather greys everything
 * under it out. A dark tint darkens through the same blend, which is what lets
 * one number cover a field of any colour.
 */
const FIELD_WASH = 0.7;
/** What a browser with no soft light gets instead, as a flat fill. */
const FIELD_WASH_FLAT = 0.17;
/** How a Scoba nobody is controlling this moment is drawn. */
const WAITING_TINT = "brightness(0.4) saturate(0.7)";

export class BattleStage {
  private fighters: Fighter[] = [];
  /** The two characters, and the enemy trainer when there is one. */
  private people: {
    actor: Actor; side: 0 | 1; slot: number; ox: number; oy: number;
    /** Which character this is, so somebody arriving can be found or added. */
    who?: SlotId;
  }[] = [];
  private effects: Effect[] = [];
  /** The wash over each side, side 0's half of the view and side 1's. */
  private washes: [FieldWash, FieldWash] = [
    { id: null, a: 0, want: null },
    { id: null, a: 0, want: null },
  ];
  private queue: Step[] = [];
  private stepT = 0;
  private started = false;
  private done: (() => void) | null = null;
  private view = { w: 320, h: 180 };
  private shown = new Map<string, Shown>();
  /** Valid targets while a move is being aimed, and the one under the cursor. */
  private aim: { options: TargetRef[]; hover: TargetRef | null } | null = null;
  /**
   * Whose choice the screen is on, and who on that side is not being
   * controlled right now. The one being picked for wears a marker; the rest
   * are darkened, which is what tells a solo player, picking for both
   * characters in turn, which of the two they are looking at.
   */
  private turn: { acting: TargetRef | null; waiting: TargetRef[] } = { acting: null, waiting: [] };
  /**
   * Called after every draw, so the DOM readouts can follow the sprites.
   * Tied to drawing rather than to simulation on purpose: the readouts are
   * presentation, and they have to be in the right place even on frames where
   * nothing is allowed to move, such as while a transition holds the scene.
   */
  onFrame: (() => void) | null = null;
  /** Skips every duration, for tests and for the fast-forward hook. */
  instant = false;
  /** True while the opening is running, so the readouts hold off. */
  private opening = false;
  /** False until a frame has been drawn, so the view size is real. */
  private drawn = false;
  /** How much of the bottom the action bar covers, in world units. */
  private safeBottom = 0;
  /**
   * What it has just been measured at. A page whose buttons come out taller
   * than the rest, a long target list, moves every mark on the field, so the
   * scene slides to the new layout over a few frames rather than jumping to it.
   */
  private safeWant = 0;

  constructor(
    private art: Art,
    private st: BattleState,
    private save: SaveData,
    private opts: { fighters: SlotId[]; trainer: boolean },
  ) {
    this.instant = (window as { __scobaFast?: boolean }).__scobaFast === true;
    this.buildPeople();
    this.sync();
  }

  // --- layout ---

  /**
   * Anchors are fractions of the view so the same choreography reads on a
   * wide desktop and a narrow phone. The two slots on a side stagger toward
   * the middle and down, which keeps them apart without needing room.
   */
  /**
   * How much room the interface has left the scene at the bottom, in world
   * units. The action row is DOM and its height changes with the screen, so
   * `ui/battle.ts` measures it and the whole layout is worked out in what is
   * above it rather than against a guess.
   */
  /**
   * How wide a Pawn's readout actually came out, in screen pixels. Sets both
   * how far apart the row stands and how far in from the edge it starts, so
   * the outermost card cannot hang off the side of the screen.
   */
  private pawnStep = PAWN_STEP;
  private pawnEdge = EDGE;

  setPawnCard(px: number): void {
    if (px <= 0) return;
    const world = px * this.cssScale();
    this.pawnStep = Math.max(PAWN_STEP, world + PAWN_GAP);
    this.pawnEdge = Math.max(EDGE, world / 2 + PAWN_GAP);
  }

  setSafeBottom(px: number): void {
    this.safeWant = Math.min(this.view.h * 0.5, Math.max(0, px) * this.cssScale());
    // The first reading is the layout, not a change to it.
    if (this.safeBottom === 0) this.safeBottom = this.safeWant;
  }

  /**
   * The band the ranks are laid out in: the room above the action bar, capped
   * at `STAGE_DEPTH` and sat against the bottom of it.
   */
  private band(): { top: number; height: number } {
    const room = Math.max(1, this.view.h - this.safeBottom);
    const height = Math.min(room, STAGE_DEPTH);
    return { top: room - height, height };
  }

  /** Where a rank sits, in world units down that band. */
  private rankY(share: number): number {
    const b = this.band();
    return b.top + b.height * share;
  }

  /**
   * How far out the field spreads either side of the middle. It stops growing
   * past `FIELD_MAX`, so a very wide screen gets margins rather than two teams
   * shouting at each other from opposite edges.
   */
  private fieldHalf(): number {
    return Math.min(this.view.w * 0.44, FIELD_MAX);
  }

  private anchor(side: 0 | 1, slot: number): Anchor {
    const mid = this.view.w / 2;
    const out = (side === 0 ? -1 : 1) * this.fieldHalf();
    // The court gathers at the front corner of its own side, in a row running
    // inward from the edge, where it fills the ground beside the buttons
    // instead of floating about behind everybody.
    if (isPawnSlot(slot)) {
      const i = slot - SCOBA_SLOTS;
      const along = this.pawnEdge + i * this.pawnStep;
      return {
        x: side === 0 ? along : this.view.w - along,
        y: this.rankY(RANK.pawns),
      };
    }
    const across = SCOBA_ACROSS[slot] ?? SCOBA_ACROSS[0]!;
    return { x: mid + out * across, y: this.rankY(slot === 0 ? RANK.front : RANK.back) };
  }

  /**
   * Where a character stands: behind and outside their Scobas, and staggered
   * out and up the way the two Scobas are, so the pair read as two people
   * rather than one thick one.
   *
   * Measured in world units off the edge rather than in fractions of the view,
   * because a character is the same size whatever the view is: on a phone a
   * fraction leaves the two of them on top of each other and half off screen.
   */
  private personAnchor(side: 0 | 1, slot: number): Anchor {
    const { w } = this.view;
    const mid = w / 2;
    const half = this.fieldHalf();
    // Just outside the field on their own side, rather than a fixed share of
    // the view: on a wide screen a fraction leaves them marooned in a corner
    // with the fight going on somewhere else.
    if (side === 1) return { x: Math.min(w - EDGE, mid + half + 28), y: this.rankY(RANK.trainer) };
    // Down the screen from their Scobas, and staggered out and up the way the
    // Scobas themselves are. Far enough down to clear the readouts hanging
    // under the back Scoba, which on a narrow view reach the left edge.
    const base = Math.max(EDGE, mid - half - 30);
    return {
      x: base + (slot === 0 ? 26 : 0),
      y: this.rankY(slot === 0 ? RANK.castFront : RANK.castBack),
    };
  }

  private buildPeople(): void {
    const local = this.save.localSlot;
    const order: SlotId[] = this.opts.fighters.includes(local)
      ? [local, ...this.opts.fighters.filter((f) => f !== local)]
      : this.opts.fighters;
    order.forEach((slot, i) => {
      const look = this.save.characters[slot].look;
      const actor = new Actor(0, 0, { sprite: worldSprite(this.art.doll, look), motion: "hop" });
      actor.speed = CHAR_SPEED;
      actor.dir = 1;
      actor.desync(i * 0.41 + 0.13);
      this.people.push({ actor, side: 0, slot: i, ox: 0, oy: 0, who: slot });
    });
    if (this.opts.trainer) {
      const other: SlotId = local === "A" ? "B" : "A";
      // No art of their own yet: the trainer borrows the other character doll,
      // which at least reads as a person standing opposite.
      const actor = new Actor(0, 0, {
        sprite: worldSprite(this.art.doll, this.save.characters[other].look),
        motion: "hop",
      });
      actor.speed = CHAR_SPEED;
      actor.dir = -1;
      actor.desync(0.67);
      this.people.push({ actor, side: 1, slot: 0, ox: 0, oy: 0 });
    }
  }

  /**
   * Re-reads who is standing where. Called after a switch, a join or a
   * summon, so the stage follows the battle rather than tracking it twice.
   */
  sync(): void {
    const wanted: Fighter[] = [];
    for (const side of [0, 1] as const) {
      for (const slot of ALL_SLOTS) {
        const index = this.st.active[side][slot] ?? -1;
        if (index < 0) continue;
        const c = this.st.teams[side][index];
        if (!c) continue;
        // A Scoba the battle has already downed stays on the field until its
        // own faint animation has played.
        if (this.shownOf(side, index).fainted) continue;
        const kept = this.fighters.find((f) => f.side === side && f.index === index);
        if (kept) {
          kept.slot = slot;
          wanted.push(kept);
          continue;
        }
        const sp = SPECIES[c.scoba.speciesId];
        if (!sp) continue;
        const pawn = isPawnSlot(slot);
        const at = this.anchor(side, slot);
        const actor = new Actor(at.x, at.y, critterLook(this.art, sp, c.scoba));
        actor.dir = side === 0 ? 1 : -1;
        actor.speed = ENTER_SPEED;
        actor.radius = 3;
        // Standing ready: hopping species keep bouncing, hovering ones are
        // already at full float and are left alone.
        actor.idleMix = 0.45;
        const bounds = critterBounds(this.art, sp);
        // Deterministic per slot, so the bob is out of step with the others
        // but lands the same way on both clients.
        actor.desync(((side * 2 + slot) * 0.37 + index * 0.19) % 1);
        // A Pawn is only ever on the field because something called it, and
        // the call is what brings it in, so it starts hidden and the summon
        // event is what makes it appear.
        wanted.push({
          actor, side, slot, index, pawn, ox: 0, oy: 0,
          bounds, head: bounds.top + idleLift(sp.movement, actor.idleMix),
          alpha: pawn ? 0 : 1, shake: 0, hurt: 0,
          settled: !pawn, plate: pawn ? 0 : 1, leaving: null,
        });
        continue;
      }
    }
    // Anyone on the way out is carried over until they have finished fading,
    // readout and all, rather than being cut the moment their slot clears.
    for (const f of this.fighters) {
      if (wanted.includes(f)) continue;
      if (f.alpha <= 0.02 && f.plate <= 0.01) continue;
      f.settled = false;
      wanted.push(f);
    }
    this.fighters = wanted;
  }

  private static key(side: 0 | 1, index: number): string {
    return `${side}:${index}`;
  }

  /**
   * Freezes what the plates show at the values in front of the player right
   * now. Called before the round is resolved, so the round's results have
   * something to be revealed against.
   */
  snapshot(): void {
    for (const side of [0, 1] as const) {
      this.st.teams[side].forEach((c, index) => {
        const k = BattleStage.key(side, index);
        const held = this.shown.get(k);
        if (held) {
          held.mana = c.mana;
          held.fainted = c.fainted;
          return;
        }
        this.shown.set(k, { hp: c.hp, hpTrail: c.hp, mana: c.mana, manaTrail: c.mana, fainted: c.fainted });
      });
    }
  }

  /** What the readout for a combatant should say this frame. */
  shownOf(side: 0 | 1, index: number): {
    hp: number; hpTrail: number; mana: number; manaTrail: number; fainted: boolean;
  } {
    const held = this.shown.get(BattleStage.key(side, index));
    const c = this.st.teams[side][index];
    if (!held) {
      const hp = c?.hp ?? 0;
      const mana = c?.mana ?? 0;
      return { hp, hpTrail: hp, mana, manaTrail: mana, fainted: c?.fainted ?? false };
    }
    return {
      hp: Math.max(0, Math.round(held.hp)),
      hpTrail: Math.max(0, held.hpTrail),
      mana: held.mana,
      manaTrail: Math.max(0, held.manaTrail),
      fainted: held.fainted,
    };
  }

  /**
   * Brings the readouts level with the battle, once the round has played. The
   * trails are left where they are, so the blow that ended the round keeps a
   * highlight to drain instead of losing it the moment the round does.
   */
  settle(): void {
    for (const side of [0, 1] as const) {
      this.st.teams[side].forEach((c, index) => {
        const k = BattleStage.key(side, index);
        const held = this.shown.get(k);
        this.shown.set(k, {
          hp: c.hp,
          hpTrail: this.instant ? c.hp : held?.hpTrail ?? c.hp,
          mana: c.mana,
          manaTrail: this.instant ? c.mana : held?.manaTrail ?? c.mana,
          fainted: c.fainted,
        });
      });
    }
    for (const side of [0, 1] as const) this.setWash(side, this.st.fields[side]?.id ?? null);
    this.sync();
  }

  private find(ref: TargetRef | undefined): Fighter | null {
    if (!ref) return null;
    return this.fighters.find((f) => f.side === ref.side && f.index === ref.index) ?? null;
  }

  private posOf(f: Fighter): Anchor {
    return { x: f.actor.x + f.ox, y: f.actor.y + f.oy };
  }

  /**
   * The mark a fighter stands on, without whatever its move is doing to it.
   * A readout is pinned to this rather than to the sprite, so it holds still
   * while its Scoba lunges, rears and blinks about, and only travels when the
   * Scoba really walks somewhere.
   */
  private restOf(f: Fighter): Anchor {
    return { x: f.actor.x, y: f.actor.y };
  }

  /**
   * Sends a fighter off the field: its readout goes at once, then it takes a
   * short diagonal out of the row and carries on out past the edge. Walking
   * off is what makes room for the replacement; standing there reads as the
   * two of them sharing a mark.
   */
  private sendOff(f: Fighter): void {
    const away = f.side === 0 ? -1 : 1;
    // Down as well as out, so it leaves the row before it leaves the view and
    // never walks through whoever is arriving.
    f.leaving = {
      leg: 0,
      turn: { x: f.actor.x + away * 22, y: f.actor.y + 14 },
      exit: { x: away < 0 ? -30 : this.view.w + 30, y: f.actor.y + 30 },
    };
    f.settled = false;
    // The readout goes with it rather than easing out over the empty mark.
    f.plate = 0;
    f.ox = 0;
    f.oy = 0;
    f.actor.dir = away;
  }

  /** Carries anyone on their way off a little further along it. */
  private stepRetreats(dt: number): void {
    let anyGone = false;
    for (const f of this.fighters) {
      const going = f.leaving;
      if (!going) continue;
      const mark = going.leg === 0 ? going.turn : going.exit;
      const left = f.actor.seek(dt, mark.x, mark.y, 0.5, NO_MAP, 1.5, WALK_ON);
      if (going.leg === 0 && left <= 0.5) going.leg = 1;
      f.actor.dir = f.side === 0 ? -1 : 1;
      // Past the edge it is off the field for good, rather than idling out
      // there until something else happens to call sync.
      if (f.side === 0 ? f.actor.x < -24 : f.actor.x > this.view.w + 24) {
        f.alpha = 0;
        anyGone = true;
      }
    }
    if (anyGone) this.fighters = this.fighters.filter((f) => !f.leaving || f.alpha > 0);
  }

  /**
   * Brings each side's wash toward what it should be. A wash on its way out is
   * taken all the way off before the one replacing it starts coming in, which
   * is what keeps two fields from ever being half-drawn at once.
   */
  private stepWashes(dt: number): void {
    for (const wash of this.washes) {
      if (wash.id === wash.want) {
        if (wash.id !== null) wash.a = Math.min(1, wash.a + dt * FIELD_FADE);
        continue;
      }
      wash.a -= dt * FIELD_FADE;
      if (wash.a > 0) continue;
      wash.a = 0;
      wash.id = wash.want;
    }
  }

  /** What the scene has been told the weather is now. */
  private setWash(side: 0 | 1, id: string | null): void {
    const wash = this.washes[side];
    wash.want = id;
    // Coming back to the field already up is a renewal, not a new one: it stays
    // drawn rather than blinking out and back in.
    if (wash.id === null && id !== null) wash.id = id;
  }

  /**
   * The field the scene is showing over a side, which is what a readout marks
   * rather than what the battle holds: the state has the new weather the moment
   * the round resolves, and the mark should turn up with the wash.
   */
  shownField(side: 0 | 1): string | null {
    return this.washes[side].want;
  }

  /** Puts the washes level with the battle, for a stage that cannot fade. */
  private snapWashes(): void {
    for (const side of [0, 1] as const) {
      const id = this.st.fields[side]?.id ?? null;
      this.washes[side] = { id, a: id === null ? 0 : 1, want: id };
    }
  }

  /** How many are still walking on during the opening. */
  private walkersOut(enemyWalksIn: boolean): number {
    let n = 0;
    for (const p of this.people) {
      const home = this.personAnchor(p.side, p.slot);
      if (Math.hypot(home.x - p.actor.x, home.y - p.actor.y) > ARRIVED) n += 1;
    }
    for (const f of this.fighters) {
      if (f.pawn || (f.side === 1 && !enemyWalksIn)) continue;
      const a = this.anchor(f.side, f.slot);
      if (Math.hypot(a.x - f.actor.x, a.y - f.actor.y) > ARRIVED) n += 1;
    }
    return n;
  }

  /** Puts everyone back on their mark, after a resize or a slot change. */
  private resnap(): void {
    for (const f of this.fighters) {
      // Anyone walking off has left their mark on purpose and does not want
      // putting back on it.
      if (f.leaving) continue;
      const a = this.anchor(f.side, f.slot);
      f.actor.x = a.x;
      f.actor.y = a.y;
    }
    for (const p of this.people) {
      const a = this.personAnchor(p.side, p.slot);
      p.actor.x = a.x;
      p.actor.y = a.y;
    }
  }

  // --- the step queue ---

  private push(step: Step): void {
    this.queue.push(step);
  }

  /** Resolves once every queued step has run. */
  private flush(): Promise<void> {
    if (this.instant) {
      // Run each step's ends in order and land on the final state.
      for (const s of this.queue) {
        s.start?.();
        s.run?.(1, 0);
        s.end?.();
      }
      this.queue = [];
      this.effects = [];
      this.snapWashes();
      return Promise.resolve();
    }
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.done = resolve;
    });
  }

  update(real: number): void {
    // Everything on the stage runs on this clock, so one number paces it all.
    const dt = real * STAGE_PACE;
    if (Math.abs(this.safeWant - this.safeBottom) > 0.05) {
      this.safeBottom += (this.safeWant - this.safeBottom) * Math.min(1, real * 9);
      // Every mark moved with it, so put back anyone who is meant to be on one.
      if (this.queue.length === 0) this.resnap();
    }
    for (const p of this.people) p.actor.step(dt, 0, 0, NO_MAP);
    this.stepRetreats(dt);
    for (const f of this.fighters) {
      if (f.leaving) continue;
      f.actor.step(dt, 0, 0, NO_MAP);
      f.shake *= Math.max(0, 1 - dt * 9);
      f.hurt = Math.max(0, f.hurt - dt * 8);
      // The readout arrives after its Scoba does, and leaves with it.
      const want = f.settled ? f.alpha : 0;
      f.plate += (want - f.plate) * Math.min(1, dt * 6);
      if (Math.abs(want - f.plate) < 0.01) f.plate = want;
    }
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter((e) => e.t < e.dur);
    this.stepWashes(dt);
    for (const v of this.shown.values()) {
      v.hpTrail = easeTrail(v.hpTrail, v.hp, dt);
      v.manaTrail = easeTrail(v.manaTrail, v.mana, dt);
    }

    const step = this.queue[0];
    if (!step) {
      if (this.done) {
        const d = this.done;
        this.done = null;
        d();
      }
      return;
    }
    if (!this.started) {
      this.started = true;
      step.start?.();
    }
    this.stepT += dt;
    const k = step.dur <= 0 ? 1 : Math.min(1, this.stepT / step.dur);
    step.run?.(k, dt);
    // A walk that is running late holds the queue rather than being cut off
    // and put on its mark, which is what used to read as a teleport.
    const waiting = k >= 1
      && step.hold?.() === true
      && this.stepT < (step.cap ?? step.dur + HOLD_CAP);
    if (k >= 1 && !waiting) {
      step.end?.();
      this.queue.shift();
      this.stepT = 0;
      this.started = false;
    }
  }

  // --- the opening ---

  /**
   * The characters walk out ahead of their Scobas, then fall back as the
   * Scobas take the field. A wild fight has no trainer to walk on, so its
   * Scoba is simply already there.
   */
  /**
   * Somebody arriving at a fight already in progress: they walk on from their
   * own side and take their place, and only then does their Scoba come out.
   * Everyone already here stays exactly where they are, because from their
   * point of view nothing is starting, somebody is just turning up.
   *
   * `withScoba` is for the arriving player's own screen, where the Scoba is
   * already in the state they were handed and so has no send-in of its own to
   * animate. On the other screen the join brings a switch-in with it, and that
   * plays the Scoba on by itself.
   */
  playArrival(who: SlotId, withScoba: boolean): Promise<void> {
    this.instant = (window as { __scobaFast?: boolean }).__scobaFast === true;
    const person = this.personFor(who);
    if (!person) return Promise.resolve();

    // Whoever is already fighting is settled where they belong, so the arrival
    // does not disturb them.
    this.push({
      dur: 0,
      start: () => {
        for (const p of this.people) {
          if (p === person) continue;
          const home = this.personAnchor(p.side, p.slot);
          p.actor.x = home.x;
          p.actor.y = home.y;
          p.actor.dir = p.side === 0 ? 1 : -1;
        }
        for (const f of this.fighters) {
          const a = this.anchor(f.side, f.slot);
          const arriving = withScoba && this.ownerOf(f) === who;
          if (arriving) {
            // Held off the edge until its owner is standing.
            f.alpha = 0;
            f.settled = false;
            f.actor.x = -16;
            f.actor.y = a.y;
          } else {
            f.actor.x = a.x;
            f.actor.y = a.y;
            f.alpha = 1;
            f.settled = true;
          }
          f.actor.dir = f.side === 0 ? 1 : -1;
        }
        // They come in along the line their Scoba will stand on, rather than
        // straight to the mark they keep, so the walk reads as joining in.
        const lane = this.anchor(0, person.slot === 0 ? 0 : 1);
        person.actor.x = -18;
        person.actor.y = lane.y;
        person.actor.dir = 1;
      },
    });

    const forward = (): { x: number; y: number } => {
      const home = this.personAnchor(person.side, person.slot);
      const lane = this.anchor(0, person.slot === 0 ? 0 : 1);
      return { x: home.x + this.view.w * 0.12, y: lane.y };
    };

    this.push({
      dur: 1.3,
      run: (_k, dt) => {
        const to = forward();
        person.actor.seek(dt, to.x, to.y, ARRIVED, NO_MAP, 1.5, WALK_ON);
      },
      hold: () => {
        const to = forward();
        return Math.hypot(to.x - person.actor.x, to.y - person.actor.y) > ARRIVED;
      },
    });

    this.push({ dur: 0.3 });

    // They drop back to their mark, and their Scoba takes the field.
    this.push({
      dur: 1.5,
      start: () => {
        if (!withScoba) return;
        for (const f of this.fighters) {
          if (this.ownerOf(f) !== who) continue;
          f.alpha = 1;
        }
      },
      run: (_k, dt) => {
        const home = this.personAnchor(person.side, person.slot);
        person.actor.seek(dt, home.x, home.y, ARRIVED, NO_MAP, 1.5, WALK_ON);
        if (!withScoba) return;
        for (const f of this.fighters) {
          if (this.ownerOf(f) !== who) continue;
          const a = this.anchor(f.side, f.slot);
          f.actor.seek(dt, a.x, a.y, ARRIVED, NO_MAP, 1.4, WALK_ON);
        }
      },
      hold: () => {
        const home = this.personAnchor(person.side, person.slot);
        return Math.hypot(home.x - person.actor.x, home.y - person.actor.y) > ARRIVED;
      },
      end: () => {
        this.resnap();
        person.actor.dir = 1;
        for (const f of this.fighters) {
          f.actor.dir = f.side === 0 ? 1 : -1;
          if (!f.pawn) f.settled = true;
        }
      },
    });

    return this.flush();
  }

  /** Which character a Scoba on the field belongs to, if any. */
  private ownerOf(f: Fighter): SlotId | null {
    if (f.side !== 0 || f.pawn) return null;
    const owner = this.st.teams[0][f.index]?.scoba.owner;
    return owner === "A" || owner === "B" ? owner : null;
  }

  /** The person for a character, adding them to the stage if they are new. */
  private personFor(who: SlotId): typeof this.people[number] | null {
    const found = this.people.find((p) => p.side === 0 && p.who === who);
    if (found) return found;
    const look = this.save.characters[who]?.look;
    if (!look) return null;
    const actor = new Actor(0, 0, { sprite: worldSprite(this.art.doll, look), motion: "hop" });
    actor.speed = CHAR_SPEED;
    actor.dir = 1;
    actor.desync(0.29);
    const slot = this.people.filter((p) => p.side === 0).length;
    const person = { actor, side: 0 as const, slot, ox: 0, oy: 0, who };
    this.people.push(person);
    return person;
  }

  playIntro(): Promise<void> {
    this.instant = (window as { __scobaFast?: boolean }).__scobaFast === true;
    this.opening = true;
    // A wild Scoba is the one you walked into, so it is already standing
    // there. A trainer's Scobas come out with their trainer, the same way
    // yours do.
    const enemyWalksIn = this.opts.trainer;

    const forwardMark = (p: { side: 0 | 1; slot: number }): number => {
      const home = this.personAnchor(p.side, p.slot).x;
      return p.side === 0 ? home + this.view.w * 0.15 : home - this.view.w * 0.15;
    };

    /**
     * A character walks on along the line its own Scoba stands on, and only
     * afterwards drops away to the mark it keeps for the fight. Arriving
     * already down there reads as two people standing about; walking down out
     * of the row reads as making way for the Scoba.
     *
     * The line is taken once, as the walk starts, rather than read fresh each
     * frame. The layout is still settling at that point, and a target that
     * drifts down while somebody is walking at it turns a walk straight in
     * from the edge into a diagonal.
     */
    const entryY = new Map<Actor, number>();
    const lineOf = (p: { actor: Actor; side: 0 | 1; slot: number }): number =>
      entryY.get(p.actor) ?? this.anchor(p.side, p.slot === 0 ? 0 : 1).y;

    this.push({
      dur: 0,
      start: () => {
        entryY.clear();
        this.people.forEach((p, i) => {
          // Everyone starts just off their own edge and walks straight on.
          entryY.set(p.actor, this.anchor(p.side, p.slot === 0 ? 0 : 1).y);
          p.actor.x = p.side === 0 ? -18 - i * 14 : this.view.w + 18;
          p.actor.y = lineOf(p);
        });
        for (const f of this.fighters) {
          const a = this.anchor(f.side, f.slot);
          f.actor.x = a.x;
          f.actor.y = a.y;
          // A Pawn called before the first round waits on its own mark until
          // the call plays: it was summoned, so it appears rather than walking.
          const walksOn = !f.pawn && (f.side === 0 || enemyWalksIn);
          f.alpha = f.pawn ? 0 : walksOn ? 0 : 1;
          f.settled = !f.pawn && !walksOn;
          f.plate = 0;
        }
      },
    });

    // Characters walk on and out to a forward mark.
    this.push({
      dur: 1.4,
      run: (_k, dt) => {
        for (const p of this.people) {
          p.actor.seek(dt, forwardMark(p), lineOf(p), ARRIVED, NO_MAP, 1.5, WALK_ON);
        }
      },
      hold: () => this.people.some(
        (p) => Math.hypot(forwardMark(p) - p.actor.x, lineOf(p) - p.actor.y) > ARRIVED,
      ),
    });

    this.push({ dur: 0.35 });

    // They fall back as the Scobas take the field.
    this.push({
      dur: 1.6,
      start: () => {
        for (const f of this.fighters) {
          if (f.pawn || (f.side === 1 && !enemyWalksIn)) continue;
          f.alpha = 1;
          const a = this.anchor(f.side, f.slot);
          f.actor.x = f.side === 0 ? -16 : this.view.w + 16;
          f.actor.y = a.y;
        }
      },
      run: (_k, dt) => {
        for (const p of this.people) {
          const home = this.personAnchor(p.side, p.slot);
          p.actor.seek(dt, home.x, home.y, ARRIVED, NO_MAP, 1.5, WALK_ON);
        }
        for (const f of this.fighters) {
          if (f.pawn || (f.side === 1 && !enemyWalksIn)) continue;
          const a = this.anchor(f.side, f.slot);
          f.actor.seek(dt, a.x, a.y, ARRIVED, NO_MAP, 1.4, WALK_ON);
        }
      },
      hold: () => this.walkersOut(enemyWalksIn) > 0,
      end: () => {
        // Everyone is within a whisker of their mark by now, so this settles
        // the last fraction of a pixel rather than moving anyone.
        this.resnap();
        // Everyone turns back to face the field: they arrived walking away
        // from it, and would otherwise stand there with their backs to it.
        for (const p of this.people) p.actor.dir = p.side === 0 ? 1 : -1;
        for (const f of this.fighters) {
          f.actor.dir = f.side === 0 ? 1 : -1;
          if (!f.pawn) f.settled = true;
        }
      },
    });
    this.push({ dur: 0, start: () => { this.opening = false; } });

    return this.flush();
  }

  // --- playing a resolved turn ---

  /**
   * Walks the turn's events, animating each and handing it back so the caller
   * can write the log line and refresh the readouts at the same moment.
   */
  play(events: BattleEvent[], onEach: (ev: BattleEvent) => void): Promise<void> {
    let caster: TargetRef | undefined;
    for (const ev of events) {
      if (ev.kind === "spell") caster = ev.at;
      this.queueEvent(ev, caster, onEach);
    }
    return this.flush();
  }

  private queueEvent(ev: BattleEvent, caster: TargetRef | undefined, onEach: (ev: BattleEvent) => void): void {
    const say = (dur: number, step: Omit<Step, "dur"> = {}): void => {
      // Spread the step rather than naming its fields: a `hold` left behind
      // here is a walk that gets cut off and put on its mark.
      this.push({
        ...step,
        dur,
        start: () => {
          onEach(ev);
          this.applyShown(ev);
          step.start?.();
        },
      });
    };

    switch (ev.kind) {
      case "spell": {
        const move = ev.moveId ? MOVES[ev.moveId] ?? null : null;
        const self = this.find(ev.at);
        if (!self) return say(0.2);
        const anim = animOf(move);
        say(castDuration(anim), {
          run: (k) => this.runCasterAnim(self, anim, k),
          end: () => {
            self.ox = 0;
            self.oy = 0;
            self.alpha = 1;
          },
        });
        return;
      }
      case "hit": {
        const target = this.find(ev.at);
        const from = this.find(ev.by ?? caster);
        const move = ev.moveId ? MOVES[ev.moveId] ?? null : null;
        const vfx = vfxOf(move);
        const color = move ? TYPE_COLORS[move.type] : "#f3f2c0";
        if (!target) return say(0.2);
        const travel = vfx === "bolt" ? 0.15 : vfx === "lob" ? 0.2 : 0;
        const land = 0.15;
        // Fired once, off its own flag rather than off the white flash: the
        // flash now outlives the step it belongs to, and two hits landing on
        // one Scoba in a round must each get their own impact.
        let struck = false;
        say(travel + land, {
          start: () => {
            const a = from ? this.posOf(from) : this.posOf(target);
            const b = this.posOf(target);
            if (travel > 0) this.effects.push({ kind: vfx, t: 0, dur: travel, from: a, to: b, color });
            else if (vfx === "beam") this.effects.push({ kind: "beam", t: 0, dur: 0.18, from: a, to: b, color });
          },
          run: (k) => {
            if (struck || k < travel / (travel + land)) return;
            struck = true;
            target.hurt = 1;
            target.shake = 2.2;
            const b = this.posOf(target);
            this.effects.push({ kind: "impact", t: 0, dur: 0.22, from: b, to: b, color });
          },
          end: () => {
            target.shake = 0;
          },
        });
        return;
      }
      case "status": {
        const target = this.find(ev.at);
        if (!target) return say(0.25);
        say(0.28, {
          start: () => {
            const b = this.posOf(target);
            this.effects.push({ kind: "flames", t: 0, dur: 0.45, from: b, to: b, color: "#e7a03c" });
          },
        });
        return;
      }
      case "heal": {
        const target = this.find(ev.at);
        say(0.35, {
          start: () => {
            if (!target) return;
            const b = this.posOf(target);
            this.effects.push({ kind: "glow", t: 0, dur: 0.45, from: b, to: b, color: "#7aa74a" });
          },
        });
        return;
      }
      case "faint": {
        const target = this.find(ev.at);
        say(0.5, {
          run: (k) => {
            if (!target) return;
            target.alpha = 1 - k;
            target.oy = k * 6;
          },
          end: () => this.sync(),
        });
        return;
      }
      case "switch": {
        let walking: Fighter | null = null;
        say(0.55, {
          start: () => {
            // Whoever is standing on that side before the swap is read in;
            // the one the swap displaces is the one that walks off.
            const at = ev.at;
            const standing = at ? this.fighters.filter((f) => f.side === at.side && !f.leaving) : [];
            this.sync();
            walking = this.find(ev.at);
            if (!walking) return;
            const going = standing.find((f) => f !== walking && f.slot === walking!.slot);
            if (going) this.sendOff(going);
            walking.settled = false;
            walking.plate = 0;
            const a = this.anchor(walking.side, walking.slot);
            walking.actor.x = walking.side === 0 ? -20 : this.view.w + 20;
            walking.actor.y = a.y;
          },
          run: (_k, dt) => {
            if (!walking) return;
            const a = this.anchor(walking.side, walking.slot);
            walking.actor.seek(dt, a.x, a.y, ARRIVED, NO_MAP, 1.6, WALK_ON);
          },
          hold: () => {
            if (!walking) return false;
            const a = this.anchor(walking.side, walking.slot);
            return Math.hypot(a.x - walking.actor.x, a.y - walking.actor.y) > ARRIVED;
          },
          end: () => {
            if (walking) {
              walking.settled = true;
              walking.actor.dir = walking.side === 0 ? 1 : -1;
            }
            // The walker is on its mark already; this is for anyone whose slot
            // the switch moved, and settles the last fraction of a pixel.
            this.resnap();
          },
        });
        return;
      }
      case "summon": {
        // The caller rattles, then a poof over the mark, then the Pawn is
        // standing in it. The two halves are one step so the puff lands on the
        // same frame the shake ends on.
        //
        // Both are looked up as the step runs rather than as it is queued: a
        // Pawn called this round does not exist on the stage until the `sync`
        // below puts it there, and a reference taken any earlier is null.
        const pawnRef = ev.at;
        const callerRef = ev.by;
        let puffed = false;
        say(SUMMON_TIME, {
          start: () => {
            sfx.summon();
            this.sync();
            const called = this.find(pawnRef);
            if (!called) return;
            called.alpha = 0;
            called.plate = 0;
            called.settled = false;
          },
          run: (k) => {
            const caller = this.find(callerRef);
            if (caller) caller.shake = k < SUMMON_CALL ? 3.2 : 0;
            const called = this.find(pawnRef);
            if (!called || k < SUMMON_CALL) return;
            if (!puffed) {
              puffed = true;
              const b = this.posOf(called);
              this.effects.push({ kind: "poof", t: 0, dur: 0.5, from: b, to: b, color: "#e8e6f2" });
            }
            called.alpha = Math.min(1, (k - SUMMON_CALL) / (1 - SUMMON_CALL));
          },
          end: () => {
            const caller = this.find(callerRef);
            if (caller) caller.shake = 0;
            const called = this.find(pawnRef);
            if (!called) return;
            called.alpha = 1;
            called.settled = true;
            called.actor.dir = called.side === 0 ? 1 : -1;
          },
        });
        return;
      }
      case "field": {
        const called = ev.field;
        if (!called) return say(0.3);
        // Nobody called a field that lifted of its own accord, so that one is
        // only the wash going back out.
        const callerRef = ev.by;
        if (!callerRef) {
          return say(0.5, {
            start: () => {
              for (const side of called.sides) this.setWash(side, called.id);
            },
          });
        }
        // The caller rattles first and the weather turns after it, so the two
        // read as one Scoba calling something up rather than as a wash that
        // happened to arrive.
        let laid = false;
        say(FIELD_TIME, {
          start: () => {
            laid = false;
          },
          run: (k) => {
            const caller = this.find(callerRef);
            if (caller) caller.shake = k < FIELD_CALL ? 3.2 : 0;
            if (laid || k < FIELD_CALL) return;
            laid = true;
            for (const side of called.sides) this.setWash(side, called.id);
          },
          end: () => {
            const caller = this.find(callerRef);
            if (caller) caller.shake = 0;
            for (const side of called.sides) this.setWash(side, called.id);
          },
        });
        return;
      }
      case "block": {
        const self = this.find(ev.at);
        say(0.3, {
          start: () => {
            if (!self) return;
            const b = this.posOf(self);
            this.effects.push({ kind: "glow", t: 0, dur: 0.35, from: b, to: b, color: "#7c9df0" });
          },
        });
        return;
      }
      case "win":
        say(0.6);
        return;
      default:
        say(0.28);
    }
  }

  /**
   * Moves the readouts on by one event. A hit's bar snaps to what it left the
   * subject on and the highlight behind it closes the gap over the next half
   * second; a faint only counts once its own line plays.
   */
  private applyShown(ev: BattleEvent): void {
    const ref = ev.at;
    if (!ref) return;
    const held = this.shown.get(BattleStage.key(ref.side, ref.index));
    if (!held) return;
    if (ev.hp !== undefined) {
      held.hp = ev.hp;
      if (this.instant) held.hpTrail = ev.hp;
    }
    if (ev.mana !== undefined) {
      held.mana = ev.mana;
      if (this.instant) held.manaTrail = ev.mana;
    }
    if (ev.kind === "faint") held.fainted = true;
  }

  /** The caster's own motion while its move goes off. */
  private runCasterAnim(self: Fighter, anim: CasterAnim, k: number): void {
    const facing = self.side === 0 ? 1 : -1;
    const reach = this.view.w * 0.12;
    switch (anim) {
      case "shake":
        self.shake = 2.2 * (1 - k);
        break;
      case "lunge": {
        // Out and back, so the step reads as a strike rather than a walk. It
        // covers half what the blink does, which is a move across the field.
        const p = k < 0.45 ? k / 0.45 : 1 - (k - 0.45) / 0.55;
        self.ox = facing * reach * 0.5 * p;
        break;
      }
      case "rear": {
        const p = k < 0.5 ? k / 0.5 : 1 - (k - 0.5) / 0.5;
        self.oy = -this.view.h * 0.06 * p;
        break;
      }
      case "blink": {
        // Gone, over the target, rattling, then gone and back.
        if (k < 0.2) self.alpha = 1 - k / 0.2;
        else if (k < 0.8) {
          self.alpha = 1;
          self.ox = facing * reach * 1.9;
          self.shake = 2.4;
        } else {
          self.alpha = (k - 0.8) / 0.2;
          self.ox = 0;
        }
        break;
      }
      case "focus":
      default:
        self.oy = -Math.sin(k * Math.PI) * this.view.h * 0.02;
        break;
    }
  }

  // --- aiming ---

  /** The targets a move will accept, and whichever one is under the cursor. */
  setAiming(aim: { options: TargetRef[]; hover: TargetRef | null } | null): void {
    this.aim = aim;
  }

  /** Who is being picked for, and who is standing by while that happens. */
  setTurn(turn: { acting: TargetRef | null; waiting: TargetRef[] }): void {
    this.turn = turn;
  }

  /** World units per CSS pixel, for turning a click into a place on the field. */
  private cssScale(): number {
    return window.innerWidth > 0 ? this.view.w / window.innerWidth : 1;
  }

  /** Where a fighter is standing, in CSS pixels from the top left. */
  screenPos(side: 0 | 1, index: number): { x: number; y: number } | null {
    const f = this.fighters.find((k) => k.side === side && k.index === index);
    if (!f) return null;
    const per = 1 / this.cssScale();
    const at = this.posOf(f);
    return { x: at.x * per, y: at.y * per };
  }

  /**
   * Where a slot's readout belongs, in CSS pixels: under whoever is standing
   * there, or under the empty mark when nobody is.
   */
  /**
   * How visible a slot's readout should be. It rides its Scoba, so it walks
   * on with it at the opening and fades out with it on a faint rather than
   * standing over an empty patch of ground.
   */
  /**
   * Whether the scene knows how big it is yet. Until the first draw the view
   * is a placeholder, so anything positioned against it would be laid out
   * somewhere wrong and then snap.
   */
  ready(): boolean {
    return this.drawn;
  }

  slotAlpha(side: 0 | 1, slot: number): number {
    const f = this.fighters.find((k) => k.side === side && k.slot === slot);
    if (f) return f.plate;
    return this.opening ? 0 : 1;
  }

  /**
   * The same, for a readout bound to one combatant. A Scoba that has just
   * gone down is off the field before the next render, so a slot lookup would
   * snap its readout back to full rather than letting it fade out with it.
   */
  fighterAlpha(side: 0 | 1, index: number): number {
    return this.fighters.find((k) => k.side === side && k.index === index)?.plate ?? 0;
  }

  /**
   * The team index standing on a slot as far as the scene is concerned, which
   * is not the same as the battle's: one the battle has already downed is
   * still out there until its faint has played.
   */
  fighterOn(side: 0 | 1, slot: number): number | null {
    return this.fighters.find((f) => f.side === side && f.slot === slot)?.index ?? null;
  }

  fighterScreenPos(side: 0 | 1, index: number): { x: number; y: number } | null {
    const f = this.fighters.find((k) => k.side === side && k.index === index);
    if (!f) return null;
    const per = 1 / this.cssScale();
    const at = this.restOf(f);
    return { x: at.x * per, y: at.y * per };
  }

  slotScreenPos(side: 0 | 1, slot: number): { x: number; y: number } {
    const per = 1 / this.cssScale();
    const f = this.fighters.find((k) => k.side === side && k.slot === slot);
    if (f) {
      const at = this.restOf(f);
      return { x: at.x * per, y: at.y * per };
    }
    const a = this.anchor(side, slot);
    return { x: a.x * per, y: a.y * per };
  }

  /**
   * The box a Scoba occupies, in world units, for clicks and for the ring. It
   * is that Scoba's own drawn pixels with a little slack round them, not one
   * size for everybody: a Pawn's box is a Pawn's size, so the ring fits it and
   * a tap beside it does not land on it.
   */
  private boxOf(f: Fighter): { x: number; y: number; w: number; h: number } {
    const at = this.posOf(f);
    const b = f.bounds;
    // The sprite is mirrored to face the other way, and its bounds with it.
    const left = f.actor.dir === -1 ? -(b.left + b.width) : b.left;
    // Down to the feet, plus anything the art hangs below them.
    const under = Math.max(0, b.height - b.top);
    return {
      x: at.x + left - TOUCH_PAD,
      y: at.y - f.head - TOUCH_PAD,
      w: b.width + TOUCH_PAD * 2,
      h: f.head + under + TOUCH_PAD * 2,
    };
  }

  /** Where a marker's point goes: just clear of the top of the head. */
  private markerY(f: Fighter, bob: number): number {
    return this.posOf(f).y - f.head - MARKER_GAP + bob;
  }

  /** Which fighter a click at this CSS point lands on, if any. */
  hitTest(cssX: number, cssY: number): TargetRef | null {
    const scale = this.cssScale();
    const x = cssX * scale;
    const y = cssY * scale;
    let best: { ref: TargetRef; d: number } | null = null;
    for (const f of this.fighters) {
      const b = this.boxOf(f);
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
      // Overlapping boxes go to whichever centre is nearer the click.
      const d = Math.hypot(x - (b.x + b.w / 2), y - (b.y + b.h / 2));
      if (!best || d < best.d) best = { ref: { side: f.side, index: f.index }, d };
    }
    return best?.ref ?? null;
  }

  private isTarget(f: Fighter): boolean {
    if (!this.aim) return false;
    return this.aim.options.some((o) => o.side === f.side && o.index === f.index);
  }

  /**
   * The weather, as a wash over the half of the view its side stands on. Over
   * the cast rather than under it, so a side under a field looks like it is
   * standing in that light instead of on a coloured floor, and under the turn
   * markers and the aiming ring, which have to stay readable whatever the
   * field is doing.
   */
  private drawWashes(ctx: CanvasRenderingContext2D): void {
    const { w, h } = this.view;
    const mid = Math.round(w / 2);
    for (const side of [0, 1] as const) {
      const wash = this.washes[side];
      const def = wash.id ? FIELDS[wash.id] : null;
      if (!def || wash.a <= 0.01) continue;
      ctx.save();
      ctx.globalCompositeOperation = "soft-light";
      const lit = ctx.globalCompositeOperation === "soft-light";
      ctx.globalAlpha = wash.a * (lit ? FIELD_WASH : FIELD_WASH_FLAT);
      ctx.fillStyle = def.tint;
      ctx.fillRect(side === 0 ? 0 : mid, 0, side === 0 ? mid : w - mid, h);
      ctx.restore();
    }
  }

  /**
   * A bobbing arrow over everything the move will accept, and a square
   * reticle around whichever one the cursor is over.
   */
  /**
   * The triangle over whoever the player is choosing for right now. It stands
   * down while a move is being aimed: the aim arrows want the same patch of air
   * over the same head, and which Scoba is picking is already said by the
   * prompt on the action row and by the other one being darkened.
   */
  private drawTurn(ctx: CanvasRenderingContext2D): void {
    if (this.aim) return;
    const f = this.find(this.turn.acting ?? undefined);
    if (!f || f.alpha <= 0.02) return;
    const t = performance.now() / 1000;
    turnMarker(ctx, this.posOf(f).x, this.markerY(f, Math.sin(t * 4) * MARKER_BOB));
  }

  private drawAiming(ctx: CanvasRenderingContext2D): void {
    if (!this.aim) return;
    const t = performance.now() / 1000;
    for (const f of this.fighters) {
      if (!this.isTarget(f)) continue;
      arrow(ctx, this.posOf(f).x, this.markerY(f, Math.sin(t * 5) * MARKER_BOB));
      const hover = this.aim.hover;
      if (hover && hover.side === f.side && hover.index === f.index) reticle(ctx, this.boxOf(f));
    }
  }

  /** Testing/debug snapshot: the marks, who is on them, and what is playing. */
  debugInfo(): object {
    return {
      view: { ...this.view },
      busy: this.queue.length,
      people: this.people.map((p) => ({
        side: p.side,
        x: Math.round(p.actor.x),
        y: Math.round(p.actor.y),
        dir: p.actor.dir,
        walking: p.actor.moving,
      })),
      fighters: this.fighters.map((f) => ({
        side: f.side,
        slot: f.slot,
        index: f.index,
        dir: f.actor.dir,
        x: Math.round(f.actor.x + f.ox),
        y: Math.round(f.actor.y + f.oy),
        alpha: Number(f.alpha.toFixed(2)),
        plate: Number(f.plate.toFixed(2)),
        settled: f.settled,
        shake: Number(f.shake.toFixed(2)),
        idleMix: f.actor.idleMix,
      })),
      effects: this.effects.map((e) => ({ kind: e.kind, t: Number(e.t.toFixed(2)) })),
      shown: [0, 1].flatMap((side) =>
        this.st.teams[side as 0 | 1].map((_c, i) => ({
          side, index: i, ...this.shownOf(side as 0 | 1, i),
        })),
      ),
      fields: this.washes.map((f) => ({ id: f.id, want: f.want, a: Number(f.a.toFixed(2)) })),
      aiming: this.aim ? { options: this.aim.options.length, hover: this.aim.hover } : null,
      turn: { acting: this.turn.acting, waiting: this.turn.waiting },
    };
  }

  // --- drawing ---

  draw(r: Renderer): void {
    const resized = this.view.w !== r.width || this.view.h !== r.height;
    this.view = { w: r.width, h: r.height };
    if (!this.drawn) {
      this.drawn = true;
      this.resnap();
    }
    // A rotation or a resize moves every mark, so put everyone back on theirs
    // rather than leaving them standing where the old layout had them.
    if (resized && this.queue.length === 0) this.resnap();
    const ctx = r.ctx;
    const { w, h } = this.view;

    // Ground in two bands rather than one, each with its own lip: the far one
    // the court stands on, the near one the Scobas and their people do. The
    // ranks and the bands are worked out from the same numbers, so a row can
    // never end up standing in the sky.
    const sky = Math.round(h * SKY_SHARE);
    const step = Math.round(this.rankY(RANK.step));
    ctx.fillStyle = "#2a3049";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#232941";
    ctx.fillRect(0, sky, w, h - sky);
    ctx.fillStyle = "#2f3450";
    ctx.fillRect(0, sky, w, 1);
    ctx.fillStyle = "#363d5e";
    ctx.fillRect(0, step, w, h - step);
    ctx.fillStyle = "#3f4767";
    ctx.fillRect(0, step, w, 1);

    const items: { baseY: number; draw: () => void }[] = [];
    for (const p of this.people) {
      items.push({ baseY: p.actor.depthY, draw: () => p.actor.draw(ctx, 0, 0) });
    }
    for (const f of this.fighters) {
      const at = this.posOf(f);
      const target = this.isTarget(f);
      const waiting = this.turn.waiting.some((r) => r.side === f.side && r.index === f.index);
      items.push({
        // The lagging depth, so a move that lifts or lunges a Scoba does not
        // shuffle it past whoever it is standing beside.
        baseY: f.actor.depthY,
        draw: () => {
          if (f.alpha <= 0.02) return;
          const jitter = f.shake > 0.05 ? (Math.random() - 0.5) * f.shake : 0;
          ctx.save();
          // Anything the move cannot reach fades back while it is being aimed.
          ctx.globalAlpha = Math.min(f.alpha, this.aim && !target ? 0.4 : 1);
          // Standing by while another Scoba is picked for: darkened rather
          // than faded, so it still reads as one standing on the field.
          if (waiting) ctx.filter = WAITING_TINT;
          // The animation offset is a draw-time shift, so the actor keeps
          // owning where it actually stands.
          ctx.translate(f.ox + jitter, f.oy);
          f.actor.draw(ctx, 0, 0);
          ctx.restore();
          if (f.hurt > 0) flash(ctx, at.x, at.y, f.hurt);
        },
      });
    }
    items.sort((a, b) => a.baseY - b.baseY);
    for (const it of items) it.draw();

    for (const e of this.effects) drawEffect(ctx, e);
    this.drawWashes(ctx);
    this.drawTurn(ctx);
    this.drawAiming(ctx);
    this.onFrame?.();
  }
}

/** Actors want a map to collide against; the stage has no walls. */
const NO_MAP = {
  moveCircle: (x: number, y: number, dx: number, dy: number) => ({ x: x + dx, y: y + dy }),
} as unknown as Parameters<Actor["step"]>[3];

/**
 * How long a caster's own motion takes. Every one of them is a jab: out and
 * back inside a quarter second or so, so a round reads as a flurry rather
 * than as each Scoba walking its attack over and walking it back.
 */
function castDuration(anim: CasterAnim): number {
  if (anim === "blink") return 0.28;
  if (anim === "lunge") return 0.22;
  if (anim === "rear") return 0.26;
  return 0.2;
}

/** A white wash over whatever was just struck. */
function flash(ctx: CanvasRenderingContext2D, x: number, y: number, k: number): void {
  ctx.save();
  ctx.globalAlpha = Math.min(0.5, k * 0.5);
  ctx.fillStyle = "#f3f2c0";
  ctx.fillRect(Math.round(x - 7), Math.round(y - 22), 14, 22);
  ctx.restore();
}

/**
 * Effects are drawn as square chunks rather than smooth arcs, so they stay in
 * the same pixel idiom as everything else on the canvas.
 */
function drawEffect(ctx: CanvasRenderingContext2D, e: Effect): void {
  const k = Math.min(1, e.t / e.dur);
  const u = 1 / ART;
  const chunk = (x: number, y: number, s: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round((x - s / 2) * ART) * u, Math.round((y - s / 2) * ART) * u, s, s);
  };
  const lift = 14;
  /**
   * How far a shot arcs over the straight line between its two ends. A shot
   * between two Scobas on the same rank stays flat; one that climbs the field,
   * which is every shot a Pawn takes from its corner, is thrown over the top.
   *
   * That is not a flourish. A readout is DOM and sits above the canvas whatever
   * the scene does, so a shot crossing the band a card hangs in disappears
   * behind it, and the straight line from a Pawn to the far side runs right
   * through the cards of everyone between them.
   */
  const climb = Math.min(ARC_MAX, Math.abs(e.from.y - e.to.y) * ARC_PER_RANK);
  const arcAt = (p: number): number => Math.sin(p * Math.PI) * climb;
  switch (e.kind) {
    case "bolt": {
      const x = e.from.x + (e.to.x - e.from.x) * k;
      const y = e.from.y - lift + (e.to.y - e.from.y) * k - arcAt(k);
      chunk(x, y, 3, "#171b2c");
      chunk(x, y, 2, e.color);
      // A short trail behind it.
      for (let i = 1; i <= 3; i++) {
        const b = Math.max(0, k - i * 0.06);
        chunk(
          e.from.x + (e.to.x - e.from.x) * b,
          e.from.y - lift + (e.to.y - e.from.y) * b - arcAt(b),
          2 - i * 0.4, e.color,
        );
      }
      break;
    }
    case "lob": {
      const x = e.from.x + (e.to.x - e.from.x) * k;
      const flat = e.from.y - lift + (e.to.y - e.from.y) * k;
      // A parabola that peaks halfway across.
      const y = flat - Math.sin(k * Math.PI) * 26 - arcAt(k);
      chunk(x, y, 4, "#171b2c");
      chunk(x, y, 3, e.color);
      break;
    }
    case "beam": {
      const a = 1 - k;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = "#171b2c";
      beamRects(ctx, e, 3);
      ctx.fillStyle = e.color;
      beamRects(ctx, e, 1.5);
      ctx.restore();
      break;
    }
    case "flames": {
      // Licks that rise and fade.
      for (let i = 0; i < 6; i++) {
        const off = ((i * 7919) % 13) / 13 - 0.5;
        const p = (k + i / 6) % 1;
        chunk(e.to.x + off * 12, e.to.y - 4 - p * 20, 3 * (1 - p), i % 2 ? e.color : "#d9553f");
      }
      break;
    }
    case "glow": {
      const rad = 6 + k * 12;
      const a = 1 - k;
      ctx.save();
      ctx.globalAlpha = a;
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        chunk(e.to.x + Math.cos(ang) * rad, e.to.y - 11 + Math.sin(ang) * rad * 0.7, 2.5, e.color);
      }
      ctx.restore();
      break;
    }
    case "poof": {
      // A ring of puffs that swells, drifts up and thins out, plus a couple of
      // heavier ones lower down, so the cloud has a bottom to it.
      const a = 1 - k * k;
      ctx.save();
      ctx.globalAlpha = a;
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2;
        const rad = 3 + k * 15;
        const s = 5 * (1 - k * 0.6) + 1;
        const x = e.to.x + Math.cos(ang) * rad;
        const y = e.to.y - 12 - k * 8 + Math.sin(ang) * rad * 0.6;
        chunk(x, y, s + 1, "#171b2c");
        chunk(x, y, s, i % 3 === 0 ? e.color : "#b6b3c9");
      }
      for (let i = 0; i < 3; i++) {
        const x = e.to.x + (i - 1) * 9;
        chunk(x, e.to.y - 2 - k * 4, 6 * (1 - k) + 1, "#b6b3c9");
      }
      ctx.restore();
      break;
    }
    case "burst":
    case "impact": {
      const rad = 2 + k * 16;
      const a = 1 - k;
      ctx.save();
      ctx.globalAlpha = a;
      for (let i = 0; i < 10; i++) {
        const ang = (i / 10) * Math.PI * 2;
        const s = 4 * (1 - k) + 1;
        chunk(e.to.x + Math.cos(ang) * rad, e.to.y - 11 + Math.sin(ang) * rad * 0.8, s + 1, "#171b2c");
        chunk(e.to.x + Math.cos(ang) * rad, e.to.y - 11 + Math.sin(ang) * rad * 0.8, s, e.color);
      }
      ctx.restore();
      break;
    }
  }
}

/**
 * A ring around whatever the cursor is over. One circle drawn with the same
 * three-pixel brush the art itself is outlined with, stepped along the art's
 * own pixel grid a row at a time rather than stroked, so no edge softens. It
 * takes its size from the Scoba it is drawn around, so a Pawn gets a small one.
 */
function reticle(ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }): void {
  const u = 1 / ART;
  const cx = Math.round((b.x + b.w / 2) * ART);
  const cy = Math.round((b.y + b.h / 2) * ART);
  const outer = Math.max(RETICLE_BRUSH, Math.round((Math.max(b.w, b.h) / 2) * ART));
  const inner = outer - RETICLE_BRUSH;
  /** Half the width of a circle of this radius at this row, or -1 outside it. */
  const half = (r: number, dy: number): number =>
    r <= 0 || Math.abs(dy) > r ? -1 : Math.floor(Math.sqrt(r * r - dy * dy));
  ctx.fillStyle = "#eae178";
  for (let dy = -outer; dy <= outer; dy++) {
    const out = half(outer, dy);
    if (out < 0) continue;
    const y = (cy + dy) * u;
    const cut = half(inner, dy);
    if (cut < 0) {
      // Past the top or bottom of the hole: the row is solid across.
      ctx.fillRect((cx - out) * u, y, (out * 2 + 1) * u, u);
      continue;
    }
    ctx.fillRect((cx - out) * u, y, (out - cut) * u, u);
    ctx.fillRect((cx + cut + 1) * u, y, (out - cut) * u, u);
  }
}

/**
 * How high a species' head rides over its mark while it stands there, in world
 * units: its constant float plus the top of the bob it keeps up at rest. A
 * marker measured against the highest the head goes never gets bobbed through.
 */
function idleLift(movement: keyof typeof MOTIONS, idleMix: number): number {
  const m = MOTIONS[movement];
  const ease = m.idle + (1 - m.idle) * idleMix;
  return (m.float + m.hop * ease) / ART;
}

/**
 * The little triangle that says which Scoba the player is picking for. It is
 * the blue the acting readout is outlined in, so the two read as one thing.
 * Both markers are drawn from their point, so putting one over a head is a
 * matter of naming where the point goes.
 */
function turnMarker(ctx: CanvasRenderingContext2D, cx: number, tipY: number): void {
  const x = Math.round(cx);
  const y = Math.round(tipY);
  ctx.fillStyle = "#171b2c";
  for (let i = 0; i < 6; i++) ctx.fillRect(x - 6 + i, y - 5 + i, 13 - i * 2, 1);
  ctx.fillStyle = "#7c9df0";
  for (let i = 0; i < 4; i++) ctx.fillRect(x - 4 + i, y - 4 + i, 9 - i * 2, 1);
}

/** A stubby downward arrow, built from rows so it stays hard-edged. */
function arrow(ctx: CanvasRenderingContext2D, cx: number, tipY: number): void {
  const x = Math.round(cx);
  const y = Math.round(tipY);
  ctx.fillStyle = "#171b2c";
  for (let i = 0; i < 5; i++) ctx.fillRect(x - 6 + i, y - 4 + i, 13 - i * 2, 1);
  ctx.fillRect(x - 3, y - 9, 7, 5);
  ctx.fillStyle = "#eae178";
  for (let i = 0; i < 4; i++) ctx.fillRect(x - 4 + i, y - 3 + i, 9 - i * 2, 1);
  ctx.fillRect(x - 2, y - 8, 5, 5);
}

function beamRects(ctx: CanvasRenderingContext2D, e: Effect, thick: number): void {
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const x = e.from.x + (e.to.x - e.from.x) * p;
    const y = e.from.y - 14 + (e.to.y - e.from.y) * p;
    ctx.fillRect(Math.round(x - thick / 2), Math.round(y - thick / 2), thick, thick);
  }
}
