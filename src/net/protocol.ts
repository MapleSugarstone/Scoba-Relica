// Wire protocol for the future sync server (a small Google Cloud service that
// can sleep when idle). The server is a dumb relay + tiny key-value store;
// all game logic stays client-side. See claude-notes/architecture.md.
import type { ScobaInstance } from "../sim/scoba";
import type { CareState } from "../sim/care";
import type { BattleState, Choice, OwnerId } from "../sim/battle";
import type { Step } from "./presence";
import type { Companionship } from "../sim/companionship";

/**
 * The wire format's version. Bumped only when the messages themselves change,
 * which is what actually decides whether two clients can play together. A new
 * sprite is not a reason to refuse someone; a message the other end has never
 * heard of is.
 *
 * Raise this when you add, remove or change the shape of anything in
 * `ClientMessage` or `ServerMessage`.
 */
export const PROTOCOL_VERSION = 2;

/** Two players share a campaign under one room code. */
export interface RoomInfo {
  code: string;
  slotTaken: { A: boolean; B: boolean };
}

export type ClientMessage =
  /**
   * `client` names the installation, not the character. It is what separates a
   * player reconnecting from two devices that both picked the same character.
   */
  | { t: "hello"; room: string; slot: "A" | "B"; saveRev: number; protocol?: number; client?: string }
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
  /**
   * Who the Relica has gone off with. Both clients draw it, so they have to
   * agree, or each player sees it walking beside themselves. Character A
   * decides and says so; it changes in stints, so this is rare.
   */
  | { t: "relica"; state: Companionship }
  /**
   * Who someone is, and which world they are in. Sent by both sides when
   * they meet. The world seed is the part that matters: it drives the
   * procedural world, so a player who joined with their own would be
   * walking around a different map with the same name.
   */
  | { t: "profile"; slot: "A" | "B"; character: CharacterProfile; worldSeed: string }
  /**
   * Setting up together, before either save exists. `character` is null
   * until they have made one, and `ready` means they have picked a starter
   * too. The other side watches this to grey out the Scoba already taken.
   */
  | { t: "lobby"; slot: "A" | "B"; character: CharacterProfile | null; ready: boolean }
  /**
   * The host saying go. Both build their save from this seed at the same
   * moment, so they walk into the same world together rather than one of
   * them arriving to find the other already there.
   */
  | { t: "lobby-start"; worldSeed: string }
  | { t: "bye" };

/** The parts of a character the other player needs to draw and name them. */
export interface CharacterProfile {
  name: string;
  look: unknown;
  starter: string;
}

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
  /** `protocol` is the relay's own, so a client can tell it is talking to an old one. */
  | { t: "hello-ok"; room: RoomInfo; protocol?: number; care?: { state: CareState; rev: number } }
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
  | { t: "relica"; state: Companionship }
  | { t: "profile"; slot: "A" | "B"; character: CharacterProfile; worldSeed: string }
  | { t: "lobby"; slot: "A" | "B"; character: CharacterProfile | null; ready: boolean }
  | { t: "lobby-start"; worldSeed: string }
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
