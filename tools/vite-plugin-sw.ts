import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = resolve(ROOT, "tools/sw-template.js");
const PUBLIC_DIR = resolve(ROOT, "public");

/** Every file under `public/`, as forward-slashed paths relative to it. */
function publicFiles(dir = PUBLIC_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...publicFiles(full));
    else out.push(relative(PUBLIC_DIR, full).split("\\").join("/"));
  }
  return out;
}

/**
 * Emits `sw.js` with the build's real filenames baked into its precache list.
 * The list has to be generated because Vite content-hashes asset names, and
 * the cache name is a hash of the list, so a deploy that changes any file
 * lands in a fresh cache and retires the old one.
 */
export function serviceWorker(): Plugin {
  return {
    name: "scoba-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      // index.html is named rather than read off the bundle: Vite has not
      // emitted it yet at this point in the build. It is also the one file
      // without a content hash, which is why navigations are network-first.
      const found = [...Object.keys(bundle), ...publicFiles()]
        // The F2 world editor is dynamically imported and players never load
        // it, so it stays out of what every player has to download.
        .filter((f) => !/editor/i.test(f))
        .filter((f) => !f.endsWith(".map"));
      const precache = [...new Set(["index.html", ...found])].sort();

      const version = createHash("sha256")
        .update(precache.join("\n"))
        .digest("hex")
        .slice(0, 12);

      const source = readFileSync(TEMPLATE, "utf8")
        .replaceAll("__VERSION__", version)
        .replaceAll("__PRECACHE__", JSON.stringify(precache, null, 2));

      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}
