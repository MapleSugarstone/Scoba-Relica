// The script files read together into the tables the game runs on.
import type { Ability, Move } from "../species";
import type { FieldDef, HobbyDef, StatusDef } from "../status";
import { readScript, type RecordKind, type Ref } from "./read";
import { missingWords } from "./words";

/** The script files, by the name they are saved under in `src/sim/content`. */
export type ScriptFile = "moves" | "statuses" | "passives" | "fields" | "hobbies";

export const SCRIPT_FILES: readonly ScriptFile[] = ["moves", "statuses", "passives", "fields", "hobbies"];

/** What kind of record each file holds. */
export const FILE_RECORD: Record<ScriptFile, RecordKind> = {
  moves: "move", statuses: "status", passives: "passive", fields: "field", hobbies: "hobby",
};

export interface Tables {
  moves: Record<string, Move>;
  statuses: Record<string, StatusDef>;
  abilities: Record<string, Ability>;
  fields: Record<string, FieldDef>;
  hobbies: Record<string, HobbyDef>;
}

/** A problem in one of the files. */
export interface FileProblem {
  file: ScriptFile;
  line: number;
  says: string;
}

export interface ReadContent extends Tables {
  problems: FileProblem[];
  /** Every id the records name, with the file and line naming it. */
  refs: (Ref & { file: ScriptFile })[];
}

/** Reads every file. Records with mistakes are left out and their mistakes listed. */
export function readContent(texts: Record<ScriptFile, string>): ReadContent {
  const out: ReadContent = { moves: {}, statuses: {}, abilities: {}, fields: {}, hobbies: {}, problems: [], refs: [] };
  for (const missing of missingWords()) {
    out.problems.push({ file: "moves", line: 0, says: `the script has no word for the ${missing}` });
  }
  const owner: Record<string, ScriptFile> = {};
  const claim = (file: ScriptFile, line: number, id: string, table: string): boolean => {
    const key = `${table}:${id}`;
    if (owner[key]) {
      out.problems.push({ file, line, says: `"${id}" is already used by a record in ${owner[key]}` });
      return false;
    }
    owner[key] = file;
    return true;
  };
  for (const file of SCRIPT_FILES) {
    const read = readScript(texts[file], FILE_RECORD[file]);
    for (const p of read.problems) out.problems.push({ file, ...p });
    for (const r of read.refs) out.refs.push({ file, ...r });
    const at = (id: string): number => read.lines[id] ?? 0;
    for (const m of read.moves) if (claim(file, at(m.id), m.id, "moves")) out.moves[m.id] = m;
    // A passive is carried as a status of the same id, so the two share one table of ids.
    for (const s of read.statuses) if (claim(file, at(s.id), s.id, "statuses")) out.statuses[s.id] = s;
    for (const a of read.abilities) if (claim(file, at(a.id), a.id, "abilities")) out.abilities[a.id] = a;
    for (const f of read.fields) if (claim(file, at(f.id), f.id, "fields")) out.fields[f.id] = f;
    for (const h of read.hobbies) if (claim(file, at(h.id), h.id, "hobbies")) out.hobbies[h.id] = h;
  }
  return out;
}

/** Every id a record names that names nothing, given what each table holds. */
export function brokenRefs(
  refs: ReadContent["refs"],
  has: { moves: object; statuses: object; species: object; fields: object },
): FileProblem[] {
  const what = { moves: "move", statuses: "status", species: "species", fields: "field" } as const;
  return refs
    .filter((r) => !(r.id in has[r.table]))
    .map((r) => ({ file: r.file, line: r.line, says: `names a ${what[r.table]} called "${r.id}", and there is none` }));
}
