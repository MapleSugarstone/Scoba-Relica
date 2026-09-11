// The standalone cosmetics editor: `npm run cosmetics`.
//
// It is the same panel the game puts behind F3, on a page of its own, with the
// document read from and written straight back to
// `src/game/content/cosmetics.json`. That is the whole point of it: no game to
// load, no download, and nothing to carry back into the repo by hand.
//
// It imports the game's own modules, so the art, the species list and the
// placement rule are the real ones rather than a copy that could drift.
import { loadArt } from "../../src/engine/assets";
import { buildCosmeticsPanel } from "../../src/dev/cosmeticspanel";
import { installCosmetics, parseCosmetics, type CosmeticDoc } from "../../src/game/cosmetics";

const said = document.getElementById("said")!;
const mount = document.getElementById("mount")!;

function note(text: string, bad = false): void {
  said.textContent = text;
  said.classList.toggle("bad", bad);
}

/** What the file holds right now, so the editor opens on the real document. */
async function readDoc(): Promise<CosmeticDoc> {
  const res = await fetch("/api/cosmetics");
  if (!res.ok) throw new Error(`could not read the document (${res.status})`);
  return parseCosmetics(await res.text());
}

async function writeDoc(json: string): Promise<string> {
  const res = await fetch("/api/cosmetics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: json,
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(text || `save failed (${res.status})`);
  return text || "Saved.";
}

async function start(): Promise<void> {
  note("Loading art...");
  const [art, doc] = await Promise.all([loadArt(), readDoc()]);

  /**
   * Unsaved work is held in memory rather than written on every nudge. A drag
   * is a dozen changes and the file is committed, so it is worth being asked
   * for rather than being rewritten a dozen times.
   */
  let dirty = false;
  installCosmetics(doc, () => {
    dirty = true;
    note("Unsaved changes.");
  });

  const panel = buildCosmeticsPanel(art, {
    note: (text) => note(text),
    save: {
      label: "Save to the repo",
      run: async (json) => {
        const answer = await writeDoc(json);
        dirty = false;
        return answer;
      },
    },
  });
  mount.appendChild(panel.root);
  note("Ready.");

  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    e.preventDefault();
  });
}

void start().catch((err: unknown) => {
  note(String(err instanceof Error ? err.message : err), true);
});
