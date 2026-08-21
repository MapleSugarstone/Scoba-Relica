import type { TileMap } from "../engine/tilemap";

/** One kind of Scoba in a zone, and how it behaves while it is out. */
export interface ZoneSpecies {
  species: string;
  minLv: number;
  maxLv: number;
  /** Chance per second that one more appears, while both caps allow it. */
  ratePerSec: number;
  /** Most of this species out at once. */
  max: number;
  /** World px per second while charging. It wanders at a fraction of this. */
  speed: number;
  /** How near you have to get before it charges. */
  detect: number;
  /** Tileset keys it rises from. Empty means anywhere walkable in the zone. */
  tiles: string[];
}

export interface EncounterZone {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Most Scobas of any kind out in this zone at once. */
  max: number;
  species: ZoneSpecies[];
}

export const ZONE_DEFAULTS = {
  ratePerSec: 0.5,
  max: 2,
  speed: 58,
  detect: 76,
  minLv: 2,
  maxLv: 4,
  zoneMax: 4,
} as const;

/** How fast one drifts when it has not noticed you, as a share of its speed. */
export const WANDER_SHARE = 0.38;

export function zoneSpecies(species: string): ZoneSpecies {
  return {
    species,
    minLv: ZONE_DEFAULTS.minLv,
    maxLv: ZONE_DEFAULTS.maxLv,
    ratePerSec: ZONE_DEFAULTS.ratePerSec,
    max: ZONE_DEFAULTS.max,
    speed: ZONE_DEFAULTS.speed,
    detect: ZONE_DEFAULTS.detect,
    tiles: [],
  };
}

/** Zones are handed to the runtime as copies, so edits never alias the world. */
export function cloneZone(z: EncounterZone): EncounterZone {
  return { ...z, species: z.species.map((sp) => ({ ...sp, tiles: [...sp.tiles] })) };
}

export interface WorldDef {
  map: TileMap;
  spawn: { x: number; y: number };
  encounters: EncounterZone[];
  /** Terrain arrays behind the painter, exposed so the dev editor can edit
   * them live and the content snapshot can capture them. */
  layout?: { land: boolean[]; deck: boolean[] };
}
