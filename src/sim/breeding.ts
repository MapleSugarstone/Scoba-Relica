import type { ScobaInstance, Tint } from "./scoba";
import { costOf, freshUid, maxHp, unnaturalMoves, MAX_MANA, SHINY_CHANCE } from "./scoba";
import { SPECIES } from "./species";
import { STAT_NAMES, type Stats } from "./types";
import type { Rng } from "./rng";
import { chance, pick } from "./rng";

export const MAX_BREED_COUNT = 2;
/** Moves a Scoba can hold that its own line does not learn. */
export const MAX_UNNATURAL = 1;
export const DAD_ABILITY_CHANCE = 0.1;

export function canBreed(mom: ScobaInstance, dad: ScobaInstance): string | null {
  const momSp = SPECIES[mom.speciesId];
  const dadSp = SPECIES[dad.speciesId];
  if (!momSp || !dadSp) return "Unknown species.";
  if (momSp.special || dadSp.special || momSp.pawn || dadSp.pawn) return "This Scoba cannot breed.";
  if (mom.breedCount >= MAX_BREED_COUNT || dad.breedCount >= MAX_BREED_COUNT) {
    return "Bred out. A line can only be bred twice.";
  }
  return null;
}

export function inheritGenes(mom: Stats, dad: Stats): Stats {
  const out = {} as Stats;
  for (const name of STAT_NAMES) {
    out[name] = Math.round(0.8 * mom[name] + 0.2 * dad[name]);
  }
  return out;
}

/**
 * Moves the father could pass on: the ones the mother's set does not hold, and
 * that the child could actually cast. A move its line does not learn costs the
 * surcharge for good, so one that would land over the mana ceiling is no
 * inheritance at all and is not offered.
 */
export function inheritableFrom(mom: ScobaInstance, dad: ScobaInstance): string[] {
  return dad.moves.filter((m) =>
    !mom.moves.includes(m) && costOf(mom.speciesId, m) <= MAX_MANA);
}

/**
 * Which of the mother's moves the child may give up. A Scoba holds one worked
 * move at most, so a mother already carrying one can only pass the child that
 * slot: taking anything else would leave it with two.
 */
export function droppableFrom(mom: ScobaInstance): string[] {
  const worked = unnaturalMoves(mom);
  return worked.length > 0 ? worked.slice(0, 1) : [...mom.moves];
}

/** Which of mom's moves goes, and which of dad's takes the slot. */
export interface MoveSwap {
  drop: string;
  take: string;
}

/** A hatching: the child, and how the one roll in it landed. */
export interface Hatchling {
  child: ScobaInstance;
  /**
   * Whether the ability roll took the father's rather than the mother's. It is
   * the roll and not the two abilities that decides this: parents that happen
   * to share an ability still hand down one or the other, and what the child
   * takes after is what it was given, not what can be told apart afterwards.
   */
  fromDad: boolean;
}

/**
 * Child is the mom's species at level 1. Genes are 80% mom / 20% dad. One of
 * mom's moves is replaced by a move the dad knows (when he knows something
 * new); `swap` names which for which, and without one the pair is rolled.
 * 10% chance to inherit dad's secondary ability instead of mom's.
 */
export function breed(
  mom: ScobaInstance,
  dad: ScobaInstance,
  rng: Rng,
  swap?: MoveSwap,
): Hatchling {
  const err = canBreed(mom, dad);
  if (err) throw new Error(err);
  const sp = SPECIES[mom.speciesId]!;

  const moves = [...mom.moves];
  const newFromDad = inheritableFrom(mom, dad);
  if (newFromDad.length > 0) {
    // The inherited move lands on the slot it replaced and stays there,
    // because statuses address a Scoba's moves by position. Which slot that
    // can be is limited to one when the mother already works a move herself.
    const droppable = droppableFrom(mom);
    const drop = swap && droppable.includes(swap.drop) ? swap.drop : pick(rng, droppable);
    const slot = moves.indexOf(drop);
    moves[slot] = swap && newFromDad.includes(swap.take) ? swap.take : pick(rng, newFromDad);
  }

  const fromDad = chance(rng, DAD_ABILITY_CHANCE);
  const secondaryAbility = fromDad ? dad.secondaryAbility : mom.secondaryAbility;

  const child: ScobaInstance = {
    uid: freshUid(rng),
    speciesId: mom.speciesId,
    level: 1,
    xp: 0,
    genes: inheritGenes(mom.genes, dad.genes),
    moves,
    secondaryAbility,
    breedCount: Math.max(mom.breedCount, dad.breedCount) + 1,
    hp: 0,
  };
  if (rng() < SHINY_CHANCE) child.shiny = true;
  child.hp = maxHp(child);
  return { child, fromDad };
}

/** One colour in a sprite, and how many pixels it covers. */
export interface ColorCount {
  hex: string;
  count: number;
}

/**
 * Line art, in every sprite and never swapped. White is left alone because a
 * child that is mostly white has nothing else to mark, and black because it is
 * the outline holding the drawing together.
 */
const LINE_ART = new Set(["#000000", "#ffffff"]);

/**
 * Which of a set of colour swaps a palette can actually wear, in the order they
 * are offered, with a null where it cannot. The palette is walked as it goes,
 * so a later swap is matched against what an earlier one left behind rather
 * than against the art underneath both.
 *
 * This is what decides how much of a summoner shows on the Pawn it called: the
 * marks are the summoner's, and only the ones the Pawn has a colour for stick.
 */
export function sharedSwaps(worn: readonly string[], offered: readonly (Tint | null)[]): (Tint | null)[] {
  const has = new Set(worn);
  return offered.map((t) => {
    if (!t || !has.has(t.from)) return null;
    has.delete(t.from);
    has.add(t.to);
    return t;
  });
}

/**
 * The mark a father leaves on a child that took his ability: his most-used
 * colour that the child does not already wear, painted over the child's rarest
 * colour. A child with nothing but line art keeps its palette, and so does one
 * whose father brings no colour of his own.
 *
 * Ties break on the hex itself, so two clients hatching the same pair paint
 * the same pixel.
 */
export function pickTint(dad: ColorCount[], child: ColorCount[]): Tint | null {
  const worn = new Set(child.map((c) => c.hex));
  const donor = dad
    .filter((c) => !worn.has(c.hex))
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex))[0];
  if (!donor) return null;
  const target = child
    .filter((c) => !LINE_ART.has(c.hex))
    .sort((a, b) => a.count - b.count || a.hex.localeCompare(b.hex))[0];
  if (!target) return null;
  return { from: target.hex, to: donor.hex };
}
