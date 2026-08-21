import { defineConfig } from "vite";
import { serviceWorker } from "./tools/vite-plugin-sw";

// base './' keeps asset URLs relative so the build works on GitHub Pages
// regardless of repo name.
export default defineConfig({
  base: "./",
  // Art is emitted as files rather than inlined into the bundle: the sprite
  // roster only grows, and a browser can cache a sheet it already has.
  build: { target: "es2022", assetsInlineLimit: 0 },
  plugins: [serviceWorker()],
  server: { host: true },
});
