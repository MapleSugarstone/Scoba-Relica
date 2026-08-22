// One Durable Object per room code. It is a relay with a small store bolted on:
// it never simulates a battle and never reads a Scoba, so its cost tracks
// messages sent rather than players playing. See claude-notes/architecture.md.
import { careAlertText, nextCareAlert, type CareAlert, type CareState } from "../../src/sim/care";
import type {
  ClientMessage, PushSubscriptionJson, RoomInfo, ServerMessage,
} from "../../src/net/protocol";
import { sendPush, type VapidKeys } from "./push";

type Slot = "A" | "B";

/** Rides on the socket so it survives hibernation, which clears memory. */
interface Attachment {
  slot: Slot;
}

interface Revised<T> {
  value: T;
  rev: number;
}

/** Two clients disagreeing about a turn is the one thing worth reporting. */
interface TurnHash {
  slot: Slot;
  hash: string;
}

const MAX_MESSAGE_BYTES = 128 * 1024;

/** What the Relica is called in a notification. */
const RELICA_NAME = "Relica";

export interface RoomEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export class Room {
  /**
   * A durable object knows its id but not the name it was derived from, and
   * the name is the code players read to each other. The worker passes it in
   * on the upgrade, and it is persisted because a revived object may never see
   * another `fetch` before it has to answer for itself.
   */
  private code = "";

  constructor(private state: DurableObjectState, private env: RoomEnv = {}) {
    state.blockConcurrencyWhile(async () => {
      this.code = (await state.storage.get<string>("code")) ?? "";
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const code = req.headers.get("X-Room-Code");
    if (code && code !== this.code) {
      this.code = code;
      await this.state.storage.put("code", code);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // acceptWebSocket rather than server.accept(): the latter pins this object
    // in memory for the life of the connection, which is the whole cost.
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return this.fail(ws, "text frames only");
    if (raw.length > MAX_MESSAGE_BYTES) return this.fail(ws, "message too large");

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return this.fail(ws, "malformed json");
    }
    if (!msg || typeof msg.t !== "string") return this.fail(ws, "malformed message");

    // Everything except the greeting needs a slot already claimed, so an
    // unannounced socket cannot push state into a room or read a peer's.
    if (msg.t === "hello") return this.hello(ws, msg);
    const mine = this.slotOf(ws);
    if (!mine) return this.fail(ws, "say hello first");

    switch (msg.t) {
      case "care-sync":
        return this.syncRevised(ws, "care", msg.state, msg.rev, (value, rev) => ({
          t: "care-state", state: value as CareState, rev,
        }));
      case "story-flags":
        return this.syncRevised(ws, "flags", msg.flags, msg.rev, (value, rev) => ({
          t: "story-flags", flags: value as Record<string, boolean>, rev,
        }));
      case "battle-hash":
        return this.compareHash(ws, mine, msg.battleId, msg.turn, msg.hash);
      case "battle-open":
      case "battle-join":
      case "battle-sync":
      case "battle-close":
      case "battle-choice":
      case "battle-send-in":
        // Pure relay: only the peer's own client knows what it did, and only
        // the peer's client needs to hear it.
        this.toPeer(ws, msg as unknown as ServerMessage);
        return;
      case "push-subscribe":
        await this.state.storage.put(`push:${mine}`, msg.sub);
        await this.armCareAlarm();
        return;
      case "push-unsubscribe":
        await this.state.storage.delete(`push:${mine}`);
        return;
      case "bye":
        ws.close(1000, "bye");
        return;
      default:
        return this.fail(ws, `unknown message ${String((msg as { t: string }).t)}`);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.departed(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.departed(ws);
  }

  /**
   * Only a socket that held a slot changes the room. A refused or unannounced
   * connection dropping is not news, and announcing it would put a message in
   * front of the players that says nothing changed.
   */
  private departed(ws: WebSocket): void {
    if (this.slotOf(ws) === null) return;
    this.announcePresence(ws);
  }

  private async hello(ws: WebSocket, msg: Extract<ClientMessage, { t: "hello" }>): Promise<void> {
    if (msg.slot !== "A" && msg.slot !== "B") return this.fail(ws, "slot must be A or B");
    const taken = this.sockets().some((w) => w !== ws && this.slotOf(w) === msg.slot);
    if (taken) return this.fail(ws, `slot ${msg.slot} is already held`);

    ws.serializeAttachment({ slot: msg.slot } satisfies Attachment);
    const care = await this.state.storage.get<Revised<CareState>>("care");
    this.send(ws, {
      t: "hello-ok",
      room: this.info(),
      ...(care ? { care: { state: care.value, rev: care.rev } } : {}),
    });
    // Both sides get the new picture: the arrival needs it too, since its own
    // hello-ok was built before its slot counted as taken.
    this.announcePresence(null);
  }

  /**
   * Last writer wins by revision, and a client that arrives with a stale one is
   * corrected rather than ignored. Care decay is a pure function of time on
   * both clients, so the only thing that has to be arbitrated is which snapshot
   * is newer.
   */
  private async syncRevised<T>(
    ws: WebSocket,
    key: "care" | "flags",
    value: T,
    rev: number,
    toMessage: (value: unknown, rev: number) => ServerMessage,
  ): Promise<void> {
    if (!Number.isFinite(rev)) return this.fail(ws, "revision must be a number");
    const stored = await this.state.storage.get<Revised<T>>(key);
    if (stored && stored.rev >= rev) {
      this.send(ws, toMessage(stored.value, stored.rev));
      return;
    }
    await this.state.storage.put(key, { value, rev } satisfies Revised<T>);
    this.toPeer(ws, toMessage(value, rev));
    if (key === "care") await this.armCareAlarm();
  }

  /**
   * Point the alarm at the exact minute the Relica will next want something.
   * Nothing is polled and nothing watches: the crossing is worked out from the
   * stored snapshot, the object sleeps until then, and re-arms when it wakes or
   * when a care action moves the snapshot.
   */
  private async armCareAlarm(from = Date.now()): Promise<void> {
    const care = await this.state.storage.get<Revised<CareState>>("care");
    if (!care) return;
    const alert = nextCareAlert(care.value, from);
    if (!alert) {
      await this.state.storage.delete("alarmFor");
      await this.state.storage.deleteAlarm();
      return;
    }
    // What the alarm is for is written down rather than re-derived when it
    // rings. By then the meter that set it has crossed, so asking again would
    // answer with the following one and there would be nothing to announce.
    await this.state.storage.put("alarmFor", alert satisfies CareAlert);
    await this.state.storage.setAlarm(alert.at);
  }

  /**
   * The alarm never advances the stored state. The relay keeps what a client
   * told it and nothing else, so waking up to send a reminder must not become
   * a second place the Relica's condition is decided.
   */
  async alarm(): Promise<void> {
    const due = await this.state.storage.get<CareAlert>("alarmFor");
    if (!due) return;
    // A genuine early wake: go back to sleep for the time actually wanted.
    if (due.at > Date.now() + 60000) {
      await this.state.storage.setAlarm(due.at);
      return;
    }
    await this.state.storage.delete("alarmFor");
    const { title, body } = careAlertText(due.need, RELICA_NAME);
    await this.notifyBoth({ title, body, tag: `care-${due.need}`, url: "./" });
    // Arm whatever comes next. Asking from a minute on skips the meter just
    // announced, since the prediction judges from the state at that time and
    // it is under the line by then.
    await this.armCareAlarm(Date.now() + 60000);
  }

  private vapid(): VapidKeys | null {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = this.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
    return {
      publicKey: VAPID_PUBLIC_KEY,
      privateKey: VAPID_PRIVATE_KEY,
      subject: VAPID_SUBJECT ?? "mailto:nobody@example.com",
    };
  }

  /** Both players share one Relica, so both hear about it. */
  private async notifyBoth(payload: {
    title: string; body: string; tag: string; url: string;
  }): Promise<void> {
    const keys = this.vapid();
    if (!keys) {
      // The likeliest misconfiguration in production, and silent failure here
      // looks exactly like a phone that simply never buzzed.
      console.warn("reminder not sent: no VAPID keys configured on the worker");
      return;
    }
    for (const slot of ["A", "B"] as const) {
      const sub = await this.state.storage.get<PushSubscriptionJson>(`push:${slot}`);
      if (!sub) continue;
      try {
        const result = await sendPush(sub, payload, keys);
        // A push service that says the subscription is dead means the app was
        // uninstalled or permission revoked; keeping it would retry forever.
        if (result.gone) await this.state.storage.delete(`push:${slot}`);
        else if (!result.ok) console.warn(`push to ${slot} refused: ${result.status}`);
      } catch (err) {
        // A transient failure is not worth losing the subscription over, but it
        // is worth saying so: an unlogged throw here is indistinguishable from
        // a phone that never buzzed.
        console.warn(`push to ${slot} threw: ${String(err)}`);
      }
    }
  }

  private async compareHash(
    ws: WebSocket,
    mine: Slot,
    battleId: string,
    turn: number,
    hash: string,
  ): Promise<void> {
    const key = `hash:${battleId}:${turn}`;
    const seen = await this.state.storage.get<TurnHash>(key);
    if (!seen) {
      // Kept in storage rather than memory: a player taking their time over a
      // choice can let this object hibernate mid-battle.
      await this.state.storage.put(key, { slot: mine, hash } satisfies TurnHash);
      return;
    }
    await this.state.storage.delete(key);
    if (seen.slot === mine || seen.hash === hash) return;
    const complaint: ServerMessage = {
      t: "peer-illegal",
      battleId,
      reason: `turn ${turn} resolved differently on the two clients`,
    };
    for (const w of this.sockets()) this.send(w, complaint);
  }

  private announcePresence(closing: WebSocket | null): void {
    const info = this.info(closing);
    for (const w of this.sockets()) {
      if (w !== closing) this.send(w, { t: "peer", room: info });
    }
  }

  /** `closing` is excluded because its slot is already gone by the time we say so. */
  private info(closing?: WebSocket | null): RoomInfo {
    const held = new Set(
      this.sockets()
        .filter((w) => w !== closing)
        .map((w) => this.slotOf(w))
        .filter((s): s is Slot => s !== null),
    );
    return {
      code: this.code,
      slotTaken: { A: held.has("A"), B: held.has("B") },
    };
  }

  private sockets(): WebSocket[] {
    return this.state.getWebSockets();
  }

  private slotOf(ws: WebSocket): Slot | null {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a?.slot ?? null;
  }

  private toPeer(from: WebSocket, msg: ServerMessage): void {
    for (const w of this.sockets()) {
      if (w !== from) this.send(w, msg);
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // A socket that died between listing and sending is not our problem;
      // webSocketClose will tidy up after it.
    }
  }

  private fail(ws: WebSocket, reason: string): void {
    this.send(ws, { t: "error", reason });
  }
}
