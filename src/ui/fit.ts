// Keeping a hover window inside the frame.
//
// Every window in the game hangs off the thing it explains, and the things it
// explains sit anywhere: a readout at the top of the field, a word at the edge
// of a panel. Left alone a window runs off the screen and the one thing it is
// for is being read.
import { frameRect, uiZoom } from "../engine/renderer";

/**
 * How far a window stays clear of the frame. Enough to read as deliberate
 * rather than as a window that happens to end where the screen does.
 */
const EDGE = 6;

/**
 * Shifts a window until it clears all four edges. Both offsets are written as
 * custom properties rather than as `left` and `top`, so the rule that places
 * the window keeps saying where it belongs and this only says how far it had
 * to move to fit.
 */
export function fitWindow(tip: HTMLElement): void {
  tip.style.setProperty("--nudge", "0px");
  tip.style.setProperty("--lift", "0px");
  const box = tip.getBoundingClientRect();
  const edge = frameRect();
  const zoom = uiZoom();
  const across = box.right > edge.right - EDGE
    ? edge.right - EDGE - box.right
    : box.left < edge.left + EDGE ? edge.left + EDGE - box.left : 0;
  if (across !== 0) tip.style.setProperty("--nudge", `${Math.round(across / zoom)}px`);
  // Down off the top edge in preference to up off the bottom: a window opens
  // above what it explains, so the top is the edge it meets.
  const down = box.top < edge.top + EDGE
    ? edge.top + EDGE - box.top
    : box.bottom > edge.bottom - EDGE ? edge.bottom - EDGE - box.bottom : 0;
  if (down !== 0) tip.style.setProperty("--lift", `${Math.round(down / zoom)}px`);
}
