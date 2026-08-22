// The seam between a running battle and the relay.
//
// Both clients resolve every turn themselves. `resolveTurn` is deterministic
// given the same state and the same choices, and the turn rng comes from the
// battle seed, so the relay only has to carry what each player decided and
// never has to decide anything. That is what keeps a fight costing two small
// messages a round instead of a simulation on a server.
import type { Choice, OwnerId } from "../sim/battle";
import type { ScobaInstance } from "../sim/scoba";
import type { BattleState } from "../sim/battle";
import type { ClientMessage } from "./protocol";

export interface BattleLink {
  /** The character this client answers for. */
  readonly localOwner: OwnerId;
  /** True on the client that started the fight. */
  readonly isHost: boolean;
  readonly battleId: string;
  send(msg: ClientMessage): void;
}

/** What a live battle exposes to the session so peer messages can reach it. */
export interface NetBattle {
  battleId: string;
  /** A choice the peer picked for one of their slots. */
  peerChoice(turn: number, choice: Choice): void;
  /** A replacement the peer walked on between rounds. */
  peerSendIn(turn: number, slot: 0 | 1, benchIndex: number): void;
  /** The peer walking into the fight, with the team this client has not seen. */
  peerJoin(guest: OwnerId, team: ScobaInstance[]): void;
  /** The peer's fight ended, so this one should stop waiting on them. */
  peerLeft(): void;
  /** Two clients resolved a turn differently. */
  desynced(reason: string): void;
  /** Internals, for diagnosing a co-op fight that will not start. */
  debug(): object;
}

/**
 * A fight the peer has started that this client has not walked into yet. Held
 * by the session until the player reaches the marker in the overworld.
 */
export interface PendingBattle {
  battleId: string;
  host: OwnerId;
  at: { x: number; y: number };
}

/** Rounds are keyed by turn so a message that arrives early is not lost. */
export class PeerChoices {
  private byTurn = new Map<number, Choice[]>();

  add(turn: number, choice: Choice): void {
    const list = this.byTurn.get(turn) ?? [];
    // A repeat for the same slot replaces rather than stacks: a reconnecting
    // peer can resend a choice it is not sure arrived.
    const existing = list.findIndex((c) => c.slot === choice.slot);
    if (existing >= 0) list[existing] = choice;
    else list.push(choice);
    this.byTurn.set(turn, list);
  }

  /** What the peer has said about this turn so far. */
  forTurn(turn: number): Choice[] {
    return this.byTurn.get(turn) ?? [];
  }

  /** Everything up to and including `turn` is spent once the turn resolves. */
  clearThrough(turn: number): void {
    for (const key of [...this.byTurn.keys()]) {
      if (key <= turn) this.byTurn.delete(key);
    }
  }
}

/**
 * What a networked battle is handed when it opens. `adopted` is set on the
 * guest, which receives the host's state rather than building its own.
 */
export interface BattleNet {
  battleId: string;
  /** The character this client answers for; the other one is the peer's. */
  localOwner: OwnerId;
  isHost: boolean;
  adopted?: BattleState;
  send(msg: ClientMessage): void;
}
