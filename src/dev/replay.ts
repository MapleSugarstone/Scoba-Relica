// Running a recorded fight again. A replay holds the state each round opened
// on and the picks it was handed, so a round is re-run by handing both back to
// the same function that ran it the first time.
import { resolveTurn, stateHash, type BattleEvent, type BattleState } from "../sim/battle";
import { recording, resumeReplay, stopReplay, takeReplay, type Replay } from "../sim/replay";

export interface RanRound {
  turn: number;
  events: BattleEvent[];
  /** The battle the round left behind. */
  after: BattleState;
  hash: string;
}

/**
 * Every round of a replay, run again in order.
 *
 * Each round starts from its own recorded state rather than from the one the
 * round before it left, so a round that the fight reached by some other route,
 * such as a walk-on between rounds, still opens on what it actually opened on.
 *
 * A fight that travelled back in time records the rounds it replayed as rounds
 * of their own, and re-running the round that sent it back runs those again,
 * so they appear twice. That is what happened rather than a fault in the file.
 */
export function runReplay(data: Replay): RanRound[] {
  // A recording in progress is not fed the rounds of an old one.
  const held = recording() ? takeReplay() : null;
  stopReplay();
  const ran: RanRound[] = [];
  try {
    for (const round of data.rounds) {
      const st = structuredClone(round.before);
      // The answers go back in with the choices: a round that stopped to ask
      // is only the same round again if it is told the same things.
      const events = resolveTurn(st, structuredClone(round.choices), structuredClone(round.answers ?? []));
      ran.push({ turn: round.turn, events, after: st, hash: stateHash(st) });
    }
  } finally {
    if (held) resumeReplay(held);
  }
  return ran;
}

/** A replay run again, as lines to read rather than as objects to dig through. */
export function replayLog(data: Replay): string[] {
  const out: string[] = [`${data.rounds.length} rounds, build ${data.build}, taken ${data.taken}`];
  if (data.note) out.push(`note: ${data.note}`);
  for (const r of runReplay(data)) {
    out.push(`--- turn ${r.turn} (${r.hash})`);
    for (const ev of r.events) out.push(`  [${ev.kind}] ${ev.text}`);
  }
  return out;
}
