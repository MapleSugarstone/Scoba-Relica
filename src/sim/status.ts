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
  /** One of a move's target groups, by the order its aims are written in. */
  | { aim: number };

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
  | "focus";

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
export type ShowPath = "wheel" | "glow" | "burst" | "flames";

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
    element?: ElementType; category?: "physical" | "magic"; sound?: string;
  }
  /** A set amount, with no chart and no armor. */
  | { kind: "damage"; to: Who; damage: StatusDamage; sound?: string }
  | { kind: "heal"; to: Who; basis: Basis; frac: number; sound?: string }
  /** `turns` overrides how long the status stands. */
  | { kind: "inflict"; status: string; on: Who; turns?: number }
  | { kind: "cleanse"; on: Who; polarity: StatusPolarity }
  /** Copies every status the first of `from` carries onto each of `to`. */
  | { kind: "copy-marks"; from: Who; to: Who }
  /** Takes a share of current HP from some and spends it on others, split between them. */
  | { kind: "transfer"; from: Who; to: Who; frac: number; deliver: "damage" | "heal" }
  | { kind: "summon"; species: string; level: number }
  | { kind: "grant-item"; item: string; count: number }
  | { kind: "mana"; on: Who; amount: number }
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
  /** Takes one named status off each Scoba in `on`, however many stacks it holds. */
  | { kind: "clear-status"; status: string; on: Who }
  /** Runs `then` only if a Scoba in `fell` that was standing when the cast began is down now. */
  | { kind: "if"; fell: Who; then: Step[] }
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
  | { kind: "give-move"; to: Who; slot: number | null }
  /** A line in the battle log. `{self}`, `{target}` and `{picked}` are filled in. */
  | { kind: "say"; text: string }
  /** The costume the Scoba is seen in for the rest of the battle. */
  | { kind: "wear"; who: Who; form: string }
  | { kind: "motion"; who: Who; anim: CasterAnim }
  /**
   * Throws art from `self` at each of `to`, leaving from a piece it wears where
   * `from` names one. `sound` is the noise of it leaving, null for none.
   * `drawn` throws the drawn card as it was drawn, in place of `art`.
   */
  | {
    kind: "throw"; art?: string; drawn?: boolean; path: MoveVfx; from?: string; to: Who;
    sound?: string | null;
  }
  /** Shows art in place on or over a Scoba. `pointer` is drawn still over a wheel. */
  | { kind: "show"; art: string; path: ShowPath; on: Who; pointer?: string }
  | { kind: "sound"; name: string }
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
  /**
   * A status the holder leaves that stands for at least `minTurns` is measured
   * `mult` times over when it lands.
   */
  | { kind: "mark-power"; mult: number; minTurns: number };

export type StatusEffect = Standing | Step;

export type StatusPolarity = "good" | "bad";

/** Which side a field lands on, relative to whoever called it up. */
export type FieldScope = "allies" | "enemies" | "both";

export interface StatusDef {
  id: string;
  name: string;
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
  /** Whether it survives the holder being switched out. */
  persists: boolean;
  /**
   * A number read off the field when the status is applied and kept on the
   * instance. `stat-power` moves a stat by it, so a mark left by a big caster
   * hits harder than the same mark left by a small one.
   */
  power?: { basis: Basis; frac: number };
  /**
   * A passive the Scoba was born with rather than something done to it. Innate
   * statuses are never cleansed, never copied, and are left off the tag row,
   * since the ability they belong to is already named on the Scoba's card.
   */
  innate?: boolean;
  /** The sigil it is shown as, by file name in `assets/Sigils`. */
  icon?: string;
  /** A drawn sample for it landing, by file name in `assets/Sounds`. */
  sound?: string;
  /** Its stacks are a hand of cards, drawn over the holder's head. */
  hand?: boolean;
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
  const held = list.filter((s) => s.id === inst.id);
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
  "stat-boost", "immune", "vulnerable", "element-power", "root", "ward", "soften", "mark-power",
]);

export function isContinuous(kind: StatusEffect["kind"]): boolean {
  return CONTINUOUS.has(kind);
}

/** Continuous effects, in the order they should be applied. */
export function continuousEffects(list: StatusInstance[]): ReadEffect[] {
  const out: ReadEffect[] = [];
  for (const inst of list) {
    const def = STATUSES[inst.id];
    if (!def) continue;
    for (const effect of def.effects) {
      if (isContinuous(effect.kind)) {
        out.push({
          effect, stacks: inst.stacks, power: inst.power ?? 0,
          ...(inst.basis ? { basis: inst.basis } : {}),
        });
      }
    }
  }
  return out;
}

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
export function softenOn(list: StatusInstance[]): { inst: StatusInstance; frac: number } | null {
  for (const inst of list) {
    if (inst.chargesLeft === 0) continue;
    const def = STATUSES[inst.id];
    const found = def?.effects.find((e) => e.kind === "soften");
    if (found?.kind === "soften") return { inst, frac: found.frac };
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
  | { on: "hit"; category: DamageCategory; element: ElementType; spell: boolean }
  | { on: "deal"; category: DamageCategory; element: ElementType; spell: boolean }
  | { on: "kill-attack" }
  | { on: "death" }
  | { on: "switch-in" }
  | { on: "ally-death" }
  | { on: "enemy-death" }
  | { on: "hp-below"; frac: number };

/** Does this status's trigger answer what just happened? */
export function triggerMatches(def: StatusDef, event: TriggerEvent): boolean {
  const t = def.trigger;
  if (t.on === "passive") return false;
  if (event.on === "hit") {
    switch (t.on) {
      case "hit-any": return true;
      case "hit-magic": return event.category === "magic";
      case "hit-physical": return event.category === "physical";
      case "hit-element": return t.element === event.element;
      default: return false;
    }
  }
  if (event.on === "deal") {
    switch (t.on) {
      case "deal-any": return true;
      case "deal-magic": return event.category === "magic";
      case "deal-physical": return event.category === "physical";
      case "deal-spell": return event.spell;
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
