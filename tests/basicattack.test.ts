import { describe, expect, it } from "vitest";
import { basicPower, combatantStats, startBattle, BASIC_BASE, BASIC_PER_LEVEL, BASIC_STR_SCALE } from "../src/sim/battle";
import { makeWild } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const wild = (id: string, lv: number, seed: string) => makeWild(id, lv, rngFrom(seed));

describe("the basic attack", () => {
  it("is a floor, a point a level, and most of Strength", () => {
    expect(basicPower(1, 0)).toBe(BASIC_BASE + BASIC_PER_LEVEL);
    expect(basicPower(30, 100)).toBe(BASIC_BASE + 30 + 100 * BASIC_STR_SCALE);
  });

  it("is worth swinging on a line that spends nothing on Strength", () => {
    // Octoshake has no Strength at all, so before the floor its swing was the
    // one point the stat line is clamped to.
    const st = startBattle("b", [wild("octoshake", 30, "o")], [wild("plib", 30, "p")], { wild: true });
    const me = st.teams[0][0]!;
    expect(me.scoba.genes.str).toBe(0);
    // Its Strength is the common stat and nothing else, so most of the swing
    // is the floor and the level rather than the stat.
    const str = combatantStats(me).str;
    expect(basicPower(30, str) - str * BASIC_STR_SCALE).toBe(BASIC_BASE + 30);
    expect(basicPower(30, str)).toBeGreaterThan(str);
  });

  it("grows with the level and with Strength alike", () => {
    expect(basicPower(30, 50)).toBeGreaterThan(basicPower(1, 50));
    expect(basicPower(10, 200)).toBeGreaterThan(basicPower(10, 100));
  });
});
