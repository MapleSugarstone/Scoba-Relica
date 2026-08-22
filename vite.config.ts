import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { serviceWorker } from "./tools/vite-plugin-sw";

/**
 * The build, taken from git so it moves on every push without anyone having to
 * remember to bump it. Shown on the title screen and in the diagnostics, so a
 * tester's screenshot says which build they are actually on.
 */
function buildVersion(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim().length > 0;
    return dirty ? `${sha}+` : sha;
  } catch {
    // No git, which is a source download rather than a checkout.
    return "dev";
  }
}

// base './' keeps asset URLs relative so the build works on GitHub Pages
// regardless of repo name.
export default defineConfig({
  base: "./",
  // Art is emitted as files rather than inlined into the bundle: the sprite
  // roster only grows, and a browser can cache a sheet it already has.
  build: { target: "es2022", assetsInlineLimit: 0 },
  define: { __BUILD_VERSION__: JSON.stringify(buildVersion()) },
  plugins: [serviceWorker()],
  // The relay's own tests drive a running `wrangler dev` over real sockets, so
  // they are not part of the game's suite and must not run in its CI step.
  test: { exclude: ["**/node_modules/**", "**/dist/**", "worker/**"] },
  server: { host: true },
});
