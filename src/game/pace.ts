// How fast a battle plays, kept on the machine the way the sound level is.
// The stage reads this once a frame and scales its whole clock by it, so the
// setting paces every duration, ease and walk without touching the geometry.

const KEY = "scoba-skeeple-battle-pace";

/** The paces the settings screen offers, against the clock the game runs on. */
export const PACES = { normal: 0.7, fast: 1.4 };

/** Anything outside this is a battle nobody can read or nobody can sit through. */
const MIN = 0.2;
const MAX = 4;

function stored(fallback: number): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(MIN, Math.min(MAX, n)) : fallback;
  } catch {
    return fallback;
  }
}

let pace = stored(PACES.normal);

export function stagePace(): number {
  return pace;
}

export function setStagePace(v: number): void {
  pace = Math.max(MIN, Math.min(MAX, v));
  try {
    localStorage.setItem(KEY, String(pace));
  } catch {
    // A browser that refuses storage still holds the pace for this visit.
  }
}
