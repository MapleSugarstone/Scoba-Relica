// The seam between a running battle and the relay.
//
// Both clients resolve every turn themselves. `resolveTurn` is deterministic
// given the same state and the same choices, and the turn rng comes from the
// battle seed, so the relay only has to carry what each player decided and
// never has to decide anything. That is what keeps a fight costing two small
// messages a round instead of a simulation on a server.
import type { Answer, Choice, OwnerId } from "../sim/battle";
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
  /** What one of the peer's Scobas answered a question with, mid-round. */
  peerAnswer(turn: number, seq: string, index: number, answer: Answer): void;
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
    // A repeat for the same mark replaces rather than stacks: a reconnecting
    // peer can resend a choice it is not sure arrived. Both sides are keyed,
    // since a fight between the two players has a peer on the other side.
    const existing = list.findIndex((c) => c.side === choice.side && c.slot === choice.slot);
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
 * What one run of questions a round stopped on has been answered with. A round
 * and a replacement walking on each ask from zero, so the answers are filed
 * under the turn and the name of the run as well as the question's place in it.
 *
 * A question that reaches here before the local client has worked out that it
 * was asked is kept, and one the local client is already waiting on wakes the
 * wait. Both clients ask the same questions in the same order, so the place in
 * the run is all either of them needs to pair an answer with its question.
 */
export class PeerAnswers {
  private held = new Map<string, Answer>();
  private waiting = new Map<string, ((answer: Answer) => void)[]>();

  private static key(turn: number, seq: string, index: number): string {
    return `${turn}:${seq}:${index}`;
  }

  add(turn: number, seq: string, index: number, answer: Answer): void {
    const key = PeerAnswers.key(turn, seq, index);
    this.held.set(key, answer);
    for (const wake of this.waiting.get(key) ?? []) wake(answer);
    this.waiting.delete(key);
  }

  /** What the peer said, waiting for it if it has not arrived yet. */
  get(turn: number, seq: string, index: number): Promise<Answer> {
    const key = PeerAnswers.key(turn, seq, index);
    const held = this.held.get(key);
    if (held) return Promise.resolve(held);
    return new Promise((wake) => {
      this.waiting.set(key, [...this.waiting.get(key) ?? [], wake]);
    });
  }

  /** Everything up to and including `turn` is spent once the turn resolves. */
  clearThrough(turn: number): void {
    for (const key of [...this.held.keys()]) {
      if (Number(key.split(":")[0]) <= turn) this.held.delete(key);
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
  /**
   * Which side this client plays. Both players stand on side 0 in a co-op
   * fight, which is every fight there is for now. A fight between the two of
   * them would put one of them on side 1, and everything that routes a choice
   * or an answer reads the side off the message rather than assuming this one.
   */
  localSide?: 0 | 1;
  /**
   * Who fills side 1's choices. "ai" is the enemy hand every fight uses now;
   * "peer" would be the other player, and nothing asks the AI in that case.
   */
  enemyHand?: "ai" | "peer";
  send(msg: ClientMessage): void;
}
