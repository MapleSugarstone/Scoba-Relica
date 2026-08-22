// The client half of the relay. A room is two people who already know each
// other, so there is no matchmaking and no lobby here: a code names a durable
// object and the socket carries messages between the two clients holding it.
import type { ClientMessage, ServerMessage, Transport } from "./protocol";
import type { SlotId } from "../save/save";

export type RelayStatus = "offline" | "connecting" | "live";

const RELAY_OVERRIDE_KEY = "scoba-relay-url";
const DEFAULT_RELAY = "wss://scoba-relica-relay.workers.dev";

/**
 * Where the relay lives. `?relay=ws://localhost:8787` pins a local `wrangler
 * dev` and is remembered, so a phone on the same tunnel keeps talking to it
 * across reloads without the query string. `?relay=` on its own clears it.
 */
export function relayUrl(): string {
  let stored: string | null = null;
  try {
    const q = new URLSearchParams(location.search);
    if (q.has("relay")) {
      const set = q.get("relay") ?? "";
      if (set) localStorage.setItem(RELAY_OVERRIDE_KEY, set);
      else localStorage.removeItem(RELAY_OVERRIDE_KEY);
    }
    stored = localStorage.getItem(RELAY_OVERRIDE_KEY);
  } catch {
    // A blocked store just means no override.
  }
  const configured = import.meta.env["VITE_RELAY_URL"] as string | undefined;
  return stored || configured || DEFAULT_RELAY;
}

export interface RelayHooks {
  onMessage(msg: ServerMessage): void;
  onStatus(status: RelayStatus): void;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
/** Enough to hold a turn's worth of traffic across a brief drop, not a session's. */
const MAX_QUEUED = 32;

export class Relay implements Transport {
  private ws: WebSocket | null = null;
  private handlers: ((msg: ServerMessage) => void)[] = [];
  private outbox: ClientMessage[] = [];
  private attempt = 0;
  private timer: number | null = null;
  private shut = false;
  private saveRev = 0;

  constructor(
    private readonly room: string,
    private readonly slot: SlotId,
    private readonly hooks: RelayHooks,
    private readonly url = relayUrl(),
  ) {
    this.handlers.push((m) => hooks.onMessage(m));
    if (typeof document !== "undefined") {
      // A phone suspends the socket when the screen goes off without always
      // firing close, so coming back to the tab is a reason to check.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.ensure();
      });
    }
    this.connect();
  }

  /** Bumped on every local care write so the relay can order the two clients. */
  setSaveRev(rev: number): void {
    this.saveRev = rev;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    // Oldest goes first: a stale choice is worth less than a fresh one.
    if (this.outbox.length >= MAX_QUEUED) this.outbox.shift();
    this.outbox.push(msg);
    this.ensure();
  }

  onMessage(cb: (msg: ServerMessage) => void): void {
    this.handlers.push(cb);
  }

  close(): void {
    this.shut = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.ws?.send(JSON.stringify({ t: "bye" } satisfies ClientMessage));
    } catch {
      // Already gone, which is the same outcome.
    }
    this.ws?.close(1000, "left");
    this.ws = null;
    this.hooks.onStatus("offline");
  }

  private ensure(): void {
    if (this.shut) return;
    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    if (this.timer === null) this.connect();
  }

  private connect(): void {
    if (this.shut) return;
    this.hooks.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.url}/room/${encodeURIComponent(this.room)}`);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.attempt = 0;
      // The greeting has to lead, and it has to lead on a reconnect too: the
      // room forgets which socket held which slot when the old one dropped.
      ws.send(JSON.stringify({
        t: "hello", room: this.room, slot: this.slot, saveRev: this.saveRev,
      } satisfies ClientMessage));
      const pending = this.outbox;
      this.outbox = [];
      for (const msg of pending) ws.send(JSON.stringify(msg));
      this.hooks.onStatus("live");
    });

    ws.addEventListener("message", (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      for (const h of this.handlers) h(msg);
    });

    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      this.hooks.onStatus("offline");
      this.retry();
    });

    ws.addEventListener("error", () => {
      // close always follows, and that is where the retry is scheduled.
    });
  }

  private retry(): void {
    if (this.shut || this.timer !== null) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    // Jittered so two clients kicked off together do not march back in step.
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait + Math.random() * 500);
  }
}
