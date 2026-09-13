// Written text with the numbers left out of it.
//
// A written line says what a move does in plain language and marks the places
// where a number or a mark belongs. The reader sees a short highlighted word
// and gets the scaling by hovering it, so the sentence stays a sentence and the
// arithmetic stays out of the way of reading it.
//
//   A Moon and Sugar attack that hits the whole line. Deals [damage], and
//   leaves them [status:cold|slowed].
//
// A token nobody recognises is left exactly as it was typed, brackets and all,
// so a stray bracket shows up as a stray bracket rather than swallowing the
// rest of the sentence.
import { MOVES, firstStep, type Move } from "./species";
import { FIELDS, STATUSES, type Basis, type Step } from "./status";
import { describeField, describeStatus, perLevel } from "./describe";
import { MAX_LEVEL } from "./scoba";
import { STAT_LABELS, type Stats } from "./types";
import { hitCategory } from "./script/read";

/**
 * What a token stands for. There is nothing here for what a move costs or what
 * element it is: both are already shown beside its name wherever it is read,
 * and a sentence that says them again is a sentence saying it twice.
 */
export type Token =
  /** The move's own hit, or a mark's, where one is named. */
  | { of: "damage"; id?: string }
  /** The move's own healing, or a mark's. */
  | { of: "heal"; id?: string }
  /** A mark it leaves, by status id. */
  | { of: "status"; id: string };

export type Part =
  | { kind: "text"; text: string }
  /**
   * A highlighted word, what hovering it should say, and which of the damage
   * colours it takes where it is a number being dealt.
   */
  | { kind: "token"; label: string; detail: string; tone?: "physical" | "magic" | "true" };

/**
 * What a written line is being read against. The stats are the caster's, and
 * where they are in hand a damage token shows the number it would actually
 * deal rather than the share it is of a stat.
 */
export interface ProseFor {
  move?: Move | null;
  stats?: Stats;
  level?: number;
}

/** Everything a written line may put in brackets, for the editor to list. */
export const TOKENS = [
  { form: "[damage]", says: "what the move hits for, with the scaling on hover" },
  { form: "[damage:id]", says: "what a mark hits for each time it bites" },
  { form: "[heal]", says: "what the move heals for" },
  { form: "[heal:id]", says: "what a mark heals for each turn" },
  { form: "[status:id]", says: "a mark, named after the mark" },
  { form: "[status:id|word]", says: "the same mark, written as your own word" },
];

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Reads one bracket's contents, or null where it names nothing. */
export function readToken(inside: string): { token: Token; label?: string } | null {
  const [head = "", shown] = inside.split("|", 2);
  const [rawOf = "", rawId = ""] = head.split(":", 2);
  const of = rawOf.trim();
  const id = rawId.trim();
  const label = shown?.trim();
  if (of === "damage" || of === "heal") {
    return { token: { of, ...(id ? { id } : {}) }, ...(label ? { label } : {}) };
  }
  if (of === "status" && id !== "") {
    return { token: { of: "status", id }, ...(label ? { label } : {}) };
  }
  return null;
}

/** The word shown for a token, and what hovering it says. */
export function resolveToken(token: Token, at: ProseFor): Part & { kind: "token" } {
  if (token.of === "status") {
    const def = STATUSES[token.id];
    if (def) {
      return { kind: "token", label: def.name, detail: describeStatus(token.id) };
    }
    // A field is laid over a side rather than hung on a Scoba, but it is named
    // in a sentence the same way and reads the same way to a player.
    const field = FIELDS[token.id];
    if (field) {
      return { kind: "token", label: field.name, detail: describeField(token.id) };
    }
    return { kind: "token", label: token.id, detail: `No mark called ${token.id}.` };
  }
  // A token naming a mark is read off that mark rather than off the move, so
  // one line can say what the hit does and what the mark it leaves does.
  if (token.id !== undefined) return markToken(token.of, token.id, at);
  const move = at.move ?? null;
  if (!move) return { kind: "token", label: "?", detail: "Nothing to read this off." };
  if (token.of === "heal") {
    const mend = firstStep(move, "heal");
    if (!mend) return { kind: "token", label: "?", detail: `${move.name} heals nothing.` };
    return healToken(mend, at);
  }
  const hit = firstStep(move, "hit");
  if (!hit) return { kind: "token", label: "?", detail: `${move.name} hits nothing.` };
  return {
    kind: "token",
    label: damageLabel(hit, at),
    detail: damageDetail(hit),
    tone: hit.perLevel !== undefined ? "true" : hitCategory(hit),
  };
}

/** What one mark does each time it bites, read off the mark itself. */
function markToken(of: "damage" | "heal", id: string, at: ProseFor): Part & { kind: "token" } {
  const def = STATUSES[id];
  const effect = def?.effects.find((e) => e.kind === of);
  if (!def || !effect) {
    return { kind: "token", label: id, detail: `No ${of} on a mark called ${id}.` };
  }
  const frac = effect.kind === "damage" ? effect.damage.frac : effect.kind === "heal" ? effect.frac : 0;
  const basis = effect.kind === "damage" ? effect.damage.basis : effect.kind === "heal" ? effect.basis : "source-str";
  const flat = effect.kind === "damage" ? effect.damage.flatAtCeiling ?? 0 : 0;
  const off = basis === "source-str" ? "str" : basis === "source-mag" ? "mag" : null;
  const number = off && at.stats
    ? Math.floor(at.stats[off] * frac + (at.level === undefined ? 0 : (flat * at.level) / MAX_LEVEL))
    : null;
  // A flat amount is written in the script as what it comes to at the level
  // ceiling, and read out as what each level of the caster adds.
  const share = `${pct(frac)} of ${basisName(basis)}${flat ? ` plus ${perLevel(flat)} damage per level` : ""}`;
  const tone = effect.kind === "damage"
    ? effect.damage.category === "physical" ? "physical" : effect.damage.category === "magic" ? "magic" : "true"
    : undefined;
  // With no caster to read, the label says what it is a share of, the same way
  // a move's own token does.
  const shareLabel = `${pct(frac)} ${basisShort(basis)}${flat ? ` + ${perLevel(flat)} damage per level` : ""}`;
  return {
    kind: "token",
    label: number === null ? shareLabel : String(number),
    detail: of === "damage"
      ? `${cap(share)}, every time ${def.name} bites.`
      : `${cap(share)}, every turn ${def.name} stands.`,
    ...(tone ? { tone } : {}),
  };
}

/** What a basis is, as short as it will go, for a label. */
function basisShort(basis: Basis): string {
  switch (basis) {
    case "source-str": case "holder-str": return STAT_LABELS.str;
    case "source-mag": case "holder-mag": return STAT_LABELS.mag;
    case "source-max-hp": case "holder-max-hp": return "max HP";
    case "holder-hp": return "HP";
  }
}

/** What a basis is, in words. */
function basisName(basis: Basis): string {
  switch (basis) {
    case "source-str": return "the caster's Strength";
    case "source-mag": return "the caster's Magic";
    case "source-max-hp": return "the caster's maximum HP";
    case "holder-str": return "its own Strength";
    case "holder-mag": return "its own Magic";
    case "holder-max-hp": return "its own maximum HP";
    case "holder-hp": return "the health it has left";
  }
}

/** What a heal comes to, and what it is a share of. */
function healToken(mend: Extract<Step, { kind: "heal" }>, at: ProseFor): Part & { kind: "token" } {
  const off = mend.basis === "source-mag" ? "mag" : mend.basis === "source-str" ? "str" : null;
  const basis = off === null
    ? "the target's own maximum HP"
    : `the caster's ${STAT_LABELS[off]}`;
  const number = off && at.stats ? Math.floor(at.stats[off] * mend.frac) : null;
  return {
    kind: "token",
    label: number === null ? pct(mend.frac) : String(number),
    detail: `Heals ${pct(mend.frac)} of ${basis}.`,
  };
}

/**
 * What the hit comes to: the number itself where the caster's stats are in
 * hand, and the share of the stat where they are not. Read before the type
 * chart and before whatever is standing on the other side, so it is what the
 * move is worth rather than what it would do to one particular target.
 */
function damageLabel(hit: HitStep, at: ProseFor): string {
  if (hit.perLevel !== undefined) {
    return at.level === undefined
      ? `${hit.perLevel} damage per level`
      : String(hit.perLevel * at.level);
  }
  if (!at.stats) {
    return hit.scaling.map((s) => `${pct(s.scale)} ${STAT_LABELS[s.stat]}`).join(" + ");
  }
  let base = 0;
  for (const s of hit.scaling) base += at.stats[s.stat] * s.scale;
  return String(Math.floor(base));
}

/** The long form, for the window that opens on hovering it. */
function damageDetail(hit: HitStep): string {
  if (hit.perLevel !== undefined) {
    return `${hit.perLevel} damage per level of the caster. Flat damage ignores Defense,`
      + " Resistance and the type chart alike.";
  }
  const [first, ...rest] = hit.scaling;
  const category = hitCategory(hit);
  const armor = category === "physical" ? "def" : "res";
  const also = rest.map((s) => ` and ${pct(s.scale)} of its ${STAT_LABELS[s.stat]}`).join("");
  const main = first ? `${pct(first.scale)} of the caster's ${STAT_LABELS[first.stat]}` : "Nothing";
  return `${main}${also}.`
    + ` ${cap(category === "physical" ? "physical" : "magical")} damage is reduced by the target's ${STAT_LABELS[armor]}.`;
}

type HitStep = Extract<Step, { kind: "hit" }>;

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Splits a written line into what to print and what to highlight. Text with no
 * brackets in it comes back as one piece, which is every line nobody has
 * written a token into.
 */
export function parseProse(template: string, at: ProseFor): Part[] {
  const out: Part[] = [];
  // Where the text still waiting to be printed starts, and where to look for
  // the next bracket. They part company over a bracket that names nothing: the
  // search moves past it and the text does not, so it stays in the sentence.
  let from = 0;
  let scan = 0;
  const push = (text: string): void => {
    if (text !== "") out.push({ kind: "text", text });
  };
  for (;;) {
    const open = template.indexOf("[", scan);
    if (open < 0) break;
    const close = template.indexOf("]", open);
    if (close < 0) break;
    const read = readToken(template.slice(open + 1, close));
    if (!read) {
      scan = open + 1;
      continue;
    }
    push(template.slice(from, open));
    const part = resolveToken(read.token, at);
    out.push(read.label ? { ...part, label: read.label } : part);
    from = close + 1;
    scan = from;
  }
  push(template.slice(from));
  return out;
}

/** The same line as one string, for anywhere that cannot show a hover window. */
export function flattenProse(template: string, at: ProseFor): string {
  return parseProse(template, at).map((p) => (p.kind === "text" ? p.text : p.label)).join("");
}

/** The move a written line is about, where it is about one. */
export function moveOf(id: string): Move | null {
  return MOVES[id] ?? null;
}
