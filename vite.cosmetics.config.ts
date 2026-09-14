// The standalone cosmetics editor: `npm run cosmetics`.
//
// Its own Vite root under `tools/cosmetics`, so it serves one page and never
// boots the game. It still imports the game's modules, which is the point: the
// art, the species list and the placement rule are the real ones.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import { cosmeticsFile } from "./tools/vite-plugin-cosmetics";
import { SCRATCH_ART } from "./vite.config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(root, "tools/cosmetics"),
  // Assets are globbed out of `assets/`, which is above the page's own root.
  server: {
    fs: { allow: [root] }, port: 5273, open: true,
    // The files the editor writes stay watched, so a reload always reads what is
    // on disk. The editor's own saves skip the reload (see the plugin), and an
    // edit made to those files anywhere else still reloads the page.
    watch: { ignored: SCRATCH_ART },
  },
  // `__BUILD_VERSION__` is baked into the game's bundle and reached through a
  // module or two of what this imports, so it has to be defined here too.
  define: { __BUILD_VERSION__: JSON.stringify("cosmetics") },
  plugins: [cosmeticsFile(root)],
});
