// Writes records back out as move script, in the same phrases `read.ts` reads.
//
// Reading what this writes gives back the record it was written from, which is
// what `tests/script.test.ts` holds it to.
import type { Ability, Move } from "../species";
import type {
  Basis, FieldDef, HobbyDef, MoveChange, Standing, StatusDef, StatusEffect, StatusTrigger, Step, Who,
} from "../status";
import { isContinuous } from "../status";
import { STAT_NAMES } from "../types";
import {
  AIM_WORDS, FIELD_SCOPE_WORDS, STAT_WORDS, TRIGGER_WORDS,
} from "./words";

const INDENT = "  ";

/** A number without the noise floating point leaves on a share. */
const num = (n: number): string => String(Number(n.toFixed(6)));
const pct = (f: number): string => `${num(f * 100)}%`;
const times = (m: number): string => `x${num(m)}`;
const signed = (n: number): string => `${n >= 0 ? "+" : "-"}${num(Math.abs(n))}`;

/** Text in double quotes, with the quotes and backslashes in it escaped. */
export const quote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;

/**
 * A move's or a passive's script with its `text` line saying `words`, or with no
 * `text` line where `words` is null. Every other line stays as it was written. A
 * new line goes where the writers below put one: before `cast:` in a move, and
 * under the header in a passive.
 */
export function withTextLine(record: string, words: string | null): string {
  const rows = record.split(/\r?\n/);
  // Notes written above a record belong to its block, so the header is the first line that is not one.
  const head = rows.findIndex((r) => r.trim() !== "" && !r.startsWith("#"));
  if (head < 0) return record;
  const child = rows.slice(head + 1).find((r) => r.trim() !== "" && !r.trim().startsWith("#"));
  const pad = child?.match(/^[ \t]+/)?.[0] ?? INDENT;
  const topLevel = (i: number, word: RegExp): boolean => {
    const r = rows[i]!;
    return i > head && r.startsWith(pad) && !/^[ \t]/.test(r.slice(pad.length)) && word.test(r.slice(pad.length));
  };
  const line = words === null ? null : `${pad}text ${quote(words)}`;
  const at = rows.findIndex((_, i) => topLevel(i, /^text\b/i));
  if (at >= 0) {
    if (line === null) rows.splice(at, 1);
    else rows[at] = line;
    return rows.join("\n");
  }
  if (line === null) return record;
  const cast = /^move\b/i.test(rows[head]!) ? rows.findIndex((_, i) => topLevel(i, /^cast\s*:/i)) : -1;
  rows.splice(cast >= 0 ? cast : head + 1, 0, line);
  return rows.join("\n");
}

/** A name written bare where it can be, and quoted where it has spaces or commas in it. */
const bare = (s: string): string => (/^[A-Za-z0-9_#.-]+$/.test(s) ? s : quote(s));

interface Names {
  kind: "move" | "status";
  /** A move's target groups, by index. */
  aims: string[];
}

function who(w: Who, names: Names): string {
  if (typeof w === "object") {
    if ("aim" in w) return names.aims[w.aim] ?? `target${w.aim + 1}`;
    if ("next" in w) return `next ${w.next} scoba from ${who(w.from, names)}`;
    return `${who(w.first, names)} or ${who(w.then, names)}`;
  }
  switch (w) {
    case "self": return names.kind === "move" ? "caster" : "holder";
    case "field-allies": return "allies on the field";
    case "field-enemies": return "enemies on the field";
    case "ally-scobas": return "ally scobas";
    case "enemy-scobas": return "enemy scobas";
    default: return w;
  }
}

function share(basis: Basis, frac: number, names: Names): string {
  const [whose, ...rest] = basis.split("-");
  const measure = rest.join("-");
  const owner = whose === "source" ? (names.kind === "move" ? "caster" : "source") : "their";
  const what = measure === "max-hp" ? "max hp" : measure === "hp" ? "hp" : STAT_WORDS.write[measure as "str" | "mag"];
  return `${pct(frac)} of ${owner} ${what}`;
}

function trigger(t: StatusTrigger): string {
  switch (t.on) {
    case "passive": return "";
    case "hit-element": return `hit by ${t.element}`;
    case "deal-element": return `it lands ${t.element}${t.category !== undefined ? ` ${t.category}` : ""}`;
    case "hp-below": return `below ${pct(t.frac)} hp`;
    default: return TRIGGER_WORDS.write[t.on];
  }
}

function change(c: MoveChange): string {
  switch (c.set) {
    case "type": return `set type ${c.to}`;
    case "category": return `set damage ${c.to}`;
    case "stat": return `scale off ${c.to === "str" ? "strength" : "magic"}`;
    case "tint": return `tint ${bare(c.to)}`;
    case "cost": return `set cost ${times(c.mult)}`;
    case "name": return `set name ${quote(c.to)}`;
  }
}

/** One step, and whatever is indented under it, as lines at a depth. */
function stepLines(s: Step, names: Names, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const line = (text: string): string[] => [`${pad}${text}`];
  switch (s.kind) {
    case "hit": {
      const shares = s.scaling.map((x) => `${pct(x.scale)} ${STAT_WORDS.write[x.stat]}`).join(" + ");
      const amount = s.perLevel !== undefined
        ? `${num(s.perLevel)} per level`
        : `${shares}${s.flatAtCeiling !== undefined ? ` + ${num(s.flatAtCeiling)} at max level` : ""}`;
      const opts: string[] = [];
      if (s.perStackOf !== undefined) opts.push(`per stack of ${s.perStackOf}`);
      if (s.element !== undefined || s.category !== undefined) {
        opts.push(`as${s.element ? ` ${s.element}` : ""}${s.category ? ` ${s.category}` : ""}`);
      }
      if (s.sound !== undefined) opts.push(`sound ${bare(s.sound)}`);
      return line([`hit ${who(s.to, names)} ${amount}`, ...opts].join(", "));
    }
    case "damage": {
      const d = s.damage;
      const flat = d.flatAtCeiling !== undefined ? ` + ${num(d.flatAtCeiling)} at max level` : "";
      const opts: string[] = [];
      opts.push(d.category === "true" && d.element === "plain" ? "as true" : `as ${d.element} ${d.category}`);
      const defaultClass = names.kind === "move" ? "attack" : "status";
      if (d.damageClass !== defaultClass) opts.push(`counts as ${d.damageClass}`);
      if (d.triggersOnHit) opts.push("sets off hits");
      if (d.snapshot) opts.push("fixed when applied");
      if (s.sound !== undefined) opts.push(`sound ${bare(s.sound)}`);
      return line([`damage ${who(s.to, names)} ${share(d.basis, d.frac, names)}${flat}`, ...opts].join(", "));
    }
    case "heal":
      return line(`heal ${who(s.to, names)} ${share(s.basis, s.frac, names)}${s.sound !== undefined ? `, sound ${bare(s.sound)}` : ""}`);
    case "inflict":
      return line(`inflict ${s.status} on ${who(s.on, names)}`
        + `${s.turns !== undefined ? `, for ${num(s.turns)} turn${s.turns === 1 ? "" : "s"}` : ""}`);
    case "cleanse": return line(`cleanse ${s.polarity} marks from ${who(s.on, names)}`);
    case "clear-status": return line(`clear ${s.status} from ${who(s.on, names)}`);
    case "undo-round":
      return line(`undo what ${who(s.on, names)} takes this round${s.mark ? `, marked ${s.mark}` : ""}`);
    case "rewind": return line(`rewind ${num(s.turns)} turn${s.turns === 1 ? "" : "s"}`);
    case "travel":
      return line(`travel back ${num(s.turns)} turn${s.turns === 1 ? "" : "s"}`
        + `${s.discount > 0 ? `, ${num(s.discount)} mana off` : ""}`
        + `${s.art !== undefined ? `, riding ${bare(s.art)}` : ""}`);
    case "raise": {
      const as = s.types !== undefined ? `, as ${s.types.join(" ")}` : "";
      return line(`raise ${who(s.who, names)} as a pawn at ${pct(s.levelShare)} level${as}`);
    }
    case "copy-marks": return line(`copy marks from ${who(s.from, names)} to ${who(s.to, names)}`);
    case "transfer":
      return line(`take ${pct(s.frac)} hp from ${who(s.from, names)}, ${s.deliver === "damage"
        ? `deal it to ${who(s.to, names)}`
        : `heal ${who(s.to, names)} with it`}`);
    case "summon": return line(`summon ${s.species} at level ${num(s.level)}`);
    case "grant-item": return line(`find ${num(s.count)} ${s.item}`);
    case "mana": return line(`give ${who(s.on, names)} ${num(s.amount)} mana${s.second ? ", second bar" : ""}`);
    case "field": return line(`lay ${s.field} over ${FIELD_SCOPE_WORDS.write[s.scope]}`);
    case "draw-card":
      return line(["draw a card", ...s.changes.map((c) => `swap ${c.from} for ${c.to} ${pct(c.chance)} of the time`)].join(", "));
    case "deal-card":
      return line(`deal drawn card to ${who(s.to, names)}, hand ${s.hand}, 21 pays ${pct(s.payoff)} strength`);
    case "if":
      return [`${pad}if ${who(s.fell, names)} fell:`, ...s.then.flatMap((t) => stepLines(t, names, depth + 1))];
    case "refund": return line("refund");
    case "pick-move": {
      const opts: string[] = [];
      if (s.minCost > 0) opts.push(`costing at least ${num(s.minCost)}`);
      if (s.skipOncePerBattle) opts.push("skip once per battle");
      return line(["pick a random move", ...opts].join(", "));
    }
    case "change-move":
      return [`${pad}change picked move:`, ...s.changes.map((c) => `${pad}${INDENT}${change(c)}`)];
    case "give-move":
      return line(`give ${who(s.to, names)} ${s.move ?? "picked move"}`
        + ` ${s.slot === null ? "as extra" : `in slot ${s.slot + 1}`}`);
    case "say": return line(`say ${quote(s.text)}`);
    case "wear": return line(`${who(s.who, names)} wears ${bare(s.form)}`);
    case "motion": {
      const long = s.seconds !== undefined ? `, for ${num(s.seconds)} second${s.seconds === 1 ? "" : "s"}` : "";
      return line(`${who(s.who, names)} ${s.anim}${long}`);
    }
    case "throw": {
      const art = s.drawn ? " drawn card" : s.art !== undefined ? ` ${bare(s.art)}` : "";
      const from = s.from !== undefined ? ` from ${bare(s.from)}` : "";
      const sound = s.sound === null ? ", silent" : s.sound !== undefined ? `, sound ${bare(s.sound)}` : "";
      const off = s.off !== undefined ? `, off ${who(s.off, names)}` : "";
      return line(`throw${art} as ${s.path}${from} to ${who(s.to, names)}${sound}${off}`);
    }
    case "show": {
      const place = s.path === "wheel" || s.path === "clock" ? "over" : "on";
      const hands = (s.pointers ?? []).map((h) => `, pointer ${bare(h)}`).join("");
      return line(`show ${bare(s.art)} as ${s.path} ${place} ${who(s.on, names)}${hands}`);
    }
    case "sound": return line(`sound ${bare(s.name)}`);
    case "flash":
      return line(`flash ${s.color} for ${num(s.seconds)} second${s.seconds === 1 ? "" : "s"}`);
    case "wait": return line(`wait ${num(s.seconds)} second${s.seconds === 1 ? "" : "s"}`);
  }
}

function standingLine(e: Standing): string {
  switch (e.kind) {
    case "stat-add": return `${STAT_WORDS.write[e.stat]} ${signed(e.amount)}`;
    case "stat-offset": return `${STAT_WORDS.write[e.stat]} ${signed(e.amount)} after scaling`;
    case "stat-set": return `${STAT_WORDS.write[e.stat]} = ${num(e.value)}`;
    case "stat-share": return `${STAT_WORDS.write[e.stat]} + ${pct(e.frac)} of ${STAT_WORDS.write[e.from]}`;
    case "stat-scale": return `${STAT_WORDS.write[e.stat]} ${times(e.mult)}`;
    case "stat-boost": return `${STAT_WORDS.write[e.stat]} + ${pct(e.frac)} of base + ${num(e.flat)}`;
    case "stat-power": {
      const size = Math.abs(e.mult) === 1 ? "power" : `${pct(Math.abs(e.mult))} power`;
      return `${STAT_WORDS.write[e.stat]} ${e.mult < 0 ? "-" : "+"} ${size}`;
    }
    case "immune": return `immune to ${e.element}`;
    case "vulnerable": return `takes ${times(e.mult)} from ${e.element}`;
    case "frail": return `takes ${times(e.mult)} from everything`;
    case "element-power": return `${e.element} moves ${times(e.mult)}`;
    case "root": return "cannot switch out";
    case "no-hyper": return "cannot enter hyper-mode";
    case "echo": return `casts again at ${pct(e.frac)}`;
    case "ward": return `blocks ${e.element} hits`;
    case "soften": return `cuts the next hit by ${pct(e.frac)}`;
    case "mark-power": return `marks it leaves hit ${times(e.mult)} if they last ${num(e.minTurns)} turns or more`;
    case "mark-worth": {
      const where = e.reach === "self" ? "it carries" : `on ${e.reach}`;
      return `${e.polarity} marks ${where} hit ${times(e.mult)}${e.shown !== undefined ? `, shown as ${e.shown}` : ""}`;
    }
    case "heal-bonus": return `heals on allies + ${num(e.flatAtCeiling)} at max level`;
  }
}

/** Standing effects as lines, with a run of the same change to every stat written once. */
function standingLines(effects: Standing[], depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const out: string[] = [];
  let i = 0;
  while (i < effects.length) {
    const run = effects.slice(i, i + STAT_NAMES.length);
    const first = run[0]!;
    const sameAll = run.length === STAT_NAMES.length
      && "stat" in first
      && run.every((e, k) => "stat" in e && e.stat === STAT_NAMES[k]
        && JSON.stringify({ ...e, stat: "" }) === JSON.stringify({ ...first, stat: "" }));
    if (sameAll && first.kind !== "stat-share") {
      out.push(`${pad}all stats ${standingLine(first).split(" ").slice(1).join(" ")}`);
      i += STAT_NAMES.length;
      continue;
    }
    out.push(`${pad}${standingLine(effects[i]!)}`);
    i += 1;
  }
  return out;
}

function split(effects: StatusEffect[]): { standing: Standing[]; steps: Step[] } {
  return {
    standing: effects.filter((e): e is Standing => isContinuous(e.kind)),
    steps: effects.filter((e): e is Step => !isContinuous(e.kind)),
  };
}

function behaviourLines(def: StatusDef): string[] {
  const { standing, steps } = split(def.effects);
  const out: string[] = [];
  if (standing.length > 0) out.push(`${INDENT}while carried:`, ...standingLines(standing, 2));
  if (def.trigger.on !== "passive") {
    out.push(`${INDENT}when ${trigger(def.trigger)}:`);
    out.push(...steps.flatMap((s) => stepLines(s, { kind: "status", aims: [] }, 2)));
  }
  for (const block of def.also ?? []) {
    out.push(`${INDENT}when ${trigger(block.trigger)}:`);
    out.push(...block.steps.flatMap((s) => stepLines(s, { kind: "status", aims: [] }, 2)));
  }
  return out;
}

export function writeMove(m: Move, aimNames?: string[]): string {
  const aims = m.targets.map((_, i) => aimNames?.[i] ?? (i === 0 ? "target" : `target${i + 1}`));
  const out = [`move ${m.id} ${quote(m.name)}`];
  out.push(`${INDENT}type ${m.type}${m.type2 ? `, ${m.type2}` : ""}`);
  out.push(`${INDENT}costs ${num(m.manaCost)} mana`);
  if (m.cooldown > 0) out.push(`${INDENT}cooldown ${num(m.cooldown)}`);
  if (m.startCooldown > 0) out.push(`${INDENT}starts on cooldown ${num(m.startCooldown)}`);
  if (m.priority !== undefined) out.push(`${INDENT}priority ${num(m.priority)}`);
  if (m.oncePerBattle) out.push(`${INDENT}once per battle`);
  m.targets.forEach((t, i) => {
    const prompt = t.prompt !== undefined ? ` ${quote(t.prompt)}` : "";
    const named = aims[i] !== (i === 0 ? "target" : `target${i + 1}`) ? ` as ${aims[i]}` : "";
    out.push(`${INDENT}aim ${AIM_WORDS.write[t.mode]}${prompt}${named}`);
  });
  if (m.text !== undefined) out.push(`${INDENT}text ${quote(m.text)}`);
  out.push(`${INDENT}cast:`);
  out.push(...m.cast.flatMap((s) => stepLines(s, { kind: "move", aims }, 2)));
  return out.join("\n");
}

export function writeStatus(s: StatusDef): string {
  const out = [`status ${s.id} ${quote(s.name)}`];
  out.push(`${INDENT}${s.polarity}`);
  if (s.text !== undefined) out.push(`${INDENT}text ${quote(s.text)}`);
  if (s.icon !== undefined) out.push(`${INDENT}icon ${bare(s.icon)}`);
  if (s.sound !== undefined) out.push(`${INDENT}sound ${bare(s.sound)}`);
  if (s.duration !== null) out.push(`${INDENT}lasts ${num(s.duration)} turn${s.duration === 1 ? "" : "s"}`);
  if (s.charges !== null) out.push(`${INDENT}charges ${num(s.charges)}`);
  if (s.stacks) out.push(`${INDENT}stacks${s.maxStacks >= 99 ? "" : ` up to ${num(s.maxStacks)}`}`);
  if (!s.persists) out.push(`${INDENT}lost on switching out`);
  if (s.hand) out.push(`${INDENT}shows a hand of cards`);
  if (s.unseen) out.push(`${INDENT}no sigil`);
  if (s.asWritten) out.push(`${INDENT}always as written`);
  if (s.growth !== undefined) {
    out.push(`${INDENT}grows ${s.growthEach === undefined ? "" : `${num(s.growthEach)} `}${bare(s.growth)}`);
  }
  if (s.power) out.push(`${INDENT}power ${share(s.power.basis, s.power.frac, { kind: "status", aims: [] })}`);
  out.push(...behaviourLines(s));
  return out.join("\n");
}

/** A passive, with the status it is carried as where it has one. */
export function writePassive(a: Ability, status: StatusDef | null): string {
  const out = [`passive ${a.id} ${quote(a.name)}`];
  if (a.text !== undefined) out.push(`${INDENT}text ${quote(a.text)}`);
  if (status?.icon !== undefined) out.push(`${INDENT}icon ${bare(status.icon)}`);
  if (a.accessory !== undefined) out.push(`${INDENT}wears ${bare(a.accessory)}`);
  if (a.grantsMove !== undefined) out.push(`${INDENT}grants move ${a.grantsMove}`);
  if (status?.basicAttack) out.push(`${INDENT}basic attack is ${status.basicAttack}`);
  if (status?.fuses) out.push(`${INDENT}fuses with ${status.fuses.partner} into ${status.fuses.into}`);
  if (status) {
    if (status.charges === 1) out.push(`${INDENT}once per battle`);
    else if (status.charges !== null) out.push(`${INDENT}charges ${num(status.charges)}`);
    out.push(...behaviourLines(status));
  }
  return out.join("\n");
}

export function writeHobby(h: HobbyDef): string {
  const out = [`hobby ${h.id} ${quote(h.name)}`];
  out.push(`${INDENT}doing ${quote(h.doing)}`);
  out.push(`${INDENT}text ${quote(h.text)}`);
  if (h.effects.length > 0) out.push(`${INDENT}while carried:`, ...standingLines(h.effects, 2));
  return out.join("\n");
}

export function writeField(f: FieldDef): string {
  const out = [`field ${f.id} ${quote(f.name)}`];
  if (f.icon !== undefined) out.push(`${INDENT}icon ${bare(f.icon)}`);
  if (f.duration !== null) out.push(`${INDENT}lasts ${num(f.duration)} turn${f.duration === 1 ? "" : "s"}`);
  out.push(`${INDENT}tint ${bare(f.tint)}`);
  out.push(`${INDENT}begins ${quote(f.onset)}`);
  out.push(`${INDENT}ends ${quote(f.lifts)}`);
  if (f.effects.length > 0) out.push(`${INDENT}while standing:`, ...standingLines(f.effects, 2));
  return out.join("\n");
}
