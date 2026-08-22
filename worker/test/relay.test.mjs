// Integration test for the relay. Drives a running `wrangler dev` with two
// real WebSocket clients, because the things worth checking here are slot
// arbitration, revision conflicts and who a message reaches, none of which a
// unit test of the class would exercise honestly.
//
//   npx wrangler dev --port 8787      (in one terminal)
//   node test/relay.test.mjs          (in another)

const BASE = process.env.RELAY ?? "http://localhost:8787";
const WS_BASE = BASE.replace(/^http/, "ws");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

function equal(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `expected ${e}\n         got      ${a}`);
}

/** A socket that queues what arrives, so a test can await the next message. */
function open(room) {
  const ws = new WebSocket(`${WS_BASE}/room/${room}`);
  const queue = [];
  const waiters = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(msg);
    else queue.push(msg);
  });
  /**
   * A timed-out waiter takes itself back out of the queue. Leaving it in was a
   * real bug in an earlier version of this harness: a `silent()` that correctly
   * saw nothing left its waiter behind, and that waiter then swallowed the next
   * genuine message, so an unrelated assertion much further down timed out.
   */
  const take = (ms, onTimeout) =>
    new Promise((resolve, reject) => {
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
    ws,
    ready: new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    }),
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (ms = 2000) => take(ms, (_resolve, reject) => reject(new Error("timed out waiting"))),
    /** Null if nothing arrives, which is how "the peer must not hear this" is checked. */
    silent: (ms = 400) => take(ms, (resolve) => resolve(null)),
    close: () => ws.close(),
  };
}

const care = (hunger, lastCalc) => ({
  form: 0, careXp: 0, hunger, clean: 80, happy: 70, hibernating: false, lastCalc,
});

async function main() {
  console.log(`relay integration tests against ${BASE}\n`);

  console.log("routing");
  const health = await fetch(`${BASE}/health`);
  check("health responds", health.status === 200);
  // No Upgrade header on these: undici refuses to set one, and the code is
  // validated in the worker before the object ever checks for an upgrade.
  const bad = await fetch(`${BASE}/room/nope`);
  check("a malformed room code is refused", bad.status === 400, `got ${bad.status}`);
  const ambiguous = await fetch(`${BASE}/room/OIOIOI`);
  check("a code using the excluded letters is refused", ambiguous.status === 400, `got ${ambiguous.status}`);
  const plain = await fetch(`${BASE}/room/ABCDEF`);
  check("a valid code without an upgrade is refused by the room", plain.status === 426, `got ${plain.status}`);
  const missing = await fetch(`${BASE}/nothing-here`);
  check("an unknown path is a 404", missing.status === 404, `got ${missing.status}`);

  // A fresh code per run: durable object storage survives across `wrangler
  // dev` restarts, so a fixed room would carry the last run's care state in.
  const room = Array.from({ length: 6 }, () =>
    CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  console.log(`\nhandshake (room ${room})`);
  const a = open(room);
  await a.ready;
  a.send({ t: "hello", room, slot: "A", saveRev: 1 });
  const helloA = await a.next();
  check("A is greeted", helloA.t === "hello-ok", JSON.stringify(helloA));
  equal("the room reports the code players read out", helloA.room.code, room);
  equal("only A holds a slot so far", helloA.room.slotTaken, { A: true, B: false });
  check("no care state exists yet", helloA.care === undefined);

  // A also gets a presence message, since its own hello-ok was built before
  // its slot counted.
  const presenceForA = await a.next();
  check("A hears its own arrival as presence", presenceForA.t === "peer");

  const b = open(room);
  await b.ready;
  b.send({ t: "hello", room, slot: "B", saveRev: 1 });
  const helloB = await b.next();
  equal("B sees both slots held", helloB.room.slotTaken, { A: true, B: true });
  const peerForA = await a.next();
  check("A is told B arrived", peerForA.t === "peer" && peerForA.room.slotTaken.B === true,
    JSON.stringify(peerForA));
  // B hears its own arrival too. Drained here so later reads see real replies.
  const peerForB = await b.next();
  check("B hears its own arrival as presence", peerForB.t === "peer", JSON.stringify(peerForB));

  console.log("\nslot arbitration");
  const intruder = open(room);
  await intruder.ready;
  intruder.send({ t: "hello", room, slot: "A", saveRev: 1 });
  const refused = await intruder.next();
  check("a second claim on slot A is refused", refused.t === "error", JSON.stringify(refused));
  intruder.close();

  const rude = open(room);
  await rude.ready;
  rude.send({ t: "care-sync", room, state: care(10, 5), rev: 99 });
  const scolded = await rude.next();
  check("a socket that never said hello cannot write", scolded.t === "error", JSON.stringify(scolded));
  rude.close();

  console.log("\ncare sync");
  a.send({ t: "care-sync", room, state: care(50, 1000), rev: 1 });
  const gotByB = await b.next();
  check("B receives A's care push", gotByB.t === "care-state" && gotByB.state.hunger === 50,
    JSON.stringify(gotByB));
  const echoToA = await a.silent();
  check("A is not sent back its own push", echoToA === null, JSON.stringify(echoToA));

  b.send({ t: "care-sync", room, state: care(90, 2000), rev: 2 });
  const gotByA = await a.next();
  check("a newer revision wins", gotByA.state.hunger === 90 && gotByA.rev === 2, JSON.stringify(gotByA));

  a.send({ t: "care-sync", room, state: care(11, 500), rev: 1 });
  const corrected = await a.next();
  check("a stale writer is corrected rather than ignored",
    corrected.t === "care-state" && corrected.rev === 2 && corrected.state.hunger === 90,
    JSON.stringify(corrected));
  const bDisturbed = await b.silent();
  check("the peer is not disturbed by a stale write", bDisturbed === null, JSON.stringify(bDisturbed));

  console.log("\nstory flags");
  a.send({ t: "story-flags", room, flags: { metSage: true }, rev: 1 });
  const flags = await b.next();
  check("flags reach the peer", flags.t === "story-flags" && flags.flags.metSage === true,
    JSON.stringify(flags));

  console.log("\nbattle relay");
  a.send({ t: "battle-choice", battleId: "bt1", turn: 3, choice: { kind: "move", index: 2 } });
  const choice = await b.next();
  check("a choice is relayed verbatim",
    choice.t === "battle-choice" && choice.turn === 3 && choice.choice.index === 2,
    JSON.stringify(choice));

  a.send({ t: "battle-send-in", battleId: "bt1", turn: 3, slot: 0, benchIndex: 1 });
  const sendIn = await b.next();
  check("a send-in is relayed", sendIn.t === "battle-send-in" && sendIn.benchIndex === 1,
    JSON.stringify(sendIn));

  console.log("\ndesync detection");
  a.send({ t: "battle-hash", battleId: "bt1", turn: 4, hash: "same" });
  const quietB = await b.silent();
  check("one hash alone says nothing", quietB === null, JSON.stringify(quietB));
  b.send({ t: "battle-hash", battleId: "bt1", turn: 4, hash: "same" });
  const quietAgain = await b.silent();
  check("matching hashes stay quiet", quietAgain === null, JSON.stringify(quietAgain));

  a.send({ t: "battle-hash", battleId: "bt1", turn: 5, hash: "one" });
  b.send({ t: "battle-hash", battleId: "bt1", turn: 5, hash: "other" });
  const complaintA = await a.next();
  const complaintB = await b.next();
  check("both sides are told when a turn diverges",
    complaintA.t === "peer-illegal" && complaintB.t === "peer-illegal",
    `${JSON.stringify(complaintA)} / ${JSON.stringify(complaintB)}`);

  console.log("\nreconnection");
  b.close();
  const departure = await a.next();
  check("A is told B left", departure.t === "peer" && departure.room.slotTaken.B === false,
    JSON.stringify(departure));

  const b2 = open(room);
  await b2.ready;
  b2.send({ t: "hello", room, slot: "B", saveRev: 1 });
  const rejoin = await b2.next();
  check("B can reclaim its slot after leaving", rejoin.t === "hello-ok", JSON.stringify(rejoin));
  check("the room hands back the care state it kept",
    rejoin.care !== undefined && rejoin.care.state.hunger === 90 && rejoin.care.rev === 2,
    JSON.stringify(rejoin.care));

  a.close();
  b2.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nharness error:", e.message);
  process.exit(1);
});
