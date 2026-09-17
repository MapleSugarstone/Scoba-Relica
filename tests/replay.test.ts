import { afterEach, describe, expect, it } from "vitest";
import { resolveTurn, startBattle, stateHash, type BattleState, type Choice } from "../src/sim/battle";
import { recording, startReplay, stopReplay, takeReplay } from "../src/sim/replay";
import { runReplay } from "../src/dev/replay";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const wild = (id: string, lv = 30, seed = id): ScobaInstance => makeWild(id, lv, rngFrom(seed));
const mine = (s: ScobaInstance): ScobaInstance => ({ ...s, owner: "A" });

function fight(): BattleState {
  const st = startBattle(
    "replay",
    [mine(wild("unwind")), mine(wild("plib", 30, "ally"))],
    [wild("plib", 30, "e0"), wild("clikkit", 30, "e1")],
    { slots: 2 },
  );
  st.teams[0][0]!.mana = 100;
  st.teams[0][0]!.cds = {};
  return st;
}

const swing = (side: 0 | 1, slot: number, at: { side: 0 | 1; index: number }): Choice =>
  ({ kind: "attack", side, slot, picks: [at] as never });
const cast = (moveId: string, picks: unknown[], slot = 0): Choice =>
  ({ kind: "spell", side: 0, slot, moveId, picks: picks as never });

/** A round of everyone swinging at whoever is across from them. */
const brawl = (): Choice[] => [
  swing(0, 0, { side: 1, index: 0 }),
  swing(0, 1, { side: 1, index: 1 }),
  swing(1, 0, { side: 0, index: 0 }),
  swing(1, 1, { side: 0, index: 1 }),
];

afterEach(() => stopReplay());

describe("recording a fight", () => {
  it("files nothing until it is turned on", () => {
    const st = fight();
    expect(recording()).toBe(false);
    resolveTurn(st, brawl());
    expect(takeReplay()).toBeNull();
  });

  it("files one round per round, with the state it opened on", () => {
    const st = fight();
    startReplay("test");
    const opening = stateHash(st);
    resolveTurn(st, brawl());
    resolveTurn(st, brawl());
    const data = takeReplay()!;
    expect(data.rounds).toHaveLength(2);
    expect(data.build).toBe("test");
    expect(stateHash(data.rounds[0]!.before)).toBe(opening);
    expect(data.rounds[0]!.turn).toBe(0);
    expect(data.rounds[1]!.turn).toBe(1);
  });

  it("runs back to the same events and the same state", () => {
    const st = fight();
    startReplay("test");
    const live = [resolveTurn(st, brawl()), resolveTurn(st, brawl())];
    const ended = stateHash(st);
    const ran = runReplay(takeReplay()!);
    expect(ran).toHaveLength(2);
    expect(ran.map((r) => r.events.map((e) => e.text))).toEqual(live.map((e) => e.map((x) => x.text)));
    expect(ran[1]!.hash).toBe(ended);
  });

  it("keeps recording the live fight after one is run back", () => {
    const st = fight();
    startReplay("test");
    resolveTurn(st, brawl());
    runReplay(takeReplay()!);
    expect(takeReplay()!.rounds).toHaveLength(1);
    resolveTurn(st, brawl());
    expect(takeReplay()!.rounds).toHaveLength(2);
  });

  it("runs a round that travels back in time, which needs the history with it", () => {
    const st = fight();
    startReplay("test");
    // Three rounds to go back to, then the journey itself.
    resolveTurn(st, brawl());
    resolveTurn(st, brawl());
    resolveTurn(st, brawl());
    st.teams[0][0]!.mana = 100;
    const live = resolveTurn(st, [cast("time-machine", [null]), ...brawl().slice(1)]);
    const data = takeReplay()!;
    const journey = data.rounds.at(-1)!;
    expect(journey.before.history?.length).toBeGreaterThan(0);
    const again = resolveTurn(structuredClone(journey.before), structuredClone(journey.choices));
    expect(again.map((e) => e.text)).toEqual(live.map((e) => e.text));
  });
});
