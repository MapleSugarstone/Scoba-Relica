// Deterministic battle engine (1v1 wild fights, 2v2 doubles, and the co-op
// fights where the two characters hold a slot each). Both clients replay the
// same seed and choice log, so a peer's state can be re-derived and checked
// rather than trusted.
//
// Combat rules: every Scoba starts a battle with 40 mana, gains 20 at end of
// turn (cap 100), and spends mana on spells. Some spells have a cooldown and
// a starting cooldown. Innate actions: Block (halve all damage taken this
// turn) and a basic attack (typeless physical, see `basicPower`). Physical
// damage is mitigated by Defense (+1% effective HP per point), magical by
// Resistance. Same-type spells deal 1.5x, super effective 2x, resisted 0.5x.
//
// Every hit in the battle, whatever it came from, goes through `dealDamage`.
// That is the one place immunity, vulnerability, blocking, faints and the
// on-hit and kill status triggers are handled, so a status tick and a spell
// cannot drift apart in how they land.
import type { ScobaInstance, Summoner } from "./scoba";
import {
  MAX_LEVEL, MAX_MANA, inheritFromCaller, moveCost, scobaTypes, statsAt, makeWild,
  passiveStatuses,
} from "./scoba";
import {
  HYPER_FORM, MOVES, SPECIES, abilityStatuses, firstStep, grantedMoves,
  moveTypes, typesEffectiveness, type Move,
} from "./species";
import { BLACKJACK, DECK, deckIndex, type Card, type CardFace } from "./cards";
import { STAT_NAMES, type ElementType, type StatName, type Stats } from "./types";
import type { Rng } from "./rng";
import { mulberry32, hashSeed, rngFrom } from "./rng";
import {
  FIELDS,
  STATUSES,
  applyStatus,
  continuousEffects,
  fieldEffects,
  foldStatEffects,
  isContinuous,
  newField,
  newStatus,
  boostFrom,
  isRooted,
  onSwitchOut,
  rootedBy,
  stacksOf,
  statusName,
  tickDurations,
  ticksThisTurn,
  tickField,
  triggerMatches,
  wardAgainst,
  type Basis,
  type ChanceColorChange,
  type DamageCategory,
  type DamageClass,
  type FieldEffect,
  type FieldInstance,
  type FieldScope,
  type StatusDef,
  type StatusEffect,
  type ReadEffect,
  type StatusInstance,
  type StatusPolarity,
  type Step,
  type TriggerEvent,
  type Who,
  HYPER_FLAT,
  HYPER_SCALE,
} from "./status";
import { hitCategory } from "./script/read";
import { deriveMove } from "./rewrite";
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
/** What entering Hyper-Mode costs. A Scoba enters once and never leaves. */
export const HYPER_COST = 60;
export { HYPER_SCALE, HYPER_FLAT };
/**
 * What entering Hyper-Mode is worth, per stat.
 *
 * Worked out from the Scoba's own line rather than from what it is carrying at
 * the time, so the mode is worth the same whenever it is entered. Read off the
 * battle instead and a Scoba that had been worn down would get less for it
 * exactly when it needed more, and one that had stacked a buff would get paid
 * twice for it.
 */
export function hyperBonus(base: Stats): Stats {
  const out = {} as Stats;
  for (const name of STAT_NAMES) out[name] = boostFrom(HYPER_SCALE, HYPER_FLAT, base[name]);
  return out;
}
/**
 * What a basic attack hits for before Defense: a flat floor, a point a level,
 * and most of the caster's Strength. The floor is what makes it worth taking
 * on a Scoba with no Strength to speak of, which is every caster with an empty
 * bar and nothing else left to do.
 */
export const BASIC_BASE = 10;
export const BASIC_PER_LEVEL = 1;
export const BASIC_STR_SCALE = 0.9;

/** What a basic attack scales to for this Scoba, before any mitigation. */
export function basicPower(level: number, str: number): number {
  return BASIC_BASE + BASIC_PER_LEVEL * level + str * BASIC_STR_SCALE;
}

/**
 * What a defence multiplies an incoming hit by. Defense reads against a
 * physical hit and Resistance against a magical one, and either can be driven
 * under nothing.
 *
 * Armour of nothing changes nothing, 100 halves a hit and 300 quarters it. A
 * negative is the same curve mirrored: it adds what the same amount of armour
 * would have taken off, so -100 puts half again on top. It approaches double
 * and never passes it, so no amount of stripping turns one hit into a whole
 * pool.
 */
export function mitigation(armor: number): number {
  return armor >= 0 ? 100 / (100 + armor) : 2 - 100 / (100 - armor);
}
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
  /** Moves it has already spent its one cast of. */
  spent: string[];
  /** In Hyper-Mode, which it entered once and stays in. */
  hyper?: boolean;
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
  /** Moves a step has put in a slot, by slot index, for this battle only. */
  swapped?: Record<number, string>;
  /**
   * Moves a step has handed over on top of the four it holds, for this battle
   * only. Offered after the slots, beside a move an ability grants.
   */
  given?: string[];
  /** Costumes a step has put it in, for the rest of the battle. */
  worn?: string[];
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
  /**
   * Enters Hyper-Mode. It resolves ahead of every switch, which is what lets a
   * mode that pins the field catch a Scoba trying to leave it.
   */
  | { kind: "hyper"; side: 0 | 1; slot: Slot }
  | { kind: "catch"; side: 0 | 1; slot: Slot }
  | { kind: "flee"; side: 0 | 1; slot: Slot }
  | { kind: "pass"; side: 0 | 1; slot: Slot };

export interface BattleEvent {
  text: string;
  kind: "spell" | "hit" | "faint" | "switch" | "heal" | "block" | "catch" | "flee" | "win" | "info"
  | "status" | "summon" | "field" | "hyper" | "card"
  /** Something drawn or heard that a step asked for, with no line in the log. */
  | "show";
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
  /**
   * The card being thrown or dealt, as it looks, and what the hand stands at
   * once it is dealt.
   */
  face?: CardFace;
  count?: number;
  /** The status a status line is about, for the sound it lands with. */
  status?: string;
  /** The sample a hit or a heal lands with, where its step names one. */
  sound?: string;
  /** For a `show` event: the step that asked for it, and who it reaches. */
  visual?: VisualStep;
  to?: TargetRef[];
}

/** The steps that change only what is drawn and heard. */
export type VisualStep = Extract<Step, { kind: "motion" | "throw" | "show" | "sound" | "wait" | "wear" }>;

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
      spent: [],
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

/**
 * The court closes ranks at the end of a turn: the Pawn marks are numbered
 * from the one nearest the Scobas outward, a new Pawn takes the first empty
 * one, and a Pawn standing behind an empty one steps forward into it, so the
 * row is always filled from the Scobas out.
 */
function closeRanks(st: BattleState, side: 0 | 1): void {
  const marks = ALL_SLOTS.filter(isPawnSlot);
  const standing = marks.map((slot) => st.active[side][slot] ?? -1).filter((i) => i >= 0);
  marks.forEach((slot, i) => {
    st.active[side][slot] = standing[i] ?? -1;
  });
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
function readEffects(c: Combatant, field: FieldEffect[]): ReadEffect[] {
  const out = continuousEffects(c.statuses);
  for (const effect of field) out.push({ effect, stacks: 1, power: 0 });
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

/**
 * Every move a combatant can pick this turn: the four it holds, then whatever
 * its abilities hand it. A granted move is never in a slot, so it neither
 * crowds the set out nor counts as one its line does not learn.
 */
export function castableMoves(c: Combatant): string[] {
  const sp = SPECIES[c.scoba.speciesId];
  const granted = sp ? grantedMoves(sp, c.scoba.secondaryAbility) : [];
  const held = heldMoves(c);
  // Whatever a step handed over goes after the lot, so it reads as one more
  // thing offered rather than as something a slot lost.
  const out = [...held, ...granted.filter((m) => !held.includes(m))];
  for (const id of c.given ?? []) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * The four a combatant is holding right now. A step can put another move in a
 * slot for as long as the battle lasts, and that is held on the combatant
 * rather than written onto the Scoba, because what it carries out of the fight
 * has not changed.
 */
export function heldMoves(c: Combatant): string[] {
  if (!c.swapped) return c.scoba.moves;
  return c.scoba.moves.map((id, i) => c.swapped?.[i] ?? id);
}

/**
 * What casting a move costs this combatant. A move a step handed over for the
 * battle costs what it says, since it was never bred into the line and is gone
 * when the fight ends. Anything else costs what it costs the Scoba.
 */
export function castCost(c: Combatant, moveId: string): number {
  const handed = (c.given ?? []).includes(moveId) || Object.values(c.swapped ?? {}).includes(moveId);
  return handed ? MOVES[moveId]?.manaCost ?? 0 : moveCost(c.scoba, moveId);
}

export function moveReady(c: Combatant, moveId: string): { ok: boolean; why?: string } {
  const move = MOVES[moveId];
  if (!move) return { ok: false, why: "Unknown move." };
  if (move.oncePerBattle && c.spent.includes(moveId)) return { ok: false, why: "Already used this battle." };
  if ((c.cds[moveId] ?? 0) > 0) return { ok: false, why: `On cooldown (${c.cds[moveId]}).` };
  if (c.mana < castCost(c, moveId)) return { ok: false, why: "Not enough mana." };
  return { ok: true };
}

/**
 * The costumes a combatant is currently seen in: whatever its steps put it in,
 * and Hyper-Mode. Both last as long as the battle does, so a Scoba is drawn
 * with its cherry again the next time it walks out.
 */
export function formsOf(c: Combatant): string[] {
  const out = [...(c.worn ?? [])];
  if (c.hyper) out.push(HYPER_FORM);
  return out;
}

/** Why this Scoba cannot go Hyper right now, or null if it can. */
export function hyperError(c: Combatant): string | null {
  const sp = SPECIES[c.scoba.speciesId];
  if (!sp?.hyperAbility) return "This Scoba has no Hyper-Mode.";
  if (c.hyper) return "Already in Hyper-Mode.";
  if (c.mana < HYPER_COST) return `Costs ${HYPER_COST} mana.`;
  return null;
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
    // A rooted Scoba stays where it is. Checked before the bench, since what
    // stops the switch is the one leaving rather than the one coming in.
    const leaving = combatant(st, c.side, c.slot);
    if (leaving && !leaving.fainted && isRooted(leaving.statuses)) {
      return `${rootedBy(leaving.statuses) ?? "Something"} holds it in place.`;
    }
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
  if (c.kind === "hyper") return hyperError(user);
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
    if (!castableMoves(user).includes(c.moveId)) return "Scoba does not know that spell.";
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
  /** The sample it lands with. */
  sound?: string;
}

type HitStep = Extract<Step, { kind: "hit" }>;

/** An attack, and the move it is part of where it is part of one. */
interface Attack {
  step: HitStep;
  move: Move | null;
}

/** The elements an attack is read as: what its step names, then its move's, then Plain. */
function attackTypes(a: Attack): ElementType[] {
  if (a.step.element) return [a.step.element];
  return a.move ? moveTypes(a.move) : ["plain"];
}

/** What one attack comes to against one target. A null attack is a basic attack. */
function damageOf(
  user: Combatant,
  target: Combatant,
  attack: Attack | null,
  field: FieldEffect[],
): { dmg: number; eff: number } {
  const uStats = combatantStats(user);
  const tStats = combatantStats(target);
  let dmg: number;
  let eff = 1;
  if (attack === null) {
    dmg = basicPower(user.scoba.level, uStats.str);
    dmg *= mitigation(tStats.def);
  } else if (attack.step.perLevel !== undefined) {
    // Flat damage is the number and nothing else: no stat, no same-type bonus,
    // no chart and no mitigation. What it buys is a hit you can count on.
    dmg = attack.step.perLevel * user.scoba.level;
  } else {
    dmg = 0;
    for (const s of attack.step.scaling) dmg += uStats[s.stat] * s.scale;
    const types = attackTypes(attack);
    // The Scoba's own elements rather than its species', since a bred one may
    // carry a second it took from its father.
    const own = scobaTypes(user.scoba);
    if (types.some((t) => own.includes(t))) dmg *= 1.5;
    eff = typesEffectiveness(types, scobaTypes(target.scoba));
    dmg *= eff;
    // A two-element move is powered up by whichever of its elements the
    // caster and the field have something to say about.
    dmg *= types.reduce((mult, t) => mult * elementPower(user, t, field), 1);
    dmg *= mitigation(hitCategory(attack.step) === "physical" ? tStats.def : tStats.res);
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
  const hit = firstStep(move, "hit");
  const mend = firstStep(move, "heal");
  const category: DamageCategory = hit && hitCategory(hit) === "physical" ? "physical" : "magic";
  if (move.kind === "heal" && mend) {
    const off = mend.basis === "source-mag" ? "mag" : mend.basis === "source-str" ? "str" : null;
    return {
      element: move.type, category,
      stat: off === "mag" ? "mag" : null,
      scale: mend.frac, damage: null, eff: 1,
      heal: Math.floor(basisOf(st, mend.basis, userRef, userRef) * mend.frac),
    };
  }
  if (!hit) {
    return { element: move.type, category, stat: null, scale: 0, damage: null, eff: 1, heal: null };
  }
  const stat: StatName | null = hit.scaling[0]?.stat ?? null;
  const ref = targetRef ?? firstStanding(st, userRef.side === 0 ? 1 : 0);
  const target = ref ? combatantAt(st, ref) : null;
  // Flat damage reads off the caster's level, so it has a number to show even
  // with nothing on the far side to measure against.
  if (hit.perLevel !== undefined) {
    return {
      element: move.type, category, stat: null, scale: 0,
      damage: hit.perLevel * user.scoba.level, eff: 1, heal: null,
    };
  }
  const scale = hit.scaling[0]?.scale ?? 0;
  if (!target) {
    return { element: move.type, category, stat, scale, damage: null, eff: 1, heal: null };
  }
  const { dmg, eff } = damageOf(user, target, { step: hit, move }, fieldEffects(st.fields[userRef.side]));
  return { element: move.type, category, stat, scale, damage: dmg, eff, heal: null };
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
    ...(meta.sound !== undefined ? { sound: meta.sound } : {}),
  });

  if (meta.triggersOnHit && ctx.depth < MAX_TRIGGER_DEPTH) {
    const deeper = { ...ctx, depth: ctx.depth + 1 };
    // A basic attack names no move, which is what tells a spell trigger from
    // the plain swing that carries the same category.
    const spell = meta.moveId !== undefined;
    fire(deeper, targetRef, { on: "hit", category: meta.category, element: meta.element, spell }, meta.source);
    if (meta.source) {
      fire(deeper, meta.source, { on: "deal", category: meta.category, element: meta.element, spell }, targetRef);
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

/** One hit that has landed, waiting for what it sets off. */
interface Landed {
  at: TargetRef;
  meta: HitMeta;
  dealt: number;
}

/**
 * Lands one hit and stops, without running anything it set off.
 *
 * Everything up to and including the HP coming off is here. Everything the
 * loss provokes is left to `reactTo`, so a move that reaches several Scobas
 * can take the HP off all of them before any of them answers.
 */
function landDamage(ctx: Ctx, targetRef: TargetRef, raw: number, meta: HitMeta): Landed | null {
  const target = combatantAt(ctx.st, targetRef);
  if (!target || target.fainted) return null;
  const name = displayName(target.scoba);

  const field = fieldEffects(ctx.st.fields[targetRef.side]);
  if (immuneTo(target, meta.element, field)) {
    ctx.events.push({ text: `${name} is untouched by it.`, kind: "info", at: targetRef, by: meta.source ?? undefined });
    return null;
  }
  const ward = wardAgainst(target.statuses, meta.element);
  if (ward) {
    if (ward.chargesLeft > 0) ward.chargesLeft -= 1;
    target.statuses = target.statuses.filter((held) => held.chargesLeft !== 0);
    ctx.events.push({
      text: `${name} turns it aside.`,
      kind: "status", at: targetRef, by: meta.source ?? undefined,
    });
    return null;
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
    ...(meta.sound !== undefined ? { sound: meta.sound } : {}),
  });
  return { at: targetRef, meta, dealt: dmg };
}

/** What one landed hit sets off: the on-hit marks, the low-HP watch, the death. */
function reactTo(ctx: Ctx, hit: Landed): void {
  const target = combatantAt(ctx.st, hit.at);
  if (!target) return;
  const meta = hit.meta;
  if (meta.triggersOnHit && ctx.depth < MAX_TRIGGER_DEPTH) {
    const deeper = { ...ctx, depth: ctx.depth + 1 };
    // A basic attack names no move, which is what tells a spell trigger from
    // the plain swing that carries the same category.
    const spell = meta.moveId !== undefined;
    fire(deeper, hit.at, { on: "hit", category: meta.category, element: meta.element, spell }, meta.source);
    if (meta.source) {
      fire(deeper, meta.source, { on: "deal", category: meta.category, element: meta.element, spell }, hit.at);
    }
  }
  if (target.hp > 0) {
    const frac = target.hp / Math.max(1, combatantMaxHp(target));
    if (ctx.depth < MAX_TRIGGER_DEPTH) {
      fire({ ...ctx, depth: ctx.depth + 1 }, hit.at, { on: "hp-below", frac }, meta.source);
    }
  }
  if (target.hp <= 0 && !target.fainted) killed(ctx, hit.at, meta);
}

/**
 * One strike that reaches several Scobas at once.
 *
 * Every number is worked out before any of it lands, every hit lands before
 * anything answers, and only then does anything answer. Dealt one at a time
 * instead, the first Scoba to fall would have set off its passives, its
 * allies' and its killer's before the second was even struck, so a move that
 * hit a whole line landed on a field that its own first hit had already
 * changed.
 *
 * What answers, answers fastest first. A Scoba that acts before another in a
 * round reacts before it too, and ties fall to team order rather than a roll
 * so two clients agree without spending any.
 */
function dealTogether(
  ctx: Ctx,
  strikes: { at: TargetRef; raw: number; meta: HitMeta }[],
): void {
  const landed: Landed[] = [];
  for (const s of strikes) {
    const hit = landDamage(ctx, s.at, s.raw, s.meta);
    if (hit) landed.push(hit);
  }
  landed.sort((a, b) => {
    const sa = combatantAt(ctx.st, a.at);
    const sb = combatantAt(ctx.st, b.at);
    return (sb ? combatantStats(sb).spd : 0) - (sa ? combatantStats(sa).spd : 0)
      || a.at.side - b.at.side || a.at.index - b.at.index;
  });
  for (const hit of landed) {
    if (ctx.st.winner !== -1) return;
    reactTo(ctx, hit);
  }
}

/**
 * `from` names who is mending and with what, the way a hit names who struck.
 * The scene needs both: a heal thrown at an ally has to leave somebody's hands
 * and be drawn as the move it came from.
 */
function heal(
  ctx: Ctx, targetRef: TargetRef, amount: number,
  from?: { source?: TargetRef | null; moveId?: string; sound?: string },
): number {
  const target = combatantAt(ctx.st, targetRef);
  if (!target || target.fainted || amount <= 0) return 0;
  const max = combatantMaxHp(target);
  const given = Math.min(max - target.hp, Math.max(1, Math.floor(amount)));
  if (given <= 0) return 0;
  target.hp += given;
  ctx.events.push({
    text: `${displayName(target.scoba)} recovered ${given} HP.`,
    kind: "heal", at: targetRef, hp: target.hp,
    ...(from?.source ? { by: from.source } : {}),
    ...(from?.moveId ? { moveId: from.moveId } : {}),
    ...(from?.sound !== undefined ? { sound: from.sound } : {}),
  });
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
  return basisOf(ctx.st, basis, holderRef, from);
}

/**
 * What a share is measured against. `holder` is the Scoba the number lands on,
 * and `source` is who it comes from: the caster of a move, or whoever left a
 * status.
 */
function basisOf(st: BattleState, basis: Basis, holderRef: TargetRef, from: TargetRef | null): number {
  const holder = combatantAt(st, holderRef);
  const source = from ? combatantAt(st, from) : null;
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
    // A mark that landed this turn waits for the next one before it ticks.
    if (!ticksThisTurn(inst, event, ctx.st.turn)) continue;
    if (inst.chargesLeft > 0) inst.chargesLeft -= 1;
    const steps = def.effects.filter((e): e is Step => !isContinuous(e.kind));
    runSteps(ctx, {
      record: def.id, self: holderRef, source: inst.from ?? null, other,
      groups: [], alive: aliveNow(ctx.st), picked: null, card: null, draws: 0,
      status: { def, inst }, cast: null,
    }, steps);
  }
  holder.statuses = holder.statuses.filter((s) => s.chargesLeft !== 0);
}

// --- running steps ---

/** Everything a list of steps is run with. */
interface Run {
  /** The move or status the steps belong to. */
  record: string;
  /** The caster of a move, or the Scoba carrying a status. */
  self: TargetRef;
  /** Who a status came from, or the caster of a move. */
  source: TargetRef | null;
  /** Whoever was on the far side of a status's trigger. */
  other: TargetRef | null;
  /** A move's target groups, in the order its aims are written. */
  groups: TargetRef[][];
  /** Everyone standing as the steps began, for telling who has fallen since. */
  alive: Set<string>;
  /** The move a `pick-move` step picked, for the steps after it. */
  picked: string | null;
  /** The card a `draw-card` step drew, for the steps after it. */
  card: DrawnCard | null;
  /** How many cards these steps have drawn, so each draw rolls its own card. */
  draws: number;
  /** The status running these steps, where a status is. */
  status: { def: StatusDef; inst: StatusInstance } | null;
  /** The move being cast and what was paid for it, where a move is. */
  cast: { move: Move; paid: number } | null;
}

const refKey = (ref: TargetRef): string => `${ref.side}:${ref.index}`;

function aliveNow(st: BattleState): Set<string> {
  const out = new Set<string>();
  for (const side of [0, 1] as const) {
    st.teams[side].forEach((c, index) => {
      if (!c.fainted) out.add(refKey({ side, index }));
    });
  }
  return out;
}

/** Who a step reaches, before anyone who has fallen is left out. */
function whoRefs(ctx: Ctx, run: Run, who: Who): TargetRef[] {
  if (typeof who === "object") return run.groups[who.aim] ?? [];
  switch (who) {
    case "self": return [run.self];
    case "source": return run.source ? [run.source] : [];
    case "other": return run.other ? [run.other] : [];
    default: return teamOf(ctx.st, run.self, who);
  }
}

/** Every standing member of a team, or of both, relative to one Scoba. */
function teamOf(st: BattleState, selfRef: TargetRef, who: "allies" | "enemies" | "everyone" | "others"): TargetRef[] {
  const sides: (0 | 1)[] = who === "everyone" || who === "others"
    ? [0, 1]
    : [who === "allies" ? selfRef.side : (selfRef.side === 0 ? 1 : 0)];
  const out: TargetRef[] = [];
  for (const side of sides) {
    st.teams[side].forEach((c, index) => {
      if (c.fainted) return;
      if (who === "others" && sameRef({ side, index }, selfRef)) return;
      out.push({ side, index });
    });
  }
  return out;
}

/** Fills in `{self}`, `{target}` and `{picked}` in a line a step says. */
function fillIn(ctx: Ctx, run: Run, text: string): string {
  const nameAt = (ref: TargetRef | undefined): string => {
    const c = ref ? combatantAt(ctx.st, ref) : null;
    return c ? displayName(c.scoba) : "";
  };
  return text
    .replace(/\{self\}/g, nameAt(run.self))
    .replace(/\{target\}/g, nameAt(run.groups[0]?.[0] ?? run.other ?? undefined))
    .replace(/\{picked\}/g, run.picked ? MOVES[run.picked]?.name ?? run.picked : "");
}

/**
 * Runs steps in order. A `pick-move` that finds nothing ends the list it is in,
 * since everything after it is about the move it would have picked.
 */
function runSteps(ctx: Ctx, run: Run, steps: Step[]): void {
  for (const step of steps) {
    if (!runStep(ctx, run, step)) return;
  }
}

/** Runs one step, and says whether the list it is in goes on. */
function runStep(ctx: Ctx, run: Run, step: Step): boolean {
  const selfC = combatantAt(ctx.st, run.self);
  switch (step.kind) {
    case "motion":
    case "throw":
    case "show":
    case "sound":
    case "wait":
    case "wear": {
      if (step.kind === "wear") {
        for (const ref of whoRefs(ctx, run, step.who)) {
          const c = combatantAt(ctx.st, ref);
          if (c && !(c.worn ?? []).includes(step.form)) c.worn = [...(c.worn ?? []), step.form];
        }
      }
      const reach = step.kind === "throw" ? step.to : step.kind === "show" ? step.on
        : step.kind === "motion" || step.kind === "wear" ? step.who : "self";
      const to = whoRefs(ctx, run, reach).filter((ref) => combatantAt(ctx.st, ref)?.fainted === false);
      // A card is thrown as it was drawn, so the scene shows the card the hand
      // is about to be dealt rather than rolling one of its own.
      if (step.kind === "throw" && step.drawn && !run.card) return true;
      ctx.events.push({
        text: "", kind: "show", at: run.self, visual: step, to,
        ...(run.cast ? { moveId: run.cast.move.id } : {}),
        ...(step.kind === "throw" && step.drawn && run.card ? { face: run.card.face } : {}),
      });
      return true;
    }
    case "draw-card":
      run.card = drawCard(ctx.st, run.self, run.record, run.draws, step.changes);
      run.draws += 1;
      return true;
    case "hit": {
      const user = selfC;
      if (!user) return true;
      const group = whoRefs(ctx, run, step.to);
      if (group.length === 0) {
        if (run.cast) ctx.events.push({ text: "But there was no target...", kind: "info" });
        return true;
      }
      const move = run.cast?.move ?? null;
      const attack: Attack = { step, move };
      // Worked out against the field as it stands, before any of it lands, so a
      // Scoba struck second is struck by the same move the first one was.
      const field = fieldEffects(ctx.st.fields[run.self.side]);
      const element = step.element ?? move?.type ?? "plain";
      const strikes = group.flatMap((ref) => {
        const target = combatantAt(ctx.st, ref);
        if (!target || target.fainted) return [];
        const { dmg, eff } = damageOf(user, target, attack, field);
        const note = eff > 1 ? " Super effective!" : eff < 1 ? " Not very effective." : "";
        const meta: HitMeta = {
          element,
          category: hitCategory(step),
          damageClass: "attack",
          triggersOnHit: true,
          source: run.self,
          note,
          ...(move ? { moveId: move.id } : {}),
          ...(step.sound !== undefined ? { sound: step.sound } : {}),
        };
        return [{ at: ref, raw: dmg, meta }];
      });
      dealTogether(ctx, strikes);
      return true;
    }
    case "damage": {
      const d = step.damage;
      const inst = run.status?.inst;
      for (const ref of whoRefs(ctx, run, step.to)) {
        const target = combatantAt(ctx.st, ref);
        if (!target) continue;
        const power = d.snapshot && inst?.power !== undefined
          ? inst.power
          : basisValue(ctx, d.basis, ref, run.source) * d.frac;
        if (run.status) {
          ctx.events.push({ text: `${run.status.def.name} bites ${displayName(target.scoba)}.`, kind: "status", at: ref });
        }
        dealDamage(ctx, ref, Math.max(1, Math.floor(power)), {
          element: d.element,
          category: d.category,
          damageClass: d.damageClass,
          triggersOnHit: d.triggersOnHit,
          source: run.source,
          ...(step.sound !== undefined ? { sound: step.sound } : {}),
        });
      }
      return true;
    }
    case "heal": {
      const group = whoRefs(ctx, run, step.to);
      if (run.cast && group.length === 0) {
        ctx.events.push({ text: "But there was no target...", kind: "info" });
        return true;
      }
      for (const ref of group) {
        const amount = basisValue(ctx, step.basis, ref, run.source) * step.frac;
        heal(ctx, ref, run.cast ? Math.floor(amount) : amount, {
          ...(run.cast ? { source: run.self, moveId: run.cast.move.id } : {}),
          ...(step.sound !== undefined ? { sound: step.sound } : {}),
        });
      }
      return true;
    }
    case "inflict":
      for (const ref of whoRefs(ctx, run, step.on)) {
        // A status that hangs another one measures it from whoever left the
        // first, so a mark keeps naming the caster it came from as it spreads.
        inflict(ctx, ref, step.status, run.source ?? run.self, step.turns);
      }
      return true;
    case "cleanse":
      for (const ref of whoRefs(ctx, run, step.on)) cleanse(ctx, ref, step.polarity);
      return true;
    case "copy-marks": {
      const from = whoRefs(ctx, run, step.from)[0];
      if (!from) return true;
      for (const ref of whoRefs(ctx, run, step.to)) copyStatuses(ctx, from, ref);
      return true;
    }
    case "transfer": {
      // Taken from one group and spent on the other, so a two-target move reads
      // as "draw from this one, land it on that one".
      let pool = 0;
      for (const ref of whoRefs(ctx, run, step.from)) {
        const src = combatantAt(ctx.st, ref);
        if (!src || src.fainted) continue;
        const take = Math.max(1, Math.floor(src.hp * step.frac));
        pool += take;
        dealDamage(ctx, ref, take, {
          element: "plain",
          category: "true",
          damageClass: "status",
          triggersOnHit: false,
          source: run.self,
          note: " (drawn)",
        });
      }
      if (pool <= 0) return true;
      const dest = whoRefs(ctx, run, step.to);
      if (dest.length === 0) return true;
      const each = Math.max(1, Math.floor(pool / dest.length));
      for (const ref of dest) {
        if (step.deliver === "heal") heal(ctx, ref, each);
        else {
          dealDamage(ctx, ref, each, {
            element: "plain",
            category: "true",
            damageClass: "attack",
            triggersOnHit: true,
            source: run.self,
          });
        }
      }
      return true;
    }
    case "summon":
      summon(ctx, run.self, step.species, step.level);
      return true;
    case "grant-item":
      grantItem(ctx, run.self.side, step.item, step.count);
      return true;
    case "mana":
      for (const ref of whoRefs(ctx, run, step.on)) {
        const c = combatantAt(ctx.st, ref);
        if (!c) continue;
        const before = c.mana;
        c.mana = Math.min(MAX_MANA, c.mana + step.amount);
        if (c.mana === before) continue;
        ctx.events.push({
          text: `${displayName(c.scoba)} is brimming.`,
          kind: "status", at: ref, mana: c.mana,
        });
      }
      return true;
    case "field":
      setField(ctx, fieldScope(run.self, step.scope), step.field, run.self);
      return true;
    case "deal-card":
      if (!run.card) return true;
      for (const ref of whoRefs(ctx, run, step.to)) dealCard(ctx, run.self, ref, step.payoff, step.hand, run.card);
      return true;
    case "if": {
      const fell = whoRefs(ctx, run, step.fell).some((ref) =>
        run.alive.has(refKey(ref)) && combatantAt(ctx.st, ref)?.fainted === true);
      if (fell) runSteps(ctx, run, step.then);
      return true;
    }
    case "refund": {
      if (!run.cast || !selfC) return true;
      const { move, paid } = run.cast;
      selfC.mana = Math.min(MAX_MANA, selfC.mana + paid);
      delete selfC.cds[move.id];
      ctx.events.push({
        text: `${move.name} comes back around.`,
        kind: "status", at: run.self, mana: selfC.mana,
      });
      return true;
    }
    case "pick-move": {
      if (!selfC || selfC.fainted) return false;
      const pool = movePool(step.minCost, step.skipOncePerBattle);
      if (pool.length === 0) return false;
      const roll = rngFrom(pickLabel(ctx.st, run))();
      run.picked = pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))]!;
      return true;
    }
    case "change-move":
      if (run.picked) run.picked = deriveMove(run.picked, step.changes, step.key);
      return true;
    case "give-move": {
      const picked = run.picked;
      if (!picked) return true;
      for (const ref of whoRefs(ctx, run, step.to)) {
        const c = combatantAt(ctx.st, ref);
        if (!c) continue;
        if (step.slot === null) c.given = [picked];
        else c.swapped = { ...c.swapped, [step.slot]: picked };
        // What was just handed over is not on cooldown from what stood there before it.
        delete c.cds[picked];
      }
      return true;
    }
    case "say":
      ctx.events.push({ text: fillIn(ctx, run, step.text), kind: "info", at: run.self });
      return true;
  }
}

/** Every move a `pick-move` could land on, in an order both clients agree on. */
export function movePool(minCost: number, skipOncePerBattle: boolean): string[] {
  return Object.values(MOVES)
    .filter((m) => m.manaCost >= minCost && !(skipOncePerBattle && m.oncePerBattle) && !m.derived)
    .map((m) => m.id)
    .sort();
}

/** What a pick is rolled off: the battle seed, the turn, who picks, and what it is picking for. */
function pickLabel(st: BattleState, run: Run): string {
  return `${st.seed}:pick:${run.record}:${st.turn}:${run.self.side}:${run.self.index}`;
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

/**
 * How many times over a status is measured as it lands, off what whoever left
 * it is carrying. Only a status that stands long enough for the effect asks.
 */
function markPower(st: BattleState, from: TargetRef | null, def: StatusDef): number {
  const source = from ? combatantAt(st, from) : null;
  if (!source) return 1;
  let mult = 1;
  for (const { effect, stacks } of continuousEffects(source.statuses)) {
    if (effect.kind !== "mark-power" || (def.duration ?? 0) < effect.minTurns) continue;
    mult *= Math.pow(effect.mult, stacks);
  }
  return mult;
}

/** The damage step a status measures when it lands, wherever it is written. */
function snapshotStep(effects: StatusEffect[]): Extract<Step, { kind: "damage" }> | null {
  for (const e of effects) {
    if (e.kind === "damage" && e.damage.snapshot) return e;
    if (e.kind === "if") {
      const inner = snapshotStep(e.then);
      if (inner) return inner;
    }
  }
  return null;
}

/** Puts a status on a target, snapshotting its damage if it asks for that. */
export function inflict(
  ctx: Ctx, targetRef: TargetRef, statusId: string, from: TargetRef | null, turns?: number,
): void {
  const def = STATUSES[statusId];
  const target = combatantAt(ctx.st, targetRef);
  if (!def || !target || target.fainted) return;
  let power: number | undefined;
  if (def.power) {
    power = basisValue(ctx, def.power.basis, targetRef, from) * def.power.frac;
  } else {
    const dmg = snapshotStep(def.effects);
    if (dmg) {
      power = basisValue(ctx, dmg.damage.basis, targetRef, from) * dmg.damage.frac;
      // A flat share of the mark is measured off whoever left it, so the same
      // mark from a level 6 Scoba is worth a fifth of one from a level 30.
      const flat = dmg.damage.flatAtCeiling;
      const source = from ? combatantAt(ctx.st, from) : null;
      if (flat && source) power += (flat * source.scoba.level) / MAX_LEVEL;
    }
  }
  if (power !== undefined) {
    const mult = markPower(ctx.st, from, def);
    if (mult !== 1) power *= mult;
  }
  const inst = newStatus(statusId, from ?? undefined, power, ctx.st.turn);
  if (!inst) return;
  // What put it there can say how long it stands, over the mark's own clock.
  if (turns !== undefined) inst.turnsLeft = turns;
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
    status: statusId,
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
  inheritFromCaller(scoba, caller.scoba);
  // What it wears is settled where the pixels are. The sim only records who
  // called it; the art layer keeps whichever of the summoner's marks the Pawn's
  // own palette has a colour for.
  const worn: Summoner = { speciesId: caller.scoba.speciesId };
  if (caller.scoba.sire) worn.sire = caller.scoba.sire;
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

/**
 * Enters Hyper-Mode: 25 percent on every stat and then a flat 15, the line's
 * third passive turned on, and the same share of a bigger pool. A Scoba enters
 * once and stays in it for the rest of the battle.
 *
 * Turning the mode on counts as taking the field, so a Hyper passive that does
 * something the moment it comes up hangs it on `switch-in` like any other
 * arrival. Passives that already spent their charge walking on stay spent.
 */
function enterHyper(ctx: Ctx, side: 0 | 1, slot: Slot): void {
  const c = combatant(ctx.st, side, slot);
  if (!c || c.fainted || hyperError(c) !== null) return;
  const sp = SPECIES[c.scoba.speciesId]!;
  const before = combatantMaxHp(c);
  const share = before > 0 ? c.hp / before : 1;
  c.mana -= HYPER_COST;
  c.hyper = true;
  // The Scoba's own line, passives and all, which is what it would have had
  // walking in. Anything the fight has done to it since is left out.
  const basis = statsAt(c.scoba, true);
  for (const id of ["hyper", ...abilityStatuses(sp.hyperAbility!)]) {
    const inst = newStatus(id);
    if (!inst) continue;
    if (STATUSES[id]?.effects.some((e) => e.kind === "stat-boost")) inst.basis = basis;
    c.statuses.push(inst);
  }
  c.hp = Math.max(1, Math.round(combatantMaxHp(c) * share));
  const ref = refOf(ctx.st, c);
  ctx.events.push({
    text: `${displayName(c.scoba)} goes Hyper!`,
    kind: "hyper", at: ref ?? undefined, hp: c.hp, mana: c.mana,
  });
  if (ref) fire(ctx, ref, { on: "switch-in" }, null);
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

  // Ahead of every switch, because a mode that pins the field has to be able
  // to catch a Scoba on its way out.
  for (const c of choices) {
    if (c.kind !== "hyper") continue;
    enterHyper(ctx, c.side, c.slot);
  }

  for (const c of choices) {
    if (c.kind !== "switch") continue;
    const leaving = combatant(st, c.side, c.slot);
    // Whatever went up in the meantime gets its say: a Scoba rooted this turn
    // stays where it is, and the turn it meant to spend leaving is spent.
    if (leaving && !leaving.fainted && isRooted(leaving.statuses)) {
      events.push({
        text: `${displayName(leaving.scoba)} is stuck fast.`,
        kind: "info",
        at: refOf(st, leaving) ?? undefined,
      });
      continue;
    }
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
      const pri = c.kind === "spell" ? MOVES[c.moveId]?.priority ?? 0 : 0;
      return { c, pri, spd: user ? combatantStats(user).spd : 0, tie: rng() };
    })
    // Priority outranks Speed outright, so a fast Scoba never gets ahead of a
    // move that was written to go first.
    .sort((a, b) => b.pri - a.pri || b.spd - a.spd || b.tie - a.tie)
    .map((o) => o.c);

  for (const c of ordered) {
    if (st.winner !== -1) break;
    if (c.kind !== "spell" && c.kind !== "attack") continue;
    const user = combatant(st, c.side, c.slot);
    if (!user || user.fainted) continue;
    const userRef = refOf(st, user);
    if (!userRef) continue;

    const move = c.kind === "spell" ? MOVES[c.moveId] ?? null : null;
    const paid = move ? castCost(user, move.id) : 0;
    if (c.kind === "spell" && move) {
      user.mana -= paid;
      if (move.cooldown > 0) user.cds[c.moveId] = move.cooldown + 1;
      if (move.oncePerBattle && !user.spent.includes(move.id)) user.spent.push(move.id);
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

    if (move) {
      runSteps(ctx, {
        record: move.id, self: userRef, source: userRef, other: null,
        groups: hits, alive: aliveNow(st), picked: null, card: null, draws: 0,
        status: null, cast: { move, paid },
      }, move.cast);
    } else {
      basicAttack(ctx, userRef, hits[0] ?? []);
    }

    // Whoever the action was aimed at is the far side of it, so a passive
    // watching for a basic attack can leave a mark on what was struck.
    const struck = hits[0]?.[0] ?? null;
    fire(ctx, userRef, c.kind === "spell" ? { on: "use-ability" } : { on: "basic-attack" }, struck);
  }

  endOfTurn(ctx);
  for (const side of [0, 1] as const) closeRanks(st, side);
  // Catches a battle that opened with a side already down, since nothing
  // fainted this turn to notice it.
  checkWipe(ctx);
  return events;
}

/** A basic attack, on the Scobas its target resolved to. */
function basicAttack(ctx: Ctx, userRef: TargetRef, targets: TargetRef[]): void {
  const user = combatantAt(ctx.st, userRef);
  if (!user) return;
  if (targets.length === 0) {
    ctx.events.push({ text: "But there was no target...", kind: "info" });
    return;
  }
  const field = fieldEffects(ctx.st.fields[userRef.side]);
  const strikes: { at: TargetRef; raw: number; meta: HitMeta }[] = targets.flatMap((ref) => {
    const target = combatantAt(ctx.st, ref);
    if (!target || target.fainted) return [];
    const { dmg } = damageOf(user, target, null, field);
    return [{
      at: ref,
      raw: dmg,
      meta: {
        element: "plain",
        category: "physical",
        damageClass: "attack",
        triggersOnHit: true,
        source: userRef,
        note: "",
      },
    }];
  });
  dealTogether(ctx, strikes);
}

/** A card a step drew, and how it looks. */
export interface DrawnCard {
  card: Card;
  face: CardFace;
}

/**
 * The card a Scoba draws. One roll off the battle seed picks its place in the
 * deck, which is its drawing and its value at once, and one more roll each
 * decides every color change. Nothing about it is rolled where it is drawn on
 * screen, so both clients in a shared fight draw, throw and hold the same card.
 * `n` counts the draws the same steps have already made.
 */
export function drawCard(
  st: BattleState, by: TargetRef, record: string, n: number, changes: readonly ChanceColorChange[],
): DrawnCard {
  const rng = rngFrom(`${st.seed}:card:${st.turn}:${by.side}:${by.index}:${record}:${n}`);
  const card = DECK[deckIndex(rng())]!;
  const kept = changes.filter((c) => rng() < c.chance).map(({ from, to }) => ({ from, to }));
  return { card, face: { art: card.art, changes: kept } };
}

/**
 * Deals one card onto a hand and settles it. A hand that lands exactly on
 * twenty one pays out and clears. One that goes over busts and clears with
 * nothing, which is what makes a big card a risk rather than a bonus.
 */
function dealCard(
  ctx: Ctx, userRef: TargetRef, at: TargetRef, payoff: number, hand: string, drawn: DrawnCard,
): void {
  const target = combatantAt(ctx.st, at);
  const user = combatantAt(ctx.st, userRef);
  if (!target || !user || target.fainted) return;
  const { card, face } = drawn;
  const held = target.statuses.find((s) => s.id === hand);
  const count = (held?.stacks ?? 0) + card.value;
  ctx.events.push({
    text: `${displayName(target.scoba)} is dealt the ${card.label}.`,
    kind: "card",
    at,
    by: userRef,
    face,
    count: Math.min(count, BLACKJACK),
  });
  if (count === BLACKJACK) {
    // The hand pays out. Fortuna off Strength, the same as everything else it
    // throws, and the count goes with it.
    forgetHand(target, hand);
    const raw = Math.max(1, Math.floor(combatantStats(user).str * payoff));
    ctx.events.push({ text: `${displayName(target.scoba)} is holding ${BLACKJACK}!`, kind: "info", at });
    dealDamage(ctx, at, raw, {
      element: "fortuna",
      category: "physical",
      damageClass: "attack",
      triggersOnHit: true,
      source: userRef,
    });
    return;
  }
  if (count > BLACKJACK) {
    forgetHand(target, hand);
    ctx.events.push({
      text: `${displayName(target.scoba)} busts at ${count}.`,
      kind: "status",
      at,
    });
    return;
  }
  inflict(ctx, at, hand, userRef);
  const now = target.statuses.find((s) => s.id === hand);
  if (now) {
    now.stacks = count;
    now.face = { art: face.art, changes: face.changes.map((c) => ({ ...c })) };
  }
}

/** Takes a settled hand off, whether it paid out or busted. */
function forgetHand(target: Combatant, hand: string): void {
  target.statuses = target.statuses.filter((s) => s.id !== hand);
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
      c.statuses = tickDurations(c.statuses, st.turn);
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
      // A hand names the card on top of it, so two clients that drew different
      // cards or colors are caught even where the counts agree.
      const faceOf = (s: StatusInstance): string => (s.face
        ? `:${s.face.art}${s.face.changes.map((ch) => `/${ch.from}>${ch.to}`).join("")}`
        : "");
      const sts = c.statuses.map((s) => `${s.id}:${s.stacks}:${s.turnsLeft}:${s.chargesLeft}${faceOf(s)}`).sort().join(",");
      const spent = [...c.spent].sort().join(",");
      parts.push(`${side}.${i}:${c.hp}/${c.mana}${c.blocking ? "b" : ""}${c.fainted ? "x" : ""}${c.hyper ? "H" : ""}[${cds}]<${spent}>{${sts}}`);
    });
  }
  return String(hashSeed(parts.join("|")));
}
