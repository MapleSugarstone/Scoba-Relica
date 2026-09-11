import { describe, expect, it } from "vitest";
import { volleys } from "../src/game/battlestage";
import type { BattleEvent } from "../src/sim/battle";

const hit = (moveId: string, index: number): BattleEvent =>
  ({ kind: "hit", text: "", moveId, at: { side: 1, index } });
const other = (kind: BattleEvent["kind"]): BattleEvent => ({ kind, text: "" });

describe("volleys", () => {
  it("leaves a single hit to itself", () => {
    const out = volleys([other("spell"), hit("cold-wave", 0), other("status")]);
    expect(out.lead.size).toBe(0);
    expect(out.follows.size).toBe(0);
  });

  it("groups a run of hits from one move behind its first", () => {
    const events = [other("spell"), hit("cold-wave", 0), hit("cold-wave", 1), other("status")];
    const out = volleys(events);
    expect([...out.lead.keys()]).toEqual([1]);
    expect(out.lead.get(1)).toEqual([{ side: 1, index: 0 }, { side: 1, index: 1 }]);
    expect([...out.follows]).toEqual([2]);
  });

  it("does not reach across a different move", () => {
    const events = [hit("cold-wave", 0), hit("tentacle-slap", 1)];
    const out = volleys(events);
    expect(out.lead.size).toBe(0);
    expect(out.follows.size).toBe(0);
  });

  it("does not reach across anything that is not a hit", () => {
    // A status between two hits means they were not one strike.
    const events = [hit("cold-wave", 0), other("status"), hit("cold-wave", 1)];
    const out = volleys(events);
    expect(out.lead.size).toBe(0);
    expect(out.follows.size).toBe(0);
  });

  it("handles two casts in one round without mixing them", () => {
    const events = [
      other("spell"), hit("cold-wave", 0), hit("cold-wave", 1),
      other("spell"), hit("scatter-shot", 0), hit("scatter-shot", 1),
    ];
    const out = volleys(events);
    expect([...out.lead.keys()].sort((a, b) => a - b)).toEqual([1, 4]);
    expect([...out.follows].sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it("never marks an event as both the lead and a follower", () => {
    const events = [
      hit("a", 0), hit("a", 1), hit("a", 2), other("heal"), hit("b", 0), hit("b", 1),
    ];
    const out = volleys(events);
    for (const i of out.lead.keys()) expect(out.follows.has(i)).toBe(false);
    expect([...out.lead.keys()].sort((a, b) => a - b)).toEqual([0, 4]);
    expect([...out.follows].sort((a, b) => a - b)).toEqual([1, 2, 5]);
  });

  it("terminates on an event list of nothing but hits with no move", () => {
    const nameless: BattleEvent[] = [
      { kind: "hit", text: "" }, { kind: "hit", text: "" },
    ];
    expect(() => volleys(nameless)).not.toThrow();
    expect(volleys(nameless).lead.size).toBe(0);
  });
});
