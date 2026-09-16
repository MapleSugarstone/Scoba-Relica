// Reads move script into the records the game runs.
//
// Every phrase the language has is read here, and `write.ts` writes each one
// back the same way. `docs/move-script.md` describes them all for an author.
import type { Ability, Move } from "../species";
import type {
  Basis, ChanceColorChange, FieldDef, FieldEffect, MoveChange, Scaling, Standing, StatusDamage,
  StatusDef, StatusTrigger, Step, Who,
} from "../status";
import type { TargetSpec } from "../targeting";
import type { StatName } from "../types";
import { readLines, ScriptError, type Line, type Problem, type Word } from "./lines";
import {
  AIM_WORDS, ANIM_WORDS, ELEMENT_WORDS, FIELD_SCOPE_WORDS, PATH_WORDS, POLARITY_WORDS,
  SHOW_WORDS, STAT_WORDS, TRIGGER_WORDS, nearest, type Vocab,
} from "./words";

/** An id a record names, checked once every file has been read. */
export interface Ref {
  table: "moves" | "statuses" | "species" | "fields";
  id: string;
  line: number;
}

export interface ReadResult {
  moves: Move[];
  statuses: StatusDef[];
  abilities: Ability[];
  fields: FieldDef[];
  problems: Problem[];
  refs: Ref[];
  /** The line each record's header is on, by id. */
  lines: Record<string, number>;
}

export type RecordKind = "move" | "status" | "passive" | "field";

// --- reading one clause ---

/** The words of one clause, read left to right. */
class Clause {
  private at = 0;

  constructor(private readonly words: Word[], readonly line: number, private readonly usage: string) {}

  private peek(n = 0): Word | undefined {
    return this.words[this.at + n];
  }

  fail(says: string): never {
    throw new ScriptError(this.line, this.usage ? `${says}. It is written: ${this.usage}` : says);
  }

  /** Whether the clause goes on with this phrase, ignoring case. */
  sees(phrase: string): boolean {
    return phrase.split(" ").every((part, i) => {
      const w = this.peek(i);
      return !!w && !w.quoted && w.text.toLowerCase() === part;
    });
  }

  take(phrase: string): boolean {
    if (!this.sees(phrase)) return false;
    this.at += phrase.split(" ").length;
    return true;
  }

  expect(phrase: string): void {
    if (this.take(phrase)) return;
    const w = this.peek();
    this.fail(w ? `expected "${phrase}" where it says "${w.text}"` : `expected "${phrase}" at the end`);
  }

  get empty(): boolean {
    return this.at >= this.words.length;
  }

  private next(what: string): Word {
    const w = this.peek();
    if (!w) this.fail(`ends before ${what}`);
    this.at += 1;
    return w;
  }

  number(what: string): number {
    const w = this.next(what);
    const n = Number(w.text);
    if (w.quoted || w.text === "" || !Number.isFinite(n)) this.fail(`"${w.text}" should be a number for ${what}`);
    return n;
  }

  /** A number that counts something, which nothing in the language reads below nothing. */
  count(what: string): number {
    const n = this.number(what);
    if (n < 0) this.fail(`${what} cannot be less than nothing`);
    return n;
  }

  /** "110%" is 1.1. */
  percent(what: string): number {
    const w = this.next(what);
    const m = /^(-?\d+(?:\.\d+)?)%$/.exec(w.text);
    if (w.quoted || !m) this.fail(`"${w.text}" should be a percentage like 50% for ${what}`);
    return Number(m[1]) / 100;
  }

  /** "x1.25" is 1.25. */
  times(what: string): number {
    const w = this.next(what);
    const m = /^x(\d+(?:\.\d+)?)$/i.exec(w.text);
    if (w.quoted || !m) this.fail(`"${w.text}" should be a multiplier like x1.5 for ${what}`);
    return Number(m[1]);
  }

  /** A word or a quoted run of text, taken as it is. */
  token(what: string): string {
    const w = this.next(what);
    return w.text;
  }

  quoted(what: string): string {
    const w = this.next(what);
    if (!w.quoted) this.fail(`${what} should be in double quotes`);
    return w.text;
  }

  /** An id: lower-case letters, digits and dashes. */
  id(what: string): string {
    const w = this.next(what);
    if (w.quoted || !/^[a-z0-9][a-z0-9-]*$/.test(w.text)) {
      this.fail(`"${w.text}" should be an id of lower-case letters, digits and dashes for ${what}`);
    }
    return w.text;
  }

  /** The longest phrase in the table the clause goes on with. */
  vocab<T extends string>(words: Vocab<T>, what: string): T {
    const phrases = Object.keys(words.read).sort((a, b) => b.split(" ").length - a.split(" ").length);
    for (const phrase of phrases) {
      if (this.take(phrase)) return words.read[phrase]!;
    }
    const w = this.peek();
    if (!w) this.fail(`ends before ${what}`);
    const guess = nearest(w.text, Object.keys(words.read));
    this.fail(`"${w.text}" is not ${what}${guess ? `. Did you mean "${guess}"?` : ""}. It can be ${Object.keys(words.read).join(", ")}`);
  }

  /** Whether the next phrase is one in the table, without taking it. */
  seesAny(words: Vocab<string>): boolean {
    return Object.keys(words.read).some((p) => this.sees(p));
  }

  /** A color written as # and six hex digits, like #bc0006. */
  color(what: string): string {
    const w = this.next(what);
    if (w.quoted || !/^#[0-9a-f]{6}$/i.test(w.text)) this.fail(`"${w.text}" should be a color like #bc0006 for ${what}`);
    return w.text.toLowerCase();
  }

  /** Whether the next word is a plain number, rather than a percentage or a word. */
  seesNumber(): boolean {
    const w = this.peek();
    return !!w && !w.quoted && /^\d+(\.\d+)?$/.test(w.text);
  }

  /** "+3" or "-3" written as one word, or null where the next word is not one. */
  signed(): number | null {
    const w = this.peek();
    if (!w || w.quoted || !/^[+-]\d+(\.\d+)?$/.test(w.text)) return null;
    this.at += 1;
    return Number(w.text);
  }

  done(): void {
    if (this.empty) return;
    this.fail(`has "${this.words.slice(this.at).map((w) => w.text).join(" ")}" left over`);
  }
}

const clause = (line: Line, i: number, usage: string): Clause =>
  new Clause(line.clauses[i]!, line.no, usage);

/** A line that takes nothing after a comma. */
function single(line: Line, usage: string): Clause {
  if (line.stacked > 0 && usage.endsWith(":")) {
    throw new ScriptError(line.no, `has lines indented under it, so it should end in a colon. It is written: ${usage}`);
  }
  if (line.stacked > 0) {
    throw new ScriptError(line.no, `has lines indented under it, and it takes nothing more. It is written: ${usage}`);
  }
  if (line.clauses.length > 1) throw new ScriptError(line.no, `takes nothing after a comma. It is written: ${usage}`);
  return clause(line, 0, usage);
}

function noBlock(line: Line, usage: string): void {
  if (line.opens) throw new ScriptError(line.no, `does not open a block, so it should not end in a colon. It is written: ${usage}`);
}

function needsBlock(line: Line, usage: string): void {
  if (!line.opens) throw new ScriptError(line.no, `opens a block, so it should end in a colon. It is written: ${usage}`);
  if (line.children.length === 0) throw new ScriptError(line.no, "has nothing indented under it");
}

// --- who a step reaches ---

interface Scope {
  record: string;
  kind: "move" | "status";
  /** A move's target groups, by name. */
  aims: Map<string, number>;
  /** How many rewrites the record has read so far, for naming each one. */
  rewrites: number;
  /** Whether a step above has drawn a card, for the steps that use it. */
  drawn: boolean;
  /** Whether a step above has picked a move, for the steps that use it. */
  picked: boolean;
  refs: Ref[];
}

const TEAM_WORDS: Record<string, Who> = {
  allies: "allies", enemies: "enemies", everyone: "everyone", others: "others",
};

function whoWords(scope: Scope): Record<string, Who> {
  if (scope.kind === "move") {
    const out: Record<string, Who> = { caster: "self", raised: "raised", ...TEAM_WORDS };
    for (const [name, aim] of scope.aims) out[name] = { aim };
    return out;
  }
  return { holder: "self", source: "source", other: "other", ...TEAM_WORDS };
}

function readWho(c: Clause, scope: Scope, what = "who it reaches"): Who {
  const words = whoWords(scope);
  const found = Object.keys(words).find((w) => c.sees(w));
  if (found) {
    c.take(found);
    return words[found]!;
  }
  const w = c.token(what);
  const guess = nearest(w, Object.keys(words));
  return c.fail(`"${w}" is not ${what}${guess ? `. Did you mean "${guess}"?` : ""}. It can be ${Object.keys(words).join(", ")}`);
}

/** "15% of source magic", or "10% of their max hp". */
function readShare(c: Clause, scope: Scope): { basis: Basis; frac: number } {
  const frac = c.percent("the share");
  c.expect("of");
  const sourceWord = scope.kind === "move" ? "caster" : "source";
  let whose: "source" | "holder";
  if (c.take(sourceWord)) whose = "source";
  else if (c.take("their")) whose = "holder";
  else c.fail(`the share should be of "${sourceWord}" or of "their"`);
  let measure: string;
  if (c.take("max hp")) measure = "max-hp";
  else if (c.take("hp")) measure = "hp";
  else {
    const stat = c.vocab(STAT_WORDS, "a stat");
    if (stat !== "str" && stat !== "mag") c.fail("a share can be of strength, magic, max hp or hp");
    measure = stat;
  }
  const basis = `${whose}-${measure}`;
  if (basis === "source-hp") c.fail(`a share of "${sourceWord} hp" is not read. Use "${sourceWord} max hp"`);
  return { basis: basis as Basis, frac };
}

// --- steps ---

const STEP_STARTS = [
  "throw", "show", "sound", "wait", "say", "hit", "damage", "heal", "inflict", "clear", "cleanse", "copy", "raise",
  "take", "summon", "find", "give", "lay", "draw", "deal", "if", "refund", "pick", "change",
];

function readSteps(lines: Line[], scope: Scope): Step[] {
  return lines.map((line) => readStep(line, scope));
}

function readStep(line: Line, scope: Scope): Step {
  const first = line.clauses[0]![0]!;
  const start = first.quoted ? "" : first.text.toLowerCase();
  switch (start) {
    case "throw": return readThrow(line, scope);
    case "show": {
      const usage = "show <art> as <wheel|glow|burst|flames> on <who>, pointer <art>";
      noBlock(line, usage);
      const c = clause(line, 0, usage);
      c.expect("show");
      const art = c.token("the art");
      c.expect("as");
      const path = c.vocab(SHOW_WORDS, "a way to show it");
      if (!c.take("on")) c.expect("over");
      const on = readWho(c, scope);
      c.done();
      const step: Step = { kind: "show", art, path, on };
      for (let i = 1; i < line.clauses.length; i++) {
        const o = clause(line, i, usage);
        o.expect("pointer");
        step.pointer = o.token("the pointer art");
        o.done();
      }
      return step;
    }
    case "sound": {
      const usage = "sound <name>";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("sound");
      const name = c.token("the sound");
      c.done();
      return { kind: "sound", name };
    }
    case "wait": {
      const usage = "wait <seconds> seconds";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("wait");
      const seconds = c.count("how long");
      if (!c.take("seconds")) c.expect("second");
      c.done();
      return { kind: "wait", seconds };
    }
    case "say": {
      const usage = "say \"<words>\"";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("say");
      const text = c.quoted("what it says");
      c.done();
      return { kind: "say", text };
    }
    case "hit": return readHit(line, scope);
    case "damage": return readDamage(line, scope);
    case "heal": {
      const usage = "heal <who> <share> of <whose> <stat>, sound <name>";
      noBlock(line, usage);
      const c = clause(line, 0, usage);
      c.expect("heal");
      const to = readWho(c, scope);
      const { basis, frac } = readShare(c, scope);
      c.done();
      const step: Step = { kind: "heal", to, basis, frac };
      for (let i = 1; i < line.clauses.length; i++) {
        const o = clause(line, i, usage);
        o.expect("sound");
        step.sound = o.token("the sound");
        o.done();
      }
      return step;
    }
    case "inflict": {
      const usage = "inflict <status> on <who>, for <n> turns";
      noBlock(line, usage);
      const c = clause(line, 0, usage);
      c.expect("inflict");
      const status = c.id("the status");
      scope.refs.push({ table: "statuses", id: status, line: line.no });
      c.expect("on");
      const on = readWho(c, scope);
      c.done();
      const step: Step = { kind: "inflict", status, on };
      for (let i = 1; i < line.clauses.length; i++) {
        const o = clause(line, i, usage);
        o.expect("for");
        step.turns = o.count("how many turns");
        if (!o.take("turns")) o.expect("turn");
        o.done();
      }
      return step;
    }
    case "raise": {
      const usage = "raise <who> as a pawn at <share> level, as <element> <element>";
      noBlock(line, usage);
      const c = clause(line, 0, usage);
      c.expect("raise");
      const target = readWho(c, scope);
      c.expect("as a pawn at");
      const levelShare = c.percent("the share of its level");
      if (levelShare <= 0 || levelShare > 1) c.fail("the share of its level should be from 1% to 100%");
      c.expect("level");
      c.done();
      const step: Step = { kind: "raise", who: target, levelShare };
      for (let i = 1; i < line.clauses.length; i++) {
        const o = clause(line, i, usage);
        o.expect("as");
        const types = [o.vocab(ELEMENT_WORDS, "an element")];
        if (o.seesAny(ELEMENT_WORDS)) types.push(o.vocab(ELEMENT_WORDS, "an element"));
        o.done();
        step.types = types;
      }
      return step;
    }
    case "clear": {
      const usage = "clear <status> from <who>";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("clear");
      const status = c.id("the status");
      scope.refs.push({ table: "statuses", id: status, line: line.no });
      c.expect("from");
      const on = readWho(c, scope);
      c.done();
      return { kind: "clear-status", status, on };
    }
    case "cleanse": {
      const usage = "cleanse <good|bad> marks from <who>";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("cleanse");
      const polarity = c.vocab(POLARITY_WORDS, "good or bad");
      c.expect("marks from");
      const on = readWho(c, scope);
      c.done();
      return { kind: "cleanse", on, polarity };
    }
    case "copy": {
      const usage = "copy marks from <who> to <who>";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("copy marks from");
      const from = readWho(c, scope);
      c.expect("to");
      const to = readWho(c, scope);
      c.done();
      return { kind: "copy-marks", from, to };
    }
    case "take": {
      const usage = "take <share> hp from <who>, deal it to <who> | heal <who> with it";
      noBlock(line, usage);
      if (line.clauses.length !== 2) throw new ScriptError(line.no, `says where the HP goes after one comma. It is written: ${usage}`);
      const c = clause(line, 0, usage);
      c.expect("take");
      const frac = c.percent("the share");
      c.expect("hp from");
      const from = readWho(c, scope);
      c.done();
      const o = clause(line, 1, usage);
      if (o.take("deal it to")) {
        const to = readWho(o, scope);
        o.done();
        return { kind: "transfer", from, to, frac, deliver: "damage" };
      }
      o.expect("heal");
      const to = readWho(o, scope);
      o.expect("with it");
      o.done();
      return { kind: "transfer", from, to, frac, deliver: "heal" };
    }
    case "summon": {
      const usage = "summon <species> at level <n>";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("summon");
      const species = c.id("the species");
      scope.refs.push({ table: "species", id: species, line: line.no });
      c.expect("at level");
      const level = c.count("the level");
      c.done();
      return { kind: "summon", species, level };
    }
    case "find": {
      const usage = "find <n> <item>";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("find");
      const count = c.count("how many");
      const item = c.id("the item");
      c.done();
      return { kind: "grant-item", item, count };
    }
    case "give": {
      const usage = "give <who> <n> mana | give <who> picked move as extra | give <who> picked move in slot <n>";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("give");
      const to = readWho(c, scope);
      if (c.take("picked move")) {
        if (!scope.picked) c.fail("nothing has been picked yet. Write \"pick a random move\" above this line");
        if (c.take("as extra")) {
          c.done();
          return { kind: "give-move", to, slot: null };
        }
        c.expect("in slot");
        const slot = c.number("the slot");
        if (!Number.isInteger(slot) || slot < 1) c.fail("the slot should be a whole number from 1");
        c.done();
        return { kind: "give-move", to, slot: slot - 1 };
      }
      const amount = c.count("how much mana");
      c.expect("mana");
      c.done();
      return { kind: "mana", on: to, amount };
    }
    case "lay": {
      const usage = "lay <field> over <its side|the enemy side|both sides>";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("lay");
      const field = c.id("the field");
      scope.refs.push({ table: "fields", id: field, line: line.no });
      c.expect("over");
      const where = c.vocab(FIELD_SCOPE_WORDS, "a side");
      c.done();
      return { kind: "field", field, scope: where };
    }
    case "draw": {
      const usage = "draw a card, swap <color> for <color> <share> of the time";
      noBlock(line, usage);
      const c = clause(line, 0, usage);
      c.expect("draw a card");
      c.done();
      const changes: ChanceColorChange[] = [];
      for (let i = 1; i < line.clauses.length; i++) {
        const o = clause(line, i, usage);
        o.expect("swap");
        const from = o.color("the color it replaces");
        o.expect("for");
        const to = o.color("the color it becomes");
        const chance = o.percent("how often");
        if (chance < 0 || chance > 1) o.fail("how often should be from 0% to 100%");
        o.expect("of the time");
        o.done();
        changes.push({ from, to, chance });
      }
      scope.drawn = true;
      return { kind: "draw-card", changes };
    }
    case "deal": {
      const usage = "deal drawn card to <who>, hand <status>, 21 pays <share> strength";
      noBlock(line, usage);
      const c = clause(line, 0, usage);
      if (c.sees("deal a card")) {
        c.fail("a card is drawn by its own step now. Write \"draw a card\" above this line, then \"deal drawn card to <who>\"");
      }
      c.expect("deal drawn card to");
      if (!scope.drawn) c.fail("nothing has been drawn yet. Write \"draw a card\" above this line");
      const to = readWho(c, scope);
      c.done();
      let hand: string | null = null;
      let payoff: number | null = null;
      for (let i = 1; i < line.clauses.length; i++) {
        const o = clause(line, i, usage);
        if (o.take("hand")) {
          hand = o.id("the status that counts the hand");
          scope.refs.push({ table: "statuses", id: hand, line: line.no });
        } else {
          o.expect("21 pays");
          payoff = o.percent("the payout");
          o.expect("strength");
        }
        o.done();
      }
      if (hand === null || payoff === null) throw new ScriptError(line.no, `needs both a hand and a payout. It is written: ${usage}`);
      return { kind: "deal-card", to, payoff, hand };
    }
    case "if": {
      const usage = "if <who> fell:";
      needsBlock(line, usage);
      const c = single(line, usage);
      c.expect("if");
      const fell = readWho(c, scope);
      c.expect("fell");
      c.done();
      return { kind: "if", fell, then: readSteps(line.children, scope) };
    }
    case "refund": {
      const usage = "refund";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("refund");
      c.done();
      if (scope.kind !== "move") c.fail("only a move has a cost to refund");
      return { kind: "refund" };
    }
    case "pick": {
      const usage = "pick a random move, costing at least <n>, skip once per battle";
      noBlock(line, usage);
      const c = clause(line, 0, usage);
      c.expect("pick a random move");
      c.done();
      const step: Step = { kind: "pick-move", minCost: 0, skipOncePerBattle: false };
      for (let i = 1; i < line.clauses.length; i++) {
        const o = clause(line, i, usage);
        if (o.take("costing at least")) {
          step.minCost = o.count("the lowest cost");
        } else {
          o.expect("skip once per battle");
          step.skipOncePerBattle = true;
        }
        o.done();
      }
      scope.picked = true;
      return step;
    }
    case "change": {
      const usage = "change picked move:";
      needsBlock(line, usage);
      const c = single(line, usage);
      c.expect("change picked move");
      if (!scope.picked) c.fail("nothing has been picked yet. Write \"pick a random move\" above this line");
      c.done();
      const changes = line.children.map(readChange);
      scope.rewrites += 1;
      const key = scope.rewrites === 1 ? scope.record : `${scope.record}.${scope.rewrites}`;
      return { kind: "change-move", changes, key };
    }
    default: return readCasterStep(line, scope);
  }
}

function readChange(line: Line): MoveChange {
  const usage = "set type <element> | set damage <physical|magic> | scale off <strength|magic> | tint <color>"
    + " | set cost x<n> | set name \"<words>\"";
  noBlock(line, usage);
  const c = single(line, usage);
  if (c.take("set type")) {
    const to = c.vocab(ELEMENT_WORDS, "an element");
    c.done();
    return { set: "type", to };
  }
  if (c.take("set damage")) {
    const physical = c.take("physical");
    if (!physical) c.expect("magic");
    c.done();
    return { set: "category", to: physical ? "physical" : "magic" };
  }
  if (c.take("scale off")) {
    const strength = c.take("strength");
    if (!strength) c.expect("magic");
    c.done();
    return { set: "stat", to: strength ? "str" : "mag" };
  }
  if (c.take("tint")) {
    const to = c.color("the tint");
    c.done();
    return { set: "tint", to };
  }
  if (c.take("set cost")) {
    const mult = c.times("how much of its cost it keeps");
    c.done();
    return { set: "cost", mult };
  }
  if (c.take("set name")) {
    const to = c.quoted("the new name");
    if (to.trim() === "") c.fail("the new name cannot be empty");
    c.done();
    return { set: "name", to };
  }
  const written = (line.clauses[0] ?? []).slice(0, 2).map((w) => w.text).join(" ");
  const guess = nearest(written, ["set type", "set damage", "scale off", "tint", "set cost", "set name"]);
  return c.fail(`"${written}" is not a change${guess ? `. Did you mean "${guess}"?` : ""}`);
}

/** "caster lunge" or "caster wears cherryless". */
function readCasterStep(line: Line, scope: Scope): Step {
  const usage = "<who> <shake|lunge|blink|rear|focus> | <who> wears <form>";
  const first = line.clauses[0]![0]!;
  const words = whoWords(scope);
  // Before the line's shape, since a word that starts no step is the thing to say first.
  if (first.quoted || !(first.text.toLowerCase() in words)) {
    const guess = nearest(first.text, [...STEP_STARTS, ...Object.keys(words)]);
    throw new ScriptError(line.no, `"${first.text}" does not start a step${guess ? `. Did you mean "${guess}"?` : ""}.`
      + ` A step starts with ${STEP_STARTS.join(", ")}, or with who moves and how`);
  }
  noBlock(line, usage);
  const c = single(line, usage);
  const who = readWho(c, scope);
  if (c.take("wears")) {
    const form = c.token("the costume");
    c.done();
    return { kind: "wear", who, form };
  }
  const anim = c.vocab(ANIM_WORDS, "an animation");
  c.done();
  return { kind: "motion", who, anim };
}

function readThrow(line: Line, scope: Scope): Step {
  const usage = "throw <art> as <path> from <piece> to <who>, sound <name> | silent";
  noBlock(line, usage);
  const c = clause(line, 0, usage);
  c.expect("throw");
  const step: Step = { kind: "throw", path: "bolt", to: "self" };
  if (c.take("drawn card")) {
    if (!scope.drawn) c.fail("nothing has been drawn yet. Write \"draw a card\" above this line");
    step.drawn = true;
  } else if (!c.sees("as")) {
    step.art = c.token("the art");
  }
  c.expect("as");
  step.path = c.vocab(PATH_WORDS, "a path");
  if (c.take("from")) step.from = c.token("the piece it leaves from");
  c.expect("to");
  step.to = readWho(c, scope);
  c.done();
  for (let i = 1; i < line.clauses.length; i++) {
    const o = clause(line, i, usage);
    if (o.take("silent")) step.sound = null;
    else {
      o.expect("sound");
      step.sound = o.token("the sound");
    }
    o.done();
  }
  return step;
}

function readHit(line: Line, scope: Scope): Step {
  const usage = "hit <who> <share> <stat> + <share> <stat> + <n> at max level"
    + " | hit <who> <n> per level, per stack of <status>, as <element> <physical|magic>, sound <name>";
  noBlock(line, usage);
  const c = clause(line, 0, usage);
  c.expect("hit");
  const to = readWho(c, scope);
  const step: Step = { kind: "hit", to, scaling: [] };
  if (c.seesNumber()) {
    step.perLevel = c.count("the amount per level");
    c.expect("per level");
  } else {
    const scaling: Scaling[] = [];
    for (;;) {
      const scale = c.percent("the share");
      const stat = c.vocab(STAT_WORDS, "a stat");
      scaling.push({ stat, scale });
      if (!c.take("+")) break;
      // A number with no percent after the plus is the flat amount, which ends the list.
      if (c.seesNumber()) {
        step.flatAtCeiling = c.count("the flat amount");
        c.expect("at max level");
        break;
      }
    }
    step.scaling = scaling;
  }
  c.done();
  for (let i = 1; i < line.clauses.length; i++) {
    const o = clause(line, i, usage);
    if (o.take("per stack of")) {
      step.perStackOf = o.id("the status the stacks are counted off");
      scope.refs.push({ table: "statuses", id: step.perStackOf, line: line.no });
    } else if (o.take("sound")) step.sound = o.token("the sound");
    else {
      o.expect("as");
      const named = o.seesAny(ELEMENT_WORDS);
      if (named) step.element = o.vocab(ELEMENT_WORDS, "an element");
      if (o.take("physical")) step.category = "physical";
      else if (o.take("magic")) step.category = "magic";
      else if (!named) o.fail("says what the attack is read as, like \"as sun\" or \"as magic\"");
    }
    o.done();
  }
  return step;
}

function readDamage(line: Line, scope: Scope): Step {
  const usage = "damage <who> <share> of <whose> <stat>, as <element> <physical|magic|true>,"
    + " counts as attack, sets off hits, fixed when applied, sound <name>";
  noBlock(line, usage);
  const c = clause(line, 0, usage);
  c.expect("damage");
  const to = readWho(c, scope);
  const { basis, frac } = readShare(c, scope);
  let flatAtCeiling: number | undefined;
  if (c.take("+")) {
    flatAtCeiling = c.count("the flat amount");
    c.expect("at max level");
  }
  c.done();
  const damage: StatusDamage = {
    basis, frac, element: "plain", category: "true",
    damageClass: scope.kind === "move" ? "attack" : "status",
    triggersOnHit: false, snapshot: false,
  };
  if (flatAtCeiling !== undefined) damage.flatAtCeiling = flatAtCeiling;
  let named = false;
  let sound: string | undefined;
  for (let i = 1; i < line.clauses.length; i++) {
    const o = clause(line, i, usage);
    if (o.take("as")) {
      if (o.seesAny(ELEMENT_WORDS)) damage.element = o.vocab(ELEMENT_WORDS, "an element");
      if (o.take("physical")) damage.category = "physical";
      else if (o.take("magic")) damage.category = "magic";
      else o.expect("true");
      named = true;
    } else if (o.take("counts as")) {
      const attack = o.take("attack");
      if (!attack) o.expect("status");
      damage.damageClass = attack ? "attack" : "status";
    } else if (o.take("sets off hits")) {
      damage.triggersOnHit = true;
    } else if (o.take("fixed when applied")) {
      damage.snapshot = true;
    } else {
      o.expect("sound");
      sound = o.token("the sound");
    }
    o.done();
  }
  if (!named) throw new ScriptError(line.no, `says what kind of damage it is, like "as sun magic" or "as true". It is written: ${usage}`);
  // Written in the order the record has always held them in, so a record reads
  // back exactly as it was.
  const ordered: StatusDamage = {
    basis: damage.basis, frac: damage.frac,
    ...(damage.flatAtCeiling !== undefined ? { flatAtCeiling: damage.flatAtCeiling } : {}),
    element: damage.element, category: damage.category, damageClass: damage.damageClass,
    triggersOnHit: damage.triggersOnHit, snapshot: damage.snapshot,
  };
  return { kind: "damage", to, damage: ordered, ...(sound !== undefined ? { sound } : {}) };
}

// --- standing effects ---

function readStanding(line: Line, forField: boolean): Standing[] {
  const usage = forField
    ? "<element> moves x<n> | immune to <element> | takes x<n> from <element>"
    : "<stat> x<n> | <stat> +<n> | <stat> +<n> after scaling | <stat> = <n> | <stat> + <share> of <stat>"
      + " | <stat> + <share> of base + <n> | <stat> - power | <element> moves x<n> | immune to <element>"
      + " | takes x<n> from <element> | cannot switch out | blocks <element> hits"
      + " | cuts the next hit by <share>"
      + " | marks it leaves hit x<n> if they last <n> turns or more | all stats <change>";
  noBlock(line, usage);
  const c = single(line, usage);
  if (c.take("immune to")) {
    const element = c.vocab(ELEMENT_WORDS, "an element");
    c.done();
    return [{ kind: "immune", element }];
  }
  if (c.take("takes")) {
    const mult = c.times("how much it takes");
    c.expect("from");
    const element = c.vocab(ELEMENT_WORDS, "an element");
    c.done();
    return [{ kind: "vulnerable", element, mult }];
  }
  if (c.seesAny(ELEMENT_WORDS)) {
    const element = c.vocab(ELEMENT_WORDS, "an element");
    c.expect("moves");
    const mult = c.times("how much stronger");
    c.done();
    return [{ kind: "element-power", element, mult }];
  }
  if (forField) {
    const w = c.token("a standing effect");
    c.fail(`"${w}" is not something a field does`);
  }
  if (c.take("cannot switch out")) {
    c.done();
    return [{ kind: "root" }];
  }
  if (c.take("blocks")) {
    const element = c.vocab(ELEMENT_WORDS, "an element");
    c.expect("hits");
    c.done();
    return [{ kind: "ward", element }];
  }
  if (c.take("cuts the next hit by")) {
    const frac = c.percent("how much it cuts");
    if (frac <= 0 || frac > 1) c.fail("how much it cuts should be from 1% to 100%");
    c.done();
    return [{ kind: "soften", frac }];
  }
  if (c.take("marks it leaves hit")) {
    const mult = c.times("how much harder");
    c.expect("if they last");
    const minTurns = c.count("how many turns");
    c.expect("turns or more");
    c.done();
    return [{ kind: "mark-power", mult, minTurns }];
  }
  if (c.take("all stats")) {
    const one = readStatChange(c, "hp");
    c.done();
    return (["hp", "str", "def", "res", "mag", "spd"] as StatName[]).map((stat) => ({ ...one, stat }) as Standing);
  }
  const stat = c.vocab(STAT_WORDS, "a stat, an element, or one of the standing effects");
  const out = readStatChange(c, stat);
  c.done();
  return [out];
}

/** What follows a stat: "x1.25", "+3", "= 10", "+ 10% of magic", "- power" and the rest. */
function readStatChange(c: Clause, stat: StatName): Standing {
  if (c.sees("=")) {
    c.take("=");
    return { kind: "stat-set", stat, value: c.number("the value") };
  }
  const glued = c.signed();
  if (glued !== null) {
    const after = c.take("after scaling");
    return after
      ? { kind: "stat-offset", stat, amount: glued }
      : { kind: "stat-add", stat, amount: glued };
  }
  if (c.take("+") || c.sees("-")) {
    const sign = c.take("-") ? -1 : 1;
    if (c.take("power")) return { kind: "stat-power", stat, mult: sign };
    const frac = c.percent("the share");
    if (c.take("power")) return { kind: "stat-power", stat, mult: sign * frac };
    if (sign < 0) c.fail("a share of a stat or of base can only be added");
    c.expect("of");
    if (c.take("base")) {
      c.expect("+");
      return { kind: "stat-boost", stat, frac, flat: c.number("the flat amount") };
    }
    const from = c.vocab(STAT_WORDS, "a stat");
    return { kind: "stat-share", stat, from, frac };
  }
  return { kind: "stat-scale", stat, mult: c.times("the multiplier") };
}

// --- triggers ---

function readTrigger(c: Clause): StatusTrigger {
  if (c.take("below")) {
    const frac = c.percent("the share of HP");
    c.expect("hp");
    return { on: "hp-below", frac };
  }
  if (c.sees("hit by") && !c.sees("hit by magic") && !c.sees("hit by physical")) {
    c.take("hit by");
    return { on: "hit-element", element: c.vocab(ELEMENT_WORDS, "an element") };
  }
  return { on: c.vocab(TRIGGER_WORDS, "a trigger") };
}

// --- records ---

function header(line: Line, kind: RecordKind): { id: string; name: string } {
  const usage = `${kind} <id> "<name>"`;
  if (line.indent !== 0) throw new ScriptError(line.no, `a ${kind} starts at the left edge`);
  needsNoColon(line, usage);
  const c = single(line, usage);
  const first = line.clauses[0]![0]!;
  if (first.quoted || first.text.toLowerCase() !== kind) {
    c.fail(`every record in this file starts with "${kind}", and this line starts with "${first.text}"`);
  }
  c.expect(kind);
  const id = c.id(`the ${kind}'s id`);
  const name = c.quoted(`the ${kind}'s name`);
  c.done();
  return { id, name };
}

function needsNoColon(line: Line, usage: string): void {
  if (line.opens) throw new ScriptError(line.no, `should not end in a colon. It is written: ${usage}`);
}

/** Says which lines a record takes, for an unknown one. */
function unknownLine(line: Line, known: string[]): never {
  const first = line.clauses[0]![0]!;
  const guess = nearest(first.text, known);
  throw new ScriptError(line.no, `"${first.text}" is not a line this record takes${guess ? `. Did you mean "${guess}"?` : ""}.`
    + ` It takes ${known.join(", ")}`);
}

/** What a move's first hit or heal makes it, wherever it is written. */
export function summarize(cast: Step[]): { kind: Move["kind"]; scale: number } {
  for (const s of cast) {
    if (s.kind === "hit") {
      return {
        kind: hitCategory(s) === "physical" ? "physical" : "magical",
        scale: s.perLevel !== undefined ? 0 : s.scaling[0]?.scale ?? 0,
      };
    }
    if (s.kind === "heal") return { kind: "heal", scale: s.frac };
    if (s.kind === "if") {
      const inner = summarize(s.then);
      if (inner.kind !== "utility") return inner;
    }
  }
  return { kind: "utility", scale: 0 };
}

/**
 * How a hit is mitigated: what it says, or what its first stat makes it. Magic
 * and Resistance are magical, and everything else is physical.
 */
export function hitCategory(s: Extract<Step, { kind: "hit" }>): "physical" | "magic" {
  const first = s.scaling[0]?.stat;
  return s.category ?? (first === "mag" || first === "res" ? "magic" : "physical");
}

function readMove(head: Line, refs: Ref[]): Move {
  const { id, name } = header(head, "move");
  const known = ["type", "costs", "cooldown", "starts on cooldown", "priority", "once per battle", "aim", "text", "cast"];
  let types: Move["type"][] = [];
  let cost: number | null = null;
  let cooldown = 0;
  let startCooldown = 0;
  let priority: number | undefined;
  let once = false;
  let text: string | undefined;
  const targets: TargetSpec[] = [];
  const aims = new Map<string, number>();
  let castLine: Line | null = null;
  for (const line of head.children) {
    const c0 = clause(line, 0, "");
    if (c0.sees("type")) {
      const usage = "type <element>, <element>";
      noBlock(line, usage);
      types = line.clauses.map((_, i) => {
        const c = clause(line, i, usage);
        if (i === 0) c.expect("type");
        const t = c.vocab(ELEMENT_WORDS, "an element");
        c.done();
        return t;
      });
      if (types.length > 2) throw new ScriptError(line.no, "a move has one or two elements");
    } else if (c0.sees("costs")) {
      const c = single(line, "costs <n> mana");
      noBlock(line, "costs <n> mana");
      c.expect("costs");
      cost = c.count("the cost");
      c.expect("mana");
      c.done();
    } else if (c0.sees("cooldown")) {
      const c = single(line, "cooldown <n>");
      noBlock(line, "cooldown <n>");
      c.expect("cooldown");
      cooldown = c.count("the cooldown");
      c.done();
    } else if (c0.sees("starts on cooldown")) {
      const c = single(line, "starts on cooldown <n>");
      noBlock(line, "starts on cooldown <n>");
      c.expect("starts on cooldown");
      startCooldown = c.count("the starting cooldown");
      c.done();
    } else if (c0.sees("priority")) {
      const c = single(line, "priority <n>");
      noBlock(line, "priority <n>");
      c.expect("priority");
      priority = c.number("the priority");
      c.done();
    } else if (c0.sees("once per battle")) {
      const c = single(line, "once per battle");
      noBlock(line, "once per battle");
      c.expect("once per battle");
      c.done();
      once = true;
    } else if (c0.sees("aim")) {
      const usage = "aim <mode> \"<prompt>\" as <name>";
      noBlock(line, usage);
      const c = single(line, usage);
      c.expect("aim");
      const mode = c.vocab(AIM_WORDS, "a way to aim");
      const spec: TargetSpec = { mode };
      if (!c.empty && !c.sees("as")) spec.prompt = c.quoted("the prompt");
      const index = targets.length;
      let aimName = index === 0 ? "target" : `target${index + 1}`;
      if (c.take("as")) aimName = c.id("the name of the target");
      c.done();
      if (aims.has(aimName) || ["caster", "allies", "enemies", "everyone", "others"].includes(aimName)) {
        c.fail(`"${aimName}" already means something here, so pick another name`);
      }
      aims.set(aimName, index);
      targets.push(spec);
    } else if (c0.sees("text")) {
      const c = single(line, "text \"<words>\"");
      noBlock(line, "text \"<words>\"");
      c.expect("text");
      text = c.quoted("the text");
      c.done();
    } else if (c0.sees("cast")) {
      const c = single(line, "cast:");
      needsBlock(line, "cast:");
      c.expect("cast");
      c.done();
      castLine = line;
    } else {
      unknownLine(line, known);
    }
  }
  if (types.length === 0) throw new ScriptError(head.no, `move ${id} needs a "type" line`);
  if (cost === null) throw new ScriptError(head.no, `move ${id} needs a "costs <n> mana" line`);
  if (targets.length === 0) throw new ScriptError(head.no, `move ${id} needs at least one "aim" line`);
  if (!castLine) throw new ScriptError(head.no, `move ${id} needs a "cast:" block`);
  const scope: Scope = { record: id, kind: "move", aims, rewrites: 0, drawn: false, picked: false, refs };
  const cast = readSteps(castLine.children, scope);
  const { kind, scale } = summarize(cast);
  const move: Move = {
    id, name, type: types[0]!,
    ...(types[1] ? { type2: types[1] } : {}),
    kind, scale, manaCost: cost, cooldown, startCooldown, targets, cast,
  };
  if (priority !== undefined) move.priority = priority;
  if (once) move.oncePerBattle = true;
  if (text !== undefined) move.text = text;
  return move;
}

/** The lines a status and a passive share: what it does, and how often. */
interface Behaviour {
  trigger: StatusTrigger;
  standing: Standing[];
  steps: Step[];
  wrote: boolean;
}

function readBehaviour(line: Line, scope: Scope, into: Behaviour): boolean {
  const c0 = clause(line, 0, "");
  if (c0.sees("while carried")) {
    const c = single(line, "while carried:");
    needsBlock(line, "while carried:");
    c.expect("while carried");
    c.done();
    for (const child of line.children) into.standing.push(...readStanding(child, false));
    into.wrote = true;
    return true;
  }
  if (c0.sees("when")) {
    const usage = "when <trigger>:";
    const c = single(line, usage);
    needsBlock(line, usage);
    if (into.trigger.on !== "passive") c.fail("a record answers one trigger, and this one already has a \"when\"");
    c.expect("when");
    into.trigger = readTrigger(c);
    c.done();
    into.steps = readSteps(line.children, scope);
    into.wrote = true;
    return true;
  }
  return false;
}

/** How many damage steps ask to be measured as the status lands, `if` blocks included. */
function snapshots(steps: Step[]): number {
  let n = 0;
  for (const s of steps) {
    if (s.kind === "damage" && s.damage.snapshot) n += 1;
    if (s.kind === "if") n += snapshots(s.then);
  }
  return n;
}

function readStatus(head: Line, refs: Ref[]): StatusDef {
  const { id, name } = header(head, "status");
  const known = [
    "good", "bad", "icon", "sound", "lasts", "charges", "stacks", "lost on switching out",
    "shows a hand of cards", "grows", "power", "while carried", "when",
  ];
  const scope: Scope = { record: id, kind: "status", aims: new Map(), rewrites: 0, drawn: false, picked: false, refs };
  const b: Behaviour = { trigger: { on: "passive" }, standing: [], steps: [], wrote: false };
  const def: StatusDef = {
    id, name, polarity: "good", trigger: { on: "passive" }, duration: null, charges: null,
    stacks: false, maxStacks: 1, persists: true, effects: [],
  };
  let polarity: StatusDef["polarity"] | null = null;
  let power: StatusDef["power"];
  let icon: string | undefined;
  let sound: string | undefined;
  let hand = false;
  let growth: string | undefined;
  let growthEach: number | undefined;
  for (const line of head.children) {
    if (readBehaviour(line, scope, b)) continue;
    const c0 = clause(line, 0, "");
    const plain = (usage: string): Clause => {
      noBlock(line, usage);
      return single(line, usage);
    };
    if (c0.sees("good") || c0.sees("bad")) {
      const c = plain("good | bad");
      polarity = c.vocab(POLARITY_WORDS, "good or bad");
      c.done();
    } else if (c0.sees("icon")) {
      const c = plain("icon <art>");
      c.expect("icon");
      icon = c.token("the icon");
      c.done();
    } else if (c0.sees("sound")) {
      const c = plain("sound <name>");
      c.expect("sound");
      sound = c.token("the sound");
      c.done();
    } else if (c0.sees("lasts")) {
      const c = plain("lasts <n> turns");
      c.expect("lasts");
      def.duration = c.count("how many turns");
      if (!c.take("turns")) c.expect("turn");
      c.done();
    } else if (c0.sees("charges")) {
      const c = plain("charges <n>");
      c.expect("charges");
      def.charges = c.count("how many charges");
      c.done();
    } else if (c0.sees("stacks")) {
      const c = plain("stacks | stacks up to <n>");
      c.expect("stacks");
      def.stacks = true;
      def.maxStacks = c.take("up to") ? c.count("the most stacks") : 99;
      c.done();
    } else if (c0.sees("lost on switching out")) {
      const c = plain("lost on switching out");
      c.expect("lost on switching out");
      c.done();
      def.persists = false;
    } else if (c0.sees("shows a hand of cards")) {
      const c = plain("shows a hand of cards");
      c.expect("shows a hand of cards");
      c.done();
      hand = true;
    } else if (c0.sees("grows")) {
      const c = plain("grows <n> <art>");
      c.expect("grows");
      if (c.seesNumber()) growthEach = c.count("how many pieces a stack grows");
      growth = c.token("the art it grows");
      c.done();
    } else if (c0.sees("power")) {
      const c = plain("power <share> of <whose> <stat>");
      c.expect("power");
      power = readShare(c, scope);
      c.done();
    } else {
      unknownLine(line, known);
    }
  }
  if (polarity === null) throw new ScriptError(head.no, `status ${id} needs a "good" or "bad" line`);
  // One instance keeps one measured number, so a "power" line and a snapshotted
  // damage step would be the same number read two ways.
  if ((power ? 1 : 0) + snapshots(b.steps) > 1) {
    throw new ScriptError(head.no, `status ${id} measures one number as it lands, so it takes a "power" line`
      + " or one damage step marked \"fixed when applied\", and not both");
  }
  def.polarity = polarity;
  def.trigger = b.trigger;
  if (power) def.power = power;
  def.effects = [...b.standing, ...b.steps];
  if (icon !== undefined) def.icon = icon;
  if (sound !== undefined) def.sound = sound;
  if (hand) def.hand = true;
  if (growth !== undefined) def.growth = growth;
  if (growthEach !== undefined) def.growthEach = growthEach;
  return def;
}

function readPassive(head: Line, refs: Ref[]): { ability: Ability; status: StatusDef | null } {
  const { id, name } = header(head, "passive");
  const known = ["text", "wears", "grants move", "once per battle", "charges", "while carried", "when"];
  const scope: Scope = { record: id, kind: "status", aims: new Map(), rewrites: 0, drawn: false, picked: false, refs };
  const b: Behaviour = { trigger: { on: "passive" }, standing: [], steps: [], wrote: false };
  const ability: Ability = { id, name };
  let charges: number | null = null;
  let grants: string | undefined;
  let wears: string | undefined;
  let text: string | undefined;
  for (const line of head.children) {
    if (readBehaviour(line, scope, b)) continue;
    const c0 = clause(line, 0, "");
    const plain = (usage: string): Clause => {
      noBlock(line, usage);
      return single(line, usage);
    };
    if (c0.sees("text")) {
      const c = plain("text \"<words>\"");
      c.expect("text");
      text = c.quoted("the text");
      c.done();
    } else if (c0.sees("wears")) {
      const c = plain("wears <accessory>");
      c.expect("wears");
      wears = c.token("the accessory");
      c.done();
    } else if (c0.sees("grants move")) {
      const c = plain("grants move <move>");
      c.expect("grants move");
      grants = c.id("the move");
      refs.push({ table: "moves", id: grants, line: line.no });
      c.done();
    } else if (c0.sees("once per battle")) {
      const c = plain("once per battle");
      c.expect("once per battle");
      c.done();
      if (charges !== null) c.fail("a passive says how often it goes off once");
      charges = 1;
    } else if (c0.sees("charges")) {
      const c = plain("charges <n>");
      c.expect("charges");
      const many = c.count("how many charges");
      c.done();
      if (charges !== null) c.fail("a passive says how often it goes off once");
      charges = many;
    } else {
      unknownLine(line, known);
    }
  }
  if (!b.wrote) ability.statuses = [];
  if (grants !== undefined) ability.grantsMove = grants;
  if (wears !== undefined) ability.accessory = wears;
  if (text !== undefined) ability.text = text;
  const status: StatusDef | null = b.wrote
    ? {
      id, name, polarity: "good", trigger: b.trigger, duration: null, charges,
      stacks: false, maxStacks: 1, persists: true, innate: true,
      effects: [...b.standing, ...b.steps],
    }
    : null;
  return { ability, status };
}

function readField(head: Line): FieldDef {
  const { id, name } = header(head, "field");
  const known = ["icon", "lasts", "tint", "begins", "ends", "while standing"];
  let duration: number | null = null;
  let tint: string | null = null;
  let onset: string | null = null;
  let lifts: string | null = null;
  let icon: string | undefined;
  const effects: FieldEffect[] = [];
  for (const line of head.children) {
    const c0 = clause(line, 0, "");
    const plain = (usage: string): Clause => {
      noBlock(line, usage);
      return single(line, usage);
    };
    if (c0.sees("icon")) {
      const c = plain("icon <art>");
      c.expect("icon");
      icon = c.token("the icon");
      c.done();
    } else if (c0.sees("lasts")) {
      const c = plain("lasts <n> turns");
      c.expect("lasts");
      duration = c.count("how many turns");
      if (!c.take("turns")) c.expect("turn");
      c.done();
    } else if (c0.sees("tint")) {
      const c = plain("tint <color>");
      c.expect("tint");
      tint = c.color("the tint");
      c.done();
    } else if (c0.sees("begins")) {
      const c = plain("begins \"<words>\"");
      c.expect("begins");
      onset = c.quoted("what the log says as it begins");
      c.done();
    } else if (c0.sees("ends")) {
      const c = plain("ends \"<words>\"");
      c.expect("ends");
      lifts = c.quoted("what the log says as it ends");
      c.done();
    } else if (c0.sees("while standing")) {
      const c = single(line, "while standing:");
      needsBlock(line, "while standing:");
      c.expect("while standing");
      c.done();
      for (const child of line.children) effects.push(...(readStanding(child, true) as FieldEffect[]));
    } else {
      unknownLine(line, known);
    }
  }
  if (tint === null || onset === null || lifts === null) {
    throw new ScriptError(head.no, `field ${id} needs "tint", "begins" and "ends" lines`);
  }
  return { id, name, duration, tint, ...(icon !== undefined ? { icon } : {}), onset, lifts, effects };
}

/**
 * Reads every record in one file's text. A record with a mistake in it is left
 * out and the mistake is reported, so one broken record does not hide the rest.
 */
export function readScript(text: string, kind: RecordKind, firstLine = 1): ReadResult {
  const out: ReadResult = { moves: [], statuses: [], abilities: [], fields: [], problems: [], refs: [], lines: {} };
  let roots: Line[];
  try {
    roots = readLines(text, firstLine);
  } catch (err) {
    if (err instanceof ScriptError) {
      out.problems.push({ line: err.line, says: err.says });
      return out;
    }
    throw err;
  }
  for (const head of roots) {
    const refs: Ref[] = [];
    try {
      switch (kind) {
        case "move": out.moves.push(readMove(head, refs)); break;
        case "status": out.statuses.push(readStatus(head, refs)); break;
        case "passive": {
          const { ability, status } = readPassive(head, refs);
          out.abilities.push(ability);
          if (status) out.statuses.push(status);
          break;
        }
        case "field": out.fields.push(readField(head)); break;
      }
      out.refs.push(...refs);
      const id = head.clauses[0]?.[1]?.text;
      if (id) out.lines[id] = head.no;
    } catch (err) {
      if (!(err instanceof ScriptError)) throw err;
      out.problems.push({ line: err.line, says: err.says });
    }
  }
  return out;
}
