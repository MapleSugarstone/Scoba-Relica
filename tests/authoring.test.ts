// Records written in move script for these tests alone, installed into the
// tables, run in seeded battles, and written back out to check the language
// reads what it writes.
import { afterEach, describe, expect, it } from "vitest";
import { readScript, type RecordKind } from "../src/sim/script/read";
import { writeField, writeMove, writePassive, writeStatus } from "../src/sim/script/write";
import { readContent } from "../src/sim/script/content";
import {
  combatantMaxHp, combatantStats, mitigation, previewMove, resolveTurn, startBattle,
  type BattleState, type Choice,
} from "../src/sim/battle";
import { ABILITIES, MOVES, typesEffectiveness } from "../src/sim/species";
import { FIELDS, STATUSES, stacksOf } from "../src/sim/status";
import { makeWild, scobaTypes, statsAt, type ScobaInstance } from "../src/sim/scoba";
import { forgetDerived } from "../src/sim/rewrite";
import { rngFrom } from "../src/sim/rng";

const clean = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

const added = {
  moves: [] as string[],
  statuses: [] as string[],
  abilities: [] as string[],
  fields: [] as string[],
};

/**
 * Reads one record, holds it to writing back as the same record, and puts it in
 * the table the game looks it up in.
 */
function install(text: string, kind: RecordKind): void {
  const read = readScript(text, kind);
  expect(read.problems, text).toEqual([]);
  if (kind === "move") {
    const m = read.moves[0]!;
    const back = readScript(writeMove(m), "move");
    expect(back.problems, m.id).toEqual([]);
    expect(clean(back.moves[0]), m.id).toEqual(clean(m));
  } else if (kind === "status") {
    const s = read.statuses[0]!;
    const back = readScript(writeStatus(s), "status");
    expect(back.problems, s.id).toEqual([]);
    expect(clean(back.statuses[0]), s.id).toEqual(clean(s));
  } else if (kind === "passive") {
    const a = read.abilities[0]!;
    const own = read.statuses[0] ?? null;
    const back = readScript(writePassive(a, own), "passive");
    expect(back.problems, a.id).toEqual([]);
    expect(clean(back.abilities[0]), a.id).toEqual(clean(a));
    expect(clean(back.statuses[0] ?? null), a.id).toEqual(clean(own));
  } else {
    const f = read.fields[0]!;
    const back = readScript(writeField(f), "field");
    expect(back.problems, f.id).toEqual([]);
    expect(clean(back.fields[0]), f.id).toEqual(clean(f));
  }
  for (const m of read.moves) {
    MOVES[m.id] = m;
    added.moves.push(m.id);
  }
  for (const s of read.statuses) {
    STATUSES[s.id] = s;
    added.statuses.push(s.id);
  }
  for (const a of read.abilities) {
    ABILITIES[a.id] = a;
    added.abilities.push(a.id);
  }
  for (const f of read.fields) {
    FIELDS[f.id] = f;
    added.fields.push(f.id);
  }
}

afterEach(() => {
  for (const id of added.moves) delete MOVES[id];
  for (const id of added.statuses) delete STATUSES[id];
  for (const id of added.abilities) delete ABILITIES[id];
  for (const id of added.fields) delete FIELDS[id];
  added.moves = [];
  added.statuses = [];
  added.abilities = [];
  added.fields = [];
  // The rewrites a picked move filed are named after records that are gone now.
  forgetDerived();
});

// --- the records these tests are about ---

const CHILL = [
  "status probe-chill \"Probe Chill\"",
  "  bad",
  "  icon cold",
  "  lasts 3 turns",
  "  stacks up to 3",
  "  lost on switching out",
  "  power 50% of source magic",
  "  while carried:",
  "    speed - power",
].join("\n");

const GUARD = [
  "status probe-guard \"Probe Guard\"",
  "  good",
  "  lasts 2 turns",
  "  while carried:",
  "    defense x1.25",
].join("\n");

const WIND = [
  "status probe-wind \"Probe Wind\"",
  "  good",
  "  charges 2",
  "  when below 60% hp:",
  "    heal holder 25% of their max hp",
].join("\n");

const VIGIL = [
  "status probe-vigil \"Probe Vigil\"",
  "  good",
  "  lasts 2 turns",
  "  while carried:",
  "    defense x1.5",
  "  when a turn ends:",
  "    heal holder 10% of their max hp",
].join("\n");

const VIGIL_CALL = [
  "move probe-vigil-call \"Probe Vigil Call\"",
  "  type spring",
  "  costs 10 mana",
  "  aim any ally \"Steady\"",
  "  cast:",
  "    inflict probe-vigil on target",
].join("\n");

const EMBER = [
  "status probe-ember \"Probe Ember\"",
  "  bad",
  "  icon firework",
  "  lasts 3 turns",
  "  when a turn ends:",
  "    damage holder 5% of their max hp, as firework magic",
  "    damage holder 20% of source magic, as firework magic, fixed when applied",
].join("\n");

const EMBER_CALL = [
  "move probe-ember-call \"Probe Ember Call\"",
  "  type firework",
  "  costs 10 mana",
  "  aim any enemy",
  "  cast:",
  "    inflict probe-ember on target",
].join("\n");

const GORE = [
  "passive probe-gore \"Probe Gore\"",
  "  text \"Wears whatever it swings at down.\"",
  "  when it makes a basic attack:",
  "    inflict probe-chill on other",
].join("\n");

const BULK = [
  "passive probe-bulk \"Probe Bulk\"",
  "  text \"Bigger all over, and stronger with it.\"",
  "  while carried:",
  "    all stats +4",
  "    strength x1.5",
].join("\n");

const GLOOM = [
  "field probe-gloom \"Probe Gloom\"",
  "  icon moon",
  "  lasts 2 turns",
  "  tint #2b2f5e",
  "  begins \"A gloom settles over the field.\"",
  "  ends \"The gloom lifts.\"",
  "  while standing:",
  "    moon moves x1.5",
  "    takes x1.5 from moon",
  "    immune to spring",
].join("\n");

const TITHE = [
  "move probe-tithe \"Probe Tithe\"",
  "  type spring",
  "  costs 20 mana",
  "  aim any ally \"Draw from\" as donor",
  "  aim any ally \"Give it to\" as mender",
  "  cast:",
  "    caster focus",
  "    take 20% hp from donor, heal mender with it",
].join("\n");

const FINISHER = [
  "move probe-finisher \"Probe Finisher\"",
  "  type sugar",
  "  costs 20 mana",
  "  cooldown 3",
  "  aim any enemy",
  "  cast:",
  "    caster rear",
  "    throw \"tantalizing sweet\" as drop to target, sound tantalizingsweet",
  "    hit target 100% magic + 50% strength, as moon magic",
  "    inflict probe-chill on target",
  "    if target fell:",
  "      say \"{self} finishes {target}.\"",
  "      refund",
].join("\n");

const ORDEAL = [
  "move probe-ordeal \"Probe Ordeal\"",
  "  type mystic",
  "  costs 10 mana",
  "  aim self \"Steel yourself\"",
  "  cast:",
  "    caster focus",
  "    damage caster 30% of their max hp, as true",
].join("\n");

const BLESS = [
  "move probe-bless \"Probe Bless\"",
  "  type moon",
  "  costs 10 mana",
  "  aim any ally \"Bless\"",
  "  cast:",
  "    inflict probe-wind on target",
  "    inflict probe-guard on target",
  "    heal target 10% of caster magic, sound heal",
].join("\n");

const GLOOM_CALL = [
  "move probe-gloom-call \"Probe Gloom Call\"",
  "  type moon",
  "  costs 15 mana",
  "  aim self \"Call the gloom\"",
  "  cast:",
  "    caster focus",
  "    lay probe-gloom over both sides",
].join("\n");

const MOONLIGHT = [
  "move probe-moonlight \"Probe Moonlight\"",
  "  type moon",
  "  costs 15 mana",
  "  aim any enemy",
  "  cast:",
  "    say \"{self} draws a line through {target}.\"",
  "    hit target 100% magic",
].join("\n");

const THORN = [
  "move probe-thorn \"Probe Thorn\"",
  "  type spring",
  "  costs 15 mana",
  "  aim any enemy",
  "  cast:",
  "    hit target 100% magic",
].join("\n");

const RALLY = [
  "move probe-rally \"Probe Rally\"",
  "  type fortuna",
  "  costs 10 mana",
  "  aim all allies \"Everyone\"",
  "  cast:",
  "    summon catsquito at level 5",
  "    give target 30 mana",
  "    say \"{self} calls the swarm.\"",
].join("\n");

const MIRROR = [
  "move probe-mirror \"Probe Mirror\"",
  "  type mystic",
  "  costs 10 mana",
  "  aim any scoba \"Copy from\" as mark",
  "  aim any ally \"Copy onto\" as taker",
  "  cast:",
  "    copy marks from mark to taker",
  "    cleanse bad marks from mark",
].join("\n");

const WHEEL = [
  "move probe-wheel \"Probe Wheel\"",
  "  type fortuna",
  "  costs 20 mana",
  "  aim any enemy",
  "  cast:",
  "    # The wheel hands a spell over, then swings for a flat number.",
  "    show spin as wheel over caster, pointer spintop",
  "    pick a random move",
  "      costing at least 40",
  "      skip once per battle",
  "    change picked move:",
  "      set type fortuna",
  "      set damage physical",
  "      scale off strength",
  "      tint #e8c46a",
  "    give caster picked move in slot 4",
  "    hit target 2 per level",
].join("\n");

// --- battles to run them in ---

const wild = (species: string, level: number, seed: string): ScobaInstance =>
  makeWild(species, level, rngFrom(seed));

const mine = (species: string, seed: string, moves: string[], passive?: string): ScobaInstance => ({
  ...wild(species, 20, seed),
  owner: "A" as const,
  moves,
  ...(passive ? { secondaryAbility: passive } : {}),
});

/** A battle, with everyone at full and nothing carried but what a test asks for. */
function duel(team: ScobaInstance[], foes: ScobaInstance[], slots: 1 | 2 = 1): BattleState {
  const st = startBattle("authoring", team, foes, {
    slots,
    owners: slots === 2 ? ["A", "A"] : ["A", null],
  });
  return st;
}

/** Takes every passive off, so a test measures what it wrote and nothing else. */
function stripPassives(st: BattleState, keep: string[] = []): void {
  for (const side of [0, 1] as const) {
    for (const c of st.teams[side]) {
      c.statuses = c.statuses.filter((s) => keep.includes(s.id));
      c.hp = combatantMaxHp(c);
      c.mana = 100;
      c.cds = {};
    }
  }
  st.fields = [null, null];
}

const spell = (moveId: string, picks: ({ side: 0 | 1; index: number } | null)[], slot = 0): Choice =>
  ({ kind: "spell", side: 0, slot, moveId, picks });

describe("a move with two named aim groups", () => {
  it("draws HP out of one group and puts it into the other", () => {
    install(TITHE, "move");
    const st = duel(
      [mine("plib", "t1", ["probe-tithe"]), mine("pieble", "t2", ["crush"])],
      [wild("grima", 20, "t3")],
      2,
    );
    stripPassives(st);
    const me = st.teams[0][0]!;
    const ally = st.teams[0][1]!;
    me.hp = 20;
    const allyFull = ally.hp;
    const taken = Math.max(1, Math.floor(allyFull * 0.2));
    resolveTurn(st, [spell("probe-tithe", [{ side: 0, index: 1 }, { side: 0, index: 0 }])]);
    expect(ally.hp).toBe(allyFull - taken);
    expect(me.hp).toBe(20 + taken);
  });

  it("keeps the groups apart, so the second name is the second pick", () => {
    install(TITHE, "move");
    const move = MOVES["probe-tithe"]!;
    expect(move.targets.map((t) => t.prompt)).toEqual(["Draw from", "Give it to"]);
    const step = move.cast[1]!;
    expect(step.kind === "transfer" && step.from).toEqual({ aim: 0 });
    expect(step.kind === "transfer" && step.to).toEqual({ aim: 1 });
  });

  it("refuses a name that already means something", () => {
    const read = readScript([
      "move probe-clash \"Clash\"",
      "  type firework",
      "  costs 10 mana",
      "  aim any enemy as target2",
      "  aim any ally",
      "  cast:",
      "    caster lunge",
    ].join("\n"), "move");
    expect(read.problems[0]?.says).toContain("\"target2\" already means something here");
  });
});

describe("a move that hits, marks, and takes its cost back on a kill", () => {
  it("reads both stats and the element the hit names", () => {
    install(CHILL, "status");
    install(FINISHER, "move");
    const st = duel([mine("plib", "f1", ["probe-finisher"])], [wild("grima", 20, "f2"), wild("grima", 20, "f3")]);
    stripPassives(st);
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    const u = combatantStats(me);
    const t = combatantStats(foe);
    let raw = u.mag + u.str * 0.5;
    if (scobaTypes(me.scoba).includes("moon")) raw *= 1.5;
    raw *= typesEffectiveness(["moon"], scobaTypes(foe.scoba));
    raw *= mitigation(t.res);
    const full = foe.hp;
    const events = resolveTurn(st, [spell("probe-finisher", [{ side: 1, index: 0 }])]);
    const hit = events.find((e) => e.kind === "hit")!;
    expect(full - hit.hp!).toBe(Math.max(1, Math.floor(raw)));
    expect(foe.statuses.some((s) => s.id === "probe-chill")).toBe(true);
    // Nothing fell, so the cast keeps its cost and its cooldown.
    expect(me.cds["probe-finisher"]).toBe(3);
  });

  it("says its line and hands the mana back when the target falls", () => {
    install(CHILL, "status");
    install(FINISHER, "move");
    const st = duel([mine("plib", "f4", ["probe-finisher"])], [wild("grima", 20, "f5"), wild("grima", 20, "f6")]);
    stripPassives(st);
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    me.mana = 60;
    foe.hp = 1;
    const events = resolveTurn(st, [spell("probe-finisher", [{ side: 1, index: 0 }])]);
    expect(foe.fainted).toBe(true);
    expect(events.some((e) => e.text === "Plib finishes Grima.")).toBe(true);
    // 30 paid with the surcharge, 30 back, and the turn's 20 on top.
    expect(me.mana).toBe(80);
    expect(me.cds["probe-finisher"]).toBeUndefined();
  });
});

describe("a status with a power measured off the source", () => {
  it("drains the stat by a share of the caster's Magic, not the holder's", () => {
    install(CHILL, "status");
    install(FINISHER, "move");
    const st = duel([mine("plib", "c1", ["probe-finisher"])], [wild("grima", 20, "c2"), wild("grima", 20, "c3")]);
    stripPassives(st);
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    foe.hp = combatantMaxHp(foe) * 10;
    const casterMag = combatantStats(me).mag;
    const holderMag = combatantStats(foe).mag;
    expect(casterMag).not.toBe(holderMag);
    const bareSpeed = combatantStats(foe).spd;
    // A mark that lowers a stat off Magic meets the holder's Resistance, the same as a magical hit.
    const reduced = casterMag * 0.5 * mitigation(combatantStats(foe).res);
    resolveTurn(st, [spell("probe-finisher", [{ side: 1, index: 0 }])]);
    const inst = foe.statuses.find((s) => s.id === "probe-chill")!;
    expect(inst.power).toBe(reduced);
    expect(combatantStats(foe).spd).toBe(Math.floor(bareSpeed - reduced));
  });

  it("stacks to its cap, and stops there", () => {
    install(CHILL, "status");
    install(FINISHER, "move");
    const st = duel([mine("plib", "c4", ["probe-finisher"])], [wild("grima", 20, "c5"), wild("grima", 20, "c6")]);
    stripPassives(st);
    const foe = st.teams[1][0]!;
    const again = (): void => {
      foe.hp = combatantMaxHp(foe);
      st.teams[0][0]!.mana = 100;
      st.teams[0][0]!.cds = {};
      resolveTurn(st, [spell("probe-finisher", [{ side: 1, index: 0 }])]);
    };
    for (let i = 0; i < 3 && st.winner === -1; i++) again();
    expect(stacksOf(foe.statuses, "probe-chill")).toBe(3);
    // At the cap, landing it again tops a stack up rather than adding a fourth.
    for (let i = 0; i < 2 && st.winner === -1; i++) again();
    expect(stacksOf(foe.statuses, "probe-chill")).toBeLessThanOrEqual(3);
  });

  it("comes off when its holder is called back, and runs out on its own clock", () => {
    install(CHILL, "status");
    install(FINISHER, "move");
    const st = duel(
      [mine("plib", "c7", ["probe-finisher"])],
      [wild("grima", 20, "c8"), wild("grima", 20, "c9")],
    );
    stripPassives(st);
    const foe = st.teams[1][0]!;
    foe.hp = combatantMaxHp(foe) * 10;
    resolveTurn(st, [spell("probe-finisher", [{ side: 1, index: 0 }])]);
    const inst = foe.statuses.find((s) => s.id === "probe-chill")!;
    // It landed this turn, so this turn's end did not count against it.
    expect(inst.turnsLeft).toBe(3);
    resolveTurn(st, [{ kind: "switch", side: 1, slot: 0, benchIndex: 1 }]);
    expect(foe.statuses.some((s) => s.id === "probe-chill")).toBe(false);
  });

  it("stands for the turns it says", () => {
    install(CHILL, "status");
    install(FINISHER, "move");
    const st = duel([mine("plib", "c10", ["probe-finisher"])], [wild("grima", 20, "c11"), wild("grima", 20, "c12")]);
    stripPassives(st);
    const foe = st.teams[1][0]!;
    foe.hp = combatantMaxHp(foe) * 10;
    resolveTurn(st, [spell("probe-finisher", [{ side: 1, index: 0 }])]);
    for (let i = 0; i < 3 && st.winner === -1; i++) {
      resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    }
    expect(foe.statuses.some((s) => s.id === "probe-chill")).toBe(false);
  });
});

describe("a status that both stands and answers a trigger", () => {
  it("holds its stat up from the moment it lands and waits a turn to mend", () => {
    install(VIGIL, "status");
    install(VIGIL_CALL, "move");
    const st = duel([mine("plib", "v1", ["probe-vigil-call"])], [wild("grima", 20, "v2")]);
    stripPassives(st);
    const me = st.teams[0][0]!;
    const bareDefense = combatantStats(me).def;
    const max = combatantMaxHp(me);
    me.hp = 10;
    resolveTurn(st, [spell("probe-vigil-call", [{ side: 0, index: 0 }])]);
    expect(combatantStats(me).def).toBe(Math.floor(bareDefense * 1.5));
    // A mark does not tick on the turn it lands, so it mends from the next one.
    expect(me.hp).toBe(10);
    me.mana = 100;
    resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    expect(me.hp).toBe(10 + Math.max(1, Math.floor(max * 0.1)));
  });
});

describe("a status that deals damage every turn", () => {
  it("fixes the step that asks for it, behind a step that does not", () => {
    install(EMBER, "status");
    install(EMBER_CALL, "move");
    const st = duel([mine("plib", "e1", ["probe-ember-call"])], [wild("grima", 20, "e2"), wild("grima", 20, "e3")]);
    stripPassives(st);
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    const mag = combatantStats(me).mag;
    resolveTurn(st, [spell("probe-ember-call", [{ side: 1, index: 0 }])]);
    const inst = foe.statuses.find((s) => s.id === "probe-ember")!;
    expect(inst.power).toBe(mag * 0.2);
    const max = combatantMaxHp(foe);
    const before = foe.hp;
    // Both damage steps are magic, so each meets the holder's Resistance, and
    // a mark lands like a move does: the caster's own element where it shares
    // one, then the chart against whoever is carrying it.
    const res = mitigation(combatantStats(foe).res);
    const syn = scobaTypes(me.scoba).includes("firework") ? 1.5 : 1;
    const eff = typesEffectiveness(["firework"], scobaTypes(foe.scoba));
    const lands = (power: number): number => Math.max(1, Math.floor(power * syn * eff * res));
    const events = resolveTurn(st, [{ kind: "block", side: 0, slot: 0 }]);
    expect(before - foe.hp).toBe(lands(max * 0.05) + lands(mag * 0.2));
    expect(events.filter((e) => e.text.includes("Probe Ember hits"))).toHaveLength(2);
  });
});

describe("a passive that answers a trigger", () => {
  it("marks whoever it swung at", () => {
    install(CHILL, "status");
    install(GORE, "passive");
    const st = duel([mine("plib", "g1", ["crush"], "probe-gore")], [wild("grima", 20, "g2")]);
    stripPassives(st, ["probe-gore"]);
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    foe.hp = combatantMaxHp(foe) * 10;
    const res = mitigation(combatantStats(foe).res);
    resolveTurn(st, [{ kind: "attack", side: 0, slot: 0, picks: [{ side: 1, index: 0 }] }]);
    const inst = foe.statuses.find((s) => s.id === "probe-chill")!;
    expect(inst).toBeTruthy();
    // Nobody left a passive, so what it hangs is measured off its holder.
    expect(inst.power).toBe(combatantStats(me).mag * 0.5 * res);
    expect(inst.from).toEqual({ side: 0, index: 0 });
  });
});

describe("a passive carried as standing effects", () => {
  it("moves every stat and then scales one of them", () => {
    install(BULK, "passive");
    const st = duel([mine("plib", "b1", ["crush"], "probe-bulk")], [wild("grima", 20, "b2")]);
    stripPassives(st, ["probe-bulk"]);
    const me = st.teams[0][0]!;
    const base = statsAt(me.scoba, false);
    const now = combatantStats(me);
    expect(now.hp).toBe(base.hp + 4);
    expect(now.spd).toBe(base.spd + 4);
    expect(now.mag).toBe(base.mag + 4);
    // Adds land before scales, so the half is a half of the new total.
    expect(now.str).toBe(Math.floor((base.str + 4) * 1.5));
  });

  it("writes the six lines back as one", () => {
    const read = readScript(BULK, "passive");
    expect(writePassive(read.abilities[0]!, read.statuses[0]!)).toContain("all stats +4");
  });
});

describe("a status watching for low HP", () => {
  it("mends its holder while it has charges, and goes when they run out", () => {
    install(WIND, "status");
    install(GUARD, "status");
    install(BLESS, "move");
    install(ORDEAL, "move");
    const st = duel([mine("plib", "w1", ["probe-bless", "probe-ordeal"])], [wild("grima", 20, "w2")]);
    stripPassives(st);
    const me = st.teams[0][0]!;
    const max = combatantMaxHp(me);
    const bite = Math.max(1, Math.floor(max * 0.3));
    const mend = Math.max(1, Math.floor(max * 0.25));
    resolveTurn(st, [spell("probe-bless", [{ side: 0, index: 0 }])]);
    expect(me.statuses.some((s) => s.id === "probe-wind")).toBe(true);
    expect(me.statuses.some((s) => s.id === "probe-guard")).toBe(true);
    me.hp = max;
    me.mana = 100;

    // Down to 70% of the bar, which is above the line it watches for.
    resolveTurn(st, [spell("probe-ordeal", [null])]);
    expect(me.hp).toBe(max - bite);
    expect(me.statuses.find((s) => s.id === "probe-wind")!.chargesLeft).toBe(2);

    me.mana = 100;
    resolveTurn(st, [spell("probe-ordeal", [null])]);
    expect(me.hp).toBe(max - bite * 2 + mend);
    expect(me.statuses.find((s) => s.id === "probe-wind")!.chargesLeft).toBe(1);

    me.mana = 100;
    resolveTurn(st, [spell("probe-ordeal", [null])]);
    // Its last charge spent, it is gone.
    expect(me.statuses.some((s) => s.id === "probe-wind")).toBe(false);
  });

  it("heals for a share of the caster's Magic", () => {
    install(WIND, "status");
    install(GUARD, "status");
    install(BLESS, "move");
    const st = duel(
      [mine("plib", "h1", ["probe-bless"]), mine("pieble", "h2", ["crush"])],
      [wild("grima", 20, "h3")],
      2,
    );
    stripPassives(st);
    const me = st.teams[0][0]!;
    const ally = st.teams[0][1]!;
    ally.hp = 20;
    const mend = Math.max(1, Math.floor(combatantStats(me).mag * 0.1));
    resolveTurn(st, [spell("probe-bless", [{ side: 0, index: 1 }])]);
    expect(ally.hp).toBe(20 + mend);
  });
});

describe("a move that lays a field", () => {
  it("puts it over both sides and says the line it begins with", () => {
    install(GLOOM, "field");
    install(GLOOM_CALL, "move");
    const st = duel([mine("plib", "gl1", ["probe-gloom-call"])], [wild("grima", 20, "gl2")]);
    stripPassives(st);
    const events = resolveTurn(st, [spell("probe-gloom-call", [null])]);
    expect(st.fields[0]?.id).toBe("probe-gloom");
    expect(st.fields[1]?.id).toBe("probe-gloom");
    expect(events.some((e) => e.kind === "field" && e.text === "A gloom settles over the field.")).toBe(true);
  });

  it("multiplies the element it favors and the damage its side takes", () => {
    install(GLOOM, "field");
    install(GLOOM_CALL, "move");
    install(MOONLIGHT, "move");
    const st = duel([mine("plib", "gl3", ["probe-gloom-call", "probe-moonlight"])], [wild("grima", 20, "gl4")]);
    stripPassives(st);
    const foe = st.teams[1][0]!;
    foe.hp = combatantMaxHp(foe) * 10;
    const plain = previewMove(st, { side: 0, index: 0 }, "probe-moonlight")!.damage!;
    resolveTurn(st, [spell("probe-gloom-call", [null])]);
    // The caster's own side is what its Moon damage is read against.
    const under = previewMove(st, { side: 0, index: 0 }, "probe-moonlight")!.damage!;
    expect(Math.abs(under - plain * 1.5)).toBeLessThanOrEqual(1);
    st.teams[0][0]!.mana = 100;
    const before = foe.hp;
    const events = resolveTurn(st, [spell("probe-moonlight", [{ side: 1, index: 0 }])]);
    // And the enemy is standing under it too, so it takes half again on top.
    expect(Math.abs((before - foe.hp) - plain * 2.25)).toBeLessThanOrEqual(3);
    expect(events.some((e) => e.text === "Plib draws a line through Grima.")).toBe(true);
  });

  it("turns aside the element it is immune to, and lifts on its own clock", () => {
    install(GLOOM, "field");
    install(GLOOM_CALL, "move");
    install(THORN, "move");
    const st = duel([mine("plib", "gl5", ["probe-gloom-call", "probe-thorn"])], [wild("grima", 20, "gl6")]);
    stripPassives(st);
    const foe = st.teams[1][0]!;
    resolveTurn(st, [spell("probe-gloom-call", [null])]);
    st.teams[0][0]!.mana = 100;
    const before = foe.hp;
    const events = resolveTurn(st, [spell("probe-thorn", [{ side: 1, index: 0 }])]);
    expect(foe.hp).toBe(before);
    expect(events.some((e) => e.text.includes("untouched"))).toBe(true);
    // Two turns have ended since it was laid, so it is gone.
    expect(st.fields[0]).toBeNull();
    expect(events.some((e) => e.kind === "field" && e.text === "The gloom lifts.")).toBe(true);
  });
});

describe("the steps that call things up and hand things out", () => {
  it("summons, fills mana and writes its line", () => {
    install(RALLY, "move");
    const st = duel(
      [mine("plib", "r1", ["probe-rally"]), mine("pieble", "r2", ["crush"])],
      [wild("grima", 20, "r3")],
      2,
    );
    stripPassives(st);
    const me = st.teams[0][0]!;
    const ally = st.teams[0][1]!;
    me.mana = 40;
    ally.mana = 40;
    const before = st.teams[0].length;
    const events = resolveTurn(st, [spell("probe-rally", [null])]);
    expect(st.teams[0].length).toBe(before + 1);
    const called = st.teams[0][before]!;
    expect(called.summoned).toBe(true);
    expect(called.scoba.speciesId).toBe("catsquito");
    expect(called.scoba.level).toBe(5);
    // 20 paid, 30 given, and the turn's 20 at the end of it.
    expect(me.mana).toBe(70);
    expect(ally.mana).toBe(90);
    expect(events.some((e) => e.text === "Plib calls the swarm.")).toBe(true);
  });

  it("copies one Scoba's marks and washes the bad ones off it", () => {
    install(CHILL, "status");
    install(GUARD, "status");
    install(MIRROR, "move");
    const st = duel([mine("plib", "m1", ["probe-mirror"])], [wild("grima", 20, "m2")]);
    stripPassives(st);
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    foe.statuses.push({ id: "probe-chill", turnsLeft: 3, chargesLeft: -1, stacks: 1, power: 10 });
    foe.statuses.push({ id: "probe-guard", turnsLeft: 2, chargesLeft: -1, stacks: 1 });
    resolveTurn(st, [spell("probe-mirror", [{ side: 1, index: 0 }, { side: 0, index: 0 }])]);
    expect(me.statuses.map((s) => s.id).sort()).toEqual(["probe-chill", "probe-guard"]);
    expect(foe.statuses.map((s) => s.id)).toEqual(["probe-guard"]);
  });
});

describe("a move that picks another move and rewrites it", () => {
  it("hands the rewrite over in a slot and swings for a flat number", () => {
    install(WHEEL, "move");
    const st = duel([mine("plib", "wh1", ["probe-wheel"])], [wild("grima", 20, "wh2")]);
    stripPassives(st);
    const me = st.teams[0][0]!;
    const foe = st.teams[1][0]!;
    const before = foe.hp;
    // Fortuna against Flux, reduced by Grima's Defense: a flat base and an ordinary hit from there.
    const flat = 2 * me.scoba.level;
    const expected = Math.max(1, Math.floor(
      flat * typesEffectiveness(["fortuna"], scobaTypes(foe.scoba)) * mitigation(combatantStats(foe).def),
    ));
    const events = resolveTurn(st, [spell("probe-wheel", [{ side: 1, index: 0 }])]);
    const given = me.swapped?.[3];
    expect(given).toBeTruthy();
    const rewritten = MOVES[given!]!;
    expect(rewritten.derived?.by).toBe("probe-wheel");
    expect(rewritten.type).toBe("fortuna");
    expect(rewritten.tint).toBe("#e8c46a");
    expect(rewritten.manaCost).toBeGreaterThanOrEqual(40);
    expect(MOVES[rewritten.derived!.from]!.oncePerBattle).not.toBe(true);
    const hit = events.find((e) => e.kind === "hit")!;
    expect(before - hit.hp!).toBe(expected);
    expect(expected).not.toBe(flat);
  });

  it("reads the clauses under a step the same as the ones after a comma", () => {
    const stacked = readScript(WHEEL, "move");
    const inline = readScript(WHEEL.replace(
      ["    pick a random move", "      costing at least 40", "      skip once per battle"].join("\n"),
      "    pick a random move, costing at least 40, skip once per battle",
    ), "move");
    expect(inline.problems).toEqual([]);
    expect(clean(inline.moves[0])).toEqual(clean(stacked.moves[0]));
  });

  it("skips a note written inside a block", () => {
    const read = readScript(WHEEL, "move");
    expect(read.problems).toEqual([]);
    expect(read.moves[0]!.cast[0]!.kind).toBe("show");
  });
});

describe("what the reader refuses", () => {
  const says = (text: string, kind: RecordKind = "move"): string =>
    readScript(text, kind).problems[0]?.says ?? "";
  const cast = (steps: string): string => [
    "move probe-bad \"Bad\"",
    "  type firework",
    "  costs 10 mana",
    "  aim any enemy",
    "  cast:",
    ...steps.split("\n").map((l) => `    ${l}`),
  ].join("\n");

  it("names the word that starts no step, whatever else is on the line", () => {
    expect(says(cast("hitt target 100% magic, sound tap"))).toContain("\"hitt\" does not start a step");
    expect(says(cast("hitt target\n  100% magic"))).toContain("\"hitt\" does not start a step");
  });

  it("wants an element or a category after \"as\"", () => {
    expect(says(cast("hit target 100% magic, as"))).toContain("says what the attack is read as");
  });

  it("wants a move picked before one is rewritten or handed over", () => {
    expect(says(cast("change picked move:\n  set type moon"))).toContain("nothing has been picked yet");
    expect(says(cast("give caster picked move as extra"))).toContain("nothing has been picked yet");
  });

  it("takes a power line or a snapshotted damage step, and not both", () => {
    expect(says([
      "status probe-bad \"Bad\"",
      "  bad",
      "  power 40% of source magic",
      "  when a turn ends:",
      "    damage holder 15% of source magic, as firework magic, fixed when applied",
    ].join("\n"), "status")).toContain("measures one number as it lands");
  });

  it("takes one of \"once per battle\" and \"charges\"", () => {
    expect(says([
      "passive probe-bad \"Bad\"",
      "  once per battle",
      "  charges 3",
      "  when a turn ends:",
      "    heal holder 10% of their max hp",
    ].join("\n"), "passive")).toContain("says how often it goes off once");
  });

  it("refuses a count below nothing", () => {
    expect(says(cast("give caster -30 mana"))).toContain("cannot be less than nothing");
    expect(says(cast("summon catsquito at level -5"))).toContain("cannot be less than nothing");
    expect(says([
      "status probe-bad \"Bad\"",
      "  bad",
      "  lasts -2 turns",
      "  while carried:",
      "    speed x0.5",
    ].join("\n"), "status")).toContain("cannot be less than nothing");
  });

  it("wants a color where a color goes", () => {
    expect(says([
      "field probe-bad \"Bad\"",
      "  tint midnight",
      "  begins \"It begins.\"",
      "  ends \"It ends.\"",
    ].join("\n"), "field")).toContain("should be a color like #bc0006");
  });

  it("names the effect a field cannot carry", () => {
    expect(says([
      "field probe-bad \"Bad\"",
      "  tint #2b2f5e",
      "  begins \"It begins.\"",
      "  ends \"It ends.\"",
      "  while standing:",
      "    speed x1.2",
    ].join("\n"), "field")).toContain("\"speed\" is not something a field does");
  });

  it("keeps refund to the moves that have a cost to give back", () => {
    expect(says([
      "status probe-bad \"Bad\"",
      "  bad",
      "  when hit:",
      "    refund",
    ].join("\n"), "status")).toContain("only a move has a cost to refund");
  });
});

describe("the shape of a file", () => {
  const says = (text: string, kind: RecordKind = "move"): string =>
    readScript(text, kind).problems[0]?.says ?? "";

  it("reads a record written with tabs and one written with carriage returns", () => {
    const spaces = readScript(MOONLIGHT, "move");
    const tabs = readScript(MOONLIGHT.replace(/ {4}/g, "\t\t").replace(/^ {2}/gm, "\t"), "move");
    const crlf = readScript(MOONLIGHT.replace(/\n/g, "\r\n"), "move");
    expect(tabs.problems).toEqual([]);
    expect(crlf.problems).toEqual([]);
    expect(clean(tabs.moves[0])).toEqual(clean(spaces.moves[0]));
    expect(clean(crlf.moves[0])).toEqual(clean(spaces.moves[0]));
  });

  it("catches a comma with nothing on one side of it", () => {
    expect(says([
      "move probe-bad \"Bad\"",
      "  type firework",
      "  costs 10 mana",
      "  aim any enemy",
      "  cast:",
      "    hit target 100% magic,",
    ].join("\n"))).toContain("has a comma with nothing on one side of it");
  });

  it("wants an id bare rather than in quotes", () => {
    expect(says([
      "move probe-bad \"Bad\"",
      "  type firework",
      "  costs 10 mana",
      "  aim any enemy",
      "  cast:",
      "    inflict \"probe-chill\" on target",
    ].join("\n"))).toContain("should be an id of lower-case letters");
  });

  it("wants something under a block that opens one", () => {
    expect(says([
      "status probe-bad \"Bad\"",
      "  bad",
      "  when a turn ends:",
    ].join("\n"), "status")).toBe("has nothing indented under it");
  });

  it("reports a second record that claims an id the first one took", () => {
    const twice = [MOONLIGHT, MOONLIGHT].join("\n\n");
    const read = readContent({ moves: twice, statuses: "", passives: "", fields: "", hobbies: "" });
    expect(read.problems.map((p) => p.says)).toEqual([
      "\"probe-moonlight\" is already used by a record in moves",
    ]);
    expect(Object.keys(read.moves)).toEqual(["probe-moonlight"]);
  });
});

describe("what the writer writes back", () => {
  it("keeps a category the hit named, even where the stat implies it", () => {
    const read = readScript([
      "move probe-cat \"Cat\"",
      "  type firework",
      "  costs 10 mana",
      "  aim any enemy",
      "  cast:",
      "    hit target 100% strength, as firework physical",
    ].join("\n"), "move");
    expect(read.problems).toEqual([]);
    expect(writeMove(read.moves[0]!)).toContain("hit target 100% strength, as firework physical");
  });

  it("keeps an if inside an if", () => {
    const text = [
      "move probe-nest \"Nest\"",
      "  type firework",
      "  costs 10 mana",
      "  aim any enemy",
      "  aim any ally",
      "  cast:",
      "    hit target 100% magic",
      "    if target fell:",
      "      heal target2 10% of caster magic",
      "      if target2 fell:",
      "        caster shake",
    ].join("\n");
    const read = readScript(text, "move");
    expect(read.problems).toEqual([]);
    const back = readScript(writeMove(read.moves[0]!), "move");
    expect(back.problems).toEqual([]);
    expect(clean(back.moves[0])).toEqual(clean(read.moves[0]));
  });

  it("counts one turn and one second in the singular", () => {
    const read = readScript([
      "move probe-one \"One\"",
      "  type firework",
      "  costs 10 mana",
      "  aim any enemy",
      "  cast:",
      "    wait 1 second",
      "    inflict probe-chill on target, for 1 turn",
    ].join("\n"), "move");
    expect(read.problems).toEqual([]);
    const out = writeMove(read.moves[0]!);
    expect(out).toContain("wait 1 second");
    expect(out).toContain("for 1 turn");
    expect(out).not.toContain("1 turns");
  });
});
