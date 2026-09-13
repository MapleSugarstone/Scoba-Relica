// Rewriting a move while a battle runs.
//
// A `change-move` step turns one move into another: a different element, a
// different kind of damage, a different stat to read. The copy is registered
// under an id of its own, so everything that looks a move up by id finds it the
// way it finds any other and nothing downstream has to know it was rewritten.
import type { BattleState } from "./battle";
import { MOVES, allSteps, type Move } from "./species";
import { STATUSES, isContinuous, type MoveChange, type Step } from "./status";
import { summarize } from "./script/read";

/** Every id a rewrite has filed, so they can all be taken back out again. */
const made = { moves: new Set<string>(), statuses: new Set<string>() };

/**
 * Takes every rewritten move and status back out of the tables. The editor
 * calls this when a record changes, since a rewrite of the old record would
 * otherwise stay filed under the id the new one asks for.
 */
export function forgetDerived(): void {
  for (const id of made.moves) delete MOVES[id];
  for (const id of made.statuses) delete STATUSES[id];
  made.moves.clear();
  made.statuses.clear();
}

/** The id a rewrite of a move or a status is filed under: `moonbeam@roll-the-wheel`. */
function derivedId(baseId: string, key: string): string {
  return `${baseId}@${key}`;
}

/**
 * The move a rewrite makes of another, built once and kept. `key` names the
 * rewrite, so two steps asking for the same one get the same move.
 */
export function deriveMove(baseId: string, changes: MoveChange[], key: string): string {
  const id = derivedId(baseId, key);
  if (MOVES[id]) return id;
  const base = MOVES[baseId];
  if (!base) return baseId;
  let type = base.type;
  let tint = base.tint;
  let name = base.name;
  let manaCost = base.manaCost;
  for (const c of changes) {
    if (c.set === "type") type = c.to;
    if (c.set === "tint") tint = c.to;
    if (c.set === "name") name = c.to.replace(/\{name\}/g, name);
    // Mana is spent in whole points, so a share of a cost is rounded to one.
    if (c.set === "cost") manaCost = Math.round(manaCost * c.mult);
  }
  const retyped = changes.some((c) => c.set === "type") ? type : null;
  const rewrite = (steps: Step[]): Step[] => steps.map((s) => rewriteStep(s, changes, retyped, key, rewrite));
  const cast = rewrite(base.cast);
  const move: Move = {
    ...base,
    id,
    name,
    type,
    manaCost,
    cast,
    ...summarize(cast),
    ...(tint !== undefined ? { tint } : {}),
    derived: { from: baseId, by: key },
  };
  MOVES[id] = move;
  made.moves.add(id);
  return id;
}

function rewriteStep(
  s: Step,
  changes: MoveChange[],
  retyped: Move["type"] | null,
  key: string,
  again: (steps: Step[]) => Step[],
): Step {
  switch (s.kind) {
    case "hit": {
      let out = s;
      for (const c of changes) {
        if (c.set === "category") out = { ...out, category: c.to };
        if (c.set === "stat") {
          const [first, ...rest] = out.scaling;
          if (first && (first.stat === "str" || first.stat === "mag")) {
            out = { ...out, scaling: [{ ...first, stat: c.to }, ...rest] };
          }
        }
      }
      return out;
    }
    case "heal": {
      // A share of the patient's own pool stays that. A share of a stat becomes
      // the stat the rewrite reads.
      const stat = changes.find((c): c is Extract<MoveChange, { set: "stat" }> => c.set === "stat");
      if (!stat || !s.basis.startsWith("source-") || s.basis === "source-max-hp") return s;
      return { ...s, basis: stat.to === "str" ? "source-str" : "source-mag" };
    }
    case "inflict":
      return retyped ? { ...s, status: deriveStatus(s.status, retyped, key) } : s;
    case "if":
      return { ...s, then: again(s.then) };
    default:
      return s;
  }
}

/**
 * A status as a retyped move leaves it: whatever it deals is of the new
 * element. What it does to a stat is left alone, because a drain has no element.
 */
export function deriveStatus(baseId: string, element: Move["type"], key: string): string {
  const id = derivedId(baseId, key);
  if (STATUSES[id]) return id;
  const base = STATUSES[baseId];
  if (!base) return baseId;
  STATUSES[id] = {
    ...base,
    id,
    effects: base.effects.map((e) => {
      if (e.kind === "damage") return { ...e, damage: { ...e.damage, element } };
      if (e.kind === "hit") return { ...e, element };
      return e;
    }),
  };
  made.statuses.add(id);
  return id;
}

/**
 * Files every rewrite a battle state names that this client has not built. A
 * player walking into a shared fight is handed the state as it stands, and a
 * rewrite made before they arrived exists only on the client that was there,
 * so without this the two would read the same move id as two different moves.
 */
export function restoreDerived(st: BattleState): void {
  const moves = new Set<string>();
  const statuses = new Set<string>();
  for (const team of st.teams) {
    for (const c of team) {
      for (const id of c.given ?? []) moves.add(id);
      for (const id of Object.values(c.swapped ?? {})) moves.add(id);
      for (const id of Object.keys(c.cds)) moves.add(id);
      for (const id of c.spent) moves.add(id);
      for (const s of c.statuses) statuses.add(s.id);
    }
  }
  for (const id of moves) restoreMove(id);
  for (const id of statuses) restoreStatus(id);
}

/** The move or status a rewritten id was made from, and the rewrite that made it. */
function splitDerived(id: string): { base: string; key: string } | null {
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  return { base: id.slice(0, at), key: id.slice(at + 1) };
}

/** The `change-move` step a rewrite key names, found in the record it belongs to. */
function rewriteNamed(key: string): Extract<Step, { kind: "change-move" }> | null {
  // A key is its record's id, with a count after a dot for a record's later rewrites.
  const record = key.split(".")[0]!;
  const steps = [
    ...(MOVES[record]?.cast ?? []),
    ...(STATUSES[record]?.effects.filter((e): e is Step => !isContinuous(e.kind)) ?? []),
  ];
  const found = allSteps(steps).find((s) => s.kind === "change-move" && s.key === key);
  return found?.kind === "change-move" ? found : null;
}

function restoreMove(id: string): void {
  if (MOVES[id]) return;
  const parts = splitDerived(id);
  if (!parts) return;
  restoreMove(parts.base);
  const step = rewriteNamed(parts.key);
  if (step) deriveMove(parts.base, step.changes, parts.key);
}

function restoreStatus(id: string): void {
  if (STATUSES[id]) return;
  const parts = splitDerived(id);
  if (!parts) return;
  restoreStatus(parts.base);
  const retype = rewriteNamed(parts.key)?.changes.find((c) => c.set === "type");
  if (retype?.set === "type") deriveStatus(parts.base, retype.to, parts.key);
}
