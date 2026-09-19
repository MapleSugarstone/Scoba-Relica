// How a move, a status, a passive or a field is described, in one voice.
//
// Every line of effect text in the game comes out of here rather than being
// written by hand, so the rule in claude-notes/ability-text.md holds
// everywhere: verb first, numbers as percentages, one sentence per step,
// triggers up front, the cost in a trailer, and nothing described by its name
// where it can be described by what it does.
import {
  ABILITIES, MOVES, SPECIES, abilityStatuses, allSteps, moveTypes, type Move,
} from "./species";
import {
  FIELDS, STATUSES, statusName,
  type Basis, type DamageCategory, type FieldDef, type MoveChange, type StatusDef,
  type StatusEffect, type StatusTrigger, type Step, type Who,
  isContinuous,
} from "./status";
import { STAT_LABELS, STAT_NAMES, TYPE_LABELS, type ElementType, type StatName } from "./types";
import { BLACKJACK, CARD_HIGH } from "./cards";
import { MAX_LEVEL } from "./scoba";
import { hitCategory } from "./script/read";
import type { TargetMode } from "./targeting";

const pct = (f: number): string => `${Math.round(f * 100)}%`;

/** A passive by the name a player sees, for a step that names one by id. */
const passiveName = (id: string): string => ABILITIES[id]?.name ?? statusName(id);

/**
 * A flat amount a status gains with its source's level, as what each level adds.
 * The number is written in the script as what it comes to at the level ceiling,
 * so 50 there is 1.67 a level.
 */
export const perLevel = (atCeiling: number): string => String(Number((atCeiling / MAX_LEVEL).toFixed(2)));
const signed = (f: number): string => `${f >= 0 ? "+" : "-"}${pct(Math.abs(f))}`;
const turns = (n: number): string => `${n} turn${n === 1 ? "" : "s"}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const type = (t: ElementType): string => TYPE_LABELS[t];

/**
 * What a move counts as, named. A move of two elements is read against both,
 * so it says both: "Moon and Sugar" rather than the first of them, which is
 * what a reader would otherwise take it for.
 */
const moveElements = (move: Move): string => moveTypes(move).map(type).join(" and ");
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
  "fallen-scoba": one("a fallen Scoba", "a fallen Scoba's"),
  "benched-ally": one("a benched ally", "a benched ally's"),
  "benched-enemy": one("a benched enemy", "a benched enemy's"),
  "ally-team": many("all allies", "every ally's"),
  "enemy-team": many("all enemies", "every enemy's"),
  "random-ally": one("a random ally", "a random ally's"),
  "random-enemy": one("a random enemy", "a random enemy's"),
  "random-scoba": one("someone at random", "someone's"),
};

/** Who a status's step reaches, named from the Scoba carrying it. */
const SCOPES: Record<Extract<Who, string>, Subject> = {
  self: SELF,
  source: one("whoever left it", "whoever left it's"),
  other: THE_TARGET,
  allies: many("every ally", "every ally's"),
  enemies: many("every enemy", "every enemy's"),
  everyone: many("everyone", "everyone's"),
  others: many("every other Scoba", "every other Scoba's"),
  raised: one("the Scoba it raised", "the raised Scoba's"),
  traveller: one("the Scoba that travelled", "the travelling Scoba's"),
  "field-allies": many("all allies", "every ally's"),
  "field-enemies": many("all enemies", "every enemy's"),
  "ally-scobas": many("all ally Scobas", "every ally Scoba's"),
  "enemy-scobas": many("all enemy Scobas", "every enemy Scoba's"),
  "ally-pawns": many("all ally Pawns", "every ally Pawn's"),
  "enemy-pawns": many("all enemy Pawns", "every enemy Pawn's"),
};

/** Who a step reaches, named: a word, the next Scoba from a group, or the first of two that reaches anyone. */
const scopeOf = (w: Who): Subject => {
  if (typeof w !== "object") return SCOPES[w];
  if ("aim" in w) return THE_TARGET;
  if ("next" in w) return w.next === "ally" ? one("the other ally Scoba", "the other ally Scoba's") : one("the other enemy Scoba", "the other enemy Scoba's");
  return scopeOf(w.first);
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
    case "deal-spell": return "On landing a spell";
    case "deal-element": return `On landing ${type(t.element)}${t.category !== undefined ? ` ${t.category}` : ""} damage`;
    case "kill-attack": return "On kill";
    case "death": return "On fainting";
    case "switch-in": return "On entering the field";
    case "ally-death": return "When an ally faints";
    case "enemy-death": return "When an enemy faints";
    case "any-death": return "When any Scoba faints";
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

/** A share of a stat or a type, as a thing that can be given: "Strength +25%". */
function grant(e: StatusEffect): string | null {
  switch (e.kind) {
    case "stat-scale": return `${stat(e.stat)} ${signed(e.mult - 1)}`;
    case "stat-add": return `${stat(e.stat)} ${e.amount >= 0 ? "+" : "-"}${Math.abs(e.amount)}`;
    case "stat-set": return `${stat(e.stat)} set to ${e.value}`;
    case "stat-share": return `${stat(e.stat)} +${pct(e.frac)} of ${stat(e.from)}`;
    case "stat-offset": return `${stat(e.stat)} ${e.amount >= 0 ? "+" : "-"}${Math.abs(e.amount)}`;
    case "stat-boost":
      return `${stat(e.stat)} ${signed(e.frac)} of what it walked in with, and ${e.flat} more`;
    case "element-power": return `${type(e.element)} moves ${signed(e.mult - 1)}`;
    default: return null;
  }
}

/** What a status's `power` was measured off: "the caster's Magic", "its max HP". */
function powerOf(basis: Basis, who: Subject): string {
  switch (basis) {
    case "source-str": return `the caster's ${stat("str")}`;
    case "source-mag": return `the caster's ${stat("mag")}`;
    case "source-max-hp": return "the caster's max HP";
    case "holder-str": return `${who.their} ${stat("str")}`;
    case "holder-mag": return `${who.their} ${stat("mag")}`;
    case "holder-max-hp": return `${who.their} max HP`;
    case "holder-hp": return `${who.their} HP as it stood`;
  }
}

/** A standing condition, as a verb phrase: "takes no Moon damage". */
function state(e: StatusEffect, def: StatusDef, who: Subject, opts: StatusOpts): string | null {
  switch (e.kind) {
    case "root": return "cannot switch out";
    case "no-hyper": return "cannot enter Hyper-Mode";
    case "no-spells": return "cannot cast abilities";
    case "echo": return `casts everything a second time, for ${pct(e.frac)} of the first`;
    case "stat-power": {
      const p = def.power;
      if (!p) return null;
      const parts: string[] = [];
      if (p.basis !== undefined) parts.push(`${pct(Math.abs(p.frac * e.mult))} of ${powerOf(p.basis, who)}`);
      if (p.flatAtCeiling !== undefined) parts.push(`${perLevel(Math.abs(p.flatAtCeiling * e.mult))} a level`);
      return `${e.mult < 0 ? "loses" : "gains"} ${parts.join(" plus ")} as ${stat(e.stat)}`;
    }
    case "immune": return `takes no ${type(e.element)} damage`;
    case "vulnerable": return `takes ${pct(e.mult)} ${type(e.element)} damage`;
    case "frail": return `takes ${pct(e.mult)} damage from everything`;
    case "ward": {
      const n = def.charges ?? 0;
      return `absorbs ${n === 1 ? "one" : n > 1 ? String(n) : "every"} ${type(e.element)} hit${n === 1 ? "" : "s"}${n > 0 ? " a battle" : ""}`;
    }
    case "soften": return `cuts the next hit it takes by ${pct(e.frac)}`;
    case "mark-power":
      return `makes the marks it leaves that stand for ${turns(e.minTurns)} or more ${pct(e.mult - 1)} stronger`;
    case "mark-worth": {
      const which = e.polarity === "bad" ? "negative" : "positive";
      const where = e.reach === "self" ? "its" : e.reach === "enemies" ? "enemies'" : "allies'";
      return `makes ${where} ${which} statuses ${pct(e.mult - 1)} more effective`;
    }
    case "heal-bonus":
      return opts.level !== undefined
        ? `makes every heal on an ally restore ${shownAmount((e.flatAtCeiling * opts.level) / MAX_LEVEL)} more`
        : `makes every heal on an ally restore ${perLevel(e.flatAtCeiling)} more per level`;
    default: return null;
  }
}

/** A rewrite of a move, as the words it comes to: "Fortuna, physical and off Strength". */
function rewriteWords(changes: MoveChange[]): string {
  const words = changes.flatMap((c) => {
    switch (c.set) {
      case "type": return [type(c.to)];
      case "category": return [c.to];
      case "stat": return [`off ${stat(c.to)}`];
      case "cost": return [c.mult === 0.5 ? "at half cost" : `at ${pct(c.mult)} of its cost`];
      case "tint": case "name": return [];
    }
  });
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The steps that only change what is drawn and heard, and say nothing in a description. */
const SHOWN = new Set<Step["kind"]>(["motion", "throw", "show", "sound", "wait", "wear", "say", "draw-card"]);

/** Every stat raised by the same amount reads as one thing. */
function grants(effects: StatusEffect[]): string[] {
  const adds = effects.filter((e): e is Extract<StatusEffect, { kind: "stat-add" }> => e.kind === "stat-add");
  const allStats = adds.length === STAT_NAMES.length
    && STAT_NAMES.every((s) => adds.some((a) => a.stat === s && a.amount === adds[0]!.amount));
  const scales = effects.filter((e): e is Extract<StatusEffect, { kind: "stat-scale" }> => e.kind === "stat-scale");
  const allScaled = scales.length === STAT_NAMES.length
    && STAT_NAMES.every((s) => scales.some((a) => a.stat === s && a.mult === scales[0]!.mult));
  const offsets = effects.filter((e): e is Extract<StatusEffect, { kind: "stat-offset" }> => e.kind === "stat-offset");
  const allOffset = offsets.length === STAT_NAMES.length
    && STAT_NAMES.every((s) => offsets.some((a) => a.stat === s && a.amount === offsets[0]!.amount));
  const boosts = effects.filter((e): e is Extract<StatusEffect, { kind: "stat-boost" }> => e.kind === "stat-boost");
  const allBoost = boosts.length === STAT_NAMES.length
    && STAT_NAMES.every((s) => boosts.some((a) =>
      a.stat === s && a.frac === boosts[0]!.frac && a.flat === boosts[0]!.flat));
  const out: string[] = [];
  if (allStats) out.push(`All stats ${adds[0]!.amount >= 0 ? "+" : "-"}${Math.abs(adds[0]!.amount)}`);
  if (allScaled) out.push(`All stats ${signed(scales[0]!.mult - 1)}`);
  if (allOffset) out.push(`All stats ${offsets[0]!.amount >= 0 ? "+" : "-"}${Math.abs(offsets[0]!.amount)}`);
  if (allBoost) {
    out.push(`All stats ${signed(boosts[0]!.frac)} of what it walked in with, and ${boosts[0]!.flat} more`);
  }
  for (const e of effects) {
    if (allStats && e.kind === "stat-add") continue;
    if (allScaled && e.kind === "stat-scale") continue;
    if (allOffset && e.kind === "stat-offset") continue;
    if (allBoost && e.kind === "stat-boost") continue;
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
  /** The level of whoever leaves it, so a flat power reads as the number it comes to. */
  level?: number;
  /** What a heal or damage step comes to on the Scoba carrying it, written in place of the share it is of something. */
  amount?: (step: StatusEffect) => string | undefined;
}

/** A stat amount: whole from 10 up, and one decimal under that, since stats are only rounded once everything is added. */
export const shownAmount = (n: number): string => {
  const size = Math.abs(n);
  return size >= 10 ? String(Math.floor(size)) : String(Number(size.toFixed(1)));
};

/** Which stats a line moves: "all stats", "Speed", "Strength and Defense". */
function statsNamed(stats: StatName[]): string {
  if (stats.length >= STAT_NAMES.length) return "all stats";
  const names = stats.map(stat);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
}

/** "Increases all stats by 7." What a status's power comes to on the Scoba carrying it. */
export function shiftLine(amount: number, stats: StatName[]): string {
  return `${amount < 0 ? "Reduces" : "Increases"} ${statsNamed(stats)} by ${shownAmount(amount)}.`;
}

type StatPower = Extract<StatusEffect, { kind: "stat-power" }>;

/**
 * What a status's power moves stats by, as one verb phrase: "increases all
 * stats by 1". Null where the stats it moves are moved by different shares.
 */
function powerLine(def: StatusDef, moved: StatPower[], who: Subject, level?: number): string | null {
  const p = def.power;
  const first = moved[0];
  if (!p || !first || moved.some((e) => e.mult !== first.mult)) return null;
  const stats = [...new Set(moved.map((e) => e.stat))];
  const what = !who.noun ? statsNamed(stats)
    : stats.length >= STAT_NAMES.length ? `all of ${who.poss} stats` : `${who.poss} ${statsNamed(stats)}`;
  const size = Math.abs(first.mult);
  const parts: string[] = [];
  if (p.basis !== undefined) parts.push(`${pct(p.frac * size)} of ${powerOf(p.basis, who)}`);
  if (p.flatAtCeiling !== undefined) {
    const flat = p.flatAtCeiling * size;
    parts.push(level !== undefined ? shownAmount((flat * level) / MAX_LEVEL) : `${perLevel(flat)} a level`);
  }
  return `${first.mult < 0 ? "reduces" : "increases"} ${what} by ${parts.join(" plus ")}`;
}

/** What a fired effect does, as a verb phrase in the third person. */
function fired(e: StatusEffect, def: StatusDef, who: Subject, opts: StatusOpts): string {
  switch (e.kind) {
    case "damage": {
      const exact = opts.amount?.(e);
      if (exact !== undefined) {
        const d = e.damage;
        return `takes ${exact} ${d.category === "true" ? "true damage" : `${type(d.element)} ${d.category} damage`}`;
      }
      const dealt = damageAmount(e.damage.basis, e.damage.frac, e.damage.element, e.damage.category, who);
      const flat = e.damage.flatAtCeiling;
      return `takes ${dealt}${flat ? ` plus ${perLevel(flat)} damage per level` : ""}`;
    }
    case "heal": {
      const exact = opts.amount?.(e);
      return exact !== undefined ? `heals ${exact}` : `heals ${healAmount(e.basis, e.frac, who)}`;
    }
    case "summon": return summons(e, who);
    case "mana": return `gains ${e.amount}% mana${e.second ? " in its second mana bar" : ""}`;
    case "inflict": {
      const table = opts.statuses ?? STATUSES;
      const inner = table[e.status];
      if (!inner) return `gains ${e.status}`;
      // A status that only moves stats by its power is named rather than spelled
      // out, since its own sigil says what it comes to on whoever carries it.
      if (inner.effects.length > 0 && inner.effects.every((x) => x.kind === "stat-power")) {
        const sub = scopeOf(e.on);
        const name = statusName(e.status);
        return sub.noun ? `${sub.noun} ${sub.plural ? "gain" : "gains"} ${name}` : `gains ${name}`;
      }
      // A source that overrides how long the mark stands is described by what
      // it actually leaves behind rather than by the mark's own clock.
      const held = e.turns === undefined ? inner : { ...inner, duration: e.turns };
      return statusPieces(held, scopeOf(e.on), { ...opts, nested: true })
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
    case "clear-status": return `takes ${statusName(e.status)} off ${scopeOf(e.on).noun || "itself"}`;
    case "undo-round": return `puts ${scopeOf(e.on).noun || "itself"} back at the end of the round`;
    case "rewind": return `winds the battle back ${turns(e.turns)}`;
    case "travel": return `goes back ${turns(e.turns)} and plays them again`;
    case "raise": return `raises ${scopeOf(e.who).noun || "itself"} as a Pawn`;
    case "copy-marks":
      return `passes ${who.their} statuses to ${def.trigger.on === "death" ? "whoever struck it down" : "whoever set it off"}`;
    case "hit": {
      const amount = e.perLevel !== undefined
        ? `${e.perLevel} damage per level`
        : e.scaling.map((s) => `${pct(s.scale)} ${stat(s.stat)}`).join(" plus ");
      return `hits ${scopeOf(e.to).noun || "itself"} for ${amount}`;
    }
    case "pick-move":
      return `picks a random move out of the whole game${e.minCost > 0 ? ` costing ${e.minCost} or more` : ""}`;
    case "change-move": return `rewrites it as ${rewriteWords(e.changes)}`;
    case "give-move":
      return e.slot === null
        ? "hands it over on top of its moves for the battle"
        : `puts it in slot ${e.slot + 1} for the battle`;
    case "deal-card": return `deals a card onto ${scopeOf(e.to).noun || "itself"}`;
    case "transfer": return `takes ${pct(e.frac)} of the current HP of ${scopeOf(e.from).noun || "itself"}`;
    case "if": return "";
    case "refund": return "";
    default: return "";
  }
}

function summons(e: Extract<StatusEffect, { kind: "summon" }>, who: Subject): string {
  const sp = SPECIES[e.species];
  const name = sp?.name ?? e.species;
  const copies = e.copying !== undefined ? ` with ${who.their} moves and statuses` : "";
  if (e.levelShare !== undefined) {
    return `calls up a ${name}${sp?.pawn ? " Pawn" : ""} at ${pct(e.levelShare)} of ${who.their} level${copies}`;
  }
  return sp?.pawn
    ? `calls up a ${name} Pawn at ${who.their} level${copies}`
    : `calls a level ${e.level} ${name} to ${who.their} side${copies}`;
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

  const standing = def.effects.filter((e) => isContinuous(e.kind));
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
  const moved = powerLine(def, standing.filter((e): e is StatPower => e.kind === "stat-power"), who, opts.level);
  if (moved !== null) out.push({ text: `${cap(moved)}${perStack}${dur}.`, triggered: false });
  for (const e of standing) {
    if (moved !== null && e.kind === "stat-power") continue;
    const s = state(e, def, who, opts);
    if (!s) continue;
    out.push({ text: `${who.noun ? `${cap(who.noun)} ${s}` : cap(s)}${dur}.`, triggered: false });
  }

  const goes = def.effects.filter((e) => !isContinuous(e.kind) && !SHOWN.has(e.kind as Step["kind"]));
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
  // Every `when` block after the first says what it does on its own trigger.
  for (const block of def.also ?? []) {
    const acts = block.steps.filter((e) => !SHOWN.has(e.kind));
    const verbs = acts.map((e) => fired(e, def, who, opts)).filter((v) => v !== "").join(" and ");
    if (verbs === "") continue;
    const lead = when(block.trigger);
    const body = `${who.noun ? `${who.noun} ` : ""}${verbs}`;
    out.push({ text: lead ? `${lead}, ${body}.` : `${cap(body)}.`, triggered: lead !== "" });
  }
  if (def.basicAttack) {
    out.push({ text: `Its basic attack is ${MOVES[def.basicAttack]?.name ?? def.basicAttack}.`, triggered: false });
  }

  if (def.persists === false && !def.innate) {
    if (opts.nested && out.length > 0) {
      const last = out[out.length - 1]!;
      last.text = `${last.text.replace(/\.$/, "")} until ${who.plural ? "they switch" : "it switches"} out.`;
    } else {
      out.push({ text: "Lost on switching out.", triggered: true });
    }
  }
  if (def.fuses) {
    const into = SPECIES[def.fuses.into]?.name ?? def.fuses.into;
    out.push({
      text: `On entry in Hyper-Mode, fuses with an ally in Hyper-Mode that has ${passiveName(def.fuses.partner)} into ${into}.`,
      triggered: true,
    });
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
  if (def.text !== undefined) return def.text;
  if (def.hand) {
    return `The cards it is holding. Landing on exactly ${BLACKJACK}, with an Ace counting 1 or 11,`
      + " pays out against it at once, and going over clears the hand for nothing.";
  }
  const said = join(statusPieces(def, HOLDER, opts));
  if (said !== "") return said;
  // A passive carried only to show its sigil says what it hands over.
  const grant = grantLine(id);
  if (grant !== "") return grant;
  // A mark that does nothing on its own is a count something else reads.
  const readers = Object.values(MOVES)
    .filter((m) => !m.derived && allSteps(m.cast).some((s) => s.kind === "hit" && s.perStackOf === id))
    .map((m) => m.name);
  if (readers.length > 0) return `${readers.join(" and ")} counts how many of these it is carrying.`;
  return said;
}

/** What a passive does, which is what its statuses do and what it hands over. */
export function describeAbility(id: string): string {
  const ability = ABILITIES[id];
  if (!ability) return "";
  const parts = abilityStatuses(id).map((sid) => describeStatus(sid)).filter((s) => s !== "");
  const grant = grantLine(id);
  if (grant !== "" && !parts.includes(grant)) parts.unshift(grant);
  return parts.length > 0 ? parts.join(" ") : "Does nothing on its own.";
}

/** The move a passive hands over, as a sentence, or nothing for one that hands none over. */
function grantLine(id: string): string {
  const moveId = ABILITIES[id]?.grantsMove;
  const move = moveId ? MOVES[moveId] : undefined;
  return move ? `Lets it cast ${move.name}${move.oncePerBattle ? " once a battle" : ""}.` : "";
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
  const who = (w: Who): Subject => {
    if (typeof w === "object") return "aim" in w ? subject(w.aim) : scopeOf(w);
    if (w === "self" || w === "source") return SELF;
    return SCOPES[w];
  };
  const out: Piece[] = [];
  for (const e of move.cast) out.push(...stepPieces(e, move, who, opts));
  return out;
}

function stepPieces(e: Step, move: Move, who: (w: Who) => Subject, opts: StatusOpts): Piece[] {
  switch (e.kind) {
    case "hit": {
      const t = who(e.to);
      const category = hitCategory(e);
      const elements = e.element ? type(e.element) : moveElements(move);
      const flat = e.flatAtCeiling !== undefined ? ` plus ${perLevel(e.flatAtCeiling)} per level` : "";
      const amount = e.perLevel !== undefined ? `${e.perLevel} per level` : `${pct(e.scaling[0]?.scale ?? 0)}${flat}`;
      const each = e.perStackOf !== undefined
        ? ` for each stack of ${STATUSES[e.perStackOf]?.name ?? e.perStackOf} it carries`
        : "";
      return [{
        text: `Deals ${amount} ${elements} ${category} damage to ${t.noun || "itself"}${each}.`,
        triggered: false,
      }];
    }
    case "heal": {
      const t = who(e.to);
      const of = e.basis === "source-mag" ? `the caster's ${stat("mag")}`
        : e.basis === "source-str" ? `the caster's ${stat("str")}`
          : `${t.their} max HP`;
      return [{ text: `Heals ${t.noun ? `${t.noun} ` : ""}for ${pct(e.frac)} of ${of}.`, triggered: false }];
    }
    case "inflict": {
      const def = (opts.statuses ?? STATUSES)[e.status];
      if (!def) return [{ text: `Leaves ${e.status} on ${who(e.on).noun || "itself"}.`, triggered: false }];
      const held = e.turns === undefined ? def : { ...def, duration: e.turns };
      return statusPieces(held, who(e.on), opts);
    }
    case "if": {
      const inner = e.then.flatMap((s) => stepPieces(s, move, who, opts));
      if (e.then.some((s) => s.kind === "refund")) {
        return [...inner, { text: "A kill with it refunds its cost and its cooldown.", triggered: true }];
      }
      return inner;
    }
    case "refund": return [];
    case "damage": {
      const t = who(e.to);
      const d = e.damage;
      return [{ text: `Deals ${damageAmount(d.basis, d.frac, d.element, d.category, t)} to ${t.noun || "itself"}.`, triggered: false }];
    }
    case "pick-move":
      return [{ text: `Picks a random move out of the whole game${e.minCost > 0 ? ` costing ${e.minCost} or more` : ""}.`, triggered: false }];
    case "change-move": return [{ text: `Rewrites it as ${rewriteWords(e.changes)}.`, triggered: false }];
    case "give-move":
      return [{
        text: e.slot === null ? "Hands it over for the battle." : `Puts it in slot ${e.slot + 1} for the battle.`,
        triggered: false,
      }];
    case "mana": {
      const bar = e.second ? " in its second mana bar" : "";
      return [{ text: `Gives ${who(e.on).noun || "itself"} ${e.amount}% mana${bar}.`, triggered: false }];
    }
    case "field": {
      const f = FIELDS[e.field];
      const side = e.scope === "both" ? "both sides" : e.scope === "allies" ? "its side" : "the enemy side";
      return [{ text: `Gives ${side} ${f ? fieldClauses(f).join(", ") : e.field}.`, triggered: false }];
    }
    case "motion": case "throw": case "show": case "sound": case "flash": case "wait": case "wear": case "say":
    case "draw-card":
      return [];
    case "transfer": {
      const from = who(e.from);
      const to = who(e.to);
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
      const t = who(e.on);
      return [{ text: `Clears ${e.polarity} statuses from ${t.noun || "itself"}.`, triggered: false }];
    }
    case "clear-status": {
      const t = who(e.on);
      return [{ text: `Takes ${statusName(e.status)} off ${t.noun || "itself"}.`, triggered: false }];
    }
    case "rewind":
      return [{ text: `Winds the whole battle back ${turns(e.turns)}.`, triggered: false }];
    case "travel":
      return [{
        text: `Goes back ${turns(e.turns)}, casts the other spell there, and plays those turns again.`,
        triggered: false,
      }];
    case "undo-round": {
      const t = who(e.on);
      return [{
        text: `Undoes the damage and statuses ${t.noun || "it"} takes this round, at the end of it.`,
        triggered: false,
      }];
    }
    case "raise": {
      const t = who(e.who);
      const as = e.types !== undefined ? ` as ${e.types.map(type).join(" and ")}` : " in its own elements";
      return [{
        text: `Raises ${t.noun || "itself"} as a Pawn${as}, at ${pct(e.levelShare)} of the level it fell at.`,
        triggered: false,
      }];
    }
    case "copy-marks": {
      const from = who(e.from);
      const to = who(e.to);
      return [{ text: `Copies ${from.poss || "its"} statuses onto ${to.noun || "itself"}.`, triggered: false }];
    }
    case "summon":
      return [{ text: `${cap(summons(e, SELF))}.`, triggered: false }];
    case "grant-item":
      return [{ text: `Finds ${e.count} ${cap(e.item)}.`, triggered: false }];
    case "deal-card": {
      const t = who(e.to);
      return [
        {
          text: `Deals a card onto ${t.noun || "itself"}, worth 1 to ${CARD_HIGH}, and an Ace 1 or 11.`,
          triggered: false,
        },
        {
          text: `A hand that reaches exactly ${BLACKJACK} pays out at once for ${pct(e.payoff)} Strength`
            + " and clears. Over that busts.",
          triggered: false,
        },
      ];
    }
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
