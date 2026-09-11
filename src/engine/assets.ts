import { cropToContent, loadImage } from "./image";
import { loadPaperdoll, type PaperdollArt } from "./paperdoll";

export { loadImage };

export interface Art {
  doll: PaperdollArt;
  /** Scoba art, keyed by the species sprite name. */
  scobas: Record<string, HTMLImageElement>;
  /** Pawn art, keyed the same way. A Pawn species is looked up here instead. */
  pawns: Record<string, HTMLImageElement>;
  /**
   * Things worn over a Scoba rather than drawn into it, keyed the same way. A
   * Scoba that inherited a passive its own line does not have wears the mark
   * of the line it came from.
   */
  accessories: Record<string, HTMLImageElement>;
  /**
   * Move art, keyed the same way, cropped to what was drawn. A piece is
   * authored on the same canvas a Scoba is, so it is the crop rather than the
   * file that says how big the thing a spell throws actually is.
   */
  powers: Record<string, HTMLCanvasElement | HTMLImageElement>;
  /** Island tile art, keyed by lower-cased file name. */
  tiles: Record<string, HTMLImageElement>;
}

// Scoba art comes straight from `assets/Scobas`, same as the doll layers: drop
// a PNG in there and it is available under its lower-cased file name, which is
// the key a species points at with `sprite: { kind: "art", art: "..." }`. A
// Pawn's art sits in `assets/Pawns` and is read the same way.
const SCOBA_FILES = import.meta.glob("../../assets/Scobas/*.png", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

const PAWN_FILES = import.meta.glob("../../assets/Pawns/*.png", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

const ACCESSORY_FILES = import.meta.glob("../../assets/AccessoryScoba/*.png", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

const POWER_FILES = import.meta.glob("../../assets/Powers/*.png", {
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
const PAWN_URLS = byFileName(PAWN_FILES);
const ACCESSORY_URLS = byFileName(ACCESSORY_FILES);
const POWER_URLS = byFileName(POWER_FILES);
const TILE_URLS = byFileName(TILE_FILES);

export async function loadArt(): Promise<Art> {
  const [doll, drawn, called, worn, thrown, tiled] = await Promise.all([
    loadPaperdoll(),
    Promise.all(SCOBA_URLS.map((s) => loadImage(s.url))),
    Promise.all(PAWN_URLS.map((p) => loadImage(p.url))),
    Promise.all(ACCESSORY_URLS.map((a) => loadImage(a.url))),
    Promise.all(POWER_URLS.map((p) => loadImage(p.url))),
    Promise.all(TILE_URLS.map((t) => loadImage(t.url))),
  ]);
  const scobas = Object.fromEntries(SCOBA_URLS.map((s, i) => [s.name, drawn[i]!]));
  const pawns = Object.fromEntries(PAWN_URLS.map((p, i) => [p.name, called[i]!]));
  const accessories = Object.fromEntries(ACCESSORY_URLS.map((a, i) => [a.name, worn[i]!]));
  const powers = Object.fromEntries(POWER_URLS.map((p, i) => [p.name, cropToContent(thrown[i]!)]));
  const tiles = Object.fromEntries(TILE_URLS.map((t, i) => [t.name, tiled[i]!]));
  return { doll, scobas, pawns, accessories, powers, tiles };
}
