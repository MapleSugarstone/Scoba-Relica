import { describe, expect, it } from "vitest";
import { hexToRgb, hueShift, type RGB } from "../src/engine/recolor";
import { SHINY_CHANCE, SHINY_TURN, makeWild } from "../src/sim/scoba";
import { breed } from "../src/sim/breeding";
import { rngFrom } from "../src/sim/rng";
import { emitSpark, shedSparks, stepSparks, type Spark } from "../src/engine/sprite";

/** Hue of a colour in turns, 0 to 1, which is what the shift moves. */
function hueOf([r, g, b]: RGB): number {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return -1;
  const h = max === rn
    ? (gn - bn) / d + (gn < bn ? 6 : 0)
    : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return h / 6;
}

function lightness([r, g, b]: RGB): number {
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
}

describe("hueShift", () => {
  it("turns a colour a quarter of the way round", () => {
    for (const hex of ["#d9553f", "#7aa74a", "#4f8fba", "#8d63c0", "#eae178"]) {
      const before = hexToRgb(hex);
      const after = hueShift(before, SHINY_TURN);
      const moved = (hueOf(after) - hueOf(before) + 1) % 1;
      expect(moved).toBeCloseTo(SHINY_TURN, 2);
    }
  });

  it("keeps how light and how strong the colour is", () => {
    const before = hexToRgb("#d9553f");
    const after = hueShift(before, SHINY_TURN);
    expect(lightness(after)).toBeCloseTo(lightness(before), 2);
  });

  it("leaves grey alone, having no hue to turn", () => {
    for (const hex of ["#000000", "#ffffff", "#808080"]) {
      expect(hueShift(hexToRgb(hex), SHINY_TURN)).toEqual(hexToRgb(hex));
    }
  });

  it("comes back where it started after four quarters", () => {
    const start = hexToRgb("#4f8fba");
    let now = start;
    for (let i = 0; i < 4; i++) now = hueShift(now, SHINY_TURN);
    for (let i = 0; i < 3; i++) expect(Math.abs(now[i]! - start[i]!)).toBeLessThanOrEqual(2);
  });

  it("wraps rather than running off the end of the wheel", () => {
    const a = hueShift(hexToRgb("#d9553f"), 0.9);
    const b = hueShift(hexToRgb("#d9553f"), -0.1);
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThanOrEqual(2);
  });
});

describe("shiny rolls", () => {
  it("turns up about as often as the chance says", () => {
    let shiny = 0;
    const runs = 30000;
    for (let i = 0; i < runs; i++) {
      if (makeWild("catsquito", 3, rngFrom(`wild:${i}`)).shiny) shiny += 1;
    }
    // Expects 100 at 1 in 300. Four deviations either way, so a fair run does
    // not fail while a rate off by a factor still does.
    const want = runs * SHINY_CHANCE;
    const spread = 4 * Math.sqrt(runs * SHINY_CHANCE * (1 - SHINY_CHANCE));
    expect(shiny).toBeGreaterThan(want - spread);
    expect(shiny).toBeLessThan(want + spread);
  });

  it("is decided by the seed, so two clients hatch the same one", () => {
    const mom = makeWild("catsquito", 5, rngFrom("mom"));
    const dad = makeWild("catsquito", 5, rngFrom("dad"));
    const once = breed(mom, dad, rngFrom("same-seed")).child.shiny;
    const twice = breed(mom, dad, rngFrom("same-seed")).child.shiny;
    expect(once).toBe(twice);
  });

  it("hatches shiny children too, and just as rarely", () => {
    const mom = makeWild("catsquito", 5, rngFrom("mom"));
    const dad = makeWild("catsquito", 5, rngFrom("dad"));
    const runs = 12000;
    let shiny = 0;
    for (let i = 0; i < runs; i++) {
      if (breed(mom, dad, rngFrom(`hatch:${i}`)).child.shiny) shiny += 1;
    }
    expect(shiny).toBeGreaterThan(0);
    const want = runs * SHINY_CHANCE;
    const spread = 4 * Math.sqrt(runs * SHINY_CHANCE * (1 - SHINY_CHANCE));
    expect(shiny).toBeGreaterThan(want - spread);
    expect(shiny).toBeLessThan(want + spread);
  });
});

describe("shiny sparkles", () => {
  /** Deterministic stand-in for Math.random, so a case reads the same twice. */
  const seeded = (): (() => number) => {
    let n = 1;
    return () => {
      n = (n * 1103515245 + 12345) % 2147483648;
      return n / 2147483648;
    };
  };

  const run = (list: Spark[], secs: number, dt = 1 / 60): void => {
    for (let i = 0; i < Math.round(secs / dt); i++) stepSparks(list, dt);
  };

  it("appears within reach of the body, above the ground", () => {
    const rand = seeded();
    for (let i = 0; i < 200; i++) {
      const sp = emitSpark(100, 200, rand);
      // Halved down the screen, so the reach is measured the same way.
      expect(Math.hypot(sp.x - 100, (sp.y - 200) * 2)).toBeLessThanOrEqual(13.001);
      expect(sp.z).toBeGreaterThan(0);
    }
  });

  it("never moves once it is there", () => {
    const list: Spark[] = [];
    shedSparks(list, 40, 70, 0, 0.2);
    const sp = list[0]!;
    const was = { x: sp.x, y: sp.y, z: sp.z };
    run(list, 0.4);
    expect({ x: sp.x, y: sp.y, z: sp.z }).toEqual(was);
  });

  it("swells in and fades out, widest halfway through", () => {
    const sp = emitSpark(0, 0, seeded());
    const grow = (): number => Math.sin((1 - sp.life / sp.max) * Math.PI);
    expect(grow()).toBeCloseTo(0, 5);
    sp.life = sp.max / 2;
    expect(grow()).toBeCloseTo(1, 5);
    sp.life = 0.0001;
    expect(grow()).toBeLessThan(0.01);
  });

  it("shows at a steady rate, and carries the remainder over", () => {
    const list: Spark[] = [];
    let carry = 0;
    // A tenth of a second at a time, for a second.
    for (let i = 0; i < 10; i++) carry = shedSparks(list, 0, 0, carry, 0.1);
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(list.length).toBeLessThanOrEqual(7);
    expect(carry).toBeLessThan(0.16);
  });

  it("keeps a lid on how many are alive, however long the frame", () => {
    const list: Spark[] = [];
    shedSparks(list, 0, 0, 0, 60);
    expect(list.length).toBeLessThanOrEqual(24);
  });

  it("holds a steady handful at a time rather than piling up", () => {
    const list: Spark[] = [];
    let carry = 0;
    for (let i = 0; i < 600; i++) {
      carry = shedSparks(list, 0, 0, carry, 1 / 60);
      stepSparks(list, 1 / 60);
    }
    expect(list.length).toBeGreaterThan(2);
    expect(list.length).toBeLessThan(12);
  });

  it("clears out once the body stops showing them", () => {
    const list: Spark[] = [];
    shedSparks(list, 0, 0, 0, 0.5);
    expect(list.length).toBeGreaterThan(0);
    run(list, 3);
    expect(list).toHaveLength(0);
  });
});
