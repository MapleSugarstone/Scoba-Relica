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
import { STAT_FLOOR, STAT_NAMES, type ElementType, type StatName, type Stats } from "./types";

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
  | { kind: "summon"; species: string; level: number }
  /** Tops the holder's mana up. */
  | { kind: "mana"; amount: number }
  /**
   * Hangs another status on whoever the scope names. `turns` overrides how
   * long that mark stands, for a source that leaves it on longer or shorter
   * than the mark's own clock says.
   */
  | { kind: "inflict"; status: string; scope: InflictScope; turns?: number }
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
  | { kind: "copy-statuses" }
  /** The holder cannot be called back. Read where a switch is offered. */
  | { kind: "root" };

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
  | "all"
  /** Everyone on both sides but the holder itself. */
  | "others";

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
   * bites harder than the same mark left by a small one.
   */
  power?: { basis: Basis; frac: number };
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
  /** The stat line it was measured against when it landed, for `stat-boost`. */
  basis?: Partial<Record<StatName, number>>;
  /**
   * The turn it landed on. A mark does not tick on the turn it is applied:
   * neither its own clock nor whatever it does each turn, so a mark that lasts
   * three turns bites on the three turns after the one that put it there
   * rather than on the one it arrived on.
   */
  since?: number;
  /** Who put it there, so a tick's kill is credited to them. */
  from?: { side: 0 | 1; index: number };
}

const S = (def: StatusDef): StatusDef => def;

/** What Hyper-Mode adds: a quarter of the Scoba's own line, and a flat 15. */
export const HYPER_SCALE = 0.25;
export const HYPER_FLAT = 15;

/** One stat's worth of a `stat-boost`, measured against the line it snapshotted. */
export function boostFrom(frac: number, flat: number, basis: number): number {
  return Math.round(basis * frac) + flat;
}

/**
 * An ability's status: innate, indefinite, and never taken off the Scoba
 * carrying it. Everything a passive does is written as effects, so an ability
 * and a spell leave the same kind of mark and are read the same way.
 */
const P = (
  id: string, name: string,
  effects: StatusEffect[],
  extra: { trigger?: StatusTrigger; charges?: number } = {},
): StatusDef => ({
  id, name,
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
export const EZ_STAT_BONUS = 3;

export const STATUSES: Record<string, StatusDef> = Object.fromEntries(
  [
    S({
      id: "ez",
      name: "EZ Mode",
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
      id: "sticky",
      name: "Sticky Treat",
      polarity: "bad",
      trigger: { on: "passive" },
      // A mark does not tick on the turn it lands, so one turn here is the one
      // turn after the spell that stuck it on, which is what the passive says.
      duration: 1,
      charges: null,
      stacks: false,
      maxStacks: 1,
      persists: true,
      effects: [{ kind: "root" }],
    }),
    S({
      id: "slowed",
      name: "Slowed",
      polarity: "bad",
      trigger: { on: "passive" },
      duration: null,
      charges: null,
      stacks: true,
      maxStacks: 6,
      persists: false,
      power: { basis: "source-mag", frac: 0.3 },
      effects: [{ kind: "stat-power", stat: "spd", mult: -1 }],
    }),
    S({
      id: "cold",
      name: "Cold",
      polarity: "bad",
      trigger: { on: "turn-end" },
      duration: 3,
      charges: null,
      stacks: false,
      maxStacks: 1,
      persists: true,
      effects: [{ kind: "inflict", status: "chill", scope: "self" }],
    }),
    S({
      id: "chill",
      name: "Chill",
      polarity: "bad",
      trigger: { on: "passive" },
      duration: null,
      charges: null,
      stacks: true,
      maxStacks: 10,
      persists: false,
      power: { basis: "source-mag", frac: 0.1 },
      effects: [{ kind: "stat-power", stat: "spd", mult: -1 }],
    }),
    S({
      id: "hyper",
      name: "Hyper-Mode",
      polarity: "good",
      trigger: { on: "passive" },
      duration: null,
      charges: null,
      stacks: false,
      maxStacks: 1,
      persists: true,
      effects: STAT_NAMES.map((stat) =>
        ({ kind: "stat-boost", stat, frac: HYPER_SCALE, flat: HYPER_FLAT } as StatusEffect)),
    }),
    S({
      id: "spite",
      name: "Spite",
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
    P("swift", "Swift", [scale("spd", 1.2)]),
    P("brawn", "Brawn", [scale("str", 1.15)]),
    P("thick-coat", "Thick Coat", [scale("def", 1.2)]),
    P("warded", "Warded", [scale("res", 1.2)]),
    P("mystic", "Mystic", [scale("mag", 1.15)]),
    P("hearty", "Hearty", [scale("hp", 1.15)]),
    P("old-soul", "Old Soul", [scale("mag", 1.15)]),
    P("shifting", "Shifting", [scale("spd", 1.15), scale("res", 1.1)]),
    P("encrypted", "Encrypted", [scale("res", 1.25)]),
    P("far-sight", "Far Sight", [scale("mag", 1.2)]),
    P("sweet-tooth", "Sweet Tooth", [scale("hp", 1.2)]),
    P("plainspoken", "Plainspoken", [scale("str", 1.15), scale("def", 1.1)]),
    P("moss-skin", "Moss Skin",
      [regen(1 / 16)], { trigger: { on: "turn-end" } }),
    P("rooted", "Rooted",
      [scale("def", 1.1), regen(1 / 16)], { trigger: { on: "turn-end" } }),
    P("sun-heart", "Sun Heart", [typePower("sun", 1.25)]),
    P("flux-heart", "Flux Heart", [typePower("flux", 1.25)]),
    P("moss-heart", "Moss Heart", [typePower("moss", 1.25)]),
    P("moonlit", "Moonlit", [typePower("moon", 1.25)]),
    P("lucky", "Lucky", [typePower("fortuna", 1.25)]),

    // Catsquito drinks what it hits, and never sits still.
    P("thirst", "Thirst",
      [{ kind: "heal", basis: "holder-mag", frac: 1 }],
      { trigger: { on: "basic-attack" } }),
    P("restless", "Restless",
      [scale("spd", 1.1), scale("str", 1.1)]),

    // Meepa wears magic defence down and opens with more mana.
    P("moonwane", "Moonwane",
      [{ kind: "inflict", status: "wane", scope: "other" }],
      { trigger: { on: "deal-magic" } }),
    P("moonwell", "Moonwell",
      [{ kind: "mana", amount: 10 }],
      { trigger: { on: "battle-start" }, charges: 1 }),

    // Cottlequeen brings her court out with her, and quickens as she braces.
    P("cottle-court", "Cottle Court",
      [{ kind: "summon", species: "cottlecorn", level: 1 }],
      { trigger: { on: "switch-in" }, charges: 1 }),
    P("queens-guard", "Queen's Guard",
      [{ kind: "inflict", status: "quickstep", scope: "self" }],
      { trigger: { on: "block" } }),

    // Cottlecorn wears its horn down on whatever it hits.
    P("piercing-horn", "Piercing Horn",
      [{ kind: "inflict", status: "gored", scope: "other" }],
      { trigger: { on: "basic-attack" } }),

    // The Octoshake line. Its spells stick, its cherry is spent once, and its
    // Hyper-Mode pins the whole field in place.
    P("sticky-treat", "Sticky Treat",
      [{ kind: "inflict", status: "sticky", scope: "other" }],
      { trigger: { on: "deal-spell" } }),
    P("sticky-mess", "Sticky Mess",
      // Twice as long as the passive leaves it: the mode is what makes the
      // whole field stick rather than one Scoba at a time.
      [{ kind: "inflict", status: "sticky", scope: "others", turns: 2 }],
      { trigger: { on: "switch-in" }, charges: 1 }),

    // Cactunny blesses the whole field and eats one Sun hit.
    P("sun-bloom", "Sun Bloom",
      [{ kind: "field", field: "sunblessed", scope: "both" }],
      { trigger: { on: "switch-in" }, charges: 1 }),
    P("sun-ward", "Sun Ward",
      [{ kind: "ward", element: "sun" }],
      { charges: 1 }),

    // --- what those passives leave on everyone else ---
    S({
      id: "wane",
      name: "Waning",
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
  "stat-boost", "immune", "vulnerable", "element-power", "root", "ward",
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
