// Who a move is aimed at. A move carries an ordered list of target specs, and
// picking it walks the player through them one at a time, so even a move with
// one possible target still asks before it goes off.
//
// Targets are named by team index rather than by active slot, so a spec can
// reach a Scoba sitting on the bench.
import type { BattleState, Combatant } from "./battle";
import type { Rng } from "./rng";

/**
 * The field is two rows of marks per side. The first are the Scoba slots, one
 * per character, filled from the party and swapped between. The rest are Pawn
 * slots: nobody starts on them and nothing walks off them, they are filled by
 * summoning alone.
 *
 * Both rows live in the one `active` array, which is what lets a Pawn be aimed
 * at, rolled onto and swept up by a team move without a second code path.
 * These live here rather than in `battle.ts` because `battle.ts` imports this
 * module and not the other way round.
 */
export const SCOBA_SLOTS = 2;
export const PAWN_SLOTS = 3;
export const FIELD_SLOTS = SCOBA_SLOTS + PAWN_SLOTS;

/** Every mark on one side, Scoba slots first. */
export const ALL_SLOTS: number[] = Array.from({ length: FIELD_SLOTS }, (_v, i) => i);

export function isPawnSlot(slot: number): boolean {
  return slot >= SCOBA_SLOTS && slot < FIELD_SLOTS;
}

export type TargetMode =
  /** The caster. No pick. */
  | "self"
  /** Pick one standing ally, the caster included. */
  | "any-ally"
  /** Pick one standing ally other than the caster. */
  | "other-ally"
  /** Pick one standing enemy. */
  | "any-enemy"
  /** Pick anyone standing, either side. */
  | "any-scoba"
  /** Pick from your own bench. */
  | "benched-ally"
  /** Pick from the enemy bench. */
  | "benched-enemy"
  /** Every standing ally. No pick. */
  | "ally-team"
  /** Every standing enemy. No pick. */
  | "enemy-team"
  /** Rolled at resolve time from the seed, not chosen. */
  | "random-ally"
  | "random-enemy"
  | "random-scoba";

export interface TargetSpec {
  mode: TargetMode;
  /** Shown above the picker, e.g. "Drain from". */
  prompt?: string;
}

/** One combatant, by side and index into that side's team. */
export interface TargetRef {
  side: 0 | 1;
  index: number;
}

/** Short label for the move list and the picker header. */
export const TARGET_LABELS: Record<TargetMode, string> = {
  "self": "self",
  "any-ally": "one ally",
  "other-ally": "another ally",
  "any-enemy": "one enemy",
  "any-scoba": "anyone",
  "benched-ally": "a benched ally",
  "benched-enemy": "a benched enemy",
  "ally-team": "all allies",
  "enemy-team": "all enemies",
  "random-ally": "a random ally",
  "random-enemy": "a random enemy",
  "random-scoba": "someone at random",
};

const PICKED: TargetMode[] = [
  "any-ally", "other-ally", "any-enemy", "any-scoba", "benched-ally", "benched-enemy",
];

const RANDOM: TargetMode[] = ["random-ally", "random-enemy", "random-scoba"];

/** Does this spec stop and ask the player, or work itself out? */
export function needsPick(mode: TargetMode): boolean {
  return PICKED.includes(mode);
}

export function isRandom(mode: TargetMode): boolean {
  return RANDOM.includes(mode);
}

export function sameRef(a: TargetRef, b: TargetRef): boolean {
  return a.side === b.side && a.index === b.index;
}

export function combatantAt(st: BattleState, ref: TargetRef): Combatant | null {
  return st.teams[ref.side][ref.index] ?? null;
}

const other = (side: 0 | 1): 0 | 1 => (side === 0 ? 1 : 0);

/**
 * Team indices standing on one of the side's marks, Pawns included: a Pawn is
 * on the field and is aimed at, rolled onto and swept up like anything else
 * standing there.
 */
function standing(st: BattleState, side: 0 | 1): number[] {
  const out: number[] = [];
  for (const slot of ALL_SLOTS) {
    const idx = st.active[side][slot] ?? -1;
    if (idx >= 0 && !st.teams[side][idx]?.fainted) out.push(idx);
  }
  return out;
}

/** Team indices that are alive but not currently out. */
function benched(st: BattleState, side: 0 | 1): number[] {
  const out: number[] = [];
  st.teams[side].forEach((c, i) => {
    if (!c.fainted && !st.active[side].includes(i)) out.push(i);
  });
  return out;
}

/**
 * Everyone a spec could land on. For picked modes this is the menu the player
 * chooses from; for team and random modes it is the pool the spec draws from.
 */
export function candidates(st: BattleState, user: TargetRef, mode: TargetMode): TargetRef[] {
  const ally = user.side;
  const foe = other(user.side);
  const refs = (side: 0 | 1, list: number[]): TargetRef[] => list.map((index) => ({ side, index }));
  switch (mode) {
    case "self":
      return [user];
    case "any-ally":
    case "ally-team":
    case "random-ally":
      return refs(ally, standing(st, ally));
    case "other-ally":
      return refs(ally, standing(st, ally)).filter((r) => !sameRef(r, user));
    case "any-enemy":
    case "enemy-team":
    case "random-enemy":
      return refs(foe, standing(st, foe));
    case "any-scoba":
    case "random-scoba":
      return [...refs(ally, standing(st, ally)), ...refs(foe, standing(st, foe))];
    case "benched-ally":
      return refs(ally, benched(st, ally));
    case "benched-enemy":
      return refs(foe, benched(st, foe));
  }
}

/**
 * What a spec actually hits. Picked modes take the player's choice (validated
 * against the menu), team modes take everyone, and random modes roll from the
 * shared turn rng so both clients land on the same Scoba.
 */
export function resolveTargets(
  st: BattleState,
  user: TargetRef,
  spec: TargetSpec,
  pick: TargetRef | null,
  rng: Rng,
): TargetRef[] {
  const pool = candidates(st, user, spec.mode);
  if (pool.length === 0) return [];
  if (needsPick(spec.mode)) {
    if (!pick) return [];
    return pool.some((r) => sameRef(r, pick)) ? [pick] : [];
  }
  if (isRandom(spec.mode)) return [pool[Math.floor(rng() * pool.length)]!];
  if (spec.mode === "self") return [user];
  return pool;
}

/** Why a pick is not allowed, or null if it is. Used by the cheat check. */
export function pickError(
  st: BattleState,
  user: TargetRef,
  spec: TargetSpec,
  pick: TargetRef | null,
): string | null {
  if (!needsPick(spec.mode)) return pick ? "That target is chosen for you." : null;
  const pool = candidates(st, user, spec.mode);
  // Nothing to aim at is not the player's fault: the move fizzles instead.
  if (pool.length === 0) return null;
  if (!pick) return "Pick a target.";
  return pool.some((r) => sameRef(r, pick)) ? null : "Not a legal target.";
}
