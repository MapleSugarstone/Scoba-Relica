import { describe, expect, it } from "vitest";
import { Actor } from "../src/game/actors";

/**
 * Open ground with no edges, the same stand-in the battle stage walks on: a
 * fighter starts off the side of the view, which a real map counts as a wall.
 */
function field(): Parameters<Actor["step"]>[3] {
  return {
    moveCircle: (x: number, y: number, dx: number, dy: number) => ({ x: x + dx, y: y + dy }),
  } as unknown as Parameters<Actor["step"]>[3];
}

function walker(x: number, y: number): Actor {
  return new Actor(x, y, { sprite: { img: null as never, px: 0, py: 0 }, motion: "scamper" });
}

describe("walking onto a mark", () => {
  it("arrives, rather than creeping up on the spot for ever", () => {
    const map = field();
    const a = walker(-20, 200);
    let frames = 0;
    // A walk-on covers about a fifth of a stage; give it a generous ceiling.
    while (Math.hypot(84 - a.x, 200 - a.y) > 0.001 && frames < 60 * 12) {
      a.seek(1 / 60, 84, 200, 0.5, map, 1.6, 0.85);
      frames += 1;
    }
    // It lands on the mark, not near it.
    expect(Math.hypot(84 - a.x, 200 - a.y)).toBeLessThan(0.001);
    // And briskly: no asymptotic crawl over the last stretch.
    expect(frames / 60).toBeLessThan(2.5);
  });

  it("never jumps: a frame moves it no further than its pace allows", () => {
    const map = field();
    const a = walker(-20, 200);
    const pace = 1.6;
    for (let f = 0; f < 60 * 8; f++) {
      const from = { x: a.x, y: a.y };
      a.seek(1 / 60, 84, 200, 0.5, map, pace, 0.85);
      const moved = Math.hypot(a.x - from.x, a.y - from.y);
      // Whatever the target, a step is bounded by speed times the frame.
      expect(moved).toBeLessThanOrEqual(a.speed * pace * (1 / 60) + 1e-6);
    }
  });

  it("holds still once it is there", () => {
    const map = field();
    const a = walker(84, 200);
    for (let f = 0; f < 60; f++) a.seek(1 / 60, 84, 200, 0.5, map, 1.6, 0.85);
    expect(a.x).toBe(84);
    expect(a.y).toBe(200);
    expect(a.moving).toBe(false);
  });

  /**
   * Strides taken while there was still a real gap to close. The very last one
   * is clipped so the walk lands on its mark, so it says nothing about pace.
   */
  const stridesOver = (
    a: Actor, gap: number, opts: { pace?: number; floor?: number; slack: number },
  ): number[] => {
    const map = field();
    const out: number[] = [];
    for (let f = 0; f < 60 * 8; f++) {
      const from = { x: a.x, y: a.y };
      const left = a.seek(1 / 60, 84, 200, opts.slack, map, opts.pace ?? 1, opts.floor ?? 0);
      if (left <= opts.slack) break;
      if (left > gap) out.push(Math.hypot(a.x - from.x, a.y - from.y));
    }
    return out;
  };

  it("keeps a steady pace to the end instead of creeping in", () => {
    const strides = stridesOver(walker(-20, 200), 3, { pace: 1.6, floor: 0.85, slack: 0.5 });
    const fastest = Math.max(...strides);
    const slowest = Math.min(...strides);
    // The floor is 0.85 against a top pace of 1.6, so nothing should drop
    // below about half of the quickest stride.
    expect(slowest).toBeGreaterThan(fastest * 0.4);
  });

  it("still lets an amble ease off, which is what companions want", () => {
    const strides = stridesOver(walker(-20, 200), 3, { slack: 1.2 });
    const fastest = Math.max(...strides);
    const slowest = Math.min(...strides);
    expect(slowest).toBeLessThan(fastest * 0.3);
  });

  it("closes the gap steadily, so the walk reads as one motion", () => {
    const map = field();
    const a = walker(-20, 200);
    let last = Math.hypot(84 - a.x, 200 - a.y);
    for (let f = 0; f < 60 * 4; f++) {
      a.seek(1 / 60, 84, 200, 1.2, map, 1.6);
      const now = Math.hypot(84 - a.x, 200 - a.y);
      expect(now).toBeLessThanOrEqual(last + 1e-6);
      last = now;
    }
  });
});
