// Statuses: the lasting effects a move or ability hangs on a Scoba.
//
// A status splits in two. Its *continuous* effects (stat changes, elemental
// immunity, vulnerability, damage bonuses) are read straight off whatever the
// combatant is carrying, every time something asks. Its *fired* effects
// (damage, healing, cleansing, summoning) go off when the status's trigger
// happens, spend a charge, and stop when the charges or the turns run out.
//
// Everything here is data. `sim/battle.ts` owns when triggers fire and how the
// numbers land.
import { STAT_NAMES, type ElementType, type StatName, type Stats } from "./types";

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
  /** The holder lands a killing blow with attack damage. */
  | { on: "kill-attack" }
  /** The holder faints. */
  | { on: "death" }
  /** The holder is sent out. */
  | { on: "switch-in" }
  /** Someone else goes down. */
  | { on: "ally-death" }
  | { on: "enemy-death" }
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

export type StatusEffect =
  | { kind: "damage"; damage: StatusDamage }
  | { kind: "heal"; basis: Basis; frac: number }
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
  | { kind: "immune"; element: ElementType }
  | { kind: "vulnerable"; element: ElementType; mult: number }
  /** The holder deals more with one element. */
  | { kind: "element-power"; element: ElementType; mult: number }
  | { kind: "summon"; species: string; level: number }
  /** Tops the holder's mana up. */
  | { kind: "mana"; amount: number }
  /** Hangs another status on whoever the scope names. */
  | { kind: "inflict"; status: string; scope: InflictScope }
  /** Lays a field over a side, replacing whatever was standing over it. */
  | { kind: "field"; field: string; scope: FieldScope }
  /**
   * Eats one instance of an element outright. Read where damage lands rather
   * than fired, and spends a charge when it catches something.
   */
  | { kind: "ward"; element: ElementType }
  | { kind: "grant-item"; item: string; count: number }
  | { kind: "cleanse"; polarity: StatusPolarity }
  /** Copies the holder's statuses onto whoever set this off. */
  | { kind: "copy-statuses" };

export type StatusPolarity = "good" | "bad";

/** Which side a field lands on, relative to whoever called it up. */
export type FieldScope = "allies" | "enemies" | "both";

/** Who a status's `inflict` effect reaches, relative to its holder. */
export type InflictScope =
  | "self"
  /** Whoever was on the far side of the trigger. */
  | "other"
  | "allies"
  | "enemies"
  | "all";

export interface StatusDef {
  id: string;
  name: string;
  desc: string;
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
   * A passive the Scoba was born with rather than something done to it. Innate
   * statuses are never cleansed, never copied, and are left off the tag row,
   * since the ability they belong to is already named on the Scoba's card.
   */
  innate?: boolean;
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
  /** Who put it there, so a tick's kill is credited to them. */
  from?: { side: 0 | 1; index: number };
}

const S = (def: StatusDef): StatusDef => def;

/**
 * An ability's status: innate, indefinite, and never taken off the Scoba
 * carrying it. Everything a passive does is written as effects, so an ability
 * and a spell leave the same kind of mark and are read the same way.
 */
const P = (
  id: string, name: string, desc: string,
  effects: StatusEffect[],
  extra: { trigger?: StatusTrigger; charges?: number } = {},
): StatusDef => ({
  id, name, desc,
  polarity: "good",
  trigger: extra.trigger ?? { on: "passive" },
  duration: null,
  charges: extra.charges ?? null,
  stacks: false,
  maxStacks: 1,
  persists: true,
  innate: true,
  effects,
});

const scale = (stat: StatName, mult: number): StatusEffect => ({ kind: "stat-scale", stat, mult });
const typePower = (element: ElementType, mult: number): StatusEffect =>
  ({ kind: "element-power", element, mult });
const regen = (frac: number): StatusEffect => ({ kind: "heal", basis: "holder-max-hp", frac });

/**
 * EZ mode's leg-up. Hung on the players' own Scobas as a battle opens and
 * gone with the battle, so nothing it does outlives the fight. One stack per
 * level over the first, which is what makes it read as a bigger gain per
 * level rather than a flat bonus.
 */
const EZ_STAT_BONUS = 3;

export const STATUSES: Record<string, StatusDef> = Object.fromEntries(
  [
    S({
      id: "ez",
      name: "EZ Mode",
      desc: `Every level is worth ${EZ_STAT_BONUS + 1} to each stat instead of 1, for this battle.`,
      polarity: "good",
      trigger: { on: "passive" },
      duration: null,
      charges: null,
      stacks: true,
      maxStacks: 99,
      persists: true,
      effects: STAT_NAMES.map((stat) => ({ kind: "stat-add", stat, amount: EZ_STAT_BONUS })),
    }),
    S({
      id: "fire",
      name: "Fire",
      desc: "Burns for Sun magic at the end of each turn. Stacks.",
      polarity: "bad",
      trigger: { on: "turn-end" },
      duration: 3,
      charges: null,
      stacks: true,
      maxStacks: 99,
      persists: true,
      effects: [{
        kind: "damage",
        damage: {
          basis: "source-mag",
          frac: 0.15,
          element: "sun",
          category: "magic",
          damageClass: "status",
          triggersOnHit: false,
          snapshot: true,
        },
      }],
    }),
    S({
      id: "fragile",
      name: "Fragile",
      desc: "Every hit taken costs a tenth of its pool, three times over.",
      polarity: "bad",
      trigger: { on: "hit-any" },
      duration: 5,
      charges: 3,
      stacks: false,
      maxStacks: 1,
      persists: true,
      effects: [{
        kind: "damage",
        damage: {
          basis: "holder-max-hp",
          frac: 0.1,
          element: "plain",
          category: "true",
          damageClass: "attack",
          triggersOnHit: false,
          snapshot: false,
        },
      }],
    }),
    S({
      id: "rage",
      name: "Rage",
      desc: "Strength +25% per stack, up to six. Lost on switching out.",
      polarity: "good",
      trigger: { on: "passive" },
      duration: null,
      charges: null,
      stacks: true,
      maxStacks: 6,
      persists: false,
      effects: [{ kind: "stat-scale", stat: "str", mult: 1.25 }],
    }),
    S({
      id: "guard",
      name: "Guard",
      desc: "Defense +25% while it lasts.",
      polarity: "good",
      trigger: { on: "passive" },
      duration: 3,
      charges: null,
      stacks: false,
      maxStacks: 1,
      persists: false,
      effects: [{ kind: "stat-scale", stat: "def", mult: 1.25 }],
    }),
    S({
      id: "moonward",
      name: "Moonward",
      desc: "Shrugs off Moon damage entirely.",
      polarity: "good",
      trigger: { on: "passive" },
      duration: 2,
      charges: null,
      stacks: false,
      maxStacks: 1,
      persists: true,
      effects: [{ kind: "immune", element: "moon" }],
    }),
    S({
      id: "marked",
      name: "Marked",
      desc: "Takes half again as much Cipher damage.",
      polarity: "bad",
      trigger: { on: "passive" },
      duration: 3,
      charges: null,
      stacks: false,
      maxStacks: 1,
      persists: true,
      effects: [{ kind: "vulnerable", element: "cipher", mult: 1.5 }],
    }),
    S({
      id: "second-wind",
      name: "Second Wind",
      desc: "Heals a tenth of its pool when it drops below half.",
      polarity: "good",
      trigger: { on: "hp-below", frac: 0.5 },
      duration: null,
      charges: 1,
      stacks: false,
      maxStacks: 1,
      persists: true,
      effects: [{ kind: "heal", basis: "holder-max-hp", frac: 0.1 }],
    }),
    S({
      id: "spite",
      name: "Spite",
      desc: "Passes everything it is carrying to whoever struck it down.",
      polarity: "good",
      trigger: { on: "death" },
      duration: null,
      charges: 1,
      stacks: false,
      maxStacks: 1,
      persists: true,
      effects: [{ kind: "copy-statuses" }],
    }),

    // --- what an ability hangs on the Scoba that has it ---
    P("swift", "Swift", "Speed +20%.", [scale("spd", 1.2)]),
    P("brawn", "Brawn", "Strength +15%.", [scale("str", 1.15)]),
    P("thick-coat", "Thick Coat", "Defense +20%.", [scale("def", 1.2)]),
    P("warded", "Warded", "Resistance +20%.", [scale("res", 1.2)]),
    P("mystic", "Mystic", "Magic +15%.", [scale("mag", 1.15)]),
    P("hearty", "Hearty", "HP +15%.", [scale("hp", 1.15)]),
    P("old-soul", "Old Soul", "Magic +15%.", [scale("mag", 1.15)]),
    P("shifting", "Shifting", "Speed +15%, Resistance +10%.", [scale("spd", 1.15), scale("res", 1.1)]),
    P("encrypted", "Encrypted", "Resistance +25%.", [scale("res", 1.25)]),
    P("far-sight", "Far Sight", "Magic +20%.", [scale("mag", 1.2)]),
    P("sweet-tooth", "Sweet Tooth", "HP +20%.", [scale("hp", 1.2)]),
    P("plainspoken", "Plainspoken", "Strength +15%, Defense +10%.", [scale("str", 1.15), scale("def", 1.1)]),
    P("moss-skin", "Moss Skin", "Heals a sixteenth of its pool each turn.",
      [regen(1 / 16)], { trigger: { on: "turn-end" } }),
    P("rooted", "Rooted", "Defense +10%, and heals a little each turn.",
      [scale("def", 1.1), regen(1 / 16)], { trigger: { on: "turn-end" } }),
    P("sun-heart", "Sun Heart", "Sun moves +25%.", [typePower("sun", 1.25)]),
    P("flux-heart", "Flux Heart", "Flux moves +25%.", [typePower("flux", 1.25)]),
    P("moss-heart", "Moss Heart", "Moss moves +25%.", [typePower("moss", 1.25)]),
    P("moonlit", "Moonlit", "Moon moves +25%.", [typePower("moon", 1.25)]),
    P("lucky", "Lucky", "Fortuna moves +25%.", [typePower("fortuna", 1.25)]),

    // Catsquito drinks what it hits, and never sits still.
    P("thirst", "Thirst", "A basic attack drinks back its Magic in HP.",
      [{ kind: "heal", basis: "holder-mag", frac: 1 }],
      { trigger: { on: "basic-attack" } }),
    P("restless", "Restless", "Speed and Strength +10%.",
      [scale("spd", 1.1), scale("str", 1.1)]),

    // Meepa wears magic defence down and opens with more mana.
    P("moonwane", "Moonwane", "Magic damage thins what the target holds it off with.",
      [{ kind: "inflict", status: "wane", scope: "other" }],
      { trigger: { on: "deal-magic" } }),
    P("moonwell", "Moonwell", "Starts the battle with 10 extra mana.",
      [{ kind: "mana", amount: 10 }],
      { trigger: { on: "battle-start" }, charges: 1 }),

    // Cottlequeen brings her court out with her, and quickens as she braces.
    P("cottle-court", "Cottle Court", "Calls up a Cottlecorn Mote the first time she takes the field.",
      [{ kind: "summon", species: "cottlecorn", level: 1 }],
      { trigger: { on: "switch-in" }, charges: 1 }),
    P("queens-guard", "Queen's Guard", "Bracing pours a tenth of her Magic into her Speed.",
      [{ kind: "inflict", status: "quickstep", scope: "self" }],
      { trigger: { on: "block" } }),

    // Cottlecorn wears its horn down on whatever it hits.
    P("piercing-horn", "Piercing Horn", "A basic attack thins what the target holds magic off with.",
      [{ kind: "inflict", status: "gored", scope: "other" }],
      { trigger: { on: "basic-attack" } }),

    // Cactunny blesses the whole field and eats one Sun hit.
    P("sun-bloom", "Sun Bloom", "Calls up Sunblessed over both sides, once a battle.",
      [{ kind: "field", field: "sunblessed", scope: "both" }],
      { trigger: { on: "switch-in" }, charges: 1 }),
    P("sun-ward", "Sun Ward", "Shrugs off one Sun hit, once a battle.",
      [{ kind: "ward", element: "sun" }],
      { charges: 1 }),

    // --- what those passives leave on everyone else ---
    S({
      id: "wane",
      name: "Waning",
      desc: "Resistance -5% per stack, up to ten. Lost on switching out.",
      polarity: "bad",
      trigger: { on: "passive" },
      duration: null,
      charges: null,
      stacks: true,
      maxStacks: 10,
      persists: false,
      effects: [{ kind: "stat-scale", stat: "res", mult: 0.95 }],
    }),
    S({
      id: "quickstep",
      name: "Quickstep",
      desc: "Speed up by a tenth of Magic per stack, up to six. Lost on switching out.",
      polarity: "good",
      trigger: { on: "passive" },
      duration: null,
      charges: null,
      stacks: true,
      maxStacks: 6,
      persists: false,
      effects: [{ kind: "stat-share", stat: "spd", from: "mag", frac: 0.1 }],
    }),
    S({
      id: "gored",
      name: "Gored",
      desc: "Resistance -5% per stack, up to six.",
      polarity: "bad",
      trigger: { on: "passive" },
      duration: null,
      charges: null,
      stacks: true,
      maxStacks: 6,
      persists: false,
      effects: [{ kind: "stat-scale", stat: "res", mult: 0.95 }],
    }),
  ].map((s) => [s.id, s]),
);

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
  desc: string;
  /** Turns it holds. null stands until something replaces it. */
  duration: number | null;
  /** The wash laid over the half of the screen its side stands on. */
  tint: string;
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

export const FIELDS: Record<string, FieldDef> = {
  sunblessed: {
    id: "sunblessed",
    name: "Sunblessed",
    desc: "+25% damage to Sun moves.",
    duration: 5,
    tint: "#e7a03c",
    onset: "Sunlight pours over the field.",
    lifts: "The sunlight fades.",
    effects: [{ kind: "element-power", element: "sun", mult: 1.25 }],
  },
};

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
): StatusInstance | null {
  const def = STATUSES[id];
  if (!def) return null;
  return {
    id,
    turnsLeft: def.duration ?? -1,
    chargesLeft: def.charges ?? -1,
    stacks: 1,
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

/** Continuous effects, in the order they should be applied. */
export function continuousEffects(list: StatusInstance[]): { effect: StatusEffect; stacks: number }[] {
  const out: { effect: StatusEffect; stacks: number }[] = [];
  for (const inst of list) {
    const def = STATUSES[inst.id];
    if (!def) continue;
    for (const effect of def.effects) {
      if (effect.kind === "stat-add" || effect.kind === "stat-set" || effect.kind === "stat-scale"
        || effect.kind === "stat-share"
        || effect.kind === "immune" || effect.kind === "vulnerable" || effect.kind === "element-power") {
        out.push({ effect, stacks: inst.stacks });
      }
    }
  }
  return out;
}

/**
 * Base stats with a set of continuous effects folded in: sets first so a later
 * set does not lose to an earlier add, then adds, then shares, then scales.
 * Scaling last is what makes a Rage stack keep its quarter of whatever Strength
 * has since become; shares are measured off one snapshot taken after the adds,
 * so a pair of them cannot feed each other. Shared so a Scoba's stats read the
 * same in a battle and out of one.
 */
export function foldStatEffects(base: Stats, effects: { effect: StatusEffect; stacks: number }[]): Stats {
  const out = { ...base };
  for (const { effect } of effects) {
    if (effect.kind === "stat-set") out[effect.stat] = effect.value;
  }
  for (const { effect, stacks } of effects) {
    if (effect.kind === "stat-add") out[effect.stat] += effect.amount * stacks;
  }
  const measured = { ...out };
  for (const { effect, stacks } of effects) {
    if (effect.kind === "stat-share") out[effect.stat] += measured[effect.from] * effect.frac * stacks;
  }
  for (const { effect, stacks } of effects) {
    if (effect.kind === "stat-scale") out[effect.stat] = out[effect.stat] * Math.pow(effect.mult, stacks);
  }
  for (const name of STAT_NAMES) out[name] = Math.max(1, Math.floor(out[name]));
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
  | { on: "hit"; category: DamageCategory; element: ElementType }
  | { on: "deal"; category: DamageCategory; element: ElementType }
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
      default: return false;
    }
  }
  if (t.on !== event.on) return false;
  if (t.on === "hp-below" && event.on === "hp-below") return event.frac <= t.frac;
  return true;
}

/** Drops statuses that do not travel with a Scoba being pulled out. */
export function onSwitchOut(list: StatusInstance[]): StatusInstance[] {
  return list.filter((s) => STATUSES[s.id]?.persists === true);
}

/** Ticks durations at end of turn and clears anything that has run out. */
export function tickDurations(list: StatusInstance[]): StatusInstance[] {
  for (const s of list) {
    if (s.turnsLeft > 0) s.turnsLeft -= 1;
  }
  return list.filter((s) => s.turnsLeft !== 0 && s.chargesLeft !== 0);
}
