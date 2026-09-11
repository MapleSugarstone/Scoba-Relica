import { describe, expect, it } from "vitest";
import {
  breed,
  canBreed,
  droppableFrom,
  childGenes,
  inheritGenes,
  inheritableFrom,
  pickTints,
} from "../src/sim/breeding";
import { costOf, makeWild, moveCost, scobaTypes, unnaturalMoves, MAX_MANA, UNNATURAL_SURCHARGE } from "../src/sim/scoba";
import { BABY_BUDGET, statTotal } from "../src/sim/types";
import { rngFrom } from "../src/sim/rng";
import { MOVES, SPECIES, moveEffectiveness } from "../src/sim/species";

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

  it("child is mom's first form at level 1 with count max(parents)+1", () => {
    const m = mom();
    const d = dad();
    const child = breed(m, d, rngFrom("x")).child;
    // Obera has no baby form drawn, so its children are Oberas.
    expect(child.speciesId).toBe("obera");
    expect(child.level).toBe(1);
    expect(child.breedCount).toBe(1);
    expect(child.genes).toEqual(childGenes(m, d));
  });

  it("crosses the father's ability every time when told to", () => {
    // What the nest's debug switch turns on. The roll is one in ten, so the
    // only way to see an inherited passive without hatching a dozen children
    // is to stop rolling for it.
    const m = makeWild("obera", 20, rngFrom("fm"));
    const d = makeWild("plib", 20, rngFrom("fd"));
    d.secondaryAbility = "thick-coat";
    m.secondaryAbility = "moss-heart";
    for (let i = 0; i < 25; i++) {
      const { child, fromDad } = breed(
        { ...m }, { ...d }, rngFrom(`f${i}`), undefined, { forceDadAbility: true },
      );
      expect(fromDad).toBe(true);
      expect(child.secondaryAbility).toBe("thick-coat");
    }
  });

  it("hatches shiny every time when told to", () => {
    // What the nest's other debug switch turns on. One in three hundred is a
    // long wait to look at a palette.
    const m = makeWild("obera", 20, rngFrom("sm"));
    const d = makeWild("plib", 20, rngFrom("sd"));
    for (let i = 0; i < 25; i++) {
      const { child } = breed({ ...m }, { ...d }, rngFrom(`s${i}`), undefined, { forceShiny: true });
      expect(child.shiny).toBe(true);
    }
  });

  it("leaves the shine to the roll when not told to", () => {
    const m = makeWild("obera", 20, rngFrom("qm"));
    const d = makeWild("plib", 20, rngFrom("qd"));
    const lit = Array.from({ length: 300 }, (_, i) =>
      breed({ ...m }, { ...d }, rngFrom(`q${i}`)).child.shiny === true).filter(Boolean).length;
    expect(lit).toBeLessThan(20);
  });

  it("still rolls for it when not told to", () => {
    const m = makeWild("obera", 20, rngFrom("rm"));
    const d = makeWild("plib", 20, rngFrom("rd"));
    d.secondaryAbility = "thick-coat";
    m.secondaryAbility = "moss-heart";
    const took = Array.from({ length: 200 }, (_, i) =>
      breed({ ...m }, { ...d }, rngFrom(`r${i}`)).fromDad).filter(Boolean).length;
    expect(took).toBeGreaterThan(0);
    expect(took).toBeLessThan(80);
  });

  it("hatches a line with a baby form as that baby", () => {
    const m = makeWild("octoshake", 20, rngFrom("om"));
    const d = makeWild("plib", 20, rngFrom("od"));
    const child = breed(m, d, rngFrom("oc")).child;
    expect(child.speciesId).toBe("sqwoop");
    // Both parents are read at the baby scale, so the child is built on the
    // baby budget rather than on either parent's own.
    expect(statTotal(child.genes)).toBeLessThanOrEqual(BABY_BUDGET + 6);
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

describe("the element a passive brings with it", () => {
  const pair = (momId: string, dadId: string) => {
    const m = makeWild(momId, 20, rngFrom(`tm${momId}`));
    const d = makeWild(dadId, 20, rngFrom(`td${dadId}`));
    return breed(m, d, rngFrom("t"), undefined, { forceDadAbility: true }).child;
  };

  it("gives a child that took his passive the element he leads with", () => {
    // Obera is Moss, Cresce is Moon.
    const child = pair("obera", "cresce");
    expect(child.type2).toBe("moon");
    expect(scobaTypes(child)).toEqual(["moss", "moon"]);
  });

  it("stands in for its own line's second rather than making a third", () => {
    // Meepa is Moon/Plain; a Sun father replaces the Plain half.
    const child = pair("meepa", "flarea");
    expect(SPECIES.meepa!.type2).toBe("plain");
    expect(scobaTypes(child)).toEqual(["moon", "sun"]);
    expect(scobaTypes(child)).toHaveLength(2);
  });

  it("brings nothing when he leads with what the child already is", () => {
    const child = pair("obera", "obera");
    expect(child.type2).toBeUndefined();
    expect(scobaTypes(child)).toEqual(["moss"]);
  });

  it("brings nothing when the passive was the mother's", () => {
    const m = makeWild("obera", 20, rngFrom("nm"));
    const d = makeWild("cresce", 20, rngFrom("nd"));
    let plain = 0;
    for (let i = 0; i < 60; i++) {
      const { child, fromDad } = breed(m, d, rngFrom(`n${i}`));
      if (!fromDad) {
        expect(child.type2).toBeUndefined();
        plain += 1;
      }
    }
    expect(plain).toBeGreaterThan(0);
  });

  it("is what the chart is read against, not the species", () => {
    const child = pair("obera", "cresce");
    // Moss alone resists Moon; Moss/Moon takes it square on.
    expect(moveEffectiveness(MOVES["moonbeam"]!, ["moss"]))
      .not.toBe(moveEffectiveness(MOVES["moonbeam"]!, scobaTypes(child)));
  });
});

describe("the father's colour mask", () => {
  const c = (hex: string, count: number) => ({ hex, count });

  it("keeps what the child is mostly made of and repaints the rest", () => {
    const dad = [c("#000000", 900), c("#1d19ff", 400), c("#1613c1", 90), c("#ffffff", 300)];
    const child = [c("#000000", 800), c("#0e821b", 500), c("#53a367", 120), c("#eeff00", 18)];
    const out = pickTints(dad, child);
    // Its main green is left alone; the two under it take his two blues.
    expect(out.some((t) => t.from === "#0e821b")).toBe(false);
    expect(out).toContainEqual({ from: "#53a367", to: "#1d19ff" });
    expect(out).toContainEqual({ from: "#eeff00", to: "#1613c1" });
  });

  it("turns what his palette does not reach rather than leaving it behind", () => {
    // One colour to give, three secondaries to cover.
    const dad = [c("#000000", 900), c("#1d19ff", 400)];
    const child = [
      c("#000000", 800), c("#0e821b", 500), c("#53a367", 120),
      c("#88cc44", 60), c("#eeff00", 18),
    ];
    const out = pickTints(dad, child);
    expect(out.map((t) => t.from)).toEqual(["#53a367", "#88cc44", "#eeff00"]);
    expect(out[0]!.to).toBe("#1d19ff");
    // The two past his palette are turned rather than dropped.
    expect(out[1]!.to).not.toBe("#88cc44");
    expect(out[2]!.to).not.toBe("#eeff00");
  });

  it("leaves line art alone, so a black and white child takes no mask", () => {
    const dad = [c("#000000", 900), c("#ff2188", 200)];
    const child = [c("#000000", 1100), c("#ffffff", 980)];
    expect(pickTints(dad, child)).toEqual([]);
  });

  it("does nothing to a child of one colour, since that one is kept", () => {
    const dad = [c("#000000", 900), c("#87ff77", 600)];
    const child = [c("#000000", 800), c("#a31557", 300)];
    expect(pickTints(dad, child)).toEqual([]);
  });

  it("never paints one of the child's colours twice", () => {
    const dad = [c("#111111", 90), c("#222222", 80), c("#333333", 70)];
    const child = [c("#aaaaaa", 90), c("#bbbbbb", 80), c("#cccccc", 70), c("#dddddd", 60)];
    const out = pickTints(dad, child);
    expect(new Set(out.map((t) => t.from)).size).toBe(out.length);
  });

  it("marks an Obera's Wispen child without taking its body colour", () => {
    // Pixel counts measured off the shipped art, so the rule is pinned to a
    // pair that really happens rather than to numbers made up for a test.
    const obera = [c("#000000", 1359), c("#0e821b", 518), c("#53a367", 122), c("#eeff00", 18)];
    const wispen = [c("#000000", 1089), c("#8914ff", 347), c("#5800aa", 246), c("#ffffff", 10)];
    const out = pickTints(obera, wispen);
    expect(out.some((t) => t.from === "#8914ff")).toBe(false);
    expect(out).toContainEqual({ from: "#5800aa", to: "#0e821b" });
  });

  it("breaks ties on the colour itself, so two clients paint the same pixels", () => {
    const dad = [c("#ff0000", 100), c("#00ff00", 100)];
    const child = [c("#123456", 40), c("#abcdef", 40)];
    expect(pickTints(dad, child)).toEqual([{ from: "#abcdef", to: "#00ff00" }]);
  });
});
