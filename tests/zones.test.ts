import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/game/content";
import { cloneZone, ZONE_DEFAULTS, zoneSpecies } from "../src/game/world";

/** One map with one zone, built from whatever roster the case wants. */
function zoneFrom(zone: Record<string, unknown>): ReturnType<typeof normalizeContent>["maps"][number]["zones"] {
  return normalizeContent({
    maps: [{ id: "m", terrain: ["wwww", "wwww", "wwww", "wwww"], zones: [{ x: 0, y: 0, w: 64, h: 64, ...zone }] }],
  }).maps[0]!.zones;
}

describe("zone rosters", () => {
  it("gives a fresh kind the defaults", () => {
    const sp = zoneSpecies("catsquito");
    expect(sp).toMatchObject({
      species: "catsquito",
      minLv: ZONE_DEFAULTS.minLv,
      maxLv: ZONE_DEFAULTS.maxLv,
      ratePerSec: ZONE_DEFAULTS.ratePerSec,
      max: ZONE_DEFAULTS.max,
      speed: ZONE_DEFAULTS.speed,
      detect: ZONE_DEFAULTS.detect,
      tiles: [],
    });
  });

  it("keeps every setting a kind names", () => {
    const zones = zoneFrom({
      max: 9,
      species: [{
        species: "catsquito", minLv: 5, maxLv: 8, ratePerSec: 0.25,
        max: 3, speed: 90, detect: 140, tiles: ["dirt0", "dirt1"],
      }],
    });
    expect(zones[0]!.max).toBe(9);
    expect(zones[0]!.species[0]).toEqual({
      species: "catsquito", minLv: 5, maxLv: 8, ratePerSec: 0.25,
      max: 3, speed: 90, detect: 140, tiles: ["dirt0", "dirt1"],
    });
  });

  it("lifts a roster of bare ids, spreading the zone's old level range", () => {
    const zones = zoneFrom({ species: ["catsquito", "meepa"], minLv: 6, maxLv: 9 });
    expect(zones[0]!.max).toBe(ZONE_DEFAULTS.zoneMax);
    expect(zones[0]!.species.map((s) => s.species)).toEqual(["catsquito", "meepa"]);
    for (const sp of zones[0]!.species) {
      expect(sp).toMatchObject({ minLv: 6, maxLv: 9, tiles: [], speed: ZONE_DEFAULTS.speed });
    }
  });

  it("keeps a rate of zero, which is a kind that never comes out", () => {
    const zones = zoneFrom({ species: [{ species: "catsquito", ratePerSec: 0, max: 0 }] });
    expect(zones[0]!.species[0]!.ratePerSec).toBe(0);
    expect(zones[0]!.species[0]!.max).toBe(0);
  });

  it("drops a kind twice over, and one nothing recognizes", () => {
    const zones = zoneFrom({
      species: ["catsquito", { species: "catsquito", max: 9 }, { species: "notascoba" }, "meepa"],
    });
    expect(zones[0]!.species.map((s) => s.species)).toEqual(["catsquito", "meepa"]);
  });

  it("drops a zone with nothing left to spawn", () => {
    expect(zoneFrom({ species: [] })).toEqual([]);
    expect(zoneFrom({ species: ["notascoba"] })).toEqual([]);
  });

  it("holds a level range the right way round", () => {
    const zones = zoneFrom({ species: [{ species: "catsquito", minLv: 9, maxLv: 3 }] });
    expect(zones[0]!.species[0]).toMatchObject({ minLv: 9, maxLv: 9 });
  });

  it("clones deeply, so a runtime zone never writes back into content", () => {
    const zone = { x: 0, y: 0, w: 32, h: 32, max: 2, species: [zoneSpecies("catsquito")] };
    const copy = cloneZone(zone);
    copy.species[0]!.speed = 200;
    copy.species[0]!.tiles.push("dirt0");
    expect(zone.species[0]!.speed).toBe(ZONE_DEFAULTS.speed);
    expect(zone.species[0]!.tiles).toEqual([]);
  });
});
