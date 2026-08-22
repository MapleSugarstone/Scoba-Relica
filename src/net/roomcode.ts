// Room codes are read aloud between two people, so the alphabet leaves out the
// pairs that get heard wrong. Kept here rather than in the UI because the relay
// validates codes with the same rules and imports this file.

/** Characters a room code is spelled from: no O/0 or I/1 to read wrong. */
export const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const CODE_LENGTH = 6;

export function freshRoomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

/** A code is only a code if it is six of the characters we spell them from. */
export function normalizeRoomCode(raw: string): string | null {
  const up = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (up.length !== CODE_LENGTH) return null;
  return [...up].every((c) => CODE_CHARS.includes(c)) ? up : null;
}
