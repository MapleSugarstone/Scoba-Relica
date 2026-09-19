// The status sigils. Drawn art like the type badges, 27x26 with transparent
// ground, read straight out of `assets/Sigils` by lower-cased file name.
// Anywhere a status is shown rather than named, this is what says it.
//
// Which sigil a status is shown as is its `icon` line in the move script. A
// status with no icon, or an icon with nothing drawn for it, falls back to the
// placeholder, so a new status turns up as a mark it can be hovered rather
// than as a gap.
import {
  FIELDS, STATUSES, isContinuous, manaAt, shrink, statusName, type Step, type StatusDef, type StatusEffect,
} from "../sim/status";
import { describeField, describeStatus, shiftLine, shownAmount } from "../sim/describe";
import { allSteps } from "../sim/species";
import type { MarkNumber, StatusMark } from "../sim/battle";
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
  /** A status the mark lands, named here, and what its own window says. */
  status?: { id: string; desc: string };
  /** The arithmetic behind a number, in a window of its own over it. */
  work?: WorkLine[];
}

/** What a hover window says: what the mark is, and what it is doing. */
export interface SigilText {
  name: string;
  /** The line as plain text, for anywhere that cannot colour a run of it. */
  desc: string;
  /** The same line, split so a number can take its own colour and its own window. */
  said: SaidPart[];
  note: string;
}

type Boost = { name: string; mult: number };

const turns = (n: number): string => `${n} turn${n === 1 ? "" : "s"}`;

/**
 * The window over a status's sigil. The note is only what has a limit on it:
 * a status that runs until something takes it off says nothing, since "no
 * line" already reads as "no clock".
 */
export function sigilText(m: {
  id: string; name: string; stacks: number; turnsLeft: number; chargesLeft: number;
  shift?: StatusMark["shift"]; boosts?: StatusMark["boosts"];
}, numbers: MarkNumber[] = [], level?: number): SigilText {
  const def = STATUSES[m.id];
  const bits: string[] = [];
  if (m.turnsLeft > 0) bits.push(`Lasts ${turns(m.turnsLeft)}.`);
  if (m.chargesLeft > 0) bits.push(`Procs ${m.chargesLeft} time${m.chargesLeft === 1 ? "" : "s"}.`);
  if (def?.persists === false) bits.push("Removes on switch out.");
  const boosts = m.boosts ?? [];
  const worth = boosts.reduce((p, b) => p * b.mult, 1);
  const better = def?.polarity !== "bad";
  // The note already says how long is left and how many times, so the line on
  // what it does leaves both out. A heal or a hit is written as what it comes
  // to on this Scoba, marked so it can carry its working. The line is read
  // twice, as written and at what the boosts make it worth, so each other
  // number a boost moved can show by how much.
  const amount = (step: unknown): string | undefined => {
    const i = numbers.findIndex((n) => n.step === step);
    return i >= 0 ? `${OPEN}${i}${SHUT}` : undefined;
  };
  const written = { duration: false, charges: false, amount, ...(level !== undefined ? { level } : {}) };
  const boosted = def && worth !== 1 ? { ...written, statuses: { ...STATUSES, [def.id]: worthMore(def, worth) } } : written;
  // A status that only moves stats by its power says what it is moving them by
  // on this Scoba, every stack in.
  const said = def && m.shift && def.text === undefined && def.effects.every((e) => e.kind === "stat-power")
    ? shiftParts(m.shift, boosts, better)
    : valueParts(describeStatus(m.id, written), describeStatus(m.id, boosted), numbers, boosts, better);
  return {
    name: m.name,
    desc: said.map((p) => p.text).join(""),
    said: def ? linked(said, def, level) : said,
    note: bits.join(" "),
  };
}

/** One row for each boost, coloured by whether it helps whoever carries the mark. */
const boostRows = (boosts: Boost[], better: boolean): WorkLine[] =>
  boosts.map((b) => ({ label: b.name, value: times(b.mult), tone: (b.mult > 1) === better ? "good" : "bad" }));

const NUMBER = /(\d+(?:\.\d+)?%?)/;
/** Around the index of a heal or hit written in place, so it can be found again in the line. */
const OPEN = "";
const SHUT = "";
const MARKED = new RegExp(`${OPEN}(\\d+)${SHUT}`);

/**
 * The line as boosted, with each heal or hit carrying its own working and each
 * other number a boost moved carrying what it is written as, each boost, and
 * what it comes to.
 */
function valueParts(
  written: string, boosted: string, numbers: MarkNumber[], boosts: Boost[], better: boolean,
): SaidPart[] {
  const was = written.split(MARKED);
  const now = boosted.split(MARKED);
  return now.flatMap((t, i): SaidPart[] => {
    if (i % 2 === 1) {
      const n = numbers[Number(t)];
      if (!n) return [];
      return [{ text: String(n.amount), work: working(n, boosts), ...(n.kind === "damage" ? { dmg: n.category } : {}) }];
    }
    return boostedNumbers(was.length === now.length ? was[i]! : t, t, boosts, better).filter((p) => p.text !== "");
  });
}

/**
 * The line as boosted, with each number a boost moved split out and carrying
 * what it is written as, each boost, and what it comes to. A line whose words
 * changed along with its numbers is left as it reads.
 */
function boostedNumbers(written: string, boosted: string, boosts: Boost[], better: boolean): SaidPart[] {
  const was = written.split(NUMBER);
  const now = boosted.split(NUMBER);
  if (boosts.length === 0 || written === boosted || was.length !== now.length
    || now.some((t, i) => i % 2 === 0 && t !== was[i])) {
    return [{ text: boosted }];
  }
  return now.flatMap((t, i): SaidPart[] => {
    if (t === "") return [];
    if (i % 2 === 0 || t === was[i]) return [{ text: t }];
    return [{ text: t, work: [{ label: "Base", value: was[i]! }, ...boostRows(boosts, better), { label: "Total", value: t }] }];
  });
}

/** "Increases all stats by 24.", with the 24 carrying its stacks and every boost. */
function shiftParts(shift: NonNullable<StatusMark["shift"]>, boosts: Boost[], better: boolean): SaidPart[] {
  const line = shiftLine(shift.amount, shift.stats);
  const shown = shownAmount(shift.amount);
  const at = line.lastIndexOf(shown);
  const work: WorkLine[] = shift.perStack !== undefined
    ? [{ label: "Per stack", value: shownAmount(shift.perStack) }, { label: "Stacks", value: times(shift.stacks) }]
    : [{ label: `${shift.stacks} stack${shift.stacks === 1 ? "" : "s"}`, value: shownAmount(shift.written) }];
  work.push(...boostRows(boosts, better), { label: "Total", value: shown });
  return [{ text: line.slice(0, at) }, { text: shown, work }, { text: line.slice(at + shown.length) }];
}

/**
 * A status with everything it holds moved `worth` of the way, and every mana
 * it gives made `worth` times as much, the way the battle reads it. A heal or
 * a hit is left as the same step, since its number is worked out on its own.
 */
function worthMore(def: StatusDef, worth: number): StatusDef {
  const scaled = <T extends StatusEffect>(e: T): T => {
    if (e.kind === "mana") return { ...e, amount: manaAt(e.amount, worth) };
    if (e.kind === "if") return { ...e, then: e.then.map(scaled) };
    return isContinuous(e.kind) ? shrink(e, worth) as T : e;
  };
  return {
    ...def,
    effects: def.effects.map(scaled),
    ...(def.also ? { also: def.also.map((b) => ({ ...b, steps: b.steps.map(scaled) })) } : {}),
  };
}

/** Every other status a status can land, by id. */
function landed(def: StatusDef): string[] {
  const steps = [
    ...def.effects.filter((e): e is Step => !isContinuous(e.kind)),
    ...(def.also ?? []).flatMap((b) => b.steps),
  ];
  const ids = allSteps(steps).flatMap((s) => (s.kind === "inflict" ? [s.status] : []));
  return [...new Set(ids)].filter((id) => id !== def.id && STATUSES[id] !== undefined);
}

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The line with the name of each status the mark lands split out, so the
 * window can open that status's own window over it. What it says is read at
 * the level of the Scoba carrying the mark, since that is who leaves it.
 */
function linked(said: SaidPart[], def: StatusDef, level?: number): SaidPart[] {
  let out = said;
  for (const id of landed(def)) {
    const name = statusName(id);
    const status = { id, desc: describeStatus(id, level !== undefined ? { level } : {}) };
    const split = new RegExp(`\\b(${escaped(name)})\\b`);
    out = out.flatMap((p) => {
      if (p.dmg || p.status || p.work) return [p];
      return p.text.split(split).filter((t) => t !== "").map((t) => (t === name ? { text: t, status } : { text: t }));
    });
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
function working(n: MarkNumber, boosts: Boost[]): WorkLine[] {
  const out: WorkLine[] = [];
  // The stat first, then the share taken of it. A mark that measured its
  // number as it was cast says so on the stat, since that is the stat as it
  // was then: it is the share that is fixed, not some separate number.
  if (n.basis) {
    out.push({
      label: n.snapshot ? `${n.basis.label} when cast` : n.basis.label,
      value: String(n.basis.value),
    });
  }
  out.push({ label: `${Number((n.share * 100).toFixed(2))}%`, value: String(Math.round(n.raw)) });
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
  // A boost is worse for whoever carries a mark that deals damage, and better for one that heals.
  out.push(...boostRows(boosts, n.kind !== "damage"));
  out.push({
    label: "Total",
    value: String(n.amount),
    ...(n.kind === "damage" ? { dmg: n.category } : {}),
  });
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
  };
}

