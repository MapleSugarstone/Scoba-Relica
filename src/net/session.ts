// Owns the relay connection for a loaded save and applies what arrives to it.
// Care is settled here; battle messages are handed to the running fight, which
// is the only thing that knows what to do with them.
import { advanceCare, type CareState } from "../sim/care";
import type { SaveData } from "../save/save";
import { Relay, type RelayStatus } from "./relay";
import type { ClientMessage, PushSubscriptionJson, ServerMessage } from "./protocol";
import type { NetBattle, PendingBattle } from "./battlelink";
import { LocalTrack, RemoteTrack, type LocalState, type Step } from "./presence";
import type { Companionship } from "../sim/companionship";
import {
  PeerLink, DIRECT_INTERVAL_MS, RELAY_INTERVAL_MS, type Carrier,
} from "./peerlink";
import type { BattleState, OwnerId } from "../sim/battle";
import type { ScobaInstance } from "../sim/scoba";

export interface SessionHooks {
  /** Care or flags changed underneath the game and the save needs writing. */
  onSaveChanged(): void;
  /** Connection state, for the Connect screen to read out. */
  onStatus(status: RelayStatus, partnerHere: boolean): void;
  onError(reason: string): void;
  /** Every message from the peer, for diagnosing a stuck co-op fight. */
  onTraffic?(kind: string): void;
  /** The peer started a fight somewhere; stand a marker on it. */
  onBattleOpened(battle: PendingBattle): void;
  /** The peer's fight ended before this player reached it. */
  onBattleClosed(battleId: string): void;
  /** The host handed over a fight this player has just walked into. */
  onBattleAdopted(battleId: string, state: BattleState): void;
  /** The running fight, if there is one, so peer messages can reach it. */
  liveBattle(): NetBattle | null;
  /** How position updates are travelling, for the diagnostics readout. */
  onCarrier?(carrier: Carrier): void;
}

export class Session {
  private relay: Relay | null = null;
  private status: RelayStatus = "offline";
  private partnerHere = false;
  private peer: PeerLink | null = null;
  /** What we send, and how often, which depends on what is carrying it. */
  private mine = new LocalTrack(RELAY_INTERVAL_MS);
  /** What the other player sent, smoothed into something worth drawing. */
  readonly theirs = new RemoteTrack();

  constructor(private save: SaveData, private hooks: SessionHooks) {}

  get connected(): boolean {
    return this.status === "live";
  }

  /** No room code means single-machine play, and nothing dials out. */
  start(): void {
    this.stop();
    if (!this.save.room) return;
    this.relay = new Relay(this.save.room, this.save.localSlot, {
      onMessage: (msg) => this.receive(msg),
      onStatus: (s) => {
        this.status = s;
        if (s !== "live") this.partnerHere = false;
        this.hooks.onStatus(s, this.partnerHere);
      },
    });
    this.relay.setSaveRev(this.save.careRev ?? 0);
  }

  stop(): void {
    this.peer?.close();
    this.peer = null;
    this.theirs.reset();
    this.relay?.close();
    this.relay = null;
    this.status = "offline";
    this.partnerHere = false;
  }

  /**
   * Report where this player is. Called every frame; the track decides whether
   * anything is worth sending, and the peer link decides how it travels.
   */
  reportPosition(now: number, state: LocalState): void {
    if (!this.peer || !this.partnerHere) return;
    const step = this.mine.tick(now, state);
    if (step) this.peer.send(step);
  }

  /**
   * Say who the Relica has gone off with. Only character A decides, so only
   * character A says; B applies what it is told.
   */
  shareCompanionship(state: Companionship): void {
    if (this.save.localSlot !== "A") return;
    this.relay?.send({ t: "relica", state });
  }

  /** True when this client is the one deciding where the Relica goes. */
  get decidesCompanionship(): boolean {
    return this.save.localSlot === "A" || !this.partnerHere;
  }

  /** Where to draw the other player, or null if they have not been heard from. */
  peerAt(now: number) {
    return this.theirs.sample(now);
  }

  get carrier(): Carrier {
    return this.peer?.carrier ?? "none";
  }

  /**
   * Stood up once both players are in the room, and only then: a peer
   * connection needs someone on the other end to negotiate with.
   */
  private openPeerLink(): void {
    if (this.peer || !this.partnerHere) return;
    // Character A offers, B answers. Fixed by slot so the two of them cannot
    // both offer and collide.
    this.peer = new PeerLink(this.save.localSlot === "A", {
      signal: (msg) => this.relay?.send(msg),
      viaRelay: (step) => this.relay?.send({ t: "at", step }),
      onStep: (step) => this.theirs.push(step, performance.now()),
      onCarrier: (carrier) => {
        // A direct connection costs nothing per message, so it is worth being
        // chatty on; the relay is billed and is not.
        this.mine.setInterval(carrier === "direct" ? DIRECT_INTERVAL_MS : RELAY_INTERVAL_MS);
        this.hooks.onCarrier?.(carrier);
      },
    });
    this.peer.start();
  }

  private closePeerLink(): void {
    this.peer?.close();
    this.peer = null;
    this.theirs.reset();
  }

  /**
   * Called after a local feed, wash or play. The revision is what lets the
   * relay order two clients that both changed the Relica while apart, and it
   * has to go up before the push or the push loses to its own last one.
   */
  pushCare(): void {
    if (!this.relay) return;
    const rev = (this.save.careRev ?? 0) + 1;
    this.save.careRev = rev;
    this.relay.setSaveRev(rev);
    this.relay.send({ t: "care-sync", room: this.save.room!, state: this.save.special, rev });
  }

  /** Hands a push subscription to the room so it can wake both players. */
  sendSubscription(sub: PushSubscriptionJson): void {
    if (!this.relay || !this.save.room) return;
    this.relay.send({ t: "push-subscribe", room: this.save.room, sub });
  }

  dropSubscription(): void {
    if (!this.relay || !this.save.room) return;
    this.relay.send({ t: "push-unsubscribe", room: this.save.room });
  }

  pushFlags(): void {
    if (!this.relay) return;
    const rev = (this.save.careRev ?? 0) + 1;
    this.save.careRev = rev;
    this.relay.send({
      t: "story-flags", room: this.save.room!, flags: this.save.story.flags, rev,
    });
  }

  /** A running fight only answers for messages about itself. */
  private forBattle(battleId: string): NetBattle | null {
    const live = this.hooks.liveBattle();
    return live && live.battleId === battleId ? live : null;
  }

  /** Pass a message straight through, for the battle scene's own sends. */
  send(msg: ClientMessage): void {
    this.relay?.send(msg);
  }

  /** Tell the peer a fight has started here, and where to walk to. */
  openBattle(battleId: string, host: OwnerId, at: { x: number; y: number }): void {
    this.relay?.send({ t: "battle-open", battleId, host, at });
  }

  /**
   * Ask into the peer's fight. The host answers with the state as it stands,
   * which arrives as `battle-sync` and only then opens anything here.
   */
  joinBattle(battleId: string, guest: OwnerId, team: ScobaInstance[]): void {
    this.awaitingSync = battleId;
    this.relay?.send({ t: "battle-join", battleId, guest, team });
  }

  private awaitingSync: string | null = null;

  private receive(msg: ServerMessage): void {
    this.hooks.onTraffic?.(msg.t);
    switch (msg.t) {
      case "hello-ok":
        this.partnerHere = otherSlotHeld(msg.room.slotTaken, this.save.localSlot);
        if (this.partnerHere) this.openPeerLink();
        if (msg.care) this.adoptCare(msg.care.state, msg.care.rev);
        this.hooks.onStatus(this.status, this.partnerHere);
        return;
      case "peer": {
        const was = this.partnerHere;
        this.partnerHere = otherSlotHeld(msg.room.slotTaken, this.save.localSlot);
        if (this.partnerHere && !was) this.openPeerLink();
        if (!this.partnerHere && was) this.closePeerLink();
        // Once the other character has been seen, the save stays in two-player
        // shape even offline: their half of the story is real either way.
        if (this.partnerHere && !this.save.partnerJoined) {
          this.save.partnerJoined = true;
          this.hooks.onSaveChanged();
        }
        this.hooks.onStatus(this.status, this.partnerHere);
        return;
      }
      case "care-state":
        this.adoptCare(msg.state, msg.rev);
        return;
      case "story-flags":
        if (msg.rev <= (this.save.careRev ?? 0)) return;
        this.save.careRev = msg.rev;
        Object.assign(this.save.story.flags, msg.flags);
        this.hooks.onSaveChanged();
        return;
      case "error":
        this.hooks.onError(msg.reason);
        return;
      case "at":
        this.theirs.push(msg.step, performance.now());
        return;
      case "relica":
        // Only A decides, so this is the answer rather than a suggestion.
        this.save.companionship = msg.state;
        this.hooks.onSaveChanged();
        return;
      case "rtc-offer":
      case "rtc-answer":
      case "rtc-ice":
        void this.peer?.handleSignal(msg);
        return;
      case "battle-open":
        this.hooks.onBattleOpened({ battleId: msg.battleId, host: msg.host, at: msg.at });
        return;
      case "battle-close":
        this.hooks.onBattleClosed(msg.battleId);
        this.forBattle(msg.battleId)?.peerLeft();
        return;
      case "battle-sync":
        // Only meaningful to a client that asked to join and is waiting for it.
        if (this.awaitingSync === msg.battleId) {
          this.awaitingSync = null;
          this.hooks.onBattleAdopted(msg.battleId, msg.state);
        }
        return;
      case "battle-join":
        this.forBattle(msg.battleId)?.peerJoin(msg.guest, msg.team);
        return;
      case "battle-choice":
        this.forBattle(msg.battleId)?.peerChoice(msg.turn, msg.choice);
        return;
      case "battle-send-in":
        this.forBattle(msg.battleId)?.peerSendIn(msg.turn, msg.slot, msg.benchIndex);
        return;
      case "peer-illegal":
        this.forBattle(msg.battleId)?.desynced(msg.reason);
        return;
      default:
        return;
    }
  }

  /**
   * The relay stores a snapshot, not a live Relica, so an adopted state is
   * advanced to now before it is believed. Decay is a pure function of elapsed
   * time, so both clients land on the same condition from the same snapshot.
   */
  private adoptCare(state: CareState, rev: number): void {
    if (rev < (this.save.careRev ?? 0)) return;
    this.save.careRev = rev;
    this.save.special = advanceCare(state, Date.now());
    this.hooks.onSaveChanged();
  }
}

function otherSlotHeld(taken: { A: boolean; B: boolean }, mine: "A" | "B"): boolean {
  return mine === "A" ? taken.B : taken.A;
}
