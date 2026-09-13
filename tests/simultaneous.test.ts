import { describe, expect, it } from "vitest";
import { startBattle, resolveTurn, combatantStats, type BattleState } from "../src/sim/battle";
import { STATUSES, newStatus } from "../src/sim/status";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { MOVES } from "../src/sim/species";

const wild = (id: string, lv: number, seed: string): ScobaInstance =>
  makeWild(id, lv, rngFrom(seed));
const owned = (s: ScobaInstance): ScobaInstance => ({ ...s, owner: "A" });

/** A caster with a move that reaches the whole enemy line, against two of them. */
function field(enemyA: string, enemyB: string): BattleState {
  const me = owned(wild("wispen", 30, "me"));
  me.moves = ["scatter-shot"];
  const st = startBattle("sim", [me, owned(wild("plib", 30, "ally"))],
    [wild(enemyA, 30, "e1"), wild(enemyB, 30, "e2")], { slots: 2 });
  // Scatter Shot opens locked, and this is about what it does once it goes.
  st.teams[0][0]!.cds = {};
  st.teams[0][0]!.mana = 100;
  return st;
}

const sweep = (st: BattleState) => resolveTurn(st, [
  { kind: "spell", side: 0, slot: 0, moveId: "scatter-shot", picks: [null] },
  { kind: "block", side: 0, slot: 1 },
]);

describe("a strike that reaches several at once", () => {
  it("lands every hit before anything answers", () => {
    const st = field("plib", "plib");
    const ev = sweep(st);
    // Both hits are written before the first thing either of them set off.
    const kinds = ev.map((e) => e.kind);
    const hits = kinds.map((k, i) => (k === "hit" ? i : -1)).filter((i) => i >= 0);
    const after = kinds.findIndex((k, i) => i > hits[0]! && k !== "hit" && k !== "spell");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[1]).toBeLessThan(after === -1 ? Infinity : after);
  });

  it("hits everyone for the same number, whoever falls first", () => {
    // Two of the same line at the same level take the same hit, which they
    // would not if the first to fall had already set anything off.
    const st = field("plib", "plib");
    const before = st.teams[1].slice(0, 2).map((c) => c.hp);
    const ev = sweep(st);
    const dealt = ev.filter((e) => e.kind === "hit" && e.at?.side === 1)
      .map((e) => before[e.at!.index]! - e.hp!);
    expect(dealt).toHaveLength(2);
    expect(dealt[0]).toBe(dealt[1]);
  });

  it("answers fastest first", () => {
    // A mark that fires when its holder is hit, so the order it goes off in is
    // readable off the log.
    STATUSES["test-yelp"] = {
      id: "test-yelp", name: "Yelp", polarity: "good",
      trigger: { on: "hit-any" }, duration: null, charges: null,
      stacks: false, maxStacks: 1, persists: true,
      effects: [{ kind: "mana", on: "self", amount: 5 }],
    };
    // Catsquito is the fastest line on the roster, Obera among the slowest.
    const st = field("obera", "catsquito");
    for (const i of [0, 1]) st.teams[1][i]!.statuses.push(newStatus("test-yelp")!);
    const slow = combatantStats(st.teams[1][0]!).spd;
    const quick = combatantStats(st.teams[1][1]!).spd;
    expect(quick).toBeGreaterThan(slow);

    const ev = sweep(st);
    const yelps = ev.filter((e) => e.kind === "status" && e.text.includes("brimming"))
      .map((e) => e.at?.index);
    expect(yelps).toHaveLength(2);
    // The quick one is team index 1, and it answers before the slow one.
    expect(yelps[0]).toBe(1);
    expect(yelps[1]).toBe(0);
  });

  it("stops answering once a side is gone", () => {
    const st = field("plib", "plib");
    for (const i of [0, 1]) st.teams[1][i]!.hp = 1;
    const ev = sweep(st);
    expect(st.winner).toBe(0);
    // Both fell to the one strike, and the battle was called once.
    expect(ev.filter((e) => e.kind === "faint")).toHaveLength(2);
    expect(ev.filter((e) => e.kind === "win")).toHaveLength(1);
  });

  it("leaves a single-target move exactly as it was", () => {
    const st = field("plib", "plib");
    const me = st.teams[0][0]!;
    me.scoba.moves = ["hex"];
    me.mana = 100;
    const before = st.teams[1].slice(0, 2).map((c) => c.hp);
    resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "hex", picks: [{ side: 1, index: 0 }] },
      { kind: "block", side: 0, slot: 1 },
    ]);
    expect(st.teams[1][0]!.hp).toBeLessThan(before[0]!);
    // The one it was not aimed at is untouched.
    expect(st.teams[1][1]!.hp).toBe(before[1]!);
  });
});

describe("Tentacle Slap", () => {
  it("leads with Moon", () => {
    expect(MOVES["tentacle-slap"]!.type).toBe("moon");
    expect(MOVES["tentacle-slap"]!.type2).toBeUndefined();
  });
});
