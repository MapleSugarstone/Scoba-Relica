import { describe, expect, it } from "vitest";
import {
  combatantStats, combatantMaxHp, mitigation, resolveTurn, startBattle,
  type BattleState, type Choice,
} from "../src/sim/battle";
import { MOVES, SPECIES } from "../src/sim/species";
import { STATUSES, stacksOf } from "../src/sim/status";
import { makeWild, scobaTypes, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";
import { STAT_BUDGET, statTotal } from "../src/sim/types";

const wild = (id: string, lv = 30, seed = id): ScobaInstance => makeWild(id, lv, rngFrom(seed));
const mine = (s: ScobaInstance): ScobaInstance => ({ ...s, owner: "A" });

/** Corali against one enemy, with a full bar and nothing on cooldown. */
function reef(enemies = ["plib"], slots: 1 | 2 = 1): BattleState {
  const me = mine(wild("corali"));
  const st = startBattle("reef", [me, mine(wild("plib", 30, "ally"))], enemies.map((e, i) => wild(e, 30, `e${i}`)), { slots });
  st.teams[0][0]!.mana = 100;
  st.teams[0][0]!.cds = {};
  return st;
}

const cast = (moveId: string, picks: unknown[] = [{ side: 1, index: 0 }]): Choice =>
  ({ kind: "spell", side: 0, slot: 0, moveId, picks: picks as never });
const corals = (st: BattleState, side: 0 | 1, index: number): number =>
  stacksOf(st.teams[side][index]!.statuses, "coraled");

describe("the Corali line", () => {
  it("is a mage that spends nothing on Strength", () => {
    const sp = SPECIES["corali"]!;
    expect(statTotal(sp.genes)).toBe(STAT_BUDGET);
    expect(sp.genes.str).toBe(0);
    expect(sp.genes.mag).toBeGreaterThan(sp.genes.res);
    // Little of the budget on Speed, which is what the priority moves answer.
    expect(sp.genes.spd).toBeLessThanOrEqual(20);
  });

  it("is Moon and Flux and is drawn for Hyper-Mode", () => {
    const sp = SPECIES["corali"]!;
    expect(sp.type).toBe("moon");
    expect(sp.type2).toBe("flux");
    expect(sp.hyperAbility).toBe("coral-bloom");
    expect(sp.sprite.kind === "art" && sp.sprite.forms?.["hyper"]).toBe("hyper-corali");
  });
});

describe("Coral Growth", () => {
  it("grows a coral on an enemy it damages", () => {
    const st = reef();
    resolveTurn(st, [cast("coral-blast")]);
    expect(corals(st, 1, 0)).toBe(1);
  });

  it("hands over Coral Burst on top of the four moves", () => {
    const st = reef();
    expect(st.teams[0][0]!.scoba.moves).toHaveLength(4);
    expect(st.teams[0][0]!.scoba.moves).not.toContain("coral-burst");
    expect(MOVES["coral-burst"]!.priority).toBe(1);
  });

  it("keeps the corals through a switch, since they are against the Scoba", () => {
    expect(STATUSES["coraled"]!.persists).toBe(true);
    expect(STATUSES["coraled"]!.duration).toBeNull();
  });
});

describe("Coral Burst", () => {
  it("counts every coral on every enemy and spends them all", () => {
    const st = reef(["plib", "grima"], 2);
    const foes = [st.teams[1][0]!, st.teams[1][1]!];
    for (const c of foes) c.hp = combatantMaxHp(c) * 20;
    // Two casts, so one enemy is wearing two corals and the other one.
    resolveTurn(st, [cast("coral-blast"), { kind: "block", side: 0, slot: 1 }]);
    st.teams[0][0]!.mana = 100;
    resolveTurn(st, [cast("coral-blast"), { kind: "block", side: 0, slot: 1 }]);
    st.teams[0][0]!.mana = 100;
    resolveTurn(st, [cast("coral-blast", [{ side: 1, index: 1 }]), { kind: "block", side: 0, slot: 1 }]);
    expect(corals(st, 1, 0)).toBe(2);
    expect(corals(st, 1, 1)).toBe(1);

    const before = foes.map((c) => c.hp);
    st.teams[0][0]!.mana = 100;
    resolveTurn(st, [cast("coral-burst", [null]), { kind: "block", side: 0, slot: 1 }]);
    const took = foes.map((c, i) => before[i]! - c.hp);
    // Each enemy pays for its own count, so the one wearing two pays about twice.
    expect(took[0]! / took[1]!).toBeGreaterThan(1.7);
    expect(corals(st, 1, 0)).toBe(0);
    expect(corals(st, 1, 1)).toBe(0);
  });

  it("is not thrown at an enemy wearing none", () => {
    const st = reef();
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    resolveTurn(st, [cast("coral-burst", [null])]);
    expect(foe.hp).toBe(before);
  });
});

describe("Coral Shield", () => {
  it("takes half of one hit and is spent doing it", () => {
    // The same swing twice: once with a shield up, once with a spell cast instead.
    const swing = (shielded: boolean): number => {
      const fresh = reef();
      const c = fresh.teams[0][0]!;
      const was = c.hp;
      resolveTurn(fresh, [
        shielded ? cast("coral-shield", [{ side: 0, index: 0 }]) : cast("coral-blast"),
        { kind: "attack", side: 1, slot: 0, picks: [{ side: 0, index: 0 }] },
      ]);
      return was - c.hp;
    };
    const full = swing(false);
    const cut = swing(true);
    expect(cut).toBeLessThan(full);
    expect(Math.abs(cut - full / 2)).toBeLessThanOrEqual(1);
    const st = reef();
    const ally = st.teams[0][0]!;
    resolveTurn(st, [cast("coral-shield", [{ side: 0, index: 0 }]), { kind: "attack", side: 1, slot: 0, picks: [{ side: 0, index: 0 }] }]);
    expect(ally.statuses.some((s) => s.id === "coral-shield")).toBe(false);
  });
});

describe("Coral Feast", () => {
  it("pays 10 mana whenever anything faints", () => {
    // Two enemies, so the fight goes on after one of them falls and the turn pays out.
    const st = reef(["plib", "grima"], 2);
    const me = st.teams[0][0]!;
    expect(me.scoba.secondaryAbility).toBe("coral-feast");
    const foe = st.teams[1][0]!;
    foe.hp = 1;
    me.mana = MOVES["coral-blast"]!.manaCost;
    resolveTurn(st, [cast("coral-blast"), { kind: "block", side: 0, slot: 1 }]);
    expect(foe.fainted).toBe(true);
    // Nothing left after the cast, then 10 for the faint and the turn's own 20.
    expect(me.mana).toBe(30);
  });
});

describe("Coral Ritual", () => {
  it("raises a fallen Scoba as a Moon and Flux Pawn at three quarters of its level", () => {
    const st = reef(["plib", "grima"], 2);
    const body = st.teams[1][1]!;
    body.hp = 0;
    body.fainted = true;
    const was = body.scoba.level;
    st.teams[0][0]!.mana = 100;
    resolveTurn(st, [cast("coral-ritual", [{ side: 1, index: 1 }]), { kind: "block", side: 0, slot: 1 }]);
    const raised = st.teams[0].find((c) => c.pawn);
    expect(raised).toBeTruthy();
    expect(raised!.scoba.level).toBe(Math.round(was * 0.75));
    expect(scobaTypes(raised!.scoba)).toEqual(["moon", "flux"]);
    // It wears Corali's colours and answers to Corali's owner.
    expect(raised!.scoba.summoner?.speciesId).toBe("corali");
    // Painted in Corali's own colours rather than only wearing whatever marks it has.
    expect(raised!.scoba.summoner?.repaint).toBe(true);
    expect(raised!.scoba.owner).toBe("A");
    expect(raised!.statuses.some((s) => s.id === "decaying-coral")).toBe(true);
    // The body it came from stays down.
    expect(body.fainted).toBe(true);
  });

  it("hands the Pawn whatever elements the raiser itself has", () => {
    // A bred Corali carries its father's element, and what it raises carries it too.
    const st = reef(["plib", "grima"], 2);
    const me = st.teams[0][0]!;
    me.scoba.type2 = "sun";
    const body = st.teams[1][1]!;
    body.hp = 0;
    body.fainted = true;
    st.teams[0][0]!.mana = 100;
    resolveTurn(st, [cast("coral-ritual", [{ side: 1, index: 1 }]), { kind: "block", side: 0, slot: 1 }]);
    const raised = st.teams[0].find((c) => c.pawn)!;
    expect(scobaTypes(raised.scoba)).toEqual(scobaTypes(me.scoba));
    expect(scobaTypes(raised.scoba)).toEqual(["moon", "sun"]);
  });

  it("takes a tenth of the Pawn's pool at the end of each turn", () => {
    const st = reef(["plib", "grima"], 2);
    const body = st.teams[1][1]!;
    body.hp = 0;
    body.fainted = true;
    resolveTurn(st, [cast("coral-ritual", [{ side: 1, index: 1 }]), { kind: "block", side: 0, slot: 1 }]);
    const raised = st.teams[0].find((c) => c.pawn)!;
    const max = combatantMaxHp(raised);
    const before = raised.hp;
    // The Pawn swings rather than blocking, since blocking would halve its own decay.
    resolveTurn(st, [
      { kind: "block", side: 0, slot: 0 },
      { kind: "block", side: 0, slot: 1 },
      { kind: "attack", side: 0, slot: 2, picks: [{ side: 1, index: 0 }] },
    ]);
    expect(before - raised.hp).toBe(Math.max(1, Math.floor(max * 0.1)));
  });
});

describe("Coral Bloom", () => {
  it("grows a second coral on an enemy hit by an ability", () => {
    const st = reef();
    const me = st.teams[0][0]!;
    me.mana = 100;
    resolveTurn(st, [{ kind: "hyper", side: 0, slot: 0 }]);
    me.mana = 100;
    resolveTurn(st, [cast("coral-blast")]);
    expect(corals(st, 1, 0)).toBe(2);
  });
});

describe("Fragile, as both Coral Blast and Hairline leave it", () => {
  it("takes a tenth off both defences for two turns", () => {
    const st = reef();
    const foe = st.teams[1][0]!;
    const bare = combatantStats(foe);
    resolveTurn(st, [cast("coral-blast")]);
    const now = combatantStats(foe);
    expect(Math.abs(now.def - bare.def * 0.9)).toBeLessThanOrEqual(1);
    expect(Math.abs(now.res - bare.res * 0.9)).toBeLessThanOrEqual(1);
    expect(mitigation(now.def)).toBeGreaterThan(mitigation(bare.def));
  });
});
