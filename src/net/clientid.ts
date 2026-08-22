// A stable name for this installation of the game.
//
// It exists to tell two situations apart that look identical from the relay's
// side: the same player reconnecting after a reload or a dropped connection,
// which should take its slot back, and two different devices that both chose
// the same character, which should be told so rather than quietly fighting
// over the slot forever.
//
// Deliberately not stored in the save. A save exported from one device and
// imported on another is still two devices, and giving them the same identity
// would put the clash right back.

const KEY = "scoba-client-id";

let cached: string | null = null;

export function clientId(): string {
  if (cached) return cached;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch {
    // A blocked store just means a fresh identity each launch, which costs a
    // clear error message and nothing else.
  }
  const made = `c${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  cached = made;
  try {
    localStorage.setItem(KEY, made);
  } catch {
    // As above.
  }
  return made;
}
