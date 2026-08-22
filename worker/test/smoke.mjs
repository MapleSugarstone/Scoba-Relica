// A quick "is the deployed relay alive and configured" check. Not a test
// suite: `relay.test.mjs` is the thorough one and runs against production
// happily. This is the thing to run before a testing session, or when a phone
// says something is wrong and you want to rule the relay out in ten seconds.
//
//   node test/smoke.mjs                      (the deployed relay)
//   RELAY=http://localhost:8787 node test/smoke.mjs

const BASE = (process.env.RELAY ?? "https://scoba-relica-relay.maplesugarstone.workers.dev")
  .replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let bad = 0;
const line = (ok, label, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

const room = Array.from({ length: 6 }, () =>
  CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

console.log(`relay smoke check: ${BASE}\n`);

// 1. Reachable, and does it have what it needs to send a reminder.
let health;
try {
  const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(15000) });
  health = await res.json();
  line(res.status === 200, "reachable", `HTTP ${res.status}`);
  line(
    health.reminders === "configured",
    "reminder keys set",
    health.reminders ?? "no answer",
  );
} catch (err) {
  line(false, "reachable", String(err));
  console.log("\nnothing else can be checked while it is unreachable.");
  process.exit(1);
}

// 2. Room codes are validated the same way the client spells them.
for (const [path, want, what] of [
  ["/room/nope", 400, "a short code is refused"],
  ["/room/OIOIOI", 400, "an ambiguous-letter code is refused"],
  ["/room/ABCDEF", 426, "a good code wants a websocket"],
  ["/nothing-here", 404, "an unknown path is a 404"],
]) {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15000) });
    line(res.status === want, what, `HTTP ${res.status}`);
  } catch (err) {
    line(false, what, String(err));
  }
}

// 3. A socket can actually be opened, greeted, and told who else is here.
await new Promise((resolve) => {
  const ws = new WebSocket(`${WS_BASE}/room/${room}`);
  const timer = setTimeout(() => {
    line(false, "websocket round trip", "timed out after 15s");
    try { ws.close(); } catch { /* already gone */ }
    resolve();
  }, 15000);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ t: "hello", room, slot: "A", saveRev: 0 }));
  });
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t !== "hello-ok") return;
    clearTimeout(timer);
    line(true, "websocket round trip", `room ${msg.room.code}`);
    line(msg.room.code === room, "the room knows its own code", msg.room.code);
    line(msg.room.slotTaken.A === true, "the slot was claimed");
    ws.close();
    resolve();
  });
  ws.addEventListener("error", () => {
    clearTimeout(timer);
    line(false, "websocket round trip", "connection error");
    resolve();
  });
});

console.log(bad === 0 ? "\nall good." : `\n${bad} problem(s).`);
process.exit(bad === 0 ? 0 : 1);
