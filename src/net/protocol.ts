// Wire protocol for the future sync server (a small Google Cloud service that
// can sleep when idle). The server is a dumb relay + tiny key-value store;
// all game logic stays client-side. See claude-notes/architecture.md.
import type { ScobaInstance } from "../sim/scoba";
import type { CareState } from "../sim/care";
import type { Choice } from "../sim/battle";

/** Two players share a campaign under one room code. */
export interface RoomInfo {
  code: string;
  slotTaken: { A: boolean; B: boolean };
}

export type ClientMessage =
  | { t: "hello"; room: string; slot: "A" | "B"; saveRev: number }
  | { t: "care-sync"; room: string; state: CareState; rev: number }
  | { t: "story-flags"; room: string; flags: Record<string, boolean>; rev: number }
  | { t: "battle-join"; queue: "2v2"; team: ScobaInstance[] }
  | { t: "battle-choice"; battleId: string; turn: number; choice: Choice }
  /**
   * A replacement walking on between rounds. It is not one of the turn's
   * choices, since arriving costs no turn, so a peer has to be told about it
   * separately or the two clients field different Scobas.
   */
  | { t: "battle-send-in"; battleId: string; turn: number; slot: 0 | 1; benchIndex: number }
  | { t: "battle-hash"; battleId: string; turn: number; hash: string }
  | { t: "bye" };

export type ServerMessage =
  | { t: "hello-ok"; room: RoomInfo; care?: { state: CareState; rev: number } }
  | { t: "care-state"; state: CareState; rev: number }
  | { t: "story-flags"; flags: Record<string, boolean>; rev: number }
  | { t: "battle-start"; battleId: string; seed: string; yourSide: 0 | 1; teams: [ScobaInstance[], ScobaInstance[]] }
  | { t: "battle-choice"; battleId: string; turn: number; choice: Choice }
  | { t: "battle-send-in"; battleId: string; turn: number; slot: 0 | 1; benchIndex: number }
  | { t: "peer-illegal"; battleId: string; reason: string }
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
