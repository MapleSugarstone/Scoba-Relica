// The tests run under Node, but the project is type-checked for the browser and
// carries no Node types, so the few Node calls a test makes are declared here.
// Vitest blanks every stylesheet it is asked to import, `?raw` included, so a
// test that reads CSS has to read it off the disk.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
}

declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
