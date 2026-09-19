import { describe, expect, it } from "vitest";
import {
  combatantMaxHp, combatantStats, markNumbers, resolveTurn, startBattle, statusSummary,
  type BattleState, type Choice,
} from "../src/sim/battle";
import { sigilText } from "../src/ui/sigil";
import { STATUSES, newStatus } from "../src/sim/status";
import { typesEffectiveness } from "../src/sim/species";
import { makeWild, scobaTypes, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const wild = (id: string, lv = 30, seed = id): ScobaInstance => makeWild(id, lv, rngFrom(seed));
const block = (slot: number, side: 0 | 1 = 0): Choice => ({ kind: "block", side, slot });
const swing = (side: 0 | 1, slot: number, at: { side: 0 | 1; index: number }): Choice =>
  ({ kind: "attack", side, slot, picks: [at] as never });

/** The instance of one mark on the Scoba, past whatever passives it carries. */
const held = (st: BattleState, id: string) =>
  st.teams[0][0]!.statuses.find((inst) => inst.id === id)!;

/** A Scoba carrying one mark, put there by the one across from it. */
function marked(id: string): { st: BattleState; ref: { side: 0 | 1; index: number } } {
  const st = startBattle("sigil", [{ ...wild("plib"), owner: "A" }], [wild("grima", 30, "foe")]);
  for (const c of [...st.teams[0], ...st.teams[1]]) c.hp = combatantMaxHp(c);
  const put = newStatus(id, undefined, undefined, st.turn)!;
  put.from = { side: 1, index: 0 };
  // A mark that fixes its number measures it as it lands, which is what the
  // battle does for it; a fixture that skipped this left it reading live.
  const fixed = STATUSES[id]!.effects
    .find((e) => e.kind === "damage" && e.damage.snapshot === true);
  if (fixed && fixed.kind === "damage") {
    put.power = combatantStats(st.teams[1][0]!).mag * fixed.damage.frac;
  }
  st.teams[0][0]!.statuses.push(put);
  return { st, ref: { side: 0, index: 0 } };
}

describe("what a mark's damage meets", () => {
  it("takes the caster's element match and the chart, the way a move does", () => {
    const { st, ref } = marked("dead-coral");
    const [n] = markNumbers(st, ref, held(st, "dead-coral"));
    const caster = st.teams[1][0]!;
    const holder = st.teams[0][0]!;
    const want = scobaTypes(caster.scoba).includes("flux") ? 1.5 : 1;
    expect(n!.synergy).toBe(want);
    expect(n!.elemental).toBe(typesEffectiveness(["flux"], scobaTypes(holder.scoba)));
    // And the number is those multiples applied to the power in order.
    expect(n!.amount).toBe(Math.max(1, Math.floor(
      n!.raw * n!.synergy * n!.elemental * n!.armor!.mult,
    )));
  });

  it("is the number the tick takes off, multipliers and all", () => {
    const { st, ref } = marked("dead-coral");
    const [n] = markNumbers(st, ref, held(st, "dead-coral"));
    const before = st.teams[0][0]!.hp;
    resolveTurn(st, [swing(0, 0, { side: 1, index: 0 }), block(0, 1)]);
    expect(before - st.teams[0][0]!.hp).toBe(n!.amount);
  });
});

describe("what a mark's window says", () => {
  it("states the damage Dead Coral does rather than the share it is of something", () => {
    const { st, ref } = marked("dead-coral");
    const mark = statusSummary(st.teams[0][0]!).find((m) => m.id === "dead-coral")!;
    const said = sigilText(mark, markNumbers(st, ref, held(st, "dead-coral")));
    expect(said.desc).toMatch(/^Resistance -5%\./);
    expect(said.desc).toMatch(/At the end of each turn, takes \d+ Flux magic damage\./);
    // No share of anything left on the line: that is the working, not the effect.
    expect(said.desc).not.toContain("%%");
    expect(said.desc).not.toMatch(/70%/);
  });

  it("is the number the tick actually takes off", () => {
    const { st, ref } = marked("dead-coral");
    const [dealt] = markNumbers(st, ref, held(st, "dead-coral"));
    expect(dealt).toBeDefined();
    const before = st.teams[0][0]!.hp;
    // Not blocking: blocking halves what lands, and the number on the readout
    // is what the mark does rather than what a choice in the round does to it.
    resolveTurn(st, [swing(0, 0, { side: 1, index: 0 }), block(0, 1)]);
    expect(before - st.teams[0][0]!.hp).toBe(dealt!.amount);
  });

  it("shows the working behind the number, with the element it lands as", () => {
    const { st, ref } = marked("dead-coral");
    const numbers = markNumbers(st, ref, held(st, "dead-coral"));
    const coral = () => statusSummary(st.teams[0][0]!).find((m) => m.id === "dead-coral")!;
    const said = sigilText(coral(), numbers);
    const dealt = said.said.find((p) => p.dmg !== undefined)!;
    expect(dealt.text).toBe(String(numbers[0]!.amount));
    const working = dealt.work ?? [];
    expect(working.some((w) => w.element === "flux")).toBe(true);
    expect(working.some((w) => w.label.includes("Magic"))).toBe(true);
    // The stat is the one the number was taken off, so the share of it is the
    // number: the two rows agree even after the caster's own Magic has moved.
    const stat = working.find((w) => w.label.includes("Magic"))!;
    const share = working.find((w) => w.label.endsWith("%"))!;
    st.teams[1][0]!.scoba.genes = { ...st.teams[1][0]!.scoba.genes, mag: 1 };
    const later = sigilText(coral(), markNumbers(st, ref, held(st, "dead-coral")));
    const laterWork = later.said.find((p) => p.dmg !== undefined)!.work ?? [];
    expect(laterWork.find((w) => w.label.includes("Magic"))!.value).toBe(stat.value);
    expect(laterWork.find((w) => w.label.endsWith("%"))!.value).toBe(share.value);
    expect(working.at(-1)!.value).toBe(String(numbers[0]!.amount));
  });

  it("leaves a mark with no numbers reading as it always did", () => {
    const { st, ref } = marked("coral-shield");
    const mark = statusSummary(st.teams[0][0]!).find((m) => m.id === "coral-shield")!;
    const said = sigilText(mark, markNumbers(st, ref, held(st, "coral-shield")));
    expect(said.desc).not.toBe("");
    expect(said.said.every((p) => p.work === undefined)).toBe(true);
  });
});

describe("what a boost does to a mark's window", () => {
  /** Addiza carrying Swift beside a Poki, whose Multiply Allies makes Addiza's positive statuses 15% more effective. */
  function boosted(): BattleState {
    const a = { ...wild("addiza"), secondaryAbility: "swift" };
    return startBattle("boost", [a, wild("poki")], [wild("obera"), wild("obera", 30, "foe")], { slots: 2 });
  }

  it("states the boosted number, with what it was written as and each boost in its working", () => {
    const st = boosted();
    const mark = statusSummary(st.teams[0][0]!).find((m) => m.id === "swift")!;
    expect(mark.boosts).toEqual([{ name: "Multiply Allies", mult: 1.15 }]);
    const said = sigilText(mark);
    expect(said.desc).toBe("Speed +23%.");
    const number = said.said.find((p) => p.work)!;
    expect(number.text).toBe("23%");
    expect(number.work).toEqual([
      { label: "Base", value: "20%" },
      { label: "Multiply Allies", value: "1.15x", tone: "good" },
      { label: "Total", value: "23%" },
    ]);
  });
});

describe("a passive's values under Multiply Allies", () => {
  /** Addiza carrying `passive` beside a Poki, whose Multiply Allies reaches Addiza. */
  function beside(passive: string, partner = "poki"): BattleState {
    const a = { ...wild("addiza"), secondaryAbility: passive };
    return startBattle("values", [a, wild(partner)], [wild("obera"), wild("obera", 30, "foe")], { slots: 2 });
  }

  it("shows Sum's bonus at the holder's level, boosted, with its working", () => {
    const st = beside("sum");
    const mark = statusSummary(st.teams[0][0]!).find((m) => m.id === "sum")!;
    const said = sigilText(mark, [], 30);
    expect(said.desc).toBe("Makes every heal on an ally restore 34 more.");
    expect(said.said.find((p) => p.work)!.work).toEqual([
      { label: "Base", value: "30" },
      { label: "Multiply Allies", value: "1.15x", tone: "good" },
      { label: "Total", value: "34" },
    ]);
  });

  it("gives more mana from a passive, and says so", () => {
    const gained = (partner: string): number => {
      const st = beside("accelerated", partner);
      const a = st.teams[0][0]!;
      a.mana = 0;
      resolveTurn(st, [block(0), block(1), block(0, 1), block(1, 1)]);
      return a.mana;
    };
    // Accelerated's 10, made 12 by Poki's Multiply Allies.
    expect(gained("poki") - gained("obera")).toBe(2);
    const st = beside("accelerated");
    const mark = statusSummary(st.teams[0][0]!).find((m) => m.id === "accelerated")!;
    expect(sigilText(mark, [], 30).desc).toContain("gains 12% mana");
  });
});

describe("a status one mark lands", () => {
  it("is split out of the line with its own window, read at the carrier's level", () => {
    const mark = { id: "power-grid", name: "Power Grid", stacks: 1, turnsLeft: -1, chargesLeft: -1 };
    const said = sigilText(mark, [], 30);
    expect(said.desc).toBe("At the end of each turn, all ally Pawns gain Charged.");
    const named = said.said.find((p) => p.status)!;
    expect(named.text).toBe("Charged");
    expect(named.status).toEqual({ id: "charged", desc: "Increases all stats by 1 per stack, up to 30 stacks." });
  });
});
