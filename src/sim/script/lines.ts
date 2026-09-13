// Turns script text into lines of words, nested by indentation.
//
// A record's header at the left edge holds the lines indented under it. Below
// that, a line that ends in a colon opens a block, and the lines indented under
// it belong to it. A line that does not end in a colon can still have lines
// indented under it: those are more of its own clauses, written one per line
// instead of after commas. A line starting with # is a note and is skipped.

/** One word, or one run of text in double quotes. */
export interface Word {
  text: string;
  quoted: boolean;
}

export interface Line {
  /** Counted from 1, in the text it was read from. */
  no: number;
  indent: number;
  /** The first clause, then one per comma, then one per line indented under a line that opens nothing. */
  clauses: Word[][];
  /** Ends in a colon, so the lines under it are a block of their own. */
  opens: boolean;
  children: Line[];
  /** How many of its clauses came from lines indented under it rather than after commas. */
  stacked: number;
}

/** A problem, and the line it is on. */
export interface Problem {
  line: number;
  says: string;
}

export class ScriptError extends Error {
  constructor(readonly line: number, readonly says: string) {
    super(`line ${line}: ${says}`);
  }
}

/** Spaces a tab counts for, so a file mixing the two still lines up the way it looks. */
const TAB = 2;

/** Splits one line into clauses of words, and says whether it ends in a colon. */
function wordsOf(text: string, no: number): { clauses: Word[][]; opens: boolean } {
  const clauses: Word[][] = [[]];
  let opens = false;
  let i = 0;
  const current = (): Word[] => clauses[clauses.length - 1]!;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (ch === ",") {
      clauses.push([]);
      i += 1;
      continue;
    }
    if (ch === "\"") {
      let out = "";
      i += 1;
      let closed = false;
      while (i < text.length) {
        const c = text[i]!;
        if (c === "\\" && i + 1 < text.length) {
          out += text[i + 1];
          i += 2;
          continue;
        }
        if (c === "\"") {
          closed = true;
          i += 1;
          break;
        }
        out += c;
        i += 1;
      }
      if (!closed) throw new ScriptError(no, "has a quote that is never closed");
      current().push({ text: out, quoted: true });
      continue;
    }
    let word = "";
    while (i < text.length && !" \t,\"".includes(text[i]!)) {
      word += text[i];
      i += 1;
    }
    current().push({ text: word, quoted: false });
  }
  // A colon on the end of the last word opens a block. One on its own does too.
  const last = current();
  const tail = last[last.length - 1];
  if (tail && !tail.quoted && tail.text.endsWith(":")) {
    opens = true;
    tail.text = tail.text.slice(0, -1);
    if (tail.text === "") last.pop();
  }
  if (clauses.some((c) => c.length === 0)) {
    throw new ScriptError(no, "has a comma with nothing on one side of it");
  }
  return { clauses, opens };
}

/** Reads text into top-level lines, each holding the lines indented under it. */
export function readLines(text: string, firstLine = 1): Line[] {
  const roots: Line[] = [];
  const stack: Line[] = [];
  const rows = text.split(/\r?\n/);
  rows.forEach((row, i) => {
    const no = firstLine + i;
    const expanded = row.replace(/\t/g, " ".repeat(TAB));
    const body = expanded.trimStart();
    if (body === "" || body.startsWith("#")) return;
    const indent = expanded.length - body.length;
    const { clauses, opens } = wordsOf(body.trimEnd(), no);
    const line: Line = { no, indent, clauses, opens, children: [], stacked: 0 };
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent) {
      roots.push(line);
    } else if (parent.opens || parent === stack[0]) {
      // A record's own lines sit under its header, which needs no colon.
      parent.children.push(line);
    } else {
      // Lines under a line that opens nothing are more of its clauses.
      if (opens || line.children.length > 0) {
        throw new ScriptError(no, "is under a line that does not end in a colon, so it cannot open a block");
      }
      parent.clauses.push(...clauses);
      parent.stacked += clauses.length;
      return;
    }
    stack.push(line);
  });
  return roots;
}

/** One record's text in a file, with any notes written directly above it. */
export interface Block {
  /** `move`, `status`, `passive` or `field`. */
  kind: string;
  id: string;
  text: string;
  /** The line its text starts on, counted from 1. */
  firstLine: number;
}

/** A file cut into what comes before the first record and one block per record. */
export interface Blocks {
  preamble: string;
  blocks: Block[];
}

const HEADER = /^(move|status|passive|field)\s+([^\s"]+)/;

/**
 * Cuts a file into records, for editing one at a time and writing the file back
 * whole. A run of notes with no blank line between it and a record belongs to
 * that record. Blank lines between records are not kept, since writing the
 * file back puts exactly one between each.
 */
export function splitBlocks(text: string): Blocks {
  const rows = text.split(/\r?\n/);
  const starts: { row: number; kind: string; id: string }[] = [];
  rows.forEach((row, i) => {
    const m = HEADER.exec(row);
    if (m) starts.push({ row: i, kind: m[1]!, id: m[2]! });
  });
  // Pull each start up over the notes directly above it.
  const tops = starts.map((s) => {
    let top = s.row;
    while (top > 0 && rows[top - 1]!.startsWith("#")) top -= 1;
    return top;
  });
  const trim = (lines: string[]): string => {
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
    while (out.length > 0 && out[0]!.trim() === "") out.shift();
    return out.join("\n");
  };
  const preamble = trim(rows.slice(0, tops[0] ?? rows.length));
  const blocks = starts.map((s, i) => {
    const from = tops[i]!;
    const to = tops[i + 1] ?? rows.length;
    const lines = rows.slice(from, to);
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return { kind: s.kind, id: s.id, text: lines.join("\n"), firstLine: from + 1 };
  });
  return { preamble, blocks };
}

/** Puts a file back together from its parts, one blank line between records. */
export function joinBlocks(parts: Blocks): string {
  const bodies = parts.blocks.map((b) => b.text.replace(/\s+$/, ""));
  const all = parts.preamble.trim() === "" ? bodies : [parts.preamble.replace(/\s+$/, ""), ...bodies];
  return `${all.join("\n\n")}\n`;
}
