import { describe, expect, it } from "vitest";
import {
  breed,
  canBreed,
  droppableFrom,
  childGenes,
  inheritGenes,
  hueTurn,
  inheritableFrom,
  makesHybrid,
  pairColors,
  pickTints,
} from "../src/sim/breeding";
import { costOf, makeWild, moveCost, scobaTypes, speciesName, unnaturalMoves, MAX_MANA, UNNATURAL_SURCHARGE } from "../src/sim/scoba";
import { BABY_BUDGET, statTotal } from "../src/sim/types";
import { rngFrom } from "../src/sim/rng";
import { MOVES, SPECIES, moveEffectiveness, sameLine } from "../src/sim/species";

describe("inheritGenes", () => {
  it("mixes 65% mom / 35% dad per stat, rounded", () => {
    const mom = { hp: 100, str: 50, def: 40, res: 60, mag: 45, spd: 10 };
    const dad = { hp: 50, str: 100, def: 40, res: 30, mag: 52, spd: 20 };
    expect(inheritGenes(mom, dad)).toEqual({ hp: 83, str: 68, def: 40, res: 50, mag: 47, spd: 14 });
  });
});

describe("evolutionary lines", () => {
  it("puts a baby and what it grows into on one line", () => {
    expect(sameLine(SPECIES.roulle!, SPECIES.allin!)).toBe(true);
    expect(sameLine(SPECIES.octoshake!, SPECIES.sqwoop!)).toBe(true);
    expect(sameLine(SPECIES.obera!, SPECIES.obera!)).toBe(true);
    expect(sameLine(SPECIES.obera!, SPECIES.plib!)).toBe(false);
    expect(sameLine(SPECIES.allin!, SPECIES.octoshake!)).toBe(false);
  });
});

describe("breeding within one line", () => {
  it("hatches a plain baby of the line, the same as a wild one", () => {
    const m = makeWild("octoshake", 20, rngFrom("om"));
    const d = makeWild("sqwoop", 20, rngFrom("od"));
    expect(makesHybrid(m, d)).toBe(false);
    const child = breed(m, d, rngFrom("oc"));
    expect(child.speciesId).toBe("sqwoop");
    expect(child.level).toBe(1);
    expect(child.hybrid).toBeUndefined();
    expect(child.sire).toBeUndefined();
    expect(child.type2).toBeUndefined();
    expect(child.genes).toEqual(SPECIES.sqwoop!.genes);
    const wild = makeWild("sqwoop", 1, rngFrom("oc"));
    expect(child.moves).toEqual(wild.moves);
    expect(child.secondaryAbility).toBe(wild.secondaryAbility);
  });

  it("hatches a baby that can breed again", () => {
    const child = breed(makeWild("obera", 20, rngFrom("a")), makeWild("obera", 20, rngFrom("b")), rngFrom("c"));
    expect(canBreed(child, makeWild("plib", 20, rngFrom("d")))).toBeNull();
  });

  it("hatches shiny when told to", () => {
    const m = makeWild("obera", 20, rngFrom("sm"));
    const d = makeWild("obera", 20, rngFrom("sd"));
    for (let i = 0; i < 10; i++) expect(breed(m, d, rngFrom(`s${i}`), undefined, { forceShiny: true }).shiny).toBe(true);
  });
});

describe("breeding a hybrid", () => {
  const mom = (): ReturnType<typeof makeWild> => makeWild("obera", 20, rngFrom("mom"));
  const dad = (): ReturnType<typeof makeWild> => makeWild("plib", 20, rngFrom("dad"));

  it("is the mother's first form at level 1, marked a hybrid", () => {
    const m = mom();
    const d = dad();
    expect(makesHybrid(m, d)).toBe(true);
    const child = breed(m, d, rngFrom("x"));
    // Obera has no baby form drawn, so its children are Oberas.
    expect(child.speciesId).toBe("obera");
    expect(child.level).toBe(1);
    expect(child.hybrid).toBe(true);
    expect(child.genes).toEqual(childGenes(m, d));
  });

  it("always takes the father's secondary passive and his colours", () => {
    const m = makeWild("obera", 20, rngFrom("fm"));
    const d = makeWild("plib", 20, rngFrom("fd"));
    d.secondaryAbility = "thick-coat";
    m.secondaryAbility = "moss-heart";
    for (let i = 0; i < 25; i++) {
      const child = breed({ ...m }, { ...d }, rngFrom(`f${i}`));
      expect(child.secondaryAbility).toBe("thick-coat");
      expect(child.sire).toBe("plib");
    }
  });

  it("cannot breed, as a mother or as a father", () => {
    const child = breed(mom(), dad(), rngFrom("h"));
    expect(canBreed(child, dad())).toMatch(/hybrid/);
    expect(canBreed(mom(), child)).toMatch(/hybrid/);
  });

  it("goes by a name blended from its mother's species and its father's", () => {
    const child = breed(makeWild("octoshake", 20, rngFrom("n1")), makeWild("plib", 20, rngFrom("n2")), rngFrom("n3"));
    expect(child.speciesId).toBe("sqwoop");
    expect(speciesName(child)).not.toBe("Sqwoop");
    expect(speciesName(child)).toMatch(/^Sq/);
    // A plain Scoba of the same species keeps its species' name.
    expect(speciesName(makeWild("sqwoop", 1, rngFrom("n4")))).toBe("Sqwoop");
  });

  it("hatches a line with a baby form as that baby", () => {
    const child = breed(makeWild("octoshake", 20, rngFrom("om")), makeWild("plib", 20, rngFrom("od")), rngFrom("oc"));
    expect(child.speciesId).toBe("sqwoop");
    // Both parents are read at the baby scale, so the child is built on the
    // baby budget rather than on either parent's own.
    expect(statTotal(child.genes)).toBeLessThanOrEqual(BABY_BUDGET + 6);
  });

  it("leaves the shine to the roll when not told to", () => {
    const m = mom();
    const d = dad();
    const lit = Array.from({ length: 300 }, (_, i) =>
      breed({ ...m }, { ...d }, rngFrom(`q${i}`)).shiny === true).filter(Boolean).length;
    expect(lit).toBeLessThan(20);
  });

  it("leaves an inherited move on the slot it replaced", () => {
    const m = makeWild("obera", 12, rngFrom("slot-mom"));
    const d = makeWild("plib", 12, rngFrom("slot-dad"));
    const child = breed(m, d, rngFrom("slot-child"));
    expect(child.moves).toHaveLength(m.moves.length);
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
    const child = breed(m, d, rngFrom("y"));
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
    const child = breed(m, d, rngFrom("swap"), { drop, take });
    expect(child.moves[1]).toBe(take);
    expect(child.moves.filter((mv) => mv === take)).toHaveLength(1);
    m.moves.forEach((mv, i) => {
      if (i !== 1) expect(child.moves[i]).toBe(mv);
    });
  });

  it("rolls the swap when the pair names something the parents cannot do", () => {
    const m = mom();
    const d = dad();
    const child = breed(m, d, rngFrom("bogus"), { drop: "not-a-move", take: "also-not" });
    const fromDad = child.moves.filter((mv) => !m.moves.includes(mv));
    expect(fromDad).toHaveLength(1);
    expect(d.moves).toContain(fromDad[0]);
  });

  it("charges the surcharge for a move the line does not learn", () => {
    const m = mom();
    const d = dad();
    const take = inheritableFrom(m, d)[0]!;
    const child = breed(m, d, rngFrom("cost"), { drop: m.moves[0]!, take });
    expect(moveCost(child, take)).toBe(MOVES[take]!.manaCost + UNNATURAL_SURCHARGE);
    for (const id of child.moves) {
      if (id === take) continue;
      expect(moveCost(child, id)).toBe(MOVES[id]!.manaCost);
    }
    expect(unnaturalMoves(child)).toEqual([take]);
  });

  it("never offers a move the child could not afford to cast", () => {
    const m = mom();
    const d = dad();
    for (const id of inheritableFrom(m, d)) {
      expect(costOf(m.speciesId, id)).toBeLessThanOrEqual(MAX_MANA);
    }
    const dear = { ...d, moves: ["nuzzle-nap"] };
    const priced = costOf(m.speciesId, "nuzzle-nap");
    expect(inheritableFrom(m, dear).length).toBe(priced <= MAX_MANA ? 1 : 0);
  });

  it("offers only the worked slot when the mother already works a move", () => {
    const m = mom();
    const d = dad();
    const worked = breed(m, d, rngFrom("gen1"), { drop: m.moves[0]!, take: inheritableFrom(m, d)[0]! });
    expect(unnaturalMoves(worked)).toHaveLength(1);
    expect(droppableFrom(worked)).toEqual(unnaturalMoves(worked));
  });

  it("pairs any two lines, but refuses special Scobas", () => {
    expect(canBreed(mom(), makeWild("flarea", 10, rngFrom("p")))).toBeNull();
    expect(canBreed(makeWild("relica", 10, rngFrom("s")), dad())).toMatch(/cannot breed/);
  });
});

describe("the element a hybrid takes from its father", () => {
  const pair = (momId: string, dadId: string) =>
    breed(makeWild(momId, 20, rngFrom(`tm${momId}`)), makeWild(dadId, 20, rngFrom(`td${dadId}`)), rngFrom("t"));

  it("is the element he leads with", () => {
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
  });

  it("is nothing when he leads with what the child already is", () => {
    // Aulium and Allin are both Fortuna, and they are different lines.
    const child = pair("aulium", "allin");
    expect(child.hybrid).toBe(true);
    expect(child.type2).toBeUndefined();
    expect(scobaTypes(child)).toEqual(["fortuna"]);
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

  it("paints the child's colours with his, commonest over commonest", () => {
    const dad = [c("#000000", 900), c("#1d19ff", 400), c("#1613c1", 90), c("#ffffff", 300)];
    const child = [c("#000000", 800), c("#0e821b", 500), c("#53a367", 120), c("#eeff00", 18)];
    const out = pickTints(dad, child);
    // Its main green takes his main blue, and the one under it takes his second.
    expect(out).toContainEqual({ from: "#0e821b", to: "#1d19ff" });
    expect(out).toContainEqual({ from: "#53a367", to: "#1613c1" });
    // Nothing of his left for the last, so it is turned to match the rest.
    expect(out.find((t) => t.from === "#eeff00")?.to).not.toBe("#eeff00");
  });

  it("turns what his palette does not reach rather than leaving it behind", () => {
    // One colour to give, three secondaries to cover.
    const dad = [c("#000000", 900), c("#1d19ff", 400)];
    const child = [
      c("#000000", 800), c("#0e821b", 500), c("#53a367", 120),
      c("#88cc44", 60), c("#eeff00", 18),
    ];
    const out = pickTints(dad, child);
    expect(out.map((t) => t.from)).toEqual(["#0e821b", "#53a367", "#88cc44", "#eeff00"]);
    expect(out[0]!.to).toBe("#1d19ff");
    // The three past his palette are turned rather than dropped.
    expect(out[1]!.to).not.toBe("#53a367");
    expect(out[2]!.to).not.toBe("#88cc44");
    expect(out[3]!.to).not.toBe("#eeff00");
  });

  it("turns what a grey father's palette does not reach grey, at its own lightness", () => {
    // Plib is two greys, which have no hue to turn toward.
    const plib = [c("#000000", 625), c("#dbdbdb", 552), c("#636363", 58)];
    const child = [
      c("#000000", 700), c("#fdedd4", 543), c("#f2aebd", 57), c("#b65832", 48), c("#d60300", 18),
    ];
    const out = pickTints(plib, child);
    expect(out).toContainEqual({ from: "#fdedd4", to: "#dbdbdb" });
    expect(out).toContainEqual({ from: "#f2aebd", to: "#636363" });
    // The two past his palette have no grey of his to take, so they go grey on their own.
    for (const from of ["#b65832", "#d60300"]) {
      const to = out.find((t) => t.from === from)?.to ?? "";
      expect(to.slice(1, 3)).toBe(to.slice(3, 5));
      expect(to.slice(3, 5)).toBe(to.slice(5, 7));
    }
  });

  it("turns nothing when the child's own main colour is the grey one", () => {
    const dad = [c("#1d19ff", 400)];
    const child = [c("#808080", 500), c("#53a367", 120), c("#eeff00", 18)];
    expect(pairColors([c("#eeff00", 18)], [], hueTurn("#808080", "#1d19ff"))).toEqual([]);
    expect(pickTints(dad, child)).toEqual([{ from: "#808080", to: "#1d19ff" }]);
  });

  it("leaves line art alone, so a black and white child takes no mask", () => {
    const dad = [c("#000000", 900), c("#ff2188", 200)];
    const child = [c("#000000", 1100), c("#ffffff", 980)];
    expect(pickTints(dad, child)).toEqual([]);
  });

  it("paints a child of one colour, since that colour is the whole of it", () => {
    const dad = [c("#000000", 900), c("#87ff77", 600)];
    const child = [c("#000000", 800), c("#a31557", 300)];
    expect(pickTints(dad, child)).toEqual([{ from: "#a31557", to: "#87ff77" }]);
  });

  it("never paints one of the child's colours twice", () => {
    const dad = [c("#111111", 90), c("#222222", 80), c("#333333", 70)];
    const child = [c("#aaaaaa", 90), c("#bbbbbb", 80), c("#cccccc", 70), c("#dddddd", 60)];
    const out = pickTints(dad, child);
    expect(new Set(out.map((t) => t.from)).size).toBe(out.length);
  });

  it("marks an Obera's Wispen child, body colour and all", () => {
    // Pixel counts measured off the shipped art, so the rule is pinned to a
    // pair that really happens rather than to numbers made up for a test.
    const obera = [c("#000000", 1359), c("#0e821b", 518), c("#53a367", 122), c("#eeff00", 18)];
    const wispen = [c("#000000", 1089), c("#8914ff", 347), c("#5800aa", 246), c("#ffffff", 10)];
    const out = pickTints(obera, wispen);
    expect(out).toContainEqual({ from: "#8914ff", to: "#0e821b" });
    expect(out).toContainEqual({ from: "#5800aa", to: "#53a367" });
  });

  it("breaks ties on the colour itself, so two clients paint the same pixels", () => {
    const dad = [c("#ff0000", 100), c("#00ff00", 100)];
    const child = [c("#123456", 40), c("#abcdef", 40)];
    // Both sides tie on count, so both are ordered by their own hex.
    expect(pickTints(dad, child)).toEqual([
      { from: "#123456", to: "#00ff00" },
      { from: "#abcdef", to: "#ff0000" },
    ]);
  });
});
