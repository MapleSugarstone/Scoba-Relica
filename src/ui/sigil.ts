// The status sigils. Drawn art like the type badges, 27x26 with transparent
// ground, read straight out of `assets/Sigils` by lower-cased file name.
// Anywhere a status is shown rather than named, this is what says it.
//
// Which sigil a status is shown as is its `icon` line in the move script. A
// status with no icon, or an icon with nothing drawn for it, falls back to the
// placeholder, so a new status turns up as a mark it can be hovered rather
// than as a gap.
import { FIELDS, STATUSES } from "../sim/status";
import { describeField, describeStatus } from "../sim/describe";

const FILES = import.meta.glob("../../assets/Sigils/*.png", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

const URLS = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [
    path.split("/").pop()!.replace(/\.png$/i, "").toLowerCase(),
    url,
  ]),
) as Record<string, string | undefined>;

/**
 * The sigil for a status or a field, by id. Statuses and fields share the one
 * row under a card, and what tells the two apart is the window over them.
 */
export function sigilUrl(id: string): string | null {
  const icon = (STATUSES[id]?.icon ?? FIELDS[id]?.icon)?.toLowerCase();
  return (icon ? URLS[icon] : undefined) ?? URLS["placeholder"] ?? null;
}

/** What a hover window says: what the mark is, and what it is doing. */
export interface SigilText {
  name: string;
  desc: string;
  note: string;
}

const turns = (n: number): string => `${n} turn${n === 1 ? "" : "s"}`;

/**
 * The window over a status's sigil. The note is only what has a limit on it:
 * a status that runs until something takes it off says nothing, since "no
 * line" already reads as "no clock".
 */
export function sigilText(m: {
  id: string; name: string; stacks: number; turnsLeft: number; chargesLeft: number;
}): SigilText {
  const def = STATUSES[m.id];
  const bits: string[] = [];
  if (m.turnsLeft > 0) bits.push(`Lasts ${turns(m.turnsLeft)}.`);
  if (m.chargesLeft > 0) bits.push(`Procs ${m.chargesLeft} time${m.chargesLeft === 1 ? "" : "s"}.`);
  if (def?.persists === false) bits.push("Removes on switch out.");
  // The note already says how long is left and how many times, so the line on
  // what it does leaves both out.
  return { name: m.name, desc: describeStatus(m.id, { duration: false, charges: false }), note: bits.join(" ") };
}

/**
 * The window over a field's sigil. Named as a field rather than by itself,
 * since it sits in the same row as the marks a Scoba is carrying and is the
 * one thing there that is not on the Scoba at all.
 */
export function fieldSigilText(f: { id: string; turnsLeft: number }): SigilText {
  const def = FIELDS[f.id];
  return {
    name: `Field: ${def?.name ?? f.id}`,
    desc: describeField(f.id),
    note: f.turnsLeft > 0 ? `${turns(f.turnsLeft)} remaining` : "",
  };
}

