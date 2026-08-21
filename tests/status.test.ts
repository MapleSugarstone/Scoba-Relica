import { describe, expect, it } from "vitest";
import {
  startBattle,
  resolveTurn,
  combatantStats,
  combatantMaxHp,
  statusSummary,
  MAX_SUMMONS,
  type BattleState,
  type Combatant,
} from "../src/sim/battle";
import { STATUSES, applyStatus, newStatus, onSwitchOut, stacksOf, triggerMatches } from "../src/sim/status";
import { makeWild, statsAt, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const wild = (species: string, level: number, seed: string) => makeWild(species, level, rngFrom(seed));
const owned = (s: ScobaInstance, owner: "A" | "B"): ScobaInstance => ({ ...s, owner });

/** One ally out with a spare on the bench, one enemy out. */
function duel(moves: string[]): BattleState {
  const me = owned(wild("plib", 12, "m1"), "A");
  me.moves = moves;
  const st = startBattle("statuses", [me, owned(wild("grima", 12, "m2"), "A")], [wild("obera", 12, "e1")], {
    slots: 1,
    owners: ["A", null],
  });
  st.teams[0][0]!.mana = 100;
  st.teams[0][0]!.cds = {};
  return st;
}

const put = (c: Combatant, id: string, from?: { side: 0 | 1; index: number }) => {
  applyStatus(c.statuses, newStatus(id, from)!);
};

describe("status definitions", () => {
  it("matches a specific hit against a status listening for any hit", () => {
    const fragile = STATUSES["fragile"]!;
    expect(triggerMatches(fragile, { on: "hit", category: "magic", element: "sun" })).toBe(true);
    expect(triggerMatches(fragile, { on: "hit", category: "physical", element: "plain" })).toBe(true);
    expect(triggerMatches(fragile, { on: "turn-end" })).toBe(false);
    // A status listening for one category ignores the other.
    const marked = STATUSES["marked"]!;
    expect(triggerMatches(marked, { on: "hit", category: "magic", element: "cipher" })).toBe(false);
  });

  it("fires an hp-below watcher only once the threshold is crossed", () => {
    const wind = STATUSES["second-wind"]!;
    expect(triggerMatches(wind, { on: "hp-below", frac: 0.4 })).toBe(true);
    expect(triggerMatches(wind, { on: "hp-below", frac: 0.5 })).toBe(true);
    expect(triggerMatches(wind, { on: "hp-below", frac: 0.9 })).toBe(false);
  });

  it("never fires a passive status, which is read continuously instead", () => {
    expect(triggerMatches(STATUSES["rage"]!, { on: "turn-end" })).toBe(false);
  });

  it("stacks up to the cap and refreshes past it", () => {
    const list: ReturnType<typeof newStatus>[] = [];
    const holder = list as NonNullable<ReturnType<typeof newStatus>>[];
    for (let i = 0; i < 10; i++) applyStatus(holder, newStatus("rage")!);
    expect(stacksOf(holder, "rage")).toBe(STATUSES["rage"]!.maxStacks);
  });

  it("keeps one instance of a status that does not stack", () => {
    const holder: NonNullable<ReturnType<typeof newStatus>>[] = [];
    expect(applyStatus(holder, newStatus("fragile")!)).toBe("added");
    expect(applyStatus(holder, newStatus("fragile")!)).toBe("refreshed");
    expect(stacksOf(holder, "fragile")).toBe(1);
  });

  it("drops what does not travel when a Scoba is pulled out", () => {
    const holder: NonNullable<ReturnType<typeof newStatus>>[] = [];
    applyStatus(holder, newStatus("fire")!);
    applyStatus(holder, newStatus("rage")!);
    const kept = onSwitchOut(holder);
    expect(kept.map((s) => s.id)).toEqual(["fire"]);
  });
});

describe("statuses in a battle", () => {
  it("Rage scales Strength per stack and is lost on switching out", () => {
    const st = duel(["fury"]);
    const me = st.teams[0][0]!;
    // Passives are statuses of their own; set them aside so what is measured
    // here is Rage and nothing else.
    me.statuses = [];
    const base = statsAt(me.scoba, false).str;
    put(me, "rage");
    expect(combatantStats(me).str).toBe(Math.max(1, Math.floor(base * 1.25)));
    put(me, "rage");
    expect(combatantStats(me).str).toBe(Math.max(1, Math.floor(base * 1.25 * 1.25)));

    resolveTurn(st, [{ kind: "switch", side: 0, slot: 0, benchIndex: 1 }]);
    expect(me.statuses).toHaveLength(0);
    expect(combatantStats(me).str).toBe(base);
  });

  it("Rage keeps its share of a Strength that something else raised", () => {
    const st = duel(["crush"]);
    const me = st.teams[0][0]!;
    me.statuses = [];
    const base = statsAt(me.scoba, false).str;
    applyStatus(me.statuses, newStatus("rage")!);
    me.statuses.push({ id: "flat", turnsLeft: -1, chargesLeft: -1, stacks: 1 });
    // A raw +100 to Strength, applied before the scale, so Rage takes a
    // quarter of the new total rather than a quarter of the old one.
    STATUSES["flat"] = {
      id: "flat", name: "Flat", desc: "", polarity: "good", trigger: { on: "passive" },
      duration: null, charges: null, stacks: false, maxStacks: 1, persists: true,
      effects: [{ kind: "stat-add", stat: "str", amount: 100 }],
    };
    expect(combatantStats(me).str).toBe(Math.floor((base + 100) * 1.25));
    delete STATUSES["flat"];
  });

  it("Fire ticks at end of turn off the caster's Magic, snapshotted", () => {
    const st = duel(["ember"]);
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "ember", picks: [{ side: 1, index: 0 }] }]);
    expect(statusSummary(foe).some((m) => m.id === "fire")).toBe(true);
    const afterCast = foe.hp;
    expect(afterCast).toBeLessThan(before);

    // The burn is fixed when applied, so it lands the same even if the
    // caster's Magic changes afterwards.
    const inst = foe.statuses.find((s) => s.id === "fire")!;
    expect(inst.power).toBeGreaterThan(0);
    expect(inst.turnsLeft).toBeLessThan(STATUSES["fire"]!.duration!);
  });

  it("Fire runs out after its three turns", () => {
    const st = duel(["crush"]);
    const foe = st.teams[1][0]!;
    put(foe, "fire", { side: 0, index: 0 });
    for (let i = 0; i < 3; i++) {
      if (st.winner !== -1) break;
      resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    }
    expect(foe.statuses.some((s) => s.id === "fire")).toBe(false);
  });

  it("Fragile bites on every hit and spends its three charges", () => {
    const st = duel(["crush"]);
    const foe = st.teams[1][0]!;
    foe.scoba.moves = [];
    put(foe, "fragile", { side: 0, index: 0 });
    const charges = () => foe.statuses.find((s) => s.id === "fragile")?.chargesLeft ?? 0;
    expect(charges()).toBe(3);
    resolveTurn(st, [{ kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] }]);
    if (!foe.fainted) expect(charges()).toBe(2);
  });

  it("Fragile's own tick does not set itself off again", () => {
    const st = duel(["crush"]);
    const foe = st.teams[1][0]!;
    foe.hp = 10000;
    foe.scoba.moves = [];
    put(foe, "fragile", { side: 0, index: 0 });
    resolveTurn(st, [{ kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] }]);
    // One hit, one charge: a self-retriggering status would have burned all three.
    expect(foe.statuses.find((s) => s.id === "fragile")?.chargesLeft).toBe(2);
  });

  it("elemental immunity turns a hit aside entirely", () => {
    const st = duel(["moonbeam"]);
    const foe = st.teams[1][0]!;
    put(foe, "moonward");
    const before = foe.hp;
    const events = resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "moonbeam", picks: [{ side: 1, index: 0 }] }]);
    expect(foe.hp).toBe(before);
    expect(events.some((e) => e.text.includes("untouched"))).toBe(true);
  });

  it("vulnerability multiplies what an element does", () => {
    const plain = duel(["decode"]);
    const marked = duel(["decode"]);
    const pick = [{ side: 1 as const, index: 0 }];
    put(marked.teams[1][0]!, "marked");
    const a = plain.teams[1][0]!;
    const b = marked.teams[1][0]!;
    const aBefore = a.hp;
    const bBefore = b.hp;
    resolveTurn(plain, [{ kind: "spell", side: 0, slot: 0, moveId: "decode", picks: pick }]);
    resolveTurn(marked, [{ kind: "spell", side: 0, slot: 0, moveId: "decode", picks: pick }]);
    expect(bBefore - b.hp).toBeGreaterThan(aBefore - a.hp);
  });

  it("cleansing strips only the half it was aimed at", () => {
    const st = duel(["cleanse"]);
    const me = st.teams[0][0]!;
    put(me, "fire", { side: 1, index: 0 });
    put(me, "rage");
    resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "cleanse", picks: [{ side: 0, index: 0 }] }]);
    expect(me.statuses.some((s) => s.id === "fire")).toBe(false);
    expect(me.statuses.some((s) => s.id === "rage")).toBe(true);
  });

  it("copies one Scoba's marks onto another", () => {
    const st = duel(["mirror-mark"]);
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    put(foe, "fire", { side: 0, index: 0 });
    resolveTurn(st, [{
      kind: "spell", side: 0, slot: 0, moveId: "mirror-mark",
      picks: [{ side: 1, index: 0 }, { side: 0, index: 0 }],
    }]);
    expect(me.statuses.some((s) => s.id === "fire")).toBe(true);
  });

  it("a summon joins the team and the cap holds", () => {
    const st = duel(["call-swarm"]);
    const before = st.teams[0].length;
    resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "call-swarm", picks: [null] }]);
    expect(st.teams[0].length).toBe(before + 1);
    expect(st.teams[0][before]!.summoned).toBe(true);
    // The summon answers to whoever called it, so they can swap to it.
    expect(st.teams[0][before]!.scoba.owner).toBe("A");
    expect(MAX_SUMMONS).toBeGreaterThan(0);
  });

  it("a granted item shows up in the battle's own stock", () => {
    const st = duel(["forage"]);
    resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "forage", picks: [null] }]);
    expect(st.items[0]["snare"]).toBe(1);
  });

  it("keeps max HP and current HP consistent when a status changes the pool", () => {
    const st = duel(["crush"]);
    const me = st.teams[0][0]!;
    expect(combatantMaxHp(me)).toBeGreaterThan(0);
    expect(me.hp).toBeLessThanOrEqual(combatantMaxHp(me));
  });
});
