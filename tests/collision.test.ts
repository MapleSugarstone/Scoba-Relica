import { describe, expect, it } from "vitest";
import { SUB_FULL, TILE, TileMap } from "../src/engine/tilemap";
import { maskOf } from "../src/game/islandart";

const R = 4;
const DT = 1 / 60;
const SPEED = 72;

/** An open 12x12 map with a solid wall along the top edge of row 3. */
function walledMap(): TileMap {
  const map = new TileMap(12, 12);
  for (let x = 0; x < 12; x++) map.solid[map.idx(x, 2)] = true;
  return map;
}

/** Walk an actor for `frames` frames along a unit heading. */
function walk(
  map: TileMap, x: number, y: number, ax: number, ay: number, frames: number, r = R,
): { x: number; y: number } {
  let at = { x, y };
  for (let i = 0; i < frames; i++) at = map.moveCircle(at.x, at.y, ax * SPEED * DT, ay * SPEED * DT, r);
  return at;
}

describe("circleHits", () => {
  it("is exact against a tile corner rather than sampled around the rim", () => {
    const map = new TileMap(6, 6);
    map.solid[map.idx(3, 3)] = true;
    // The tile's corner is at (48, 48). A body centered on the diagonal just
    // inside its radius of the corner overlaps, one just outside does not.
    const d = (R - 0.2) / Math.SQRT2;
    expect(map.circleHits(48 - d, 48 - d, R)).toBe(true);
    const e = (R + 0.2) / Math.SQRT2;
    expect(map.circleHits(48 - e, 48 - e, R)).toBe(false);
  });

  it("treats the ground past the map's edge as solid", () => {
    const map = new TileMap(4, 4);
    expect(map.circleHits(2, 32, R)).toBe(true);
    expect(map.circleHits(R + 1, 32, R)).toBe(false);
    expect(map.circleHits(32, 4 * TILE - 2, R)).toBe(true);
  });

  it("sees a prop's hitbox and only its hitbox", () => {
    const map = new TileMap(6, 6);
    map.props.push({
      img: null as never, sx: 0, sy: 0, sw: 16, sh: 16, x: 32, y: 32, baseY: 46,
      solid: { x: 37, y: 38, w: 6, h: 7 },
    });
    expect(map.circleHits(40, 41, 0)).toBe(true);
    expect(map.circleHits(33, 33, 0)).toBe(false);
    expect(map.circleHits(37 - R + 0.5, 41, R)).toBe(true);
    expect(map.circleHits(37 - R - 0.5, 41, R)).toBe(false);
  });

  it("notices a prop added after the first query", () => {
    const map = new TileMap(6, 6);
    expect(map.circleHits(40, 41, 0)).toBe(false);
    map.props.push({
      img: null as never, sx: 0, sy: 0, sw: 16, sh: 16, x: 32, y: 32, baseY: 46,
      solid: { x: 37, y: 38, w: 6, h: 7 },
    });
    expect(map.circleHits(40, 41, 0)).toBe(true);
  });
});

describe("moveCircle", () => {
  it("stops flush against a wall instead of a step short of it", () => {
    const map = walledMap();
    const at = walk(map, 80, 80, 0, -1, 120);
    // Row 2's bottom face is at y = 48; the body rests its radius below it.
    expect(at.y).toBeCloseTo(48 + R, 1);
    expect(at.x).toBe(80);
    expect(map.circleHits(at.x, at.y, R)).toBe(false);
  });

  it("slides along a wall of many cells without catching on the seams", () => {
    const map = walledMap();
    // Press into the wall and along it. Every frame should carry the full
    // sideways share of the step; a catch at a seam would eat some of it.
    let at = { x: 40, y: 48 + R };
    const ax = Math.SQRT1_2;
    for (let i = 0; i < 90; i++) {
      const before = at.x;
      at = map.moveCircle(at.x, at.y, ax * SPEED * DT, -ax * SPEED * DT, R);
      expect(at.x - before).toBeCloseTo(ax * SPEED * DT, 6);
      expect(at.y).toBeCloseTo(48 + R, 1);
    }
  });

  it("slides along a fence of subcell rails the same way", () => {
    const map = new TileMap(12, 12);
    for (let x = 0; x < 12; x++) map.fence[map.idx(x, 3)] = true;
    map.finalizeFences();
    // The rails fill row 3's middle band, y in [53.33, 58.67].
    const rest = 3 * TILE + 2 * (TILE / 3) + R;
    let at = { x: 40, y: rest };
    const ax = Math.SQRT1_2;
    for (let i = 0; i < 90; i++) {
      const before = at.x;
      at = map.moveCircle(at.x, at.y, ax * SPEED * DT, -ax * SPEED * DT, R);
      expect(at.x - before).toBeCloseTo(ax * SPEED * DT, 6);
      expect(at.y).toBeCloseTo(rest, 1);
    }
  });

  it("rounds a corner it clips instead of stopping on it", () => {
    const map = new TileMap(12, 12);
    map.solid[map.idx(5, 2)] = true;
    // Walking straight up with the body's left side over the tile's bottom
    // right corner (x = 96). It should drift right and get past the tile.
    const start = { x: 96 + R - 1.5, y: 90 };
    const at = walk(map, start.x, start.y, 0, -1, 180);
    expect(at.x).toBeGreaterThan(96 + R - 0.01);
    expect(at.y).toBeLessThan(2 * TILE);
    expect(map.circleHits(at.x, at.y, R)).toBe(false);
  });

  it("slides clear of a corner it hits nearly head on", () => {
    const map = new TileMap(12, 12);
    map.solid[map.idx(5, 2)] = true;
    // The body's center is 0.3px past the tile's bottom right corner (96, 48),
    // so the push off the corner alone would carry it sideways by a hair a
    // frame. The assist gets it round in a few frames instead.
    let at = { x: 96.3, y: 60 };
    let cleared = -1;
    for (let i = 0; i < 40 && cleared < 0; i++) {
      at = map.moveCircle(at.x, at.y, 0, -SPEED * DT, R);
      expect(map.circleHits(at.x, at.y, R)).toBe(false);
      if (at.y < 44) cleared = i;
    }
    expect(cleared).toBeGreaterThan(0);
    expect(cleared).toBeLessThan(18);
    expect(at.x).toBeGreaterThan(96 + R);
  });

  it("gives no assist into a corner it hits dead on", () => {
    const map = new TileMap(12, 12);
    map.solid[map.idx(5, 2)] = true;
    // Centered on the tile: a face hit, and the body just stops.
    const at = walk(map, 88, 70, 0, -1, 60);
    expect(at.x).toBe(88);
    expect(at.y).toBeCloseTo(48 + R, 1);
  });

  it("never ends a frame overlapping, whatever the heading", () => {
    const map = new TileMap(12, 12);
    map.solid[map.idx(5, 5)] = true;
    map.setCellMask(6, 5, maskOf("... ### ..."));
    map.setCellMask(5, 6, maskOf(".#. .#. .#."));
    for (let k = 0; k < 48; k++) {
      const ang = (k / 48) * Math.PI * 2;
      let at = { x: 88 + Math.cos(ang) * 40, y: 88 + Math.sin(ang) * 40 };
      for (let i = 0; i < 120; i++) {
        at = map.moveCircle(at.x, at.y, -Math.cos(ang) * SPEED * DT, -Math.sin(ang) * SPEED * DT, R);
        expect(map.circleHits(at.x, at.y, R)).toBe(false);
      }
    }
  });

  it("does not tunnel through a rail when the step is longer than the rail is thick", () => {
    const map = new TileMap(12, 12);
    for (let x = 0; x < 12; x++) map.fence[map.idx(x, 3)] = true;
    map.finalizeFences();
    let at = { x: 40, y: 90 };
    for (let i = 0; i < 40; i++) at = map.moveCircle(at.x, at.y, 0, -12, R);
    expect(at.y).toBeGreaterThan(3 * TILE + TILE / 3);
    expect(map.circleHits(at.x, at.y, R)).toBe(false);
  });

  it("refuses a gap narrower than the body", () => {
    const map = new TileMap(12, 12);
    // Two posts with a 6px gap; a body of radius 4 needs 8.
    map.props.push(
      { img: null as never, sx: 0, sy: 0, sw: 0, sh: 0, x: 0, y: 0, baseY: 0, solid: { x: 40, y: 40, w: 8, h: 8 } },
      { img: null as never, sx: 0, sy: 0, sw: 0, sh: 0, x: 0, y: 0, baseY: 0, solid: { x: 54, y: 40, w: 8, h: 8 } },
    );
    const at = walk(map, 51, 70, 0, -1, 120);
    // It can nestle into the mouth of the gap as far as the two corners
    // allow, which is where a circle of this radius touches both, and no further.
    const mouth = 48 + Math.sqrt(R * R - 3 * 3);
    expect(at.y).toBeGreaterThan(mouth - 0.05);
    expect(map.circleHits(at.x, at.y, R)).toBe(false);
  });

  it("lifts a body that starts the frame wedged onto the nearest open ground", () => {
    const map = new TileMap(12, 12);
    map.setCellMask(5, 5, SUB_FULL);
    // Well inside the tile, further than one push can clear.
    const at = map.moveCircle(88, 88, 0, 0, R);
    expect(map.circleHits(at.x, at.y, R)).toBe(false);
    expect(Math.hypot(at.x - 88, at.y - 88)).toBeLessThan(TILE + R + 1);
  });

  it("holds a body still when it is not moving and stands clear", () => {
    const map = walledMap();
    expect(map.moveCircle(80, 80, 0, 0, R)).toEqual({ x: 80, y: 80 });
  });
});

describe("shore rims", () => {
  it("blocks only the quarter-tile band on the sides it names", () => {
    const map = new TileMap(6, 6);
    map.setRim(2, 2, 1 | 8);
    // North band: y in [32, 36). West band: x in [32, 36).
    expect(map.isSolidAt(40, 33)).toBe(true);
    expect(map.isSolidAt(40, 37)).toBe(false);
    expect(map.isSolidAt(33, 40)).toBe(true);
    expect(map.isSolidAt(37, 40)).toBe(false);
    expect(map.isSolidAt(46, 40)).toBe(false);
    expect(map.circleHits(40, 36 + R + 0.5, R)).toBe(false);
    expect(map.circleHits(40, 36 + R - 0.5, R)).toBe(true);
  });

  it("stops feet where the dirt starts rather than at the cell boundary", () => {
    const map = new TileMap(6, 6);
    for (let cx = 0; cx < 6; cx++) map.solid[map.idx(cx, 1)] = true;
    for (let cx = 0; cx < 6; cx++) map.setRim(cx, 2, 1);
    const at = walk(map, 40, 80, 0, -1, 120);
    expect(at.y).toBeCloseTo(2 * TILE + TILE / 4 + R, 1);
  });

  it("clears with zero", () => {
    const map = new TileMap(6, 6);
    map.setRim(2, 2, 2);
    map.setRim(2, 2, 0);
    expect(map.rims.size).toBe(0);
  });
});

describe("nearestFree", () => {
  it("returns the spot itself when it is already clear", () => {
    const map = walledMap();
    expect(map.nearestFree(80, 80, R)).toEqual({ x: 80, y: 80 });
  });

  it("finds the closest open ground beside a wall", () => {
    const map = walledMap();
    const spot = map.nearestFree(80, 40, R)!;
    expect(spot).not.toBeNull();
    expect(map.circleHits(spot.x, spot.y, R)).toBe(false);
    // The wall's bottom face is y = 48; the nearest clear ground is just below it.
    expect(spot.y).toBeGreaterThan(48 + R - 0.01);
    expect(spot.y).toBeLessThan(48 + R + 3);
  });

  it("gives up past its reach", () => {
    const map = new TileMap(12, 12);
    for (let i = 0; i < 144; i++) map.solid[i] = true;
    expect(map.nearestFree(88, 88, R, TILE)).toBeNull();
  });
});
