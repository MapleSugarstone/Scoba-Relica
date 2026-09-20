// Statuses: the lasting effects a move or ability hangs on a Scoba.
//
// A status splits in two. Its *continuous* effects (stat changes, elemental
// immunity, vulnerability, damage bonuses) are read straight off whatever the
// combatant is carrying, every time something asks. Its *fired* effects
// (damage, healing, cleansing, summoning) go off when the status's trigger
// happens, spend a charge, and stop when the charges or the turns run out.
//
// Everything here is data, written in move script. `sim/battle.ts` owns when
// triggers fire, runs the steps they set off, and settles how the numbers land.
import { STAT_FLOOR, STAT_NAMES, type ElementType, type StatName, type Stats } from "./types";
import type { TargetMode } from "./targeting";
import { CONTENT_TABLES } from "./content/tables";
import type { CardFace } from "./cards";

/** What sets a status's fired effects off. */
export type StatusTrigger =
  /** Nothing. For statuses that are only ever continuous, like Rage. */
  | { on: "passive" }
  /** The battle opens. Fires once for everyone on both teams, bench included. */
  | { on: "battle-start" }
  | { on: "turn-start" }
  | { on: "turn-end" }
  /** The holder makes a basic attack. */
  | { on: "basic-attack" }
  /** The holder casts a spell. */
  | { on: "use-ability" }
  /** The holder blocks. */
  | { on: "block" }
  /** The holder is hit. */
  | { on: "hit-magic" }
  | { on: "hit-physical" }
  | { on: "hit-any" }
  | { on: "hit-element"; element: ElementType }
  /** The holder lands a hit on somebody else. */
  | { on: "deal-magic" }
  | { on: "deal-physical" }
  | { on: "deal-any" }
  /** The holder lands a hit with a move rather than with a basic attack. */
  | { on: "deal-spell" }
  /** The holder lands a hit of one element, and of one category where that is named. */
  | { on: "deal-element"; element: ElementType; category?: "physical" | "magic" }
  /** The holder lands a killing blow with attack damage. */
  | { on: "kill-attack" }
  /** The holder faints. */
  | { on: "death" }
  /** The holder is sent out. */
  | { on: "switch-in" }
  /** Someone else goes down. `any-death` answers either side. */
  | { on: "ally-death" }
  | { on: "enemy-death" }
  | { on: "any-death" }
  /** The holder drops to or below a share of its pool. */
  | { on: "hp-below"; frac: number };

/**
 * How damage counts. `attack` is what a kill trigger looks for, and covers
 * every direct hit; `status` is a tick from a lasting effect.
 */
export type DamageClass = "attack" | "status";

/** How damage is mitigated. `true` damage ignores both defences. */
export type DamageCategory = "physical" | "magic" | "true";

/**
 * How an attack is mitigated. A `mixed` one is both at once: its shares of
 * Magic are magical and everything else in it is physical.
 */
export type HitCategory = "physical" | "magic" | "mixed";

/** Whether a hit of one category counts as one of another, which a mixed hit does for both halves. */
export function countsAs(cat: DamageCategory | "mixed", want: DamageCategory): boolean {
  return cat === want || (cat === "mixed" && want !== "true");
}

/** Where a number is measured from. */
export type Basis =
  /** The Scoba that applied the status. */
  | "source-str"
  | "source-mag"
  | "source-max-hp"
  /** The Scoba carrying it. */
  | "holder-str"
  | "holder-mag"
  | "holder-max-hp"
  | "holder-hp";

/**
 * The number a status measures as it lands: a share of a stat, a flat amount at
 * the level ceiling scaled by the source's level, or both added together. A
 * power with no `basis` is the flat amount alone.
 */
export interface StatusPower {
  basis?: Basis;
  frac: number;
  flatAtCeiling?: number;
}

export interface StatusDamage {
  basis: Basis;
  frac: number;
  /**
   * Added to the share, times the source's level over the ceiling, so a mark
   * that names a flat number means that number on a Scoba at the ceiling and
   * proportionally less below it. Folded into the snapshot with the share.
   */
  flatAtCeiling?: number;
  element: ElementType;
  category: DamageCategory;
  damageClass: DamageClass;
  /** Whether landing this can set off the victim's own on-hit statuses. */
  triggersOnHit: boolean;
  /**
   * Fix the number when the status is applied rather than reading it fresh
   * each tick, so a caster that is buffed or weakened later changes nothing.
   */
  snapshot: boolean;
}

/**
 * Who a step reaches, read from whoever is running it. A move runs its steps as
 * its caster, and a status runs them as the Scoba carrying it.
 */
export type Who =
  /** The caster of a move, or the Scoba carrying a status. */
  | "self"
  /** Who put the status there. A status with nobody behind it reaches nobody. */
  | "source"
  /** Whoever was on the far side of the trigger: the attacker for a hit, the victim for a kill. */
  | "other"
  /** Every standing member of the self's own team, bench included, the self too. */
  | "allies"
  | "enemies"
  | "everyone"
  /** Every standing member of both teams but the self. */
  | "others"
  /** The Scoba a `raise` step just put on the field, for the steps after it. */
  | "raised"
  /** The Scoba standing in a time it does not belong to, for the steps after a `travel` one. */
  | "traveller"
  /** Every ally standing on the field, Pawns and the self included. */
  | "field-allies"
  /** Every enemy standing on the field, Pawns included. */
  | "field-enemies"
  /** Every ally Scoba standing on the field, the self included, and no Pawn. */
  | "ally-scobas"
  /** Every enemy Scoba standing on the field, and no Pawn. */
  | "enemy-scobas"
  /** Every ally Pawn standing on the field, and no Scoba. */
  | "ally-pawns"
  /** Every enemy Pawn standing on the field, and no Scoba. */
  | "enemy-pawns"
  /** One of a move's target groups, by the order its aims are written in. */
  | { aim: number }
  /** What an `ask` step above was answered with, by the name that step gave it. */
  | { asked: string }
  /** The first ally or enemy Scoba standing on the field, in mark order, that `from` does not reach. */
  | { next: "ally" | "enemy"; from: Who }
  /** Whoever `first` reaches, or whoever `then` reaches where `first` reaches nobody standing. */
  | { first: Who; then: Who };

/** One stat an attack reads, and how much of it. */
export interface Scaling {
  stat: StatName;
  scale: number;
}

/** The animation a caster plays. */
export type CasterAnim =
  /** Rattle in place. */
  | "shake"
  /** Quick step at the target and back. */
  | "lunge"
  /** Vanish, appear over the target, rattle, vanish back. */
  | "blink"
  /** Rise and slam down. */
  | "rear"
  /** Hold still and gather. */
  | "focus"
  /** Sway from side to side in little hops, turning to face each way. */
  | "dance";

/** How something thrown travels, or how it appears where it lands. */
export type MoveVfx =
  /** Straight shot from caster to target. */
  | "bolt"
  /** Arcing shot. */
  | "lob"
  /** A slow arc, turning as it goes, that is gone the moment it lands. */
  | "toss"
  /** Appears over the target and falls onto it, slowing into the ground. */
  | "drop"
  /** A burst on the target with nothing thrown. */
  | "burst"
  /** Licking flames over the target. */
  | "flames"
  /** A halo on whoever it lands on. */
  | "glow"
  /** A line drawn straight through, all at once. */
  | "beam";

/** How something shown in place is drawn. */
export type ShowPath = "wheel" | "glow" | "burst" | "ghost" | "flames" | "clock" | "liftoff" | "landing" | "rise";

/** A color on a drawn card replaced by another, `chance` of the time. */
export interface ChanceColorChange {
  from: string;
  to: string;
  chance: number;
}

/** One way a move is rewritten by `change-move`. */
export type MoveChange =
  /** Its first element. A second element is kept. */
  | { set: "type"; to: ElementType }
  /** How its hits are mitigated. */
  | { set: "category"; to: "physical" | "magic" }
  /** The stat its hits read first, and the stat a heal off a stat reads. */
  | { set: "stat"; to: "str" | "mag" }
  /** The color it is played back in. */
  | { set: "tint"; to: string }
  /** Its mana cost, multiplied and rounded to a whole number. */
  | { set: "cost"; mult: number }
  /** What it is called. `{name}` is the name it had before this change. */
  | { set: "name"; to: string };

/**
 * Something that happens, in the order it is written. A move's cast is a list
 * of these, and so is what a status does when its trigger goes off. Some change
 * the battle and some only change what is drawn and heard, and the scene plays
 * both in the order the battle ran them.
 */
export type Step =
  /**
   * An attack: shares of the attacker's stats through the same-type bonus, the
   * type chart and the target's Defense or Resistance. `perLevel` takes a flat
   * number per level of the attacker in place of the shares, and the rest applies
   * the same.
   */
  | {
    kind: "hit"; to: Who; scaling: Scaling[]; perLevel?: number;
    /** A flat amount at the level ceiling, scaled by the attacker's level, on top of the shares. */
    flatAtCeiling?: number;
    /**
     * Counted once for each stack of this status the target carries, and not
     * thrown at all where the target carries none.
     */
    perStackOf?: string;
    /**
     * A share of the target's own HP bar, added to the shares of the
     * attacker's stats. It is the one part of an attack read off the Scoba it
     * lands on, and the armor and the type chart still apply to it.
     */
    ofTargetHp?: number;
    /**
     * After the named target, the attack carries on to every other enemy
     * standing, each one taking this share of what the one before it took.
     */
    bounce?: number;
    /** Art thrown from each target to the next one the bounce reaches. */
    bounceArt?: string;
    element?: ElementType; category?: HitCategory; sound?: string;
  }
  /** One free basic attack, the same swing a chosen attack makes, at each of `at`. */
  | { kind: "swing"; at: Who }
  /** A set amount, with no chart and no armor. */
  | { kind: "damage"; to: Who; damage: StatusDamage; sound?: string }
  /** `power` heals what the status or the patch running it snapshotted, in place of the share. */
  | { kind: "heal"; to: Who; basis: Basis; frac: number; power?: true; sound?: string }
  /** `turns` overrides how long the status stands. */
  | { kind: "inflict"; status: string; on: Who; turns?: number }
  /** Puts a status on the ground under each of `under`, where it stands on its own. */
  | { kind: "plant"; status: string; under: Who }
  /**
   * Stops the round and asks each Scoba in `who` to pick one Scoba, the way
   * the round's own choices are picked. The picks stand as the group `name`
   * for the steps below. Whoever cannot be asked, such as a Pawn nobody
   * controls, is answered by the same hand that plays it.
   */
  | { kind: "ask"; who: Who; mode: TargetMode; name: string; prompt?: string }
  | { kind: "cleanse"; on: Who; polarity: StatusPolarity }
  /** Copies every status the first of `from` carries onto each of `to`. */
  | { kind: "copy-marks"; from: Who; to: Who }
  /** Takes a share of current HP from some and spends it on others, split between them. */
  | { kind: "transfer"; from: Who; to: Who; frac: number; deliver: "damage" | "heal" }
  /**
   * Calls a Scoba to the side of the one running the step. `levelShare` sets its
   * level as a share of that Scoba's own, in place of `level`. `copying` hands it
   * the moves, the statuses and the bred lean of the first Scoba that reaches,
   * less Hyper-Mode and the statuses `except` names.
   */
  | {
    kind: "summon"; species: string; level: number; levelShare?: number;
    copying?: Who; except?: string[];
  }
  | { kind: "grant-item"; item: string; count: number }
  /** `second` puts it in a fusion's second mana bar rather than its first. */
  | { kind: "mana"; on: Who; amount: number; second?: true }
  | { kind: "field"; field: string; scope: FieldScope }
  /**
   * Draws one card from the deck off the battle seed, and calls it the drawn
   * card for the steps after it. The one roll decides both its drawing and its
   * value. Each color change then happens with its own chance, rolled off the
   * same seed.
   */
  | { kind: "draw-card"; changes: ChanceColorChange[] }
  /**
   * Deals the drawn card face up and adds its value to the hand the `hand`
   * status counts. A hand of exactly twenty one pays out for `payoff` times the
   * dealer's Strength and clears. One that goes over busts and clears.
   */
  | { kind: "deal-card"; to: Who; payoff: number; hand: string }
  /**
   * Raises a fallen Scoba as a Pawn on the caster's side, at `levelShare` of the
   * level it fell at, wearing the caster's colours. `types` replaces what it is,
   * and the steps after it reach it as `raised`.
   */
  | { kind: "raise"; who: Who; levelShare: number; types?: ElementType[] }
  /**
   * Puts the battle back `turns` rounds, stands the caster there as a visitor,
   * has it cast the spell the move asked for, and then plays those rounds again
   * with everyone repeating what they chose. Anything that is no longer legal
   * simply does not happen.
   */
  /** `art` is the machine it rides, shown carrying it there and away again. */
  | { kind: "travel"; turns: number; discount: number; art?: string }
  /**
   * Puts the whole battle back the way it stood `turns` rounds ago. The round it
   * runs in stops there: everything after it in that round happened in a past
   * that is gone.
   */
  | { kind: "rewind"; turns: number }
  /**
   * Remembers what each Scoba in `on` is carrying, and puts them back to it at
   * the end of the round: the HP they had and the statuses they held. One that
   * falls in the meantime stays fallen, since what is undone is damage survived.
   */
  /**
   * Holds what everyone in `on` is carrying and puts it back as the round
   * closes. `mark` is the status they wear while it is held, so the board says
   * who is being undone, and it comes off with the putting back.
   */
  | { kind: "undo-round"; on: Who; mark?: string }
  /** Takes one named status off each Scoba in `on`, however many stacks it holds. */
  | { kind: "clear-status"; status: string; on: Who }
  /**
   * Runs `then` only where `test` holds for a Scoba in `who`: `fell` for one
   * standing as the steps began that is down now, `stands` for one standing now.
   */
  | { kind: "if"; who: Who; test: "fell" | "stands"; then: Step[] }
  /** Puts back the mana the cast was paid with and clears its cooldown. */
  | { kind: "refund" }
  /**
   * Picks a move out of the whole game, off the battle seed, and calls it the
   * picked move for the steps after it. Finding nothing ends the list.
   */
  | { kind: "pick-move"; minCost: number; skipOncePerBattle: boolean }
  /** Rewrites the picked move. `key` names the rewrite, so the same one is built once. */
  | { kind: "change-move"; changes: MoveChange[]; key: string }
  /** Hands the picked move over for the battle: on top of its moves, or in a slot. */
  | { kind: "give-move"; to: Who; slot: number | null; move?: string }
  /** A line in the battle log. `{self}`, `{target}` and `{picked}` are filled in. */
  | { kind: "say"; text: string }
  /** The costume the Scoba is seen in for the rest of the battle. */
  | { kind: "wear"; who: Who; form: string }
  /** `seconds` stretches the animation from its own short beat to that long. */
  | { kind: "motion"; who: Who; anim: CasterAnim; seconds?: number }
  /**
   * Throws art from `self` at each of `to`, leaving from a piece it wears where
   * `from` names one. `sound` is the noise of it leaving, null for none.
   * `drawn` throws the drawn card as it was drawn, in place of `art`.
   */
  | {
    kind: "throw"; art?: string; drawn?: boolean; path: MoveVfx; from?: string; to: Who;
    sound?: string | null;
    /** Where it leaves from in place of the Scoba running the step, for a throw that bounces. */
    off?: Who;
  }
  /**
   * Shows art in place on or over a Scoba. `pointers` are the hand a `wheel` is
   * read against and the hands a `clock` turns, each one faster than the one
   * written above it.
   */
  | { kind: "show"; art: string; path: ShowPath; on: Who; pointers?: string[] }
  | { kind: "sound"; name: string }
  /** Washes the whole screen in a color and fades it out. */
  | { kind: "flash"; color: string; seconds: number }
  | { kind: "wait"; seconds: number };

/** An effect that stands for as long as its status does and is read where it matters. */
export type Standing =
  /** Adds points to a stat. */
  | { kind: "stat-add"; stat: StatName; amount: number }
  /** Overrides a stat outright; the last one applied wins. */
  | { kind: "stat-set"; stat: StatName; value: number }
  /**
   * Pours a share of one stat into another. Read off the same stat line every
   * other continuous effect is, measured once every set and add has landed, so
   * two shares on one holder cannot depend on which was written first.
   */
  | { kind: "stat-share"; stat: StatName; from: StatName; frac: number }
  /**
   * Scales a stat, applied after every add and set, so it keeps its share of
   * whatever the stat has since become. Stacking multiplies.
   */
  | { kind: "stat-scale"; stat: StatName; mult: number }
  /**
   * Adds to a stat after every scale has landed, which is what makes a flat
   * bonus stay flat.
   */
  | { kind: "stat-offset"; stat: StatName; amount: number }
  /**
   * A share of the stat line the status was measured against when it landed,
   * plus a flat amount. The line is fixed at that moment, so what the Scoba
   * has become since cannot feed back into it: the same mode is worth the same
   * whenever it is entered. Hyper-Mode is written with this.
   */
  | { kind: "stat-boost"; stat: StatName; frac: number; flat: number }
  /**
   * Moves a stat by the number the status snapshotted when it was applied,
   * times the multiplier. A drain uses a negative multiplier. The number is
   * fixed at application, so a caster buffed afterwards changes nothing.
   */
  | { kind: "stat-power"; stat: StatName; mult: number }
  | { kind: "immune"; element: ElementType }
  | { kind: "vulnerable"; element: ElementType; mult: number }
  /** Everything hurts it more, whatever element it is. */
  | { kind: "frail"; mult: number }
  /** The holder deals more with one element. */
  | { kind: "element-power"; element: ElementType; mult: number }
  /**
   * Eats one instance of an element outright. Read where damage lands, and
   * spends a charge when it catches something.
   */
  | { kind: "ward"; element: ElementType }
  /**
   * Takes `frac` off the next instance of damage the holder takes, whatever it
   * is. Read where damage lands, and spends a charge when it catches something.
   */
  | { kind: "soften"; frac: number }
  /** The holder cannot be called back. Read where a switch is offered. */
  | { kind: "root" }
  /** The holder can no longer enter Hyper-Mode. Read where the mode is offered. */
  | { kind: "no-hyper" }
  /** The holder cannot cast a move. Read where a move is offered. */
  | { kind: "no-spells" }
  /**
   * Everything the holder casts is cast a second time, worth `frac` of the
   * first. What the echo leaves behind is marked as an echo too.
   */
  | { kind: "echo"; frac: number }
  /**
   * A status the holder leaves that stands for at least `minTurns` is measured
   * `mult` times over when it lands.
   */
  | { kind: "mark-power"; mult: number; minTurns: number }
  /**
   * Makes statuses of one polarity `mult` times as effective where they sit:
   * on the holder itself, on every enemy on the field, or on every ally on the
   * field, the holder included. Read while the statuses are read, so it reaches
   * statuses already there as well as new ones, and the reach to the field
   * lasts only while the holder is standing on it. `shown` is a status each
   * Scoba it reaches on the field shows as a sigil while it does, other than
   * the holder itself.
   */
  | {
    kind: "mark-worth"; reach: "self" | "enemies" | "allies"; polarity: StatusPolarity; mult: number;
    shown?: string;
  }
  /**
   * Every heal that lands on an ally standing on the field, the holder
   * included, restores this much more, for as long as the holder stands there.
   * An amount at the level ceiling, scaled by the holder's level.
   */
  | { kind: "heal-bonus"; flatAtCeiling: number };

export type StatusEffect = Standing | Step;

export type StatusPolarity = "good" | "bad";

/** Which side a field lands on, relative to whoever called it up. */
export type FieldScope = "allies" | "enemies" | "both";

/**
 * A hobby: what a Scoba does with its time, and what that does to its stats.
 * Every Scoba has exactly one, it never changes on its own, and it is part of
 * the Scoba rather than something it is carrying, so it counts in and out of a
 * battle alike and nothing can take it off.
 */
export interface HobbyDef {
  id: string;
  /** What the hut calls it: "Crochet". */
  name: string;
  /** What the Scoba is doing, for its own card: "Crocheting". */
  doing: string;
  /** The line the hut reads out. */
  text: string;
  effects: Standing[];
}

export interface StatusDef {
  id: string;
  name: string;
  /**
   * The line a player reads. A status with none says what it does from its own
   * effects, which is enough for almost all of them; one that only marks who
   * something else is about to reach has no effects to say it with.
   */
  text?: string;
  /** Which half of a cleanse strips it. */
  polarity: StatusPolarity;
  trigger: StatusTrigger;
  /** Turns it lasts. null runs until something takes it off. */
  duration: number | null;
  /** Times its fired effects can go off. null is unlimited. */
  charges: number | null;
  /** Whether a second application stacks rather than refreshing. */
  stacks: boolean;
  maxStacks: number;
  /**
   * One stack answers a trigger rather than every stack answering it, and that
   * stack is gone once it has. What it stacks up to is how many times it can
   * answer before it is spent.
   */
  spendsStack?: boolean;
  /** Whether it survives the holder being switched out. */
  persists: boolean;
  /**
   * A number read off the field when the status is applied and kept on the
   * instance. `stat-power` moves a stat by it, so a mark left by a big caster
   * hits harder than the same mark left by a small one.
   */
  power?: StatusPower;
  /**
   * A passive the Scoba was born with rather than something done to it. Innate
   * statuses are never cleansed, never copied, and are left off the tag row,
   * since the ability they belong to is already named on the Scoba's card.
   */
  innate?: boolean;
  /** The sigil it is shown as, by file name in `assets/Sigils`. */
  icon?: string;
  /**
   * Drawn on the mark it is planted under, by file name in `assets/Powers`.
   * A status with one is a patch of ground rather than something a Scoba
   * carries: `plant` puts it on a mark, it stands there for its own duration,
   * and it reaches whoever is standing on that mark when it goes off.
   */
  planted?: string;
  /**
   * What the holder's line art is drawn in while it carries this, as a hex
   * colour. The black outline holds every drawing together, so lighting it is
   * how a status shows on the Scoba itself rather than only on its card.
   */
  lit?: string;
  /** A drawn sample for it landing, by file name in `assets/Sounds`. */
  sound?: string;
  /** Its stacks are a hand of cards, drawn over the holder's head. */
  hand?: boolean;
  /** Never shown in the sigil row, for a state the Scoba's own drawing already shows. */
  unseen?: boolean;
  /** Nothing makes it more or less effective: a `mark-worth` effect passes it by. */
  asWritten?: boolean;
  /**
   * A passive that fuses its holder, in Hyper-Mode, with an ally in Hyper-Mode
   * carrying the `partner` status, into one Scoba of the `into` species. Tried
   * whenever the holder takes the field, which entering Hyper-Mode counts as.
   */
  fuses?: { partner: string; into: string };
  /** A passive that turns the holder's basic attack into this move, cast for nothing. */
  basicAttack?: string;
  /**
   * The `when` blocks after the first, each with its own trigger and steps. The
   * first is `trigger` and the steps in `effects`.
   */
  also?: { trigger: StatusTrigger; steps: Step[] }[];
  /**
   * Art that grows out of the holder, by file name in `assets/Powers`. A name
   * with numbered files beside it (`randomcoral1`, `randomcoral2`) draws one of
   * them per piece. `growthEach` is how many pieces a stack is worth, which is
   * one where it is left out.
   */
  growth?: string;
  growthEach?: number;
  /** Standing effects, then the steps its trigger runs, each in written order. */
  effects: StatusEffect[];
}

/** One status sitting on one combatant. */
export interface StatusInstance {
  id: string;
  /** Turns left; -1 is indefinite. */
  turnsLeft: number;
  /** Charges left; -1 is unlimited. */
  chargesLeft: number;
  stacks: number;
  /** Fixed damage number, for statuses that snapshot when applied. */
  power?: number;
  /** The stat line it was measured against when it landed, for `stat-boost`. */
  basis?: Partial<Record<StatName, number>>;
  /**
   * The turn it landed on. A mark does not tick on the turn it is applied:
   * neither its own clock nor whatever it does each turn, so a mark that lasts
   * three turns acts on the three turns after the one that put it there
   * rather than on the one it arrived on.
   */
  since?: number;
  /** Who put it there, so a tick's kill is credited to them. */
  from?: { side: 0 | 1; index: number };
  /** For a hand of cards: every card dealt onto it, oldest first, as each looked when it was thrown. */
  faces?: CardFace[];
  /** For a hand of cards: it holds an Ace, which can count 11. `stacks` counts every Ace as 1. */
  ace?: true;
  /**
   * An echo of a cast rather than the cast itself, worth `scale` of what it
   * would be. It sits beside a plain instance of the same status rather than
   * refreshing it, so a status that does not stack still stacks this way.
   */
  chrono?: true;
  scale?: number;
}

/**
 * How a mark's power is mitigated. One that lowers a stat is physical off
 * Strength and magical off Magic. One that only raises stats, or measures off
 * health, is true and meets no armor.
 */
export function powerCategory(def: StatusDef): DamageCategory {
  const lowers = def.effects.some((e) => e.kind === "stat-power" && e.mult < 0);
  if (!def.power || !lowers) return "true";
  const basis = def.power.basis;
  if (basis === undefined) return "true";
  if (basis === "source-str" || basis === "holder-str") return "physical";
  if (basis === "source-mag" || basis === "holder-mag") return "magic";
  return "true";
}

/** What Hyper-Mode adds: a quarter of the Scoba's own line, and a flat 15. */
export const HYPER_SCALE = 0.25;
export const HYPER_FLAT = 15;

/** One stat's worth of a `stat-boost`, measured against the line it snapshotted. */
export function boostFrom(frac: number, flat: number, basis: number): number {
  return Math.round(basis * frac) + flat;
}

/**
 * EZ mode's leg-up. Hung on the players' own Scobas as a battle opens and
 * gone with the battle, so nothing it does outlives the fight. One stack per
 * level over the first, which is what makes it read as a bigger gain per
 * level rather than a flat bonus.
 */
export const EZ_STAT_BONUS = 3;

/**
 * Every status, from `content/statuses.txt`, and the status each passive in
 * `content/passives.txt` is carried as. The files are the source of truth and
 * the cosmetics editor reads and writes them.
 */
export const STATUSES: Record<string, StatusDef> = CONTENT_TABLES.statuses;

export function statusName(id: string): string {
  return STATUSES[id]?.name ?? id;
}

// --- fields ---
//
// A field is weather rather than a mark: it stands over a whole side instead
// of on one Scoba, it is not carried by anybody and so cannot be cleansed or
// switched out of, and a side holds exactly one at a time. Laying a new one
// over a side takes the old one off.
//
// What a field does is deliberately narrower than what a status does. It
// changes how damage lands and nothing else, so it can be read at the two
// points that settle a hit without every stat line in the game having to know
// which side of the field it was measured on.

/** What a field does to the side standing under it. */
export type FieldEffect =
  | { kind: "element-power"; element: ElementType; mult: number }
  | { kind: "immune"; element: ElementType }
  | { kind: "vulnerable"; element: ElementType; mult: number };

export interface FieldDef {
  id: string;
  name: string;
  /** Turns it holds. null stands until something replaces it. */
  duration: number | null;
  /** The wash laid over the half of the screen its side stands on. */
  tint: string;
  /** The sigil it is shown as, by file name in `assets/Sigils`. */
  icon?: string;
  /** What the log says as it takes hold, and as it lifts. */
  onset: string;
  lifts: string;
  effects: FieldEffect[];
}

/** One field standing over one side. */
export interface FieldInstance {
  id: string;
  /** Turns left; -1 is indefinite. */
  turnsLeft: number;
  /** Who called it up, so the scene knows who to rattle. */
  from?: { side: 0 | 1; index: number };
}

/**
 * Every hobby, from `content/hobbies.txt`. Every Scoba has one, so the table is
 * also the list the hut offers and the order it offers them in.
 */
export const HOBBIES: Record<string, HobbyDef> = CONTENT_TABLES.hobbies;

export const HOBBY_IDS: string[] = Object.keys(HOBBIES);

/** What a Scoba is doing, for its own card. Empty where it has no hobby yet. */
export function hobbyDoing(id: string | undefined): string {
  return id === undefined ? "" : HOBBIES[id]?.doing ?? "";
}

/**
 * What a hobby does to a stat line, in the shape `foldStatEffects` reads. A
 * hobby carries no stacks and no power: it is one copy of itself, always.
 */
export function hobbyEffects(id: string | undefined): ReadEffect[] {
  const def = id === undefined ? undefined : HOBBIES[id];
  if (!def) return [];
  return def.effects.map((effect) => ({ effect, stacks: 1, power: 0 }));
}

/** Every field, from `content/fields.txt`. */
export const FIELDS: Record<string, FieldDef> = CONTENT_TABLES.fields;

/** A fresh field, before it goes over a side. */
export function newField(id: string, from?: { side: 0 | 1; index: number }): FieldInstance | null {
  const def = FIELDS[id];
  if (!def) return null;
  return { id, turnsLeft: def.duration ?? -1, ...(from === undefined ? {} : { from }) };
}

/** What a side's field is doing, in the shape the hit is read against. */
export function fieldEffects(f: FieldInstance | null | undefined): FieldEffect[] {
  return f ? FIELDS[f.id]?.effects ?? [] : [];
}

/** Ticks a field's duration and clears it when it has run out. */
export function tickField(f: FieldInstance | null): FieldInstance | null {
  if (!f) return null;
  if (f.turnsLeft < 0) return f;
  f.turnsLeft -= 1;
  return f.turnsLeft === 0 ? null : f;
}

/** A fresh instance of a status, before it goes on anyone. */
export function newStatus(
  id: string,
  from?: { side: 0 | 1; index: number },
  power?: number,
  since?: number,
): StatusInstance | null {
  const def = STATUSES[id];
  if (!def) return null;
  return {
    id,
    turnsLeft: def.duration ?? -1,
    chargesLeft: def.charges ?? -1,
    stacks: 1,
    ...(since === undefined ? {} : { since }),
    ...(power === undefined ? {} : { power }),
    ...(from === undefined ? {} : { from }),
  };
}

/**
 * Puts a status on a list, stacking, refreshing or bouncing off depending on
 * what the definition allows. Returns what happened, for the battle log.
 */
export function applyStatus(
  list: StatusInstance[],
  inst: StatusInstance,
): "added" | "stacked" | "refreshed" {
  const def = STATUSES[inst.id]!;
  // An echo is its own instance: it is what makes a status that does not stack
  // stack, and it is worth less than the one it stands beside.
  const held = list.filter((s) => s.id === inst.id && !s.chrono === !inst.chrono);
  if (held.length === 0) {
    list.push(inst);
    return "added";
  }
  if (!def.stacks) {
    // One instance only: top its duration and charges back up.
    const first = held[0]!;
    first.turnsLeft = inst.turnsLeft;
    first.chargesLeft = inst.chargesLeft;
    if (inst.power !== undefined) first.power = inst.power;
    return "refreshed";
  }
  // A hand is one hand. Its stacks are the count of the cards in it, which
  // whatever deals the card sets, rather than how many times it was dealt, so
  // another landing never starts a second hand beside it.
  if (def.hand) {
    const first = held[0]!;
    first.turnsLeft = Math.max(first.turnsLeft, inst.turnsLeft);
    return "refreshed";
  }
  // Stacking statuses count either as separate instances or as stacks on one,
  // whichever the cap allows; both read the same way everywhere else.
  const total = held.reduce((n, s) => n + s.stacks, 0);
  if (total >= def.maxStacks) {
    const last = held[held.length - 1]!;
    last.turnsLeft = Math.max(last.turnsLeft, inst.turnsLeft);
    return "refreshed";
  }
  list.push(inst);
  return "stacked";
}

/** How many stacks of a status a combatant is carrying. */
export function stacksOf(list: StatusInstance[], id: string): number {
  return list.reduce((n, s) => (s.id === id ? n + s.stacks : n), 0);
}

/** A continuous effect as it is read: with its stacks and its snapshots. */
export interface ReadEffect {
  effect: StatusEffect;
  stacks: number;
  /** What the instance snapshotted, for `stat-power`. */
  power: number;
  /** The stat line it was measured against, for `stat-boost`. */
  basis?: Partial<Record<StatName, number>>;
}

/**
 * Effects read where they matter rather than fired when something happens.
 * Shared, so nothing has to keep a second list of them in step with this one.
 */
const CONTINUOUS = new Set<StatusEffect["kind"]>([
  "stat-add", "stat-set", "stat-scale", "stat-share", "stat-offset", "stat-power",
  "stat-boost", "immune", "vulnerable", "frail", "element-power", "root", "no-hyper", "no-spells", "echo", "ward", "soften",
  "mark-power",
  "mark-worth", "heal-bonus",
]);

export function isContinuous(kind: StatusEffect["kind"]): boolean {
  return CONTINUOUS.has(kind);
}

/**
 * Continuous effects, in the order they should be applied. `worth` is how
 * effective each status is where it sits, for a holder under something that
 * makes its statuses stronger or weaker.
 */
export function continuousEffects(list: StatusInstance[], worth?: (inst: StatusInstance) => number): ReadEffect[] {
  const out: ReadEffect[] = [];
  for (const inst of list) {
    const def = STATUSES[inst.id];
    if (!def) continue;
    const w = worth ? worth(inst) : 1;
    const scale = (inst.scale ?? 1) * w;
    for (const effect of def.effects) {
      if (isContinuous(effect.kind)) {
        out.push({
          effect: scale === 1 ? effect : shrink(effect, scale),
          stacks: inst.stacks,
          power: (inst.power ?? 0) * w,
          ...(inst.basis ? { basis: inst.basis } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Every multiple a list of statuses puts on attacks of one element, named by
 * whatever does it. The battle multiplies these into a hit; a readout wants
 * them one at a time, so a player can see which mark is behind the number.
 */
export function elementPowers(
  list: StatusInstance[],
  element: ElementType,
  worth?: (inst: StatusInstance) => number,
): { name: string; mult: number }[] {
  const out: { name: string; mult: number }[] = [];
  for (const inst of list) {
    const def = STATUSES[inst.id];
    if (!def) continue;
    const scale = (inst.scale ?? 1) * (worth ? worth(inst) : 1);
    for (const raw of def.effects) {
      if (!isContinuous(raw.kind)) continue;
      const effect = scale === 1 ? raw : shrink(raw, scale);
      if (effect.kind !== "element-power" || effect.element !== element) continue;
      out.push({ name: def.name, mult: Math.pow(effect.mult, inst.stacks) });
    }
  }
  return out;
}

/**
 * How effective the holder's own statuses of one polarity are made by what it
 * carries: a status that says the marks on it hit harder.
 */
export function selfWorth(list: StatusInstance[], polarity: StatusPolarity): number {
  let mult = 1;
  for (const inst of list) {
    for (const effect of STATUSES[inst.id]?.effects ?? []) {
      if (effect.kind === "mark-worth" && effect.reach === "self" && effect.polarity === polarity) {
        mult *= Math.pow(effect.mult, inst.stacks);
      }
    }
  }
  return mult;
}

/**
 * Whether a status is one a `mark-worth` effect can reach: anything, passives
 * included, except a status written to stay as it is and one that is itself a
 * `mark-worth`.
 */
export function worthReaches(inst: StatusInstance): boolean {
  const def = STATUSES[inst.id];
  if (!def || def.asWritten) return false;
  return !def.effects.some((e) => e.kind === "mark-worth");
}

/**
 * One effect worth `scale` of itself, for an echo. A share of a stat is that
 * much of a share; a multiplier moves that much of the way from 1, so a
 * quarter-strength x0.5 is x0.875 rather than x0.125.
 */
export function shrink(effect: StatusEffect, scale: number): StatusEffect {
  switch (effect.kind) {
    case "stat-add":
    case "stat-offset":
      return { ...effect, amount: effect.amount * scale };
    case "stat-share":
      return { ...effect, frac: effect.frac * scale };
    case "stat-scale":
    case "vulnerable":
    case "frail":
    case "element-power":
    case "mark-power":
      return { ...effect, mult: 1 + (effect.mult - 1) * scale };
    case "stat-boost":
      return { ...effect, frac: effect.frac * scale, flat: effect.flat * scale };
    case "echo":
      return { ...effect, frac: effect.frac * scale };
    // Never past the whole hit.
    case "soften":
      return { ...effect, frac: Math.min(1, effect.frac * scale) };
    case "heal-bonus":
      return { ...effect, flatAtCeiling: effect.flatAtCeiling * scale };
    default:
      return effect;
  }
}

/** What a `mana` step gives at `scale`, in whole points of mana. */
export const manaAt = (amount: number, scale: number): number => Math.round(amount * scale);

/** Is anything the holder carries stopping it being called back? */
export function isRooted(list: StatusInstance[]): boolean {
  return list.some((inst) => STATUSES[inst.id]?.effects.some((e) => e.kind === "root") === true);
}

/** The first root the holder is carrying, for naming what is holding it. */
export function rootedBy(list: StatusInstance[]): string | null {
  const held = list.find((inst) => STATUSES[inst.id]?.effects.some((e) => e.kind === "root") === true);
  return held ? STATUSES[held.id]?.name ?? held.id : null;
}

/**
 * Base stats with a set of continuous effects folded in: sets first so a later
 * set does not lose to an earlier add, then adds, then shares, then scales.
 * Scaling last is what makes a Rage stack keep its quarter of whatever Strength
 * has since become; shares are measured off one snapshot taken after the adds,
 * so a pair of them cannot feed each other. Shared so a Scoba's stats read the
 * same in a battle and out of one.
 */
export function foldStatEffects(base: Stats, effects: ReadEffect[]): Stats {
  const out = { ...base };
  for (const { effect } of effects) {
    if (effect.kind === "stat-set") out[effect.stat] = effect.value;
  }
  for (const { effect, stacks } of effects) {
    if (effect.kind === "stat-add") out[effect.stat] += effect.amount * stacks;
  }
  for (const { effect, stacks, power } of effects) {
    if (effect.kind === "stat-power") out[effect.stat] += power * effect.mult * stacks;
  }
  const measured = { ...out };
  for (const { effect, stacks } of effects) {
    if (effect.kind === "stat-share") out[effect.stat] += measured[effect.from] * effect.frac * stacks;
  }
  for (const { effect, stacks } of effects) {
    if (effect.kind === "stat-scale") out[effect.stat] = out[effect.stat] * Math.pow(effect.mult, stacks);
  }
  // Last, so a flat bonus stays flat however much scaling ran before it.
  for (const { effect, stacks, basis } of effects) {
    if (effect.kind === "stat-offset") out[effect.stat] += effect.amount * stacks;
    if (effect.kind === "stat-boost") {
      out[effect.stat] += boostFrom(effect.frac, effect.flat, basis?.[effect.stat] ?? 0) * stacks;
    }
  }
  // Each stat stops where it is allowed to stop, which is not the same place
  // for all six: see `STAT_FLOOR`.
  for (const name of STAT_NAMES) {
    const floor = STAT_FLOOR[name];
    const v = Math.floor(out[name]);
    out[name] = floor === null ? v : Math.max(floor, v);
  }
  return out;
}

/** How much a second cast is worth to this holder, or 0 where nothing echoes. */
export function echoFrac(list: StatusInstance[], worth?: (inst: StatusInstance) => number): number {
  let frac = 0;
  for (const read of continuousEffects(list, worth)) {
    if (read.effect.kind === "echo" && read.effect.frac > frac) frac = read.effect.frac;
  }
  return frac;
}

/** Whether anything the holder carries has closed Hyper-Mode off. */
export function hyperShut(list: StatusInstance[]): boolean {
  return list.some((inst) => STATUSES[inst.id]?.effects.some((e) => e.kind === "no-hyper"));
}

/** The first status that stops the holder casting moves, for naming it, or null. */
export function spellsShutBy(list: StatusInstance[]): StatusDef | null {
  for (const inst of list) {
    const def = STATUSES[inst.id];
    if (def?.effects.some((e) => e.kind === "no-spells")) return def;
  }
  return null;
}

/** The first status holding a ward against this element, if anything does. */
export function wardAgainst(list: StatusInstance[], element: ElementType): StatusInstance | null {
  for (const inst of list) {
    if (inst.chargesLeft === 0) continue;
    const def = STATUSES[inst.id];
    if (!def) continue;
    if (def.effects.some((e) => e.kind === "ward" && e.element === element)) return inst;
  }
  return null;
}

/** The first status cutting the next hit down, if anything does, and by how much. */
export function softenOn(
  list: StatusInstance[], worth?: (inst: StatusInstance) => number,
): { inst: StatusInstance; frac: number } | null {
  for (const inst of list) {
    if (inst.chargesLeft === 0) continue;
    const found = continuousEffects([inst], worth).find((r) => r.effect.kind === "soften");
    if (found?.effect.kind === "soften") return { inst, frac: found.effect.frac };
  }
  return null;
}

/**
 * What actually happened, as opposed to what a status is listening for. A hit
 * is one event carrying its category and element rather than three separate
 * ones, so a status watching for any hit fires once per hit and not once per
 * way of describing it.
 */
export type TriggerEvent =
  | { on: "battle-start" }
  | { on: "turn-start" }
  | { on: "turn-end" }
  | { on: "basic-attack" }
  | { on: "use-ability" }
  | { on: "block" }
  | { on: "hit"; category: DamageCategory | "mixed"; element: ElementType; spell: boolean }
  | { on: "deal"; category: DamageCategory | "mixed"; element: ElementType; spell: boolean }
  | { on: "kill-attack" }
  | { on: "death" }
  | { on: "switch-in" }
  | { on: "ally-death" }
  | { on: "enemy-death" }
  | { on: "hp-below"; frac: number };

/** Does this status's trigger answer what just happened? */
export function triggerMatches(def: StatusDef, event: TriggerEvent): boolean {
  return triggerFits(def.trigger, event);
}

/** Whether one trigger answers an event. */
export function triggerFits(t: StatusTrigger, event: TriggerEvent): boolean {
  if (t.on === "passive") return false;
  if (event.on === "hit") {
    switch (t.on) {
      case "hit-any": return true;
      case "hit-magic": return countsAs(event.category, "magic");
      case "hit-physical": return countsAs(event.category, "physical");
      case "hit-element": return t.element === event.element;
      default: return false;
    }
  }
  if (event.on === "deal") {
    switch (t.on) {
      case "deal-any": return true;
      case "deal-magic": return countsAs(event.category, "magic");
      case "deal-physical": return countsAs(event.category, "physical");
      case "deal-spell": return event.spell;
      case "deal-element":
        return event.element === t.element && (t.category === undefined || countsAs(event.category, t.category));
      default: return false;
    }
  }
  // Anyone but the holder: the fainted Scoba answers its own `death` instead.
  if (t.on === "any-death") return event.on === "ally-death" || event.on === "enemy-death";
  if (t.on !== event.on) return false;
  if (t.on === "hp-below" && event.on === "hp-below") return event.frac <= t.frac;
  return true;
}

/** Drops statuses that do not travel with a Scoba being pulled out. */
export function onSwitchOut(list: StatusInstance[]): StatusInstance[] {
  return list.filter((s) => STATUSES[s.id]?.persists === true);
}

/** Ticks durations at end of turn and clears anything that has run out. */
export function tickDurations(list: StatusInstance[], turn: number): StatusInstance[] {
  for (const s of list) {
    // A mark that landed this turn has not stood for a turn yet.
    if (s.since === turn) continue;
    if (s.turnsLeft > 0) s.turnsLeft -= 1;
  }
  return list.filter((s) => s.turnsLeft !== 0 && s.chargesLeft !== 0);
}

/**
 * Does a mark that landed this turn answer this event? A turn's own beats are
 * held off until the turn after it arrived; everything else, a hit or a block
 * or a death, it answers at once.
 */
export function ticksThisTurn(inst: StatusInstance, event: TriggerEvent, turn: number): boolean {
  if (inst.since !== turn) return true;
  return event.on !== "turn-end" && event.on !== "turn-start";
}
