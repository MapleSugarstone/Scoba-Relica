// The one endpoint the standalone cosmetics editor needs: read and write
// `src/game/content/cosmetics.json`.
//
// A dev server only, and only ever this one file under the repo, because the
// point is to save a round trip through a download rather than to open the
// disk up.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const DOC = "src/game/content/cosmetics.json";

/** How big a document is worth accepting. A nudge is a dozen bytes. */
const MAX_BYTES = 256 * 1024;

export function cosmeticsFile(root: string): Plugin {
  const path = resolve(root, DOC);
  return {
    name: "scoba-cosmetics-file",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/cosmetics", (req, res) => {
        const send = (code: number, body: string, type = "text/plain"): void => {
          res.statusCode = code;
          res.setHeader("content-type", type);
          res.end(body);
        };

        if (req.method === "GET") {
          readFile(path, "utf8")
            // No file yet is a document with nothing moved, not an error.
            .catch(() => "{}")
            .then((text) => send(200, text, "application/json"))
            .catch((err: unknown) => send(500, String(err)));
          return;
        }

        if (req.method !== "POST") return send(405, "GET or POST only.");

        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            send(413, "That is far too big to be a set of placements.");
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          if (res.writableEnded) return;
          const body = Buffer.concat(chunks).toString("utf8");
          let pretty: string;
          try {
            // Parsed before it is written, so a broken body never lands in the
            // repo, and reformatted so the committed file reads the same
            // however it arrived.
            pretty = `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
          } catch {
            return send(400, "That is not JSON.");
          }
          writeFile(path, pretty, "utf8")
            .then(() => send(200, `Saved to ${DOC}.`))
            .catch((err: unknown) => send(500, `Could not write ${DOC}: ${String(err)}`));
        });
      });
    },
  };
}
