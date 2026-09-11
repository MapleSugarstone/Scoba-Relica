import { beforeEach, describe, expect, it } from "vitest";
import {
  BIG_SHADOW, DEFAULT_SHADOW, NO_SHADOW, asOneStep, canRedo, canUndo, clearLine, clearPlacement,
  clearSetup, cosmetics, cosmeticsJson, emptyCosmetics, installCosmetics, movementFor,
  parseCosmetics, placedCount, placementFor, readCosmetics, redoCosmetics, setMovement,
  setPlacement, setSetup, setupFor, shadowFor, undoCosmetics,
} from "../src/game/cosmetics";
import { HYPER_FORM, SPECIES, costumesOf, kinCostumes } from "../src/sim/species";

/** A document of its own for each case, since the module holds the working copy. */
beforeEach(() => {
  installCosmetics(emptyCosmetics(), () => undefined);
});

describe("reading a document", () => {
  it("takes a file written before there was anything in it but placements", () => {
    const old = { cherry: { octoshake: { dx: 1, dy: 2, front: true } } };
    const doc = readCosmetics(old);
    expect(doc.pieces).toEqual(old);
    expect(doc.costumes).toEqual({});
    expect(doc.lines).toEqual({});
  });

  it("takes one written since, and fills in a part that is not there", () => {
    const doc = readCosmetics({ costumes: { plib: { body: { dx: 1, dy: 0 } } } });
    expect(doc.costumes["plib"]).toEqual({ body: { dx: 1, dy: 0 } });
    expect(doc.pieces).toEqual({});
    expect(doc.lines).toEqual({});
  });

  it("falls back to nothing moved on anything it cannot read", () => {
    expect(readCosmetics(null)).toEqual(emptyCosmetics());
    expect(readCosmetics("not a document")).toEqual(emptyCosmetics());
    expect(parseCosmetics("{oh dear")).toEqual(emptyCosmetics());
  });

  it("survives a round trip through the file", () => {
    setSetup("octoshake", { body: { dx: 2, dy: -3 }, shadow: { art: "shadow", dx: 0, dy: 1 } });
    setMovement("octoshake", "hover");
    setPlacement("cherry", "octoshake", { dx: 4, dy: 5, front: true });
    const again = parseCosmetics(cosmeticsJson());
    expect(again).toEqual(cosmetics());
  });
});

describe("what a costume is set to", () => {
  it("holds a spot, and hands it back", () => {
    setSetup("plib", { origin: { dx: 3, dy: -4 } });
    expect(setupFor("plib").origin).toEqual({ dx: 3, dy: -4 });
  });

  it("rounds to whole sprite pixels, since that is what a drawing has", () => {
    setSetup("plib", { center: { dx: 2.4, dy: -3.6 } });
    expect(setupFor("plib").center).toEqual({ dx: 2, dy: -4 });
  });

  it("stores nothing for a spot that is back where its art puts it", () => {
    setSetup("plib", { body: { dx: 5, dy: 0 } });
    setSetup("plib", { body: { dx: 0, dy: 0 } });
    expect(setupFor("plib")).toEqual({});
    expect(cosmetics().costumes["plib"]).toBeUndefined();
  });

  it("stores nothing for a body standing on the default shadow where it is drawn", () => {
    setSetup("plib", { shadow: { art: DEFAULT_SHADOW, dx: 0, dy: 0 } });
    expect(setupFor("plib").shadow).toBeUndefined();
    expect(shadowFor("plib")).toEqual({ art: DEFAULT_SHADOW, dx: 0, dy: 0 });
  });

  it("stores the larger shadow, a moved one, and none at all", () => {
    setSetup("plib", { shadow: { art: BIG_SHADOW, dx: 0, dy: 0 } });
    expect(shadowFor("plib").art).toBe(BIG_SHADOW);
    setSetup("plib", { shadow: { art: DEFAULT_SHADOW, dx: 0, dy: 3 } });
    expect(shadowFor("plib")).toEqual({ art: DEFAULT_SHADOW, dx: 0, dy: 3 });
    setSetup("plib", { shadow: { art: NO_SHADOW, dx: 0, dy: 0 } });
    expect(shadowFor("plib").art).toBe(NO_SHADOW);
  });

  it("puts one costume back on its own art without touching the rest", () => {
    setSetup("sqwoop", { body: { dx: 1, dy: 1 } });
    setSetup("octoshake", { body: { dx: 2, dy: 2 } });
    clearSetup("sqwoop");
    expect(setupFor("sqwoop")).toEqual({});
    expect(setupFor("octoshake").body).toEqual({ dx: 2, dy: 2 });
  });
});

describe("how a line carries itself", () => {
  it("is its species' until something says otherwise", () => {
    expect(movementFor("octoshake")).toBeNull();
    setMovement("octoshake", "hover");
    expect(movementFor("octoshake")).toBe("hover");
  });

  it("goes back to its species' when the override is taken off", () => {
    setMovement("octoshake", "hover");
    setMovement("octoshake", null);
    expect(movementFor("octoshake")).toBeNull();
    expect(cosmetics().lines["octoshake"]).toBeUndefined();
  });

  it("belongs to the line rather than to one of its drawings", () => {
    // Hyper-Mode is a redrawing, not a different gait.
    setMovement("octoshake", "skitter");
    expect(movementFor("octoshake")).toBe("skitter");
    expect(setupFor("hyper-octoshake")).toEqual({});
  });
});

describe("a piece on a costume", () => {
  it("still reads and writes the way it always did", () => {
    setPlacement("cherry", "octoshake", { dx: 3, dy: 4, front: true });
    expect(placementFor("cherry", "octoshake")).toEqual({ dx: 3, dy: 4, front: true });
    clearPlacement("cherry", "octoshake");
    expect(placementFor("cherry", "octoshake")).toBeNull();
  });

  it("is not confused by another costume of the same line", () => {
    setPlacement("cherry", "octoshake", { dx: 1, dy: 1 });
    setPlacement("cherry", "hyper-octoshake", { dx: 9, dy: 9 });
    expect(placementFor("cherry", "octoshake")).toEqual({ dx: 1, dy: 1 });
    expect(placementFor("cherry", "hyper-octoshake")).toEqual({ dx: 9, dy: 9 });
  });
});

describe("stepping back and forward", () => {
  it("has nothing to step back to on a fresh document", () => {
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
    expect(undoCosmetics()).toBe(false);
    expect(redoCosmetics()).toBe(false);
  });

  it("takes one change off and puts it back", () => {
    setPlacement("cherry", "octoshake", { dx: 3, dy: 4 });
    expect(canUndo()).toBe(true);
    expect(undoCosmetics()).toBe(true);
    expect(placementFor("cherry", "octoshake")).toBeNull();
    expect(redoCosmetics()).toBe(true);
    expect(placementFor("cherry", "octoshake")).toEqual({ dx: 3, dy: 4 });
  });

  it("walks back through changes to different things one at a time", () => {
    setPlacement("cherry", "octoshake", { dx: 1, dy: 1 });
    setPlacement("cherry", "sqwoop", { dx: 2, dy: 2 });
    setMovement("octoshake", "hover");
    undoCosmetics();
    expect(movementFor("octoshake")).toBeNull();
    expect(placementFor("cherry", "sqwoop")).toEqual({ dx: 2, dy: 2 });
    undoCosmetics();
    expect(placementFor("cherry", "sqwoop")).toBeNull();
    expect(placementFor("cherry", "octoshake")).toEqual({ dx: 1, dy: 1 });
  });

  it("counts a run of nudges at one thing as a single step", () => {
    // What the arrow keys do: the same piece on the same costume, over and over.
    for (let dy = 1; dy <= 6; dy++) setPlacement("cherry", "octoshake", { dx: 0, dy });
    expect(placementFor("cherry", "octoshake")).toEqual({ dx: 0, dy: 6 });
    undoCosmetics();
    expect(placementFor("cherry", "octoshake")).toBeNull();
  });

  it("drops the way forward once something else is changed", () => {
    setPlacement("cherry", "octoshake", { dx: 1, dy: 1 });
    undoCosmetics();
    expect(canRedo()).toBe(true);
    setMovement("plib", "hop");
    expect(canRedo()).toBe(false);
  });

  it("takes a whole line's reset off in one step", () => {
    setPlacement("cherry", "octoshake", { dx: 1, dy: 1 });
    setPlacement("cherry", "octoshake-cherryless", { dx: 2, dy: 2 });
    setSetup("octoshake", { origin: { dx: 5, dy: 0 } });
    setMovement("octoshake", "hover");
    clearLine(["octoshake", "octoshake-cherryless"], "octoshake");
    expect(placedCount()).toBe(0);
    expect(undoCosmetics()).toBe(true);
    // Every part of it comes back together.
    expect(placementFor("cherry", "octoshake")).toEqual({ dx: 1, dy: 1 });
    expect(placementFor("cherry", "octoshake-cherryless")).toEqual({ dx: 2, dy: 2 });
    expect(setupFor("octoshake").origin).toEqual({ dx: 5, dy: 0 });
    expect(movementFor("octoshake")).toBe("hover");
  });

  it("leaves another line alone when one is reset", () => {
    setPlacement("cherry", "octoshake", { dx: 1, dy: 1 });
    setPlacement("cherry", "plib", { dx: 9, dy: 9 });
    clearLine(["octoshake"], "octoshake");
    expect(placementFor("cherry", "octoshake")).toBeNull();
    expect(placementFor("cherry", "plib")).toEqual({ dx: 9, dy: 9 });
  });

  it("counts a group of changes as one step", () => {
    asOneStep(() => {
      setPlacement("cherry", "octoshake", { dx: 1, dy: 1 });
      setPlacement("cherry", "plib", { dx: 2, dy: 2 });
      setMovement("plib", "hover");
    });
    expect(undoCosmetics()).toBe(true);
    expect(placedCount()).toBe(0);
  });

  it("starts a fresh history when a document is installed", () => {
    setPlacement("cherry", "octoshake", { dx: 1, dy: 1 });
    expect(canUndo()).toBe(true);
    installCosmetics(emptyCosmetics(), () => undefined);
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });
});

describe("which costumes are drawn from the same body", () => {
  const octoshake = SPECIES["octoshake"]!;
  const names = (tags: string[]): string[] =>
    kinCostumes(octoshake, tags).map((c) => c.tags.join("+") || "as drawn");

  it("lists every costume a line has", () => {
    expect(costumesOf(octoshake).map((c) => c.tags.join("+") || "as drawn"))
      .toEqual(["as drawn", "cherryless", "hyper", "cherryless+hyper"]);
  });

  it("keeps the ordinary drawings together", () => {
    expect(names([])).toEqual(["as drawn", "cherryless"]);
    expect(names(["cherryless"])).toEqual(["as drawn", "cherryless"]);
  });

  it("keeps the Hyper drawings together", () => {
    expect(names([HYPER_FORM])).toEqual(["hyper", "cherryless+hyper"]);
    expect(names(["cherryless", HYPER_FORM])).toEqual(["hyper", "cherryless+hyper"]);
  });

  it("never reaches across the two, whichever side it starts on", () => {
    for (const tags of [[], ["cherryless"], [HYPER_FORM], ["cherryless", HYPER_FORM]]) {
      const hyper = tags.includes(HYPER_FORM);
      expect(kinCostumes(octoshake, tags).every((c) => c.tags.includes(HYPER_FORM) === hyper))
        .toBe(true);
    }
  });

  it("leaves a line drawn one way with only itself", () => {
    expect(kinCostumes(SPECIES["plib"]!, [])).toHaveLength(1);
  });
});

describe("how much has been set", () => {
  it("counts pieces, costumes and lines alike", () => {
    expect(placedCount()).toBe(0);
    setPlacement("cherry", "octoshake", { dx: 1, dy: 0 });
    setSetup("octoshake", { body: { dx: 1, dy: 0 } });
    setMovement("octoshake", "hover");
    expect(placedCount()).toBe(3);
  });
});
