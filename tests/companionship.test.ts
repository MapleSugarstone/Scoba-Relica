import { describe, expect, it } from "vitest";
import {
  MIN_STINT_S, advanceCompanionship, companionshipBalance, newCompanionship,
  type Companionship,
} from "../src/sim/companionship";

const BOTH = { A: true, B: true };
const ONLY_A = { A: true, B: false };
const ONLY_B = { A: false, B: true };

/** Run for `seconds` at a steady tick, counting how often it changed hands. */
function run(state: Companionship, seconds: number, here: { A: boolean; B: boolean }, dt = 0.5) {
  let s = state;
  let swaps = 0;
  for (let t = 0; t < seconds; t += dt) {
    const before = s.with;
    s = advanceCompanionship(s, dt, here);
    if (s.with !== before) swaps++;
  }
  return { state: s, swaps };
}

describe("who the Relica walks with", () => {
  it("starts with someone", () => {
    expect(newCompanionship("A").with).toBe("A");
  });

  it("stays with the one who is actually there", () => {
    const { state } = run(newCompanionship("A"), 300, ONLY_A);
    expect(state.with).toBe("A");
    expect(state.withB).toBe(0);
  });

  it("goes with the other one when its own character leaves", () => {
    const s = advanceCompanionship(newCompanionship("A"), 0.5, ONLY_B);
    expect(s.with).toBe("B");
  });

  it("does not dither: it stays put for a stint before reconsidering", () => {
    const { swaps } = run(newCompanionship("A"), MIN_STINT_S - 2, BOTH);
    expect(swaps).toBe(0);
  });

  it("goes to the neglected one once the two are back together", () => {
    // Five minutes alone with A, which is a debt owed to B.
    const { state: apart } = run(newCompanionship("A"), 300, ONLY_A);
    expect(apart.withB).toBe(0);
    // Reunited, it should cross over rather than stay on the one it was with.
    const { state: back } = run(apart, MIN_STINT_S + 5, BOTH);
    expect(back.with).toBe("B");
  });

  it("stays with the neglected one in a chunk, not a moment", () => {
    const { state: apart } = run(newCompanionship("A"), 300, ONLY_A);
    const { state: crossed } = run(apart, MIN_STINT_S + 1, BOTH);
    expect(crossed.with).toBe("B");
    // It owes B a lot, so it should still be with B a good while later.
    const { state: later, swaps } = run(crossed, 60, BOTH);
    expect(later.with).toBe("B");
    expect(swaps).toBe(0);
  });

  it("evens out over a long spell together", () => {
    const { state } = run(newCompanionship("A"), 3600, BOTH);
    // An hour in, neither should have had appreciably more of it than the other.
    expect(Math.abs(companionshipBalance(state))).toBeLessThan(0.05);
  });

  it("pays back a long separation rather than carrying the debt forever", () => {
    // Ten minutes with A alone, then an hour together.
    const { state: apart } = run(newCompanionship("A"), 600, ONLY_A);
    const { state: settled } = run(apart, 3600, BOTH);
    expect(Math.abs(companionshipBalance(settled))).toBeLessThan(0.05);
  });

  it("does not swap back and forth once they are level", () => {
    const { state: even } = run(newCompanionship("A"), 1200, BOTH);
    // Level, so it should change hands at a walking pace, not a flicker.
    const { swaps } = run(even, 300, BOTH);
    expect(swaps).toBeLessThanOrEqual(300 / MIN_STINT_S + 1);
  });

  it("keeps the debt while they are apart and spends it when they meet", () => {
    const { state: apart } = run(newCompanionship("A"), 300, ONLY_A);
    const owedBefore = apart.withA - apart.withB;
    expect(owedBefore).toBeGreaterThan(200);
    const { state: after } = run(apart, 600, BOTH);
    expect(after.withA - after.withB).toBeLessThan(owedBefore);
  });

  it("holds still when neither of them is reachable", () => {
    const s = advanceCompanionship(newCompanionship("A"), 0.5, { A: false, B: false });
    expect(s.with).toBe("A");
  });
});
