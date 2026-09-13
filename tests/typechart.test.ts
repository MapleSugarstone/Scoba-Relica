import { describe, expect, it } from "vitest";
import { TYPES, effectiveness, type ElementType } from "../src/sim/types";
import { typesEffectiveness } from "../src/sim/species";

/** The first attack with two defenders it reads `want` against, found off the chart itself. */
function pairFor(want: number): { attack: ElementType; defend: [ElementType, ElementType] } {
  for (const attack of TYPES) {
    const hits = TYPES.filter((d) => effectiveness(attack, d) === want);
    if (hits.length >= 2) return { attack, defend: [hits[0]!, hits[1]!] };
  }
  throw new Error(`no attack reads ${want} against two types`);
}

describe("stacked effectiveness", () => {
  it("adds a multiple per weakness rather than doubling again", () => {
    const { attack, defend } = pairFor(2);
    expect(typesEffectiveness([attack], [defend[0]])).toBe(2);
    expect(typesEffectiveness([attack], defend)).toBe(3);
  });

  it("adds a divisor per resistance rather than halving again", () => {
    const { attack, defend } = pairFor(0.5);
    expect(typesEffectiveness([attack], [defend[0]])).toBe(0.5);
    expect(typesEffectiveness([attack], defend)).toBeCloseTo(1 / 3);
  });

  it("lets a weakness and a resistance cancel to even", () => {
    const weak = pairFor(2);
    const resist = TYPES.find((d) => effectiveness(weak.attack, d) === 0.5);
    if (!resist) throw new Error("no resistance to pair against");
    expect(typesEffectiveness([weak.attack], [weak.defend[0], resist])).toBe(1);
  });

  it("reads even where the chart says nothing", () => {
    expect(typesEffectiveness(["plain"], ["plain", "plain"])).toBe(1);
  });
});
