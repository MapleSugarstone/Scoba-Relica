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
  const self = {
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
    /**
     * Swallow whatever is waiting. Slot churn produces perfectly correct
     * presence messages that a later assertion is not expecting, so the test
     * resynchronises rather than pretending they should not happen.
     */
    async drain(ms = 400) {
      for (;;) {
        const m = await take(ms, (resolve) => resolve(null));
        if (m === null) return;
      }
    },
  };
  return self;
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
  let a = open(room);
  await a.ready;
  a.send({ t: "hello", room, slot: "A", saveRev: 1, protocol: 2, client: "device-a" });
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
  b.send({ t: "hello", room, slot: "B", saveRev: 1, protocol: 2, client: "device-b" });
  const helloB = await b.next();
  equal("B sees both slots held", helloB.room.slotTaken, { A: true, B: true });
  const peerForA = await a.next();
  check("A is told B arrived", peerForA.t === "peer" && peerForA.room.slotTaken.B === true,
    JSON.stringify(peerForA));
  // B hears its own arrival too. Drained here so later reads see real replies.
  const peerForB = await b.next();
  check("B hears its own arrival as presence", peerForB.t === "peer", JSON.stringify(peerForB));

  console.log("\nslot arbitration");
  // A reconnecting player takes their own slot back rather than being locked
  // out of it by the socket they left behind. Refusing them meant a reload, a
  // backgrounded app, or a dropped connection kept them out of their own room
  // until the ghost timed out.
  const rejoin = open(room);
  await rejoin.ready;
  rejoin.send({ t: "hello", room, slot: "A", saveRev: 1, protocol: 2, client: "device-a" });
  const retaken = await rejoin.next();
  check("a returning player takes their slot back", retaken.t === "hello-ok", JSON.stringify(retaken));
  rejoin.close();
  await new Promise((r) => setTimeout(r, 500));

  // Put the original connection back in charge for the rest of the run.
  a = open(room);
  await a.ready;
  a.send({ t: "hello", room, slot: "A", saveRev: 1, protocol: 2, client: "device-a" });
  await a.next();
  // The slot changing hands three times told B about it three times, all of it
  // correct and none of it what the next assertions are waiting for.
  await a.drain();
  await b.drain();

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

  console.log("\ntwo devices, one character");
  // What actually happens when two people set up separately: both pick
  // character A. Quietly swapping the slot between them means neither ever
  // sees a partner and both sit on "connected, waiting" forever.
  const twin = open(room);
  await twin.ready;
  twin.send({ t: "hello", room, slot: "A", saveRev: 1, protocol: 2, client: "some-other-device" });
  const clash = await twin.next();
  check("a second device on the same character is refused", clash.t === "error", JSON.stringify(clash));
  check("and told what to do about it", /character A/.test(clash.reason ?? ""), clash.reason);
  twin.close();
  await new Promise((r) => setTimeout(r, 400));

  // The player who was already there keeps their slot and their connection.
  // Checked with a flag rather than a care push, so this does not disturb the
  // stored care state a later assertion is about.
  a.send({ t: "story-flags", room, flags: { survivedTheClash: true }, rev: 40 });
  const stillWorks = await b.next();
  check("the player already there is undisturbed",
    stillWorks.t === "story-flags" && stillWorks.flags.survivedTheClash === true,
    JSON.stringify(stillWorks));
  await a.drain();
  await b.drain();

  console.log("\nversion gating");
  // Two clients on different wire versions cannot understand each other, so
  // they are told rather than left to fail confusingly later on.
  const older = open(room);
  await older.ready;
  older.send({ t: "hello", room, slot: "B", saveRev: 1, protocol: 1, client: "device-b" });
  const refused = await older.next();
  check("a client on another version is refused", refused.t === "error", JSON.stringify(refused));
  check("and told which versions are involved", /version/i.test(refused.reason ?? ""), refused.reason);
  older.close();
  await new Promise((r) => setTimeout(r, 400));
  await a.drain();
  await b.drain();

  check("the relay says which wire version it speaks", typeof helloA.protocol === "number",
    String(helloA.protocol));

  console.log("\nmovement fallback");
  // Position normally goes peer to peer and never touches the relay at all.
  // This is the path for pairs whose networks refuse a direct connection.
  const stepMsg = { seq: 7, x: 120, y: 64, dir: -1, moving: true, map: "home" };
  a.send({ t: "at", room, step: stepMsg });
  const moved = await b.next();
  check("a position reaches the peer", moved.t === "at" && moved.step.x === 120,
    JSON.stringify(moved));
  check("it arrives unchanged", moved.step.seq === 7 && moved.step.dir === -1 && moved.step.map === "home",
    JSON.stringify(moved.step));
  const echoed = await a.silent();
  check("the sender is not sent its own position back", echoed === null, JSON.stringify(echoed));

  // Signalling is relayed too, and never interpreted.
  a.send({ t: "rtc-offer", sdp: "v=0 offer" });
  const offered = await b.next();
  check("an offer reaches the peer", offered.t === "rtc-offer" && offered.sdp === "v=0 offer",
    JSON.stringify(offered));
  b.send({ t: "rtc-answer", sdp: "v=0 answer" });
  const answered = await a.next();
  check("an answer comes back", answered.t === "rtc-answer", JSON.stringify(answered));
  a.send({ t: "rtc-ice", candidate: { candidate: "candidate:1 1 udp", sdpMid: "0", sdpMLineIndex: 0 } });
  const iced = await b.next();
  check("a candidate reaches the peer", iced.t === "rtc-ice" && iced.candidate.sdpMid === "0",
    JSON.stringify(iced));

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
  b2.send({ t: "hello", room, slot: "B", saveRev: 1, protocol: 2, client: "device-b" });
  const backIn = await b2.next();
  check("B can reclaim its slot after leaving", backIn.t === "hello-ok", JSON.stringify(backIn));
  check("the room hands back the care state it kept",
    backIn.care !== undefined && backIn.care.state.hunger === 90 && backIn.care.rev === 2,
    JSON.stringify(backIn.care));

  a.close();
  b2.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nharness error:", e.message);
  process.exit(1);
});
