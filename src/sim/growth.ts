// Aetus: what a fight pays out, and what raising a Scoba with it costs.
//
// Levelling by xp is what a Scoba earns by being fielded; Aetus is what the
// player spends on one that was not. Both stop at the same ceiling, so buying
// levels catches a Scoba up rather than pushing it past anything.
import type { ScobaInstance } from "./scoba";
import { EVOLVE_LEVEL, MAX_LEVEL, evolve, raiseLevel } from "./scoba";
import { SPECIES, evolutionOf, stageOf } from "./species";

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

/**
 * Why this Scoba cannot evolve right now, or null if it can. Growing up is
 * the player's call rather than something that happens on the way past a
 * level: reaching the level is what puts the button within reach.
 */
export function evolveError(s: ScobaInstance, aetus: number): string | null {
  const sp = SPECIES[s.speciesId];
  if (!sp) return "Unknown species.";
  if (!evolutionOf(sp)) return "Nothing to evolve into yet.";
  if (s.level < EVOLVE_LEVEL) return `Ready at level ${EVOLVE_LEVEL}.`;
  // A baby grows out of its own form, which costs nothing: the level is the
  // whole of what it asks for. Anything else is bought.
  if (!sp.baby && aetus < EVOLVE_COST) return `Costs ${EVOLVE_COST} Aetus.`;
  return null;
}

/** What evolving this Scoba takes out of the Aetus on hand. */
export function evolvePrice(s: ScobaInstance): number {
  return SPECIES[s.speciesId]?.baby ? 0 : EVOLVE_COST;
}

export { evolve };
export { raiseLevel as levelUp };
