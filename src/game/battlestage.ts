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
import { ART, frameRect, viewport } from "../engine/renderer";
import { DOLL_W } from "../engine/paperdoll";
import { sfx } from "../engine/sfx";
import { Actor, MOTIONS } from "./actors";
import { stagePace } from "./pace";
import {
  accessoryAnchor, centerAnchor, critterLook, critterBounds, lookOf, originAnchor, personSkin, pieceWorn,
  type CritterBounds, type FormTag,
  growthArt,
  growthMiddle,
  growthRoll,
  growthSpots,
  handPivot,
  paintedFor,
  type ScobaImage,
} from "./critters";
import {
  formsOf, fusionBars, fusionHalves, statusSummary,
  type BattleEvent, type BattleState, type Combatant, type StatusMark, type VisualStep,
} from "../sim/battle";
import { ACE_EXTRA, BLACKJACK, CARD_BACK, CARD_HIGH, cardOfValue, type CardFace } from "../sim/cards";
import { CREAM, hexToRgb, paletteSwap } from "../engine/recolor";
import {
  MOVES, SPECIES,
  type CasterAnim, type Move, type MoveVfx, type Species,
} from "../sim/species";
import { FIELDS, STATUSES, type ShowPath } from "../sim/status";
import type { Tint } from "../sim/scoba";
import { rngFrom } from "../sim/rng";
import { TYPE_COLORS } from "../sim/types";
import {
  ALL_SLOTS, PAWN_SLOTS, SCOBA_SLOTS, isFusionSlot, isPawnSlot, isTravelSlot, sameRef, type TargetRef,
} from "../sim/targeting";
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
  /**
   * Which body this is, which never changes while it stands there. A rewind
   * renumbers the whole team at once, so the index is only where it sits today
   * and is no use for telling one body from another across one.
   */
  key: string;
  /**
   * Which Scoba it was last drawn as, costume and all. A Scoba that spends its
   * cherry or goes Hyper keeps its actor and is re-skinned in place, and a
   * rewind can put a different Scoba on the same mark, so both have to be
   * compared against something.
   */
  worn: string;
  /** Offset from the anchor, which is what the move animations drive. */
  ox: number;
  oy: number;
  /** 0 hidden, 1 fully drawn. Blinking and fainting ride this. */
  alpha: number;
  /** Extra rattle, in world units. */
  shake: number;
  hurt: number;
  /** A green wash over whatever was just healed, fading as it goes. */
  heal: number;
  /** A cream wash, for a Scoba changing into something else. */
  flare: number;
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
  /**
   * The hand it is holding: every card dealt onto it, oldest first, as each was
   * thrown, and what the cards add up to. Drawn over its head and kept between
   * turns, because the hand is against the Scoba until it pays out.
   */
  hand: { faces: CardFace[]; count: number } | null;
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
/** How a reconcile treats bodies the board and the scene disagree about. */
interface SyncOpts {
  /**
   * Rebuild from the board alone, dropping every body it does not name. For a
   * rewind, where what is on screen belongs to a round that no longer happened.
   */
  fresh?: boolean;
  /** The one body the event now playing is bringing in, which starts hidden. */
  arriving?: TargetRef;
  /** Reconcile who is already on the field without introducing anyone new. */
  hold?: boolean;
}

/** One of a fusion's HP bars and the mana bar of the same half, as a readout shows them. */
export interface ShownBar {
  hp: number;
  hpTrail: number;
  max: number;
  mana: number;
  manaTrail: number;
}

/** A fusion's bars as the battle holds them, or undefined for anyone else. */
function liveBars(st: BattleState, c: Combatant): { hp: number; max: number; mana: number }[] | undefined {
  const bars = fusionBars(c);
  if (!bars) return undefined;
  const halves = fusionHalves(st, c);
  return bars.map((b, i) => ({ ...b, mana: halves[i]?.mana ?? 0 }));
}

/** Bars read straight off the battle, with nothing left to trail. */
function barsAt(live: { hp: number; max: number; mana: number }[]): ShownBar[] {
  return live.map((b) => ({ hp: b.hp, hpTrail: b.hp, max: b.max, mana: b.mana, manaTrail: b.mana }));
}

interface Shown {
  hp: number;
  hpTrail: number;
  mana: number;
  manaTrail: number;
  /** A fusion's two bars, first slot's first. Nobody else has any. */
  bars?: ShownBar[];
  fainted: boolean;
  /**
   * The marks the readout is showing. Snapshotted like the numbers are,
   * because the battle resolves a whole round before any of it is played: read
   * off the combatant and every sigil the round left would be on the card
   * before the move that left it had been drawn.
   */
  marks: StatusMark[];
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
  kind: MoveVfx | "impact" | "poof" | "wheel" | "clock" | "ghost" | "machine";
  t: number;
  dur: number;
  from: Anchor;
  to: Anchor;
  color: string;
  /** Turns it makes on the way across, signed. Only a `toss` takes one. */
  spin?: number;
  /**
   * Drawn art for the move behind it, cropped to what was drawn. Where there
   * is any it is thrown and burst in place of the blocks, along the same path,
   * so a move with art and one without travel and land the same way.
   */
  sprite?: HTMLCanvasElement | HTMLImageElement;
  /**
   * Hands drawn over the sprite: held still against a wheel, and turned on a
   * clock, each one faster than the one before it.
   */
  pins?: (HTMLCanvasElement | HTMLImageElement)[];
}

/**
 * What a mark is currently drawn as: which Scoba is standing there and what it
 * is wearing. A mark is held by side and index, and a rewind or a Scoba leaving
 * the team shuffles the team array under those indexes, so two different Scobas
 * can hold one mark across a round. Keying only on the costume left the old
 * body standing there wearing the new one's name.
 */
function drawnAs(c: Combatant): string {
  const sp = SPECIES[c.scoba.speciesId];
  const piece = sp ? pieceWorn(sp, carriedBy(c), formsOf(c)) : null;
  return [bodyKey(c), ...formsOf(c), ...(piece ? [`piece:${piece}`] : [])].join("+");
}

/** The ids of every status a combatant carries, which is what decides the piece it wears. */
function carriedBy(c: Combatant): string[] {
  return c.statuses.map((s) => s.id);
}

/**
 * Which body a combatant is. Its Scoba, and whether this is the one standing in
 * a time it does not belong to: a traveller is a copy of the Scoba it came
 * from, down to the same uid, and the two of them stand on the field together.
 */
function bodyKey(c: Combatant): string {
  return `${c.scoba.uid}${c.aside === true ? ":aside" : ""}`;
}

/** One thing drawn into the scene, sorted by how near the viewer it stands. */
interface Item {
  baseY: number;
  /** The one that travelled, which keeps its own color while the past is washed. */
  now?: boolean;
  /** Drawn on the near canvas, over the readouts, rather than under them. */
  over?: boolean;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

/**
 * A caster's movement, running beside the queue rather than as a step in it.
 *
 * A step holds the queue until it is done, so an animation written as one puts
 * everything it sets off after itself: the Scoba finished its throw and only
 * then did anything leave its hand. Run here instead and the throw, what it
 * threw and what that lands on all happen together.
 */
interface Motion {
  f: Fighter;
  anim: CasterAnim;
  t: number;
  dur: number;
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
 * How long the whole stage stops for on the frame a blow lands, in real
 * seconds. It is taken off the real clock rather than the paced one, so a
 * player who has turned the battle speed up still gets the same beat.
 */
const HIT_STOP = 0.07;

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
  /**
   * The two characters, between the back Scoba rank and the court. They are up
   * off the floor rather than down on it because the Pawn cards hang below the
   * court and reach back across the corner the pair stand in, and they can go
   * no higher because the back Scoba's own readout hangs into that corner from
   * above on a narrow view.
   */
  castBack: 0.77,
  castFront: 0.83,
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

/** How far out a traveller stands, at the inner end of the row the court fills. */
const TRAVEL_ACROSS = 0.1;

/**
 * How far in from its own edge a side's first person stands, in world units.
 * Half a doll and a little air, so nobody is drawn off the side of the view.
 */
const EDGE = DOLL_W / (2 * ART) + 3;
/**
 * How far out from the first character the second one stands, in world units.
 * Enough that the pair read as two people, and no more: the corner they share
 * is narrow, with the back Scoba's readout hanging into it from above and the
 * Pawn cards reaching back into it from below.
 */
const CAST_STAGGER = 20;
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
 * How far below the band's foot the court stands, in world units. Its cards
 * hang under it, so with the card and its gap this has to fit inside the
 * plate room the action bar leaves (a Scoba's readout is taller than that).
 */
const PAWN_SINK = 15;

/**
 * Slack around a Scoba's drawn pixels, in world units: air under the ring and
 * room for a thumb that lands beside a small one rather than on it.
 */
const TOUCH_PAD = 3;
/** How far over a head a marker floats, and how far it bobs. */
const MARKER_GAP = 2;
const MARKER_BOB = 1.5;
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
 * How long a fusion takes to form, and how far into it the two halves meet in
 * the middle, at their palest, and become one.
 */
const FUSE_TIME = 1.2;
const FUSE_MEET = 0.55;
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
/** How everything standing in a time it does not belong to is drawn. */
/** How much of its color a body standing in another time keeps. */
const PAST_KEEP = 0.45;
/** The warmth laid over it, and how much of it. */
const PAST_WARM = "#b98a52";
const PAST_WARM_A = 0.22;

/**
 * The levels a sprite or a readout is ever drawn at. Fractional opacity is the
 * one soft edge a scene that never antialiases can still let in, so the eased
 * value is kept for timing and only what reaches the screen is stepped.
 */
const ALPHA_LEVELS = [0, 0.33, 0.67, 1];

/** Puts a continuous alpha on the nearest level. */
function stepAlpha(a: number): number {
  const i = Math.round(Math.max(0, Math.min(1, a)) * (ALPHA_LEVELS.length - 1));
  return ALPHA_LEVELS[i] ?? 1;
}

/**
 * The scene's ground. Each band has its own lip along the top of it and its own
 * darker tone, which is what the mark under a pair of feet is drawn in.
 */
const GROUND = {
  sky: "#f0e8d8",
  far: "#e1dacb",
  farLip: "#eae2d2",
  near: "#dbd3c5",
  nearLip: "#e3dccd",
};

/** How far apart the dither pixels along the horizon stand, in world units. */
const HORIZON_STEP = 3;

export class BattleStage {
  private fighters: Fighter[] = [];
  /** The two characters, and the enemy trainer when there is one. */
  private people: {
    actor: Actor; side: 0 | 1; slot: number; ox: number; oy: number;
    /** Which character this is, so somebody arriving can be found or added. */
    who?: SlotId;
  }[] = [];
  private effects: Effect[] = [];

  /** A wash over the whole screen, fading as it goes. */
  private flash: { color: string; t: number; dur: number } | null = null;

  /**
   * Whether the scene is standing in a time it does not belong to. Read off
   * playback rather than off the battle, because the battle is already in the
   * past from the first frame of the round that travels there.
   */
  private inPast = false;

  /** The mark a traveller is standing on, which is the one thing the past does not wash. */
  private visitor: TargetRef | null = null;
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
  /**
   * The fusions the scene has shown forming, by body. The battle resolves a
   * whole round before any of it plays, so a fusion is on the board from the
   * start of the round it formed in, and until its own fuse plays the scene
   * keeps drawing the two it is made of.
   */
  private fusions = new Set<string>();
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

  /**
   * A second canvas over the readouts, for the row standing nearer the viewer
   * than the rank they hang from. A readout is a page element and the scene is
   * one canvas, so everything drawn on that canvas is behind every readout,
   * whatever is standing where. Splitting the cast across two canvases with the
   * readouts between them is what puts the near row back in front of them.
   */
  frontCanvas: HTMLCanvasElement | null = null;

  private frontCtx: CanvasRenderingContext2D | null = null;

  /** Whether the last frame put anything on the near canvas, so it needs clearing. */
  private frontLit = false;

  /**
   * The near canvas, sized and cleared for this frame, or null where there is
   * none and everything has to go on the one canvas.
   */
  private frontContext(r: Renderer): CanvasRenderingContext2D | null {
    const node = this.frontCanvas;
    if (!node) {
      this.frontCtx = null;
      return null;
    }
    const w = r.bufferW * r.scale;
    const h = r.bufferH * r.scale;
    if (node.width !== w || node.height !== h) {
      node.width = w;
      node.height = h;
      this.frontCtx = null;
    }
    if (!this.frontCtx) {
      const got = node.getContext("2d");
      if (!got) return null;
      this.frontCtx = got;
    }
    const c = this.frontCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    // The same whole number of device pixels per drawn pixel the blitted
    // buffer lands at, so both canvases share one brush.
    c.setTransform(ART * r.scale, 0, 0, ART * r.scale, 0, 0);
    c.imageSmoothingEnabled = false;
    return c;
  }

  /**
   * The wash over the whole screen this frame, for the layers that sit over
   * the canvas. A flash covers the fight, readouts and all, rather than
   * washing over the field and leaving the cards hanging in front of it.
   */
  flashNow(): { color: string; alpha: number } | null {
    if (!this.flash) return null;
    const k = Math.min(1, this.flash.t / this.flash.dur);
    return { color: this.flash.color, alpha: k < FLASH_HOLD ? 1 : 1 - (k - FLASH_HOLD) / (1 - FLASH_HOLD) };
  }
  /**
   * Called when the set of fighters or the marks they stand on changed, so the
   * readouts can be rebuilt. A Scoba switched in mid-round and a replacement
   * sent on between rounds both arrive long after the page was drawn, and the
   * plates are built from whoever the stage has at the moment they are built.
   */
  onRoster: (() => void) | null = null;
  /** Skips every duration, for tests and for the fast-forward hook. */
  instant = false;
  /** Real seconds the stage is frozen for, so a landed blow reads. */
  private hold = 0;
  /** Caster movements in flight, stepped alongside the queue. */
  private motions: Motion[] = [];
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
    // A fight handed over part way through can already have a fusion in it.
    this.noteFusions();
    this.sync();
  }

  /** Counts every fusion on the board as shown. */
  private noteFusions(): void {
    for (const team of this.st.teams) {
      for (const c of team) if (c.fusion) this.fusions.add(bodyKey(c));
    }
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
    const step = Math.max(PAWN_STEP, world + PAWN_GAP);
    const edge = Math.max(EDGE, world / 2 + PAWN_GAP);
    const changed = step !== this.pawnStep || edge !== this.pawnEdge;
    this.pawnStep = step;
    this.pawnEdge = edge;
    // A court that arrives before any card exists to measure stands at the
    // fallback step, so the row goes back on its marks once one has been.
    if (changed && this.queue.length === 0) this.resnap();
  }

  setSafeBottom(px: number): void {
    // A reading before the first draw is against the placeholder view, and the
    // opening places a wild Scoba once from whatever reading it starts with.
    if (!this.drawn) return;
    // Up to six tenths of the view: the block takes four, and the readouts
    // hanging under the front rank need the rest to clear it.
    this.safeWant = Math.min(this.view.h * 0.6, Math.max(0, px) * this.cssScale());
    // The first reading is the layout, not a change to it.
    if (this.safeBottom === 0) {
      this.safeBottom = this.safeWant;
      // A step that has not started yet places everyone itself.
      if (!this.started) this.resnap();
    }
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
      // The first Pawn slot is the one nearest the Scobas, and the row runs
      // out from there to the edge: a court fills in from its own side's
      // Scobas, and closes ranks toward them when one falls.
      const i = PAWN_SLOTS - 1 - (slot - SCOBA_SLOTS);
      const along = this.pawnEdge + i * this.pawnStep;
      // Below the band, in the room kept for the readouts: the court stands
      // at the foot of the field with its cards straight under it, clear of
      // the readouts hanging from the ranks above.
      const b = this.band();
      return {
        x: side === 0 ? along : this.view.w - along,
        y: b.top + b.height + PAWN_SINK,
      };
    }
    // A traveller stands at the foot of the field, on the inner end of it.
    // Down there its readout hangs below the pair's rather than across them,
    // and it is plainly not one of the two it came back to.
    if (isTravelSlot(slot)) {
      const b = this.band();
      return { x: mid + out * TRAVEL_ACROSS, y: b.top + b.height + PAWN_SINK };
    }
    // A fusion stands between the two marks it was made from.
    if (isFusionSlot(slot)) {
      const front = this.anchor(side, 0);
      const back = this.anchor(side, 1);
      return { x: (front.x + back.x) / 2, y: (front.y + back.y) / 2 };
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
      x: base + (slot === 0 ? CAST_STAGGER : 0),
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
      const actor = new Actor(0, 0, personSkin(this.art, look));
      actor.speed = CHAR_SPEED;
      actor.dir = 1;
      actor.desync(i * 0.41 + 0.13);
      this.people.push({ actor, side: 0, slot: i, ox: 0, oy: 0, who: slot });
    });
    if (this.opts.trainer) {
      const other: SlotId = local === "A" ? "B" : "A";
      // No art of their own yet: the trainer borrows the other character doll,
      // which at least reads as a person standing opposite.
      const actor = new Actor(0, 0, personSkin(this.art, this.save.characters[other].look));
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
  /**
   * Puts a fighter into the costume it is currently in, where that has changed
   * since it was last drawn. The actor is kept rather than replaced, so
   * whatever it is in the middle of carries on.
   */
  /**
   * Puts a body into the costume its Scoba is currently in.
   *
   * A mark that now holds a different Scoba is not a costume change. The battle
   * resolves a whole round before any of it is played, so mid-playback the
   * board can already be somewhere the scene has not reached: a rewind swaps
   * the team array under every mark at once. Swapping the body there and then
   * would show the new one before the move that brought it has played, so that
   * is left to `sync`, which runs off the event that says the board changed.
   */
  private reskin(f: Fighter, arriving = false): void {
    const c = this.st.teams[f.side][f.index];
    const sp = c ? SPECIES[c.scoba.speciesId] : undefined;
    if (!c || !sp) return;
    const forms = formsOf(c);
    const worn = drawnAs(c);
    if (f.worn === worn) return;
    if (!arriving && f.worn.split("+")[0] !== c.scoba.uid) return;
    f.actor.skin = critterLook(this.art, sp, c.scoba, forms, carriedBy(c));
    f.bounds = critterBounds(this.art, sp, lookOf(sp, c.scoba, forms, carriedBy(c)));
    f.head = f.bounds.top + idleLift(sp.movement, f.actor.idleMix);
    f.worn = worn;
  }

  /** Everyone on the field, for a change that is not a walk-on or a faint. */
  private reskinAll(): void {
    for (const f of this.fighters) this.reskin(f);
  }

  /**
   * Reconciles the bodies on the field with the board.
   *
   * `arriving` is the one body the event now playing is about to bring in, and
   * it is the only one that starts hidden. Anything else already standing on
   * the board is drawn standing there: a body that starts hidden and has
   * nothing coming to reveal it is invisible for the rest of the fight, which
   * is what happened to a Pawn the board already held when a rewind rebuilt
   * the scene around it.
   */
  sync({ fresh = false, arriving, hold = false }: SyncOpts = {}): void {
    const before = this.rosterKey();
    // A rewind lands on a board the scene has never shown, fusions and all.
    if (fresh) this.noteFusions();
    const wanted: Fighter[] = [];
    /** Bodies already claimed by a mark this pass, so none serves two. */
    const taken = new Set<Fighter>();
    for (const side of [0, 1] as const) {
      for (const slot of ALL_SLOTS) {
        const index = this.st.active[side][slot] ?? -1;
        if (index < 0) continue;
        const c = this.st.teams[side][index];
        if (!c) continue;
        // Once its fusion has been shown forming, a half is inside it. Until
        // then it is still standing on its own mark as far as the player knows.
        if (c.fusedInto !== undefined && !c.fainted) {
          const body = this.st.teams[side][c.fusedInto];
          if (body && this.fusions.has(bodyKey(body))) continue;
        }
        if (c.fusion && !this.fusions.has(bodyKey(c))) continue;
        // A Scoba the battle has already downed stays on the field until its
        // own faint animation has played.
        if (this.shownOf(side, index).fainted) continue;
        const sp = SPECIES[c.scoba.speciesId];
        if (!sp) continue;
        const forms = formsOf(c);
        const worn = drawnAs(c);
        // Matched on which body it is rather than on where it sits. A rewind
        // renumbers the team under every mark at once, and matching on the
        // number put one Scoba's body on another's mark. The mark it is already
        // on wins, so nothing shuffles while the roster only grows.
        const key = bodyKey(c);
        const mine = (f: Fighter): boolean => !taken.has(f) && f.side === side && f.key === key;
        const kept = this.fighters.find((f) => mine(f) && f.slot === slot)
          ?? this.fighters.find(mine);
        if (kept) {
          taken.add(kept);
          kept.index = index;
          kept.slot = slot;
          // Changed costume since it was last drawn: re-skin it where it
          // stands rather than replacing the actor, so nothing it is in the
          // middle of is interrupted. This is the one place a mark is allowed
          // to change hands, since it is what reconciles the scene with the
          // board.
          this.reskin(kept, true);
          wanted.push(kept);
          continue;
        }
        // Nobody new: the battle resolves a whole round before the scene plays
        // any of it, so a mark whose replacement has already been sent on is a
        // mark whose replacement has not been announced yet. Putting it on the
        // field here had it appear standing there and then walk on again.
        if (hold) continue;
        const pawn = isPawnSlot(slot);
        // Neither one walks on: a Pawn is called and a traveller is set down,
        // so whichever of them this event is bringing in starts hidden and
        // that event reveals it.
        const brought = arriving !== undefined && sameRef({ side, index }, arriving);
        const at = this.anchor(side, slot);
        const actor = new Actor(at.x, at.y, critterLook(this.art, sp, c.scoba, forms, carriedBy(c)));
        actor.dir = side === 0 ? 1 : -1;
        actor.speed = ENTER_SPEED;
        actor.radius = 3;
        // Standing ready: hopping species keep bouncing, hovering ones are
        // already at full float and are left alone.
        actor.idleMix = 0.45;
        const bounds = critterBounds(this.art, sp, lookOf(sp, c.scoba, forms, carriedBy(c)));
        // Deterministic per slot, so the bob is out of step with the others
        // but lands the same way on both clients.
        actor.desync(((side * 2 + slot) * 0.37 + index * 0.19) % 1);
        wanted.push({
          actor, side, slot, index, key: bodyKey(c), pawn, worn, ox: 0, oy: 0,
          bounds, head: bounds.top + idleLift(sp.movement, actor.idleMix),
          alpha: brought ? 0 : 1, shake: 0, hurt: 0, heal: 0, flare: 0,
          settled: !brought, plate: brought ? 0 : 1, leaving: null,
          // A hand already dealt is read back off the battle, so one standing
          // on a Scoba that walks off and back on is still over its head.
          hand: handOf(c),
        });
        continue;
      }
    }
    // Anyone on the way out is carried over until they have finished fading,
    // readout and all, rather than being cut the moment their slot clears. A
    // board that was wound back keeps none of them: they were fading out of a
    // round that no longer happened, and they would stand over whoever the
    // other time has on their mark.
    for (const f of this.fighters) {
      if (wanted.includes(f)) continue;
      if (fresh || (f.alpha <= 0.02 && f.plate <= 0.01)) continue;
      // Only a body actually walking off loses its readout here. One that is
      // merely waiting for its own faint to play keeps it: the battle downs a
      // Scoba as the round resolves, and the scene has not shown that yet, so
      // unsettling it took the plaque off a Scoba still standing there whole.
      if (f.leaving) f.settled = false;
      wanted.push(f);
    }
    this.fighters = wanted;
    if (this.rosterKey() !== before) this.onRoster?.();
  }

  /** Sets the filter a draw runs under, for the one case that wants its own. */
  private wash(ctx: CanvasRenderingContext2D, extra = ""): void {
    ctx.filter = extra === "" ? "none" : extra;
  }

  /**
   * Warms a canvas into the colors of another time. Drawn over what is already
   * there and nowhere else, so a canvas that is mostly empty stays that way.
   *
   * Neither this nor the draining that goes with it uses a canvas filter. A
   * filter costs a compositing pass of its own, and filtering a whole canvas
   * against itself makes the browser take a copy of the surface first: two of
   * those a frame, one per canvas, halved the frame rate for as long as the
   * past was on screen.
   */
  private tintPast(ctx: CanvasRenderingContext2D): void {
    if (!this.inPast) return;
    const { w, h } = this.view;
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = PAST_WARM_A;
    ctx.fillStyle = PAST_WARM;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /**
   * Takes the color out of a canvas that is opaque all over, which is the one
   * the ground is on. A blend against flat grey is exactly what `saturate()`
   * would do and costs a fill rather than a pass.
   */
  private drainPast(ctx: CanvasRenderingContext2D): void {
    if (!this.inPast) return;
    const { w, h } = this.view;
    ctx.save();
    ctx.globalCompositeOperation = "saturation";
    ctx.globalAlpha = 1 - PAST_KEEP;
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /**
   * What the past leaves a body drawn on a canvas that is not opaque. The one
   * that travelled there keeps its own colours: it belongs to the round the
   * player is in, and it is the only thing on the field that does.
   */
  private pastFilter(now: boolean): string {
    return this.inPast && !now ? `saturate(${PAST_KEEP})` : "";
  }

  /** Who is on the field and which mark each stands on, as one string. */
  private rosterKey(): string {
    return this.fighters.map((f) => `${f.side}.${f.index}.${f.slot}`).join(",");
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
        const live = liveBars(this.st, c);
        if (held) {
          held.mana = c.mana;
          held.fainted = c.fainted;
          // Mana moves between rounds and HP does not, the same as for anyone.
          if (live) {
            held.bars = live.map((b, i) => {
              const was = held.bars?.[i];
              return was ? { ...was, mana: b.mana } : barsAt([b])[0]!;
            });
          }
          return;
        }
        this.shown.set(k, {
          hp: c.hp, hpTrail: c.hp, mana: c.mana, manaTrail: c.mana,
          ...(live ? { bars: barsAt(live) } : {}),
          fainted: c.fainted, marks: statusSummary(c),
        });
      });
    }
  }

  /** What the readout for a combatant should say this frame. */
  shownOf(side: 0 | 1, index: number): {
    hp: number; hpTrail: number; mana: number; manaTrail: number;
    bars?: ShownBar[];
    fainted: boolean; marks: StatusMark[];
  } {
    const held = this.shown.get(BattleStage.key(side, index));
    const c = this.st.teams[side][index];
    if (!held) {
      const hp = c?.hp ?? 0;
      const mana = c?.mana ?? 0;
      const live = c ? liveBars(this.st, c) : undefined;
      return {
        hp, hpTrail: hp, mana, manaTrail: mana,
        ...(live ? { bars: barsAt(live) } : {}),
        fainted: c?.fainted ?? false, marks: c ? statusSummary(c) : [],
      };
    }
    return {
      hp: Math.max(0, Math.round(held.hp)),
      hpTrail: Math.max(0, held.hpTrail),
      mana: held.mana,
      manaTrail: Math.max(0, held.manaTrail),
      ...(held.bars ? {
        bars: held.bars.map((b) => ({
          ...b, hp: Math.max(0, Math.round(b.hp)), hpTrail: Math.max(0, b.hpTrail), manaTrail: Math.max(0, b.manaTrail),
        })),
      } : {}),
      fainted: held.fainted,
      marks: held.marks,
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
        const live = liveBars(this.st, c);
        this.shown.set(k, {
          hp: c.hp,
          hpTrail: this.instant ? c.hp : held?.hpTrail ?? c.hp,
          mana: c.mana,
          manaTrail: this.instant ? c.mana : held?.manaTrail ?? c.mana,
          ...(live ? {
            bars: live.map((b, i) => ({
              hp: b.hp,
              hpTrail: this.instant ? b.hp : held?.bars?.[i]?.hpTrail ?? b.hp,
              max: b.max,
              mana: b.mana,
              manaTrail: this.instant ? b.mana : held?.bars?.[i]?.manaTrail ?? b.mana,
            })),
          } : {}),
          fainted: c.fainted,
          marks: statusSummary(c),
        });
      });
    }
    for (const side of [0, 1] as const) this.setWash(side, this.st.fields[side]?.id ?? null);
    // Every fuse this round has played by now, so any fusion on the board is one
    // the scene has shown.
    this.noteFusions();
    // The round has played out, so the scene and the battle agree again about
    // which time everyone is standing in.
    this.inPast = !!this.st.travelling;
    this.visitor = this.st.travelling?.visitor ?? null;
    this.sync();
  }

  /**
   * Reads every readout off the board as it now stands, with no trail left to
   * run down. A rewind replaces the whole battle at once, so the numbers belong
   * to another turn: easing to them would slide each bar from a value that
   * never became this one, after the flash the change happened behind.
   */
  restate(): void {
    this.shown.clear();
    for (const side of [0, 1] as const) {
      this.st.teams[side].forEach((c, index) => {
        const live = liveBars(this.st, c);
        this.shown.set(BattleStage.key(side, index), {
          hp: c.hp, hpTrail: c.hp, mana: c.mana, manaTrail: c.mana,
          ...(live ? { bars: barsAt(live) } : {}),
          fainted: c.fainted, marks: statusSummary(c),
        });
      });
    }
  }

  /**
   * Whether a place on the board still holds the Scoba an event named. An
   * event carries a place, and a rewind in the same round can give that place
   * to somebody else before the scene gets to play it.
   */
  private named(ref: TargetRef | undefined, uid: string | undefined): boolean {
    if (!ref) return false;
    const c = this.st.teams[ref.side][ref.index];
    if (!c) return false;
    return uid === undefined || c.scoba.uid === uid;
  }

  private find(ref: TargetRef | undefined): Fighter | null {
    if (!ref) return null;
    return this.fighters.find((f) => f.side === ref.side && f.index === ref.index) ?? null;
  }

  private posOf(f: Fighter): Anchor {
    return { x: f.actor.x + f.ox, y: f.actor.y + f.oy };
  }

  /** The species and costume a fighter is drawn as, for anything read off its art. */
  private drawnAs(f: Fighter): { sp: Species; forms: FormTag[] } | null {
    const c = this.st.teams[f.side][f.index];
    const sp = c ? SPECIES[c.scoba.speciesId] : undefined;
    return sp && c ? { sp, forms: formsOf(c) } : null;
  }

  /**
   * Puts a spot measured off a costume's feet where that fighter is standing.
   * The sprite is mirrored for the far side, so the offset mirrors with it.
   */
  private spotOn(f: Fighter, anchor: { x: number; y: number }): Anchor {
    const at = this.posOf(f);
    const facing = f.side === 0 ? 1 : -1;
    // The anchor is already in world units, the same as everything else the
    // stage measures in. Scaling it by the art's own density here put every
    // throw four times too far from the feet it was measured off.
    return { x: at.x + anchor.x * facing, y: at.y - anchor.y };
  }

  /**
   * Where a throw lands on a fighter: the middle of its drawn pixels, or
   * wherever the cosmetics editor has moved that to. A blow reads as landing
   * on the body rather than at the feet it stands on.
   */
  private centerOf(f: Fighter): Anchor {
    const drawn = this.drawnAs(f);
    if (!drawn) return this.posOf(f);
    return this.spotOn(f, centerAnchor(this.art, drawn.sp, drawn.forms));
  }

  /**
   * Where a throw leaves the caster from. A throw off a piece the caster wears
   * leaves from where that piece sits, drawn in or worn on top alike. Anything
   * else leaves from the middle of the Scoba.
   */
  private originOf(f: Fighter, piece?: string): Anchor {
    const drawn = this.drawnAs(f);
    if (!drawn) return this.posOf(f);
    const anchor = piece
      ? accessoryAnchor(this.art, drawn.sp, piece, drawn.forms)
      : originAnchor(this.art, drawn.sp, drawn.forms);
    return this.spotOn(f, anchor);
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

  /**
   * Puts everyone back on their mark, after a resize or a slot change.
   *
   * The stage is built before it knows how big it is, and it runs for as long
   * as the screen takes to arrive before the first frame is drawn. Everyone is
   * standing on a mark worked out from the fallback size until then, so the
   * light a shiny shed over those frames fell somewhere nobody is, and goes.
   */
  private resnap(): void {
    for (const f of this.fighters) {
      // Anyone walking off has left their mark on purpose and does not want
      // putting back on it.
      if (f.leaving) continue;
      const a = this.anchor(f.side, f.slot);
      f.actor.x = a.x;
      f.actor.y = a.y;
      f.actor.clearSparks();
    }
    for (const p of this.people) {
      const a = this.personAnchor(p.side, p.slot);
      p.actor.x = a.x;
      p.actor.y = a.y;
      p.actor.clearSparks();
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
      this.flash = null;
      this.inPast = !!this.st.travelling;
      this.visitor = this.st.travelling?.visitor ?? null;
      this.snapWashes();
      return Promise.resolve();
    }
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.done = resolve;
    });
  }

  update(real: number): void {
    // A landed blow stops the whole stage together: the queue, the offsets, the
    // effects and the trails all hold, so nothing drifts on through the pause.
    if (this.hold > 0) {
      this.hold -= real;
      if (this.hold > 0) return;
      this.hold = 0;
    }
    // Everything on the stage runs on this clock, so one number paces it all.
    const dt = real * stagePace();
    if (Math.abs(this.safeWant - this.safeBottom) > 0.05) {
      this.safeBottom += (this.safeWant - this.safeBottom) * Math.min(1, real * 9);
      // Every mark moved with it, so put back anyone who is meant to be on one.
      if (this.queue.length === 0) this.resnap();
    }
    for (const p of this.people) p.actor.step(dt, 0, 0, NO_MAP);
    this.stepRetreats(dt);
    for (const f of this.fighters) {
      if (f.leaving) continue;
      // The court closes ranks: a Pawn whose slot moved in after a round
      // walks to its new mark while nothing else is playing.
      const home = f.pawn && f.settled && this.queue.length === 0 ? this.anchor(f.side, f.slot) : null;
      if (home && Math.hypot(home.x - f.actor.x, home.y - f.actor.y) > 0.5) {
        f.actor.seek(dt, home.x, home.y, 0.5, NO_MAP, 1, WALK_ON);
      } else {
        f.actor.step(dt, 0, 0, NO_MAP);
      }
      f.shake *= Math.max(0, 1 - dt * 9);
      f.hurt = Math.max(0, f.hurt - dt * 8);
      // Slower than a hit's flash: what a heal reads as is the colour draining
      // back out of it rather than a blow landing.
      f.heal = Math.max(0, f.heal - dt * 1.6);
      f.flare = Math.max(0, f.flare - dt * 1.4);
      // The readout arrives after its Scoba does, and leaves with it.
      const want = f.settled ? f.alpha : 0;
      f.plate += (want - f.plate) * Math.min(1, dt * 6);
      if (Math.abs(want - f.plate) < 0.01) f.plate = want;
    }
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter((e) => e.t < e.dur);
    if (this.flash) {
      this.flash.t += dt;
      if (this.flash.t >= this.flash.dur) this.flash = null;
    }
    this.stepMotions(dt);
    this.stepWashes(dt);
    for (const v of this.shown.values()) {
      v.hpTrail = easeTrail(v.hpTrail, v.hp, dt);
      v.manaTrail = easeTrail(v.manaTrail, v.mana, dt);
      for (const b of v.bars ?? []) {
        b.hpTrail = easeTrail(b.hpTrail, b.hp, dt);
        b.manaTrail = easeTrail(b.manaTrail, b.mana, dt);
      }
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

  /**
   * Runs every caster movement on the clock and puts each Scoba back where it
   * stands once its own is done.
   */
  private stepMotions(dt: number): void {
    if (this.motions.length === 0) return;
    for (const m of this.motions) {
      m.t += dt;
      const k = m.dur <= 0 ? 1 : Math.min(1, m.t / m.dur);
      this.runCasterAnim(m.f, m.anim, k);
      if (k < 1) continue;
      m.f.ox = 0;
      m.f.oy = 0;
      m.f.alpha = 1;
    }
    this.motions = this.motions.filter((m) => m.t < m.dur);
  }

  /** Starts one, replacing whatever that Scoba was already in the middle of. */
  private startMotion(f: Fighter, anim: CasterAnim, seconds?: number): void {
    this.motions = this.motions.filter((m) => m.f !== f);
    if (this.instant) return;
    this.motions.push({ f, anim, t: 0, dur: seconds ?? castDuration(anim) });
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
    const actor = new Actor(0, 0, personSkin(this.art, look));
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
    // A round with no journey in it either way is one the battle's own answer
    // is right for: the scene has either been in the past since an earlier
    // round or has never been there.
    if (!events.some((e) => e.kind === "travel")) this.inPast = !!this.st.travelling;
    let caster: TargetRef | undefined;
    const groups = volleys(events);
    events.forEach((ev, i) => {
      if (ev.kind === "spell") caster = ev.at;
      this.queueEvent(ev, caster, onEach, groups.lead.get(i), groups.follows.has(i));
    });
    return this.flush();
  }

  private queueEvent(
    ev: BattleEvent, caster: TargetRef | undefined, onEach: (ev: BattleEvent) => void,
    volley?: TargetRef[], follows = false,
  ): void {
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
      case "show":
        // Nothing to say in the log: the step is only what is drawn and heard.
        if (ev.visual) this.queueVisual(ev, ev.visual);
        return;
      case "spell": {
        const self = this.find(ev.at);
        if (!self) return say(0.2);
        // A move's own steps say how its caster moves and when. A basic attack
        // has no steps, so it steps at what it is swinging at.
        if (ev.moveId) return say(0, { start: () => this.reskinAll() });
        // The movement runs beside the queue, so the blow lands while the swing
        // is still happening rather than after it.
        say(CAST_LEAD, {
          start: () => {
            this.reskinAll();
            this.startMotion(self, "lunge");
          },
        });
        return;
      }
      case "card": {
        // Whatever threw the card has already played. The card it threw is the
        // one that stays over the head it landed on, until a hand of 21 or more
        // is settled and taken away.
        const target = this.find(ev.at);
        if (!target) return say(0.2);
        const faces = ev.cards ?? (ev.face ? [ev.face] : null);
        const count = ev.count;
        say(HAND_SHOWN, {
          start: () => {
            if (faces && count !== undefined) target.hand = { faces, count };
          },
          end: () => {
            if (count !== undefined && count >= BLACKJACK) target.hand = null;
          },
        });
        return;
      }
      case "travel": {
        // A rewind replaces the whole battle at once, so the scene is rebuilt
        // here to whichever time it has landed in. The traveller itself is set
        // down by the `landing` step after this one, so it is only put on the
        // field hidden here. Riding away is not a rewind and does none of that.
        const back = ev.way === "back";
        const wound = ev.way === "again";
        const traveller = wound ? undefined : ev.at;
        say(back ? TRAVEL_HOME : TRAVEL_OUT, {
          start: () => {
            if (back) {
              // Riding away is not a rewind. The battle stays in the time it is
              // in and the rounds the traveller came back for play on from
              // here, so nothing on the board changes but the traveller
              // leaving. The readouts are left where they are: the battle has
              // already resolved those rounds by the time this plays, so
              // reading them off it here snapped every bar to where the rounds
              // still to play leave it, and then played them again from there.
              const rode = this.find(ev.at);
              if (rode) this.fighters = this.fighters.filter((f) => f !== rode);
              this.visitor = null;
              return;
            }
            // Every number on the board belongs to another turn now, so the
            // readouts are read again rather than eased toward. This runs while
            // the flash is still at full, so the bars are already right when it
            // clears instead of sliding afterwards.
            this.restate();
            this.sync({ fresh: true, arriving: traveller });
            this.resnap();
            // Everyone standing in the other time is standing there whole. The
            // Scoba that left is one of them, three rounds younger, and the
            // machine carrying its older self faded the pair of them out.
            for (const f of this.fighters) {
              if (traveller && sameRef({ side: f.side, index: f.index }, traveller)) continue;
              f.alpha = 1;
              f.plate = 1;
              f.settled = true;
              f.leaving = null;
            }
            // A battle that simply wound back is standing in its own time
            // again, whoever put it there.
            if (!wound) {
              this.inPast = true;
              this.visitor = traveller ?? null;
            }
          },
        });
        return;
      }
      case "hyper": {
        const self = this.find(ev.at);
        if (!self) return say(0.3);
        let changed = false;
        say(0.7, {
          start: () => {
            sfx.confirm();
            const b = this.posOf(self);
            this.effects.push({ kind: "glow", t: 0, dur: 0.7, from: b, to: b, color: "#e58ab8" });
          },
          run: (k) => {
            // Rears up and settles, so the change of shape reads as the Scoba
            // doing something rather than as the art swapping under it.
            self.shake = k < 0.5 ? 3.4 : 0;
            self.oy = -Math.sin(k * Math.PI) * 5;
            // Cream all the way out, and the new costume is put on under it at
            // its palest, so what drains back is the Scoba it has become.
            if (k < HYPER_FLARE) {
              self.flare = k / HYPER_FLARE;
              return;
            }
            if (!changed) {
              changed = true;
              this.reskinAll();
              self.flare = 1;
            }
          },
          end: () => {
            self.shake = 0;
            self.oy = 0;
            if (!changed) this.reskinAll();
          },
        });
        return;
      }
      case "fuse": {
        // The two halves slide together, rattling and paling as they go, and
        // where they meet the fusion comes up out of the cream. Both are looked
        // up as the step runs: the fusion is not on the stage until it does.
        const bodyRef = ev.at;
        const halfRefs = ev.to ?? [];
        let halves: Fighter[] = [];
        let fused: Fighter | null = null;
        let merged = false;
        say(FUSE_TIME, {
          start: () => {
            halves = halfRefs.map((r) => this.find(r)).filter((f): f is Fighter => f !== null);
            const c = bodyRef ? this.st.teams[bodyRef.side][bodyRef.index] : undefined;
            if (c) this.fusions.add(bodyKey(c));
            this.sync({ arriving: bodyRef });
            fused = this.find(bodyRef);
            if (fused) {
              fused.alpha = 0;
              fused.plate = 0;
              fused.settled = false;
            }
            // Their readouts go as they start moving; the fusion's comes in once it stands.
            for (const h of halves) h.settled = false;
            sfx.confirm();
          },
          run: (k) => {
            const to = fused ? this.anchor(fused.side, fused.slot) : null;
            const p = Math.min(1, k / FUSE_MEET);
            for (const h of halves) {
              if (merged) break;
              const from = this.anchor(h.side, h.slot);
              if (to) {
                h.ox = (to.x - from.x) * p;
                h.oy = (to.y - from.y) * p;
              }
              h.shake = 2.4;
              h.flare = p;
            }
            if (merged || k < FUSE_MEET) return;
            merged = true;
            for (const h of halves) {
              h.alpha = 0;
              h.shake = 0;
            }
            if (!fused) return;
            fused.alpha = 1;
            fused.flare = 1;
            const b = this.centerOf(fused);
            this.effects.push({ kind: "glow", t: 0, dur: 0.6, from: b, to: b, color: "#f4ecd8" });
          },
          end: () => {
            this.fighters = this.fighters.filter((f) => !halves.includes(f));
            for (const h of halves) {
              h.ox = 0;
              h.oy = 0;
            }
            if (fused) {
              fused.alpha = 1;
              fused.settled = true;
              fused.actor.dir = fused.side === 0 ? 1 : -1;
            }
            this.onRoster?.();
          },
        });
        return;
      }
      case "hit": {
        // A hit that the volley ahead of it already landed is only its own log
        // line: the arrival and the flash all happened together.
        if (follows) return say(FOLLOW_BEAT);
        const target = this.find(ev.at);
        if (!target) return say(0.2);
        const move = ev.moveId ? MOVES[ev.moveId] ?? null : null;
        const color = colorOf(move);
        // Everyone this cast reaches, so they all land on the same frame.
        const struckRefs = volley ?? (ev.at ? [ev.at] : []);
        say(LAND, {
          start: () => {
            // The freeze is what makes the blow read, so it lands on the same
            // frame the flash and the shake do.
            if (!this.instant) this.hold = HIT_STOP;
            for (const ref of struckRefs) {
              const hitF = this.find(ref);
              if (!hitF) continue;
              hitF.hurt = 1;
              hitF.shake = 2.2;
              const b = this.centerOf(hitF);
              this.effects.push({ kind: "impact", t: 0, dur: 0.22, from: b, to: b, color });
            }
            // A landed hit always makes a noise, so nothing lands in silence:
            // the sample its step names, or the generic blow.
            if (!sfx.play(ev.sound)) sfx.play("generichit", MIX.blow);
          },
          end: () => {
            for (const ref of struckRefs) {
              const hitF = this.find(ref);
              if (hitF) hitF.shake = 0;
            }
          },
        });
        return;
      }
      case "status": {
        const target = this.find(ev.at);
        if (!target) return say(0.25);
        say(0.28, {
          start: () => {
            const b = this.centerOf(target);
            this.effects.push({ kind: "flames", t: 0, dur: 0.45, from: b, to: b, color: "#e7a03c" });
            sfx.play(STATUSES[ev.status ?? ""]?.sound, MIX.status);
          },
        });
        return;
      }
      case "heal": {
        const target = this.find(ev.at);
        if (!target) return say(0.3);
        say(0.3, {
          start: () => {
            // The green goes on as the heal reaches them, and drains back out
            // over the rest of the step.
            target.heal = 1;
            const b = this.centerOf(target);
            this.effects.push({ kind: "glow", t: 0, dur: 0.45, from: b, to: b, color: "#7aa74a" });
            sfx.play(ev.sound);
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
          end: () => this.sync({ hold: true }),
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
            // A Scoba calls as it walks on, where its line has a call drawn.
            sfx.play(SPECIES[this.st.teams[walking.side][walking.index]?.scoba.speciesId ?? ""]?.cry);
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
        let called: Fighter | null = null;
        say(SUMMON_TIME, {
          start: () => {
            // The call is only played where the Pawn it named is still the one
            // standing in that place. A rewind later in the same round takes
            // back everything the round appended, so a call made before one can
            // be pointing at whoever the rewind put there instead, and it drew
            // the caller's Pawn as that Scoba.
            if (!this.named(pawnRef, ev.uid)) return;
            sfx.summon();
            this.sync({ arriving: pawnRef });
            called = this.find(pawnRef);
            if (!called) return;
            called.alpha = 0;
            called.plate = 0;
            called.settled = false;
          },
          run: (k) => {
            const caller = this.find(callerRef);
            if (caller) caller.shake = k < SUMMON_CALL ? 3.2 : 0;
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
   * Plays a step that only changes what is drawn and heard, in the place the
   * battle ran it. Each is a beat of its own, so a throw is in the air for
   * exactly as long as it travels and whatever the step after it does starts
   * as it lands.
   */
  private queueVisual(ev: BattleEvent, step: VisualStep): void {
    const move = ev.moveId ? MOVES[ev.moveId] ?? null : null;
    const color = colorOf(move);
    const reached = (): Fighter[] =>
      (ev.to ?? []).map((ref) => this.find(ref)).filter((f): f is Fighter => f !== null);
    switch (step.kind) {
      case "motion":
        // The movement runs beside the queue, so whatever comes next leaves
        // while the movement is still happening rather than after it. The step
        // is only the beat before it.
        this.push({
          // A motion stretched out still lets the next step go as it reaches
          // the target, which for a long one is later than the usual beat.
          dur: step.seconds === undefined ? CAST_LEAD : Math.max(CAST_LEAD, arrivalShare(step.anim) * step.seconds),
          start: () => { for (const f of reached()) this.startMotion(f, step.anim, step.seconds); },
        });
        return;
      case "wear":
        this.push({ dur: 0, start: () => this.reskinAll() });
        return;
      case "sound":
        this.push({ dur: 0, start: () => playNamed(step.name) });
        return;
      case "wait":
        this.push({ dur: Math.max(0, step.seconds) });
        return;
      case "show": {
        const dur = SHOW_TIME[step.path];
        // What the scene waits for is not always how long the drawing lasts. A
        // ghosted piece spreads out of whatever it landed on, so the blow it
        // belongs to has to land while it is spreading rather than after it has
        // gone: the drawing runs its own life beside the queue.
        const hold = step.path === "ghost" ? 0 : dur;
        // A machine takes whoever it is shown on with it: they fade into it as
        // it closes and are hidden for as long as it is carrying them.
        const carried: Fighter[] = [];
        this.push({
          dur: hold,
          start: () => {
            const sprite = this.paintedBy(ev.at, artNamed(this.art, step.art, move?.tint));
            for (const f of reached()) {
              if (step.path === "wheel" || step.path === "clock") {
                // Over the head rather than on it, so the wheel reads as
                // something being consulted rather than something landing.
                const b = this.posOf(f);
                const up = { x: b.x, y: b.y - f.head - WHEEL_LIFT };
                const to = step.path === "clock" ? { x: up.x, y: up.y - CLOCK_RISE } : up;
                const pins = (step.pointers ?? [])
                  .map((h) => artNamed(this.art, h, undefined))
                  .filter((h): h is HTMLCanvasElement | HTMLImageElement => h !== undefined);
                this.effects.push({
                  kind: step.path === "clock" ? "clock" : "wheel", t: 0, dur, from: up, to, color, sprite, pins,
                });
              } else if (step.path === "liftoff" || step.path === "landing") {
                const b = this.centerOf(f);
                const sky = { x: b.x, y: -MACHINE_CLEAR };
                const up = step.path === "liftoff";
                this.effects.push({
                  kind: "machine", t: 0, dur, from: up ? b : sky, to: up ? sky : b, color, sprite,
                });
                carried.push(f);
                if (!up) {
                  f.alpha = 0;
                  f.plate = 0;
                  f.settled = false;
                }
              } else {
                const b = this.centerOf(f);
                this.effects.push({ kind: step.path, t: 0, dur, from: b, to: b, color, sprite });
              }
            }
            if (step.path === "liftoff" || step.path === "landing") sfx.summon();
          },
          run: (k) => {
            // Shut inside while the machine is over them. On the way down they
            // stay shut until it has actually set down, so nobody is standing
            // there watching their own arrival.
            const out = step.path === "landing"
              ? (k - MACHINE_SET) / (1 - MACHINE_SET)
              : k < MACHINE_DOOR ? 1 - k / MACHINE_DOOR : 0;
            for (const f of carried) f.alpha = Math.min(1, Math.max(0, out));
          },
          end: () => {
            for (const f of carried) {
              f.alpha = step.path === "landing" ? 1 : 0;
              f.settled = step.path === "landing";
              if (step.path === "landing") f.actor.dir = f.side === 0 ? 1 : -1;
            }
          },
        });
        return;
      }
      case "flash": {
        const seconds = Math.max(0.01, step.seconds);
        this.push({
          // Only the stretch it is at full for. Whatever comes next happens
          // behind a flash that is already at full, so the fade uncovers a
          // board that has already changed rather than changing it in view.
          dur: seconds * FLASH_HOLD,
          start: () => { this.flash = { color: step.color, t: 0, dur: seconds }; },
        });
        return;
      }
      case "throw": {
        const travel = TRAVEL[step.path] ?? 0;
        const seed = `${this.st.seed}:spin:${this.st.turn}`;
        this.push({
          dur: travel,
          start: () => {
            // A bounce leaves from whoever it bounced off rather than the thrower.
            const bounce = ev.off ? this.find(ev.off) : null;
            const from = bounce ?? this.find(ev.at);
            const sprite = step.drawn
              ? ev.face ? faceArt(this.art, ev.face, move?.tint) : undefined
              : this.paintedBy(ev.at, artNamed(this.art, step.art, move?.tint));
            let thrown = false;
            for (const ref of ev.to ?? []) {
              const target = this.find(ref);
              if (!target) continue;
              // Something thrown at whoever is throwing it has nowhere to go.
              if (from === target && travel > 0) continue;
              const b = this.centerOf(target);
              // Where it comes from: a piece the caster wears throws from where
              // that piece sits, and anything that falls starts over the target
              // it is falling on.
              const a = step.path === "drop"
                ? { x: b.x, y: b.y - this.view.h * DROP_HEIGHT }
                : bounce ? this.centerOf(bounce)
                  : from ? this.originOf(from, step.from?.toLowerCase()) : b;
              // A turning piece is given its spin here rather than where it is
              // drawn, so it keeps the same one the whole way across. Off the
              // seed, so both clients throw it the same way.
              const spin = step.path === "toss"
                ? (rngFrom(`${seed}:${ref.side}:${ref.index}`)() * 2 - 1) * 2.4
                : 0;
              if (travel > 0) {
                this.effects.push({ kind: step.path, t: 0, dur: travel, from: a, to: b, color, sprite, spin });
                thrown = true;
              } else if (step.path === "beam") {
                this.effects.push({ kind: "beam", t: 0, dur: 0.18, from: a, to: b, color, sprite });
              } else if (sprite) {
                this.effects.push({ kind: "burst", t: 0, dur: 0.3, from: b, to: b, color, sprite });
              }
            }
            // One noise for the throw however many went out, so a move that
            // reaches a whole line does not sound like several.
            if (step.sound === null) return;
            if (step.sound !== undefined) playNamed(step.sound);
            else if (thrown) sfx.play("wooshthrow", MIX.throw);
          },
        });
        return;
      }
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
    const k = BattleStage.key(ref.side, ref.index);
    // A fusion made this round has no readout copy yet: its fuse makes one.
    if (!this.shown.has(k) && ev.bars) {
      const live = this.st.teams[ref.side][ref.index];
      this.shown.set(k, {
        hp: ev.hp ?? 0, hpTrail: ev.hp ?? 0, mana: 0, manaTrail: 0,
        fainted: false, marks: live ? statusSummary(live) : [],
      });
    }
    const held = this.shown.get(k);
    if (!held) return;
    const bars = ev.bars;
    if (bars) {
      held.bars = bars.hp.map((hp, i) => {
        const was = held.bars?.[i];
        const mana = bars.mana[i] ?? 0;
        return {
          hp, max: bars.max[i] ?? 1, mana,
          hpTrail: this.instant || !was ? hp : was.hpTrail,
          manaTrail: this.instant || !was ? mana : was.manaTrail,
        };
      });
    }
    if (ev.hp !== undefined) {
      held.hp = ev.hp;
      if (this.instant) held.hpTrail = ev.hp;
    }
    if (ev.mana !== undefined) {
      held.mana = ev.mana;
      if (this.instant) held.manaTrail = ev.mana;
    }
    if (ev.kind === "faint") held.fainted = true;
    // A mark arrives with the line that says it arrived, rather than with the
    // round that resolved it. Read off the combatant at that moment, so every
    // mark it is carrying by then shows together: what the events say is which
    // Scoba was marked and when, not one status at a time.
    if (ev.kind === "status" || ev.kind === "faint" || ev.kind === "hyper" || ev.kind === "fuse") {
      const live = this.st.teams[ref.side][ref.index];
      if (live) held.marks = statusSummary(live);
    }
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

  /** World units per screen pixel, for turning a click into a place on the field. */
  private cssScale(): number {
    const v = viewport();
    const cssW = v.ui.w * v.zoom;
    return cssW > 0 ? this.view.w / cssW : 1;
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
    // Stepped on the way out, the same as a sprite: a readout easing through
    // fractional opacity is the same soft edge in the interface.
    if (f) return stepAlpha(f.plate);
    return this.opening ? 0 : 1;
  }

  /**
   * The same, for a readout bound to one combatant. A Scoba that has just
   * gone down is off the field before the next render, so a slot lookup would
   * snap its readout back to full rather than letting it fade out with it.
   */
  fighterAlpha(side: 0 | 1, index: number): number {
    return stepAlpha(this.fighters.find((k) => k.side === side && k.index === index)?.plate ?? 0);
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

  /** Which fighter a click at this screen point lands on, if any. */
  hitTest(cssX: number, cssY: number): TargetRef | null {
    // The point is measured from the window's corner and the frame is not
    // always in it: with the ground showing round the frame, a click has to
    // be read from the frame's own corner or every box sits up and to the
    // left of the Scoba it belongs to.
    const origin = frameRect();
    const scale = this.cssScale();
    const x = (cssX - origin.left) * scale;
    const y = (cssY - origin.top) * scale;
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
  /**
   * The cards a Scoba is holding, over its head: every one of them fanned out
   * side by side, oldest at the back and the one just dealt in front.
   */
  private drawHand(ctx: CanvasRenderingContext2D, f: Fighter): void {
    if (!f.hand || f.alpha <= 0.02) return;
    const arts = f.hand.faces.map((face) => faceArt(this.art, face, undefined)).filter((a) => a !== undefined);
    const first = arts[0];
    if (!first) return;
    const at = this.posOf(f);
    const bob = Math.sin(performance.now() / 1000 * HAND_RATE + f.index) * HAND_BOB;
    const u = 1 / ART;
    const w = first.width * u;
    const h = first.height * u;
    // A whole number of art pixels, so every card edge lands on the pixel grid.
    const step = Math.round(first.width * HAND_SPREAD) * u;
    const left = at.x - (w + step * (arts.length - 1)) / 2;
    const top = at.y - f.head - HAND_LIFT - h + bob;
    ctx.save();
    ctx.globalAlpha = f.alpha;
    ctx.imageSmoothingEnabled = false;
    arts.forEach((art, i) => ctx.drawImage(art, left + step * i, top, w, h));
    ctx.restore();
  }

  private drawWashes(ctx: CanvasRenderingContext2D, onlyDrawn = false): void {
    const { w, h } = this.view;
    const mid = Math.round(w / 2);
    for (const side of [0, 1] as const) {
      const wash = this.washes[side];
      const def = wash.id ? FIELDS[wash.id] : null;
      if (!def || wash.a <= 0.01) continue;
      ctx.save();
      ctx.globalCompositeOperation = onlyDrawn ? "source-atop" : "soft-light";
      const lit = ctx.globalCompositeOperation === "soft-light";
      ctx.globalAlpha = wash.a * (lit || onlyDrawn ? FIELD_WASH : FIELD_WASH_FLAT);
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
        /** Which Scoba the body standing here was last drawn as. */
        worn: f.worn,
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
        this.st.teams[side as 0 | 1].map((c, i) => ({
          side, index: i, ...this.shownOf(side as 0 | 1, i),
          // What the Scoba is, beside what its readout says, so a check can
          // see the line it was built with rather than only its bars.
          uid: c.scoba.uid,
          species: c.scoba.speciesId,
          level: c.scoba.level,
          hybrid: c.scoba.hybrid === true,
          hobby: c.scoba.hobby,
          teas: c.scoba.teas ?? [],
        })),
      ),
      fields: this.washes.map((f) => ({ id: f.id, want: f.want, a: Number(f.a.toFixed(2)) })),
      aiming: this.aim ? { options: this.aim.options.length, hover: this.aim.hover } : null,
      turn: { acting: this.turn.acting, waiting: this.turn.waiting },
    };
  }

  /**
   * A piece of art in the colours of whoever on that mark threw or left it, so
   * a line wearing a father's colours throws them too. A Scoba in its own
   * line's colours is handed the art as it was drawn.
   */
  private paintedBy(ref: TargetRef | undefined, img: ScobaImage | undefined): ScobaImage | undefined {
    if (!ref || !img) return img;
    const c = this.st.teams[ref.side][ref.index];
    const sp = c ? SPECIES[c.scoba.speciesId] : undefined;
    if (!c || !sp) return img;
    return paintedFor(this.art, sp, c.scoba, img, formsOf(c));
  }

  /**
   * Whatever the marks on a Scoba grow out of it: one piece per stack, planted
   * on one of the body's own pixels and turned about its foot. Which pixel and
   * which way each piece leans is rolled off the Scoba and the piece's place in
   * the row, so a coral stays where it grew for as long as it stands.
   */
  private drawGrowths(ctx: CanvasRenderingContext2D, f: Fighter, alpha: number): void {
    // Read off what the round has played so far rather than off the state it
    // resolved to, so a coral grows with the blow that grew it.
    for (const held of this.shownOf(f.side, f.index).marks) {
      const name = STATUSES[held.id]?.growth;
      if (name === undefined) continue;
      const pieces = growthArt(this.art, name).map((p) => this.paintedBy(held.from, p) ?? p);
      const spots = growthSpots(f.actor.skin.sprite.img);
      if (pieces.length === 0 || spots.length === 0) continue;
      const many = held.stacks * (STATUSES[held.id]?.growthEach ?? 1);
      for (let i = 0; i < many; i++) {
        const key = `${f.side}.${f.index}.${held.id}.${i}`;
        const spot = spots[Math.floor(growthRoll(`${key}:where`) * spots.length)]!;
        const piece = pieces[Math.floor(growthRoll(`${key}:which`) * pieces.length)]!;
        const middle = growthMiddle(spots);
        const out = Math.atan2(spot.x - middle.x, middle.y - spot.y);
        const lean = out + (growthRoll(`${key}:tilt`) - 0.5) * GROWTH_LEAN.jitter;
        const tilt = Math.max(-GROWTH_LEAN.most, Math.min(GROWTH_LEAN.most, lean));
        f.actor.drawGrowth(ctx, 0, 0, piece, spot, tilt, growthRoll(`${key}:flip`) < 0.5, alpha);
      }
    }
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
    ctx.fillStyle = GROUND.sky;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = GROUND.far;
    ctx.fillRect(0, sky, w, h - sky);
    ctx.fillStyle = GROUND.farLip;
    ctx.fillRect(0, sky, w, 1);
    // A dithered row over the horizon, so the sky and the ground behind
    // everybody do not meet on a bare flat edge.
    for (let x = 0; x < w; x += HORIZON_STEP) ctx.fillRect(x, sky - 1, 1, 1);
    ctx.fillStyle = GROUND.near;
    ctx.fillRect(0, step, w, h - step);
    ctx.fillStyle = GROUND.nearLip;
    ctx.fillRect(0, step, w, 1);

    const items: Item[] = [];
    for (const p of this.people) {
      items.push({
        baseY: p.actor.depthY,
        draw: (c) => {
          p.actor.drawShadow(c, 0, 0);
          p.actor.draw(c, 0, 0);
        },
      });
    }
    for (const f of this.fighters) {
      const at = this.posOf(f);
      const target = this.isTarget(f);
      const waiting = this.turn.waiting.some((r) => r.side === f.side && r.index === f.index);
      const now = !!this.visitor && sameRef({ side: f.side, index: f.index }, this.visitor);
      items.push({
        // The lagging depth, so a move that lifts or lunges a Scoba does not
        // shuffle it past whoever it is standing beside.
        baseY: f.actor.depthY,
        now,
        // The court, a traveller and anyone walking off all stand nearer than
        // the rank the Scoba readouts hang from, so they are drawn over those
        // readouts. A Scoba walking on is not: it arrives on its own rank, and
        // on the near canvas it would be drawn over the people standing in
        // front of it.
        over: isPawnSlot(f.slot) || isTravelSlot(f.slot) || f.leaving !== null,
        draw: (c) => {
          // Anything the move cannot reach fades back while it is being aimed.
          const alpha = stepAlpha(Math.min(f.alpha, this.aim && !target ? 0.4 : 1));
          // The shadow stays on the ground under the body while the sprite
          // floats, lunges or rises, which is the whole point of drawing it.
          f.actor.drawShadow(c, -f.ox, 0, alpha);
          if (alpha <= 0) return;
          const jitter = f.shake > 0.05 ? (Math.random() - 0.5) * f.shake : 0;
          c.save();
          c.globalAlpha = alpha;
          // Standing by while another Scoba is picked for: darkened rather
          // than faded, so it still reads as one standing on the field.
          this.wash(c, [this.pastFilter(now), waiting ? WAITING_TINT : ""].filter((f) => f !== "").join(" "));
          // The animation offset is a draw-time shift, so the actor keeps
          // owning where it actually stands.
          c.translate(f.ox + jitter, f.oy);
          // Behind the body, so what shows is whatever clears its outline.
          this.drawGrowths(c, f, alpha);
          f.actor.draw(c, 0, 0);
          // Every wash is the Scoba's own shape, drawn on the same transform
          // it is, so none of them reads as a box sitting over the field.
          if (f.hurt > 0) f.actor.drawTint(c, 0, 0, "#f3f2c0", f.hurt * 0.5);
          if (f.heal > 0) f.actor.drawTint(c, 0, 0, "#7aa74a", f.heal * 0.55);
          if (f.flare > 0) f.actor.drawTint(c, 0, 0, CREAM, f.flare);
          c.restore();
          // The hand rides over the head rather than with the body, so a lunge
          // does not take the cards with it.
          this.drawHand(c, f);
        },
      });
    }
    items.sort((a, b) => a.baseY - b.baseY);
    const paint = (c: CanvasRenderingContext2D, on: Item[]): void => {
      for (const it of on) {
        c.save();
        it.draw(c);
        c.restore();
      }
    };
    const near = items.filter((it) => it.over);
    paint(ctx, near.length > 0 ? items.filter((it) => !it.over) : items);
    // The ground and everyone standing on it belong to the time the battle is
    // in. The one that travelled there does not, and is drawn after this.
    this.drainPast(ctx);
    this.tintPast(ctx);

    // Whatever is thrown, shown or burst goes over the readouts with the near
    // row: a move's own art reading as something behind a stat card is worse
    // than a card reading as something behind a spark.
    //
    // Most rounds have neither, and a second canvas cleared and painted every
    // frame for nothing is the whole cost of having one, so it is only touched
    // on the frames that put something on it and the one that empties it.
    const wanted = near.length > 0 || this.effects.length > 0;
    const front = wanted || this.frontLit ? this.frontContext(r) : null;
    // Taken out of the page entirely while it holds nothing. A canvas the size
    // of the field is a layer the browser composites every frame even when it
    // is empty, and most rounds put nothing on this one.
    if (this.frontCanvas && wanted !== this.frontLit) {
      this.frontCanvas.style.display = wanted ? "" : "none";
    }
    this.frontLit = wanted;
    if (front && wanted) {
      paint(front, near.filter((it) => !it.now));
      front.save();
      this.wash(front, this.pastFilter(false));
      for (const e of this.effects) drawEffect(front, e);
      front.restore();
      this.tintPast(front);
      // After the tint, so the one that travelled keeps its own colors while
      // everything it is standing among wears the ones of that time.
      paint(front, near.filter((it) => it.now));
      // The weather tints what is standing on this canvas and nothing else:
      // the rest of it is the readouts showing through, and weather does not
      // fall on a readout.
      this.drawWashes(front, true);
    } else {
      for (const e of this.effects) {
        ctx.save();
        drawEffect(ctx, e);
        ctx.restore();
      }
    }
    // Full for the first blink of it and then fading, so the change it covers
    // happens while the screen is hidden.
    const wash = this.flashNow();
    if (wash) {
      ctx.save();
      ctx.globalAlpha = wash.alpha;
      ctx.fillStyle = wash.color;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
    this.drawWashes(ctx);
    // The markers say whose turn it is and what a move can reach, so they go
    // over everything on the field, which is the near canvas wherever there is
    // anything on it.
    const marks = front && wanted ? front : ctx;
    this.drawTurn(marks);
    this.drawAiming(marks);
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
/**
 * How long the queue waits on a cast before the first hit is allowed to land.
 * Short, because the movement itself carries on beside the queue: this is the
 * beat that keeps a throw from landing on the frame it started.
 */
const CAST_LEAD = 0.09;

function castDuration(anim: CasterAnim): number {
  if (anim === "blink") return 0.28;
  if (anim === "lunge") return 0.22;
  if (anim === "rear") return 0.26;
  return 0.2;
}

/**
 * How far into a motion the caster is at its target, as a share of the whole:
 * a blink has reappeared over it, a lunge is at full reach and a rear is at the
 * top. A motion that stays put is there from the start.
 */
function arrivalShare(anim: CasterAnim): number {
  if (anim === "blink") return 0.2;
  if (anim === "lunge") return 0.45;
  if (anim === "rear") return 0.5;
  return 0;
}

/** A wash over whatever was just struck or just mended. */
function flash(
  ctx: CanvasRenderingContext2D, x: number, y: number, k: number, color: string,
): void {
  ctx.save();
  ctx.globalAlpha = Math.min(0.5, k * 0.5);
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x - 7), Math.round(y - 22), 14, 22);
  ctx.restore();
}

/**
 * Effects are drawn as square chunks rather than smooth arcs, so they stay in
 * the same pixel idiom as everything else on the canvas.
 */
/** How long a landed hit holds the queue for its flash and shake. */
const LAND = 0.15;

/** How long each way of showing something in place holds the queue. */
const SHOW_TIME: Record<ShowPath, number> = {
  wheel: 0.9,
  clock: 1.3,
  glow: 0.45,
  burst: 0.3,
  ghost: 0.55,
  flames: 0.45,
  liftoff: 1.1,
  landing: 1.0,
};

/** Sounds the game makes itself rather than reading from a file, by the name a step uses. */
const TONES: Record<string, () => void> = {
  confirm: () => sfx.confirm(),
  tap: () => sfx.tap(),
  back: () => sfx.back(),
  summon: () => sfx.summon(),
};

/** Plays a sound a step names: one of the game's own tones, or a drawn sample. */
function playNamed(name: string): void {
  const tone = TONES[name];
  if (tone) tone();
  else sfx.play(name);
}

/** The color a move is played back in: what a rewrite tinted it, or its element's. */
function colorOf(move: Move | null): string {
  if (move?.tint) return move.tint;
  return move ? TYPE_COLORS[move.type] : "#f3f2c0";
}

/**
 * Where each layer sits under a move's own sound, which plays at full. Every
 * sample is already levelled to one loudness as it loads, so these say what
 * belongs in the background rather than correcting how a file was recorded.
 */
const tintedArt = new Map<string, WeakMap<CanvasImageSource, HTMLCanvasElement>>();

/**
 * Art in a rewritten move's color. Every drawn pixel keeps its own value and
 * takes the tint's hue, so the shape still reads and the color says where the
 * move came from. Built once per drawing and color and kept.
 */
function tinted(img: HTMLCanvasElement | HTMLImageElement, tint: string): HTMLCanvasElement {
  let byImg = tintedArt.get(tint);
  if (!byImg) {
    byImg = new WeakMap();
    tintedArt.set(tint, byImg);
  }
  const hit = byImg.get(img);
  if (hit) return hit;
  const w = (img as HTMLImageElement).naturalWidth || img.width;
  const h = (img as HTMLImageElement).naturalHeight || img.height;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  // Luminosity keeps the drawing's own light and shade under the color, which
  // a flat fill would paint out.
  ctx.globalCompositeOperation = "color";
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, w, h);
  // Put back the shape, since the fill above covered the transparent pixels too.
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(img, 0, 0);
  byImg.set(img, cv);
  return cv;
}

/** Art by name, in a rewritten move's color where it has one. */
function artNamed(art: Art, name: string | undefined, tint: string | undefined): HTMLCanvasElement | HTMLImageElement | undefined {
  // Art is filed by lower-case file name, so a script can write a name either way.
  const drawn = name ? art.powers[name.toLowerCase()] : undefined;
  if (!drawn) return undefined;
  return tint ? tinted(drawn, tint) : drawn;
}

const recolored = new Map<string, WeakMap<CanvasImageSource, HTMLCanvasElement>>();

/**
 * A card as it was drawn: its drawing with the draw's color changes made, in a
 * rewritten move's tint where it has one. Built once per drawing and changes.
 */
function faceArt(art: Art, face: CardFace, tint: string | undefined): HTMLCanvasElement | HTMLImageElement | undefined {
  const drawn = art.powers[face.art.toLowerCase()];
  if (!drawn) return undefined;
  let out: HTMLCanvasElement | HTMLImageElement = drawn;
  if (face.changes.length > 0) {
    const key = face.changes.map((c) => `${c.from}>${c.to}`).join(",");
    let byImg = recolored.get(key);
    if (!byImg) {
      byImg = new WeakMap();
      recolored.set(key, byImg);
    }
    const hit = byImg.get(drawn);
    if (hit) out = hit;
    else {
      const swapped = paletteSwap(drawn, face.changes.map((c) => [hexToRgb(c.from), hexToRgb(c.to)]));
      byImg.set(drawn, swapped);
      out = swapped;
    }
  }
  return tint ? tinted(out, tint) : out;
}

/**
 * The hand a combatant is holding, read off its marks: every card in it as each
 * was dealt, and the best count they make. A hand with no cards kept shows the
 * card worth the whole hand, or the back of one.
 */
function handOf(c: Combatant | null | undefined): { faces: CardFace[]; count: number } | null {
  const dealt = c?.statuses.find((s) => STATUSES[s.id]?.hand === true);
  if (!dealt) return null;
  const faces = dealt.faces ?? [{
    art: dealt.stacks <= CARD_HIGH ? cardOfValue(dealt.stacks).art : CARD_BACK,
    changes: [],
  }];
  const high = dealt.ace === true && dealt.stacks + ACE_EXTRA < BLACKJACK;
  return { faces, count: high ? dealt.stacks + ACE_EXTRA : dealt.stacks };
}

const MIX = {
  /** Under whatever the move itself does, because it is the arm and not the blow. */
  throw: 0.7,
  /** The blow a move with no sound of its own makes, heard on every basic attack. */
  blow: 0.85,
  status: 0.8,
};

/**
 * Which hits belong to one cast. A move that reaches a whole line lands on
 * everyone at once rather than walking down the row, so the first hit of a
 * run throws at every target and lands them all, and the rest are only their
 * own log lines.
 *
 * A run is a stretch of hits from the one move with nothing between them,
 * which is exactly how the battle writes a move that struck several.
 */
export function volleys(events: BattleEvent[]): { lead: Map<number, TargetRef[]>; follows: Set<number> } {
  const lead = new Map<number, TargetRef[]>();
  const follows = new Set<number>();
  let i = 0;
  while (i < events.length) {
    const here = events[i];
    if (here?.kind !== "hit" || here.moveId === undefined) {
      i += 1;
      continue;
    }
    let j = i;
    const refs: TargetRef[] = [];
    while (j < events.length) {
      const next = events[j];
      if (next?.kind !== "hit" || next.moveId !== here.moveId || !next.at) break;
      refs.push(next.at);
      j += 1;
    }
    if (refs.length > 1) {
      lead.set(i, refs);
      for (let k = i + 1; k < j; k++) follows.add(k);
    }
    i = Math.max(j, i + 1);
  }
  return { lead, follows };
}

/** Turns a lobbed piece of art makes between the thrower and the target. */
const LOB_SPINS = 2;

/** How long each kind of shot spends in the air. */
const TRAVEL: Partial<Record<MoveVfx, number>> = {
  bolt: 0.15,
  lob: 0.2,
  // Thrown rather than fired, so it hangs in the air long enough to be read.
  toss: 0.42,
  drop: 0.34,
};

/** How far over a head the wheel is held while it is being spun, in world units. */
const WHEEL_LIFT = 10;

/** How far a clock climbs while it counts, in world units. */
const CLOCK_RISE = 26;

/** Turns the hand on a clock makes while it climbs. */
const CLOCK_TURNS = 5;

/** How far a ghosted piece swells as it thins away, as a share of its own size. */
const GHOST_FROM = 0.45;
const GHOST_TO = 2.1;

/** How much of a clock's time is spent appearing, and how much fading out. */
const CLOCK_IN = 0.12;
const CLOCK_OUT = 0.2;

/** How far past the top of the view a machine goes before it is out of sight. */
const MACHINE_CLEAR = 40;

/** How much of a machine's flight the door is open for, at the near end of it. */
const MACHINE_DOOR = 0.3;

/** How far through a landing the machine has set down and its passenger can step out. */
const MACHINE_SET = 0.82;

/** How much of a screen flash is held at full before it fades. */
const FLASH_HOLD = 0.35;

/** How long the scene holds on the time a traveller has arrived in, and on the one it comes home to. */
const TRAVEL_OUT = 0.7;
const TRAVEL_HOME = 0.5;

/** Turns the wheel makes before it stops. */
const WHEEL_TURNS = 3;

/** How far the pointer overlaps the wheel, so it reads as resting against it. */
const WHEEL_BITE = 6;

/** Where a hand sits over the head it was dealt to, in world units. */
const HAND_LIFT = 7;

/**
 * How far a grown piece can lean off upright, in radians, and how much of that
 * is rolled rather than read off where it sits. A piece points away from the
 * middle of the body, so one on a flank sticks out sideways and one on the
 * crown stands up, and nothing quite lies down.
 */
const GROWTH_LEAN = { most: 1.45, jitter: 0.3 };


/** How far along each card in a hand sits from the one behind it, as a share of a card's width. */
const HAND_SPREAD = 0.5;

/** How long the scene holds on a card that has just landed in a hand. */
const HAND_SHOWN = 0.3;

/** How far a held hand drifts as it hovers, and how fast. */
const HAND_BOB = 1.2;
const HAND_RATE = 2.2;

/** How far over a target something that falls on it starts, as a share of the view. */
const DROP_HEIGHT = 0.36;

/** What a hit already landed by the volley ahead of it spends on its log line. */
const FOLLOW_BEAT = 0.12;

/** How far into the Hyper-Mode step the Scoba is at its palest. */
const HYPER_FLARE = 0.45;

function drawEffect(ctx: CanvasRenderingContext2D, e: Effect): void {
  const k = Math.min(1, e.t / e.dur);
  const u = 1 / ART;
  // The wheel is read before anything else: it turns rather than travelling,
  // so the path every other drawn effect takes is not the one it wants.
  if (e.kind === "wheel") {
    if (!e.sprite) return;
    // It slows to a stop, and the pointer over it holds still while it does,
    // which is what makes it read as a wheel being spun rather than a spinning
    // picture.
    const spun = WHEEL_TURNS * Math.PI * 2 * (1 - (1 - k) * (1 - k));
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(e.to.x, e.to.y);
    ctx.save();
    ctx.rotate(spun);
    ctx.scale(u, u);
    ctx.drawImage(e.sprite, -e.sprite.width / 2, -e.sprite.height / 2);
    ctx.restore();
    const pin = e.pins?.[0];
    if (pin) {
      ctx.scale(u, u);
      ctx.drawImage(pin, -pin.width / 2, -e.sprite.height / 2 - pin.height + WHEEL_BITE);
    }
    ctx.restore();
    return;
  }
  // A clock climbs while its hand goes round, and the face holds still under it.
  if (e.kind === "clock") {
    if (!e.sprite) return;
    const p = 1 - (1 - k) * (1 - k);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = Math.min(1, k / CLOCK_IN) * Math.min(1, (1 - k) / CLOCK_OUT);
    ctx.translate(e.from.x + (e.to.x - e.from.x) * p, e.from.y + (e.to.y - e.from.y) * p);
    ctx.scale(u, u);
    ctx.drawImage(e.sprite, -e.sprite.width / 2, -e.sprite.height / 2);
    // Every hand is drawn on the same sheet the face is, so each one is left
    // exactly where the artist put it and turned about the point it is fixed
    // at. They are turned in the order they were written, each faster than the
    // last, which is an hour, a minute and a second hand written in that order.
    (e.pins ?? []).forEach((hand, i) => {
      const at = handPivot(hand);
      const ox = at ? at.x - hand.width / 2 : 0;
      const oy = at ? at.y - hand.height / 2 : 0;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(CLOCK_TURNS * (i + 1) * Math.PI * 2 * k * k);
      ctx.translate(-ox, -oy);
      ctx.drawImage(hand, -hand.width / 2, -hand.height / 2);
      ctx.restore();
    });
    ctx.restore();
    return;
  }
  // A machine leaving the ground pulls away; one coming down settles onto it.
  if (e.kind === "machine") {
    if (!e.sprite) return;
    const up = e.to.y < e.from.y;
    const p = up ? k * k : 1 - (1 - k) * (1 - k);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(e.from.x + (e.to.x - e.from.x) * p, e.from.y + (e.to.y - e.from.y) * p);
    ctx.scale(u, u);
    ctx.drawImage(e.sprite, -e.sprite.width / 2, -e.sprite.height / 2);
    ctx.restore();
    return;
  }
  const chunk = (x: number, y: number, s: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round((x - s / 2) * ART) * u, Math.round((y - s / 2) * ART) * u, s, s);
  };
  // Both ends of a path are real anchors on the two drawings now: a throw
  // leaves the spot the costume says it leaves and lands on the spot the
  // costume says it lands on. This used to raise a path that ran between two
  // pairs of feet, and raising it again would put every shot over the target.
  const lift = 0;
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

  // Drawn art rides the same paths the blocks do, so a move with art and one
  // without travel and land alike. It is centred on the point and scaled to
  // world units, and a burst swells and fades where the blocks would scatter.
  if (e.sprite) {
    const w = e.sprite.width / ART;
    const h = e.sprite.height / ART;
    let x = e.to.x;
    let y = e.to.y - lift;
    let scale = 1;
    let alpha = 1;
    if (e.kind === "bolt" || e.kind === "lob" || e.kind === "toss") {
      x = e.from.x + (e.to.x - e.from.x) * k;
      y = e.from.y - lift + (e.to.y - e.from.y) * k - arcAt(k);
      if (e.kind === "lob") y -= Math.sin(k * Math.PI) * 26;
      // Thrown higher than it is lobbed, because it is in the air longer.
      if (e.kind === "toss") y -= Math.sin(k * Math.PI) * 34;
    } else if (e.kind === "drop") {
      // Straight down onto the target, slowing into the ground the way a
      // dropped thing does rather than falling at one speed and stopping.
      const p = 1 - (1 - k) * (1 - k) * (1 - k);
      x = e.from.x + (e.to.x - e.from.x) * p;
      y = e.from.y + (e.to.y - e.from.y) * p - lift;
    } else if (e.kind === "beam") {
      x = e.from.x + (e.to.x - e.from.x) * 0.5;
      y = e.from.y - lift + (e.to.y - e.from.y) * 0.5;
      alpha = 1 - k;
    } else if (e.kind === "ghost") {
      // Swells out past its own size and thins away with it, so it reads as
      // something spreading from what it landed on rather than landing on it.
      scale = GHOST_FROM + (GHOST_TO - GHOST_FROM) * (1 - (1 - k) * (1 - k));
      alpha = (1 - k) * (1 - k);
    } else {
      // A burst on the spot: up to full size quickly, then out.
      scale = 0.6 + Math.min(1, k * 3) * 0.4;
      alpha = 1 - Math.max(0, (k - 0.5) * 2);
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.imageSmoothingEnabled = false;
    // A lobbed shot turns end over end on its way across, which is what tells
    // a thrown thing from one that was cast. It turns with the throw, so a
    // shot going left spins the other way.
    if (e.kind === "lob" || e.kind === "toss") {
      // A lob turns the same way every time; a toss takes the turn it was
      // given when it left, which is a different one each throw.
      const turns = e.kind === "toss" ? (e.spin ?? 1) : (e.to.x >= e.from.x ? 1 : -1) * LOB_SPINS;
      ctx.translate(x, y);
      ctx.rotate(k * Math.PI * 2 * turns);
      ctx.translate(-x, -y);
    }
    ctx.drawImage(e.sprite, x - (w * scale) / 2, y - (h * scale) / 2, w * scale, h * scale);
    ctx.restore();
    return;
  }

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
  pointer(ctx, cx, tipY, "#7c9df0");
}

/** A stubby downward arrow, built from rows so it stays hard-edged. */
function arrow(ctx: CanvasRenderingContext2D, cx: number, tipY: number): void {
  pointer(ctx, cx, tipY, "#eae178");
}

/**
 * A plain triangle pointing down at somebody, drawn at the art's own
 * resolution rather than in whole world units so it reads as part of the
 * picture rather than as a chunk of coarser pixels floating over it. No
 * edge: it is a mark over the scene, not a thing standing in it. The target
 * arrow and the turn marker are this in two colours.
 */
function pointer(ctx: CanvasRenderingContext2D, cx: number, tipY: number, color: string): void {
  const px = 1 / ART;
  const snap = (v: number): number => Math.round(v * ART) / ART;
  const x = snap(cx);
  const y = snap(tipY);
  const tri = (width: number, height: number, tip: number, color: string): void => {
    ctx.fillStyle = color;
    const rows = Math.round(height / px);
    for (let i = 0; i < rows; i++) {
      const half = (width / 2) * (1 - i / rows);
      const left = snap(x - half);
      const right = snap(x + half);
      if (right <= left) continue;
      ctx.fillRect(left, tip - height + i * px, right - left, px);
    }
  };
  tri(10, 7, y, color);
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
