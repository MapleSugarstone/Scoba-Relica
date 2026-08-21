import { describe, expect, it } from "vitest";
import { makeWild, gainXp, xpForNext, maxHp, statsAt } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { MAX_MOVES, MOVES, SPECIES, speciesMoves } from "../src/sim/species";

describe("leveling", () => {
  it("levels up when xp crosses the threshold and raises every stat by 1", () => {
    const s = makeWild("plib", 4, rngFrom("a"));
    const before = statsAt(s, false);
    const result = gainXp(s, xpForNext(4));
    expect(result.levelsGained).toBe(1);
    expect(s.level).toBe(5);
    const after = statsAt(s, false);
    for (const k of Object.keys(before) as (keyof typeof before)[]) {
      expect(after[k]).toBe(before[k] + 1);
    }
  });

  it("keeps damage taken across level-ups instead of healing to full", () => {
    const s = makeWild("plib", 4, rngFrom("b"));
    s.hp = maxHp(s) - 5;
    gainXp(s, xpForNext(4));
    expect(s.hp).toBe(maxHp(s) - 5);
  });

  it("starts with its whole set and never learns another", () => {
    const low = makeWild("obera", 1, rngFrom("c"));
    const high = makeWild("obera", 40, rngFrom("c2"));
    // Level has nothing to do with what it knows.
    expect(low.moves).toEqual(high.moves);
    expect(low.moves).toEqual(speciesMoves(SPECIES["obera"]!));
    const r = gainXp(low, xpForNext(1) * 6);
    expect(r.levelsGained).toBeGreaterThan(0);
    expect(low.moves).toEqual(high.moves);
  });

  it("orders a move set cheapest first, since statuses address slots 1-4", () => {
    for (const sp of Object.values(SPECIES)) {
      const moves = speciesMoves(sp);
      const costs = moves.map((m) => MOVES[m]!.manaCost);
      expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    }
  });

  it("gives a species no more slots than its own set, capped at four", () => {
    for (const sp of Object.values(SPECIES)) {
      const moves = speciesMoves(sp);
      expect(moves.length).toBeGreaterThan(0);
      expect(moves.length).toBeLessThanOrEqual(MAX_MOVES);
      expect(new Set(moves).size).toBe(moves.length);
    }
  });
});
