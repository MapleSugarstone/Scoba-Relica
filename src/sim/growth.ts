// Aetus: what a fight pays out, and what raising a Scoba with it costs.
//
// Levelling by xp is what a Scoba earns by being fielded; Aetus is what the
// player spends on one that was not. Both stop at the same ceiling, so buying
// levels catches a Scoba up rather than pushing it past anything.
import type { ScobaInstance } from "./scoba";
import { MAX_LEVEL, maxHp, raiseLevel } from "./scoba";
import { MOVES, SPECIES, evolutionOf, speciesMoves, stageOf } from "./species";

export const AETUS_PER_WILD = 100;
export const AETUS_PER_TRAINER = 300;
export const LEVEL_COST = 100;
export const EVOLVE_COST = 500;

/** Why this Scoba cannot be levelled right now, or null if it can. */
export function levelUpError(s: ScobaInstance, aetus: number): string | null {
  const sp = SPECIES[s.speciesId];
  if (!sp) return "Unknown species.";
  if (stageOf(sp) > 1) return "Only a first form grows on Aetus.";
  if (s.level >= MAX_LEVEL) return `Already at level ${MAX_LEVEL}.`;
  if (aetus < LEVEL_COST) return `Costs ${LEVEL_COST} Aetus.`;
  return null;
}

/** Why this Scoba cannot evolve right now, or null if it can. */
export function evolveError(s: ScobaInstance, aetus: number): string | null {
  const sp = SPECIES[s.speciesId];
  if (!sp) return "Unknown species.";
  if (!evolutionOf(sp)) return "Nothing to evolve into yet.";
  if (aetus < EVOLVE_COST) return `Costs ${EVOLVE_COST} Aetus.`;
  return null;
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
  s.speciesId = next.id;
  const slots = speciesMoves(next);
  if (slots.length > 0) {
    s.moves.forEach((m, i) => {
      if (!inherited.has(m)) return;
      slots[Math.min(i, slots.length - 1)] = m;
    });
    s.moves = slots;
  }
  if (!next.secondaryPool.includes(s.secondaryAbility)) {
    s.secondaryAbility = next.secondaryPool[0] ?? s.secondaryAbility;
  }
  s.hp = maxHp(s);
}

export { raiseLevel as levelUp };
