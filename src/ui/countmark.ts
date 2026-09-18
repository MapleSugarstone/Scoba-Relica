// The count in the corner of a status sigil, drawn as pixel art rather than
// set as writing.
//
// Each digit is six art pixels by nine, its uprights two pixels wide the way
// the bold writing's are, in the text colour on an ink backdrop that follows
// the digits two pixels out, on the grid the sprites are drawn on. Set as
// writing, even in a face sampled for it, a count needed a box behind it to
// read over the sigil. Three by five and then five by seven were tried first,
// and both were too small to read at a glance.
import { ART, UI_PER_UNIT } from "../engine/renderer";

/** Art pixels per interface pixel: the grid every sprite is drawn on. */
const FIELD = ART / UI_PER_UNIT;

/** Each digit, top row first, with the rounded corners the game's writing has. */
const DIGITS: Record<string, string[]> = {
  "0": [".####.", "##..##", "##..##", "##..##", "##..##", "##..##", "##..##", "##..##", ".####."],
  "1": ["..##..", ".###..", "####..", "..##..", "..##..", "..##..", "..##..", "..##..", "######"],
  "2": [".####.", "##..##", "....##", "....##", "...##.", "..##..", ".##...", "##....", "######"],
  "3": ["#####.", "....##", "....##", "....##", ".####.", "....##", "....##", "....##", "#####."],
  "4": ["...##.", "..###.", ".####.", "##.##.", "##.##.", "######", "...##.", "...##.", "...##."],
  "5": ["######", "##....", "##....", "#####.", "....##", "....##", "....##", "##..##", ".####."],
  "6": ["..###.", ".##...", "##....", "#####.", "##..##", "##..##", "##..##", "##..##", ".####."],
  "7": ["######", "....##", "....##", "...##.", "...##.", "..##..", "..##..", ".##...", ".##..."],
  "8": [".####.", "##..##", "##..##", "##..##", ".####.", "##..##", "##..##", "##..##", ".####."],
  "9": [".####.", "##..##", "##..##", "##..##", ".#####", "....##", "....##", "...##.", ".###.."],
};
const W = 6;
const H = 9;
/** How far the ink backdrop reaches out from the digits, in art pixels. */
const EDGE = 2;

/** A token's value, for filling a pixel with. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#000";
}

/** A count as a small canvas: its digits a pixel apart, outlined all round. */
export function countMark(n: number): HTMLCanvasElement {
  const text = String(Math.max(0, Math.floor(n)));
  const ink = new Set<string>();
  text.split("").forEach((d, i) => {
    const rows = DIGITS[d] ?? DIGITS["0"]!;
    rows.forEach((row, y) => {
      for (let x = 0; x < W; x++) {
        // The backdrop's width round the lot, and one pixel between each digit.
        if (row[x] === "#") ink.add(`${EDGE + i * (W + 1) + x},${EDGE + y}`);
      }
    });
  });
  const w = text.length * (W + 1) - 1 + EDGE * 2;
  const h = H + EDGE * 2;
  const cv = document.createElement("canvas");
  cv.className = "sx";
  cv.width = w;
  cv.height = h;
  cv.style.width = `${w / FIELD}px`;
  cv.style.height = `${h / FIELD}px`;
  const g = cv.getContext("2d")!;
  // The backdrop is every pixel within EDGE of a digit, so a count reads over
  // whatever colour the sigil is under it. The far corner of each reach is
  // left out, which rounds the backdrop's corners the way the game's frames are.
  g.fillStyle = token("--p-ink");
  for (const at of ink) {
    const [x, y] = at.split(",").map(Number) as [number, number];
    for (let dy = -EDGE; dy <= EDGE; dy++) {
      for (let dx = -EDGE; dx <= EDGE; dx++) {
        if (Math.abs(dx) === EDGE && Math.abs(dy) === EDGE) continue;
        g.fillRect(x + dx, y + dy, 1, 1);
      }
    }
  }
  g.fillStyle = token("--p-text");
  for (const at of ink) {
    const [x, y] = at.split(",").map(Number) as [number, number];
    g.fillRect(x, y, 1, 1);
  }
  return cv;
}
