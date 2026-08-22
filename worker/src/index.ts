// Relay entry point. Everything interesting happens in the Room durable
// object; this only decides which room a socket belongs to.
import { normalizeRoomCode } from "../../src/net/roomcode";

export { Room } from "./room";

interface Env {
  ROOMS: DurableObjectNamespace;
  VAPID_PRIVATE_KEY?: string;
}

export type { RoomEnv } from "./room";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      // Reports whether reminders can actually be sent, which is the one bit
      // of configuration that fails silently otherwise.
      return Response.json({ ok: true, reminders: env.VAPID_PRIVATE_KEY ? "configured" : "unconfigured" });
    }

    const match = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });

    // Validated with the same rules the client spells codes by, so a junk or
    // oversized path cannot mint an unbounded number of durable objects.
    const code = normalizeRoomCode(decodeURIComponent(match[1]!));
    if (!code) return new Response("bad room code", { status: 400 });

    // idFromName is deterministic, so both players reach the same object from
    // the code alone with nothing to look up.
    const id = env.ROOMS.idFromName(code);
    const forwarded = new Request(req);
    forwarded.headers.set("X-Room-Code", code);
    return env.ROOMS.get(id).fetch(forwarded);
  },
};
