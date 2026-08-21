import { describe, expect, it } from "vitest";
import { Trail } from "../src/game/actors";

describe("Trail", () => {
  it("keeps crumbs only once they are a few px apart", () => {
    const t = new Trail();
    t.reset(0, 0);
    t.push(1, 0);
    t.push(2, 0);
    expect(t.head()).toBe(0); // too close to count
    t.push(10, 0);
    expect(t.head()).toBe(1);
  });

  it("searches newest first, which is what a rejoin depends on", () => {
    const t = new Trail();
    t.reset(0, 0);
    for (let x = 10; x <= 100; x += 10) t.push(x, 0);
    // Two crumbs match; the newer one wins, so a companion rejoins at the
    // nearest point of the path rather than the start of it.
    const i = t.findBack((p) => p.x === 20 || p.x === 80);
    expect(t.at(i)).toEqual({ x: 80, y: 0 });
  });

  it("reports nothing when no crumb matches", () => {
    const t = new Trail();
    t.reset(0, 0);
    t.push(10, 0);
    expect(t.findBack((p) => p.x > 500)).toBe(-1);
    expect(t.at(-1)).toBeNull();
  });

  it("keeps indices valid as old crumbs fall off the back", () => {
    const t = new Trail();
    t.reset(0, 0);
    for (let i = 1; i <= 500; i++) t.push(i * 10, 0);
    const head = t.head();
    expect(t.at(head)).toEqual({ x: 5000, y: 0 });
    // The oldest have been dropped, and asking for one is not an error.
    expect(t.at(0)).toBeNull();
  });

  it("forgets the old path when it is reset", () => {
    const t = new Trail();
    t.reset(0, 0);
    for (let x = 10; x <= 100; x += 10) t.push(x, 0);
    t.reset(500, 500);
    expect(t.head()).toBe(0);
    expect(t.at(0)).toEqual({ x: 500, y: 500 });
    expect(t.findBack((p) => p.x === 50)).toBe(-1);
  });
});
