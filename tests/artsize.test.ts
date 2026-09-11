import { describe, expect, it } from "vitest";
import { pivotOf } from "../src/game/critters";
import { DOLL_H, DOLL_PIVOT, DOLL_W } from "../src/engine/paperdoll";

/**
 * Where a drawing stands on its own sheet. Every line used to be drawn on the
 * one canvas, so this was a constant; a line drawn bigger now works its own out,
 * and the rule has to keep giving the old answer for the old size.
 */
describe("the feet on a sheet of any size", () => {
  it("gives the doll's own pivot for the doll's own size", () => {
    expect(pivotOf({ w: DOLL_W, h: DOLL_H }))
      .toEqual({ px: DOLL_PIVOT.x, py: DOLL_PIVOT.y });
  });

  it("keeps the feet the same height above the bottom edge", () => {
    const gap = DOLL_H - DOLL_PIVOT.y;
    for (const size of [{ w: 118, h: 139 }, { w: 200, h: 260 }, { w: 64, h: 80 }]) {
      expect(size.h - pivotOf(size).py).toBe(gap);
    }
  });

  it("stands a wider sheet on its middle", () => {
    expect(pivotOf({ w: 200, h: 139 }).px).toBe(100);
    expect(pivotOf({ w: 118, h: 139 }).px).toBe(59);
  });

  it("grows upward rather than downward, so a taller line does not sink", () => {
    const small = pivotOf({ w: 118, h: 139 });
    const tall = pivotOf({ w: 118, h: 239 });
    // The drawing is 100 taller and its feet are 100 further down the sheet,
    // which is the same point on the ground.
    expect(tall.py - small.py).toBe(100);
  });
});
