// What the roster actually covers, counted off the content files.
//
// A unique kit gives every mechanic exactly one holder on the day it is
// written, and a mechanic with one holder is a Scoba nobody can build a team
// without. This counts the mechanics rather than trusting a spreadsheet, so
// the gaps and the monopolies are visible while a line is being designed.
// `claude-notes/roster-coverage.md` holds the rules it is counting against.
//
// Nothing here is ever loaded by the game: it is read by `npm run coverage`.
import {
  ABILITIES, MOVES, SPECIES, abilityStatuses, allSteps, rosterSpecies,
  type Move, type RosterRole, type Species,
} from "../sim/species";
import { STATUSES, isContinuous, type Standing, type Step, type StatusEffect, type Who } from "../sim/status";
import type { TargetMode } from "../sim/targeting";
import { ROSTER_ROLES } from "../sim/species";
import { TYPE_LABELS, type ElementType } from "../sim/types";

/** A mechanic worth counting: something that changes how a fight is played. */
export type Mechanic =
  | "area-damage" | "damage-over-time" | "drain"
  | "self-sustain" | "ally-heal" | "status-removal"
  | "damage-cut" | "protect-ally" | "immunity" | "redirect"
  | "speed-control" | "stat-debuff" | "stat-buff"
  | "switch-lock" | "cast-denial" | "taunt"
  | "mana-gain" | "mana-denial"
  | "summon" | "raise-fallen"
  | "status-amplify" | "double-cast" | "counter" | "field" | "ground" | "time";

/** Every mechanic the roster is counted against, and what it means. */
export const MECHANICS: { tag: Mechanic; says: string }[] = [
  { tag: "area-damage", says: "damage reaching a whole side" },
  { tag: "damage-over-time", says: "a mark that deals damage while it stands" },
  { tag: "drain", says: "HP taken from one and spent on another" },
  { tag: "self-sustain", says: "healing itself" },
  { tag: "ally-heal", says: "healing an ally" },
  { tag: "status-removal", says: "clearing statuses" },
  { tag: "damage-cut", says: "taking less from the next hit" },
  { tag: "protect-ally", says: "cutting or catching a hit aimed at an ally" },
  { tag: "immunity", says: "eating an element outright" },
  { tag: "redirect", says: "taking a hit aimed at an ally" },
  { tag: "speed-control", says: "slowing an enemy" },
  { tag: "stat-debuff", says: "lowering an enemy's stats" },
  { tag: "stat-buff", says: "raising its own or an ally's stats" },
  { tag: "switch-lock", says: "stopping an enemy switching out" },
  { tag: "cast-denial", says: "stopping an enemy casting or going Hyper" },
  { tag: "taunt", says: "making an enemy attack it" },
  { tag: "mana-gain", says: "mana for itself or an ally" },
  { tag: "mana-denial", says: "mana off an enemy" },
  { tag: "summon", says: "another body on the field" },
  { tag: "raise-fallen", says: "a fallen Scoba back as a Pawn" },
  { tag: "status-amplify", says: "making other statuses stronger" },
  { tag: "double-cast", says: "casting twice" },
  { tag: "counter", says: "a free attack outside its own turn" },
  { tag: "field", says: "weather over a side" },
  { tag: "ground", says: "a patch on a mark that works on whoever stands there" },
  { tag: "time", says: "winding the battle back" },
];

/**
 * The mechanics a team cannot do without, which are the ones the rules in
 * `roster-coverage.md` hold to a minimum number of holders.
 */
export const KEYSTONES: Mechanic[] = [
  "area-damage", "ally-heal", "status-removal", "protect-ally", "redirect",
  "speed-control", "cast-denial", "switch-lock", "taunt", "summon", "status-amplify", "ground",
];

/** Where a mechanic sits on a line, which is what decides whether breeding can move it. */
export type Slot = "primary" | "secondary" | "hyper" | "move";

/**
 * Whether breeding can carry it to another line. A child keeps its mother's
 * line and her primary passive, and takes the father's secondary passive, his
 * leading element and one of his moves, so a secondary passive is a mechanic
 * every line can buy and a primary is one only this line ever has.
 */
export const PORTABLE: Record<Slot, boolean> = {
  primary: false, secondary: true, hyper: false, move: true,
};

export interface Holder {
  species: Species;
  slot: Slot;
  /** The passive or move it is carried in. */
  source: string;
  /** What it costs to use, for seeing whether one holder is strictly better than another. */
  price: string;
}

export interface Coverage {
  lines: Species[];
  byMechanic: Map<Mechanic, Holder[]>;
  /** Lines with no role written on them, which is the one thing that rots. */
  unroled: Species[];
  /** Everything that multiplies something else, which is what compounds as the roster grows. */
  multipliers: { species: Species; source: string; says: string }[];
}

/** Which side an effect lands on, which is what tells a buff from a debuff. */
type Side = "self" | "allies" | "enemies";

const MANY: Who[] = ["allies", "enemies", "everyone", "others", "field-allies", "field-enemies",
  "ally-scobas", "enemy-scobas", "ally-pawns", "enemy-pawns"];

const reachesMany = (who: Who): boolean => typeof who === "string" && MANY.includes(who);

/** Which side a move's nth aim picks from. `any-scoba` can pick either, so it counts as both. */
function sidesOfMode(mode: TargetMode | undefined): Side[] {
  switch (mode) {
    case "self": return ["self"];
    case "any-ally": return ["self", "allies"];
    case "other-ally": case "ally-team": case "random-ally": case "benched-ally": case "fallen-scoba":
      return ["allies"];
    case "any-enemy": case "enemy-team": case "random-enemy": case "benched-enemy":
      return ["enemies"];
    case "any-scoba": case "random-scoba": return ["self", "allies", "enemies"];
    default: return ["enemies"];
  }
}

/**
 * Which sides a scope reaches. A step that names the move's own aim is read
 * off what that move asks the player to pick, since the same heal is sustain
 * aimed at itself and an ally heal aimed at an ally.
 */
function sidesOf(who: Who, aims: TargetMode[]): Side[] {
  if (typeof who !== "string") {
    if ("aim" in who) return sidesOfMode(aims[who.aim]);
    // Asked for mid-round, so what it reaches is whatever the question allowed.
    if ("asked" in who) return ["self", "allies", "enemies"];
    if ("next" in who) return who.next === "ally" ? ["allies"] : ["enemies"];
    return sidesOf(who.first, aims);
  }
  switch (who) {
    case "self": case "source": case "traveller": return ["self"];
    case "other": return ["enemies"];
    case "allies": case "field-allies": case "ally-scobas": case "ally-pawns": case "raised":
      return ["allies"];
    case "enemies": case "field-enemies": case "enemy-scobas": case "enemy-pawns":
      return ["enemies"];
    case "everyone": case "others": return ["allies", "enemies"];
    default: return ["enemies"];
  }
}

/** Whether a standing effect is worse for whoever carries it. */
function lowers(e: Standing): boolean {
  switch (e.kind) {
    case "stat-scale": return e.mult < 1;
    case "stat-add": case "stat-offset": return e.amount < 0;
    case "stat-power": return e.mult < 0;
    case "stat-share": return e.frac < 0;
    case "frail": case "vulnerable": return true;
    default: return false;
  }
}

const isSpeed = (e: Standing): boolean =>
  "stat" in e && e.stat === "spd";

/**
 * Every mechanic a set of effects comes to. `on` is who the effects were
 * landed on, since the same slow is speed control on an enemy and a drawback
 * on its holder.
 */
function scan(effects: StatusEffect[], sides: Side[], seen: Set<string>, aims: TargetMode[] = []): Set<Mechanic> {
  const out = new Set<Mechanic>();
  const add = (tag: Mechanic): void => { out.add(tag); };
  const on = sides.includes("enemies") ? "enemies" : sides.includes("allies") ? "allies" : "self";
  const standing = effects.filter((e): e is Standing => isContinuous(e.kind));
  for (const e of standing) {
    switch (e.kind) {
      case "soften":
        add(on === "allies" ? "protect-ally" : "damage-cut");
        break;
      case "ward": case "immune":
        add(on === "allies" ? "protect-ally" : "immunity");
        break;
      case "root":
        if (on === "enemies") add("switch-lock");
        break;
      case "no-spells": case "no-hyper":
        if (on === "enemies") add("cast-denial");
        break;
      case "echo":
        add("double-cast");
        break;
      case "mark-worth": case "mark-power":
        add("status-amplify");
        break;
      case "heal-bonus":
        add("ally-heal");
        break;
      default:
        if (!("stat" in e) && e.kind !== "frail" && e.kind !== "vulnerable" && e.kind !== "element-power") break;
        if (on === "enemies" && lowers(e)) {
          add("stat-debuff");
          if (isSpeed(e)) add("speed-control");
        }
        if (on !== "enemies" && !lowers(e)) add("stat-buff");
        break;
    }
  }
  for (const step of allSteps(effects.filter((e): e is Step => !isContinuous(e.kind)))) {
    switch (step.kind) {
      case "hit": case "damage": {
        const to = sidesOf(step.to, aims);
        if (reachesMany(step.to) && to.includes("enemies")) add("area-damage");
        break;
      }
      case "heal": {
        const to = sidesOf(step.to, aims);
        if (to.includes("allies")) add("ally-heal");
        if (to.includes("self")) add("self-sustain");
        break;
      }
      case "transfer":
        add("drain");
        // What it takes from one it spends on the other, so it heals whoever that is.
        if (step.deliver === "heal" && sidesOf(step.to, aims).some((s) => s !== "enemies")) add("ally-heal");
        break;
      case "cleanse":
        add("status-removal");
        break;
      case "mana":
        add(sidesOf(step.on, aims).includes("enemies") ? "mana-denial" : "mana-gain");
        break;
      case "swing":
        add("counter");
        break;
      case "summon":
        add("summon");
        break;
      case "raise":
        add("raise-fallen");
        break;
      case "field":
        add("field");
        break;
      case "rewind": case "undo-round": case "travel":
        add("time");
        break;
      case "plant": {
        add("ground");
        if (seen.has(step.status)) break;
        seen.add(step.status);
        const patch = STATUSES[step.status];
        if (!patch) break;
        // What the patch does, it does to whoever is standing on the mark.
        const steps = [...patch.effects, ...(patch.also ?? []).flatMap((b) => b.steps)];
        for (const tag of scan(steps, sidesOf(step.under, aims), seen)) add(tag);
        break;
      }
      case "inflict": {
        if (seen.has(step.status)) break;
        seen.add(step.status);
        const inner = STATUSES[step.status];
        if (!inner) break;
        const to = sidesOf(step.on, aims);
        if (inner.effects.some((e) => e.kind === "damage") && to.includes("enemies")) add("damage-over-time");
        // A mark stands on whoever it was put on, so its own steps read from there.
        for (const tag of scan([...inner.effects, ...(inner.also ?? []).flatMap((b) => b.steps)], to, seen)) {
          add(tag);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** What a move comes to, its aim included: a move that asks for a whole side reaches one. */
function mechanicsOfMove(move: Move): Set<Mechanic> {
  const aims = move.targets.map((t) => t.mode);
  const out = scan(move.cast, ["enemies"], new Set(), aims);
  const area = move.targets.some((t) => t.mode === "enemy-team");
  const hits = allSteps(move.cast).some((s) => s.kind === "hit" || s.kind === "damage");
  if (area && hits) out.add("area-damage");
  return out;
}

/** What a passive comes to, through every status it is carried as. */
function mechanicsOfAbility(id: string): Set<Mechanic> {
  const out = new Set<Mechanic>();
  for (const sid of abilityStatuses(id)) {
    const def = STATUSES[sid];
    if (!def) continue;
    const steps = [...def.effects, ...(def.also ?? []).flatMap((b) => b.steps)];
    for (const tag of scan(steps, ["self"], new Set([sid]))) out.add(tag);
    // A passive that rewrites the basic attack is carrying whatever that move does.
    const basic = def.basicAttack ? MOVES[def.basicAttack] : undefined;
    if (basic) for (const tag of mechanicsOfMove(basic)) out.add(tag);
  }
  const move = ABILITIES[id]?.grantsMove;
  if (move && MOVES[move]) for (const tag of mechanicsOfMove(MOVES[move]!)) out.add(tag);
  return out;
}

/** What a move or a passive costs to use, for comparing two holders of one mechanic. */
function priceOfMove(move: Move): string {
  const bits = [`${move.manaCost}% mana`];
  if (move.cooldown > 0) bits.push(`cd${move.cooldown}`);
  if (move.oncePerBattle) bits.push("once a battle");
  return bits.join(", ");
}

function priceOfAbility(id: string): string {
  const charges = abilityStatuses(id)
    .map((sid) => STATUSES[sid]?.charges)
    .find((n) => typeof n === "number" && n > 0);
  return charges === undefined ? "always on" : charges === 1 ? "once a battle" : `${charges} times`;
}

/** Everything one line carries, by slot. */
function slotsOf(sp: Species): { slot: Slot; source: string; tags: Set<Mechanic>; price: string }[] {
  const out: { slot: Slot; source: string; tags: Set<Mechanic>; price: string }[] = [];
  const passive = (slot: Slot, id: string): void => {
    if (!ABILITIES[id]) return;
    out.push({ slot, source: ABILITIES[id]!.name, tags: mechanicsOfAbility(id), price: priceOfAbility(id) });
  };
  passive("primary", sp.primaryAbility);
  for (const id of sp.secondaryPool) passive("secondary", id);
  if (sp.hyperAbility) passive("hyper", sp.hyperAbility);
  for (const id of sp.moves) {
    const move = MOVES[id];
    if (!move) continue;
    out.push({ slot: "move", source: move.name, tags: mechanicsOfMove(move), price: priceOfMove(move) });
  }
  return out;
}

/** Whether a line stands on its own in the roster: not a Pawn, not a fusion, not a baby form. */
export function isLine(sp: Species): boolean {
  return !sp.pawn && !sp.fusion && !sp.baby;
}

export function buildCoverage(): Coverage {
  const lines = rosterSpecies().filter(isLine);
  const byMechanic = new Map<Mechanic, Holder[]>();
  for (const { tag } of MECHANICS) byMechanic.set(tag, []);
  const multipliers: Coverage["multipliers"] = [];
  for (const sp of lines) {
    for (const { slot, source, tags, price } of slotsOf(sp)) {
      for (const tag of tags) byMechanic.get(tag)?.push({ species: sp, slot, source, price });
    }
    for (const id of [sp.primaryAbility, ...sp.secondaryPool, ...(sp.hyperAbility ? [sp.hyperAbility] : [])]) {
      for (const sid of abilityStatuses(id)) {
        for (const e of STATUSES[sid]?.effects ?? []) {
          const says = multiplierLine(e);
          if (says) multipliers.push({ species: sp, source: ABILITIES[id]?.name ?? id, says });
        }
      }
    }
  }
  return {
    lines,
    byMechanic,
    unroled: lines.filter((sp) => sp.role === undefined),
    multipliers,
  };
}

/** An effect that multiplies something else, written out, or null for one that only adds. */
function multiplierLine(e: StatusEffect): string | null {
  switch (e.kind) {
    case "mark-worth":
      return `${e.polarity} statuses on ${e.reach} x${e.mult}`;
    case "mark-power":
      return `the marks it leaves x${e.mult}`;
    case "echo":
      return `every cast again at ${Math.round(e.frac * 100)}%`;
    case "heal-bonus":
      return `every heal on an ally +${e.flatAtCeiling} at the ceiling`;
    case "element-power":
      return `${e.element} moves x${e.mult}`;
    default:
      return null;
  }
}

/** One line of a table, padded so the columns line up in a terminal. */
const row = (cells: string[], widths: number[]): string =>
  cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();

const widthsOf = (rows: string[][]): number[] =>
  rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];

function table(head: string[], body: string[][]): string {
  const all = [head, ...body];
  const widths = widthsOf(all);
  return [row(head, widths), row(head.map((_, i) => "-".repeat(widths[i] ?? 0)), widths),
    ...body.map((r) => row(r, widths))].join("\n");
}

const elementsOf = (sp: Species): ElementType[] => [sp.type, ...(sp.type2 ? [sp.type2] : [])];

/** The report as it is printed, section by section. */
export function renderCoverage(cov: Coverage): string {
  const out: string[] = [];
  const say = (s = ""): void => { out.push(s); };

  say(`Roster: ${cov.lines.length} lines`);
  if (cov.unroled.length > 0) say(`No role written: ${cov.unroled.map((s) => s.id).join(", ")}`);
  say();

  // Roles across the elements a line leads with, so a gap reads as a row of zeros.
  const elements = [...new Set(cov.lines.map((sp) => sp.type))];
  const roleBody = elements.map((el) => [
    TYPE_LABELS[el],
    ...ROSTER_ROLES.map((role) => {
      const n = cov.lines.filter((sp) => sp.type === el && sp.role === role).length;
      return n === 0 ? "." : String(n);
    }),
    String(cov.lines.filter((sp) => sp.type === el).length),
  ]);
  say("Roles by leading element");
  say(table(["Element", ...ROSTER_ROLES.map((r) => r.slice(0, 5)), "all"], roleBody));
  say();
  const emptyRoles = ROSTER_ROLES.filter((role) => !cov.lines.some((sp) => sp.role === role));
  if (emptyRoles.length > 0) say(`Roles nobody fills: ${emptyRoles.join(", ")}`);
  say();

  // Every mechanic, how many lines hold it and how many of those a hybrid can carry elsewhere.
  say("Mechanics");
  const mechBody = MECHANICS.map(({ tag, says }) => {
    const holders = cov.byMechanic.get(tag) ?? [];
    const held = [...new Set(holders.map((h) => h.species.id))];
    const spread = [...new Set(holders.flatMap((h) => elementsOf(h.species)))];
    const portable = holders.filter((h) => PORTABLE[h.slot]).length;
    const keystone = KEYSTONES.includes(tag);
    const flag = held.length === 0 ? (keystone ? "GAP" : "none")
      : held.length === 1 ? (keystone ? "MONOPOLY" : "one line")
        : spread.length === 1 ? "one element"
          : "";
    return [tag, keystone ? "key" : "", String(held.length), String(spread.length), String(portable), flag, says];
  });
  say(table(["mechanic", "", "lines", "elem", "port", "flag", "what it is"], mechBody));
  say();

  // Who holds what, so two holders of one mechanic can be read against each other.
  say("Holders");
  for (const { tag } of MECHANICS) {
    const holders = cov.byMechanic.get(tag) ?? [];
    if (holders.length === 0) continue;
    say(`  ${tag}`);
    for (const h of holders) {
      const where = PORTABLE[h.slot] ? `${h.slot}, breedable` : h.slot;
      say(`    ${h.species.name} (${h.species.role ?? "?"}, ${elementsOf(h.species).map((e) => TYPE_LABELS[e]).join("/")})`
        + `  ${h.source} [${where}]  ${h.price}`);
    }
  }
  say();

  // Breadth: what one line covers on its own, before breeding adds to it.
  say("Keystones per line");
  const breadth = cov.lines
    .map((sp) => {
      const tags = KEYSTONES.filter((tag) => (cov.byMechanic.get(tag) ?? []).some((h) => h.species.id === sp.id));
      return { sp, tags };
    })
    .filter((r) => r.tags.length >= 2)
    .sort((a, b) => b.tags.length - a.tags.length);
  if (breadth.length === 0) say("  Nothing holds two.");
  for (const { sp, tags } of breadth) {
    say(`  ${sp.name} (${sp.role ?? "?"}): ${tags.join(", ")}`);
  }
  say("  Any line can add one more by breeding, from a father's secondary passive.");
  say();

  say("Multipliers");
  for (const m of cov.multipliers) say(`  ${m.species.name}  ${m.source}: ${m.says}`);
  if (cov.multipliers.length === 0) say("  None.");
  return out.join("\n");
}
