// Team validation for online battles. Play with a friend is trust-based, but
// ranked 2v2 re-derives what a Scoba could legally be: species, level, moves
// reachable through its learnset plus breeding inheritance, ability from its
// own pool (or anyone's, via breeding), and genes reachable through the 80/20
// breeding mix. Any two Scobas can breed, so every pool below is global.
import type { ScobaInstance } from "./scoba";
import { MOVES, SPECIES, rosterSpecies, speciesMoves, ABILITIES, type Species } from "./species";
import { STAT_NAMES } from "./types";
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
 * Per-stat gene values reachable for this species with `breedCount` breeding
 * steps. Genes mix per-stat as round(0.8*mom + 0.2*dad), mom always the same
 * species as the child, dad anything at all, and parents of a count-k child
 * have count <= k-1. Two breeding steps keep these sets small.
 */
export function reachableGenes(sp: Species, breedCount: number, stat: (typeof STAT_NAMES)[number]): Set<number> {
  const lines = breedableSpecies();
  const gen: Map<string, Set<number>>[] = [];
  gen[0] = new Map(lines.map((m) => [m.id, new Set([m.genes[stat]])]));
  for (let k = 1; k <= breedCount; k++) {
    const prevUnion = new Map<string, Set<number>>();
    for (const m of lines) {
      const u = new Set<number>();
      for (let j = 0; j < k; j++) for (const v of gen[j]!.get(m.id) ?? []) u.add(v);
      prevUnion.set(m.id, u);
    }
    gen[k] = new Map(
      lines.map((m) => {
        const out = new Set<number>();
        for (const momV of prevUnion.get(m.id)!) {
          for (const dadSp of lines) {
            for (const dadV of prevUnion.get(dadSp.id)!) {
              out.add(Math.round(0.8 * momV + 0.2 * dadV));
            }
          }
        }
        return [m.id, out];
      }),
    );
  }
  return gen[breedCount]!.get(sp.id) ?? new Set();
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

  const bc = Math.min(Math.max(s.breedCount, 0), MAX_BREED_COUNT);
  for (const stat of STAT_NAMES) {
    const v = s.genes[stat];
    if (!Number.isInteger(v)) {
      errors.push(`${name}: non-integer ${stat} gene`);
      continue;
    }
    let ok = false;
    for (let k = 0; k <= bc && !ok; k++) {
      if (reachableGenes(sp, k, stat).has(v)) ok = true;
    }
    if (!ok) errors.push(`${name}: ${stat} gene ${v} unreachable by breeding`);
  }

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
