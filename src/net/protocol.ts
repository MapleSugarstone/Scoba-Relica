// Wire protocol for the future sync server (a small Google Cloud service that
// can sleep when idle). The server is a dumb relay + tiny key-value store;
// all game logic stays client-side. See claude-notes/architecture.md.
import type { ScobaInstance } from "../sim/scoba";
import type { CareState } from "../sim/care";
import type { BattleState, Choice, OwnerId } from "../sim/battle";
import type { Step } from "./presence";

/** Two players share a campaign under one room code. */
export interface RoomInfo {
  code: string;
  slotTaken: { A: boolean; B: boolean };
}

export type ClientMessage =
  | { t: "hello"; room: string; slot: "A" | "B"; saveRev: number }
  | { t: "care-sync"; room: string; state: CareState; rev: number }
  | { t: "story-flags"; room: string; flags: Record<string, boolean>; rev: number }
  /**
   * The host announcing a fight it has started, and where to walk to join it.
   * Nothing about the fight itself travels here: the guest may arrive several
   * rounds late, so what it eventually needs is the state as it stands, not
   * the ingredients to rebuild it from the beginning.
   */
  | { t: "battle-open"; battleId: string; host: OwnerId; at: { x: number; y: number } }
  /** The guest walking in, bringing the team the host's save has drifted from. */
  | { t: "battle-join"; battleId: string; guest: OwnerId; team: ScobaInstance[] }
  /**
   * The host handing over the whole battle once the guest is in it. From here
   * both clients resolve every turn themselves and only exchange choices.
   */
  | { t: "battle-sync"; battleId: string; state: BattleState }
  /** The fight is over on the sender's side, so the peer can drop its copy. */
  | { t: "battle-close"; battleId: string; outcome: string }
  | { t: "battle-choice"; battleId: string; turn: number; choice: Choice }
  /**
   * A replacement walking on between rounds. It is not one of the turn's
   * choices, since arriving costs no turn, so a peer has to be told about it
   * separately or the two clients field different Scobas.
   */
  | { t: "battle-send-in"; battleId: string; turn: number; slot: 0 | 1; benchIndex: number }
  | { t: "battle-hash"; battleId: string; turn: number; hash: string }
  /**
   * A push subscription for care reminders. Stored per slot, so the room can
   * wake both players when the Relica needs something, and dropped when the
   * push service says it is dead.
   */
  | { t: "push-subscribe"; room: string; sub: PushSubscriptionJson }
  | { t: "push-unsubscribe"; room: string }
  /**
   * Setting up a direct connection between the two players. Only the handshake
   * comes through here; once it is up, position updates go peer to peer and
   * never touch the relay. Character A always makes the offer, so the two of
   * them cannot offer at each other at once.
   */
  | { t: "rtc-offer"; sdp: string }
  | { t: "rtc-answer"; sdp: string }
  | { t: "rtc-ice"; candidate: RtcCandidate }
  /** Where this player is, when there is no direct connection to carry it. */
  | { t: "at"; step: Step }
  | { t: "bye" };

/** The parts of an ICE candidate worth putting on the wire. */
export interface RtcCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** `PushSubscription.toJSON()`, which is what the browser hands us. */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type ServerMessage =
  | { t: "hello-ok"; room: RoomInfo; care?: { state: CareState; rev: number } }
  /**
   * Who is holding which slot, sent unprompted whenever that changes. Without
   * it the player already in a room has no way to learn the other one arrived,
   * which is what `partnerJoined` on the save is waiting to hear.
   */
  | { t: "peer"; room: RoomInfo }
  | { t: "care-state"; state: CareState; rev: number }
  | { t: "story-flags"; flags: Record<string, boolean>; rev: number }
  // The battle messages are relayed verbatim: only a player's own client knows
  // what they did, and only their peer's client needs to hear it.
  | { t: "battle-open"; battleId: string; host: OwnerId; at: { x: number; y: number } }
  | { t: "battle-join"; battleId: string; guest: OwnerId; team: ScobaInstance[] }
  | { t: "battle-sync"; battleId: string; state: BattleState }
  | { t: "battle-close"; battleId: string; outcome: string }
  | { t: "battle-choice"; battleId: string; turn: number; choice: Choice }
  | { t: "battle-send-in"; battleId: string; turn: number; slot: 0 | 1; benchIndex: number }
  | { t: "peer-illegal"; battleId: string; reason: string }
  | { t: "rtc-offer"; sdp: string }
  | { t: "rtc-answer"; sdp: string }
  | { t: "rtc-ice"; candidate: RtcCandidate }
  | { t: "at"; step: Step }
  | { t: "error"; reason: string };

export interface Transport {
  send(msg: ClientMessage): void;
  onMessage(cb: (msg: ServerMessage) => void): void;
  close(): void;
}

/** Placeholder transport until the relay server exists. Drops everything. */
export class OfflineTransport implements Transport {
  send(): void {}
  onMessage(): void {}
  close(): void {}
}
