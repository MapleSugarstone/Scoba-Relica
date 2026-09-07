// How a move, a status, a passive or a field is described, in one voice.
//
// Every line of effect text in the game comes out of here rather than being
// written by hand, so the rule in claude-notes/ability-text.md holds
// everywhere: verb first, numbers as percentages, one sentence per step,
// triggers up front, the cost in a trailer, and nothing described by its name
// where it can be described by what it does.
import { ABILITIES, SPECIES, abilityStatuses, type Move, type MoveEffect } from "./species";
import {
  FIELDS, STATUSES,
  type Basis, type DamageCategory, type FieldDef, type InflictScope, type StatusDef,
  type StatusEffect, type StatusTrigger,
} from "./status";
import { STAT_LABELS, STAT_NAMES, TYPE_LABELS, type ElementType, type StatName } from "./types";
import type { TargetMode } from "./targeting";

const pct = (f: number): string => `${Math.round(f * 100)}%`;
const signed = (f: number): string => `${f >= 0 ? "+" : "-"}${pct(Math.abs(f))}`;
const turns = (n: number): string => `${n} turn${n === 1 ? "" : "s"}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const type = (t: ElementType): string => TYPE_LABELS[t];
const stat = (s: StatName): string => STAT_LABELS[s];

/** Who a sentence is about. */
interface Subject {
  /** Named where it first comes up: "an ally", "all enemies". Empty for the holder or the caster. */
  noun: string;
  /** Referred back to once named: "it", "each". */
  back: string;
  /** "another ally's", "anyone's". Empty for the holder or the caster. */
  poss: string;
  /** "its" or "their", for anything of the subject's own. */
  their: string;
  plural: boolean;
}

const one = (noun: string, poss: string): Subject => ({ noun, back: "it", poss, their: "its", plural: false });
const many = (noun: string, poss: string): Subject => ({ noun, back: "each", poss, their: "their", plural: true });

/** The caster of a move, aiming at itself. Never named. */
const SELF: Subject = { noun: "", back: "", poss: "its", their: "its", plural: false };
/**
 * The Scoba carrying a status, read off its own mark or its own passive. Never
 * named either, and what it is given reads bare: "Strength +25%" rather than
 * "Gains Strength +25%", since there is nobody else the line could be about.
 */
const HOLDER: Subject = { noun: "", back: "", poss: "its", their: "its", plural: false };
/** Whoever was on the far side of a trigger. */
const THE_TARGET = one("the target", "the target's");

const TARGETS: Record<TargetMode, Subject> = {
  "self": SELF,
  "any-ally": one("an ally", "an ally's"),
  "other-ally": one("another ally", "another ally's"),
  "any-enemy": one("an enemy", "an enemy's"),
  "any-scoba": one("anyone", "anyone's"),
  "benched-ally": one("a benched ally", "a benched ally's"),
  "benched-enemy": one("a benched enemy", "a benched enemy's"),
  "ally-team": many("all allies", "every ally's"),
  "enemy-team": many("all enemies", "every enemy's"),
  "random-ally": one("a random ally", "a random ally's"),
  "random-enemy": one("a random enemy", "a random enemy's"),
  "random-scoba": one("someone at random", "someone's"),
};

const SCOPES: Record<InflictScope, Subject> = {
  self: SELF,
  other: THE_TARGET,
  allies: many("every ally", "every ally's"),
  enemies: many("every enemy", "every enemy's"),
  all: many("everyone", "everyone's"),
};

/** A sentence, and whether it opens on a trigger rather than following on. */
interface Piece {
  text: string;
  triggered: boolean;
}

/** What a triggered sentence opens with. */
function when(t: StatusTrigger): string {
  switch (t.on) {
    case "battle-start": return "At the start of battle";
    case "turn-start": return "At the start of each turn";
    case "turn-end": return "At the end of each turn";
    case "basic-attack": return "On a basic attack";
    case "use-ability": return "On casting";
    case "block": return "On blocking";
    case "hit-magic": return "When hit by magic";
    case "hit-physical": return "When hit by a physical attack";
    case "hit-any": return "When hit";
    case "hit-element": return `When hit by ${type(t.element)}`;
    case "deal-magic": return "On landing magic damage";
    case "deal-physical": return "On landing physical damage";
    case "deal-any": return "On landing a hit";
    case "kill-attack": return "On kill";
    case "death": return "On fainting";
    case "switch-in": return "On entering the field";
    case "ally-death": return "When an ally faints";
    case "enemy-death": return "When an enemy faints";
    case "hp-below": return `When below ${pct(t.frac)} HP`;
    case "passive": return "";
  }
}

/**
 * An amount of damage. A bare percentage with a category is a share of the
 * caster's Strength or Magic, which is what the category already implies. A
 * share of a pool says whose pool it is.
 */
function damageAmount(basis: Basis, frac: number, element: ElementType, category: DamageCategory, who: Subject): string {
  const kind = category === "true" ? "true damage" : `${type(element)} ${category} damage`;
  switch (basis) {
    case "source-str":
    case "source-mag":
      return `${pct(frac)} ${kind}`;
    case "holder-str":
    case "holder-mag":
      return `${pct(frac)} of ${who.their} ${basis === "holder-str" ? stat("str") : stat("mag")} as ${kind}`;
    case "holder-max-hp": return `${pct(frac)} of ${who.their} max HP as ${kind}`;
    case "holder-hp": return `${pct(frac)} of ${who.their} current HP as ${kind}`;
    case "source-max-hp": return `${pct(frac)} of the caster's max HP as ${kind}`;
  }
}

/** An amount of healing. "X% Magic" is a share of the healer's own Magic. */
function healAmount(basis: Basis, frac: number, who: Subject): string {
  switch (basis) {
    case "holder-max-hp": return frac >= 1 ? "to full" : `for ${pct(frac)} of ${who.their} max HP`;
    case "holder-hp": return `for ${pct(frac)} of ${who.their} current HP`;
    case "holder-str": return `for ${pct(frac)} ${stat("str")}`;
    case "holder-mag": return `for ${pct(frac)} ${stat("mag")}`;
    case "source-str": return `for ${pct(frac)} of the caster's ${stat("str")}`;
    case "source-mag": return `for ${pct(frac)} of the caster's ${stat("mag")}`;
    case "source-max-hp": return `for ${pct(frac)} of the caster's max HP`;
  }
}

const CONTINUOUS = new Set<StatusEffect["kind"]>([
  "stat-add", "stat-set", "stat-scale", "stat-share", "immune", "vulnerable", "element-power", "ward",
]);

/** A share of a stat or a type, as a thing that can be given: "Strength +25%". */
function grant(e: StatusEffect): string | null {
  switch (e.kind) {
    case "stat-scale": return `${stat(e.stat)} ${signed(e.mult - 1)}`;
    case "stat-add": return `${stat(e.stat)} ${e.amount >= 0 ? "+" : "-"}${Math.abs(e.amount)}`;
    case "stat-set": return `${stat(e.stat)} set to ${e.value}`;
    case "stat-share": return `${stat(e.stat)} +${pct(e.frac)} of ${stat(e.from)}`;
    case "element-power": return `${type(e.element)} moves ${signed(e.mult - 1)}`;
    default: return null;
  }
}

/** A standing condition, as a verb phrase: "takes no Moon damage". */
function state(e: StatusEffect, def: StatusDef): string | null {
  switch (e.kind) {
    case "immune": return `takes no ${type(e.element)} damage`;
    case "vulnerable": return `takes ${pct(e.mult)} ${type(e.element)} damage`;
    case "ward": {
      const n = def.charges ?? 0;
      return `absorbs ${n === 1 ? "one" : n > 1 ? String(n) : "every"} ${type(e.element)} hit${n === 1 ? "" : "s"}${n > 0 ? " a battle" : ""}`;
    }
    default: return null;
  }
}

/** Every stat raised by the same amount reads as one thing. */
function grants(effects: StatusEffect[]): string[] {
  const adds = effects.filter((e): e is Extract<StatusEffect, { kind: "stat-add" }> => e.kind === "stat-add");
  const allStats = adds.length === STAT_NAMES.length
    && STAT_NAMES.every((s) => adds.some((a) => a.stat === s && a.amount === adds[0]!.amount));
  const out: string[] = [];
  if (allStats) out.push(`All stats ${adds[0]!.amount >= 0 ? "+" : "-"}${Math.abs(adds[0]!.amount)}`);
  for (const e of effects) {
    if (allStats && e.kind === "stat-add") continue;
    const g = grant(e);
    if (g) out.push(g);
  }
  return out;
}

interface StatusOpts {
  /** Say how long it lasts. Off for a window that already shows the turns left. */
  duration?: boolean;
  /** Say how many times it can go off. Off for the same reason. */
  charges?: boolean;
  /** Inside another status's trigger, where it is one clause of that sentence. */
  nested?: boolean;
  /** Where a status is looked up, so a test can describe one that is not in the game. */
  statuses?: Record<string, StatusDef>;
}

/** What a fired effect does, as a verb phrase in the third person. */
function fired(e: StatusEffect, def: StatusDef, who: Subject, opts: StatusOpts): string {
  switch (e.kind) {
    case "damage": return `takes ${damageAmount(e.damage.basis, e.damage.frac, e.damage.element, e.damage.category, who)}`;
    case "heal": return `heals ${healAmount(e.basis, e.frac, who)}`;
    case "summon": return summons(e.species, e.level, who);
    case "mana": return `gains ${e.amount}% mana`;
    case "inflict": {
      const table = opts.statuses ?? STATUSES;
      const inner = table[e.status];
      if (!inner) return `gains ${e.status}`;
      return statusPieces(inner, SCOPES[e.scope], { ...opts, nested: true })
        .map((p) => low(p.text.replace(/\.$/, "")))
        .join(" and ");
    }
    case "field": {
      const f = FIELDS[e.field];
      const side = e.scope === "both" ? "both sides" : e.scope === "allies" ? "its side" : "the enemy side";
      const what = f ? fieldClauses(f).join(", ") : e.field;
      return `gives ${side} ${what}${f?.duration ? ` for ${turns(f.duration)}` : ""}`;
    }
    case "grant-item": return `finds ${e.count} ${cap(e.item)}`;
    case "cleanse": return `clears ${who.their} ${e.polarity} statuses`;
    case "copy-statuses":
      return `passes ${who.their} statuses to ${def.trigger.on === "death" ? "whoever struck it down" : "whoever set it off"}`;
    default: return "";
  }
}

function summons(species: string, level: number, who: Subject): string {
  const sp = SPECIES[species];
  const name = sp?.name ?? species;
  return sp?.pawn
    ? `calls up a ${name} Pawn at ${who.their} level`
    : `calls a level ${level} ${name} to ${who.their} side`;
}

/**
 * The sentences a status comes to, about `who`. Standing effects come first
 * and follow on from whatever came before them; fired effects open on their
 * trigger and stand on their own.
 */
function statusPieces(def: StatusDef, who: Subject, opts: StatusOpts): Piece[] {
  const withDuration = opts.duration !== false;
  const withCharges = opts.charges !== false;
  const dur = withDuration && def.duration ? ` for ${turns(def.duration)}` : "";
  const perStack = def.stacks
    ? def.maxStacks >= 99 ? " per stack" : ` per stack, up to ${def.maxStacks} stacks`
    : "";
  const out: Piece[] = [];

  const standing = def.effects.filter((e) => CONTINUOUS.has(e.kind));
  const given = grants(standing).map((g) => `${g}${perStack}`);
  if (given.length > 0) {
    const list = given.join(", ");
    const text = who === HOLDER
      ? `${cap(list)}${dur}.`
      : who.noun
        ? `Gives ${who.noun} ${list}${dur}.`
        : `Gains ${list}${dur}.`;
    out.push({ text, triggered: false });
  }
  for (const e of standing) {
    const s = state(e, def);
    if (!s) continue;
    out.push({ text: `${who.noun ? `${cap(who.noun)} ${s}` : cap(s)}${dur}.`, triggered: false });
  }

  const goes = def.effects.filter((e) => !CONTINUOUS.has(e.kind));
  if (goes.length > 0) {
    const lead = when(def.trigger);
    // A trigger that can only ever fire once says nothing about how often.
    const onlyOnce = def.trigger.on === "battle-start" || def.trigger.on === "death";
    const times = withCharges && def.charges && !onlyOnce
      ? def.charges === 1 ? ", once a battle" : `, up to ${def.charges} times`
      : "";
    const verbs = goes.map((e) => fired(e, def, who, opts)).filter((v) => v !== "").join(" and ");
    const subject = who.noun ? `${who.noun} ` : "";
    const body = `${subject}${verbs}${times}${dur}`;
    out.push({ text: lead ? `${lead}, ${body}.` : `${cap(body)}.`, triggered: lead !== "" });
    if (def.stacks && given.length === 0) out.push({ text: "Stacks.", triggered: true });
  }

  if (def.persists === false && !def.innate) {
    if (opts.nested && out.length > 0) {
      const last = out[out.length - 1]!;
      last.text = `${last.text.replace(/\.$/, "")} until ${who.plural ? "they switch" : "it switches"} out.`;
    } else {
      out.push({ text: "Lost on switching out.", triggered: true });
    }
  }
  return out;
}

/** Sentences in order, with each immediate step after the first led by "Then". */
function join(pieces: Piece[]): string {
  return pieces
    .map((p, i) => (i > 0 && !p.triggered ? `Then ${low(p.text)}` : p.text))
    .join(" ");
}

/** What a status does to the Scoba carrying it. */
export function describeStatus(id: string, opts: StatusOpts = {}): string {
  const def = (opts.statuses ?? STATUSES)[id];
  if (!def) return "";
  return join(statusPieces(def, HOLDER, opts));
}

/** What a passive does, which is what its statuses do. */
export function describeAbility(id: string): string {
  if (!ABILITIES[id]) return "";
  return abilityStatuses(id).map((sid) => describeStatus(sid)).filter((s) => s !== "").join(" ");
}

function fieldClauses(f: FieldDef): string[] {
  return f.effects.map((e) => {
    switch (e.kind) {
      case "element-power": return `${type(e.element)} moves ${signed(e.mult - 1)}`;
      case "immune": return `no ${type(e.element)} damage taken`;
      case "vulnerable": return `${pct(e.mult)} ${type(e.element)} damage taken`;
    }
  });
}

/** What a field does to the side standing under it. */
export function describeField(id: string): string {
  const f = FIELDS[id];
  if (!f) return "";
  return `${cap(fieldClauses(f).join(", "))}.`;
}

function movePieces(move: Move, opts: StatusOpts): Piece[] {
  const named = new Set<number>();
  // A target is named the first time it comes up and referred back to after.
  const subject = (i: number): Subject => {
    const mode = move.targets[i]?.mode;
    if (!mode) return THE_TARGET;
    const t = TARGETS[mode];
    if (named.has(i)) return { ...t, noun: t.back, poss: t.their };
    named.add(i);
    return t;
  };
  const out: Piece[] = [];
  const category = move.kind === "physical" ? "physical" : "magic";
  if (move.kind === "physical" || move.kind === "magical") {
    const t = subject(0);
    out.push({
      text: `Deals ${pct(move.scale)} ${type(move.type)} ${category} damage to ${t.noun || "itself"}.`,
      triggered: false,
    });
  } else if (move.kind === "heal") {
    const t = subject(0);
    out.push({ text: `Heals ${t.noun ? `${t.noun} ` : ""}for ${pct(move.scale)} of ${t.their} max HP.`, triggered: false });
  }
  for (const e of move.effects ?? []) out.push(...effectPieces(e, subject, opts));
  return out;
}

function effectPieces(e: MoveEffect, subject: (i: number) => Subject, opts: StatusOpts): Piece[] {
  switch (e.kind) {
    case "status": {
      const def = (opts.statuses ?? STATUSES)[e.status];
      if (!def) return [{ text: `Leaves ${e.status} on ${subject(e.target).noun || "itself"}.`, triggered: false }];
      return statusPieces(def, subject(e.target), opts);
    }
    case "damage": {
      const t = subject(e.target);
      return [{ text: `Deals ${pct(e.scale)} Plain physical damage to ${t.noun || "itself"}.`, triggered: false }];
    }
    case "heal": {
      const t = subject(e.target);
      return [{ text: `Heals ${t.noun ? `${t.noun} ` : ""}for ${pct(e.frac)} of ${t.their} max HP.`, triggered: false }];
    }
    case "transfer": {
      const from = subject(e.from);
      const to = subject(e.to);
      const split = to.plural ? ", split between them" : "";
      return [
        { text: `Takes ${pct(e.frac)} of ${from.poss || "its"} current HP.`, triggered: false },
        {
          text: e.deliver === "heal"
            ? `Heals ${to.noun ? `${to.noun} ` : ""}for that much${split}.`
            : `Deals it to ${to.noun || "itself"} as true damage${split}.`,
          triggered: false,
        },
      ];
    }
    case "cleanse": {
      const t = subject(e.target);
      return [{ text: `Clears ${e.polarity} statuses from ${t.noun || "itself"}.`, triggered: false }];
    }
    case "copy-statuses": {
      const from = subject(e.from);
      const to = subject(e.to);
      return [{ text: `Copies ${from.poss || "its"} statuses onto ${to.noun || "itself"}.`, triggered: false }];
    }
    case "summon":
      return [{ text: `${cap(summons(e.species, e.level, SELF))}.`, triggered: false }];
    case "grant-item":
      return [{ text: `Finds ${e.count} ${cap(e.item)}.`, triggered: false }];
  }
}

/** What a move does, without its cost. For anywhere the cost is already printed beside it. */
export function describeMoveEffects(move: Move, opts: StatusOpts = {}): string {
  return join(movePieces(move, opts));
}

/** The trailer: cost, then cooldown, then how soon it is first usable, each only when it applies. */
export function describeMoveCost(move: Move): string {
  const bits = [`${move.manaCost}% mana`];
  if (move.cooldown > 0) bits.push(`cooldown ${move.cooldown}`);
  if (move.startCooldown > 0) bits.push(`first ready on turn ${move.startCooldown + 1}`);
  return `(${bits.join(", ")})`;
}

/** The whole line, the way the rule writes it. */
export function describeMove(move: Move, opts: StatusOpts = {}): string {
  return `${describeMoveEffects(move, opts)} ${describeMoveCost(move)}`;
}
