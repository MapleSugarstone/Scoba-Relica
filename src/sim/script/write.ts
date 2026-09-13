// Writes records back out as move script, in the same phrases `read.ts` reads.
//
// Reading what this writes gives back the record it was written from, which is
// what `tests/script.test.ts` holds it to.
import type { Ability, Move } from "../species";
import type {
  Basis, FieldDef, MoveChange, Standing, StatusDef, StatusEffect, StatusTrigger, Step, Who,
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

/** A name written bare where it can be, and quoted where it has spaces or commas in it. */
const bare = (s: string): string => (/^[A-Za-z0-9_#.-]+$/.test(s) ? s : quote(s));

interface Names {
  kind: "move" | "status";
  /** A move's target groups, by index. */
  aims: string[];
}

function who(w: Who, names: Names): string {
  if (typeof w === "object") return names.aims[w.aim] ?? `target${w.aim + 1}`;
  switch (w) {
    case "self": return names.kind === "move" ? "caster" : "holder";
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
      const amount = s.perLevel !== undefined
        ? `${num(s.perLevel)} per level`
        : s.scaling.map((x) => `${pct(x.scale)} ${STAT_WORDS.write[x.stat]}`).join(" + ");
      const opts: string[] = [];
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
    case "copy-marks": return line(`copy marks from ${who(s.from, names)} to ${who(s.to, names)}`);
    case "transfer":
      return line(`take ${pct(s.frac)} hp from ${who(s.from, names)}, ${s.deliver === "damage"
        ? `deal it to ${who(s.to, names)}`
        : `heal ${who(s.to, names)} with it`}`);
    case "summon": return line(`summon ${s.species} at level ${num(s.level)}`);
    case "grant-item": return line(`find ${num(s.count)} ${s.item}`);
    case "mana": return line(`give ${who(s.on, names)} ${num(s.amount)} mana`);
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
      return line(`give ${who(s.to, names)} picked move ${s.slot === null ? "as extra" : `in slot ${s.slot + 1}`}`);
    case "say": return line(`say ${quote(s.text)}`);
    case "wear": return line(`${who(s.who, names)} wears ${bare(s.form)}`);
    case "motion": return line(`${who(s.who, names)} ${s.anim}`);
    case "throw": {
      const art = s.drawn ? " drawn card" : s.art !== undefined ? ` ${bare(s.art)}` : "";
      const from = s.from !== undefined ? ` from ${bare(s.from)}` : "";
      const sound = s.sound === null ? ", silent" : s.sound !== undefined ? `, sound ${bare(s.sound)}` : "";
      return line(`throw${art} as ${s.path}${from} to ${who(s.to, names)}${sound}`);
    }
    case "show": {
      const place = s.path === "wheel" ? "over" : "on";
      const pointer = s.pointer !== undefined ? `, pointer ${bare(s.pointer)}` : "";
      return line(`show ${bare(s.art)} as ${s.path} ${place} ${who(s.on, names)}${pointer}`);
    }
    case "sound": return line(`sound ${bare(s.name)}`);
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
    case "element-power": return `${e.element} moves ${times(e.mult)}`;
    case "root": return "cannot switch out";
    case "ward": return `blocks ${e.element} hits`;
    case "mark-power": return `marks it leaves hit ${times(e.mult)} if they last ${num(e.minTurns)} turns or more`;
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
  if (s.icon !== undefined) out.push(`${INDENT}icon ${bare(s.icon)}`);
  if (s.sound !== undefined) out.push(`${INDENT}sound ${bare(s.sound)}`);
  if (s.duration !== null) out.push(`${INDENT}lasts ${num(s.duration)} turn${s.duration === 1 ? "" : "s"}`);
  if (s.charges !== null) out.push(`${INDENT}charges ${num(s.charges)}`);
  if (s.stacks) out.push(`${INDENT}stacks${s.maxStacks >= 99 ? "" : ` up to ${num(s.maxStacks)}`}`);
  if (!s.persists) out.push(`${INDENT}lost on switching out`);
  if (s.hand) out.push(`${INDENT}shows a hand of cards`);
  if (s.power) out.push(`${INDENT}power ${share(s.power.basis, s.power.frac, { kind: "status", aims: [] })}`);
  out.push(...behaviourLines(s));
  return out.join("\n");
}

/** A passive, with the status it is carried as where it has one. */
export function writePassive(a: Ability, status: StatusDef | null): string {
  const out = [`passive ${a.id} ${quote(a.name)}`];
  if (a.text !== undefined) out.push(`${INDENT}text ${quote(a.text)}`);
  if (a.accessory !== undefined) out.push(`${INDENT}wears ${bare(a.accessory)}`);
  if (a.grantsMove !== undefined) out.push(`${INDENT}grants move ${a.grantsMove}`);
  if (status) {
    if (status.charges === 1) out.push(`${INDENT}once per battle`);
    else if (status.charges !== null) out.push(`${INDENT}charges ${num(status.charges)}`);
    out.push(...behaviourLines(status));
  }
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
