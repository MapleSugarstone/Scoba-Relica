import { describe, expect, it } from "vitest";
import { MOVES, firstStep } from "../src/sim/species";
import { MOTIONS } from "../src/game/actors";
import { bounce } from "../src/engine/sprite";
import { startBattle, resolveTurn, previewMove, START_MANA } from "../src/sim/battle";
import { makeWild, type ScobaInstance } from "../src/sim/scoba";
import { rngFrom } from "../src/sim/rng";

const wild = (species: string, level: number, seed: string) => makeWild(species, level, rngFrom(seed));
const owned = (s: ScobaInstance, owner: "A" | "B"): ScobaInstance => ({ ...s, owner });

describe("move animations", () => {
  it("gives every move a caster animation before anything else happens", () => {
    for (const move of Object.values(MOVES)) {
      expect(move.cast[0]?.kind, move.id).toBe("motion");
    }
  });

  it("keeps what a move asks for", () => {
    expect(firstStep(MOVES["null-key"]!, "motion")?.anim).toBe("blink");
    expect(firstStep(MOVES["slam"]!, "motion")?.anim).toBe("rear");
    expect(firstStep(MOVES["riptide"]!, "throw")?.path).toBe("lob");
    expect(firstStep(MOVES["cherry-on-top"]!, "throw")?.from).toBe("cherry");
  });

  it("throws nothing for a move that has nothing to draw", () => {
    // Ember names no art, and flames with no art have nothing to show.
    expect(firstStep(MOVES["ember"]!, "throw")).toBeNull();
  });

  it("plays a cast in the order its steps are written", () => {
    const me = owned(wild("octoshake", 20, "o1"), "A");
    me.moves = ["cold-wave"];
    const st = startBattle("order", [me], [wild("obera", 20, "o2")], { slots: 1, owners: ["A", null] });
    st.teams[0][0]!.mana = 100;
    const events = resolveTurn(st, [{ kind: "spell", side: 0, slot: 0, moveId: "cold-wave", picks: [null] }]);
    const order = events
      .filter((e) => e.moveId === "cold-wave" || e.kind === "status")
      .map((e) => (e.kind === "show" ? e.visual!.kind : e.kind));
    expect(order.slice(0, 5)).toEqual(["spell", "motion", "throw", "hit", "status"]);
  });

  it("aims a throw at everyone its step reaches", () => {
    const me = owned(wild("octoshake", 20, "t1"), "A");
    me.moves = ["cold-wave"];
    const st = startBattle("aim", [me], [wild("obera", 20, "t2"), wild("plib", 20, "t3")], { slots: 2, owners: ["A", null] });
    st.teams[0][0]!.mana = 100;
    const events = resolveTurn(st, [
      { kind: "spell", side: 0, slot: 0, moveId: "cold-wave", picks: [null] },
    ]);
    const thrown = events.find((e) => e.kind === "show" && e.visual?.kind === "throw");
    expect(thrown?.to).toHaveLength(2);
    expect(thrown?.visual?.kind === "throw" && thrown.visual.sound).toBe("coldwave");
  });
});

describe("standing ready", () => {
  it("keeps a hovering Scoba floating whether or not it is walking", () => {
    const hover = MOTIONS.hover;
    // A gait that runs at rest ignores the walking blend entirely.
    const still = bounce(hover, 0.5, 0);
    const walking = bounce(hover, 0.5, 1);
    expect(still.hop).toBe(walking.hop);
    expect(still.hop).toBeGreaterThan(hover.float);
  });

  it("leaves a hopping Scoba flat at rest until a battle asks for a bounce", () => {
    const hop = MOTIONS.hop;
    expect(bounce(hop, 0.5, 0).hop).toBe(0);
    // The stage keeps some of the walk cycle going, which is the combat idle.
    const ready = bounce(hop, 0.5, 0.45);
    expect(ready.hop).toBeGreaterThan(0);
    expect(ready.hop).toBeLessThan(bounce(hop, 0.5, 1).hop);
  });
});

describe("events carry the values behind them", () => {
  it("reports HP after each hit, so a bar can slide instead of jumping", () => {
    const me = owned(wild("plib", 20, "h1"), "A");
    me.moves = ["crush"];
    const st = startBattle("bars", [me], [wild("obera", 20, "h2")], { slots: 1, owners: ["A", null] });
    const before = st.teams[1][0]!.hp;
    const events = resolveTurn(st, [{ kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] }]);
    const hit = events.find((e) => e.kind === "hit" && e.at?.side === 1);
    expect(hit?.hp).toBeDefined();
    expect(hit!.hp!).toBeLessThan(before);
    // The value on the event is what the combatant actually reached.
    expect(hit!.hp!).toBeGreaterThanOrEqual(0);
  });

  it("reports mana after a cast, so the bar drops with the animation", () => {
    // A move the line learns itself, so the bar drops by what the move says
    // rather than by that and the surcharge an unnatural move carries.
    const me = owned(wild("plib", 20, "m1"), "A");
    me.moves = ["punch"];
    const st = startBattle("mana", [me], [wild("obera", 20, "m2")], { slots: 1, owners: ["A", null] });
    const events = resolveTurn(st, [{
      kind: "spell", side: 0, slot: 0, moveId: "punch", picks: [{ side: 1, index: 0 }],
    }]);
    const cast = events.find((e) => e.kind === "spell");
    expect(cast?.mana).toBe(START_MANA - MOVES["punch"]!.manaCost);
  });

  it("puts the faint after the hit that caused it, and reports it at zero", () => {
    const me = owned(wild("plib", 40, "z1"), "A");
    me.moves = ["crush"];
    const st = startBattle("order", [me], [wild("obera", 2, "z2")], { slots: 1, owners: ["A", null] });
    st.teams[1][0]!.hp = 1;
    const events = resolveTurn(st, [{ kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] }]);
    const hitAt = events.findIndex((e) => e.kind === "hit");
    const faintAt = events.findIndex((e) => e.kind === "faint");
    expect(hitAt).toBeGreaterThanOrEqual(0);
    expect(faintAt).toBeGreaterThan(hitAt);
    expect(events[faintAt]!.hp).toBe(0);
  });
});

describe("events carry who did what", () => {
  it("names the caster, the target and the move behind each line", () => {
    const me = owned(wild("plib", 12, "n1"), "A");
    me.moves = ["cinder-spit"];
    const st = startBattle("anim", [me], [wild("obera", 12, "n2")], { slots: 1, owners: ["A", null] });
    st.teams[0][0]!.mana = 100;
    const events = resolveTurn(st, [{
      kind: "spell", side: 0, slot: 0, moveId: "cinder-spit", picks: [{ side: 1, index: 0 }],
    }]);
    const cast = events.find((e) => e.kind === "spell" && e.moveId === "cinder-spit");
    expect(cast?.at).toEqual({ side: 0, index: 0 });
    const hit = events.find((e) => e.kind === "hit");
    expect(hit?.at).toEqual({ side: 1, index: 0 });
    expect(hit?.by).toEqual({ side: 0, index: 0 });
    expect(hit?.moveId).toBe("cinder-spit");
  });

  it("names who a status landed on and who put it there", () => {
    const me = owned(wild("plib", 12, "s1"), "A");
    me.moves = ["ember"];
    const st = startBattle("anim2", [me], [wild("obera", 12, "s2")], { slots: 1, owners: ["A", null] });
    st.teams[0][0]!.mana = 100;
    const events = resolveTurn(st, [{
      kind: "spell", side: 0, slot: 0, moveId: "ember", picks: [{ side: 1, index: 0 }],
    }]);
    const mark = events.find((e) => e.kind === "status");
    expect(mark?.at).toEqual({ side: 1, index: 0 });
    expect(mark?.by).toEqual({ side: 0, index: 0 });
  });

  it("names the one that went down, so it can be animated out", () => {
    const me = owned(wild("plib", 40, "f1"), "A");
    me.moves = ["crush"];
    const foe = wild("obera", 2, "f2");
    const st = startBattle("anim3", [me], [foe], { slots: 1, owners: ["A", null] });
    st.teams[1][0]!.hp = 1;
    const events = resolveTurn(st, [{ kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] }]);
    const down = events.find((e) => e.kind === "faint");
    expect(down?.at).toEqual({ side: 1, index: 0 });
  });
});

describe("ability readout", () => {
  it("runs the real numbers a cast would, not just the raw scaling", () => {
    const me = owned(wild("plib", 20, "p1"), "A");
    me.moves = ["crush"];
    const st = startBattle("preview", [me], [wild("grima", 20, "p2")], { slots: 1, owners: ["A", null] });
    const view = previewMove(st, { side: 0, index: 0 }, "crush")!;
    expect(view.category).toBe("physical");
    expect(view.stat).toBe("str");
    expect(view.scale).toBe(MOVES["crush"]!.scale);
    // What it says it would deal is what a turn actually takes off.
    const before = st.teams[1][0]!.hp;
    resolveTurn(st, [{
      kind: "spell", side: 0, slot: 0, moveId: "crush", picks: [{ side: 1, index: 0 }],
    }]);
    expect(before - st.teams[1][0]!.hp).toBe(view.damage);
  });

  it("reads a magic move as magic and a heal as healing", () => {
    const me = owned(wild("plib", 20, "p3"), "A");
    me.moves = ["cinder-spit", "nuzzle-nap"];
    const st = startBattle("preview2", [me], [wild("obera", 20, "p4")], { slots: 1, owners: ["A", null] });
    const hit = previewMove(st, { side: 0, index: 0 }, "cinder-spit")!;
    expect(hit.category).toBe("magic");
    expect(hit.stat).toBe("mag");
    expect(hit.damage).toBeGreaterThan(0);
    const mend = previewMove(st, { side: 0, index: 0 }, "nuzzle-nap")!;
    expect(mend.damage).toBeNull();
    expect(mend.heal).toBeGreaterThan(0);
  });

  it("gives a utility move no damage line to colour", () => {
    const me = owned(wild("plib", 20, "p5"), "A");
    me.moves = ["fury"];
    const st = startBattle("preview3", [me], [wild("obera", 20, "p6")], { slots: 1, owners: ["A", null] });
    const view = previewMove(st, { side: 0, index: 0 }, "fury")!;
    expect(view.damage).toBeNull();
    expect(view.heal).toBeNull();
    expect(view.stat).toBeNull();
  });
});
