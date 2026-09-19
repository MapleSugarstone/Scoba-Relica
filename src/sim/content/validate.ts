// Checks the game data the compiler cannot.
//
// Moves, statuses, passives and fields are move script, and reading a script
// already refuses anything it cannot make sense of. What reading one file cannot
// tell is whether an id it names exists in another, so that is checked here once
// every file is in. The lines are still JSON, and a misspelled key in JSON is
// valid JSON that silently does nothing, so each line is walked against a schema.
import { ABILITIES, MOVES, SPECIES, type MovementStyle } from "../species";
import { FIELDS, STATUSES } from "../status";
import { STAT_NAMES, TYPES } from "../types";
import { brokenRefs } from "../script/content";
import { CONTENT_TABLES } from "./tables";

/** One thing wrong with a record, and where in it. */
export interface Problem {
  /** A path into the record, like `moves[0]`, or a line in a script file. */
  at: string;
  says: string;
}

// --- the schema language, for the lines ---

type Rule =
  | { t: "string" }
  | { t: "number" }
  | { t: "boolean" }
  | { t: "enum"; of: readonly string[] }
  /** An id that has to name something in one of the tables. */
  | { t: "ref"; table: () => Record<string, unknown>; what: string }
  | { t: "array"; of: Rule }
  | { t: "map"; of: Rule }
  | { t: "object"; fields: Fields }
  /** One of several shapes, told apart by the value of one key. */
  | { t: "tagged"; key: string; cases: Record<string, Fields> };

type Fields = Record<string, { rule: Rule; optional?: boolean }>;

const str: Rule = { t: "string" };
const num: Rule = { t: "number" };
const bool: Rule = { t: "boolean" };
const oneOf = (of: readonly string[]): Rule => ({ t: "enum", of });
const ref = (table: () => Record<string, unknown>, what: string): Rule => ({ t: "ref", table, what });
const listOf = (of: Rule): Rule => ({ t: "array", of });
const req = (rule: Rule) => ({ rule });
const opt = (rule: Rule) => ({ rule, optional: true });

const everyMovement: Record<MovementStyle, true> = {
  hop: true, scamper: true, hover: true, skitter: true, moonhop: true,
};
const MOVEMENTS = Object.keys(everyMovement);

const moveRef = ref(() => MOVES, "move");
const abilityRef = ref(() => ABILITIES, "passive");
const speciesRef = ref(() => SPECIES, "species");
const element = oneOf(TYPES);

const SPECIES_FIELDS: Fields = {
  id: req(str),
  name: req(str),
  type: req(element),
  type2: opt(element),
  genes: req({
    t: "object",
    fields: Object.fromEntries(STAT_NAMES.map((s) => [s, req(num)])),
  }),
  primaryAbility: req(abilityRef),
  secondaryPool: req(listOf(abilityRef)),
  moves: req(listOf(moveRef)),
  sprite: req({
    t: "tagged",
    key: "kind",
    cases: {
      art: { art: req(str), forms: opt({ t: "map", of: str }) },
      placeholder: {},
    },
  }),
  movement: req(oneOf(MOVEMENTS)),
  stage: opt(num),
  evolvesTo: opt(speciesRef),
  baby: opt(bool),
  hyperAbility: opt(abilityRef),
  cry: opt(str),
  blurb: opt(str),
  starter: opt(bool),
  special: opt(bool),
  pawn: opt(bool),
  autonomous: opt(bool),
  inheritsFromCaller: opt(bool),
  fusion: opt(bool),
};

// --- walking a value against a rule ---

const kindOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v;

function walk(value: unknown, rule: Rule, at: string, out: Problem[]): void {
  switch (rule.t) {
    case "string":
    case "number":
    case "boolean":
      if (typeof value !== rule.t || (rule.t === "number" && !Number.isFinite(value as number))) {
        out.push({ at, says: `should be a ${rule.t}, but is ${kindOf(value)}` });
      }
      return;
    case "enum":
      if (typeof value !== "string" || !rule.of.includes(value)) {
        out.push({ at, says: `should be one of ${rule.of.join(", ")}, but is ${JSON.stringify(value)}` });
      }
      return;
    case "ref":
      if (typeof value !== "string") {
        out.push({ at, says: `should be the id of a ${rule.what}, but is ${kindOf(value)}` });
      } else if (!(value in rule.table())) {
        out.push({ at, says: `names a ${rule.what} called "${value}", and there is none` });
      }
      return;
    case "array":
      if (!Array.isArray(value)) {
        out.push({ at, says: `should be a list, but is ${kindOf(value)}` });
        return;
      }
      value.forEach((item, i) => walk(item, rule.of, `${at}[${i}]`, out));
      return;
    case "map":
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        out.push({ at, says: `should be an object, but is ${kindOf(value)}` });
        return;
      }
      for (const [k, v] of Object.entries(value)) walk(v, rule.of, `${at}.${k}`, out);
      return;
    case "object":
      walkFields(value, rule.fields, at, out);
      return;
    case "tagged": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        out.push({ at, says: `should be an object, but is ${kindOf(value)}` });
        return;
      }
      const tag = (value as Record<string, unknown>)[rule.key];
      const shape = typeof tag === "string" ? rule.cases[tag] : undefined;
      if (!shape) {
        out.push({
          at: `${at}.${rule.key}`,
          says: `should be one of ${Object.keys(rule.cases).join(", ")}, but is ${JSON.stringify(tag)}`,
        });
        return;
      }
      walkFields(value, { [rule.key]: req(str), ...shape }, at, out);
      return;
    }
  }
}

function walkFields(value: unknown, fields: Fields, at: string, out: Problem[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    out.push({ at, says: `should be an object, but is ${kindOf(value)}` });
    return;
  }
  const record = value as Record<string, unknown>;
  const here = (k: string): string => (at === "" ? k : `${at}.${k}`);
  for (const [key, spec] of Object.entries(fields)) {
    if (!(key in record) || record[key] === undefined) {
      if (!spec.optional) out.push({ at: here(key), says: "is missing" });
      continue;
    }
    walk(record[key], spec.rule, here(key), out);
  }
  // A key the game never reads is almost always a typo of one it does, and a
  // typo of a number is a number that silently stops mattering.
  for (const key of Object.keys(record)) {
    if (!(key in fields)) {
      const near = Object.keys(fields).find((f) => f.toLowerCase() === key.toLowerCase());
      out.push({
        at: here(key),
        says: near ? `is not read by the game. Did you mean "${near}"?` : "is not read by the game",
      });
    }
  }
}

export const checkSpecies = (s: unknown): Problem[] => {
  const out: Problem[] = [];
  walkFields(s, SPECIES_FIELDS, "", out);
  return out;
};

/** Every problem in the game's data, each with the file or table and record it is in. */
export function checkAll(): { kind: string; id: string; problems: Problem[] }[] {
  const out: { kind: string; id: string; problems: Problem[] }[] = [];
  for (const [id, record] of Object.entries(SPECIES)) {
    const problems = checkSpecies(record);
    if (record.id !== id) problems.push({ at: "id", says: `is "${record.id}", but it is filed as "${id}"` });
    if (problems.length > 0) out.push({ kind: "species", id, problems });
  }
  for (const p of CONTENT_TABLES.problems) {
    out.push({ kind: `${p.file}.txt`, id: `line ${p.line}`, problems: [{ at: "", says: p.says }] });
  }
  for (const p of brokenRefs(CONTENT_TABLES.refs, { moves: MOVES, statuses: STATUSES, species: SPECIES, fields: FIELDS })) {
    out.push({ kind: `${p.file}.txt`, id: `line ${p.line}`, problems: [{ at: "", says: p.says }] });
  }
  return out;
}
