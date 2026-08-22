// Who the Relica is walking with.
//
// It picks one of the two characters and stays with them, rather than riding
// between them, because once the players can separate there is no "between"
// to ride. Left alone with one of them it stays with that one and quietly runs
// up a debt to the other; when the two of them are back together it goes and
// pays that debt off, and over a session it ends up having spent about the same
// time with each.
//
// It moves in stints rather than continuously, because a companion that
// reconsidered every frame would sit exactly halfway and twitch, which is the
// thing being replaced.
import type { OwnerId } from "./battle";

export interface Companionship {
  /** Who it is with now. */
  with: OwnerId;
  /** Seconds spent with each, ever. The difference is what it tries to close. */
  withA: number;
  withB: number;
  /** Seconds before it will consider moving to the other one. */
  stint: number;
}

/** Short enough to feel responsive, long enough not to read as indecision. */
export const MIN_STINT_S = 20;
/** However large the debt, it checks in this often. */
export const MAX_STINT_S = 90;
/** Under this the two are close enough to even that it stops chasing the difference. */
export const EVEN_ENOUGH_S = 3;

export function newCompanionship(start: OwnerId = "A"): Companionship {
  return { with: start, withA: 0, withB: 0, stint: MIN_STINT_S };
}

const other = (o: OwnerId): OwnerId => (o === "A" ? "B" : "A");
const timeWith = (s: Companionship, o: OwnerId): number => (o === "A" ? s.withA : s.withB);

/** How long to stay, given how much catching up there is to do. */
function stintFor(debt: number): number {
  return Math.max(MIN_STINT_S, Math.min(MAX_STINT_S, debt));
}

/**
 * Advance by `dt` seconds. `here` says which characters the Relica could
 * actually be with: one of them being away is what creates the debt in the
 * first place, and is also why it cannot simply always pick the neglected one.
 */
export function advanceCompanionship(
  state: Companionship,
  dt: number,
  here: { A: boolean; B: boolean },
): Companionship {
  const next: Companionship = { ...state };
  const away = other(next.with);

  // Whoever it is actually beside gets the credit, including when that is the
  // only choice available.
  if (next.with === "A") next.withA += dt;
  else next.withB += dt;
  next.stint -= dt;

  const mineHere = here[next.with];
  const theirsHere = here[away];

  // Its character has gone and the other one is right here. Nothing to weigh
  // up: it goes with the one who is present.
  if (!mineHere && theirsHere) {
    next.with = away;
    next.stint = stintFor(timeWith(next, next.with) === 0 ? MAX_STINT_S : debtTo(next, away));
    return next;
  }

  // Nobody to reconsider with, or not yet time to.
  if (!theirsHere || next.stint > 0) return next;

  // Both are here and the stint is up. Go to whoever is owed time; if they are
  // level, stay put and look again shortly rather than swapping for its own
  // sake.
  const owed = debtTo(next, away);
  if (owed > EVEN_ENOUGH_S) {
    next.with = away;
    next.stint = stintFor(owed);
  } else {
    next.stint = MIN_STINT_S;
  }
  return next;
}

/** How much more time the other one has had than `o`, floored at zero. */
function debtTo(s: Companionship, o: OwnerId): number {
  return Math.max(0, timeWith(s, other(o)) - timeWith(s, o));
}

/** How lopsided things are, for anything that wants to say so. */
export function companionshipBalance(s: Companionship): number {
  const total = s.withA + s.withB;
  return total <= 0 ? 0 : (s.withA - s.withB) / total;
}
