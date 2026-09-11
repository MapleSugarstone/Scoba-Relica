import { describe, expect, it } from "vitest";
import { mitigation, startBattle, resolveTurn, combatantStats } from "../src/sim/battle";
import { STATUSES, foldStatEffects, newStatus } from "../src/sim/status";
import { makeWild } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { STAT_FLOOR, STAT_NAMES, stats, type StatName } from "../src/sim/types";

const wild = (id: string, lv: number, seed: string) => makeWild(id, lv, rngFrom(seed));

/** One continuous effect, in the shape `foldStatEffects` reads. */
const add = (stat: StatName, amount: number) =>
  ({ effect: { kind: "stat-add" as const, stat, amount }, stacks: 1, power: 0 });

describe("mitigation", () => {
  it("leaves an undefended hit alone", () => {
    expect(mitigation(0)).toBe(1);
  });

  it("halves at 100 and quarters at 300", () => {
    expect(mitigation(100)).toBe(0.5);
    expect(mitigation(300)).toBe(0.25);
  });

  it("adds back what the same armour would have taken off", () => {
    // The curve mirrors about zero: -100 puts on half again, which is what
    // +100 takes off.
    expect(mitigation(-100)).toBeCloseTo(1.5, 10);
    expect(mitigation(-300)).toBeCloseTo(1.75, 10);
    for (const armor of [25, 50, 100, 240, 300]) {
      expect(mitigation(-armor) - 1).toBeCloseTo(1 - mitigation(armor), 10);
    }
  });

  it("approaches double and never passes it", () => {
    expect(mitigation(-10000)).toBeLessThan(2);
    expect(mitigation(-1e9)).toBeLessThan(2);
    expect(mitigation(-1e9)).toBeGreaterThan(1.99);
  });

  it("only ever goes one way as armour climbs", () => {
    let last = Infinity;
    for (let armor = -400; armor <= 400; armor += 10) {
      const now = mitigation(armor);
      expect(now).toBeLessThan(last);
      last = now;
    }
  });
});

describe("stat floors", () => {
  it("stops Strength and Magic at nothing", () => {
    const line = stats(100, 100, 100, 100, 100, 100);
    const out = foldStatEffects(line, [add("str", -500), add("mag", -500)]);
    expect(out.str).toBe(0);
    expect(out.mag).toBe(0);
  });

  it("lets Defense, Resistance and Speed go under nothing", () => {
    const line = stats(100, 100, 100, 100, 100, 100);
    const out = foldStatEffects(line, [add("def", -150), add("res", -150), add("spd", -150)]);
    expect(out.def).toBe(-50);
    expect(out.res).toBe(-50);
    expect(out.spd).toBe(-50);
  });

  it("keeps a pool on the field", () => {
    const line = stats(100, 100, 100, 100, 100, 100);
    expect(foldStatEffects(line, [add("hp", -500)]).hp).toBe(1);
  });

  it("agrees with the table it is written from", () => {
    const line = stats(100, 100, 100, 100, 100, 100);
    const out = foldStatEffects(line, STAT_NAMES.map((s) => add(s, -500)));
    for (const name of STAT_NAMES) {
      const floor = STAT_FLOOR[name];
      if (floor === null) expect([name, out[name] < 0]).toEqual([name, true]);
      else expect([name, out[name]]).toEqual([name, floor]);
    }
  });
});

describe("a stripped defence in a real fight", () => {
  // Nothing on the roster strips this far yet, so the mark is made here.
  STATUSES["test-strip"] = {
    id: "test-strip", name: "Stripped", polarity: "bad",
    trigger: { on: "passive" }, duration: null, charges: null,
    stacks: false, maxStacks: 1, persists: true,
    effects: [{ kind: "stat-add", stat: "def", amount: -400 }],
  };

  /** One basic attack on an Obera, with its Defense left alone or stripped. */
  const swing = (stripped: boolean): { dealt: number; def: number } => {
    const st = startBattle(`strip${String(stripped)}`,
      [wild("plib", 30, "a")], [wild("obera", 30, "b")], { wild: true });
    const target = st.teams[1][0]!;
    if (stripped) target.statuses.push(newStatus("test-strip")!);
    const def = combatantStats(target).def;
    const before = target.hp;
    const events = resolveTurn(st,
      [{ kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] }]);
    // Read off the hit itself: Obera regenerates at the end of a turn, and
    // that would colour the number on both sides of the comparison.
    const hit = events.find((e) => e.kind === "hit")!;
    return { dealt: before - hit.hp!, def };
  };

  it("reads a negative Defense and takes more for it", () => {
    const plain = swing(false);
    const bare = swing(true);
    expect(plain.def).toBeGreaterThan(0);
    expect(bare.def).toBeLessThan(0);
    expect(bare.dealt).toBeGreaterThan(plain.dealt);
    // What it took is what the curve says it should have.
    expect(bare.dealt / plain.dealt)
      .toBeCloseTo(mitigation(bare.def) / mitigation(plain.def), 1);
  });
});
