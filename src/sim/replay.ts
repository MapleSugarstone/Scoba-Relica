// Recording a fight so it can be run again somewhere else. Every round is
// filed as the state it opened on and the picks it was handed, which is all
// `resolveTurn` needs, so a replay reproduces the events exactly rather than
// approximately.
//
// Recording is off unless something turns it on, and the cost of a round that
// is not being recorded is one boolean.
import type { BattleState, Choice } from "./battle";

/** What one round needs to be run again. */
export interface ReplayRound {
  turn: number;
  /**
   * The battle as the round opened, history included. The history is what a
   * rewind reads, so a round that travels back in time cannot be replayed
   * without it.
   */
  before: BattleState;
  /** The picks as they were handed in, before the round sorted them. */
  choices: Choice[];
}

export interface Replay {
  kind: "scoba-replay";
  version: number;
  /** Which build recorded it, so an old file is recognisable as old. */
  build: string;
  /** When it was taken, ISO 8601. */
  taken: string;
  /** Whatever the person taking it typed, which is usually what went wrong. */
  note: string;
  rounds: ReplayRound[];
}

export const REPLAY_VERSION = 2;

let rounds: ReplayRound[] | null = null;
let build = "dev";

/** Whether rounds are being filed. Read before every clone, so keep it cheap. */
export function recording(): boolean {
  return rounds !== null;
}

/** Starts a fresh recording, throwing away whatever was being recorded. */
export function startReplay(buildName = "dev"): void {
  rounds = [];
  build = buildName;
}

export function stopReplay(): void {
  rounds = null;
}

/** Picks a recording back up where it was put down, rounds and all. */
export function resumeReplay(data: Replay): void {
  rounds = data.rounds;
  build = data.build;
}

/**
 * Files a round. The caller clones, because it is the one that knows whether
 * anything is listening.
 */
export function logRound(turn: number, before: BattleState, choices: Choice[]): void {
  rounds?.push({ turn, before, choices });
}

/** The recording so far, or null if nothing is being recorded. */
export function takeReplay(note = ""): Replay | null {
  if (!rounds) return null;
  return {
    kind: "scoba-replay",
    version: REPLAY_VERSION,
    build,
    taken: new Date().toISOString(),
    note,
    rounds,
  };
}

/** Reads a file back, and says what is wrong with it rather than guessing. */
export function parseReplay(text: string): Replay {
  const data = JSON.parse(text) as Partial<Replay>;
  if (data.kind !== "scoba-replay") throw new Error("not a replay file");
  if (!Array.isArray(data.rounds)) throw new Error("replay has no rounds");
  return data as Replay;
}
