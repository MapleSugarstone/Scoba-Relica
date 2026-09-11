// Team validation for online battles. Play with a friend is trust-based, but
// ranked 2v2 re-derives what a Scoba could legally be: species, level, moves
// reachable through its learnset plus breeding inheritance, ability from its
// own pool (or anyone's, via breeding), and genes reachable through the 80/20
// breeding mix. Any two Scobas can breed, so every pool below is global.
import type { ScobaInstance } from "./scoba";
import { MOVES, SPECIES, rosterSpecies, speciesMoves, ABILITIES, type Species } from "./species";
import { BABY_BUDGET, STAT_BUDGET, STAT_CAPS, STAT_NAMES, statTotal, type Stats } from "./types";
import { MAX_BREED_COUNT, MAX_UNNATURAL } from "./breeding";

export interface LegalityOptions {
  maxLevel?: number;
  teamSize?: number;
}

/** Everything that can father a child, which is every line but the special one. */
function breedableSpecies(): Species[] {
  return rosterSpecies();
}

function inheritableMoves(): Set<string> {
  const pool = new Set<string>();
  for (const member of breedableSpecies()) {
    for (const l of member.learnset) pool.add(l.move);
  }
  return pool;
}

function inheritableAbilities(): Set<string> {
  const pool = new Set<string>();
  for (const member of breedableSpecies()) {
    for (const a of member.secondaryPool) pool.add(a);
  }
  return pool;
}

/**
 * How far off its budget a line may read before it is called impossible.
 * Breeding rounds per stat and evolution rounds again, so a line that has been
 * through both lands a point or two either side of where it started.
 */
export const BUDGET_SLACK = 12;

/** What a form is built on: the small budget for a baby, the full one else. */
export function budgetFor(sp: Species): number {
  if (sp.pawn) return statTotal(sp.genes);
  return sp.baby ? BABY_BUDGET : STAT_BUDGET;
}

/**
 * What is wrong with a base stat line, or nothing.
 *
 * Genes are checked against the budget rather than against an enumeration of
 * what breeding could reach. Every step preserves the budget: a child's line is
 * a weighted average of two lines already inside it, and evolution maps a line
 * onto the budget of the form it grows into. So a line inside its budget and
 * its caps is a line some pairing could have produced, and one outside it is a
 * line nothing could.
 */
export function geneErrors(sp: Species, genes: Stats, name: string): string[] {
  const errors: string[] = [];
  for (const stat of STAT_NAMES) {
    const v = genes[stat];
    if (!Number.isInteger(v)) {
      errors.push(`${name}: non-integer ${stat} gene`);
    } else if (v < 0) {
      errors.push(`${name}: negative ${stat} gene`);
    } else if (v > STAT_CAPS[stat]) {
      errors.push(`${name}: ${stat} gene ${v} is over the cap of ${STAT_CAPS[stat]}`);
    }
  }
  if (errors.length > 0) return errors;
  const total = statTotal(genes);
  const budget = budgetFor(sp);
  if (total > budget + BUDGET_SLACK) {
    errors.push(`${name}: base stats total ${total}, over the ${budget} a ${sp.name} is built on`);
  }
  return errors;
}

export function validateScoba(s: ScobaInstance, opts: LegalityOptions = {}): string[] {
  const errors: string[] = [];
  const sp = SPECIES[s.speciesId];
  if (!sp) return [`unknown species "${s.speciesId}"`];
  const name = s.nickname ?? sp.name;
  const maxLevel = opts.maxLevel ?? 100;

  if (!Number.isInteger(s.level) || s.level < 1 || s.level > maxLevel) {
    errors.push(`${name}: level ${s.level} outside 1-${maxLevel}`);
  }
  if (!Number.isInteger(s.breedCount) || s.breedCount < 0 || s.breedCount > MAX_BREED_COUNT) {
    errors.push(`${name}: impossible breed count ${s.breedCount}`);
  }
  if (sp.special) {
    errors.push(`${name}: special Scobas are not allowed in online battles`);
  }

  if (s.moves.length < 1 || s.moves.length > 4) {
    errors.push(`${name}: must know 1-4 moves`);
  }
  if (new Set(s.moves).size !== s.moves.length) {
    errors.push(`${name}: duplicate moves`);
  }
  // A bred child inherits mom's moves, which can sit above its own level, so
  // breeding unlocks the full own-species learnset for legality purposes.
  const own = new Set(
    s.breedCount > 0
      ? sp.learnset.map((l) => l.move)
      : speciesMoves(sp),
  );
  const inherited = inheritableMoves();
  let foreign = 0;
  for (const m of s.moves) {
    if (!MOVES[m]) {
      errors.push(`${name}: unknown move "${m}"`);
    } else if (!own.has(m)) {
      foreign += 1;
      if (!inherited.has(m)) {
        errors.push(`${name}: ${MOVES[m]!.name} is not learnable or inheritable`);
      }
    }
  }
  // One worked move at most, however many generations went into it: a second
  // one can only have come from somewhere breeding cannot reach.
  const allowedForeign = s.breedCount > 0 ? MAX_UNNATURAL : 0;
  if (foreign > allowedForeign) {
    errors.push(`${name}: ${foreign} inherited move(s) but ${allowedForeign} allowed`);
  }

  if (!ABILITIES[s.secondaryAbility]) {
    errors.push(`${name}: unknown ability "${s.secondaryAbility}"`);
  } else if (!sp.secondaryPool.includes(s.secondaryAbility)) {
    if (s.breedCount === 0) {
      errors.push(`${name}: ability ${s.secondaryAbility} not in its pool`);
    } else if (!inheritableAbilities().has(s.secondaryAbility)) {
      errors.push(`${name}: ability ${s.secondaryAbility} is on no Scoba's pool`);
    }
  }

  errors.push(...geneErrors(sp, s.genes, name));

  return errors;
}

export function validateTeam(team: ScobaInstance[], opts: LegalityOptions = {}): string[] {
  const errors: string[] = [];
  const size = opts.teamSize ?? 3;
  if (team.length < 1 || team.length > size) {
    errors.push(`team must have 1-${size} Scobas`);
  }
  if (new Set(team.map((s) => s.uid)).size !== team.length) {
    errors.push("duplicate team members");
  }
  for (const s of team) errors.push(...validateScoba(s, opts));
  return errors;
}
