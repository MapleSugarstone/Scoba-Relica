// The stat hexagon on a Scoba's card: six axes, one per stat, with the Scoba's
// own reading drawn as a shape over a target of rings.
//
// Every axis runs from nothing to a fixed mark for its stat, the same at every
// level, so a shape grows as its Scoba does and a young one's is small.
//
// The shapes are drawn cell by cell on the art's own grid rather than through
// the canvas's path filling, which antialiases every edge it draws. The rings
// are bands of fill rather than lines, so the only line in the drawing is the
// shape's own rim, at the weight of every other outline on the screen.
import { ART, UI_PER_UNIT } from "../engine/renderer";
import type { Stats, StatName } from "../sim/types";

/** Art pixels per interface pixel: the grid every sprite is drawn on. */
const FIELD = ART / UI_PER_UNIT;

/** The drawing's box, its centre and its radius, in interface px. */
const W = 200;
const H = 134;
const CX = W / 2;
const CY = H / 2;
const R = 48;
/** Room between a corner of the hexagon and the label hung off it. */
const LABEL_GAP = 4;
/** One line of 12 px writing at its natural height, which is what a label is. */
const LINE = 18;

/** The outline weight of every frame and sprite, in art pixels. */
const RIM = 3;

/** How many bands the target is cut into, from the rim inwards. */
const BANDS = 4;

/**
 * The axes clockwise from the top. Attack stats across the upper half and
 * defence across the lower, physical on the right and magical on the left, so
 * a hitter leans up and a wall leans down.
 */
const AXES: { stat: StatName; label: string }[] = [
  { stat: "hp", label: "HP" },
  { stat: "str", label: "STR" },
  { stat: "def", label: "DEF" },
  { stat: "spd", label: "SPD" },
  { stat: "res", label: "RES" },
  { stat: "mag", label: "MGK" },
];

/** Where axis `i` points, as a unit vector: the first straight up. */
function direction(i: number): { x: number; y: number } {
  const a = -Math.PI / 2 + (i * Math.PI) / 3;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/**
 * Where each axis ends: what a strong Scoba reaches in that stat, not the most
 * it can. HP is the stat, not the pool a fight shows, which is 2.8 times it.
 */
const RIMS: Stats = { hp: 400, str: 350, def: 350, res: 350, mag: 350, spd: 200 };

type Rgb = [number, number, number];

/** Any CSS colour, tokens included, as the three channels a pixel is written in. */
function rgbOf(css: string): Rgb {
  const probe = document.createElement("span");
  probe.style.color = css;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const m = /(\d+)[, ]+(\d+)[, ]+(\d+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [0, 1, 2].map((i) => Math.round(a[i]! * (1 - t) + b[i]! * t)) as Rgb;

type Pt = { x: number; y: number };

/** Whether a point is inside a polygon, by counting the edges a ray crosses. */
function inside(poly: Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** How far a point is from the nearest edge of a polygon. */
function toEdge(poly: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!, b = poly[i]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len));
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
  }
  return best;
}

/** A hexagon about the centre with each corner at its own share of the radius, in art px. */
function hexagon(shares: number[]): Pt[] {
  return shares.map((share, i) => {
    const d = direction(i);
    return { x: (CX + d.x * R * share) * FIELD, y: (CY + d.y * R * share) * FIELD };
  });
}

/** The hexagon for one Scoba's stats, drawn in the colour of `color`. */
export function statHex(stats: Stats, color: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "bxHex";
  // The drawing and its labels share one box of their own, so a label is
  // placed against the drawing rather than against the frame's padding.
  const art = document.createElement("div");
  art.className = "bxHexArt";
  art.style.width = `${W}px`;
  art.style.height = `${H}px`;
  box.appendChild(art);

  const cv = document.createElement("canvas");
  cv.width = W * FIELD;
  cv.height = H * FIELD;
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  art.appendChild(cv);

  const bandA = rgbOf("var(--p-quiet)");
  const bandB = rgbOf("var(--p-ground)");
  const edge = rgbOf(color);
  const body = mix(edge, rgbOf("var(--p-ink)"), 0.45);

  const rings = Array.from({ length: BANDS }, (_, k) => hexagon(AXES.map(() => 1 - k / BANDS)));
  // Past the mark, a stat sits on the rim rather than off the drawing.
  const shape = hexagon(AXES.map(({ stat }) => Math.max(0, Math.min(1, stats[stat] / RIMS[stat]))));

  const g = cv.getContext("2d")!;
  const img = g.createImageData(cv.width, cv.height);
  const px = img.data;
  const put = (at: number, c: Rgb): void => {
    px[at] = c[0]; px[at + 1] = c[1]; px[at + 2] = c[2]; px[at + 3] = 255;
  };
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const sx = x + 0.5, sy = y + 0.5;
      const at = (y * cv.width + x) * 4;
      if (inside(shape, sx, sy)) {
        put(at, toEdge(shape, sx, sy) < RIM ? edge : body);
        continue;
      }
      // The innermost ring this cell is in sets its band.
      for (let k = BANDS - 1; k >= 0; k--) {
        if (inside(rings[k]!, sx, sy)) {
          put(at, k % 2 === 0 ? bandA : bandB);
          break;
        }
      }
    }
  }
  g.putImageData(img, 0, 0);

  // Labels are writing, so they are set as writing rather than drawn, and
  // every one sits on a whole pixel.
  AXES.forEach(({ stat, label }, i) => {
    const d = direction(i);
    const lab = document.createElement("span");
    lab.className = "bxHexLab";
    const name = document.createElement("span");
    name.className = "bxHexStat";
    name.textContent = label;
    lab.append(name, ` ${stats[stat]}`);
    const vx = CX + d.x * (R + LABEL_GAP);
    const vy = CY + d.y * (R + LABEL_GAP);
    if (Math.abs(d.x) < 0.01) {
      // Top and bottom: centred across the box, above or below the corner.
      lab.style.left = "0";
      lab.style.right = "0";
      lab.style.textAlign = "center";
      lab.style.top = `${Math.round(d.y < 0 ? vy - LINE : vy)}px`;
    } else {
      lab.style.top = `${Math.round(vy - LINE / 2)}px`;
      if (d.x > 0) lab.style.left = `${Math.round(vx)}px`;
      else {
        lab.style.right = `${Math.round(W - vx)}px`;
        lab.style.textAlign = "right";
      }
    }
    art.appendChild(lab);
  });
  return box;
}
