// Aetus: what a fight pays out, and what raising a Scoba with it costs.
//
// Levelling by xp is what a Scoba earns by being fielded; Aetus is what the
// player spends on one that was not. Both stop at the same ceiling, so buying
// levels catches a Scoba up rather than pushing it past anything.
import type { ScobaInstance } from "./scoba";
import { BABY_EVOLVE_LEVEL, MAX_LEVEL, evolve, raiseLevel } from "./scoba";
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

/** Why this Scoba cannot evolve right now, or null if it can. */
export function evolveError(s: ScobaInstance, aetus: number): string | null {
  const sp = SPECIES[s.speciesId];
  if (!sp) return "Unknown species.";
  if (!evolutionOf(sp)) return "Nothing to evolve into yet.";
  // A baby grows out of itself on reaching the level, so there is nothing to
  // buy: making it purchasable would be a second way out of a baby form.
  if (sp.baby) return `Grows up on its own at level ${BABY_EVOLVE_LEVEL}.`;
  if (aetus < EVOLVE_COST) return `Costs ${EVOLVE_COST} Aetus.`;
  return null;
}

export { evolve };
export { raiseLevel as levelUp };
