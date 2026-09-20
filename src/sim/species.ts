import type { ElementType, Stats } from "./types";
import type { TargetSpec } from "./targeting";
import type { Step } from "./status";
import { TYPE_LABELS, effectiveness } from "./types";
import { CONTENT_TABLES } from "./content/tables";
import SPECIES_DATA from "./content/species.json";

export type { CasterAnim, MoveVfx } from "./status";

// Spells cost mana (battles start at 40, +20 per turn, cap 100) and may have
// a cooldown (turns to wait after use) and a starting cooldown (turns to wait
// at battle start). Block and the basic attack are innate, not moves.

export interface Move {
  id: string;
  name: string;
  type: ElementType;
  /**
   * A second element, checked against the chart alongside the first and
   * granting same-type damage on its own. A move strong into both halves of a
   * defender lands at 4x, the same way a two-type species is read.
   */
  type2?: ElementType;
  /**
   * What its first hit or heal makes it, for anything that sorts moves rather
   * than casting them. Worked out from `cast` when the move is read.
   */
  kind: "physical" | "magical" | "heal" | "utility";
  /** The share its first hit or heal reads, worked out the same way. */
  scale: number;
  manaCost: number;
  cooldown: number;
  startCooldown: number;
  /**
   * What it asks you to aim at, in order. Every move has at least one, so
   * picking a move always asks for a target even when only one thing can be hit.
   */
  targets: TargetSpec[];
  /** What happens when it is cast, in order: what is drawn, what is heard and what is done. */
  cast: Step[];
  /**
   * Resolves ahead of everything slower than it, whatever the Speed either
   * side is carrying. 0 is where every ordinary move sits.
   */
  priority?: number;
  /** Casts once a battle, however much mana and cooldown would allow. */
  oncePerBattle?: boolean;
  /**
   * What it does, in words, with the numbers left in brackets for the reader to
   * hover. See `sim/prose.ts` for what a bracket may hold. A move with none
   * falls back to the long sentence the game builds out of its own data, and
   * the cosmetics editor can write over either.
   */
  text?: string;
  /** The color it is played back in, over its element's, where a rewrite gave it one. */
  tint?: string;
  /**
   * Built while a battle runs by rewriting another move, rather than read from
   * a file. `by` names the rewrite.
   */
  derived?: { from: string; by: string };
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
  statuses?: string[];
  /**
   * A move the Scoba can cast without holding it in a slot. It shows up after
   * the four it knows, and costs what the move says rather than a surcharge,
   * since the ability is what hands it over.
   */
  grantsMove?: string;
  /**
   * Art worn over a Scoba that inherited this passive from another line, by
   * file name in `assets/AccessoryScoba`. A line that has the passive of its
   * own already has it drawn in and wears nothing.
   */
  accessory?: string;
  /**
   * What it does, in words, with the numbers left in brackets for the reader to
   * hover, the same way a move carries one. A passive with none falls back to
   * the sentence the game builds out of the effects its statuses carry.
   */
  text?: string;
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
/** `teleport` never walks: it stands still, and blinks to wherever it has to be. */
export type MovementStyle = "hop" | "scamper" | "hover" | "skitter" | "moonhop" | "teleport";

/**
 * `art` is a 118x139 sprite drawn on the same canvas and feet line as the
 * character doll. `placeholder` stands in for species whose art is not drawn
 * yet: a blob in the species' type color.
 */
export type SpriteDef =
  | {
    kind: "art";
    art: string;
    /**
     * Costumes, keyed by the form tags they are worn for, sorted and joined
     * with "+". A Scoba wearing tags with nothing drawn for them falls back to
     * `art`, so a line needs a costume only for the forms it can be seen in.
     */
    forms?: Record<string, string>;
  }
  | { kind: "placeholder" };

/**
 * The tag a Scoba in Hyper-Mode wears. A Hyper costume is the line drawn again
 * from scratch rather than the same body with a piece taken off it, so anything
 * measured against the art holds for the Hyper drawings or for the ordinary
 * ones and never across the two.
 */
export const HYPER_FORM = "hyper";

/** One drawing a line can be seen in: the tags that ask for it, and its name. */
export interface Costume {
  tags: string[];
  label: string;
}

/**
 * Every costume a line can be seen in: the art it walks around in, then one per
 * set of form tags it has a drawing for.
 */
export function costumesOf(sp: Species): Costume[] {
  const out: Costume[] = [{ tags: [], label: "As drawn" }];
  if (sp.sprite.kind !== "art") return out;
  for (const key of Object.keys(sp.sprite.forms ?? {})) {
    out.push({ tags: key.split("+"), label: key.replace(/\+/g, " + ") });
  }
  return out;
}

/**
 * The costumes drawn from the same body as the one these tags ask for. Taking a
 * piece off a Scoba leaves the body where it was, so anything measured against
 * one of those drawings holds for the others. Hyper-Mode is the line drawn again
 * from scratch, so nothing measured against it carries over either way.
 */
export function kinCostumes(sp: Species, tags: readonly string[]): Costume[] {
  const hyper = tags.includes(HYPER_FORM);
  return costumesOf(sp).filter((c) => c.tags.includes(HYPER_FORM) === hyper);
}

/**
 * Which costume a set of form tags asks for. Tags are sorted here rather than
 * where they are collected, so nothing has to remember what order they go in.
 */
export function artNameFor(sp: Species, tags: readonly string[]): string | null {
  if (sp.sprite.kind !== "art") return null;
  if (tags.length === 0) return sp.sprite.art;
  const key = [...new Set(tags)].sort().join("+");
  return sp.sprite.forms?.[key] ?? sp.sprite.art;
}

/**
 * What a line is for in a team. This is the job it does beside four others,
 * rather than the shape of its stat line, which `claude-notes/making-scobas.md`
 * calls its archetype: a Tank stat line can be built as a guardian or as a
 * bruiser, and the roster needs both.
 */
export type RosterRole =
  | "tank"
  | "bruiser"
  | "assassin"
  | "burst"
  | "control"
  | "enchanter"
  | "guardian"
  | "summoner"
  | "normie";

export const ROSTER_ROLES: RosterRole[] = [
  "tank", "bruiser", "assassin", "burst", "control", "enchanter", "guardian", "summoner", "normie",
];

export interface Species {
  id: string;
  name: string;
  type: ElementType;
  /** A second type, defended with and attacked from alongside the first. */
  type2?: ElementType;
  genes: Stats;
  primaryAbility: string;
  secondaryPool: string[];
  /** The moves it knows, all from the start. See `speciesMoves`. */
  moves: string[];
  sprite: SpriteDef;
  movement: MovementStyle;
  /**
   * Which form this is. Only a first form can be raised with Aetus; anything
   * further has to be earned by evolving into it.
   */
  stage?: number;
  /** The species it becomes when it evolves, if there is one yet. */
  evolvesTo?: string;
  /**
   * A baby form. It is built on the smaller budget, it grows out of itself on
   * reaching `BABY_EVOLVE_LEVEL` rather than being bought out of, and it is
   * what its line's children hatch as.
   */
  baby?: boolean;
  /**
   * The third passive, which runs only while the Scoba is in Hyper-Mode. A
   * baby has none, and neither does a Pawn.
   */
  hyperAbility?: string;
  /** A drawn sample it calls with, by file name in `assets/Sounds`. */
  cry?: string;
  /**
   * What the line is for in a team, as design bookkeeping. Never shown to a
   * player and never read by the battle: it is what `npm run coverage` counts,
   * so the roster can be kept honest as it grows. See
   * `claude-notes/roster-coverage.md`.
   */
  role?: RosterRole;
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
  /**
   * Pawns only. A Pawn is a piece of whoever called it, so by default it takes
   * that Scoba's second passive, its second element and the worked move it
   * carries. Set this false for a line that is meant to come as itself.
   */
  inheritsFromCaller?: boolean;
  /**
   * Only ever made in a battle, by two Scobas fusing: never wild, never kept,
   * never bred. Its stats, types, level, moves and colours all come from the two
   * it was made of, so its own entry supplies only its art and its passive.
   */
  fusion?: boolean;
}

/**
 * Every move, from `content/moves.txt`. The file is the source of truth and
 * the cosmetics editor reads and writes it, so a move is changed there rather
 * than here.
 */
export const MOVES: Record<string, Move> = CONTENT_TABLES.moves;

/** Every passive, from `content/passives.txt`. */
export const ABILITIES: Record<string, Ability> = CONTENT_TABLES.abilities;

/** The first step of a kind in a move's cast, looking inside any `if` too. */
export function firstStep<K extends Step["kind"]>(move: Move, kind: K): Extract<Step, { kind: K }> | null {
  const walk = (steps: Step[]): Extract<Step, { kind: K }> | null => {
    for (const s of steps) {
      if (s.kind === kind) return s as Extract<Step, { kind: K }>;
      if (s.kind === "if") {
        const inner = walk(s.then);
        if (inner) return inner;
      }
    }
    return null;
  };
  return walk(move.cast);
}

/** Every step in a move's cast, `if` blocks opened out, in the order they are written. */
export function allSteps(steps: Step[]): Step[] {
  return steps.flatMap((s) => (s.kind === "if" ? [s, ...allSteps(s.then)] : [s]));
}

/** The costume a move leaves its caster in, for a move that uses something up. */
export function wornBy(move: Move): string | null {
  return firstStep(move, "wear")?.form ?? null;
}

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
 * How the chart's readings stack. Each weakness adds one more multiple and
 * each resistance one more divisor, rather than each doubling or halving the
 * last: a move strong into both halves of a pairing lands at 3x, not 4x, weak
 * into both at a third, and one of each comes out even. Anything the chart
 * calls immune stays immune.
 */
function stacked(readings: number[]): number {
  if (readings.some((r) => r === 0)) return 0;
  const weak = readings.filter((r) => r > 1).length;
  const resist = readings.filter((r) => r < 1).length;
  return (1 + weak) / (1 + resist);
}

/** The chart multiplier against a species, its types stacked as `stacked` says. */
export function effectivenessAgainst(attack: ElementType, sp: Species): number {
  return stacked(typesOf(sp).map((t) => effectiveness(attack, t)));
}

/** Both of a move's elements, primary first. */
export function moveTypes(move: Move): ElementType[] {
  return move.type2 ? [move.type, move.type2] : [move.type];
}

/** The chart multiplier for an attack of these elements, against a set of elements. */
export function typesEffectiveness(types: readonly ElementType[], against: readonly ElementType[]): number {
  return stacked(types.flatMap((t) => against.map((d) => effectiveness(t, d))));
}

/** The chart multiplier for a whole move, against a set of elements. */
export function moveEffectiveness(move: Move, against: readonly ElementType[]): number {
  return typesEffectiveness(moveTypes(move), against);
}

/** Does the caster share either of the move's elements? */
export function moveIsStab(has: readonly ElementType[], move: Move): boolean {
  return moveTypes(move).some((t) => has.includes(t));
}

/** The first form of a species' evolutionary line, which is its baby where the line has one. */
export function firstFormOf(sp: Species): Species {
  let at = sp;
  const walked = new Set([sp.id]);
  for (;;) {
    const before = Object.values(SPECIES).find((b) => b.evolvesTo === at.id);
    if (!before || walked.has(before.id)) return at;
    walked.add(before.id);
    at = before;
  }
}

/** Whether two species belong to the same evolutionary line. */
export function sameLine(a: Species, b: Species): boolean {
  return firstFormOf(a).id === firstFormOf(b).id;
}

/** The baby form a line hatches as, or null for a line with none. */
export function babyOf(sp: Species): Species | null {
  if (sp.baby) return sp;
  const found = Object.values(SPECIES).find((b) => b.baby === true && b.evolvesTo === sp.id);
  return found ?? null;
}

/** The moves an ability hands a Scoba on top of the four it holds. */
export function grantedMoves(sp: Species, secondaryAbility: string): string[] {
  const ids = [sp.primaryAbility, secondaryAbility, sp.hyperAbility ?? ""];
  const out: string[] = [];
  for (const id of ids) {
    const granted = ABILITIES[id]?.grantsMove;
    if (granted && MOVES[granted] && !out.includes(granted)) out.push(granted);
  }
  return out;
}

/**
 * Every line in the game, from `content/species.json`, in the order the file
 * lists them. That order is the order the index and the starter picker show.
 */
export const SPECIES: Record<string, Species> = Object.fromEntries(
  (SPECIES_DATA as unknown as Species[]).map((s) => [s.id, s]),
);

export const STARTER_IDS: string[] = Object.values(SPECIES)
  .filter((s) => s.starter === true)
  .map((s) => s.id);

/**
 * The lines a player can actually keep. The special Scoba is nobody's, a Pawn
 * is only ever summoned and a fusion only ever made in a fight, so none of them
 * belongs in the index, the world editor's species list, or the pools legality
 * derives breeding from.
 */
export function rosterSpecies(): Species[] {
  return Object.values(SPECIES).filter((sp) => !sp.special && !sp.pawn && !sp.fusion);
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
  for (const id of sp.moves) {
    if (seen.has(id) || !MOVES[id]) continue;
    seen.add(id);
    ids.push(id);
  }
  // The order written is the order held. A line's four slots read left to
  // right and top to bottom on the board, so the file decides where each one
  // lands rather than the game shuffling them by price. The convention the
  // shipped lines follow is cheapest, second cheapest, second dearest,
  // dearest, which puts the heaviest move in the bottom right.
  return ids.slice(0, MAX_MOVES);
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
