// Whether the frame is held to whole pixel steps, kept on the machine the way
// the sound level is.
//
// The frame is drawn at some number of device pixels per art pixel. A whole
// number puts every art pixel, every panel edge and every letter on the device
// grid. Anything else, and the browser resamples all three: the art goes soft,
// and text, which is the finest thing on the screen, goes soft first.
//
// The cost is the window it cannot fill. A whole step only grows in whole
// multiples, so a window half a step too large is a window with a border round
// the game.

const KEY = "scoba-skeeple-crisp";

function stored(fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

let crisp = stored(true);

/** Whether to take the whole step and leave the rest of the window empty. */
export function crispPixels(): boolean {
  return crisp;
}

export function setCrispPixels(on: boolean): void {
  crisp = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // A browser that refuses storage still holds the choice for this visit.
  }
}
