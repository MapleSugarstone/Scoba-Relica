// The status sigils. Drawn art like the type badges, 27x26 with transparent
// ground, read straight out of `assets/Sigils` by lower-cased file name.
// Anywhere a status is shown rather than named, this is what says it.
//
// Which sigil a status is shown as is its `icon` line in the move script. A
// status with no icon, or an icon with nothing drawn for it, falls back to the
// placeholder, so a new status turns up as a mark it can be hovered rather
// than as a gap.
import { FIELDS, STATUSES, type StatusDef } from "../sim/status";
import { describeField, describeStatus, statusHalves, whileTrigger } from "../sim/describe";
import type { MarkNumber } from "../sim/battle";
import type { DamageCategory } from "../sim/status";
import type { WorkLine } from "../sim/prose";

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

/**
 * A run of the line a window opens with. A number being dealt is split out so
 * it can take its damage colour, the same colour it has wherever else the game
 * writes one.
 */
export interface SaidPart {
  text: string;
  dmg?: DamageCategory;
}

/** What a hover window says: what the mark is, and what it is doing. */
export interface SigilText {
  name: string;
  /** The line as plain text, for anywhere that cannot colour a run of it. */
  desc: string;
  /** The same line, split so a number being dealt can take its own colour. */
  said: SaidPart[];
  note: string;
  /**
   * The working behind whatever number `desc` states, shown when the window is
   * opened rather than on the line itself. Empty where the mark has no number.
   */
  working: WorkLine[];
}

const turns = (n: number): string => `${n} turn${n === 1 ? "" : "s"}`;

/**
 * The window over a status's sigil. The note is only what has a limit on it:
 * a status that runs until something takes it off says nothing, since "no
 * line" already reads as "no clock".
 */
export function sigilText(m: {
  id: string; name: string; stacks: number; turnsLeft: number; chargesLeft: number;
}, numbers: MarkNumber[] = []): SigilText {
  const def = STATUSES[m.id];
  const bits: string[] = [];
  if (m.turnsLeft > 0) bits.push(`Lasts ${turns(m.turnsLeft)}.`);
  if (m.chargesLeft > 0) bits.push(`Procs ${m.chargesLeft} time${m.chargesLeft === 1 ? "" : "s"}.`);
  if (def?.persists === false) bits.push("Removes on switch out.");
  const opts = { duration: false, charges: false };
  // The note already says how long is left and how many times, so the line on
  // what it does leaves both out.
  const said = numbers.length > 0 && def
    ? exactly(def, numbers, opts)
    : [{ text: describeStatus(m.id, opts) }];
  return {
    name: m.name,
    desc: said.map((p) => p.text).join(""),
    said,
    note: bits.join(" "),
    working: working(numbers),
  };
}

/**
 * What the mark is doing, in the numbers it is actually doing it in. The half
 * that is true while it is carried is written the way it always is; the half
 * that goes off says what it comes to on this Scoba rather than what share of
 * what it is, since the share is the working rather than the effect.
 */
function exactly(
  def: StatusDef, numbers: MarkNumber[], opts: { duration: boolean; charges: boolean },
): SaidPart[] {
  const { standing, fires } = statusHalves(def.id, opts);
  const at = whileTrigger(def.trigger);
  if (numbers.length === 0) return [{ text: standing || fires }];
  const out: SaidPart[] = [];
  if (standing !== "") out.push({ text: `${standing} ` });
  for (const [i, n] of numbers.entries()) {
    if (i > 0) out.push({ text: " " });
    out.push({ text: n.kind === "damage" ? "Takes " : "Heals " });
    out.push({ text: String(n.amount), ...(n.kind === "damage" ? { dmg: n.category } : {}) });
    out.push({ text: n.kind === "damage" ? ` damage ${at}.` : ` ${at}.` });
  }
  return out;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const times = (n: number): string => `${Number(n.toFixed(2))}x`;

/**
 * Every step between where a mark's number starts and what its holder actually
 * loses, in the order the battle applies them. A multiple that did not apply is
 * still listed at 1x: what a reader wants to know is whether it was in play,
 * and a missing line reads as a rule that does not exist.
 */
function working(numbers: MarkNumber[]): WorkLine[] {
  const out: WorkLine[] = [];
  for (const n of numbers) {
    // The stat first, then the share taken of it. A mark that measured its
    // number as it was cast says so on the stat, since that is the stat as it
    // was then: it is the share that is fixed, not some separate number.
    if (n.basis) {
      out.push({
        label: n.snapshot ? `${n.basis.label} when cast` : n.basis.label,
        value: String(n.basis.value),
      });
    }
    out.push({ label: `${Math.round(n.share * 100)}%`, value: String(Math.round(n.raw)) });
    if (n.element) {
      out.push({ label: "Type", value: `${cap(n.element)} ${n.category}`, element: n.element });
    }
    if (n.kind === "damage" && n.category !== "true") {
      out.push({
        label: "Elemental Synergy",
        value: times(n.synergy),
        ...(n.casterMatch ? { element: n.casterMatch } : {}),
        ...(n.synergy > 1 ? { tone: "bad" as const } : {}),
      });
      out.push({
        label: "Elemental Weakness Modifier",
        value: times(n.elemental),
        ...(n.elemental === 1 ? {} : { tone: n.elemental > 1 ? "bad" as const : "good" as const }),
      });
    }
    if (n.armor) {
      out.push({ label: `${n.armor.label} ${n.armor.value}`, value: times(n.armor.mult), tone: "good" });
    }
    if (n.category === "true" && n.kind === "damage") {
      out.push({ label: "True damage, no defenses apply", value: "" });
    }
    out.push({
      label: "Total",
      value: String(n.amount),
      ...(n.kind === "damage" ? { dmg: n.category } : {}),
    });
  }
  return out;
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
    said: [{ text: describeField(f.id) }],
    working: [],
  };
}

