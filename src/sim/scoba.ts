import type { Stats } from "./types";
import { STAT_NAMES } from "./types";
import { abilityStatuses, MOVES, SPECIES, speciesMoves } from "./species";
import { continuousEffects, foldStatEffects, newStatus, type StatusInstance } from "./status";
import type { Rng } from "./rng";
import { pick } from "./rng";

/**
 * A colour swap laid over a species' art: one of the father's colours painted
 * over one of the child's, hung on at hatching. Hex, lower case, six digits.
 */
export interface Tint {
  from: string;
  to: string;
}

/**
 * Whoever called a Pawn up, kept for the colours it wears. A Pawn takes on its
 * summoner's marks, but only where its own art has the colour to swap, which is
 * a question about pixels: the sim records who called it and the art layer
 * works out how much of that shows.
 */
export interface Summoner {
  speciesId: string;
  tint?: Tint;
  shiny?: boolean;
}

export interface ScobaInstance {
  uid: string;
  speciesId: string;
  nickname?: string;
  level: number;
  xp: number;
  /** Inherited stat line (starts at the species genes, 5 across the board);
   * breeding mixes these 80/20. Stat at a level = gene + (level - 1). */
  genes: Stats;
  moves: string[]; // 1-4 move ids
  secondaryAbility: string;
  breedCount: number; // 0-2; 2 means it cannot breed again
  hp: number; // current effective HP, persisted between battles
  /** Which character it walks with in the overworld. Wild ones have none. */
  owner?: "A" | "B";
  /** Whose it really is, while it is lent to the other character. */
  lentBy?: "A" | "B";
  /** Colour mask inherited from its father, drawn over the species art. */
  tint?: Tint;
  /** Rare colouring: its main colour is turned, and it glitters. */
  shiny?: boolean;
  /** Pawns only: who called it up, which is what it takes its colours from. */
  summoner?: Summoner;
}

/** Nobody grows past this, by xp or by Aetus. */
export const MAX_LEVEL = 5;

/** How often one turns up shiny. */
export const SHINY_CHANCE = 1 / 300;

/** How far round the wheel a shiny turns its main colour. */
export const SHINY_TURN = 0.25;

let uidCounter = 0;

export function freshUid(rng?: Rng): string {
  uidCounter += 1;
  const r = rng ? Math.floor(rng() * 0xffffff) : Math.floor(Math.random() * 0xffffff);
  return `${Date.now().toString(36)}-${uidCounter.toString(36)}-${r.toString(36)}`;
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

/** Stats at the current level: gene + (level - 1), passives on top. */
export function statsAt(s: ScobaInstance, withAbility = true): Stats {
  const sp = SPECIES[s.speciesId];
  if (!sp) throw new Error(`unknown species ${s.speciesId}`);
  const out = {} as Stats;
  for (const name of STAT_NAMES) {
    out[name] = (s.genes[name] ?? 5) + (s.level - 1);
  }
  if (!withAbility) return out;
  return foldStatEffects(out, continuousEffects(passiveStatuses(s)));
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
    moves: moves.length > 0 ? moves : [sp.learnset[0]!.move],
    // A line with no secondary pool has one passive and no second: Pawns are
    // built that way on purpose, and an empty string names no ability at all.
    secondaryAbility: sp.secondaryPool.length > 0 ? pick(rng, sp.secondaryPool) : "",
    breedCount: 0,
    hp: 0,
  };
  if (rng() < SHINY_CHANCE) inst.shiny = true;
  inst.hp = maxHp(inst);
  return inst;
}

export function moveName(id: string): string {
  return MOVES[id]?.name ?? id;
}

/** Mana ceiling. A move costing more than this could never be cast at all. */
export const MAX_MANA = 100;

/** What a move bred into a line costs on top of its own price. */
export const UNNATURAL_SURCHARGE = 10;

/** Is this a move the species learns, rather than one bred into it? */
export function isNatural(speciesId: string, moveId: string): boolean {
  return SPECIES[speciesId]?.learnset.some((l) => l.move === moveId) ?? false;
}

/**
 * What a move costs this Scoba. A move its line does not learn is worked
 * rather than known, and costs the surcharge on top for as long as it holds
 * it. A Scoba carries at most one of them.
 */
export function moveCost(s: ScobaInstance, moveId: string): number {
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

export function xpForNext(level: number): number {
  return 20 + level * 10;
}

export interface LevelUpResult {
  levelsGained: number;
  /** Moves learned automatically (had a free slot). */
  learned: string[];
  /** Moves that need a replacement decision (all 4 slots full). */
  pending: string[];
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
    raiseLevel(s);
    result.levelsGained += 1;
  }
  // At the ceiling there is nothing left to spend xp on.
  if (s.level >= MAX_LEVEL) s.xp = 0;
  return result;
}

/** One level, keeping whatever damage the Scoba was already carrying. */
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
