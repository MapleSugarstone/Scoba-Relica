import { describe, expect, it } from "vitest";
import { advanceCare, newCareState, feed, wash, play, CARE, careLevel } from "../src/sim/care";

const HOUR = 3600_000;

describe("care decay", () => {
  it("drains hunger and cleanliness over time", () => {
    const s0 = newCareState(0);
    const s = advanceCare(s0, 10 * HOUR);
    expect(s.hunger).toBeCloseTo(90 - 10 * CARE.hungerPerHour, 5);
    expect(s.clean).toBeCloseTo(90 - 10 * CARE.cleanPerHour, 5);
    expect(s.lastCalc).toBe(10 * HOUR);
  });

  it("is path-independent: chunked advances equal one big advance", () => {
    const s0 = newCareState(0);
    const big = advanceCare(s0, 50 * HOUR);
    let chunked = s0;
    for (let t = 1; t <= 50; t++) chunked = advanceCare(chunked, t * HOUR);
    expect(chunked).toEqual(big);
    // Odd chunk boundaries (sub-minute remainders) also agree.
    let odd = s0;
    for (let t = 137_000; t <= 50 * HOUR; t += 137_000) odd = advanceCare(odd, t);
    odd = advanceCare(odd, 50 * HOUR);
    expect(odd).toEqual(big);
  });

  it("hibernates when fully neglected and wakes after real care", () => {
    const s0 = newCareState(0);
    const neglected = advanceCare(s0, 20 * 24 * HOUR);
    expect(neglected.hunger).toBe(0);
    expect(neglected.hibernating).toBe(true);
    let s = neglected;
    while (s.hunger < CARE.wakeAt) s = feed(s);
    expect(s.hibernating).toBe(true); // still dirty and sad
    s = wash(s);
    while (s.happy < CARE.wakeAt) s = play(s, 100);
    expect(s.hibernating).toBe(false);
  });

  it("care actions raise the meters and earn care xp", () => {
    let s = advanceCare(newCareState(0), 12 * HOUR);
    const hungerBefore = s.hunger;
    s = feed(s);
    expect(s.hunger).toBe(Math.min(100, hungerBefore + CARE.feedAmount));
    s = wash(s);
    s = play(s, 50);
    expect(s.careXp).toBe(3 * CARE.xpPerAction);
    expect(careLevel({ ...s, careXp: 100 })).toBe(2);
  });
});
