import type { ElementType, StatName, Stats } from "./types";
import { STAT_NAMES, capStats, statTotal } from "./types";
import { blendNames } from "./blend";
import HYBRID_NAMES from "./content/hybrid-names.json";
import {
  ABILITIES, abilityStatuses, evolutionOf, grantedMoves, MOVES, SPECIES, speciesMoves,
} from "./species";
import {
  HOBBY_IDS, continuousEffects, foldStatEffects, hobbyEffects, newStatus, type StatusInstance,
} from "./status";
import type { Rng } from "./rng";
import { pick } from "./rng";

/**
 * A colour swap laid over a species' art: one of the father's colours painted
 * over one of the child's. Hex, lower case, six digits.
 *
 * Worked out where the pixels are rather than stored on the Scoba. What is
 * stored is the father it came from, and the swap is read off his palette and
 * the sprite being drawn, every time. Stored as hexes it was right once and
 * wrong ever after: the Scoba evolves, or goes Hyper, and the colours it was
 * told to replace are not in the drawing any more.
 */
export interface Tint {
  from: string;
  to: string;
}

/**
 * The father a Scoba takes its colours from, as a species id.
 *
 * His own line and nothing of what was done to him: a father who inherited
 * colours himself hands on the palette his species is drawn in rather than the
 * one he is wearing. Inheritance does not compound down a line, so a Scoba is
 * its own species and one father, and never a chain of them.
 */
export type Sire = string;

/**
 * Whoever called a Pawn up, kept for the colours it wears. A Pawn takes on its
 * summoner's marks, but only where its own art has the colour to swap, which is
 * a question about pixels: the sim records who called it and the art layer
 * works out how much of that shows.
 */
export interface Summoner {
  speciesId: string;
  sire?: Sire;
  shiny?: boolean;
  /**
   * Painted in the summoner's own colours rather than only wearing whatever
   * marks it has. A raised Pawn is the raiser's work and reads as theirs.
   */
  repaint?: boolean;
}

/**
 * One of the two Scobas a fusion was made of, as it was when it fused: what it
 * is, the colours it wore, and its elements. The fusion is painted in both
 * halves' colours and fights as every element either had.
 */
export interface FusionPart {
  speciesId: string;
  sire?: Sire;
  shiny?: boolean;
  /** The costumes it was wearing, which is Hyper-Mode at least. */
  forms: string[];
  types: ElementType[];
}

export interface ScobaInstance {
  uid: string;
  speciesId: string;
  nickname?: string;
  level: number;
  xp: number;
  /**
   * Its base stat line, which is what it has at the level ceiling. A line
   * starts as its species' and a hybrid's mixes its parents' 65/35. Stats at a
   * lower level are this scaled down by the level.
   */
  genes: Stats;
  moves: string[]; // 1-4 move ids
  secondaryAbility: string;
  /**
   * What it does with its time, from `content/hobbies.txt`. Every Scoba has
   * one, it is rolled when the Scoba is and changed only at the hut, and it is
   * part of the Scoba rather than something it carries: it counts in a battle
   * and out of one, and nothing can take it off.
   */
  hobby?: string;
  /**
   * Teas it has drunk, one stat each, at most `TEAS_MAX` of them. A tea is
   * worth `TEA_AT_CEILING` to that stat at the level ceiling and a share of it
   * below, the same way the rest of the line scales. Two of the same stat is
   * twice as much: what matters is how many of each are in the list.
   */
  teas?: StatName[];
  /**
   * Bred from two different lines. It goes by a name blended from its mother's
   * species and its father's, and it cannot breed.
   */
  hybrid?: true;
  hp: number; // current effective HP, persisted between battles
  /** Which character it walks with in the overworld. Wild ones have none. */
  owner?: "A" | "B";
  /** Whose it really is, while it is lent to the other character. */
  lentBy?: "A" | "B";
  /**
   * Hybrids only: the move it took from its father and the slot it took. Its
   * moves are rebuilt around this every time the save is loaded.
   */
  inherited?: { move: string; slot: number };
  /**
   * The father it took its passive from, whose colours it wears, by species.
   * The swap itself is worked out from his own art wherever the Scoba is
   * drawn, so it follows the Scoba through an evolution and into Hyper-Mode.
   */
  sire?: Sire;
  /**
   * A second element taken from the father, which its species does not have.
   * A child that took his passive takes the element he leads with too: what it
   * inherited came from somewhere, and this is that somewhere showing.
   *
   * It stands in for the species' own second type where there is one, so a
   * Scoba is never more than two elements.
   */
  type2?: ElementType;
  /**
   * The element it leads with, where something made it something else. Only a
   * raised Pawn carries one, and a Pawn is never saved.
   */
  type1?: ElementType;
  /** Rare colouring: its main colour is turned, and it glitters. */
  shiny?: boolean;
  /**
   * When it first joined somebody, and that trainer's name as it was then. Set
   * once and kept through lending, trading and growing up. A Scoba kept from
   * before this was recorded has none.
   */
  met?: { at: number; by: string };
  /** Pawns only: who called it up, which is what it takes its colours from. */
  summoner?: Summoner;
  /**
   * Fusions only: the two it was made of, first slot first. A fusion is built
   * in a battle and gone at the end of it, so this is never saved.
   */
  fusedFrom?: FusionPart[];
}

/** Nobody grows past this, by xp or by Aetus. Base stat lines are measured
 * here, so a Scoba at the ceiling has exactly the line its species was given. */
export const MAX_LEVEL = 30;

/** Most teas one Scoba can hold. */
export const TEAS_MAX = 3;

/** What one tea gives its stat at the level ceiling. */
export const TEA_AT_CEILING = 15;

/** What one tea is worth at a level, scaled the way the rest of the line is. */
export function teaWorth(level: number): number {
  return Math.round((TEA_AT_CEILING * Math.max(1, Math.min(MAX_LEVEL, level))) / MAX_LEVEL);
}

/** The level an evolution unlocks at. Growing up is asked for, never automatic. */
export const EVOLVE_LEVEL = 15;

/** How often one turns up shiny. */
export const SHINY_CHANCE = 1 / 300;

/** How far round the wheel a shiny turns its main colour. */
export const SHINY_TURN = 0.25;

let uidCounter = 0;

/**
 * An id for one Scoba. Given a seeded roll it is worked out from that roll
 * alone, so the same seed always names the same Scoba: two clients resolving
 * one round apart agree on who was called up, and a round resolved a second
 * time to answer a question mid-round calls up the same body rather than a new
 * one. Without a roll it is a fresh id off the clock, for anything made outside
 * a battle.
 */
export function freshUid(rng?: Rng): string {
  if (rng) {
    // One roll, the same one it always took, so everything rolled after it is
    // rolled off the same number it was before ids were worked out this way.
    const r = Math.floor(rng() * 0xffffffff);
    return `${r.toString(36)}-${(r % 0xffffff).toString(36)}`;
  }
  uidCounter += 1;
  return `${Date.now().toString(36)}-${uidCounter.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

/**
 * The statuses a Scoba's two abilities hang on it. A battle puts these on the
 * combatant itself; out of a battle they are folded in here, so a Scoba's
 * numbers read the same on the party screen as they do on the field.
 */
export function passiveStatuses(s: ScobaInstance): StatusInstance[] {
  const sp = SPECIES[s.speciesId];
  if (!sp) return [];
  const ids = [...abilityStatuses(sp.primaryAbility), ...abilityStatuses(s.secondaryAbility)];
  const out: StatusInstance[] = [];
  for (const id of ids) {
    if (out.some((held) => held.id === id)) continue;
    const inst = newStatus(id);
    if (inst) out.push(inst);
  }
  return out;
}

/**
 * The base line scaled down by the level, passives on top. Every stat scales
 * together, so a Scoba is the same shape at every level and only ever gets
 * bigger. At the ceiling it is its base line exactly.
 */
export function scaleToLevel(line: Stats, level: number): Stats {
  const k = Math.max(1, Math.min(MAX_LEVEL, level)) / MAX_LEVEL;
  const out = {} as Stats;
  for (const name of STAT_NAMES) out[name] = Math.round((line[name] ?? 0) * k);
  return out;
}

/**
 * What every Scoba has in every stat whatever its line spends there, on top of
 * the line itself. It is not allocated, not inherited and not part of any
 * budget: a line that buys no Strength still swings with this much of it.
 *
 * Rounded up, so a level is always worth something rather than every other one
 * being worth nothing.
 */
export const COMMON_BASE = 5;
export const COMMON_AT_CEILING = 20;

export function commonStat(level: number): number {
  const lv = Math.max(1, Math.min(MAX_LEVEL, level));
  return COMMON_BASE + Math.ceil((COMMON_AT_CEILING * lv) / MAX_LEVEL);
}

export function statsAt(s: ScobaInstance, withAbility = true): Stats {
  const sp = SPECIES[s.speciesId];
  if (!sp) throw new Error(`unknown species ${s.speciesId}`);
  const out = scaleToLevel(s.genes, s.level);
  const common = commonStat(s.level);
  for (const name of STAT_NAMES) out[name] += common;
  // A hobby is part of the Scoba rather than a mark it is carrying, so it is
  // folded in before the abilities and counts whether or not they do. In a
  // battle the passives are hung on the combatant instead and read from there.
  const own = foldStatEffects(out, hobbyEffects(s.hobby));
  // Poured on top of what the hobby left, so a hobby never multiplies what a
  // tea gave: what a tea is worth is the same whoever drinks it.
  const worth = teaWorth(s.level);
  for (const stat of (s.teas ?? []).slice(0, TEAS_MAX)) own[stat] += worth;
  if (!withAbility) return own;
  return foldStatEffects(own, continuousEffects(passiveStatuses(s)));
}

/** Effective HP pool: HP stat x 2.8. Def/Res mitigate damage instead of
 * inflating this pool. */
export function maxHp(s: ScobaInstance): number {
  return Math.floor(statsAt(s).hp * 2.8);
}

export function makeWild(speciesId: string, level: number, rng: Rng): ScobaInstance {
  const sp = SPECIES[speciesId];
  if (!sp) throw new Error(`unknown species ${speciesId}`);
  const moves = speciesMoves(sp);
  const inst: ScobaInstance = {
    uid: freshUid(rng),
    speciesId,
    level,
    xp: 0,
    genes: { ...sp.genes },
    moves: moves.length > 0 ? moves : [sp.moves[0]!],
    // A line with no secondary pool has one passive and no second: Pawns are
    // built that way on purpose, and an empty string names no ability at all.
    secondaryAbility: sp.secondaryPool.length > 0 ? pick(rng, sp.secondaryPool) : "",
    hobby: pick(rng, HOBBY_IDS),
    hp: 0,
  };
  if (rng() < SHINY_CHANCE) inst.shiny = true;
  inst.hp = maxHp(inst);
  return inst;
}

/**
 * What a Scoba is to its own children: its line, and nothing it picked up on
 * the way. A father who was himself bred hands on his species, so what a child
 * wears is always one father's own colours.
 */
export function sireOf(s: ScobaInstance): Sire {
  return s.speciesId;
}

/** Hybrid names written by hand, by current form and father as `mother:father` species ids. */
const WRITTEN_HYBRID_NAMES: Record<string, string> = HYBRID_NAMES;

/**
 * The species a Scoba shows as. A hybrid shows as a species of its own, named
 * from its current form and its father's species, so the name follows it
 * through an evolution. A name written for the pairing wins over the blend.
 */
export function speciesName(s: ScobaInstance): string {
  const own = SPECIES[s.speciesId]?.name ?? s.speciesId;
  const father = s.hybrid && s.sire ? SPECIES[s.sire]?.name : undefined;
  if (!father) return own;
  return WRITTEN_HYBRID_NAMES[`${s.speciesId}:${s.sire}`] ?? blendNames(own, father);
}

export function moveName(id: string): string {
  return MOVES[id]?.name ?? id;
}

/**
 * What a Scoba actually is, which is its species' first element and then
 * whatever stands as its second: the one it took from its father where it took
 * one, and its species' own otherwise.
 *
 * Everything that reads a Scoba's elements in a battle reads this rather than
 * the species, because a bred Scoba is not quite its species any more.
 */
export function scobaTypes(s: ScobaInstance): ElementType[] {
  // A fusion is every element either half had, which can be up to four.
  if (s.fusedFrom) return [...new Set(s.fusedFrom.flatMap((p) => p.types))];
  const sp = SPECIES[s.speciesId];
  if (!sp) return [];
  const first = s.type1 ?? sp.type;
  const second = s.type2 ?? sp.type2;
  return second !== undefined && second !== first ? [first, second] : [first];
}

/** Mana ceiling. A move costing more than this could never be cast at all. */
export const MAX_MANA = 100;

/** What a move bred into a line costs on top of its own price. */
export const UNNATURAL_SURCHARGE = 10;

/** Is this a move the species knows, rather than one bred into it? */
export function isNatural(speciesId: string, moveId: string): boolean {
  return SPECIES[speciesId]?.moves.includes(moveId) ?? false;
}

/**
 * What a move costs this Scoba. A move its line does not learn is worked
 * rather than known, and costs the surcharge on top for as long as it holds
 * it. A Scoba carries at most one of them.
 */
export function moveCost(s: ScobaInstance, moveId: string): number {
  const sp = SPECIES[s.speciesId];
  // A move an ability hands over is not a move bred into the line, so it costs
  // what it says rather than the surcharge a worked move pays for good. The
  // same goes for one a step rewrote and handed over: it was not bred in
  // either, and it is gone at the end of the fight.
  if (MOVES[moveId]?.derived) return MOVES[moveId]?.manaCost ?? 0;
  if (sp && grantedMoves(sp, s.secondaryAbility).includes(moveId)) {
    return MOVES[moveId]?.manaCost ?? 0;
  }
  return costOf(s.speciesId, moveId);
}

/** The same price, for a move a species has not been handed yet. */
export function costOf(speciesId: string, moveId: string): number {
  const base = MOVES[moveId]?.manaCost ?? 0;
  return isNatural(speciesId, moveId) ? base : base + UNNATURAL_SURCHARGE;
}

/** The moves this Scoba holds that its line does not learn. */
export function unnaturalMoves(s: ScobaInstance): string[] {
  return s.moves.filter((m) => !isNatural(s.speciesId, m));
}

/**
 * Hands a Pawn what the Scoba calling it was handed: the passive it carries
 * beyond its own line's, the element that came with that passive, and the
 * worked move it holds in place of one of its line's. A court is the Scoba it
 * belongs to, so a Cottlequeen bred for something fields a court bred for it.
 *
 * The worked move lands on the slot it sits in on the caller, or on the last
 * slot for a Pawn with fewer moves than that, because a move is addressed by
 * position and one has to be given up to make room. It is passed over when the
 * Pawn could never pay the surcharge on it.
 *
 * A line whose species sets `inheritsFromCaller` false comes as itself.
 */
export function inheritFromCaller(pawn: ScobaInstance, caller: ScobaInstance): void {
  const sp = SPECIES[pawn.speciesId];
  if (!sp || sp.inheritsFromCaller === false) return;
  if (caller.secondaryAbility) pawn.secondaryAbility = caller.secondaryAbility;
  const second = scobaTypes(caller)[1];
  if (second !== undefined && second !== sp.type) pawn.type2 = second;
  const worked = unnaturalMoves(caller)[0];
  if (worked === undefined || pawn.moves.includes(worked)) return;
  if (costOf(pawn.speciesId, worked) > MAX_MANA) return;
  const at = Math.min(caller.moves.indexOf(worked), pawn.moves.length - 1);
  if (at >= 0) pawn.moves[at] = worked;
}

/**
 * Another line with the lean a bred Scoba carries. `from` is what the bred
 * Scoba's species is built on and `bred` is what it actually is. Whatever `bred`
 * holds more or less of than `from` would at the same total is added to `own`,
 * scaled to `own`'s total, so a Scoba of its species' own shape hands on no lean.
 */
export function leanOnto(own: Stats, bred: Stats, from: Stats): Stats {
  const bredTotal = statTotal(bred);
  const fromTotal = statTotal(from);
  if (bredTotal <= 0 || fromTotal <= 0) return { ...own };
  const scale = statTotal(own) / bredTotal;
  const out = {} as Stats;
  for (const name of STAT_NAMES) {
    const lean = bred[name] - from[name] * (bredTotal / fromTotal);
    out[name] = Math.max(0, Math.round(own[name] + lean * scale));
  }
  return capStats(out);
}

/** What the next level costs. Linear, so the climb to 30 stays readable. */
export function xpForNext(level: number): number {
  return 20 + level * 30;
}

/**
 * Moves a line from one form's scale to another's, keeping each stat's share
 * of what its species holds. A Scoba that is half again its species' HP is
 * still half again its species' HP on the other side of the mapping.
 *
 * A stat its species spends nothing on has no share to keep, so it moves on
 * the budget ratio instead. Without that, a line bred into a stat its species
 * has none of would lose it on growing up.
 */
export function rescaleLine(line: Stats, from: Stats, to: Stats): Stats {
  const budget = statTotal(to) / Math.max(1, statTotal(from));
  const out = {} as Stats;
  for (const name of STAT_NAMES) {
    out[name] = from[name] > 0
      ? Math.round(line[name] * (to[name] / from[name]))
      : Math.round(line[name] * budget);
  }
  // A stat the first form barely spends on can grow many times over, and a
  // father heavy in it pushed a bred line past what its new form is built on.
  // A line may be as big against its new form as it was against its old one
  // and no bigger, so past that the whole line comes down together and keeps
  // its shape.
  const total = statTotal(out);
  const room = statTotal(to) * Math.max(1, statTotal(line) / Math.max(1, statTotal(from)));
  if (total > room) {
    for (const name of STAT_NAMES) out[name] = Math.floor((out[name] * room) / total);
  }
  return capStats(out);
}

/**
 * Becomes its next form. Genes, level and nickname carry over, since they are
 * the Scoba rather than the shape it is in. Its moves become the new form's
 * set, because a Scoba knows its species' whole set and nothing else; the one
 * exception is a move bred into it, which keeps the slot it was given, since
 * that slot is what its line passed down.
 */
export function evolve(s: ScobaInstance): void {
  const sp = SPECIES[s.speciesId];
  const next = sp ? evolutionOf(sp) : null;
  if (!next) return;
  const inherited = new Set(s.moves.filter((m) => MOVES[m] && !speciesMoves(sp!).includes(m)));
  // Its line grows with it, keeping each stat's share of what its species
  // holds, so a bred Scoba stays the shape breeding made it.
  s.genes = rescaleLine(s.genes, sp!.genes, next.genes);
  s.speciesId = next.id;
  const slots = speciesMoves(next);
  if (slots.length > 0) {
    s.moves.forEach((m, i) => {
      if (!inherited.has(m)) return;
      slots[Math.min(i, slots.length - 1)] = m;
    });
    s.moves = slots;
  }
  // The second passive comes through untouched. A passive outside the new
  // line's pool is one the Scoba was bred to have, which is the whole point of
  // breeding for one, so growing up is the last thing that should take it away.
  if (!ABILITIES[s.secondaryAbility]) {
    s.secondaryAbility = next.secondaryPool[0] ?? s.secondaryAbility;
  }
  s.hp = maxHp(s);
}


export interface LevelUpResult {
  levelsGained: number;
  /** Moves learned automatically (had a free slot). */
  learned: string[];
  /** Moves that need a replacement decision (all 4 slots full). */
  pending: string[];
  /** The form it grew into on the way up, if a level took it out of a baby. */
  evolved?: string;
}

/** Award xp, apply level-ups (+1 every stat via the level term), keep the
 * current HP damage offset, and collect newly learnable moves. */
export function gainXp(s: ScobaInstance, amount: number): LevelUpResult {
  const result: LevelUpResult = { levelsGained: 0, learned: [], pending: [] };
  const sp = SPECIES[s.speciesId];
  if (!sp || s.level >= MAX_LEVEL) return result;
  s.xp += amount;
  while (s.level < MAX_LEVEL && s.xp >= xpForNext(s.level)) {
    s.xp -= xpForNext(s.level);
    const was = s.speciesId;
    raiseLevel(s);
    result.levelsGained += 1;
    if (s.speciesId !== was) result.evolved = s.speciesId;
  }
  // At the ceiling there is nothing left to spend xp on.
  if (s.level >= MAX_LEVEL) s.xp = 0;
  return result;
}

/**
 * One level, keeping whatever damage the Scoba was already carrying. Reaching
 * the evolution level changes nothing on its own: what it does is put the
 * button in front of the player, who decides whether the Scoba grows up.
 */
export function raiseLevel(s: ScobaInstance): void {
  if (s.level >= MAX_LEVEL) return;
  const beforeMax = maxHp(s);
  s.level += 1;
  s.hp = Math.min(maxHp(s), s.hp + (maxHp(s) - beforeMax));
}

/**
 * What a caught Scoba settles at once it is yours: the level ceiling at most,
 * then a level or two off that. A wild one is a project, never a shortcut past
 * the one you raised.
 */
export function settleCaught(s: ScobaInstance, rng: Rng): void {
  const capped = Math.min(s.level, MAX_LEVEL);
  s.level = Math.max(1, capped - (1 + Math.floor(rng() * 2)));
  s.xp = 0;
  s.hp = maxHp(s);
}
