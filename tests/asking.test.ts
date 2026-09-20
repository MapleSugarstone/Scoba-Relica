import { afterEach, describe, expect, it } from "vitest";
import { readScript } from "../src/sim/script/read";
import { writeMove } from "../src/sim/script/write";
import {
  resolveTurn, startBattle, stateHash,
  type Answer, type BattleState, type Choice,
} from "../src/sim/battle";
import { MOVES } from "../src/sim/species";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { startReplay, stopReplay, takeReplay } from "../src/sim/replay";
import { runReplay } from "../src/dev/replay";

/** A move that stops the round and has every ally Scoba pick who it lands on. */
const PICK = [
  "move probe-pick \"Probe Pick\"",
  "  type plain",
  "  costs 10 mana",
  "  aim any enemy",
  "  cast:",
  "    ask ally scobas to pick any enemy as chosen, saying \"Who takes it?\"",
  "    hit chosen 100% magic",
].join("\n");

const added: string[] = [];

function install(text: string): void {
  const read = readScript(text, "move");
  expect(read.problems, text).toEqual([]);
  const move = read.moves[0]!;
  // What is read writes back as what it was, so the step survives a round trip.
  const back = readScript(writeMove(move), "move");
  expect(back.problems, move.id).toEqual([]);
  expect(JSON.parse(JSON.stringify(back.moves[0])), move.id).toEqual(JSON.parse(JSON.stringify(move)));
  MOVES[move.id] = move;
  added.push(move.id);
}

afterEach(() => {
  for (const id of added) delete MOVES[id];
  added.length = 0;
  stopReplay();
});

const wild = (id: string, lv = 30, seed = id): ScobaInstance => makeWild(id, lv, rngFrom(seed));

/** Two Scobas a side, the first of ours holding the asking move. */
function field(): BattleState {
  const mine = { ...wild("plib"), moves: ["probe-pick", ...wild("plib").moves.slice(1)] };
  const st = startBattle(
    "asking",
    [mine, wild("pieble")],
    [wild("obera", 30, "foeA"), wild("obera", 30, "foeB")],
    { slots: 2 },
  );
  for (const c of st.teams[0]) c.mana = 100;
  return st;
}

const cast: Choice = { kind: "spell", side: 0, slot: 0, moveId: "probe-pick", picks: [{ side: 1, index: 0 }] };
const round: Choice[] = [
  cast,
  { kind: "block", side: 0, slot: 1 },
  { kind: "block", side: 1, slot: 0 },
  { kind: "block", side: 1, slot: 1 },
];

describe("a round that stops to ask", () => {
  it("asks every Scoba the step names, all at once, and says what each may pick", () => {
    install(PICK);
    const st = field();
    resolveTurn(st, round);
    const asking = st.asking ?? [];
    // Both of ours are asked in the one stop, rather than one stop each.
    expect(asking).toHaveLength(2);
    expect(asking.map((q) => q.at.index)).toEqual([0, 1]);
    expect(asking[0]!.prompt).toBe("Who takes it?");
    expect(asking[0]!.by).toBe("probe-pick");
    // Each is offered the enemies it could aim at itself.
    expect(asking[0]!.options.map((o) => `${o.side}.${o.index}`)).toEqual(["1.0", "1.1"]);
  });

  it("carries on past the question once it is answered, and lands on what was picked", () => {
    install(PICK);
    const before = structuredClone(field());
    const stopped = field();
    const upTo = resolveTurn(stopped, round);
    expect(stopped.asking).toHaveLength(2);

    // Both pick the second enemy, which is not the one the move was aimed at.
    const answers: Answer[] = [{ pick: { side: 1, index: 1 } }, { pick: { side: 1, index: 1 } }];
    const st = structuredClone(before);
    const events = resolveTurn(st, round, answers);
    expect(st.asking).toBeUndefined();
    // Everything it did before it stopped, it did again the same way.
    expect(events.slice(0, upTo.length).map((e) => e.text)).toEqual(upTo.map((e) => e.text));
    expect(events.length).toBeGreaterThan(upTo.length);
    const [first, second] = st.teams[1];
    expect(second!.hp).toBeLessThan(first!.hp);
  });

  it("is the same round twice, however many times it is resolved again", () => {
    install(PICK);
    const before = structuredClone(field());
    const answers: Answer[] = [{ pick: { side: 1, index: 0 } }, { pick: { side: 1, index: 1 } }];
    const once = structuredClone(before);
    const twice = structuredClone(before);
    const a = resolveTurn(once, round, answers).map((e) => e.text);
    const b = resolveTurn(twice, round, structuredClone(answers)).map((e) => e.text);
    expect(a).toEqual(b);
    expect(stateHash(once)).toBe(stateHash(twice));
  });

  it("hits nobody where the question is answered with nothing", () => {
    install(PICK);
    const st = field();
    const before = structuredClone(st.teams[1].map((c) => c.hp));
    resolveTurn(st, round, [{ pick: null }, { pick: null }]);
    expect(st.teams[1].map((c) => c.hp)).toEqual(before);
  });

  it("records what it was told, so a replay of it lands the same way", () => {
    install(PICK);
    startReplay("test");
    const st = field();
    resolveTurn(st, round);
    const answers: Answer[] = [{ pick: { side: 1, index: 1 } }, { pick: { side: 1, index: 1 } }];
    const done = structuredClone(field());
    resolveTurn(done, round, answers);
    const replay = takeReplay();
    stopReplay();
    expect(replay).not.toBeNull();
    // One round filed, holding the answers rather than the run that stopped.
    expect(replay!.rounds).toHaveLength(1);
    expect(replay!.rounds[0]!.answers).toEqual(answers);
    const ran = runReplay(replay!);
    expect(ran[0]!.hash).toBe(stateHash(done));
  });
});
