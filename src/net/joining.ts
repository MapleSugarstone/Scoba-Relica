// Knocking on someone's adventure before you have a save.
//
// A joining player cannot make their save first and sort the details out
// afterwards, because the world seed drives the procedural world: someone who
// generated their own would be walking around a different map with the same
// name as their friend's. So the seed is fetched before anything is built, and
// the save is created already belonging to that world.
//
// This is also what removes the worst bug the old flow had. Both players used
// to pick their own character, so both could pick A, and two clients claiming
// one slot spent the evening quietly evicting each other. Joining takes B by
// definition, so the clash cannot be set up in the first place.
import { Relay } from "./relay";
import type { CharacterProfile, ServerMessage } from "./protocol";

export interface HostAdventure {
  worldSeed: string;
  /** The host's character, so the joiner can see who they are joining. */
  host: CharacterProfile;
}

export type JoinFailure =
  /** Nobody is holding that room. */
  | "nobody-there"
  /** Somebody is there, but their adventure has not started: they are in the
   * waiting room, so the right answer is to join them in it. */
  | "setting-up"
  /** Someone answered but never told us about their world. */
  | "no-answer"
  /** The relay refused us: a version clash, or that character is taken. */
  | "refused";

export interface JoinResult {
  ok: boolean;
  adventure?: HostAdventure;
  failure?: JoinFailure;
  reason?: string;
}

/** Long enough for a slow phone to answer, short enough not to feel hung. */
const ANSWER_TIMEOUT_MS = 12000;

/**
 * Open a room as the guest, wait for the host to say who they are and which
 * world this is, then hang up. The real connection is made later by the
 * session, once there is a save for it to belong to.
 */
export function knock(room: string): Promise<JoinResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: JoinResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      relay.close();
      resolve(result);
    };

    const relay = new Relay(room, "B", {
      onMessage: (msg: ServerMessage) => {
        if (msg.t === "profile" && msg.slot === "A") {
          finish({ ok: true, adventure: { worldSeed: msg.worldSeed, host: msg.character } });
          return;
        }
        // A lobby message rather than a profile means they have not started
        // yet and are waiting for somebody, which is what we are.
        if (msg.t === "lobby" && msg.slot === "A") {
          finish({ ok: false, failure: "setting-up" });
          return;
        }
        if (msg.t === "hello-ok" && !msg.room.slotTaken.A) {
          // The room exists but nobody is hosting it, which usually means a
          // mistyped code rather than a friend who is about to appear.
          finish({ ok: false, failure: "nobody-there" });
          return;
        }
        if (msg.t === "error") {
          finish({ ok: false, failure: "refused", reason: msg.reason });
        }
      },
      onStatus: () => {
        // Status changes are not interesting here: either the host answers or
        // the timeout does.
      },
    });

    const timer = setTimeout(() => finish({ ok: false, failure: "no-answer" }), ANSWER_TIMEOUT_MS);
  });
}
