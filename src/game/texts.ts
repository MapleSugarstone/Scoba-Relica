// What the game says about a thing.
//
// A move or a passive says what its `text` line in move script says, and the
// game builds a sentence out of its effects where it has none. A line says its
// species' blurb. The cosmetics editor's Words boxes edit those same records, so
// there is one copy of each line.
import { describeAbility, describeMoveEffects } from "../sim/describe";
import { speciesName, type ScobaInstance } from "../sim/scoba";
import { ABILITIES, SPECIES, type Move, type Species } from "../sim/species";

/** What a line of words can be about. */
export type TextKind = "species" | "ability" | "move";

/** What a passive does: the line it ships with, then the sentence the game builds itself. */
export function abilityText(id: string): string {
  return ABILITIES[id]?.text ?? describeAbility(id);
}

/** What a move does, without its cost line: the line it ships with, then the sentence the game builds itself. */
export function moveText(move: Move): string {
  return move.text ?? describeMoveEffects(move);
}

/** What a line is, for the index and the picker. */
export function speciesText(sp: Species): string {
  return sp.blurb ?? "";
}

/**
 * What one Scoba is, for its card: its species' line, or for a hybrid, which
 * has no line of its own to read, the two it was bred from.
 */
export function scobaText(s: ScobaInstance): string {
  const mother = SPECIES[s.speciesId];
  const father = s.hybrid && s.sire ? SPECIES[s.sire] : undefined;
  if (mother && father) {
    return `${speciesName(s)} is a hybrid of ${mother.name} and ${father.name}. `
      + "Not much is known about this species, as it isn't common in the wild. "
      + "But it's safe to assume it has some traits from both its parents.";
  }
  return mother ? speciesText(mother) : "";
}
