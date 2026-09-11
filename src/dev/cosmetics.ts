// The cosmetics editor hung on a game screen, behind F3.
//
// The editor itself is `cosmeticspanel.ts`, which `npm run cosmetics` mounts on
// a page of its own. All this adds is the screen around it, and it writes to
// the same file over the dev server's `/api/cosmetics`, so a placement made
// here and one made there are the same placement. Use this one to check a
// piece against a Scoba in the fight it will be seen in; use the standalone
// one when placing a set of them is the whole job.
import type { Art } from "../engine/assets";
import { installCosmetics, parseCosmetics, type CosmeticDoc } from "../game/cosmetics";
import type { UI } from "../ui/screens";
import { buildCosmeticsPanel, type Panel } from "./cosmeticspanel";

/** Reads the committed document, so the editor opens on what is in the repo. */
async function readDoc(): Promise<CosmeticDoc> {
  const res = await fetch("/api/cosmetics");
  if (!res.ok) throw new Error(String(res.status));
  return parseCosmetics(await res.text());
}

/**
 * The editor that is open, or null. One at a time: a second screen over the
 * first would leave two live key handlers, and an arrow key would move a piece
 * on each of their selections.
 */
let live: (() => void) | null = null;

/** Is the editor on screen? */
export function cosmeticsOpen(): boolean {
  return live !== null;
}

/** Opens the editor, or closes the one already up. */
export function toggleCosmetics(ui: UI, art: Art, onClose: () => void): void {
  if (live) {
    live();
    return;
  }
  openCosmetics(ui, art, onClose);
}

export function openCosmetics(ui: UI, art: Art, onClose: () => void): void {
  if (live) return;
  let panel: Panel | null = null;
  // Only the dev server can write the file. A built game has no endpoint to
  // reach, so the editor opens read-only rather than pretending it can save.
  let writable = false;
  void readDoc()
    .then((doc) => {
      writable = true;
      installCosmetics(doc, () => undefined);
      ui.toast("Editing src/game/content/cosmetics.json.");
    })
    .catch(() => ui.toast("No dev server to write to. Nothing here will stick."));

  const close = (): void => {
    live = null;
    panel?.dispose();
    window.removeEventListener("keydown", leaveKey);
    ui.setLocked(false);
    ui.closeScreen();
    onClose();
  };

  // Escape leaves, since the screen is locked and nothing else would.
  const leaveKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    close();
  };

  live = close;
  ui.screen((root) => {
    panel = buildCosmeticsPanel(art, {
      note: (text) => ui.toast(text),
      onDone: close,
      save: {
        label: "Save to the repo",
        run: async (json) => {
          if (!writable) throw new Error("there is no dev server to write to");
          const res = await fetch("/api/cosmetics", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: json,
          });
          const said = (await res.text()).trim();
          if (!res.ok) throw new Error(said || `save failed (${res.status})`);
          return said || "Saved.";
        },
      },
    });
    root.appendChild(panel.root);
  });
  window.addEventListener("keydown", leaveKey);
  ui.setLocked(true);
}
