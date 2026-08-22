// Two people setting up an adventure together, before either save exists.
//
// The point of doing it here rather than separately is that both players walk
// into the world at the same instant, which is what an opening scene needs. It
// also means each of them sees what the other is choosing, so the Scoba one has
// taken is greyed out for the other rather than discovered afterwards.
//
// Nobody has a save yet, so this owns its own connection and hands over to the
// real session once the game starts.
import { Relay, type RelayStatus } from "./relay";
import { PROTOCOL_VERSION, type CharacterProfile, type ServerMessage } from "./protocol";
import type { SlotId } from "../save/save";

export interface LobbySeat {
  /** Null until they have finished making their character. */
  character: CharacterProfile | null;
  /** They have a character and a starter, and are waiting on the other. */
  ready: boolean;
  /** They are connected right now. */
  here: boolean;
}

export interface LobbyState {
  A: LobbySeat;
  B: LobbySeat;
}

export interface LobbyHooks {
  /** Anything changed: who is here, what they have chosen, whether they are ready. */
  onState(state: LobbyState): void;
  /** Both are ready and the world is settled. Build a save and go. */
  onStart(worldSeed: string): void;
  onStatus(status: RelayStatus): void;
  onError(reason: string): void;
}

const empty = (): LobbySeat => ({ character: null, ready: false, here: false });

export class Lobby {
  private relay: Relay | null = null;
  private state: LobbyState = { A: empty(), B: empty() };
  private started = false;

  constructor(
    readonly room: string,
    readonly mine: SlotId,
    private readonly hooks: LobbyHooks,
  ) {}

  get isHost(): boolean {
    return this.mine === "A";
  }

  get seats(): LobbyState {
    return this.state;
  }

  open(): void {
    this.state[this.mine].here = true;
    this.relay = new Relay(this.room, this.mine, {
      onMessage: (msg) => this.receive(msg),
      onStatus: (status) => this.hooks.onStatus(status),
    });
    // Announce an empty seat straight away, so the other side knows somebody
    // has arrived even before a character exists.
    this.announce();
  }

  close(): void {
    this.relay?.close();
    this.relay = null;
  }

  /** Say what we have chosen so far. Called as each step is finished. */
  setMine(character: CharacterProfile | null, ready: boolean): void {
    this.state[this.mine] = { character, ready, here: true };
    this.announce();
    this.hooks.onState(this.state);
    this.maybeStart();
  }

  /** The Scoba the other player has taken, if they have taken one. */
  takenStarter(): string | null {
    const other = this.mine === "A" ? "B" : "A";
    return this.state[other].character?.starter ?? null;
  }

  private announce(): void {
    const seat = this.state[this.mine];
    this.relay?.send({
      t: "lobby", slot: this.mine, character: seat.character, ready: seat.ready,
    });
  }

  /**
   * Only the host calls it. Somebody has to, or the two of them would each
   * generate a world and walk into different ones.
   */
  private maybeStart(): void {
    if (!this.isHost || this.started) return;
    if (!this.state.A.ready || !this.state.B.ready) return;
    this.started = true;
    const worldSeed = Math.random().toString(36).slice(2, 10);
    this.relay?.send({ t: "lobby-start", worldSeed });
    this.hooks.onStart(worldSeed);
  }

  private receive(msg: ServerMessage): void {
    switch (msg.t) {
      case "hello-ok": {
        // Setting up is exactly when an out-of-date relay bites: it drops every
        // message the two of you say to each other and both of you sit waiting
        // on somebody who is talking into a wall.
        const theirs = msg.protocol ?? 1;
        if (theirs !== PROTOCOL_VERSION) {
          this.hooks.onError(
            `the relay is on version ${theirs} and this game needs ${PROTOCOL_VERSION}. It has not been redeployed, so the two of you cannot hear each other.`,
          );
        }
        return;
      }
      case "peer": {
        const other = this.mine === "A" ? "B" : "A";
        const wasHere = this.state[other].here;
        this.state[other].here = msg.room.slotTaken[other];
        // Somebody who has just walked in has not heard anything we said, so
        // it all gets said again rather than waiting for them to ask.
        if (this.state[other].here && !wasHere) this.announce();
        if (!this.state[other].here) {
          this.state[other].character = null;
          this.state[other].ready = false;
        }
        this.hooks.onState(this.state);
        return;
      }
      case "lobby": {
        if (msg.slot === this.mine) return;
        this.state[msg.slot] = { character: msg.character, ready: msg.ready, here: true };
        this.hooks.onState(this.state);
        this.maybeStart();
        return;
      }
      case "lobby-start":
        if (this.started) return;
        this.started = true;
        this.hooks.onStart(msg.worldSeed);
        return;
      case "error":
        this.hooks.onError(msg.reason);
        return;
      default:
        return;
    }
  }
}
