// The endpoints the editor needs: read and write the files it edits.
//
// A dev server only, and only ever a fixed list of files under the repo, named
// here and nowhere else. The point is to save a round trip through a download
// rather than to open the disk up, so a request can never name a path.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizePath, type Connect, type Plugin } from "vite";
import { readScript, type RecordKind } from "../src/sim/script/read";

type FileSpec =
  /** A JSON document, a list of records with an id where `list` says so. */
  | { path: string; format: "json"; empty: string; list: boolean }
  /** A move script file holding one kind of record. */
  | { path: string; format: "script"; empty: string; records: RecordKind };

/** Every file the editor may read or write, by the name the request uses. */
const FILES = {
  cosmetics: { path: "src/game/content/cosmetics.json", format: "json", empty: "{}", list: false },
  species: { path: "src/sim/content/species.json", format: "json", empty: "[]", list: true },
  moves: { path: "src/sim/content/moves.txt", format: "script", empty: "", records: "move" },
  statuses: { path: "src/sim/content/statuses.txt", format: "script", empty: "", records: "status" },
  passives: { path: "src/sim/content/passives.txt", format: "script", empty: "", records: "passive" },
  fields: { path: "src/sim/content/fields.txt", format: "script", empty: "", records: "field" },
} satisfies Record<string, FileSpec>;

type FileName = keyof typeof FILES;

/** How big a file is worth accepting. The largest the game ships is well under this. */
const MAX_BYTES = 512 * 1024;

/** What is wrong with a body for this file, or null where it can be written as it is. */
function problemWith(file: FileSpec, body: string): string | null {
  if (file.format === "script") {
    // The editor checks every record before it sends a file. This is the last
    // line: a script the game cannot read would take it down when it next loaded.
    const read = readScript(body, file.records);
    const first = read.problems[0];
    return first ? `${file.path} line ${first.line}: ${first.says}` : null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "That is not JSON.";
  }
  if (file.list) {
    const ok = Array.isArray(parsed) && parsed.every(
      (r) => r !== null && typeof r === "object" && typeof (r as { id?: unknown }).id === "string",
    );
    if (!ok) return `${file.path} has to be a list of records, each with an id.`;
  }
  return null;
}

/** The text written for a body, formatted the same however it arrived. */
function formatted(file: FileSpec, body: string): string {
  if (file.format === "script") return `${body.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n`;
  return `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
}

function endpoint(root: string, name: FileName, written: Map<string, string>): Connect.NextHandleFunction {
  const file: FileSpec = FILES[name];
  const path = resolve(root, file.path);
  return (req, res) => {
    const send = (code: number, body: string, type = "text/plain"): void => {
      res.statusCode = code;
      res.setHeader("content-type", type);
      res.end(body);
    };

    if (req.method === "GET") {
      readFile(path, "utf8")
        // No file yet is an empty document rather than an error.
        .catch(() => file.empty)
        .then((text) => send(200, text, file.format === "json" ? "application/json" : "text/plain"))
        .catch((err: unknown) => send(500, String(err)));
      return;
    }

    if (req.method !== "POST") return send(405, "GET or POST only.");

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        send(413, `That is far too big to be ${file.path}.`);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks).toString("utf8");
      const problem = problemWith(file, body);
      if (problem) return send(400, problem);
      const text = formatted(file, body);
      // Recorded before the write, because the watcher can report the change first.
      written.set(normalizePath(path), text);
      writeFile(path, text, "utf8")
        .then(() => send(200, `Saved to ${file.path}.`))
        .catch((err: unknown) => send(500, `Could not write ${file.path}: ${String(err)}`));
    });
  };
}

export function cosmeticsFile(root: string): Plugin {
  /** What the editor last wrote to each file, by normalized path. */
  const written = new Map<string, string>();
  return {
    name: "scoba-editor-files",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/cosmetics", endpoint(root, "cosmetics", written));
      for (const name of Object.keys(FILES) as FileName[]) {
        if (name === "cosmetics") continue;
        server.middlewares.use(`/api/content/${name}`, endpoint(root, name, written));
      }
    },
    // The page that saved already holds what it wrote, so a reload only loses its
    // place. Vite still drops its cached copy of the file, so a manual reload reads
    // the new text. A change made outside the editor reloads as usual.
    async hotUpdate({ file, read }) {
      const wrote = written.get(file);
      if (wrote !== undefined && (await read()) === wrote) return [];
    },
  };
}
