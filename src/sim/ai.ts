// Deterministic enemy AI: derived from the battle seed and turn, so replays
// and peer verification stay reproducible.
//
// Aiming goes through the same target specs the player's picker uses, so a
// move the AI reaches for can never resolve to something a player could not
// have chosen.
//
// It also drives the Pawns nobody controls. That is the same code on a seed of
// its own: a Pawn picks between its spells exactly the way an enemy does, and
// which side it stands on changes nothing but who it aims at.
import type { BattleState, Choice, Combatant, Slot } from "./battle";
import {
  combatantMaxHp,
  combatantStats,
  moveReady,
  selfRunning,
  slotsAwaitingChoice,
  specsFor,
  targetOptions,
} from "./battle";
import { MAX_MANA, moveCost } from "./scoba";
import { MOVES, type Move } from "./species";
import { needsPick, type TargetRef } from "./targeting";
import { rngFrom } from "./rng";
import type { Rng } from "./rng";

/** How often a Scoba saving for a whole-bar spell holds its mana rather than
 * spending it on something cheaper. */
const SAVE_CHANCE = 0.55;

/** An ally under this share of its pool is worth healing. */
const HURT = 0.6;

export function enemyChoices(st: BattleState): Choice[] {
  return pickFor(st, 1, rngFrom(`${st.seed}:ai:${st.turn}`), () => true);
}

/**
 * The slots on a side that nobody is asked about: the Pawns that run
 * themselves. Side 1 is already covered by `enemyChoices`, so this is what the
 * player's own court is driven by.
 */
export function pawnChoices(st: BattleState, side: 0 | 1): Choice[] {
  // The label stays "motes" after the rename. It is a derivation key rather
  // than a name, and two clients on slightly different builds can pair peer to
  // peer, so changing it would change every roll one of them made.
  return pickFor(st, side, rngFrom(`${st.seed}:motes:${side}:${st.turn}`), selfRunning);
}

function pickFor(
  st: BattleState,
  side: 0 | 1,
  rng: Rng,
  wanted: (c: Combatant) => boolean,
): Choice[] {
  const out: Choice[] = [];
  for (const slot of slotsAwaitingChoice(st, side)) {
    const idx = st.active[side][slot] ?? -1;
    const c = st.teams[side][idx];
    if (!c || c.fainted || !wanted(c)) continue;
    out.push(actFor(st, side, slot, c, rng));
  }
  return out;
}

function actFor(st: BattleState, side: 0 | 1, slot: Slot, c: Combatant, rng: Rng): Choice {
  const idx = st.active[side][slot]!;
  const user: TargetRef = { side, index: idx };

  const usable = c.scoba.moves
    .map((id) => MOVES[id])
    .filter((m): m is Move => !!m && moveReady(c, m.id).ok);

  // Healing is never held back for a bigger spell later: an ally about to fall
  // is worth the bar.
  const healer = usable.find((m) => m.kind === "heal");
  if (healer && neediestAlly(st, user) !== null && rng() < 0.7) {
    const picks = aim(st, user, healer, rng);
    if (picks) return { kind: "spell", side, slot, moveId: healer.id, picks };
  }

  const holding = savingUp(c) && rng() < SAVE_CHANCE;
  const damaging = usable.filter((m) => m.kind !== "heal").sort((a, b) => b.scale - a.scale);
  let cast: { move: Move; picks: (TargetRef | null)[] } | null = null;
  if (!holding) {
    for (const move of damaging) {
      const picks = aim(st, user, move, rng);
      if (picks) {
        cast = { move, picks };
        break;
      }
    }
  }
  if (cast && rng() < 0.8) return { kind: "spell", side, slot, moveId: cast.move.id, picks: cast.picks };
  if (blockWorthwhile(c) && rng() < 0.35) return { kind: "block", side, slot };
  const picks = aim(st, user, null, rng);
  // Nothing left to swing at: brace instead of throwing an illegal choice.
  return picks ? { kind: "attack", side, slot, picks } : { kind: "block", side, slot };
}

/**
 * A spell that costs a whole bar can only ever be cast on a whole bar, so a
 * Scoba holding one stops spending rather than casting the bar away and never
 * climbing back to it. Only the ceiling itself triggers this: anything cheaper
 * is affordable again a turn or two after it goes off, and holding for it would
 * be a Scoba standing about for no reason.
 */
function savingUp(c: Combatant): boolean {
  return c.scoba.moves.some((id) => {
    const cost = moveCost(c.scoba, id);
    return cost >= MAX_MANA && c.mana < cost;
  });
}

/** The ally worth patching up, or null if nobody on that side is hurt enough. */
function neediestAlly(st: BattleState, user: TargetRef): TargetRef | null {
  const pool = targetOptions(st, user, { mode: "any-ally" })
    .filter((r) => share(st, r) < HURT)
    .sort((a, b) => share(st, a) - share(st, b));
  return pool[0] ?? null;
}

function share(st: BattleState, ref: TargetRef): number {
  const c = st.teams[ref.side][ref.index];
  if (!c) return 1;
  return c.hp / Math.max(1, combatantMaxHp(c));
}

/**
 * A pick for every spec the move asks for, or null if any of them has nothing
 * to aim at, which is how the caller knows to reach for a different move.
 */
function aim(st: BattleState, user: TargetRef, move: Move | null, rng: Rng): (TargetRef | null)[] | null {
  const specs = specsFor(
    move
      ? { kind: "spell", side: user.side, slot: 0, moveId: move.id, picks: [] }
      : { kind: "attack", side: user.side, slot: 0, picks: [] },
  );
  const picks: (TargetRef | null)[] = [];
  for (const spec of specs) {
    if (!needsPick(spec.mode)) {
      picks.push(null);
      continue;
    }
    const options = targetOptions(st, user, spec);
    if (options.length === 0) return null;
    // Enemies get the weakest legal target; an ally being healed gets the one
    // in the most trouble; anything else takes what it can.
    const hunting = spec.mode === "any-enemy" || spec.mode === "benched-enemy" || spec.mode === "any-scoba";
    const mending = move?.kind === "heal" && (spec.mode === "any-ally" || spec.mode === "other-ally");
    const pool = hunting
      ? [...options].sort((a, b) => hpOf(st, a) - hpOf(st, b))
      : mending
        ? [...options].sort((a, b) => share(st, a) - share(st, b))
        : options;
    // A heal aims at whoever needs it rather than rolling among the top two:
    // spreading it around is how a Pawn wastes its bar on a full ally.
    const spread = mending ? 1 : 2;
    picks.push(pool[Math.floor(rng() * Math.min(spread, pool.length))] ?? pool[0]!);
  }
  return picks;
}

function hpOf(st: BattleState, ref: TargetRef): number {
  return st.teams[ref.side][ref.index]?.hp ?? 0;
}

function blockWorthwhile(c: Combatant): boolean {
  return c.hp < combatantMaxHp(c) * 0.35 && combatantStats(c).def > 0;
}
