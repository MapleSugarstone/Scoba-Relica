// Moves, statuses, passives, fields and hobbies, read out of their script files as the
// game loads. The files are the source of truth, and the cosmetics editor reads
// and writes them.
import MOVES_TEXT from "./moves.txt?raw";
import STATUSES_TEXT from "./statuses.txt?raw";
import PASSIVES_TEXT from "./passives.txt?raw";
import FIELDS_TEXT from "./fields.txt?raw";
import HOBBIES_TEXT from "./hobbies.txt?raw";
import { readContent, type ScriptFile } from "../script/content";

/** The text of each file as the game loaded it. */
export const SCRIPT_TEXT: Record<ScriptFile, string> = {
  moves: MOVES_TEXT,
  statuses: STATUSES_TEXT,
  passives: PASSIVES_TEXT,
  fields: FIELDS_TEXT,
  hobbies: HOBBIES_TEXT,
};

const read = readContent(SCRIPT_TEXT);

// A mistake in a file would otherwise surface as a move that is quietly
// missing, which is much harder to trace back to the line that caused it.
if (read.problems.length > 0) {
  throw new Error(`The move script has mistakes in it:\n${read.problems
    .map((p) => `  ${p.file}.txt line ${p.line}: ${p.says}`).join("\n")}`);
}

export const CONTENT_TABLES = read;
