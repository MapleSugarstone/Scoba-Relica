import type { ScobaInstance, Tint } from "./scoba";
import { costOf, freshUid, makeWild, maxHp, sireOf, unnaturalMoves, MAX_MANA, SHINY_CHANCE } from "./scoba";
import { SPECIES, babyOf, firstFormOf, sameLine, type Species } from "./species";
import { EYE_KEY, greyOf, hexToRgb, hueOf, hueShift } from "../engine/recolor";
import { rescaleLine } from "./scoba";
import { BABY_SCALE, STAT_NAMES, capStats, type Stats } from "./types";
import type { Rng } from "./rng";
import { pick } from "./rng";

/** Moves a Scoba can hold that its own line does not learn. */
export const MAX_UNNATURAL = 1;

/** How much of a hybrid's base stat line comes from its mother. The father gives the rest. */
export const MOTHER_SHARE = 0.65;

export function canBreed(mom: ScobaInstance, dad: ScobaInstance): string | null {
  const momSp = SPECIES[mom.speciesId];
  const dadSp = SPECIES[dad.speciesId];
  if (!momSp || !dadSp) return "Unknown species.";
  if (momSp.special || dadSp.special || momSp.pawn || dadSp.pawn) return "This Scoba cannot breed.";
  if (mom.hybrid || dad.hybrid) return "A hybrid cannot breed.";
  return null;
}

/** Whether a pairing hatches a hybrid, which is what parents from two different evolutionary lines make. */
export function makesHybrid(mom: ScobaInstance, dad: ScobaInstance): boolean {
  const momSp = SPECIES[mom.speciesId];
  const dadSp = SPECIES[dad.speciesId];
  return !!momSp && !!dadSp && !sameLine(momSp, dadSp);
}

/**
 * The line a parent passes on, which is a baby's line and not its own. A
 * parent whose species has a baby form is read at that form's scale. One whose
 * species has none is read at the baby budget's share of the standard, which
 * is what its baby would have been built on had anybody drawn it.
 *
 * The parent's own line is what is mapped, never its species', so two Scobas
 * of one species that were bred differently hand down different children.
 *
 * This is the only place a parent is scaled down. Nothing else should do it.
 */
export function babyLineOf(s: ScobaInstance): Stats {
  const sp = SPECIES[s.speciesId];
  if (!sp) return { ...s.genes };
  if (sp.baby) return { ...s.genes };
  const baby = babyOf(sp);
  if (baby) return rescaleLine(s.genes, sp.genes, baby.genes);
  const out = {} as Stats;
  for (const name of STAT_NAMES) out[name] = Math.round(s.genes[name] * BABY_SCALE);
  return out;
}

/** The form a line's children hatch as, which is the first form of its line. */
export function hatchesAs(sp: Species): Species {
  return firstFormOf(sp);
}

/** Mixes two base lines: `MOTHER_SHARE` of the mother and the rest of the father. */
export function inheritGenes(mom: Stats, dad: Stats): Stats {
  const out = {} as Stats;
  for (const name of STAT_NAMES) {
    out[name] = Math.round(MOTHER_SHARE * mom[name] + (1 - MOTHER_SHARE) * dad[name]);
  }
  return capStats(out);
}

/**
 * What a hybrid is built on. Both parents are measured as their baby forms,
 * because what the two of them make is a baby and not a grown Scoba.
 */
export function childGenes(mom: ScobaInstance, dad: ScobaInstance): Stats {
  return inheritGenes(babyLineOf(mom), babyLineOf(dad));
}

/**
 * Moves the father could pass on: the ones the mother's set does not hold, and
 * that the child could actually cast. A move its line does not learn costs the
 * surcharge for good, so one that would land over the mana ceiling is no
 * inheritance at all and is not offered.
 */
export function inheritableFrom(mom: ScobaInstance, dad: ScobaInstance): string[] {
  const child = childSpeciesOf(mom);
  return dad.moves.filter((m) =>
    !mom.moves.includes(m) && costOf(child, m) <= MAX_MANA);
}

/** The species a pairing with this mother hatches, which is her line's first form. */
export function childSpeciesOf(mom: ScobaInstance): string {
  const sp = SPECIES[mom.speciesId];
  return sp ? hatchesAs(sp).id : mom.speciesId;
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

/** Knobs the nest screen turns that the roll would otherwise decide. */
export interface BreedOpts {
  /**
   * Hatch it shiny rather than rolling for it. One in three hundred is a long
   * wait to look at a palette.
   */
  forceShiny?: boolean;
}

/**
 * Hatches a child at level 1 as the first form of the mother's line.
 *
 * Parents from the same evolutionary line hatch a plain baby of that line, the
 * same as a wild one. Parents from two different lines hatch a hybrid. Its base
 * line mixes the parents' baby lines 65/35, and one of the mother's moves is
 * replaced by one the father knows. It takes his secondary passive, his colours
 * and his leading element, and it cannot breed. `swap` names which move goes
 * for which, and without one the pair is rolled.
 */
export function breed(
  mom: ScobaInstance,
  dad: ScobaInstance,
  rng: Rng,
  swap?: MoveSwap,
  opts: BreedOpts = {},
): ScobaInstance {
  const err = canBreed(mom, dad);
  if (err) throw new Error(err);
  const childSp = hatchesAs(SPECIES[mom.speciesId]!);

  if (!makesHybrid(mom, dad)) {
    const baby = makeWild(childSp.id, 1, rng);
    // The wild roll for shine is already spent, so forcing it moves no other roll.
    if (opts.forceShiny === true) baby.shiny = true;
    return baby;
  }

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

  const dadSp = SPECIES[dad.speciesId]!;
  const child: ScobaInstance = {
    uid: freshUid(rng),
    speciesId: childSp.id,
    level: 1,
    xp: 0,
    genes: childGenes(mom, dad),
    moves,
    // A father with no second passive has none to give, so the mother's stays.
    secondaryAbility: dad.secondaryAbility || mom.secondaryAbility,
    hybrid: true,
    // What is kept is him rather than the swap. The swap is read off his
    // palette wherever the child is drawn.
    sire: sireOf(dad),
    hp: 0,
  };
  // His leading element stands in for whatever second the child's own line
  // had, so nothing ends up with three.
  if (dadSp.type !== childSp.type) child.type2 = dadSp.type;
  // The roll is spent either way, so forcing the result moves no other roll
  // this seed makes.
  const rolledShiny = rng() < SHINY_CHANCE;
  if (opts.forceShiny === true || rolledShiny) child.shiny = true;
  child.hp = maxHp(child);
  return child;
}

/** One colour in a sprite, and how many pixels it covers. */
export interface ColorCount {
  hex: string;
  count: number;
}

/**
 * Colours no swap ever touches: black because it is the outline holding the
 * drawing together, and the eye key because it is every eye.
 */
export const UNSWAPPED = new Set(["#000000", EYE_KEY]);

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
 * Pairs colours off by how much of each there is: the commonest donor over the
 * commonest target, the second over the second, and so on down.
 *
 * A donor list shorter than the target list runs out. What is left over is
 * turned `turn` of the way round the wheel rather than being left behind: the
 * point is a set of colours that reads as one family, and half a repaint reads
 * as neither. A null turn means the father's colour is a grey, which has no hue
 * to turn toward, so what is left over goes grey at its own lightness.
 */
export function pairColors(
  targets: readonly ColorCount[], donors: readonly ColorCount[], turn: number | null,
): Tint[] {
  const out: Tint[] = [];
  targets.forEach((target, i) => {
    const donor = donors[i];
    if (donor) {
      if (donor.hex !== target.hex) out.push({ from: target.hex, to: donor.hex });
      return;
    }
    if (turn === 0) return;
    const rgb = hexToRgb(target.hex);
    const turned = turn === null ? greyOf(rgb) : hueShift(rgb, turn);
    const hex = `#${turned.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    if (hex !== target.hex) out.push({ from: target.hex, to: hex });
  });
  return out;
}

/**
 * How far round the wheel one colour sits from another. A grey `to` answers
 * null, since there is no hue to turn toward, and a grey `from` answers 0,
 * since there is no hue to turn.
 */
export function hueTurn(from: string, to: string): number | null {
  const b = hueOf(hexToRgb(to));
  if (b === null) return null;
  const a = hueOf(hexToRgb(from));
  return a !== null ? b - a : 0;
}

/** Commonest first, ties broken on the hex so two clients agree. */
export function byCount(a: ColorCount, b: ColorCount): number {
  return b.count - a.count || a.hex.localeCompare(b.hex);
}

/** Everything a Scoba is drawn in bar its outline and its eyes. */
export function bodyColors(palette: readonly ColorCount[]): ColorCount[] {
  return palette.filter((c) => !UNSWAPPED.has(c.hex)).sort(byCount);
}

/**
 * The marks a father leaves on a hybrid: his colours over the child's, paired
 * off by how much of each there is.
 *
 * The colour the child is mostly made of is painted over as well. Nearly every
 * line is one colour across four fifths of its drawing, so keeping that colour
 * kept the whole Scoba: a child took its father's passive, its element and its
 * second colour and still read as its mother's line. What makes it its own is
 * its shape, which a colour swap never touches.
 *
 * Ties break on the hex itself, so two clients hatching the same pair paint
 * the same pixels.
 */
export function pickTints(dad: ColorCount[], child: ColorCount[]): Tint[] {
  const worn = new Set(child.map((c) => c.hex));
  const donors = bodyColors(dad).filter((c) => !worn.has(c.hex));
  const mine = bodyColors(child);
  const primary = mine[0];
  if (!primary) return [];
  const turn = donors[0] ? hueTurn(primary.hex, donors[0].hex) : 0;
  return pairColors(mine, donors, turn);
}
