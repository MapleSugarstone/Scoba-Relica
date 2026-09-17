// Picking a hobby and a set of teas to suit a Scoba, rather than leaving both
// to the roll. A sparring partner brings Scobas kitted this way, and so does
// whoever is fighting them, so a practice bout is two finished teams rather
// than two piles of whatever turned up.
import type { Rng } from "./rng";
import { HOBBIES, type HobbyDef } from "./status";
import { MAX_LEVEL, TEAS_MAX, evolve, makeWild, maxHp, statsAt, type ScobaInstance } from "./scoba";
import { breed, canBreed } from "./breeding";
import { SPECIES, evolutionOf, rosterSpecies, type Species } from "./species";
import type { StatName, Stats } from "./types";

/**
 * The stats a hobby moves. HP is not one of them: nothing in the list touches
 * it, so it is left out of every reading here.
 */
export const FIGHTING: StatName[] = ["str", "def", "res", "mag", "spd"];

/** A stat worth building a hobby around. */
export const HOBBY_MARK = 180;

/** What a hobby does, read off its own effects rather than off a list of ids. */
interface Shape {
  up: StatName[];
  down: StatName | null;
}

function shapeOf(def: HobbyDef): Shape {
  const up: StatName[] = [];
  let down: StatName | null = null;
  for (const e of def.effects) {
    if (e.kind !== "stat-scale") continue;
    if (e.mult > 1) up.push(e.stat);
    if (e.mult < 1) down = e.stat;
  }
  return { up, down };
}

/** Every hobby of a given shape, by how many stats it lifts. */
function shaped(ups: number): { id: string; shape: Shape }[] {
  return Object.values(HOBBIES)
    .map((def) => ({ id: def.id, shape: shapeOf(def) }))
    .filter((h) => h.shape.up.length === ups);
}

const same = (a: StatName[], b: StatName[]): boolean =>
  a.length === b.length && a.every((s) => b.includes(s));

/**
 * The hobby that suits a stat line: one that lifts whatever is already strong
 * and gives up whatever is already weakest.
 *
 * Two stats over the mark are worth a hobby that lifts both. One is worth the
 * hobby that lifts it hardest. None, and there is nothing to build around, so
 * the Scoba takes a little of everything instead.
 */
export function hobbyFor(stats: Stats): string {
  const order = [...FIGHTING].sort((a, b) => stats[b] - stats[a]);
  const strong = order.filter((s) => stats[s] > HOBBY_MARK);
  const jack = shaped(FIGHTING.length)[0]?.id;
  if (strong.length === 0) return jack ?? "";
  const up = strong.slice(0, Math.min(2, strong.length));
  // The weakest stat that is not one of the ones being lifted.
  const down = [...order].reverse().find((s) => !up.includes(s));
  const found = shaped(up.length)
    .find((h) => same(h.shape.up, up) && h.shape.down === down);
  return found?.id ?? jack ?? "";
}

/**
 * Teas to pour on a finished stat line: spread over what it is already best
 * at, with Speed always in the running, because a Scoba that moves first gets
 * to use whatever else it has.
 */
export function teasFor(stats: Stats, rng: Rng): StatName[] {
  const order = [...FIGHTING].sort((a, b) => stats[b] - stats[a]);
  const pool = [...new Set([order[0]!, order[1]!, "spd" as StatName])];
  return Array.from({ length: TEAS_MAX }, () => pool[Math.floor(rng() * pool.length)]!);
}

/**
 * A Scoba with a hobby and teas picked for it. The hobby is read off the line
 * as the species and the level left it, so it answers what the Scoba is rather
 * than what an earlier hobby made of it, and the teas are read off the line the
 * hobby leaves behind.
 */
export function kitted(s: ScobaInstance, rng: Rng): ScobaInstance {
  const bare = { ...s, hobby: undefined, teas: [] as StatName[] };
  const hobby = hobbyFor(statsAt(bare, false));
  const withHobby = { ...bare, hobby };
  return { ...withHobby, teas: teasFor(statsAt(withHobby, false), rng) };
}

/** Lines that have finished evolving, which are the only ones a sparring partner brings. */
export function grownSpecies(): Species[] {
  return rosterSpecies().filter((sp) => !evolutionOf(sp));
}

/** Grows a Scoba to a level and all the way up its line. */
function grow(s: ScobaInstance, level: number): void {
  s.level = level;
  // Capped rather than left open: a line that pointed at itself would spin here.
  for (let step = 0; step < 6; step++) {
    const sp = SPECIES[s.speciesId];
    if (!sp || !evolutionOf(sp)) break;
    evolve(s);
  }
  s.hp = maxHp(s);
}

/** How often a sparring partner brings a hybrid rather than a plain line. */
export const HYBRID_CHANCE = 0.5;

/**
 * One Scoba for a sparring partner: a grown line, half the time a hybrid of two
 * of them with whichever of its father's moves it happened to learn, and a
 * hobby and teas picked for whatever it came out as.
 */
export function sparringScoba(level: number, rng: Rng): ScobaInstance {
  const grown = grownSpecies();
  const pick = (): Species => grown[Math.floor(rng() * grown.length)]!;
  let made = makeWild(pick().id, level, rng);
  if (rng() < HYBRID_CHANCE && grown.length > 1) {
    const mom = makeWild(pick().id, MAX_LEVEL, rng);
    const dad = makeWild(pick().id, MAX_LEVEL, rng);
    // Two lines that cannot make a hybrid between them leave the plain one.
    if (canBreed(mom, dad) === null) {
      const child = breed(mom, dad, rng);
      if (child.hybrid) {
        grow(child, level);
        made = child;
      }
    }
  }
  return kitted(made, rng);
}
