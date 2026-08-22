// Checks that a room schedules and sends care reminders, against a running
// `wrangler dev`. The push service is stood up here as a local HTTP server and
// the subscription points at it, so what the relay actually puts on the wire is
// inspectable without a real device or a real FCM endpoint.
//
//   npx wrangler dev --port 8787 --local     (in one terminal)
//   node test/reminders.test.mjs             (in another)

import { createServer } from "node:http";
import { encryptPayload, b64urlDecode, b64urlEncode } from "../src/push.ts";

const BASE = process.env.RELAY ?? "http://localhost:8787";
const WS_BASE = BASE.replace(/^http/, "ws");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PUSH_PORT = 8799;

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`); }
};

/** A stand-in push service that records what the relay sends it. */
function pushService() {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        path: req.url,
        auth: req.headers["authorization"] ?? "",
        encoding: req.headers["content-encoding"] ?? "",
        ttl: req.headers["ttl"] ?? "",
        body: Buffer.concat(chunks),
      });
      res.writeHead(201).end();
    });
  });
  return {
    received,
    listen: () => new Promise((r) => server.listen(PUSH_PORT, "127.0.0.1", r)),
    close: () => new Promise((r) => server.close(r)),
  };
}

function open(room) {
  const ws = new WebSocket(`${WS_BASE}/room/${room}`);
  const queue = [];
  const waiters = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    const w = waiters.shift();
    if (w) w.resolve(msg); else queue.push(msg);
  });
  const take = (ms, onTimeout) => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const entry = { resolve };
    waiters.push(entry);
    setTimeout(() => {
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      onTimeout(resolve, reject);
    }, ms);
  });
  return {
    ready: new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    }),
    send: (m) => ws.send(JSON.stringify(m)),
    next: (ms = 2000) => take(ms, (_r, rej) => rej(new Error("timed out waiting"))),
    silent: (ms = 500) => take(ms, (r) => r(null)),
    close: () => ws.close(),
  };
}

/** A real P-256 subscription, so the relay's encryption has something valid to target. */
async function makeSubscription() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint: `http://127.0.0.1:${PUSH_PORT}/push/test`,
    keys: { p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) },
  };
}

const care = (over = {}) => ({
  form: 0, careXp: 0, hunger: 90, clean: 90, happy: 80,
  hibernating: false, lastCalc: Date.now(), ...over,
});

async function main() {
  console.log(`care reminders against ${BASE}\n`);
  const service = pushService();
  await service.listen();

  const room = Array.from({ length: 6 }, () =>
    CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  const a = open(room);
  await a.ready;
  a.send({ t: "hello", room, slot: "A", saveRev: 0 });
  await a.next();
  await a.next(); // own presence

  console.log("subscribing");
  const sub = await makeSubscription();
  a.send({ t: "push-subscribe", room, sub });
  const quiet = await a.silent();
  check("subscribing draws no reply", quiet === null, JSON.stringify(quiet));

  console.log("\nscheduling");
  // Already starving: nothing is about to cross, so nothing should be armed
  // and no push should ever arrive for it.
  a.send({ t: "care-sync", room, state: care({ hunger: 2, clean: 2, happy: 2 }), rev: 1 });
  await new Promise((r) => setTimeout(r, 1500));
  check("a Relica already in need schedules nothing", service.received.length === 0,
    `${service.received.length} pushes`);

  // One that crosses at the next minute. Decay is quantised to whole minutes,
  // so `lastCalc` is now: a snapshot even a minute old has already crossed by
  // the time it is looked at, and there would be nothing left to schedule.
  const justAbove = { hunger: 30.05, clean: 90, happy: 80, lastCalc: Date.now() };
  a.send({ t: "care-sync", room, state: care(justAbove), rev: 2 });

  console.log("\ndelivery (waiting up to two minutes for the alarm)");
  const deadline = Date.now() + 120_000;
  while (service.received.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  check("the alarm fired and a push was sent", service.received.length > 0,
    `nothing arrived in ${Math.round((Date.now() - (deadline - 120_000)) / 1000)}s`);

  if (service.received.length > 0) {
    const got = service.received[0];
    check("it is aes128gcm encoded", got.encoding === "aes128gcm", got.encoding);
    check("it carries a VAPID authorization", /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(got.auth),
      got.auth.slice(0, 80));
    check("it sets a TTL", Number(got.ttl) > 0, got.ttl);
    check("the body has the aes128gcm header shape",
      got.body.length > 86 && got.body[20] === 65,
      `len ${got.body.length}, keyid ${got.body[20]}`);
    check("the sender key in the header is a valid P-256 point", got.body[21] === 0x04,
      String(got.body[21]));
  }

  a.close();
  await service.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nharness error:", e.message);
  process.exit(1);
});
