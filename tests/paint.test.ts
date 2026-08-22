import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK, sanitizeLook } from "../src/engine/recolor";
import {
  MAX_PAINT_COLORS,
  PaintGrid,
  hasPaint,
  paintPixels,
  sanitizePaintSet,
  type PaintLayer,
} from "../src/engine/paint";

const W = 8;
const H = 4;

const grid = (): PaintGrid => new PaintGrid(W, H);

/** A mask that only opens the top row, standing in for a part's own region. */
function topRow(): Uint8Array {
  const bits = new Uint8Array(W * H);
  bits.fill(1, 0, W);
  return bits;
}

/** The cells a layer decodes back into, as one flat array. */
function cellsOf(layer: PaintLayer | undefined): number[] {
  return [...PaintGrid.from(layer, W, H).cells];
}

describe("storing a painted layer", () => {
  it("comes back as it went in", () => {
    const g = grid();
    const red = g.colorIndex("#ff0000");
    const blue = g.colorIndex("#0000ff");
    g.set(0, 0, red, null);
    g.set(1, 0, red, null);
    g.set(5, 2, blue, null);
    expect(cellsOf(g.toLayer())).toEqual([...g.cells]);
  });

  it("is nothing at all until something is painted", () => {
    expect(grid().toLayer()).toBeUndefined();
    expect(grid().painted).toBe(false);
  });

  it("reads a run longer than one digit", () => {
    const g = grid();
    const c = g.colorIndex("#123456");
    for (let x = 0; x < W; x += 1) g.set(x, 0, c, null);
    const layer = g.toLayer()!;
    // One colour, one run of eight, and no clear tail written out.
    expect(layer.d).toBe("B8");
    expect(cellsOf(layer).slice(0, W)).toEqual(new Array(W).fill(1));
  });

  it("leaves the trailing clear cells off the wire", () => {
    const g = grid();
    g.set(0, 0, g.colorIndex("#ffffff"), null);
    expect(g.toLayer()!.d).toBe("B");
    expect(cellsOf(g.toLayer())).toEqual([1, ...new Array(W * H - 1).fill(0)]);
  });

  it("drops a colour once the last of it is erased", () => {
    const g = grid();
    const keep = g.colorIndex("#111111");
    const gone = g.colorIndex("#222222");
    g.set(0, 0, keep, null);
    g.set(1, 0, gone, null);
    g.set(1, 0, 0, null);
    const layer = g.toLayer()!;
    expect(layer.p).toEqual(["#111111"]);
  });

  it("snaps to the nearest colour it already holds once the palette is full", () => {
    const g = grid();
    for (let i = 0; i < MAX_PAINT_COLORS; i += 1) {
      g.colorIndex(`#${i.toString(16).padStart(2, "0")}0000`);
    }
    expect(g.palette).toHaveLength(MAX_PAINT_COLORS);
    // Nothing new fits, so this lands on the closest of what is already there.
    const at = g.colorIndex("#ffffff");
    expect(g.palette).toHaveLength(MAX_PAINT_COLORS);
    expect(g.palette[at - 1]).toBe("#340000");
  });
});

describe("the brush", () => {
  it("covers three by three, centred", () => {
    const g = grid();
    g.dab(3, 2, 3, 1, null);
    const on = [...g.cells].filter((c) => c !== 0).length;
    expect(on).toBe(9);
    expect(g.at(2, 1)).toBe(1);
    expect(g.at(4, 3)).toBe(1);
  });

  it("covers two by two off the cell it is pointed at", () => {
    const g = grid();
    g.dab(3, 1, 2, 1, null);
    expect([...g.cells].filter((c) => c !== 0)).toHaveLength(4);
    expect(g.at(3, 1)).toBe(1);
    expect(g.at(4, 2)).toBe(1);
    expect(g.at(2, 1)).toBe(0);
  });

  it("covers exactly the cell it is pointed at", () => {
    const g = grid();
    g.dab(3, 1, 1, 1, null);
    expect([...g.cells].filter((c) => c !== 0)).toHaveLength(1);
    expect(g.at(3, 1)).toBe(1);
  });

  it("joins up two pointer samples rather than leaving a dotted line", () => {
    const g = grid();
    g.stroke(0, 0, 7, 0, 1, 1, null);
    expect([...g.cells].slice(0, W)).toEqual(new Array(W).fill(1));
  });

  it("stays inside the canvas", () => {
    const g = grid();
    g.dab(0, 0, 3, 1, null);
    expect([...g.cells].filter((c) => c !== 0)).toHaveLength(4);
  });
});

describe("the region a layer is held to", () => {
  it("refuses a dab that lands entirely outside it", () => {
    const g = grid();
    expect(g.dab(3, 2, 3, 1, topRow())).toBe(false);
    expect(g.painted).toBe(false);
  });

  it("takes only the part of a brush that overlaps it", () => {
    const g = grid();
    expect(g.dab(3, 1, 3, 1, topRow())).toBe(true);
    // The 3x3 straddles rows zero to two; one row of it is allowed through.
    expect([...g.cells].filter((c) => c !== 0)).toHaveLength(3);
    expect(g.at(3, 0)).toBe(1);
    expect(g.at(3, 1)).toBe(0);
  });

  it("lets a stroke through where the region opens", () => {
    const g = grid();
    g.stroke(0, 0, 7, 3, 1, 1, topRow());
    expect(g.at(0, 0)).toBe(1);
    expect(g.at(7, 3)).toBe(0);
  });

  it("holds a fill inside it", () => {
    const g = grid();
    expect(g.fill(0, 0, 1, topRow())).toBe(true);
    expect([...g.cells].slice(0, W)).toEqual(new Array(W).fill(1));
    expect([...g.cells].slice(W).every((c) => c === 0)).toBe(true);
  });

  it("refuses a fill started outside it", () => {
    const g = grid();
    expect(g.fill(0, 3, 1, topRow())).toBe(false);
    expect(g.painted).toBe(false);
  });

  it("keeps paint that a change of part put out of reach", () => {
    // Drawn while the whole canvas was open, then shown under a tighter mask.
    const g = grid();
    g.fill(0, 0, g.colorIndex("#ff0000"), null);
    const px = paintPixels(g, topRow());
    expect(px[3]).toBe(255);
    expect(px[W * 4 + 3]).toBe(0);
    // The cells are still there, so the old part brings them back.
    expect(g.painted).toBe(true);
  });
});

describe("filling", () => {
  it("stops at a different colour", () => {
    const g = grid();
    const wall = g.colorIndex("#000000");
    const paint = g.colorIndex("#ffffff");
    for (let y = 0; y < H; y += 1) g.set(4, y, wall, null);
    g.fill(0, 0, paint, null);
    expect(g.at(3, 0)).toBe(paint);
    expect(g.at(5, 0)).toBe(0);
  });

  it("erases a shape when the eraser is on", () => {
    const g = grid();
    const c = g.colorIndex("#ffffff");
    g.fill(0, 0, c, null);
    expect(g.fill(0, 0, 0, null)).toBe(true);
    expect(g.painted).toBe(false);
  });

  it("does nothing when the cell is already that colour", () => {
    const g = grid();
    expect(g.fill(0, 0, 0, null)).toBe(false);
  });
});

describe("a paint set from somewhere unchecked", () => {
  it("keeps a layer it can read", () => {
    const g = grid();
    g.set(0, 0, g.colorIndex("#abcdef"), null);
    const clean = sanitizePaintSet({ face: g.toLayer() }, W, H);
    expect(clean?.face?.p).toEqual(["#abcdef"]);
  });

  it("drops slots nobody has heard of", () => {
    const g = grid();
    g.set(0, 0, g.colorIndex("#abcdef"), null);
    const clean = sanitizePaintSet({ hat: g.toLayer(), face: g.toLayer() }, W, H);
    expect(Object.keys(clean ?? {})).toEqual(["face"]);
  });

  it("throws out colours that are not colours", () => {
    expect(sanitizePaintSet({ face: { p: ["red", "#gggggg"], d: "B" } }, W, H)).toBeUndefined();
  });

  it("survives run data that is gibberish", () => {
    const clean = sanitizePaintSet({ face: { p: ["#ff0000"], d: "!!??<>B" } }, W, H);
    expect(cellsOf(clean?.face)[0]).toBe(1);
  });

  it("refuses run data longer than a full canvas could ever need", () => {
    const clean = sanitizePaintSet({ face: { p: ["#ff0000"], d: "B".repeat(W * H * 8) } }, W, H);
    // Cut down to the canvas, not carried around at the size it arrived.
    expect(clean!.face!.d.length).toBeLessThanOrEqual(W * H * 2);
    expect(cellsOf(clean?.face).every((c) => c === 1)).toBe(true);
  });

  it("is nothing when nothing survives", () => {
    expect(sanitizePaintSet({ face: { p: [], d: "" } }, W, H)).toBeUndefined();
    expect(sanitizePaintSet("hats", W, H)).toBeUndefined();
    expect(sanitizePaintSet(null, W, H)).toBeUndefined();
  });
});

describe("knowing whether a layer is worn", () => {
  it("counts a layer with something in it", () => {
    const g = grid();
    g.set(0, 0, g.colorIndex("#ffffff"), null);
    expect(hasPaint({ eyes: g.toLayer() }, "eyes")).toBe(true);
  });

  it("does not count an empty one", () => {
    expect(hasPaint(undefined, "eyes")).toBe(false);
    expect(hasPaint({ eyes: { p: [], d: "" } }, "eyes")).toBe(false);
  });
});

describe("a whole look off the wire", () => {
  it("carries the paint through", () => {
    const g = grid();
    g.set(0, 0, g.colorIndex("#ff8800"), null);
    const look = sanitizeLook(
      { ...DEFAULT_LOOK, paint: { extras: g.toLayer() } }, W, H,
    );
    expect(look.paint?.extras?.p).toEqual(["#ff8800"]);
    expect(look.skin).toBe(DEFAULT_LOOK.skin);
  });

  it("puts the default back where a field is unreadable", () => {
    const look = sanitizeLook(
      { skin: "puce", hairStyle: "lots", shirtStyle: 2, paint: 7 }, W, H,
    );
    expect(look.skin).toBe(DEFAULT_LOOK.skin);
    expect(look.hairStyle).toBe(DEFAULT_LOOK.hairStyle);
    expect(look.shirtStyle).toBe(2);
    expect(look.paint).toBeUndefined();
  });

  it("makes a whole character out of nothing at all", () => {
    expect(sanitizeLook(undefined, W, H)).toEqual(DEFAULT_LOOK);
  });
});
