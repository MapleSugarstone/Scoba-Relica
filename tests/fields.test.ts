import { describe, expect, it } from "vitest";
import {
  startBattle,
  resolveTurn,
  previewMove,
  stateHash,
  type BattleState,
} from "../src/sim/battle";
import { FIELDS } from "../src/sim/status";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const wild = (species: string, level: number, seed: string) => makeWild(species, level, rngFrom(seed));
const owned = (s: ScobaInstance, owner: "A" | "B"): ScobaInstance => ({ ...s, owner });

/** One out with a spare behind it, against one enemy with a spare too. */
function duel(mine: string, theirs: string, moves?: string[]): BattleState {
  const me = owned(wild(mine, 20, `${mine}-a`), "A");
  if (moves) me.moves = moves;
  const st = startBattle(
    `field:${mine}-vs-${theirs}`,
    [me, owned(wild("cactunny", 20, `${mine}-b`), "A")],
    [wild(theirs, 20, `${theirs}-a`), wild("plib", 20, `${theirs}-b`)],
    { slots: 1, owners: ["A", null] },
  );
  st.teams[0][0]!.mana = 100;
  st.teams[0][0]!.cds = {};
  return st;
}

/** Runs the turn out, topping the caster back up so it can go again. */
function pass(st: BattleState, n = 1): void {
  for (let i = 0; i < n; i++) {
    resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    st.teams[0][0]!.mana = 100;
    st.teams[0][0]!.cds = {};
  }
}

describe("fields", () => {
  it("stands over a side rather than on a Scoba, so nobody carries it", () => {
    const st = duel("cactunny", "grima");
    for (const side of [0, 1] as const) {
      expect(st.fields[side]?.id).toBe("sunblessed");
      for (const c of st.teams[side]) {
        expect(c.statuses.map((s) => s.id)).not.toContain("sunblessed");
      }
    }
  });

  it("only turns up once Cactunny is on the field, and only once a battle", () => {
    const st = duel("flarea", "grima", ["cinder-spit"]);
    expect(st.fields[0]).toBeNull();
    expect(st.fields[1]).toBeNull();
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    expect(st.fields[0]?.id).toBe("sunblessed");
    // Sent out again, it has nothing left to call: the field runs its own
    // clock down rather than being topped back up.
    const turns = st.fields[0]!.turnsLeft;
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 0 }]);
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    expect(st.fields[0]!.turnsLeft).toBeLessThan(turns);
  });

  it("gives the side under it 25% more out of a Sun move", () => {
    const bare = duel("flarea", "grima", ["cinder-spit"]);
    const blessed = duel("flarea", "grima", ["cinder-spit"]);
    const plain = previewMove(bare, { side: 0, index: 0 }, "cinder-spit")!.damage!;
    resolveTurn(blessed, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    resolveTurn(blessed, [{ kind: "switch", side: 0, slot: 0, benchIndex: 0 }]);
    expect(blessed.fields[0]?.id).toBe("sunblessed");
    const under = previewMove(blessed, { side: 0, index: 0 }, "cinder-spit")!.damage!;
    expect(under).toBe(Math.floor(plain * 1.25));
  });

  it("measures element power off the caster's own side, not the target's", () => {
    const st = duel("flarea", "grima", ["cinder-spit"]);
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 0 }]);
    const both = previewMove(st, { side: 0, index: 0 }, "cinder-spit")!.damage!;
    st.fields[0] = null;
    const neither = previewMove(st, { side: 0, index: 0 }, "cinder-spit")!.damage!;
    expect(neither).toBeLessThan(both);
  });

  it("lifts when its turns run out, and says so once for both sides", () => {
    const st = duel("cactunny", "grima");
    const turns = FIELDS["sunblessed"]!.duration!;
    pass(st, turns - 1);
    expect(st.fields[0]?.id).toBe("sunblessed");
    const events = resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    expect(st.fields[0]).toBeNull();
    expect(st.fields[1]).toBeNull();
    const lifted = events.filter((e) => e.kind === "field");
    expect(lifted).toHaveLength(1);
    expect(lifted[0]!.field).toEqual({ id: null, sides: [0, 1] });
  });

  it("survives a switch and a faint, since nobody is holding it", () => {
    const st = duel("cactunny", "grima");
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    expect(st.fields[0]?.id).toBe("sunblessed");
    st.teams[1][0]!.hp = 0;
    st.teams[1][0]!.fainted = true;
    expect(st.fields[1]?.id).toBe("sunblessed");
  });

  it("names one event for a field laid over both sides, so it is called once", () => {
    const st = duel("cactunny", "grima");
    const laid = st.opening.filter((e) => e.kind === "field");
    expect(laid).toHaveLength(1);
    expect(laid[0]!.field).toEqual({ id: "sunblessed", sides: [0, 1] });
    expect(laid[0]!.by).toEqual({ side: 0, index: 0 });
    expect(laid[0]!.text).toBe(FIELDS["sunblessed"]!.onset);
  });

  it("goes into the digest, so two clients cannot disagree about the weather", () => {
    const st = duel("cactunny", "grima");
    const under = stateHash(st);
    st.fields[0] = null;
    st.fields[1] = null;
    expect(stateHash(st)).not.toBe(under);
  });

  it("takes the place of whatever was standing over that side", () => {
    const st = duel("cactunny", "grima");
    // Worn down to its last turn, then the Cactunny on the bench comes out
    // and lays its own over the top.
    st.fields[0] = { id: "sunblessed", turnsLeft: 1 };
    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    // A side holds one field and not a list of them, so the new one is simply
    // what is there: full clock, and credited to whoever called it.
    expect(st.fields[0]).toEqual({
      id: "sunblessed",
      turnsLeft: FIELDS["sunblessed"]!.duration! - 1,
      from: { side: 0, index: 1 },
    });
  });
});
