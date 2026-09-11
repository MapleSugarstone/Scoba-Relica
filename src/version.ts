// What build this is. `__BUILD_VERSION__` is replaced at build time from the
// git commit (see `vite.config.ts`), so it moves on every push by itself; a
// trailing `+` means the build had uncommitted changes.
//
// This is separate from `PROTOCOL_VERSION`, and deliberately so. This one is
// for saying which build somebody is running. That one decides whether two
// players can talk to each other, and only changes when the messages do: a new
// sprite should not stop two people playing together.
declare const __BUILD_VERSION__: string;

export const BUILD_VERSION: string =
  typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : "dev";

/**
 * Whether this is somebody working on the game rather than playing it: a dev
 * server, or any build reached with `?dev=1`. The editors hang off this, and so
 * does the Aetus a dev has to spend, which is all of it.
 */
export function devMode(): boolean {
  try {
    return import.meta.env.DEV || new URLSearchParams(location.search).has("dev");
  } catch {
    // No document to read, which is a test or a worker rather than a player.
    return false;
  }
}
