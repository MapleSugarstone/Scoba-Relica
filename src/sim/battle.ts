// Deterministic battle engine (1v1 wild fights, 2v2 doubles, and the co-op
// fights where the two characters hold a slot each). Both clients replay the
// same seed and choice log, so a peer's state can be re-derived and checked
// rather than trusted.
//
// Combat rules: every Scoba starts a battle with 40 mana, gains 20 at end of
// turn (cap 100), and spends mana on spells. Some spells have a cooldown and
// a starting cooldown. Innate actions: Block (halve all damage taken this
// turn) and a basic attack (100% Strength, typeless physical). Physical
// damage is mitigated by Defense (+1% effective HP per point), magical by
// Resistance. Same-type spells deal 1.5x, super effective 2x, resisted 0.5x.
//
// Every hit in the battle, whatever it came from, goes through `dealDamage`.
// That is the one place immunity, vulnerability, blocking, faints and the
// on-hit and kill status triggers are handled, so a status tick and a spell
// cannot drift apart in how they land.
import type { ScobaInstance, Summoner } from "./scoba";
import { MAX_MANA, moveCost, statsAt, makeWild, passiveStatuses } from "./scoba";
import { MOVES, SPECIES, effectivenessAgainst, isStab, type Move, type MoveEffect } from "./species";
import type { ElementType, StatName, Stats } from "./types";
import type { Rng } from "./rng";
import { mulberry32, hashSeed, rngFrom } from "./rng";
import {
  FIELDS,
  STATUSES,
  applyStatus,
  continuousEffects,
  fieldEffects,
  foldStatEffects,
  newField,
  newStatus,
  onSwitchOut,
  stacksOf,
  statusName,
  tickDurations,
  tickField,
  triggerMatches,
  wardAgainst,
  type Basis,
  type DamageCategory,
  type DamageClass,
  type FieldEffect,
  type FieldInstance,
  type FieldScope,
  type StatusDef,
  type StatusEffect,
  type InflictScope,
  type StatusInstance,
  type StatusPolarity,
  type TriggerEvent,
} from "./status";
import {
  candidates,
  combatantAt,
  isPawnSlot,
  needsPick,
  pickError,
  resolveTargets,
  sameRef,
  ALL_SLOTS,
  FIELD_SLOTS,
  PAWN_SLOTS,
  SCOBA_SLOTS,
  type TargetRef,
  type TargetSpec,
} from "./targeting";

export { ALL_SLOTS, FIELD_SLOTS, PAWN_SLOTS, SCOBA_SLOTS, isPawnSlot };

export const START_MANA = 40;
export const MANA_PER_TURN = 20;
export { MAX_MANA };
export const BLOCK_FACTOR = 0.5;
/** Summons past this many on one team are refused, cap-breaking or not. */
export const MAX_SUMMONS = 6;
/** Stops a chain of statuses that set each other off from running away. */
const MAX_TRIGGER_DEPTH = 4;
/** A fight that runs past this many turns starts costing both sides. */
export const ATTRITION_AFTER = 20;
/** How much more of its pool each active Scoba pays per turn past that. */
export const ATTRITION_STEP = 0.1;

/** The share of its pool every active Scoba loses at the end of this turn. */
export function attritionFrac(turn: number): number {
  return turn <= ATTRITION_AFTER ? 0 : (turn - ATTRITION_AFTER) * ATTRITION_STEP;
}

/** What a plain Attack aims at. Kept here so it reads like any other move. */
export const BASIC_ATTACK_TARGETS: TargetSpec[] = [{ mode: "any-enemy", prompt: "Strike" }];

export interface Combatant {
  scoba: ScobaInstance;
  hp: number;
  mana: number;
  /** Turns each move stays locked; decremented at end of turn. */
  cds: Record<string, number>;
  blocking: boolean;
  fainted: boolean;
  statuses: StatusInstance[];
  /** Called in mid-battle rather than brought from the party. */
  summoned?: boolean;
  /**
   * Standing on a Pawn slot. It fights like anything else on the field and is
   * aimed at like anything else, but it never switches, never fills a Scoba
   * slot, and never keeps a team alive on its own.
   */
  pawn?: boolean;
}

/** A character in the shared save. */
export type OwnerId = "A" | "B";

/**
 * Who is playing a side-0 slot: a character, `"*"` for a slot not tied to one
 * (wild 1v1 and plain doubles), or null for a slot nobody holds, which is a
 * co-op battle waiting on the other player to walk over and join.
 */
export type SlotHolder = OwnerId | "*" | null;

export interface BattleState {
  seed: string;
  turn: number;
  wild: boolean;
  /** Scoba slots in play. Pawn slots are separate and are never "in play". */
  slots: 1 | 2;
  teams: [Combatant[], Combatant[]];
  /**
   * Who is on each of the side's marks, by team index, -1 for an empty one.
   * `SCOBA_SLOTS` entries for the Scobas, then `PAWN_SLOTS` for the Pawns.
   */
  active: [number[], number[]];
  /** Side 0 only. Side 1 fields whatever it has, in team order. */
  slotOwner: [SlotHolder, SlotHolder];
  /** Items won during the fight, spent before anything from the bag. */
  items: [Record<string, number>, Record<string, number>];
  /**
   * The field standing over each side. One at a time: laying a new one over a
   * side takes the old one off. Nobody carries it, so it survives a switch and
   * a faint and is never cleansed.
   */
  fields: [FieldInstance | null, FieldInstance | null];
  /**
   * EZ mode. Kept on the state rather than spent at the opening, because a
   * Pawn called mid-battle has to be given the same leg-up as the Scoba that
   * called it: without it the court stays at a quarter of everyone's size.
   */
  ez: boolean;
  /**
   * What the opening triggers said before there was a round to say it in. A
   * passive that summons as its Scoba takes the field fires here, and the
   * scene plays these after the walk-on rather than dropping them.
   */
  opening: BattleEvent[];
  winner: -1 | 0 | 1;
  outcome: "" | "caught" | "fled";
}

/**
 * The side-0 slot a character plays. Fixed rather than first-come so two
 * clients building the same battle agree on which slot is whose, which is
 * what lets `stateHash` compare by index.
 */
export function slotOf(owner: OwnerId): 0 | 1 {
  return owner === "A" ? 0 : 1;
}

/** A mark on the field: a Scoba slot below `SCOBA_SLOTS`, a Pawn slot above. */
export type Slot = number;

export type Choice =
  | { kind: "spell"; side: 0 | 1; slot: Slot; moveId: string; picks: (TargetRef | null)[] }
  | { kind: "attack"; side: 0 | 1; slot: Slot; picks: (TargetRef | null)[] }
  | { kind: "block"; side: 0 | 1; slot: Slot }
  | { kind: "switch"; side: 0 | 1; slot: Slot; benchIndex: number }
  | { kind: "catch"; side: 0 | 1; slot: Slot }
  | { kind: "flee"; side: 0 | 1; slot: Slot }
  | { kind: "pass"; side: 0 | 1; slot: Slot };

export interface BattleEvent {
  text: string;
  kind: "spell" | "hit" | "faint" | "switch" | "heal" | "block" | "catch" | "flee" | "win" | "info"
  | "status" | "summon" | "field";
  /** Who the line is about: the one hit, healed, marked or sent out. */
  at?: TargetRef;
  /** Who brought it about, when that is somebody else. */
  by?: TargetRef;
  /** The move behind it, so an animation can be picked for it. */
  moveId?: string;
  /**
   * The subject's HP and mana once this event has landed. The battle resolves
   * a whole round at once, so a bar that read the live combatant would empty
   * before its animation played; these are what the scene tweens toward.
   */
  hp?: number;
  mana?: number;
  /**
   * What the field over those sides has become, null for one that has lifted.
   * A field laid over both sides is one event and not two, so the Scoba that
   * called it rattles once rather than twice.
   */
  field?: { id: string | null; sides: (0 | 1)[] };
}

/**
 * A battle opens with everyone whole: full HP, full mana, nobody down. The
 * fights are built to be met by a team at full strength, so carrying damage
 * in would only ever be a tax on the next fight rather than a decision.
 */
export function makeCombatants(team: ScobaInstance[]): Combatant[] {
  return team.map((s) => {
    const cds: Record<string, number> = {};
    for (const id of s.moves) {
      const m = MOVES[id];
      if (m && m.startCooldown > 0) cds[id] = m.startCooldown;
    }
    const c: Combatant = {
      scoba: s,
      hp: 0,
      mana: START_MANA,
      cds,
      blocking: false,
      fainted: false,
      // Abilities are statuses, hung on before anything reads a stat off it.
      statuses: passiveStatuses(s),
    };
    c.hp = combatantMaxHp(c);
    return c;
  });
}

/**
 * Is anyone playing this slot at all? A Pawn slot is only ever in play while
 * something is standing on it: nobody is fielded there at the opening and
 * nothing walks on to fill it once its Pawn falls.
 */
export function slotInPlay(st: BattleState, side: 0 | 1, slot: Slot): boolean {
  if (slot < 0 || slot >= FIELD_SLOTS) return false;
  if (isPawnSlot(slot)) return (st.active[side][slot] ?? -1) >= 0;
  if (slot >= st.slots) return false;
  return side === 1 || st.slotOwner[slot] !== null;
}

/** Which character's Scobas may fill this slot, or `"*"` for no restriction. */
function holderOf(st: BattleState, side: 0 | 1, slot: Slot): SlotHolder {
  if (side === 1 || isPawnSlot(slot)) return "*";
  return st.slotOwner[slot] ?? null;
}

/**
 * Team members that side could still send into that slot: standing, not
 * already out, and belonging to the character holding the slot. A Scoba
 * summoned into the fight answers to whoever summoned it. A Pawn is on nobody's
 * bench and has no bench of its own: it takes the field by being called and
 * leaves it by falling.
 */
export function benchFor(st: BattleState, side: 0 | 1, slot: Slot): number[] {
  if (isPawnSlot(slot) || !slotInPlay(st, side, slot)) return [];
  const holder = holderOf(st, side, slot);
  const out: number[] = [];
  st.teams[side].forEach((c, i) => {
    if (c.fainted || c.pawn || st.active[side].includes(i)) return;
    if (holder !== "*" && c.scoba.owner !== holder) return;
    out.push(i);
  });
  return out;
}

/**
 * Slots with someone standing in them, which are the ones a round asks about.
 * An emptied slot is not one of them: its replacement walks on between rounds
 * rather than spending a turn to arrive.
 */
export function slotsAwaitingChoice(st: BattleState, side: 0 | 1): Slot[] {
  return ALL_SLOTS.filter(
    (slot) => slotInPlay(st, side, slot) && (st.active[side][slot] ?? -1) >= 0,
  );
}

/** Slots whose Scoba went down, with somebody left to take its place. */
export function emptySlots(st: BattleState, side: 0 | 1): Slot[] {
  if (st.winner !== -1 || st.outcome !== "") return [];
  return ALL_SLOTS.filter(
    (slot) =>
      !isPawnSlot(slot) &&
      slotInPlay(st, side, slot) &&
      (st.active[side][slot] ?? -1) < 0 &&
      benchFor(st, side, slot).length > 0,
  );
}

/**
 * Fills a slot the last Scoba left empty. This happens between rounds, not as
 * a turn's action: what fell is replaced after the round that felled it, and
 * the one that walked on picks a move in the next one like anybody else.
 */
export function sendIn(st: BattleState, side: 0 | 1, slot: Slot, benchIndex: number): BattleEvent[] {
  if (!slotInPlay(st, side, slot) || (st.active[side][slot] ?? -1) >= 0) return [];
  if (!benchFor(st, side, slot).includes(benchIndex)) return [];
  const c = st.teams[side][benchIndex]!;
  st.active[side][slot] = benchIndex;
  const events: BattleEvent[] = [{
    text: `${displayName(c.scoba)} joins the fight.`,
    kind: "switch",
    at: { side, index: benchIndex },
  }];
  const ctx: Ctx = { st, events, rng: turnRng(st), depth: 0 };
  fire(ctx, { side, index: benchIndex }, { on: "switch-in" }, null);
  return events;
}

export function startBattle(
  seed: string,
  teamA: ScobaInstance[],
  teamB: ScobaInstance[],
  opts: {
    slots?: 1 | 2; wild?: boolean; owners?: [SlotHolder, SlotHolder];
    /** EZ mode: the players' own Scobas fight this one with a leg-up. */
    ez?: boolean;
  } = {},
): BattleState {
  const slots = opts.slots ?? 1;
  const st: BattleState = {
    seed,
    turn: 0,
    wild: opts.wild ?? false,
    slots,
    teams: [makeCombatants(teamA), makeCombatants(teamB)],
    active: [emptyField(), emptyField()],
    slotOwner: opts.owners ?? ["*", "*"],
    items: [{}, {}],
    fields: [null, null],
    opening: [],
    ez: opts.ez === true,
    winner: -1,
    outcome: "",
  };
  if (st.ez) for (const c of st.teams[0]) grantEz(c);
  for (const side of [0, 1] as const) st.active[side] = fillSlots(st, side);
  // The opening triggers: passives that want to know a battle has started, and
  // the send-out of whoever is fielded first. No round is running yet, so what
  // they say is kept on the state for the scene to play after the walk-on.
  const ctx: Ctx = { st, events: st.opening, rng: turnRng(st), depth: 0 };
  for (const side of [0, 1] as const) {
    st.teams[side].forEach((_c, index) => fire(ctx, { side, index }, { on: "battle-start" }, null));
  }
  forEachStanding(st, (ref) => fire(ctx, ref, { on: "switch-in" }, null));
  return st;
}

/** A field with nobody on any of its marks. */
function emptyField(): number[] {
  return ALL_SLOTS.map(() => -1);
}

/**
 * First standing member for each Scoba slot the side is playing, owners
 * respected. Pawn slots are left empty: nothing is ever fielded onto one, only
 * summoned onto it.
 */
function fillSlots(st: BattleState, side: 0 | 1): number[] {
  const out = emptyField();
  for (const slot of ALL_SLOTS) {
    if (isPawnSlot(slot) || !slotInPlay(st, side, slot)) continue;
    const holder = holderOf(st, side, slot);
    out[slot] = st.teams[side].findIndex(
      (c, i) => !c.fainted && !c.pawn && !out.includes(i) && (holder === "*" || c.scoba.owner === holder),
    );
  }
  return out;
}

/**
 * A second player entering a co-op battle. Their Scobas are appended rather
 * than spliced in so indices already in the choice log keep pointing at the
 * same combatant, and they take the slot that was held open for them.
 */
export function joinBattle(st: BattleState, owner: OwnerId, team: ScobaInstance[]): BattleEvent[] {
  const slot = slotOf(owner);
  if (st.winner !== -1 || st.outcome !== "") return [];
  if (st.slotOwner[slot] !== null || slot >= st.slots) return [];
  const base = st.teams[0].length;
  st.teams[0].push(...makeCombatants(team));
  st.slotOwner[slot] = owner;
  const idx = st.teams[0].findIndex((c, i) => i >= base && !c.fainted);
  st.active[0][slot] = idx;
  const joined = idx >= 0 ? st.teams[0][idx]! : null;
  if (!joined) return [{ text: "They have nobody left to send in.", kind: "info" }];
  const events: BattleEvent[] = [{ text: `${displayName(joined.scoba)} joins the fight.`, kind: "switch" }];
  const ctx: Ctx = { st, events, rng: turnRng(st), depth: 0 };
  st.teams[0].forEach((_c, i) => {
    if (i >= base) fire(ctx, { side: 0, index: i }, { on: "battle-start" }, null);
  });
  fire(ctx, { side: 0, index: idx }, { on: "switch-in" }, null);
  return events;
}

function combatant(st: BattleState, side: 0 | 1, slot: Slot): Combatant | null {
  const idx = st.active[side][slot] ?? -1;
  if (idx < 0) return null;
  return st.teams[side][idx] ?? null;
}

/**
 * Does this one pick its own actions rather than being told them? An
 * autonomous Pawn is nobody's to command: it is offered no action row and its
 * choices come out of the same AI the enemy team runs on.
 */
export function selfRunning(c: Combatant): boolean {
  return c.pawn === true && SPECIES[c.scoba.speciesId]?.autonomous === true;
}

/** The first Pawn slot on a side with nothing standing on it. */
function freePawnSlot(st: BattleState, side: 0 | 1): Slot | null {
  for (const slot of ALL_SLOTS) {
    if (!isPawnSlot(slot)) continue;
    if ((st.active[side][slot] ?? -1) < 0) return slot;
  }
  return null;
}

/** Where a combatant sits, for naming it as a target. */
function refOf(st: BattleState, c: Combatant): TargetRef | null {
  for (const side of [0, 1] as const) {
    const index = st.teams[side].indexOf(c);
    if (index >= 0) return { side, index };
  }
  return null;
}

// --- stats with statuses layered on ---

/**
 * Level stats with every continuous status effect folded in. The base is read
 * without passives because a combatant carries its abilities as statuses of
 * its own; folding them in twice is what that would otherwise be.
 */
/**
 * Gives one combatant EZ mode's leg-up, as a status on the combatant rather
 * than anything written back to the Scoba, so it lasts exactly as long as the
 * battle does. Only what a player owns gets it: wild Scobas and other
 * trainers' teams are left where they were.
 */
function grantEz(c: Combatant): void {
  if (!c.scoba.owner) return;
  const stacks = Math.max(0, c.scoba.level - 1);
  if (stacks === 0) return;
  const inst = newStatus("ez");
  if (!inst) return;
  inst.stacks = stacks;
  c.statuses.push(inst);
  // Its HP pool moved with the rest, so it opens the fight at the new full.
  c.hp = combatantMaxHp(c);
}

export function combatantStats(c: Combatant): Stats {
  return foldStatEffects(statsAt(c.scoba, false), continuousEffects(c.statuses));
}

export function combatantMaxHp(c: Combatant): number {
  return Math.floor(combatantStats(c).hp * 2.8);
}

/**
 * What a combatant's own statuses and the field it is standing under both say,
 * as one list. A field carries no stacks, so each of its effects counts once.
 */
function readEffects(
  c: Combatant,
  field: FieldEffect[],
): { effect: StatusEffect; stacks: number }[] {
  const out = continuousEffects(c.statuses);
  for (const effect of field) out.push({ effect, stacks: 1 });
  return out;
}

function immuneTo(c: Combatant, element: ElementType, field: FieldEffect[]): boolean {
  return readEffects(c, field)
    .some(({ effect }) => effect.kind === "immune" && effect.element === element);
}

function vulnerabilityMult(c: Combatant, element: ElementType, field: FieldEffect[]): number {
  let mult = 1;
  for (const { effect, stacks } of readEffects(c, field)) {
    if (effect.kind === "vulnerable" && effect.element === element) mult *= Math.pow(effect.mult, stacks);
  }
  return mult;
}

function elementPower(c: Combatant, element: ElementType, field: FieldEffect[]): number {
  let mult = 1;
  for (const { effect, stacks } of readEffects(c, field)) {
    if (effect.kind === "element-power" && effect.element === element) mult *= Math.pow(effect.mult, stacks);
  }
  return mult;
}

export function moveReady(c: Combatant, moveId: string): { ok: boolean; why?: string } {
  const move = MOVES[moveId];
  if (!move) return { ok: false, why: "Unknown move." };
  if ((c.cds[moveId] ?? 0) > 0) return { ok: false, why: `On cooldown (${c.cds[moveId]}).` };
  if (c.mana < moveCost(c.scoba, moveId)) return { ok: false, why: "Not enough mana." };
  return { ok: true };
}

/** The target specs a choice has to satisfy before it is legal. */
export function specsFor(c: Choice): TargetSpec[] {
  if (c.kind === "attack") return BASIC_ATTACK_TARGETS;
  if (c.kind === "spell") return MOVES[c.moveId]?.targets ?? [];
  return [];
}

/** Client-side cheat check: is this choice legal in this state? */
export function choiceError(st: BattleState, c: Choice): string | null {
  const user = combatant(st, c.side, c.slot);
  if (c.kind === "pass") {
    return user && !user.fainted ? "Cannot pass with an active Scoba." : null;
  }
  if (c.kind === "switch") {
    // Switching into an emptied slot (after a faint) is how replacements enter.
    // The slot is checked before the Scoba: whether anyone is playing it, and
    // whose it is, decide the move regardless of who was named.
    if (isPawnSlot(c.slot)) return "A Pawn cannot be called back.";
    if (!slotInPlay(st, c.side, c.slot)) return "Nobody is playing that slot.";
    const target = st.teams[c.side][c.benchIndex];
    if (!target) return "No such team member.";
    if (target.pawn) return "A Pawn cannot be sent out.";
    const holder = holderOf(st, c.side, c.slot);
    if (holder !== "*" && target.scoba.owner !== holder) {
      return "That Scoba belongs to the other player.";
    }
    if (target.fainted) return "That Scoba has fainted.";
    if (st.active[c.side].includes(c.benchIndex)) return "Already in battle.";
    return null;
  }
  if (!user || user.fainted) return "No active Scoba in that slot.";
  if (c.kind === "block") return null;
  if (c.kind === "catch") {
    if (!st.wild) return "Only in wild battles.";
    if (c.side !== 0) return "Only the challenger can do that.";
    return null;
  }
  if (c.kind === "flee") {
    // Walking away from a trainer is allowed; it simply is not a win.
    if (c.side !== 0) return "Only the challenger can do that.";
    return null;
  }
  if (c.kind === "spell") {
    if (!user.scoba.moves.includes(c.moveId)) return "Scoba does not know that spell.";
    const ready = moveReady(user, c.moveId);
    if (!ready.ok) return ready.why ?? "Not ready.";
  }
  const specs = specsFor(c);
  const picks = c.picks ?? [];
  if (picks.length !== specs.length) return "Wrong number of targets.";
  const userRef = refOf(st, user);
  if (!userRef) return "No active Scoba in that slot.";
  for (let i = 0; i < specs.length; i++) {
    const err = pickError(st, userRef, specs[i]!, picks[i] ?? null);
    if (err) return err;
  }
  return null;
}

function turnRng(st: BattleState): Rng {
  return mulberry32(hashSeed(`${st.seed}:${st.turn}`));
}

export function catchChance(target: Combatant): number {
  const frac = target.hp / Math.max(1, combatantMaxHp(target));
  return Math.min(0.85, 0.25 + 0.55 * (1 - frac));
}

// --- the resolution context ---

interface Ctx {
  st: BattleState;
  events: BattleEvent[];
  rng: Rng;
  depth: number;
}

/** How a hit should be treated once it reaches `dealDamage`. */
interface HitMeta {
  element: ElementType;
  category: DamageCategory;
  damageClass: DamageClass;
  triggersOnHit: boolean;
  source: TargetRef | null;
  /** Appended to the log line, e.g. " Super effective!". */
  note?: string;
  /** The move behind the hit, for the animation that plays it. */
  moveId?: string;
  /** Lands at full even on a Scoba that braced. */
  ignoresBlock?: boolean;
}

function damageOf(
  user: Combatant,
  target: Combatant,
  move: Move | null,
  field: FieldEffect[],
): { dmg: number; eff: number } {
  const uStats = combatantStats(user);
  const tStats = combatantStats(target);
  let dmg: number;
  let eff = 1;
  if (move === null) {
    dmg = uStats.str;
    dmg /= 1 + tStats.def / 100;
  } else {
    dmg = (move.kind === "physical" ? uStats.str : uStats.mag) * move.scale;
    const userSp = SPECIES[user.scoba.speciesId]!;
    const targetSp = SPECIES[target.scoba.speciesId]!;
    if (isStab(userSp, move.type)) dmg *= 1.5;
    eff = effectivenessAgainst(move.type, targetSp);
    dmg *= eff;
    dmg *= elementPower(user, move.type, field);
    dmg /= 1 + (move.kind === "physical" ? tStats.def : tStats.res) / 100;
  }
  return { dmg: Math.max(1, Math.floor(dmg)), eff };
}

/** What a move would do right now, for the readout that explains it. */
export interface MovePreview {
  element: ElementType;
  category: DamageCategory;
  /** The stat it scales off, for the "110% Strength" line. */
  stat: StatName | null;
  scale: number;
  /** What it would take off that target, or null if it deals none. */
  damage: number | null;
  /** 2, 1 or 0.5 against that target. */
  eff: number;
  /** What it would put back, or null if it heals none. */
  heal: number | null;
}

/**
 * Runs the same numbers a cast would, without touching anything, so the
 * ability readout shows what the move will really do rather than its raw
 * scaling. Falls back to the first standing enemy when no target is named.
 */
export function previewMove(
  st: BattleState,
  userRef: TargetRef,
  moveId: string,
  targetRef?: TargetRef,
): MovePreview | null {
  const move = MOVES[moveId];
  const user = combatantAt(st, userRef);
  if (!move || !user) return null;
  const category: DamageCategory = move.kind === "physical" ? "physical" : "magic";
  const stat: StatName | null = move.kind === "physical" ? "str" : move.kind === "magical" ? "mag" : null;
  if (move.kind === "heal") {
    return {
      element: move.type, category, stat: null, scale: move.scale, damage: null, eff: 1,
      heal: Math.floor(combatantMaxHp(user) * move.scale),
    };
  }
  if (move.kind === "utility") {
    return { element: move.type, category, stat: null, scale: 0, damage: null, eff: 1, heal: null };
  }
  const ref = targetRef ?? firstStanding(st, userRef.side === 0 ? 1 : 0);
  const target = ref ? combatantAt(st, ref) : null;
  if (!target) {
    return { element: move.type, category, stat, scale: move.scale, damage: null, eff: 1, heal: null };
  }
  const { dmg, eff } = damageOf(user, target, move, fieldEffects(st.fields[userRef.side]));
  return { element: move.type, category, stat, scale: move.scale, damage: dmg, eff, heal: null };
}

function firstStanding(st: BattleState, side: 0 | 1): TargetRef | null {
  for (const slot of ALL_SLOTS) {
    const index = st.active[side][slot] ?? -1;
    if (index >= 0 && !st.teams[side][index]?.fainted) return { side, index };
  }
  return null;
}

/**
 * The one way anything loses HP. Immunity, vulnerability and blocking are
 * settled here, the log line is written here, and the on-hit, hp-below,
 * death and kill triggers all fan out from here.
 */
function dealDamage(ctx: Ctx, targetRef: TargetRef, raw: number, meta: HitMeta): number {
  const target = combatantAt(ctx.st, targetRef);
  if (!target || target.fainted) return 0;
  const name = displayName(target.scoba);

  const field = fieldEffects(ctx.st.fields[targetRef.side]);
  if (immuneTo(target, meta.element, field)) {
    ctx.events.push({ text: `${name} is untouched by it.`, kind: "info", at: targetRef, by: meta.source ?? undefined });
    return 0;
  }
  // A ward eats one instance outright and spends itself doing it.
  const ward = wardAgainst(target.statuses, meta.element);
  if (ward) {
    if (ward.chargesLeft > 0) ward.chargesLeft -= 1;
    target.statuses = target.statuses.filter((held) => held.chargesLeft !== 0);
    ctx.events.push({
      text: `${name} turns it aside.`,
      kind: "status", at: targetRef, by: meta.source ?? undefined,
    });
    return 0;
  }
  let dmg = raw * vulnerabilityMult(target, meta.element, field);
  if (target.blocking && !meta.ignoresBlock) dmg *= BLOCK_FACTOR;
  dmg = Math.max(1, Math.floor(dmg));

  target.hp = Math.max(0, target.hp - dmg);
  ctx.events.push({
    text: `${name} took ${dmg} damage.${meta.note ?? ""}${target.blocking && !meta.ignoresBlock ? " (blocked)" : ""}`,
    kind: "hit",
    at: targetRef,
    by: meta.source ?? undefined,
    moveId: meta.moveId,
    hp: target.hp,
  });

  if (meta.triggersOnHit && ctx.depth < MAX_TRIGGER_DEPTH) {
    const deeper = { ...ctx, depth: ctx.depth + 1 };
    fire(deeper, targetRef, { on: "hit", category: meta.category, element: meta.element }, meta.source);
    if (meta.source) {
      fire(deeper, meta.source, { on: "deal", category: meta.category, element: meta.element }, targetRef);
    }
  }

  if (target.hp > 0) {
    const frac = target.hp / Math.max(1, combatantMaxHp(target));
    if (ctx.depth < MAX_TRIGGER_DEPTH) {
      fire({ ...ctx, depth: ctx.depth + 1 }, targetRef, { on: "hp-below", frac }, meta.source);
    }
  }
  if (target.hp <= 0) killed(ctx, targetRef, meta);
  return dmg;
}

function heal(ctx: Ctx, targetRef: TargetRef, amount: number): number {
  const target = combatantAt(ctx.st, targetRef);
  if (!target || target.fainted || amount <= 0) return 0;
  const max = combatantMaxHp(target);
  const given = Math.min(max - target.hp, Math.max(1, Math.floor(amount)));
  if (given <= 0) return 0;
  target.hp += given;
  ctx.events.push({ text: `${displayName(target.scoba)} recovered ${given} HP.`, kind: "heal", at: targetRef, hp: target.hp });
  return given;
}

/** Marks a combatant down and fans out every trigger that a death sets off. */
function killed(ctx: Ctx, targetRef: TargetRef, meta: HitMeta): void {
  const st = ctx.st;
  const target = combatantAt(st, targetRef);
  if (!target || target.fainted) return;
  target.fainted = true;
  ctx.events.push({ text: `${displayName(target.scoba)} fainted!`, kind: "faint", at: targetRef, hp: 0 });

  if (ctx.depth < MAX_TRIGGER_DEPTH) {
    const deeper = { ...ctx, depth: ctx.depth + 1 };
    fire(deeper, targetRef, { on: "death" }, meta.source);
    for (const side of [0, 1] as const) {
      st.teams[side].forEach((c, index) => {
        if (c.fainted || sameRef({ side, index }, targetRef)) return;
        const event: TriggerEvent = side === targetRef.side ? { on: "ally-death" } : { on: "enemy-death" };
        fire(deeper, { side, index }, event, targetRef);
      });
    }
    // Only a direct hit counts as a kill; a status tick does not.
    if (meta.damageClass === "attack" && meta.source) {
      fire(deeper, meta.source, { on: "kill-attack" }, targetRef);
    }
  }

  // Statuses are dropped with the Scoba, and its slot is emptied.
  target.statuses = [];
  for (const side of [0, 1] as const) {
    for (const slot of ALL_SLOTS) {
      const idx = st.active[side][slot] ?? -1;
      if (idx >= 0 && st.teams[side][idx]?.fainted) st.active[side][slot] = -1;
    }
  }
  checkWipe(ctx);
}

/**
 * Ends the battle the moment a side has nothing left standing, rather than
 * letting the rest of the turn play out over a team that is already gone.
 *
 * A mutual wipe is a defeat, never a win: calling it a win would end the
 * battle leaving side 0 with nothing standing, and the next battle would then
 * open with no Scoba to send in.
 *
 * Pawns do not hold a side up. A team whose last Scoba falls is beaten even
 * with its court still on the field, which is both the right reading of what a
 * summon is and what stops a round from opening with nobody left to pick for.
 */
function checkWipe(ctx: Ctx): void {
  const st = ctx.st;
  if (st.winner !== -1 || st.outcome !== "") return;
  const gone = (side: 0 | 1): boolean => st.teams[side].every((c) => c.fainted || c.pawn);
  const wiped = [gone(0), gone(1)] as const;
  if (!wiped[0] && !wiped[1]) return;
  st.winner = wiped[0] ? 1 : 0;
  ctx.events.push({ text: st.winner === 0 ? "You win!" : "You lost...", kind: "win" });
}

// --- statuses ---

function basisValue(ctx: Ctx, basis: Basis, holderRef: TargetRef, from: TargetRef | null): number {
  const holder = combatantAt(ctx.st, holderRef);
  const source = from ? combatantAt(ctx.st, from) : null;
  switch (basis) {
    case "source-str": return source ? combatantStats(source).str : 0;
    case "source-mag": return source ? combatantStats(source).mag : 0;
    case "source-max-hp": return source ? combatantMaxHp(source) : 0;
    case "holder-str": return holder ? combatantStats(holder).str : 0;
    case "holder-mag": return holder ? combatantStats(holder).mag : 0;
    case "holder-max-hp": return holder ? combatantMaxHp(holder) : 0;
    case "holder-hp": return holder ? holder.hp : 0;
  }
}

/**
 * Runs the fired effects of every status on a combatant whose trigger matches
 * what just happened, spending a charge each time. `other` is whoever was on
 * the far side of the event: the attacker for an on-hit, the victim for a
 * kill, the killer for a death.
 */
function fire(ctx: Ctx, holderRef: TargetRef, event: TriggerEvent, other: TargetRef | null): void {
  const holder = combatantAt(ctx.st, holderRef);
  if (!holder) return;
  for (const inst of [...holder.statuses]) {
    const def = STATUSES[inst.id];
    if (!def || inst.chargesLeft === 0) continue;
    if (!triggerMatches(def, event)) continue;
    if (inst.chargesLeft > 0) inst.chargesLeft -= 1;
    runStatusEffects(ctx, holderRef, inst, def, other);
  }
  holder.statuses = holder.statuses.filter((s) => s.chargesLeft !== 0);
}

function runStatusEffects(
  ctx: Ctx,
  holderRef: TargetRef,
  inst: StatusInstance,
  def: StatusDef,
  other: TargetRef | null,
): void {
  const holder = combatantAt(ctx.st, holderRef);
  if (!holder) return;
  const from = inst.from ?? null;
  for (const effect of def.effects) {
    switch (effect.kind) {
      case "damage": {
        const d = effect.damage;
        const power = d.snapshot && inst.power !== undefined
          ? inst.power
          : basisValue(ctx, d.basis, holderRef, from) * d.frac;
        ctx.events.push({ text: `${def.name} bites ${displayName(holder.scoba)}.`, kind: "status", at: holderRef });
        dealDamage(ctx, holderRef, Math.max(1, Math.floor(power)), {
          element: d.element,
          category: d.category,
          damageClass: d.damageClass,
          triggersOnHit: d.triggersOnHit,
          source: from,
        });
        break;
      }
      case "heal":
        heal(ctx, holderRef, basisValue(ctx, effect.basis, holderRef, from) * effect.frac);
        break;
      case "cleanse":
        cleanse(ctx, holderRef, effect.polarity);
        break;
      case "copy-statuses":
        if (other) copyStatuses(ctx, holderRef, other);
        break;
      case "summon":
        summon(ctx, holderRef, effect.species, effect.level);
        break;
      case "grant-item":
        grantItem(ctx, holderRef.side, effect.item, effect.count);
        break;
      case "mana": {
        const before = holder.mana;
        holder.mana = Math.min(MAX_MANA, holder.mana + effect.amount);
        if (holder.mana === before) break;
        ctx.events.push({
          text: `${displayName(holder.scoba)} is brimming.`,
          kind: "status", at: holderRef, mana: holder.mana,
        });
        break;
      }
      case "inflict":
        for (const ref of inflictScope(ctx.st, holderRef, other, effect.scope)) {
          inflict(ctx, ref, effect.status, holderRef);
        }
        break;
      case "field":
        setField(ctx, fieldScope(holderRef, effect.scope), effect.field, holderRef);
        break;
      default:
        // Continuous effects, and wards, are read where they matter rather
        // than fired: nothing here has to happen for them.
        break;
    }
  }
}

/** Who an `inflict` effect reaches, relative to the Scoba carrying it. */
function inflictScope(
  st: BattleState,
  holderRef: TargetRef,
  other: TargetRef | null,
  scope: InflictScope,
): TargetRef[] {
  if (scope === "self") return [holderRef];
  if (scope === "other") return other ? [other] : [];
  const sides: (0 | 1)[] = scope === "all"
    ? [0, 1]
    : [scope === "allies" ? holderRef.side : (holderRef.side === 0 ? 1 : 0)];
  const out: TargetRef[] = [];
  for (const side of sides) {
    st.teams[side].forEach((c, index) => {
      if (!c.fainted) out.push({ side, index });
    });
  }
  return out;
}

/** Which sides a `field` effect covers, relative to whoever called it up. */
function fieldScope(holderRef: TargetRef, scope: FieldScope): (0 | 1)[] {
  if (scope === "both") return [0, 1];
  const own = holderRef.side;
  return [scope === "allies" ? own : (own === 0 ? 1 : 0)];
}

/**
 * Lays a field over one or more sides, taking off whatever was standing over
 * them. Sides that end up under the same field are reported as one event, so
 * the Scoba that called it rattles once however many sides it covered.
 */
function setField(
  ctx: Ctx,
  sides: (0 | 1)[],
  fieldId: string,
  from: TargetRef | null,
): void {
  const def = FIELDS[fieldId];
  if (!def) return;
  const changed: (0 | 1)[] = [];
  for (const side of sides) {
    const inst = newField(fieldId, from ?? undefined);
    if (!inst) continue;
    ctx.st.fields[side] = inst;
    changed.push(side);
  }
  if (changed.length === 0) return;
  ctx.events.push({
    text: def.onset,
    kind: "field",
    by: from ?? undefined,
    field: { id: fieldId, sides: changed },
  });
}

/** Puts a status on a target, snapshotting its damage if it asks for that. */
export function inflict(ctx: Ctx, targetRef: TargetRef, statusId: string, from: TargetRef | null): void {
  const def = STATUSES[statusId];
  const target = combatantAt(ctx.st, targetRef);
  if (!def || !target || target.fainted) return;
  let power: number | undefined;
  const dmg = def.effects.find((e) => e.kind === "damage");
  if (dmg && dmg.kind === "damage" && dmg.damage.snapshot) {
    power = basisValue(ctx, dmg.damage.basis, targetRef, from) * dmg.damage.frac;
  }
  const inst = newStatus(statusId, from ?? undefined, power);
  if (!inst) return;
  const how = applyStatus(target.statuses, inst);
  const name = displayName(target.scoba);
  const stacks = stacksOf(target.statuses, statusId);
  ctx.events.push({
    text: how === "added"
      ? `${name} is ${def.name}.`
      : how === "stacked"
        ? `${name} is ${def.name} x${stacks}.`
        : `${name}'s ${def.name} is renewed.`,
    kind: "status",
    at: targetRef,
    by: from ?? undefined,
  });
  target.hp = Math.min(target.hp, combatantMaxHp(target));
}

function cleanse(ctx: Ctx, targetRef: TargetRef, polarity: StatusPolarity): void {
  const target = combatantAt(ctx.st, targetRef);
  if (!target) return;
  const before = target.statuses.length;
  target.statuses = target.statuses.filter((s) => {
    const def = STATUSES[s.id];
    return def?.innate === true || def?.polarity !== polarity;
  });
  if (target.statuses.length === before) return;
  ctx.events.push({
    text: `${displayName(target.scoba)} is rid of ${polarity === "bad" ? "what ailed it" : "its blessings"}.`,
    kind: "status",
  });
  target.hp = Math.min(target.hp, combatantMaxHp(target));
}

function copyStatuses(ctx: Ctx, fromRef: TargetRef, toRef: TargetRef): void {
  const src = combatantAt(ctx.st, fromRef);
  const dst = combatantAt(ctx.st, toRef);
  if (!src || !dst || dst.fainted || src.statuses.length === 0) return;
  let copied = 0;
  for (const s of src.statuses) {
    if (STATUSES[s.id]?.innate) continue;
    const copy: StatusInstance = { ...s, from: s.from ? { ...s.from } : undefined };
    applyStatus(dst.statuses, copy);
    copied += 1;
  }
  if (copied === 0) return;
  ctx.events.push({
    text: `${displayName(dst.scoba)} takes on ${displayName(src.scoba)}'s marks.`,
    kind: "status",
  });
  dst.hp = Math.min(dst.hp, combatantMaxHp(dst));
}

function summon(ctx: Ctx, callerRef: TargetRef, speciesId: string, level: number): void {
  const sp = SPECIES[speciesId];
  if (!sp) return;
  const side = callerRef.side;
  const caller = combatantAt(ctx.st, callerRef);
  if (sp.pawn) return summonPawn(ctx, callerRef, speciesId);
  const already = ctx.st.teams[side].filter((c) => c.summoned).length;
  if (already >= MAX_SUMMONS) {
    ctx.events.push({ text: "Nothing else answers the call.", kind: "info" });
    return;
  }
  const scoba = makeWild(speciesId, level, rngFrom(`${ctx.st.seed}:summon:${ctx.st.turn}:${already}`));
  scoba.owner = caller?.scoba.owner;
  const [c] = makeCombatants([scoba]);
  if (!c) return;
  c.summoned = true;
  ctx.st.teams[side].push(c);
  ctx.events.push({ text: `${displayName(scoba)} answers the call!`, kind: "switch" });
}

/**
 * A Pawn takes a mark of its own rather than a place on the bench, so it is on
 * the field the moment it is called and stays there until it falls. It comes
 * out at its summoner's level, since the only thing that ever decides how big
 * a Pawn is is who called it.
 */
function summonPawn(ctx: Ctx, callerRef: TargetRef, speciesId: string): void {
  const st = ctx.st;
  const side = callerRef.side;
  const caller = combatantAt(st, callerRef);
  if (!caller) return;
  const slot = freePawnSlot(st, side);
  if (slot === null) {
    ctx.events.push({ text: "There is no room for another Pawn.", kind: "info" });
    return;
  }
  const scoba = makeWild(
    speciesId, caller.scoba.level,
    // Label kept through the rename, for the reason given in `ai.ts`.
    rngFrom(`${st.seed}:mote:${st.turn}:${side}:${slot}`),
  );
  scoba.owner = caller.scoba.owner;
  // What it wears is settled where the pixels are. The sim only records who
  // called it; the art layer keeps whichever of the summoner's marks the Pawn's
  // own palette has a colour for.
  const worn: Summoner = { speciesId: caller.scoba.speciesId };
  if (caller.scoba.tint) worn.tint = caller.scoba.tint;
  if (caller.scoba.shiny) worn.shiny = true;
  scoba.summoner = worn;
  const [c] = makeCombatants([scoba]);
  if (!c) return;
  c.summoned = true;
  c.pawn = true;
  if (st.ez && side === 0) grantEz(c);
  const index = st.teams[side].length;
  st.teams[side].push(c);
  st.active[side][slot] = index;
  ctx.events.push({
    text: `${displayName(caller.scoba)} calls up ${displayName(scoba)}!`,
    kind: "summon",
    at: { side, index },
    by: callerRef,
  });
  if (ctx.depth < MAX_TRIGGER_DEPTH) {
    fire({ ...ctx, depth: ctx.depth + 1 }, { side, index }, { on: "switch-in" }, null);
  }
}

function grantItem(ctx: Ctx, side: 0 | 1, item: string, count: number): void {
  ctx.st.items[side][item] = (ctx.st.items[side][item] ?? 0) + count;
  ctx.events.push({ text: `Found ${count} ${item}.`, kind: "info" });
}

/** Battle items on hand for a side: what it won here, plus the bag. */
export function itemsOnHand(st: BattleState, side: 0 | 1, item: string, bag: number): number {
  return (st.items[side][item] ?? 0) + bag;
}

/** Spends a battle item, taking what was won here before touching the bag. */
export function spendItem(st: BattleState, side: 0 | 1, item: string): "battle" | "bag" {
  const held = st.items[side][item] ?? 0;
  if (held > 0) {
    st.items[side][item] = held - 1;
    return "battle";
  }
  return "bag";
}

// --- turn resolution ---

/**
 * A round is a set of choices, not a sequence. Two clients in a co-op battle
 * each ask about their own character first, so they hand the same round in
 * different orders; the turn rng is consumed once per acting choice, so an
 * unsorted round would give the two of them different tie-breaks and desync
 * everything after it. Sorting by side and slot is a total order, since no
 * slot ever gets two choices.
 */
function canonicalOrder(choices: Choice[]): Choice[] {
  return [...choices].sort((a, b) => a.side - b.side || a.slot - b.slot);
}

export function resolveTurn(st: BattleState, unordered: Choice[]): BattleEvent[] {
  if (st.winner !== -1 || st.outcome !== "") return [{ text: "The battle is over.", kind: "info" }];
  const choices = canonicalOrder(unordered);
  for (const c of choices) {
    const err = choiceError(st, c);
    if (err) throw new Error(`illegal choice from side ${c.side} slot ${c.slot}: ${err}`);
  }
  const rng = turnRng(st);
  const events: BattleEvent[] = [];
  st.turn += 1;
  const ctx: Ctx = { st, events, rng, depth: 0 };

  // Fleeing ends the battle before anything else happens.
  if (choices.some((c) => c.kind === "flee")) {
    st.outcome = "fled";
    events.push({ text: "Got away safely.", kind: "flee" });
    return events;
  }

  forEachStanding(st, (ref) => fire(ctx, ref, { on: "turn-start" }, null));

  for (const c of choices) {
    if (c.kind !== "block") continue;
    const user = combatant(st, c.side, c.slot);
    if (!user || user.fainted) continue;
    user.blocking = true;
    const braceRef = refOf(st, user);
    events.push({ text: `${displayName(user.scoba)} braces.`, kind: "block", at: braceRef ?? undefined });
    const ref = braceRef;
    if (ref) fire(ctx, ref, { on: "block" }, null);
  }

  for (const c of choices) {
    if (c.kind !== "catch") continue;
    // A snare is thrown at a Scoba, never at somebody's Pawn.
    const targetSlot = (st.active[1][0] ?? -1) >= 0 ? 0 : 1;
    const target = combatant(st, 1, targetSlot);
    if (!target || target.fainted) continue;
    events.push({ text: "Threw a snare!", kind: "catch" });
    if (rng() < catchChance(target)) {
      st.outcome = "caught";
      events.push({ text: `${displayName(target.scoba)} was caught!`, kind: "catch" });
      return events;
    }
    events.push({ text: `${displayName(target.scoba)} broke free!`, kind: "info" });
  }

  for (const c of choices) {
    if (c.kind !== "switch") continue;
    const leaving = combatant(st, c.side, c.slot);
    if (leaving) leaving.statuses = onSwitchOut(leaving.statuses);
    st.active[c.side][c.slot] = c.benchIndex;
    const sw = st.teams[c.side][c.benchIndex]!;
    events.push({
      text: `${displayName(sw.scoba)} joins the fight.`,
      kind: "switch",
      at: { side: c.side, index: c.benchIndex },
    });
    fire(ctx, { side: c.side, index: c.benchIndex }, { on: "switch-in" }, null);
  }

  const acting = choices.filter((c) => c.kind === "spell" || c.kind === "attack");
  const ordered = acting
    .map((c) => {
      const user = combatant(st, c.side, c.slot);
      return { c, spd: user ? combatantStats(user).spd : 0, tie: rng() };
    })
    .sort((a, b) => b.spd - a.spd || b.tie - a.tie)
    .map((o) => o.c);

  for (const c of ordered) {
    if (st.winner !== -1) break;
    if (c.kind !== "spell" && c.kind !== "attack") continue;
    const user = combatant(st, c.side, c.slot);
    if (!user || user.fainted) continue;
    const userRef = refOf(st, user);
    if (!userRef) continue;

    const move = c.kind === "spell" ? MOVES[c.moveId] ?? null : null;
    if (c.kind === "spell" && move) {
      user.mana -= moveCost(user.scoba, c.moveId);
      if (move.cooldown > 0) user.cds[c.moveId] = move.cooldown + 1;
      events.push({
        text: `${displayName(user.scoba)} cast ${move.name}!`,
        kind: "spell", at: userRef, moveId: move.id, mana: user.mana,
      });
    } else {
      events.push({ text: `${displayName(user.scoba)} attacks!`, kind: "spell", at: userRef });
    }

    // Each spec is resolved once and reused, so a move's own hit and its
    // effects agree on which Scoba "target 1" meant.
    const specs = specsFor(c);
    const hits = specs.map((spec, i) => resolveTargets(st, userRef, spec, c.picks[i] ?? null, rng));

    applyPrimary(ctx, userRef, move, hits[0] ?? []);
    for (const effect of move?.effects ?? []) applyMoveEffect(ctx, userRef, effect, hits);

    // Whoever the action was aimed at is the far side of it, so a passive
    // watching for a basic attack can leave a mark on what was struck.
    const struck = hits[0]?.[0] ?? null;
    fire(ctx, userRef, c.kind === "spell" ? { on: "use-ability" } : { on: "basic-attack" }, struck);
  }

  endOfTurn(ctx);
  // Catches a battle that opened with a side already down, since nothing
  // fainted this turn to notice it.
  checkWipe(ctx);
  return events;
}

/** The move's own hit or heal, on the Scobas its first spec resolved to. */
function applyPrimary(ctx: Ctx, userRef: TargetRef, move: Move | null, targets: TargetRef[]): void {
  const user = combatantAt(ctx.st, userRef);
  if (!user) return;
  if (move && move.kind === "utility") return;
  if (targets.length === 0) {
    ctx.events.push({ text: "But there was no target...", kind: "info" });
    return;
  }
  if (move && move.kind === "heal") {
    for (const ref of targets) {
      const t = combatantAt(ctx.st, ref);
      if (t) heal(ctx, ref, combatantMaxHp(t) * move.scale);
    }
    return;
  }
  for (const ref of targets) {
    const target = combatantAt(ctx.st, ref);
    if (!target || target.fainted) continue;
    const { dmg, eff } = damageOf(user, target, move, fieldEffects(ctx.st.fields[userRef.side]));
    const note = eff > 1 ? " Super effective!" : eff < 1 ? " Not very effective." : "";
    dealDamage(ctx, ref, dmg, {
      element: move ? move.type : "plain",
      category: move ? (move.kind === "physical" ? "physical" : "magic") : "physical",
      damageClass: "attack",
      triggersOnHit: true,
      source: userRef,
      note,
      moveId: move?.id,
    });
  }
}

function applyMoveEffect(ctx: Ctx, userRef: TargetRef, effect: MoveEffect, hits: TargetRef[][]): void {
  const group = (i: number): TargetRef[] => hits[i] ?? [];
  switch (effect.kind) {
    case "status":
      for (const ref of group(effect.target)) inflict(ctx, ref, effect.status, userRef);
      break;
    case "damage": {
      const user = combatantAt(ctx.st, userRef);
      if (!user) break;
      for (const ref of group(effect.target)) {
        dealDamage(ctx, ref, Math.max(1, Math.floor(combatantStats(user).str * effect.scale)), {
          element: "plain",
          category: "physical",
          damageClass: "attack",
          triggersOnHit: true,
          source: userRef,
        });
      }
      break;
    }
    case "heal":
      for (const ref of group(effect.target)) {
        const t = combatantAt(ctx.st, ref);
        if (t) heal(ctx, ref, combatantMaxHp(t) * effect.frac);
      }
      break;
    case "transfer": {
      // Taken from one target and spent on the others, so a two-target move
      // reads as "draw from this one, land it on that one".
      let pool = 0;
      for (const ref of group(effect.from)) {
        const src = combatantAt(ctx.st, ref);
        if (!src || src.fainted) continue;
        const take = Math.max(1, Math.floor(src.hp * effect.frac));
        pool += take;
        dealDamage(ctx, ref, take, {
          element: "plain",
          category: "true",
          damageClass: "status",
          triggersOnHit: false,
          source: userRef,
          note: " (drawn)",
        });
      }
      if (pool <= 0) break;
      const dest = group(effect.to);
      if (dest.length === 0) break;
      const each = Math.max(1, Math.floor(pool / dest.length));
      for (const ref of dest) {
        if (effect.deliver === "heal") heal(ctx, ref, each);
        else {
          dealDamage(ctx, ref, each, {
            element: "plain",
            category: "true",
            damageClass: "attack",
            triggersOnHit: true,
            source: userRef,
          });
        }
      }
      break;
    }
    case "cleanse":
      for (const ref of group(effect.target)) cleanse(ctx, ref, effect.polarity);
      break;
    case "copy-statuses": {
      const from = group(effect.from)[0];
      if (!from) break;
      for (const ref of group(effect.to)) copyStatuses(ctx, from, ref);
      break;
    }
    case "summon":
      summon(ctx, userRef, effect.species, effect.level);
      break;
    case "grant-item":
      grantItem(ctx, userRef.side, effect.item, effect.count);
      break;
  }
}

function forEachStanding(st: BattleState, fn: (ref: TargetRef) => void): void {
  for (const side of [0, 1] as const) {
    for (const slot of ALL_SLOTS) {
      const index = st.active[side][slot] ?? -1;
      if (index >= 0 && !st.teams[side][index]?.fainted) fn({ side, index });
    }
  }
}

/**
 * Mana regen for actives, end-of-turn statuses (which is where an ability's
 * healing lives now), then cooldowns and durations for everyone and block
 * wearing off.
 */
function endOfTurn(ctx: Ctx): void {
  const st = ctx.st;
  if (st.winner !== -1) return;
  // Pawns draw on the same bar everything else does, which is what lets one
  // save up for a spell that costs the whole of it.
  forEachStanding(st, (ref) => {
    const c = combatantAt(st, ref);
    if (!c || c.fainted) return;
    c.mana = Math.min(MAX_MANA, c.mana + MANA_PER_TURN);
  });

  forEachStanding(st, (ref) => fire(ctx, ref, { on: "turn-end" }, null));
  if (st.winner !== -1) return;
  applyAttrition(ctx);
  if (st.winner !== -1) return;

  for (const side of [0, 1] as const) {
    for (const c of st.teams[side]) {
      for (const id of Object.keys(c.cds)) {
        if (c.cds[id]! > 0) c.cds[id]! -= 1;
      }
      c.blocking = false;
      c.statuses = tickDurations(c.statuses);
      c.hp = Math.min(c.hp, combatantMaxHp(c));
    }
  }
  tickFields(ctx);
}

/**
 * Runs the fields down a turn and says so for any that lifted. Two sides that
 * came out from under the same field on the same turn are one line, since one
 * Scoba laying it over both is how they usually got there.
 */
function tickFields(ctx: Ctx): void {
  const st = ctx.st;
  const lifted = new Map<string, (0 | 1)[]>();
  for (const side of [0, 1] as const) {
    const was = st.fields[side];
    if (!was) continue;
    st.fields[side] = tickField(was);
    if (st.fields[side]) continue;
    lifted.set(was.id, [...(lifted.get(was.id) ?? []), side]);
  }
  for (const [id, sides] of lifted) {
    ctx.events.push({
      text: FIELDS[id]?.lifts ?? `The ${FIELDS[id]?.name ?? id} lifts.`,
      kind: "field",
      field: { id: null, sides },
    });
  }
}

/**
 * A fight that will not end starts ending itself. Every active Scoba pays a
 * growing share of its pool, slowest first, and bracing does not help: the
 * point is that stalling is the thing being punished.
 */
function applyAttrition(ctx: Ctx): void {
  const st = ctx.st;
  const frac = attritionFrac(st.turn);
  if (frac <= 0) return;
  if (st.turn === ATTRITION_AFTER + 1) {
    ctx.events.push({ text: "The fight has dragged on. Everyone is flagging.", kind: "info" });
  }
  const order: { ref: TargetRef; spd: number }[] = [];
  forEachStanding(st, (ref) => {
    const c = combatantAt(st, ref);
    if (c) order.push({ ref, spd: combatantStats(c).spd });
  });
  // Slowest first, so whoever acts last also pays first. Ties fall to team
  // order rather than a roll, so two clients agree without spending rng.
  order.sort((a, b) => a.spd - b.spd || a.ref.side - b.ref.side || a.ref.index - b.ref.index);
  for (const { ref } of order) {
    if (st.winner !== -1) return;
    const c = combatantAt(st, ref);
    if (!c || c.fainted) continue;
    ctx.events.push({ text: `${displayName(c.scoba)} is worn down.`, kind: "status", at: ref });
    dealDamage(ctx, ref, Math.max(1, Math.floor(combatantMaxHp(c) * frac)), {
      element: "plain",
      category: "true",
      damageClass: "status",
      triggersOnHit: false,
      source: null,
      ignoresBlock: true,
    });
  }
}

export function displayName(s: ScobaInstance): string {
  return s.nickname ?? SPECIES[s.speciesId]?.name ?? s.speciesId;
}

/** What a combatant is carrying, collapsed for display: "Fire x2, Rage x3". */
export interface StatusMark {
  id: string;
  name: string;
  stacks: number;
  /** Turns left; -1 is indefinite. */
  turnsLeft: number;
  /** Charges left; -1 is unlimited. */
  chargesLeft: number;
}

export function statusSummary(c: Combatant): StatusMark[] {
  const out: StatusMark[] = [];
  for (const inst of c.statuses) {
    if (STATUSES[inst.id]?.innate) continue;
    const found = out.find((o) => o.id === inst.id);
    if (found) {
      found.stacks += inst.stacks;
      found.turnsLeft = Math.max(found.turnsLeft, inst.turnsLeft);
      found.chargesLeft = Math.max(found.chargesLeft, inst.chargesLeft);
      continue;
    }
    out.push({
      id: inst.id,
      name: statusName(inst.id),
      stacks: inst.stacks,
      turnsLeft: inst.turnsLeft,
      chargesLeft: inst.chargesLeft,
    });
  }
  return out;
}

/** The menu a target spec offers, for the picker to draw. */
export function targetOptions(st: BattleState, user: TargetRef, spec: TargetSpec): TargetRef[] {
  return candidates(st, user, spec.mode);
}

export { needsPick };

/** Digest for comparing two clients' states. Combatants are identified by
 * team index because the protocol fixes team order at battle start. */
export function stateHash(st: BattleState): string {
  const parts: string[] = [
    `t${st.turn}`,
    `w${st.winner}`,
    `o${st.outcome}`,
    `s${st.slotOwner[0] ?? "-"}${st.slotOwner[1] ?? "-"}`,
  ];
  for (const side of [0, 1] as const) {
    const f = st.fields[side];
    parts.push(`f${f ? `${f.id}:${f.turnsLeft}` : "-"}`);
    parts.push(`a${st.active[side].join(",")}`);
    st.teams[side].forEach((c, i) => {
      const cds = Object.entries(c.cds).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).sort().join(",");
      const sts = c.statuses.map((s) => `${s.id}:${s.stacks}:${s.turnsLeft}:${s.chargesLeft}`).sort().join(",");
      parts.push(`${side}.${i}:${c.hp}/${c.mana}${c.blocking ? "b" : ""}${c.fainted ? "x" : ""}[${cds}]{${sts}}`);
    });
  }
  return String(hashSeed(parts.join("|")));
}
