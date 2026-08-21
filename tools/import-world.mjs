// Takes an exported world.json and writes it into the build, so a map edited
// in the browser becomes the one the game ships with. Run through
// `import-world.cmd`, which is what a dropped file lands on.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "src/game/content/world.json");

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const source = process.argv[2];
if (!source) die("Drop an exported world.json onto import-world.cmd.");
if (!existsSync(source)) die(`No such file: ${source}`);

let doc;
try {
  doc = JSON.parse(readFileSync(source, "utf8"));
} catch (err) {
  die(`That file is not JSON: ${err.message}`);
}
if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
  die("That JSON is not a world document.");
}

// The game normalizes anything it loads, so this only has to catch a file that
// is the wrong thing entirely, not police every field.
const maps = Array.isArray(doc.maps) ? doc.maps : null;
const legacy = Array.isArray(doc.terrain);
if (!maps && !legacy) {
  die("No maps in there. Export from the editor's World tab, then drop that file.");
}
if (maps) {
  for (const [i, m] of maps.entries()) {
    if (!m || typeof m !== "object") die(`Map ${i + 1} is not an object.`);
    if (!Array.isArray(m.terrain) || m.terrain.length === 0) {
      die(`Map ${i + 1} (${m.id ?? "?"}) has no terrain rows.`);
    }
    const width = m.terrain[0].length;
    if (!m.terrain.every((r) => typeof r === "string" && r.length === width)) {
      die(`Map ${i + 1} (${m.id ?? "?"}) has ragged terrain rows.`);
    }
  }
}

if (existsSync(target)) {
  copyFileSync(target, `${target}.bak`);
}
writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

const list = maps ?? [{ id: "island", terrain: doc.terrain }];
console.log(`\n  Wrote ${target}`);
console.log(`  Previous version kept at world.json.bak\n`);
for (const m of list) {
  const rows = m.terrain.length;
  const cols = m.terrain[0].length;
  const tiles = Object.keys(m.tiles ?? {}).length;
  const cells = Object.keys(m.cellData ?? {}).length;
  const star = m.id === doc.startMap ? " (start)" : "";
  console.log(`  ${m.name ?? m.id}${star}: ${cols}x${rows}, ${tiles} painted tiles, ${cells} special cells`);
}
const npcs = Array.isArray(doc.npcs) ? doc.npcs.length : 0;
const quests = Array.isArray(doc.quests) ? doc.quests.length : 0;
const rules = Object.keys(doc.tileRules ?? {}).length;
console.log(`\n  ${npcs} NPCs, ${quests} quests, ${rules} edited tile defaults.`);
console.log("  Commit src/game/content/world.json to ship it.\n");
