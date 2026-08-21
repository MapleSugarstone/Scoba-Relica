import { describe, expect, it } from "vitest";
import {
  breed,
  canBreed,
  droppableFrom,
  inheritGenes,
  inheritableFrom,
  pickTint,
} from "../src/sim/breeding";
import { costOf, makeWild, moveCost, unnaturalMoves, MAX_MANA, UNNATURAL_SURCHARGE } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { MOVES, SPECIES } from "../src/sim/species";

describe("inheritGenes", () => {
  it("mixes 80% mom / 20% dad per stat, rounded", () => {
    const mom = { hp: 100, str: 50, def: 40, res: 60, mag: 45, spd: 10 };
    const dad = { hp: 50, str: 100, def: 40, res: 30, mag: 52, spd: 20 };
    expect(inheritGenes(mom, dad)).toEqual({ hp: 90, str: 60, def: 40, res: 54, mag: 46, spd: 12 });
  });
});

describe("breed", () => {
  const mom = (): ReturnType<typeof makeWild> => makeWild("obera", 20, rngFrom("mom"));
  const dad = (): ReturnType<typeof makeWild> => makeWild("plib", 20, rngFrom("dad"));

  it("child is mom's species at level 1 with count max(parents)+1", () => {
    const child = breed(mom(), dad(), rngFrom("x")).child;
    expect(child.speciesId).toBe("obera");
    expect(child.level).toBe(1);
    expect(child.breedCount).toBe(1);
    expect(child.genes).toEqual(inheritGenes(SPECIES.obera!.genes, SPECIES.plib!.genes));
  });

  it("leaves an inherited move on the slot it replaced", () => {
    const m = makeWild("obera", 12, rngFrom("slot-mom"));
    const d = makeWild("plib", 12, rngFrom("slot-dad"));
    const child = breed(m, d, rngFrom("slot-child")).child;
    expect(child.moves).toHaveLength(m.moves.length);
    // Every slot either still holds mom's move or holds the one that took it,
    // and nothing else has shuffled around it.
    let swapped = 0;
    child.moves.forEach((mv, i) => {
      if (mv === m.moves[i]) return;
      swapped += 1;
      expect(d.moves).toContain(mv);
    });
    expect(swapped).toBeLessThanOrEqual(1);
  });

  it("replaces exactly one of mom's moves with one of dad's", () => {
    const m = mom();
    const d = dad();
    const child = breed(m, d, rngFrom("y")).child;
    const fromDad = child.moves.filter((mv) => !m.moves.includes(mv));
    expect(fromDad.length).toBe(1);
    expect(d.moves).toContain(fromDad[0]);
    expect(child.moves.length).toBe(m.moves.length);
  });

  it("puts the named move on the named slot", () => {
    const m = mom();
    const d = dad();
    const offered = inheritableFrom(m, d);
    expect(offered.length).toBeGreaterThan(0);
    const drop = m.moves[1]!;
    const take = offered[offered.length - 1]!;
    const child = breed(m, d, rngFrom("swap"), { drop, take }).child;
    expect(child.moves[1]).toBe(take);
    expect(child.moves.filter((mv) => mv === take)).toHaveLength(1);
    m.moves.forEach((mv, i) => {
      if (i !== 1) expect(child.moves[i]).toBe(mv);
    });
  });

  it("rolls the swap when the pair names something the parents cannot do", () => {
    const m = mom();
    const d = dad();
    const child = breed(m, d, rngFrom("bogus"), { drop: "not-a-move", take: "also-not" }).child;
    const fromDad = child.moves.filter((mv) => !m.moves.includes(mv));
    expect(fromDad).toHaveLength(1);
    expect(d.moves).toContain(fromDad[0]);
  });

  it("charges the surcharge for a move the line does not learn", () => {
    const m = mom();
    const d = dad();
    const offered = inheritableFrom(m, d);
    const take = offered[0]!;
    const child = breed(m, d, rngFrom("cost"), { drop: m.moves[0]!, take }).child;
    expect(moveCost(child, take)).toBe(MOVES[take]!.manaCost + UNNATURAL_SURCHARGE);
    // Everything its own line learns is priced as written.
    for (const id of child.moves) {
      if (id === take) continue;
      expect(moveCost(child, id)).toBe(MOVES[id]!.manaCost);
    }
    expect(unnaturalMoves(child)).toEqual([take]);
  });

  it("never offers a move the child could not afford to cast", () => {
    const m = mom();
    const d = dad();
    // Nothing in the roster is dear enough to be refused today, so the rule is
    // checked against the price rather than against a move that does not exist.
    for (const id of inheritableFrom(m, d)) {
      expect(costOf(m.speciesId, id)).toBeLessThanOrEqual(MAX_MANA);
    }
    const dear = { ...d, moves: ["nuzzle-nap"] };
    const priced = costOf(m.speciesId, "nuzzle-nap");
    expect(inheritableFrom(m, dear).length).toBe(priced <= MAX_MANA ? 1 : 0);
  });

  it("holds one worked move at most, so a second generation trades the first", () => {
    const m = mom();
    const d = dad();
    const first = breed(m, d, rngFrom("gen1"), { drop: m.moves[0]!, take: inheritableFrom(m, d)[0]! }).child;
    expect(unnaturalMoves(first)).toHaveLength(1);
    // The only slot its own child may give up is the one it works.
    expect(droppableFrom(first)).toEqual(unnaturalMoves(first));
    first.level = 10;
    const second = breed(first, d, rngFrom("gen2")).child;
    expect(unnaturalMoves(second).length).toBeLessThanOrEqual(1);
  });

  it("inherits dad's secondary ability about 10% of the time", () => {
    let dadCount = 0;
    const runs = 2000;
    for (let i = 0; i < runs; i++) {
      const m = mom();
      const d = dad();
      m.secondaryAbility = "deep-lungs";
      d.secondaryAbility = "sly-mind";
      const child = breed(m, d, rngFrom(`run${i}`)).child;
      if (child.secondaryAbility === "sly-mind") dadCount += 1;
      else expect(child.secondaryAbility).toBe("deep-lungs");
    }
    expect(dadCount / runs).toBeGreaterThan(0.07);
    expect(dadCount / runs).toBeLessThan(0.13);
  });

  it("pairs any two lines, but refuses special Scobas and bred-out ones", () => {
    expect(canBreed(mom(), makeWild("flarea", 10, rngFrom("p")))).toBeNull();
    expect(canBreed(makeWild("relica", 10, rngFrom("s")), dad())).toMatch(/cannot breed/);
    const tired = mom();
    tired.breedCount = 2;
    expect(canBreed(tired, dad())).toMatch(/twice/);
    const once = breed(mom(), dad(), rngFrom("g1")).child;
    once.level = 10;
    const twice = breed(once, dad(), rngFrom("g2")).child;
    expect(twice.breedCount).toBe(2);
    expect(canBreed(twice, dad())).toMatch(/twice/);
  });
});

describe("the father's colour mask", () => {
  const c = (hex: string, count: number) => ({ hex, count });

  it("paints his commonest unshared colour over the child's rarest", () => {
    const dad = [c("#000000", 900), c("#1d19ff", 400), c("#ffffff", 300), c("#1613c1", 90)];
    const child = [c("#000000", 800), c("#0e821b", 500), c("#53a367", 120), c("#eeff00", 18)];
    // Blue is the most of what the child does not already wear; the yellow
    // fleck is the least of what it does.
    expect(pickTint(dad, child)).toEqual({ from: "#eeff00", to: "#1d19ff" });
  });

  it("leaves line art alone, so a black and white child takes no mask", () => {
    const dad = [c("#000000", 900), c("#ff2188", 200)];
    const child = [c("#000000", 1100), c("#ffffff", 980)];
    expect(pickTint(dad, child)).toBeNull();
  });

  it("does nothing when the father brings no colour of his own", () => {
    const dad = [c("#000000", 900), c("#87ff77", 600)];
    const child = [c("#000000", 800), c("#87ff77", 300), c("#a31557", 90)];
    expect(pickTint(dad, child)).toBeNull();
  });

  it("marks an Obera's Wispen child with the green it does not wear", () => {
    // Pixel counts measured off the shipped art, so the rule is pinned to a
    // pair that really happens rather than to numbers made up for a test.
    const obera = [c("#000000", 1359), c("#0e821b", 518), c("#53a367", 122), c("#eeff00", 18)];
    const wispen = [c("#000000", 1089), c("#8914ff", 347), c("#5800aa", 246), c("#ffffff", 10)];
    // Black is shared and skipped, so the father's leaf green is the most of
    // what he brings; the child's darker purple is the least it wears.
    expect(pickTint(obera, wispen)).toEqual({ from: "#5800aa", to: "#0e821b" });
  });

  it("breaks ties on the colour itself, so two clients paint the same pixel", () => {
    const dad = [c("#ff0000", 100), c("#00ff00", 100)];
    const child = [c("#000000", 500), c("#123456", 40), c("#abcdef", 40)];
    expect(pickTint(dad, child)).toEqual({ from: "#123456", to: "#00ff00" });
  });
});
