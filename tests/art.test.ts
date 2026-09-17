import { describe, expect, it } from "vitest";
import { statusSummary, type Combatant } from "../src/sim/battle";
import { ABILITIES, MOVES, SPECIES, allSteps, speciesMoves } from "../src/sim/species";
import { STATUSES, isContinuous, newStatus, type Step } from "../src/sim/status";

/**
 * Every drawing the content names has to be on disk. A name with no file
 * behind it draws nothing at all and says nothing about it, so a move can sit
 * in the game for weeks showing an animation that was never there.
 *
 * Read the same way the game reads them, so this and the game agree about
 * which names are spelled for which files.
 */
const named = (paths: Record<string, unknown>): Set<string> =>
  new Set(Object.keys(paths).map((p) => p.split("/").pop()!.replace(/\.png$/i, "").toLowerCase()));

const POWERS = named(import.meta.glob("../assets/Powers/*.png"));
const SIGILS = named(import.meta.glob("../assets/Sigils/*.png"));

/** Every art name a list of steps asks to be drawn, whatever draws it. */
function drawn(steps: Step[]): string[] {
  const out: string[] = [];
  for (const s of allSteps(steps)) {
    if (s.kind === "show") out.push(s.art, ...s.pointers ?? []);
    if (s.kind === "throw" && s.art !== undefined) out.push(s.art);
  }
  return out;
}

describe("the drawings the content names", () => {
  it("has a file in assets/Powers for every one a move shows or throws", () => {
    const missing: string[] = [];
    for (const move of Object.values(MOVES)) {
      for (const art of drawn(move.cast)) {
        if (!POWERS.has(art.toLowerCase())) missing.push(`${move.id}: ${art}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has one for every drawing a status shows, throws or grows", () => {
    const missing: string[] = [];
    for (const status of Object.values(STATUSES)) {
      const steps = status.effects.filter((e): e is Step => "kind" in e) as Step[];
      for (const art of drawn(steps)) {
        if (!POWERS.has(art.toLowerCase())) missing.push(`${status.id}: ${art}`);
      }
      // A growth is a numbered set: one piece is "coral1" under the name "coral".
      const grows = status.growth;
      if (grows !== undefined && ![...POWERS].some((f) => f.startsWith(grows.toLowerCase()))) {
        missing.push(`${status.id}: ${grows}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has a file in assets/Sigils for every sigil a status wears", () => {
    const missing: string[] = [];
    for (const status of Object.values(STATUSES)) {
      const icon = status.icon;
      if (icon !== undefined && !SIGILS.has(icon.toLowerCase())) missing.push(`${status.id}: ${icon}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("the four slots a line holds", () => {
  it("holds them in the order the file writes them, rather than by price", () => {
    for (const sp of Object.values(SPECIES)) {
      const want = sp.moves.filter((id, i) => MOVES[id] && sp.moves.indexOf(id) === i).slice(0, 4);
      expect(speciesMoves(sp), sp.id).toEqual(want);
    }
  });

  it("writes them cheapest to dearest, so the heaviest lands in the bottom right", () => {
    const off: string[] = [];
    for (const sp of Object.values(SPECIES)) {
      const costs = speciesMoves(sp).map((id) => MOVES[id]!.manaCost);
      if (costs.some((c, i) => i > 0 && c < costs[i - 1]!)) off.push(sp.id);
    }
    expect(off).toEqual([]);
  });
});

describe("the sigils a passive wears", () => {
  /** A passive that does something for as long as it is carried. */
  const continuous = (id: string): boolean =>
    STATUSES[id]?.effects.some((e) => isContinuous(e.kind)) === true;

  it("shows a passive on the row when it holds for as long as it is carried", () => {
    const holder = { statuses: [newStatus("accelerated")!] } as Combatant;
    expect(statusSummary(holder).map((m) => m.id)).toEqual(["accelerated"]);
  });

  it("leaves one that only waits for a trigger with the abilities", () => {
    // Timelock hands out Deathlock on entry and then does nothing, so there is
    // nothing about it that is true of the Scoba right now.
    expect(continuous("timelock")).toBe(false);
    const holder = { statuses: [newStatus("timelock")!] } as Combatant;
    expect(statusSummary(holder)).toEqual([]);
  });

  it("draws every continuous passive with something, its own art or the placeholder", () => {
    const carried = Object.keys(STATUSES).filter((id) => STATUSES[id]!.innate && continuous(id));
    expect(carried.length).toBeGreaterThan(0);
    for (const id of carried) {
      const icon = STATUSES[id]!.icon;
      // Its own sigil where one has been drawn; the placeholder stands in until
      // one is, so a passive is never a gap on the row.
      if (icon !== undefined) expect(SIGILS.has(icon.toLowerCase()), id).toBe(true);
    }
    expect(SIGILS.has("placeholder")).toBe(true);
  });
});

describe("the Unwind line's own drawings", () => {
  it("wears a sigil on every mark it leaves", () => {
    // Unwound is the one still on the placeholder, waiting on art of its own.
    for (const id of ["chrono-slow", "deathlock", "undoing", "accelerated"]) {
      expect(STATUSES[id]?.icon, id).toBeDefined();
    }
  });

  it("throws a cog and spreads the zap out of whatever it struck", () => {
    const cast = MOVES["cogwork"]!.cast;
    expect(cast.find((s) => s.kind === "throw")).toMatchObject({ art: "cogwork", path: "toss" });
    expect(cast.find((s) => s.kind === "show")).toMatchObject({ art: "cogworkzap", path: "ghost" });
  });

  it("shoots the bolt on the quickest path there is", () => {
    expect(MOVES["chrono-bolt"]!.cast.find((s) => s.kind === "throw"))
      .toMatchObject({ art: "chronobolt", path: "bolt" });
  });

  it("spreads Time Shatter out of the enemy rather than throwing it at them", () => {
    const cast = MOVES["time-shatter"]!.cast;
    expect(cast.find((s) => s.kind === "show")).toMatchObject({ art: "timeshatter", path: "ghost" });
    expect(cast.some((s) => s.kind === "throw")).toBe(false);
  });

  it("marks the allies it is holding, so the board says who is covered", () => {
    expect(MOVES["undo"]!.cast.find((s) => s.kind === "undo-round")).toMatchObject({ mark: "undoing" });
    expect(STATUSES["undoing"]!.icon).toBe("undoing");
  });

  it("turns three hands on the Undo clock and one on the Deathlock clock", () => {
    expect(MOVES["undo"]!.cast.find((s) => s.kind === "show")).toMatchObject({
      art: "undoclock",
      path: "clock",
      pointers: ["undohourhand", "undominutehand", "undosecondhand"],
    });
    const fell = STATUSES["deathlock"]!.effects.find(
      (e) => "kind" in e && e.kind === "show",
    ) as Extract<Step, { kind: "show" }>;
    expect(fell).toMatchObject({ art: "deathclock", path: "clock", pointers: ["deathclockhand"] });
  });

  it("says who it belongs to on the sigil it hands out", () => {
    expect(ABILITIES["accelerated"]).toBeDefined();
    expect(STATUSES["accelerated"]!.icon).toBe("accelerated");
  });
});
