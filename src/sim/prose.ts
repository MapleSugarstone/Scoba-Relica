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
import { MOVES, allSteps, moveTypes, type Move } from "./species";
import { FIELDS, STATUSES, isContinuous, powerCategory, type Basis, type DamageCategory, type Step, type StatusEffect } from "./status";
import { describeField, describeStatus, perLevel } from "./describe";
import { MAX_LEVEL } from "./scoba";
import { STAT_LABELS, type ElementType, type Stats } from "./types";
import { hitCategory } from "./script/read";

/**
 * What a token stands for. There is nothing here for what a move costs or what
 * element it is: both are already shown beside its name wherever it is read,
 * and a sentence that says them again is a sentence saying it twice.
 */
export type Token =
  /** The move's own hit, or a mark's, where one is named. `nth` counts from 1 in cast order. */
  | { of: "damage"; id?: string; nth?: number }
  /** The move's own healing, or a mark's. `nth` counts from 1 in cast order. */
  | { of: "heal"; id?: string; nth?: number }
  /** What a mark's power moves a stat by, by status id. */
  | { of: "power"; id: string }
  /** The move's nth scaled number of any kind, counting from 1 in cast order. */
  | { of: "scaling"; nth: number }
  /** A mark it leaves, by status id. */
  | { of: "status"; id: string };

/**
 * One line of the arithmetic behind a number. Every window that shows working
 * is built from these, so a mark's sum and a move's sum are the same rows in
 * the same order with the same colours.
 *
 * A line with an empty `value` is a sentence rather than a figure, and is given
 * the whole width of the window to wrap into.
 */
export interface WorkLine {
  label: string;
  value: string;
  /** Colours the value as an element rather than as plain text. */
  element?: ElementType;
  /** Colours it as better or worse for whoever is reading. */
  tone?: "good" | "bad";
  /** Takes the colour its kind of damage has everywhere else in the game. */
  dmg?: DamageCategory;
}

export type Part =
  | { kind: "text"; text: string }
  /**
   * A highlighted word, what hovering it should say, and which of the damage
   * colours it takes where it is a number being dealt.
   */
  | {
    kind: "token";
    label: string;
    detail: string;
    tone?: "physical" | "magic" | "true";
    /** Where the number comes from and what happens to it on the way out. */
    work?: WorkLine[];
  };

/**
 * What a written line is being read against. The stats are the caster's, and
 * where they are in hand a damage token shows the number it would actually
 * deal rather than the share it is of a stat.
 */
export interface ProseFor {
  move?: Move | null;
  stats?: Stats;
  level?: number;
  /**
   * The caster's own elements. A hit lands for half again where the move
   * shares one, so a window that knows them can say whether it applies here
   * rather than only that it exists.
   */
  types?: ElementType[];
}

/** Everything a written line may put in brackets, for the editor to list. */
export const TOKENS = [
  { form: "[damage]", says: "what the move hits for, with the scaling on hover" },
  { form: "[damage:2]", says: "the move's second hit or payout, in the order the cast runs them" },
  { form: "[damage:id]", says: "what a mark's damage deals" },
  { form: "[heal]", says: "what the move heals for" },
  { form: "[heal:2]", says: "what the move's second heal restores" },
  { form: "[heal:id]", says: "what a mark's heal restores" },
  { form: "[heal:id:2]", says: "what a mark's second heal restores" },
  { form: "[power:id]", says: "what a mark's power takes from or adds to a stat" },
  { form: "[scaling:2]", says: "the move's second scaled number: hits, heals, payouts, the marks it leaves and the marks those leave, in the order the cast runs them" },
  { form: "[status:id]", says: "a mark, named after the mark" },
  { form: "[status:id|word]", says: "the same mark, written as your own word" },
];

const pct = (n: number): string => `${Math.round(n * 100)}%`;


/** Reads one bracket's contents, or null where it names nothing. */
export function readToken(inside: string): { token: Token; label?: string } | null {
  const [head = "", shown] = inside.split("|", 2);
  const [rawOf = "", rawId = "", rawNth = ""] = head.split(":", 3);
  const of = rawOf.trim();
  const id = rawId.trim();
  const label = shown?.trim();
  if (of === "damage" || of === "heal") {
    // "[heal:2]" is the move's second heal, and "[heal:add:2]" a mark's second.
    const nth = rawNth.trim();
    const which = /^[1-9]\d*$/.test(id)
      ? { nth: Number(id) }
      : id ? { id, ...(/^[1-9]\d*$/.test(nth) ? { nth: Number(nth) } : {}) } : {};
    return { token: { of, ...which }, ...(label ? { label } : {}) };
  }
  if (of === "power" && id !== "") {
    return { token: { of: "power", id }, ...(label ? { label } : {}) };
  }
  if (of === "scaling" && (id === "" || /^[1-9]\d*$/.test(id))) {
    return { token: { of: "scaling", nth: id === "" ? 1 : Number(id) }, ...(label ? { label } : {}) };
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
  if (token.of === "power") return powerToken(token.id, at);
  // A token naming a mark is read off that mark rather than off the move, so
  // one line can say what the hit does and what the mark it leaves does.
  if (token.of !== "scaling" && token.id !== undefined) return markToken(token.of, token.id, at, token.nth ?? 1);
  const move = at.move ?? null;
  if (!move) return { kind: "token", label: "?", detail: "Nothing to read this off." };
  if (token.of === "scaling") {
    const found = scalingsOf(move)[token.nth - 1];
    if (!found) return { kind: "token", label: "?", detail: `${move.name} has no scaling number ${token.nth}.` };
    return found(at);
  }
  const nth = token.nth ?? 1;
  const steps = allSteps(move.cast);
  if (token.of === "heal") {
    const mend = steps.filter((s): s is HealStep => s.kind === "heal")[nth - 1];
    if (!mend) {
      const detail = nth === 1 ? `${move.name} heals nothing.` : `${move.name} has no heal number ${nth}.`;
      return { kind: "token", label: "?", detail };
    }
    return healToken(mend, at);
  }
  const hit = steps.filter((s): s is HitStep | DealStep => s.kind === "hit" || s.kind === "deal-card")[nth - 1];
  if (!hit) {
    const detail = nth === 1 ? `${move.name} hits nothing.` : `${move.name} has no damage number ${nth}.`;
    return { kind: "token", label: "?", detail };
  }
  if (hit.kind === "deal-card") return payoutToken(hit, at);
  return hitToken(hit, at);
}

type TokenOf = (at: ProseFor) => Part & { kind: "token" };

/**
 * Every scaled number a move's cast produces, in the order the cast runs them:
 * each hit, heal and card payout, and for each mark it leaves, that mark's
 * power, then what it hits for, then what it heals for, then the numbers of any
 * mark it leaves in turn.
 */
function scalingsOf(move: Move): TokenOf[] {
  const out: TokenOf[] = [];
  // Each mark counts once, so one that leaves itself again cannot run forever.
  const counted = new Set<string>();
  const mark = (id: string): void => {
    const def = STATUSES[id];
    if (!def || counted.has(id)) return;
    counted.add(id);
    if (def.power) out.push((at) => powerToken(id, at));
    if (def.effects.some((e) => e.kind === "damage")) out.push((at) => markToken("damage", id, at));
    if (def.effects.some((e) => e.kind === "heal")) out.push((at) => markToken("heal", id, at));
    const steps = def.effects.filter((e): e is Step => !isContinuous(e.kind));
    for (const s of allSteps(steps)) if (s.kind === "inflict") mark(s.status);
  };
  for (const s of allSteps(move.cast)) {
    if (s.kind === "hit") out.push((at) => hitToken(s, at));
    else if (s.kind === "heal") out.push((at) => healToken(s, at));
    else if (s.kind === "deal-card") out.push((at) => payoutToken(s, at));
    else if (s.kind === "inflict") mark(s.status);
  }
  return out;
}

function hitToken(hit: HitStep, at: ProseFor): Part & { kind: "token" } {
  const move = at.move;
  if (!move) return { kind: "token", label: "?", detail: "Nothing to read this off." };
  return {
    kind: "token",
    label: damageLabel(hit, at, move),
    detail: damageDetail(hit),
    tone: hitCategory(hit),
    work: damageWork(hit, at),
  };
}

/**
 * Where a hit's number comes from and what happens to it on the way out: the
 * stats it is read off, the element it lands as, and the half again a caster
 * gets for sharing one of the move's elements.
 *
 * The type chart is left out. What a move is worth is a property of the move;
 * what it comes to against one particular Scoba belongs beside that Scoba.
 */
function damageWork(hit: HitStep, at: ProseFor): WorkLine[] {
  const move = at.move;
  if (!move) return [];
  const out: WorkLine[] = [];
  if (hit.perLevel !== undefined) {
    out.push({ label: `${hit.perLevel} per level`, value: at.level === undefined ? "" : `level ${at.level}` });
  } else {
    for (const s of hit.scaling) {
      // The stat, then the share taken of it, the same two rows a mark shows.
      out.push({
        label: `Source's ${STAT_LABELS[s.stat]}`,
        value: at.stats ? String(at.stats[s.stat]) : "",
      });
      out.push({
        label: pct(s.scale),
        value: at.stats ? String(Math.floor(at.stats[s.stat] * s.scale)) : "",
      });
    }
    if (hit.flatAtCeiling !== undefined) {
      out.push({ label: perLevel(hit.flatAtCeiling), value: at.level === undefined ? "" : `level ${at.level}` });
    }
  }
  const types = hitElements(hit, move);
  for (const t of types) {
    out.push({ label: "Type", value: `${cap(t)} ${hitCategory(hit)}`, element: t });
  }
  // Said either way: a reader comparing two casters wants to know the rule is
  // there and that this one does not have it, rather than seeing nothing.
  if (at.types) {
    const match = types.find((t) => at.types!.includes(t));
    out.push({
      label: "Elemental Synergy",
      value: match ? "1.5x" : "1x",
      ...(match ? { element: match } : {}),
    });
  } else if (types.length > 0) {
    out.push({ label: `Elemental Synergy, for ${types.map(cap).join(" or ")}`, value: "1.5x" });
  }
  // As far as the arithmetic goes without a target. The chart and the armor are
  // read off whoever is being hit, and a move is read here before anyone has
  // been aimed at, so the total is what the caster brings to it.
  const base = baseOf(hit, at);
  if (base !== null) {
    out.push({
      label: "Total",
      value: String(Math.max(1, Math.floor(base * synergyFor(types, at)))),
      dmg: hitCategory(hit),
    });
  }
  // What it meets on the way in, as a sentence rather than a figure: there is
  // nobody to read a figure off yet.
  out.push({ label: reducedBy(hitCategory(hit), "damage"), value: "" });
  return out;
}

/** What a hit comes to before anything is done to it, where the stats are known. */
function baseOf(hit: HitStep, at: ProseFor): number | null {
  if (hit.perLevel !== undefined) return at.level === undefined ? null : hit.perLevel * at.level;
  if (!at.stats) return null;
  let base = hit.flatAtCeiling !== undefined && at.level !== undefined
    ? (hit.flatAtCeiling * at.level) / MAX_LEVEL
    : 0;
  for (const s of hit.scaling) base += at.stats[s.stat] * s.scale;
  return base;
}

/**
 * What one hit lands as, which is the same reading the battle takes: a step
 * that names its own element lands as that alone, and one that does not takes
 * the move's, both of them where the move has two.
 */
function hitElements(hit: HitStep, move: Move): ElementType[] {
  if (hit.element) return [hit.element];
  return moveTypes(move);
}

/**
 * What a mark's power moves a stat by, read off the mark. The power is measured
 * when the mark lands, and each stat it moves takes it times that stat's own
 * multiple, so the label is the share the first stat it moves takes.
 */
function powerToken(id: string, at: ProseFor): Part & { kind: "token" } {
  const def = STATUSES[id];
  const power = def?.power;
  if (!def || !power) return { kind: "token", label: id, detail: `No power on a mark called ${id}.` };
  const moves = def.effects.filter((e): e is StatPower => e.kind === "stat-power");
  const share = Math.abs(power.frac * (moves[0]?.mult ?? 1));
  const off = power.basis === "source-str" ? "str" : power.basis === "source-mag" ? "mag" : null;
  const number = off && at.stats ? Math.floor(at.stats[off] * share) : null;
  const category = powerCategory(def);
  const work: WorkLine[] = [];
  const off2 = off;
  if (off2 && at.stats) {
    work.push({ label: `Source's ${STAT_LABELS[off2]}`, value: String(at.stats[off2]) });
    work.push({ label: pct(share), value: String(Math.floor(at.stats[off2] * share)) });
  }
  if (number !== null) work.push({ label: "Total", value: String(number), dmg: category });
  work.push({ label: reducedBy(category, "statuses"), value: "" });
  return {
    kind: "token",
    label: number === null ? `${pct(share)} ${basisShort(power.basis)}` : String(number),
    detail: `${pct(share)} of ${basisName(power.basis)}.`,
    tone: category,
    work,
  };
}

/**
 * The sentence that says what a number meets on its way in, the same for a
 * move's damage and for a mark: Defense for physical, Resistance for magical,
 * and nothing for true.
 */
function reducedBy(category: DamageCategory, what: "damage" | "statuses"): string {
  if (category === "true") return "True damage ignores target's defenses.";
  const kind = category === "physical" ? "Physical" : "Magical";
  const armor = STAT_LABELS[category === "physical" ? "def" : "res"];
  return `${kind} ${what} ${what === "damage" ? "is" : "are"} reduced by the target's ${armor}.`;
}

/**
 * What one mark's damage or heal comes to, read off the mark itself. `nth`
 * counts that kind of step through every `when` block the mark has, in the
 * order they are written.
 */
function markToken(of: "damage" | "heal", id: string, at: ProseFor, nth = 1): Part & { kind: "token" } {
  const def = STATUSES[id];
  const steps = def ? [...def.effects, ...(def.also ?? []).flatMap((b) => b.steps)] : [];
  const effect = steps.filter((e) => e.kind === of)[nth - 1];
  if (!def || !effect) {
    return { kind: "token", label: id, detail: `No ${of} on a mark called ${id}.` };
  }
  const frac = effect.kind === "damage" ? effect.damage.frac : effect.kind === "heal" ? effect.frac : 0;
  const basis = effect.kind === "damage" ? effect.damage.basis : effect.kind === "heal" ? effect.basis : "source-str";
  const flat = effect.kind === "damage" ? effect.damage.flatAtCeiling ?? 0 : 0;
  const off = basis === "source-str" ? "str" : basis === "source-mag" ? "mag" : null;
  const element = effect.kind === "damage" ? effect.damage.element : null;
  const match = element && effect.kind === "damage" && effect.damage.category !== "true"
    ? synergyFor([element], at)
    : 1;
  const number = off && at.stats
    ? Math.max(1, Math.floor(
      (at.stats[off] * frac + (at.level === undefined ? 0 : (flat * at.level) / MAX_LEVEL)) * match,
    ))
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
  const work: WorkLine[] = [];
  if (off && at.stats) {
    work.push({ label: `Source's ${STAT_LABELS[off]}`, value: String(at.stats[off]) });
    work.push({ label: pct(frac), value: String(Math.floor(at.stats[off] * frac)) });
  }
  if (element) work.push({ label: "Type", value: `${cap(element)} ${tone ?? ""}`.trim(), element });
  if (element && effect.kind === "damage" && effect.damage.category !== "true") {
    work.push({ label: "Elemental Synergy", value: match > 1 ? "1.5x" : "1x", ...(match > 1 ? { element } : {}) });
  }
  if (number !== null) {
    work.push({
      label: "Total",
      value: String(number),
      ...(effect.kind === "damage" ? { dmg: effect.damage.category } : {}),
    });
  }
  if (effect.kind === "damage") {
    work.push({ label: reducedBy(effect.damage.category, "statuses"), value: "" });
  }
  return {
    kind: "token",
    label: number === null ? shareLabel : String(number),
    detail: `${cap(share)}.`,
    ...(tone ? { tone } : {}),
    work,
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
function healToken(mend: HealStep, at: ProseFor): Part & { kind: "token" } {
  const off = mend.basis === "source-mag" ? "mag" : mend.basis === "source-str" ? "str" : null;
  const basis = off === null
    ? "the target's own maximum HP"
    : `the caster's ${STAT_LABELS[off]}`;
  const number = off && at.stats ? Math.floor(at.stats[off] * mend.frac) : null;
  return {
    kind: "token",
    label: number === null ? pct(mend.frac) : String(number),
    detail: `${pct(mend.frac)} of ${basis}.`,
  };
}

/**
 * What the hit comes to: the number itself where the caster's stats are in
 * hand, and the share of the stat where they are not. Read before the type
 * chart and before whatever is standing on the other side, so it is what the
 * move is worth rather than what it would do to one particular target.
 */
function damageLabel(hit: HitStep, at: ProseFor, move: Move): string {
  if (hit.perLevel !== undefined) {
    return at.level === undefined
      ? `${hit.perLevel} damage per level`
      : String(hit.perLevel * at.level);
  }
  // A flat share is written as what it comes to at the ceiling, and read out as
  // what each level of the caster adds.
  const flat = hit.flatAtCeiling ?? 0;
  if (!at.stats) {
    const shares = hit.scaling.map((s) => `${pct(s.scale)} ${STAT_LABELS[s.stat]}`).join(" + ");
    return `${shares}${flat ? ` + ${perLevel(flat)} damage per level` : ""}`;
  }
  let base = flat && at.level !== undefined ? (flat * at.level) / MAX_LEVEL : 0;
  for (const s of hit.scaling) base += at.stats[s.stat] * s.scale;
  return String(Math.max(1, Math.floor(base * synergyFor(hitElements(hit, move), at))));
}

/**
 * The half again a caster gets for sharing one of the elements a number lands
 * as. Folded into every number written for a particular caster, since it is a
 * property of that caster rather than of whoever it is aimed at: a number that
 * left it out read lower than the move would ever actually deal.
 */
function synergyFor(types: ElementType[], at: ProseFor): number {
  return at.types && types.some((t) => at.types!.includes(t)) ? 1.5 : 1;
}

/** The long form, for the window that opens on hovering it. */
function damageDetail(hit: HitStep): string {
  if (hit.perLevel !== undefined) {
    return `${hit.perLevel} damage per level of the caster. ${reducedBy(hitCategory(hit), "damage")}`;
  }
  const [first, ...rest] = hit.scaling;
  const also = rest.map((s) => ` and ${pct(s.scale)} of its ${STAT_LABELS[s.stat]}`).join("");
  const main = first ? `${pct(first.scale)} of the caster's ${STAT_LABELS[first.stat]}` : "Nothing";
  const flat = hit.flatAtCeiling !== undefined ? ` plus ${perLevel(hit.flatAtCeiling)} damage per level` : "";
  const each = hit.perStackOf !== undefined
    ? `, for each ${STATUSES[hit.perStackOf]?.name ?? hit.perStackOf} on the target`
    : "";
  // What it meets on the way in is the last line of the working rather than
  // part of this, so the opening line says only where the number comes from.
  return `${main}${also}${flat}${each}.`;
}

/** What a hand of exactly 21 pays out, which the battle reads off the dealer's Strength as physical damage. */
function payoutToken(deal: DealStep, at: ProseFor): Part & { kind: "token" } {
  return {
    kind: "token",
    label: at.stats
      ? String(Math.max(1, Math.floor(at.stats.str * deal.payoff)))
      : `${pct(deal.payoff)} ${STAT_LABELS.str}`,
    detail: `${pct(deal.payoff)} of the caster's ${STAT_LABELS.str}. ${reducedBy("physical", "damage")}`,
    tone: "physical",
  };
}

type HitStep = Extract<Step, { kind: "hit" }>;
type HealStep = Extract<Step, { kind: "heal" }>;
type StatPower = Extract<StatusEffect, { kind: "stat-power" }>;
type DealStep = Extract<Step, { kind: "deal-card" }>;

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
