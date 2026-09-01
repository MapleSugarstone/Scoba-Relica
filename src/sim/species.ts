import type { ElementType, Stats } from "./types";
import type { TargetSpec } from "./targeting";
import type { StatusPolarity } from "./status";
import { BASE_GENES, TYPE_LABELS, effectiveness, stats } from "./types";

// Spells cost mana (battles start at 40, +20 per turn, cap 100) and may have
// a cooldown (turns to wait after use) and a starting cooldown (turns to wait
// at battle start). Damage scales off Strength for physical, Magic for
// magical. Block and the basic attack are innate, not moves.
/**
 * What a move does past its own hit. `target` and `from`/`to` are indices
 * into the move's `targets` list, which is how a two-target move says which
 * of the two it is talking about.
 */
export type MoveEffect =
  | { kind: "status"; target: number; status: string }
  | { kind: "damage"; target: number; scale: number }
  | { kind: "heal"; target: number; frac: number }
  /**
   * Takes a share of one target's current HP and delivers it to the other,
   * either as healing or as a hit. The sacrifice moves are built from this.
   */
  | { kind: "transfer"; from: number; to: number; frac: number; deliver: "damage" | "heal" }
  | { kind: "cleanse"; target: number; polarity: StatusPolarity }
  | { kind: "copy-statuses"; from: number; to: number }
  | { kind: "summon"; species: string; level: number }
  | { kind: "grant-item"; item: string; count: number };

/**
 * How the caster carries itself while the move goes off. Physical moves
 * default to `lunge`, magic to `cast`, healing and utility to `focus`.
 */
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

/** What is drawn, and where it travels. */
export type MoveVfx =
  /** Straight shot from caster to target, then a burst. */
  | "bolt"
  /** Arcing shot that bursts where it lands. */
  | "lob"
  /** A burst on the target with nothing thrown. */
  | "burst"
  /** Licking flames over the target. */
  | "flames"
  /** A halo on whoever it lands on. */
  | "glow"
  /** A line drawn straight through, all at once. */
  | "beam";

export interface Move {
  id: string;
  name: string;
  type: ElementType;
  /** `utility` has no hit of its own and does its work through `effects`. */
  kind: "physical" | "magical" | "heal" | "utility";
  /** Damage: fraction of Str/Mag dealt (1.1 = 110%). Heal: fraction of max HP. */
  scale: number;
  manaCost: number;
  cooldown: number;
  startCooldown: number;
  /**
   * What it asks you to aim at, in order. The move's own hit or heal lands on
   * the first entry; every move has at least one, so picking a move always
   * asks for a target even when only one thing can be hit.
   */
  targets: TargetSpec[];
  effects?: MoveEffect[];
  /** Overrides the animation its kind would otherwise get. */
  anim?: CasterAnim;
  vfx?: MoveVfx;
}

/**
 * A passive. What it does lives in the status system: sending a Scoba out
 * hangs its abilities' statuses on it, and everything from there on reads
 * those the same way it reads a burn or a buff. `statuses` defaults to the
 * ability's own id, which is what most of them are named after.
 */
export interface Ability {
  id: string;
  name: string;
  desc: string;
  statuses?: string[];
}

/** The statuses an ability puts on its Scoba. */
export function abilityStatuses(id: string): string[] {
  const ability = ABILITIES[id];
  if (!ability) return [];
  return ability.statuses ?? [ability.id];
}

/**
 * How a critter carries itself in the overworld. `hop` is the player's own
 * gait; `scamper` is the same hop a little quicker and is what Scobas use
 * unless they are given something else. Numbers live in `game/actors.ts`.
 */
export type MovementStyle = "hop" | "scamper" | "hover" | "skitter";

/**
 * `art` is a 118x139 sprite drawn on the same canvas and feet line as the
 * character doll. `placeholder` stands in for species whose art is not drawn
 * yet: a blob in the species' type color.
 */
export type SpriteDef =
  | { kind: "art"; art: string }
  | { kind: "placeholder" };

export interface Species {
  id: string;
  name: string;
  type: ElementType;
  /** A second type, defended with and attacked from alongside the first. */
  type2?: ElementType;
  genes: Stats;
  primaryAbility: string;
  secondaryPool: string[];
  learnset: { level: number; move: string }[];
  sprite: SpriteDef;
  movement: MovementStyle;
  /**
   * Which form this is. Only a first form can be raised with Aetus; anything
   * further has to be earned by evolving into it.
   */
  stage?: number;
  /** The species it becomes when it evolves, if there is one yet. */
  evolvesTo?: string;
  /** Blurb for the starter picker. */
  blurb?: string;
  /** One per primary type; offered at the start of a new game. */
  starter?: boolean;
  special?: boolean;
  /**
   * A Pawn: never caught, never bred, never in a party. It only ever reaches
   * the field by being summoned onto a Pawn slot, and it never leaves one, so
   * it is drawn smaller and read off a smaller card.
   */
  pawn?: boolean;
  /**
   * Pawns only. Nobody picks its actions: it runs the same AI the enemy team
   * does, on a seed of its own.
   */
  autonomous?: boolean;
}

const M = (
  id: string, name: string, type: ElementType, kind: Move["kind"],
  scale: number, manaCost: number, cooldown = 0, startCooldown = 0,
  extra: { targets?: TargetSpec[]; effects?: MoveEffect[]; anim?: CasterAnim; vfx?: MoveVfx } = {},
): Move => ({
  id, name, type, kind, scale, manaCost, cooldown, startCooldown,
  targets: extra.targets ?? [{ mode: kind === "heal" ? "any-ally" : "any-enemy" }],
  ...(extra.effects ? { effects: extra.effects } : {}),
  ...(extra.anim ? { anim: extra.anim } : {}),
  ...(extra.vfx ? { vfx: extra.vfx } : {}),
});

/** The animation a move falls back on when it names none. */
export function animOf(move: Move | null): CasterAnim {
  if (!move) return "lunge";
  if (move.anim) return move.anim;
  if (move.kind === "physical") return "lunge";
  if (move.kind === "magical") return "shake";
  return "focus";
}

export function vfxOf(move: Move | null): MoveVfx {
  if (!move) return "burst";
  if (move.vfx) return move.vfx;
  if (move.kind === "physical") return "burst";
  if (move.kind === "magical") return "bolt";
  if (move.kind === "heal") return "glow";
  return "glow";
}

export const MOVES: Record<string, Move> = Object.fromEntries(
  [
    M("crush", "Crush", "plain", "physical", 1.1, 30, 0, 0, { anim: "lunge", vfx: "burst" }),
    M("slam", "Slam", "plain", "physical", 1.5, 45, 1, 0, { anim: "rear", vfx: "burst" }),
    M("nuzzle-nap", "Nuzzle Nap", "plain", "heal", 0.5, 60, 3, 2, { anim: "focus", vfx: "glow" }),
    M("moonbeam", "Moonbeam", "moon", "magical", 1.2, 35),
    M("eclipse", "Eclipse", "moon", "magical", 1.7, 55, 2, 1, { anim: "focus", vfx: "beam" }),
    M("cinder-spit", "Cinder Spit", "sun", "magical", 1.2, 35),
    M("flame-burst", "Flame Burst", "sun", "magical", 1.7, 55, 2, 1, { anim: "focus", vfx: "burst" }),
    M("tide-whip", "Tide Whip", "flux", "magical", 1.2, 35),
    M("riptide", "Riptide", "flux", "magical", 1.6, 50, 2, 0, { anim: "shake", vfx: "lob" }),
    M("leaf-flick", "Leaf Flick", "moss", "magical", 1.1, 30),
    M("vine-lash", "Vine Lash", "moss", "physical", 1.4, 40, 1, 0, { anim: "lunge", vfx: "beam" }),
    M("decode", "Decode", "cipher", "magical", 1.2, 35),
    M("null-key", "Null Key", "cipher", "physical", 1.5, 45, 1, 0, { anim: "blink", vfx: "burst" }),
    M("hex", "Hex", "mystic", "magical", 1.2, 35),
    M("third-eye", "Third Eye", "mystic", "magical", 1.6, 50, 2, 0, { anim: "focus", vfx: "beam" }),
    M("sugar-rush", "Sugar Rush", "sugar", "physical", 1.2, 35),
    M("gumsnap", "Gumsnap", "sugar", "physical", 1.5, 45, 1, 0, { anim: "lunge", vfx: "lob" }),
    M("lucky-strike", "Lucky Strike", "fortuna", "physical", 1.2, 35),
    M("jackpot", "Jackpot", "fortuna", "physical", 1.9, 60, 3, 1, { anim: "blink", vfx: "burst" }),

    // Moves built on the targeting and status systems.
    M("ember", "Ember", "sun", "magical", 0.7, 30, 1, 0, {
      anim: "shake", vfx: "flames",
      effects: [{ kind: "status", target: 0, status: "fire" }],
    }),
    M("hairline", "Hairline", "cipher", "magical", 0.8, 35, 2, 0, {
      anim: "focus", vfx: "beam",
      effects: [{ kind: "status", target: 0, status: "fragile" }],
    }),
    M("fury", "Fury", "plain", "utility", 0, 25, 1, 0, {
      anim: "rear", vfx: "glow",
      targets: [{ mode: "self", prompt: "Work up" }],
      effects: [{ kind: "status", target: 0, status: "rage" }],
    }),
    M("brace-up", "Brace Up", "moss", "utility", 0, 30, 2, 0, {
      anim: "focus", vfx: "glow",
      targets: [{ mode: "any-ally", prompt: "Shield" }],
      effects: [{ kind: "status", target: 0, status: "guard" }],
    }),
    M("scatter-shot", "Scatter Shot", "flux", "magical", 0.8, 50, 2, 1, {
      anim: "shake", vfx: "lob",
      targets: [{ mode: "enemy-team", prompt: "The whole line" }],
    }),
    M("rally", "Rally", "sugar", "heal", 0.25, 55, 3, 1, {
      anim: "focus", vfx: "glow",
      targets: [{ mode: "ally-team", prompt: "Everyone" }],
    }),
    M("wild-bolt", "Wild Bolt", "fortuna", "magical", 1.9, 40, 1, 0, {
      anim: "shake", vfx: "bolt",
      targets: [{ mode: "random-enemy", prompt: "Wherever it lands" }],
    }),
    M("snipe", "Snipe", "cipher", "physical", 1.3, 45, 2, 1, {
      anim: "blink", vfx: "burst",
      targets: [{ mode: "benched-enemy", prompt: "Reach past the front" }],
    }),
    M("mirror-mark", "Mirror Mark", "mystic", "utility", 0, 45, 3, 1, {
      anim: "focus", vfx: "beam",
      targets: [
        { mode: "any-scoba", prompt: "Copy from" },
        { mode: "any-ally", prompt: "Copy onto" },
      ],
      effects: [{ kind: "copy-statuses", from: 0, to: 1 }],
    }),
    M("cleanse", "Cleanse", "moon", "utility", 0, 35, 2, 0, {
      anim: "focus", vfx: "glow",
      targets: [{ mode: "any-ally", prompt: "Clear" }],
      effects: [{ kind: "cleanse", target: 0, polarity: "bad" }],
    }),
    M("blood-pact", "Blood Pact", "mystic", "utility", 0, 40, 3, 1, {
      anim: "rear", vfx: "beam",
      targets: [
        { mode: "other-ally", prompt: "Draw from" },
        { mode: "enemy-team", prompt: "Spend it on" },
      ],
      effects: [{ kind: "transfer", from: 0, to: 1, frac: 0.25, deliver: "damage" }],
    }),
    M("tithe", "Tithe", "moss", "utility", 0, 35, 2, 0, {
      anim: "focus", vfx: "glow",
      targets: [
        { mode: "self", prompt: "Give up" },
        { mode: "other-ally", prompt: "Pass it to" },
      ],
      effects: [{ kind: "transfer", from: 0, to: 1, frac: 0.2, deliver: "heal" }],
    }),
    M("call-swarm", "Call Swarm", "moss", "utility", 0, 60, 4, 2, {
      anim: "rear", vfx: "burst",
      targets: [{ mode: "self", prompt: "Call" }],
      effects: [{ kind: "summon", species: "catsquito", level: 5 }],
    }),
    M("forage", "Forage", "sugar", "utility", 0, 20, 3, 0, {
      anim: "shake", vfx: "glow",
      targets: [{ mode: "self", prompt: "Rummage" }],
      effects: [{ kind: "grant-item", item: "snare", count: 1 }],
    }),

    // The Cottle line. A summon of a Pawn takes the caller's own level, so the
    // level named here is only what a non-Pawn summon would come out at.
    M("court-call", "Court Call", "fortuna", "utility", 0, 50, 2, 0, {
      anim: "rear", vfx: "glow",
      targets: [{ mode: "self", prompt: "Call the court" }],
      effects: [{ kind: "summon", species: "cottlecorn", level: 1 }],
    }),
    M("pawn-dart", "Pawn Dart", "fortuna", "magical", 0.8, 20, 0, 0, {
      anim: "shake", vfx: "bolt",
    }),
    M("pawn-mend", "Pawn Mend", "fortuna", "heal", 0.12, 25, 1, 0, {
      anim: "focus", vfx: "glow",
      targets: [{ mode: "any-ally", prompt: "Patch up" }],
    }),
    // A full bar to cast and a full bar is all anything can hold, so it only
    // ever goes off on a Pawn that has spent a few turns saving for it.
    M("sunfall", "Sunfall", "sun", "magical", 2.2, 100, 2, 1, {
      anim: "rear", vfx: "beam",
    }),
  ].map((m) => [m.id, m]),
);

export const ABILITIES: Record<string, Ability> = Object.fromEntries(
  (
    [
      { id: "swift", name: "Swift", desc: "Spd +20%." },
      { id: "brawn", name: "Brawn", desc: "Str +15%." },
      { id: "thick-coat", name: "Thick Coat", desc: "Def +20%." },
      { id: "warded", name: "Warded", desc: "Res +20%." },
      { id: "mystic", name: "Mystic", desc: "Mag +15%." },
      { id: "hearty", name: "Hearty", desc: "HP +15%." },
      { id: "moss-skin", name: "Moss Skin", desc: "Heals a little each turn." },
      { id: "old-soul", name: "Old Soul", desc: "Mag +15%." },
      { id: "sun-heart", name: "Sun Heart", desc: "Sun moves +25%." },
      { id: "flux-heart", name: "Flux Heart", desc: "Flux moves +25%." },
      { id: "moss-heart", name: "Moss Heart", desc: "Moss moves +25%." },
      // Starter passives.
      { id: "moonlit", name: "Moonlit", desc: "Moon moves +25%." },
      { id: "shifting", name: "Shifting", desc: "Spd +15%, Res +10%." },
      { id: "rooted", name: "Rooted", desc: "Def +10% and heals a little each turn." },
      { id: "encrypted", name: "Encrypted", desc: "Res +25%." },
      { id: "far-sight", name: "Far Sight", desc: "Mag +20%." },
      { id: "sweet-tooth", name: "Sweet Tooth", desc: "HP +20%." },
      { id: "lucky", name: "Lucky", desc: "Fortuna moves +25%." },
      { id: "plainspoken", name: "Plainspoken", desc: "Str +15%, Def +10%." },
      // The wilds. Each carries two of these: a signature primary, and a
      // secondary its pool always hands over, so every one of the line has
      // both halves of what it is.
      { id: "thirst", name: "Thirst", desc: "A basic attack drinks back its Magic in HP." },
      { id: "restless", name: "Restless", desc: "Spd and Str +10%." },
      {
        id: "moonwane", name: "Moonwane",
        desc: "Magic damage cuts the target's Res by 5%, ten times over.",
      },
      { id: "moonwell", name: "Moonwell", desc: "Starts a battle with 10 extra mana." },
      {
        id: "sun-bloom", name: "Sun Bloom",
        desc: "Calls Sunblessed up over both sides for 5 turns, once a battle.",
      },
      { id: "sun-ward", name: "Sun Ward", desc: "Shrugs off one Sun hit a battle." },
      // The Cottle line: a queen who brings her court, and the court itself.
      {
        id: "cottle-court", name: "Cottle Court",
        desc: "Calls up a Cottlecorn Pawn the first time she takes the field.",
      },
      { id: "queens-guard", name: "Queen's Guard", desc: "Bracing pours a tenth of her Magic into her Speed." },
      {
        id: "piercing-horn", name: "Piercing Horn",
        desc: "A basic attack cuts the target's Res by 5%, six times over.",
      },
    ] as Ability[]
  ).map((a) => [a.id, a]),
);

/** Which form a species is. Everything drawn so far is a first form. */
export function stageOf(sp: Species): number {
  return sp.stage ?? 1;
}

/** What it grows into, or null while nothing is drawn for it. */
export function evolutionOf(sp: Species): Species | null {
  return (sp.evolvesTo ? SPECIES[sp.evolvesTo] : undefined) ?? null;
}

/** Both of a species' types, primary first. */
export function typesOf(sp: Species): ElementType[] {
  return sp.type2 ? [sp.type, sp.type2] : [sp.type];
}

/** "Moon/Plain", for anywhere a species is named with what it is. */
export function typeLabel(sp: Species): string {
  return typesOf(sp).map((t) => TYPE_LABELS[t]).join("/");
}

/** Does an attack of this element come off one of the species' own types? */
export function isStab(sp: Species, element: ElementType): boolean {
  return typesOf(sp).includes(element);
}

/**
 * The chart multiplier against a species. A second type multiplies the first:
 * a move strong into both halves lands at 4x, and one strong into one half and
 * weak into the other comes out even.
 */
export function effectivenessAgainst(attack: ElementType, sp: Species): number {
  return typesOf(sp).reduce((mult, t) => mult * effectiveness(attack, t), 1);
}

const L = (level: number, move: string) => ({ level, move });

// One starter per primary type. Stats and passives here are first-pass
// placeholders: every line totals 32 gene points against the 30 of a plain
// line, spent differently.
const STARTERS: Species[] = [
  {
    id: "cresce", name: "Cresce", type: "moon",
    genes: stats(5, 4, 5, 6, 7, 5),
    primaryAbility: "moonlit", secondaryPool: ["mystic", "warded"],
    learnset: [L(1, "moonbeam"), L(4, "crush"), L(7, "cleanse"), L(10, "eclipse"), L(14, "nuzzle-nap")],
    sprite: { kind: "art", art: "cresce" }, movement: "scamper",
    blurb: "A tide-pull caster that leans on Magic and Resistance.",
    starter: true,
  },
  {
    id: "flarea", name: "Flarea", type: "sun",
    genes: stats(5, 6, 4, 4, 6, 7),
    primaryAbility: "sun-heart", secondaryPool: ["swift", "brawn"],
    learnset: [L(1, "cinder-spit"), L(4, "crush"), L(7, "ember"), L(10, "flame-burst"), L(14, "slam")],
    sprite: { kind: "art", art: "flarea" }, movement: "hover",
    blurb: "Quick and hot-headed, trading bulk for speed.",
    starter: true,
  },
  {
    id: "grima", name: "Grima", type: "flux",
    genes: stats(4, 5, 5, 5, 6, 7),
    primaryAbility: "shifting", secondaryPool: ["flux-heart", "swift"],
    learnset: [L(1, "tide-whip"), L(4, "crush"), L(8, "scatter-shot"), L(10, "riptide"), L(14, "hex")],
    sprite: { kind: "art", art: "grima" }, movement: "scamper",
    blurb: "Slippery and hard to pin down; strikes before it is struck.",
    starter: true,
  },
  {
    id: "obera", name: "Obera", type: "moss",
    genes: stats(7, 5, 7, 5, 4, 4),
    primaryAbility: "rooted", secondaryPool: ["moss-heart", "thick-coat"],
    learnset: [L(1, "leaf-flick"), L(4, "crush"), L(7, "brace-up"), L(10, "vine-lash"), L(12, "tithe"), L(14, "nuzzle-nap")],
    sprite: { kind: "art", art: "obera" }, movement: "hover",
    blurb: "Slow and stubborn. Outlasts more than it outhits.",
    starter: true,
  },
  {
    id: "clikkit", name: "Clikkit", type: "cipher",
    genes: stats(5, 4, 6, 7, 6, 4),
    primaryAbility: "encrypted", secondaryPool: ["warded", "mystic"],
    learnset: [L(1, "decode"), L(4, "crush"), L(8, "hairline"), L(10, "null-key"), L(13, "snipe"), L(14, "third-eye")],
    sprite: { kind: "art", art: "clikkit" }, movement: "skitter",
    blurb: "Reads the fight before it happens. Very hard to burn down.",
    starter: true,
  },
  {
    id: "wispen", name: "Wispen", type: "mystic",
    genes: stats(4, 3, 4, 6, 8, 7),
    primaryAbility: "far-sight", secondaryPool: ["mystic", "swift"],
    learnset: [L(1, "hex"), L(4, "crush"), L(9, "mirror-mark"), L(10, "third-eye"), L(12, "blood-pact"), L(14, "moonbeam")],
    sprite: { kind: "art", art: "wispen" }, movement: "hover",
    blurb: "Glass and starlight: the biggest Magic, the thinnest skin.",
    starter: true,
  },
  {
    id: "pieble", name: "Pieble", type: "sugar",
    genes: stats(8, 6, 6, 5, 4, 3),
    primaryAbility: "sweet-tooth", secondaryPool: ["hearty", "thick-coat"],
    learnset: [L(1, "sugar-rush"), L(4, "crush"), L(7, "forage"), L(10, "gumsnap"), L(12, "rally"), L(14, "slam")],
    sprite: { kind: "art", art: "pieble" }, movement: "scamper",
    blurb: "A sticky wall of a Scoba. Takes hits all day.",
    starter: true,
  },
  {
    id: "aulium", name: "Aulium", type: "fortuna",
    genes: stats(5, 6, 5, 5, 5, 6),
    primaryAbility: "lucky", secondaryPool: ["swift", "brawn"],
    learnset: [L(1, "lucky-strike"), L(4, "crush"), L(8, "wild-bolt"), L(10, "jackpot"), L(14, "slam")],
    sprite: { kind: "art", art: "aulium" }, movement: "scamper",
    blurb: "No weak spot and no specialty. Hits Plain types hardest.",
    starter: true,
  },
  {
    id: "plib", name: "Plib", type: "plain",
    genes: stats(6, 7, 6, 5, 3, 5),
    primaryAbility: "plainspoken", secondaryPool: ["brawn", "thick-coat"],
    learnset: [L(1, "crush"), L(4, "sugar-rush"), L(7, "fury"), L(10, "slam"), L(14, "nuzzle-nap")],
    sprite: { kind: "art", art: "plib" }, movement: "skitter",
    blurb: "Nothing resists it and nothing fears it. Just honest work.",
    starter: true,
  },
];

export const SPECIES: Record<string, Species> = Object.fromEntries(
  (
    [
      ...STARTERS,
      // Wilds. Every line is drawn art; there is no stand-in pack any more.
      {
        id: "catsquito", name: "Catsquito", type: "plain",
        genes: stats(4, 6, 4, 4, 6, 7),
        primaryAbility: "thirst", secondaryPool: ["restless"],
        learnset: [L(1, "crush"), L(4, "fury"), L(8, "sugar-rush"), L(12, "slam")],
        sprite: { kind: "art", art: "catsquito" }, movement: "hover",
      },
      {
        id: "meepa", name: "Meepa", type: "moon", type2: "plain",
        genes: stats(5, 4, 4, 5, 7, 5),
        primaryAbility: "moonwane", secondaryPool: ["moonwell"],
        learnset: [L(1, "moonbeam"), L(4, "crush"), L(9, "cleanse"), L(13, "eclipse")],
        sprite: { kind: "art", art: "meepa" }, movement: "hop",
      },
      {
        id: "cactunny", name: "Cactunny", type: "moss", type2: "sun",
        genes: stats(6, 5, 6, 5, 5, 3),
        primaryAbility: "sun-bloom", secondaryPool: ["sun-ward"],
        learnset: [L(1, "leaf-flick"), L(5, "ember"), L(9, "brace-up"), L(13, "cinder-spit")],
        sprite: { kind: "art", art: "cactunny" }, movement: "scamper",
      },
      {
        id: "cottlequeen", name: "Cottlequeen", type: "fortuna",
        genes: stats(6, 4, 5, 5, 7, 5),
        primaryAbility: "cottle-court", secondaryPool: ["queens-guard"],
        learnset: [L(1, "lucky-strike"), L(4, "crush"), L(6, "court-call"), L(10, "jackpot")],
        sprite: { kind: "art", art: "cottlequeen" }, movement: "hover",
      },
      // The Pawn her court is made of. Weak across the board, three moves, one
      // passive, and no way onto the field but being called.
      {
        id: "cottlecorn", name: "Cottlecorn", type: "fortuna",
        genes: stats(3, 3, 3, 3, 4, 5),
        primaryAbility: "piercing-horn", secondaryPool: [],
        learnset: [L(1, "pawn-dart"), L(1, "pawn-mend"), L(1, "sunfall")],
        sprite: { kind: "art", art: "cottlecorn" }, movement: "skitter",
        pawn: true, autonomous: true,
      },
      {
        id: "relica", name: "Relica", type: "plain",
        genes: { ...BASE_GENES },
        primaryAbility: "old-soul", secondaryPool: ["moss-skin", "mystic", "hearty"],
        learnset: [L(1, "crush"), L(1, "nuzzle-nap"), L(8, "leaf-flick"), L(15, "slam")],
        sprite: { kind: "art", art: "relica" }, movement: "scamper",
        special: true,
      },
    ] as Species[]
  ).map((s) => [s.id, s]),
);

export const STARTER_IDS: string[] = STARTERS.map((s) => s.id);

/**
 * The lines a player can actually keep. The special Scoba is nobody's and a
 * Pawn is only ever summoned, so neither belongs in the index, the world
 * editor's species list, or the pools legality derives breeding from.
 */
export function rosterSpecies(): Species[] {
  return Object.values(SPECIES).filter((sp) => !sp.special && !sp.pawn);
}

/**
 * Lines that have left the game, and what stands in their place. Saves and
 * authored worlds are older than the roster, so both read every species id
 * through here rather than trusting what they were written with.
 */
export const RETIRED_SPECIES: Record<string, string> = {
  cheepit: "catsquito",
  moovel: "cactunny",
  brookfin: "meepa",
  pyrret: "cactunny",
  emberox: "cactunny",
};

/** The species an id means today, or null if it means nothing any more. */
export function currentSpecies(id: string): string | null {
  const now = RETIRED_SPECIES[id] ?? id;
  return SPECIES[now] ? now : null;
}

/** The one special Scoba: it walks with both characters and never battles. */
export const SPECIAL = SPECIES["relica"]!;

/**
 * Every move a species knows. A Scoba starts with all of them and never picks
 * up another: a species with two entries has two slots for good, which is one
 * of the levers its balance sits on.
 *
 * The default order is cheapest first. It is only a default: breeding drops an
 * inherited move into the slot it replaced and leaves it there, because
 * statuses address a Scoba's moves by position and that slot is the point.
 */
export function speciesMoves(sp: Species): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of sp.learnset) {
    if (seen.has(entry.move) || !MOVES[entry.move]) continue;
    seen.add(entry.move);
    ids.push(entry.move);
  }
  return sortByCost(ids).slice(0, MAX_MOVES);
}

/** Move slots a Scoba can ever hold. */
export const MAX_MOVES = 4;

/** Cheapest first, ties broken by id so two clients agree on the order. */
export function sortByCost(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ma = MOVES[a];
    const mb = MOVES[b];
    if (!ma || !mb) return ma ? -1 : mb ? 1 : 0;
    return ma.manaCost - mb.manaCost || a.localeCompare(b);
  });
}

export function learnableAt(sp: Species, level: number): string[] {
  return sp.learnset.filter((l) => l.level <= level).map((l) => l.move);
}
