import { loadImage } from "./image";
import { loadPaperdoll, type PaperdollArt } from "./paperdoll";

export { loadImage };

export interface Art {
  doll: PaperdollArt;
  /** Scoba art, keyed by the species sprite name. */
  scobas: Record<string, HTMLImageElement>;
  /** Island tile art, keyed by lower-cased file name. */
  tiles: Record<string, HTMLImageElement>;
}

// Scoba art comes straight from `assets/Scobas`, same as the doll layers: drop
// a PNG in there and it is available under its lower-cased file name, which is
// the key a species points at with `sprite: { kind: "art", art: "..." }`.
const SCOBA_FILES = import.meta.glob("../../assets/Scobas/*.png", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

const TILE_FILES = import.meta.glob("../../assets/Tiles/*.png", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

function byFileName(files: Record<string, string>): { name: string; url: string }[] {
  return Object.entries(files).map(([path, url]) => ({
    name: path.split("/").pop()!.replace(/\.png$/i, "").toLowerCase(),
    url,
  }));
}

const SCOBA_URLS = byFileName(SCOBA_FILES);
const TILE_URLS = byFileName(TILE_FILES);

export async function loadArt(): Promise<Art> {
  const [doll, drawn, tiled] = await Promise.all([
    loadPaperdoll(),
    Promise.all(SCOBA_URLS.map((s) => loadImage(s.url))),
    Promise.all(TILE_URLS.map((t) => loadImage(t.url))),
  ]);
  const scobas = Object.fromEntries(SCOBA_URLS.map((s, i) => [s.name, drawn[i]!]));
  const tiles = Object.fromEntries(TILE_URLS.map((t, i) => [t.name, tiled[i]!]));
  return { doll, scobas, tiles };
}
