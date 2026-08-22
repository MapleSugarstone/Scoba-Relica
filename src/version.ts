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
