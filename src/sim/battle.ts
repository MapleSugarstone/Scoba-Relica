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
  MAX_LEVEL, MAX_MANA, freshUid, inheritFromCaller, leanOnto, maxHp, moveCost, scobaTypes, statsAt, makeWild,
  passiveStatuses, speciesName,
} from "./scoba";
import {
  HYPER_FORM, MOVES, SPECIES, abilityStatuses, allSteps, firstStep, grantedMoves,
  moveTypes, typesEffectiveness, type Move,
} from "./species";
import { BLACKJACK, DECK, addToHand, deckIndex, type Card, type CardFace } from "./cards";
import { STAT_LABELS, STAT_NAMES, type ElementType, type StatName, type Stats } from "./types";
import type { Rng } from "./rng";
import { mulberry32, hashSeed, rngFrom } from "./rng";
import { logRound, recording } from "./replay";
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
  triggerFits,
  wardAgainst,
  softenOn,
  hyperShut,
  spellsShutBy,
  echoFrac,
  manaAt,
  powerCategory,
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
  selfWorth,
  worthReaches,
} from "./status";
import { hitCategory } from "./script/read";
import { deriveMove } from "./rewrite";
import {
  candidates,
  combatantAt,
  isPawnSlot,
  isTravelSlot,
  isFusionSlot,
  TRAVEL_SLOT,
  FUSION_SLOT,
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

export {
  ALL_SLOTS, FIELD_SLOTS, PAWN_SLOTS, SCOBA_SLOTS, TRAVEL_SLOT, FUSION_SLOT, isPawnSlot, isTravelSlot, isFusionSlot,
};

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

/** The armor a kind of damage meets on a Scoba: Defense, Resistance, or none for true damage. */
function armorAgainst(category: DamageCategory, target: Combatant): number {
  if (category === "true") return 0;
  const stats = combatantStats(target);
  return category === "physical" ? stats.def : stats.res;
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
  /** The turn it was called on, so its first turn is fought on the mana it arrived with. */
  calledOn?: number;
  /**
   * Standing on a Pawn slot. It fights like anything else on the field and is
   * aimed at like anything else, but it never switches, never fills a Scoba
   * slot, and never keeps a team alive on its own.
   */
  pawn?: boolean;
  /**
   * Standing in a time it does not belong to: the one that travelled, waiting
   * to take its seat back when the past has played out. It is on the field like
   * anything else while it is there, and everything can reach it.
   */
  aside?: boolean;
  /** Taken off everything it casts, for as long as it is somewhere it does not belong. */
  costOff?: number;
  /** Moves a step has put in a slot, by slot index, for this battle only. */
  swapped?: Record<number, string>;
  /**
   * Moves a step has handed over on top of the four it holds, for this battle
   * only. Offered after the slots, beside a move an ability grants.
   */
  given?: string[];
  /** Costumes a step has put it in, for the rest of the battle. */
  worn?: string[];
  /** Set on the one body two Scobas fused into. */
  fusion?: Fusion;
  /**
   * How effective its good and its bad statuses are made by whoever is standing
   * on the field with it, from their `mark-worth` effects that reach allies or
   * enemies, and the sigils those effects have it show. Worked out again
   * whenever who is on the field changes, by `refreshWorth`, and absent where
   * nothing reaches it. `by` names each one, so a window can say what made a
   * status worth more.
   */
  worth?: {
    good: number; bad: number; shown?: string[];
    by?: { name: string; polarity: StatusPolarity; mult: number }[];
  };
  /**
   * One of the two Scobas in a fusion: the team index of that fusion. It keeps
   * its own mark, its moves, its cooldowns and its mana bar, and picks one of
   * the fusion's two moves a round from them, but it is not on the field: the
   * fusion stands there for both.
   */
  fusedInto?: number;
}

/**
 * What a fusion is made of. HP is two bars, the first slot's Scoba's first,
 * and a hit that empties one stops there rather than reaching the other.
 */
export interface Fusion {
  /** The two it was made of, by team index, first slot first. */
  parts: [number, number];
  /** How big each HP bar is, fixed as the two fused. */
  max: [number, number];
  /**
   * What each HP bar holds. The bar being hit is `Combatant.hp` for as long as
   * it is the one being hit, so read the bars through `fusionBars`.
   */
  hp: [number, number];
  /** Which bar `Combatant.hp` is. */
  live: 0 | 1;
  /** The two halves' stats pooled, before anything the fusion carries. */
  line: Stats;
  /** Each half's own Speed, which is what that half acts at. */
  spd: [number, number];
}

/** What a fusion's two stat lines are pooled down to. */
export const FUSION_SHARE = 0.75;

/** A character in the shared save. */
export type OwnerId = "A" | "B";

/**
 * Who is playing a side-0 slot: a character, `"*"` for a slot not tied to one
 * (wild 1v1 and plain doubles), or null for a slot nobody holds, which is a
 * co-op battle waiting on the other player to walk over and join.
 */
export type SlotHolder = OwnerId | "*" | null;

/**
 * A replacement that walked onto an emptied mark. Held by the Scoba's uid
 * rather than by its place in the team, since what a replay needs to find is
 * the same Scoba rather than whoever is standing where it stood.
 */
export interface Filled {
  side: 0 | 1;
  slot: Slot;
  uid: string;
}

/** One round as it can be played again: the battle before it, and what was chosen. */
export interface TurnRecord {
  turn: number;
  before: Omit<BattleState, "history">;
  choices: Choice[];
  /**
   * Who walked on between the round before this one and this one. Replacements
   * are picked between rounds rather than in them, so a round that replayed
   * without these left an emptied mark empty for the rest of the journey.
   */
  filled?: Filled[];
}

/** How many rounds back a rewind can reach. Three, and one to spare. */
export const REWIND_KEEP = 4;

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
   * What is growing on the marks. A patch is planted on a mark rather than on
   * a Scoba, so it stays where it is when the Scoba standing on it switches
   * out or falls, and it reaches whoever is standing there when it goes off.
   */
  ground: Patch[];
  /**
   * What the round it is half way through stopped to ask. Set by a round that
   * could not finish, and gone the moment one is resolved with the answers.
   * Nothing carries it between rounds: it belongs to the round that raised it.
   */
  asking?: Question[];
  /**
   * EZ mode. Kept on the state rather than spent at the opening, because a
   * Pawn called mid-battle has to be given the same leg-up as the Scoba that
   * called it: without it the court stays at a quarter of everyone's size.
   */
  ez: boolean;
  /**
   * The last few rounds, newest last: what the battle looked like before each
   * one and what was chosen in it. A rewind puts the state back to one of these
   * and a replay runs the choices again. Kept to `REWIND_KEEP` rounds, and each
   * snapshot holds no history of its own, so nothing nests.
   */
  history?: TurnRecord[];
  /**
   * Replacements that have walked on since the last round, waiting to be filed
   * with the round they walked on for. Drained as that round opens.
   */
  filling?: Filled[];
  /**
   * What an `undo-round` step is holding for the end of this round: who was
   * undone, and what they were carrying when it ran. It lives on the state
   * rather than in the run, because the step and the putting back are a round
   * apart. Cleared as the round closes.
   */
  undoing?: {
    side: 0 | 1; index: number; hp: number; statuses: StatusInstance[];
    /** The mark worn while it is held, taken off as the round is put back. */
    mark?: string;
    /** Both of a fusion's HP bars, and which was being hit. */
    bars?: { hp: [number, number]; live: 0 | 1 };
  }[];
  /**
   * A rewind has put the battle somewhere else, so the round it happened in
   * stops where it is. Cleared as that round closes.
   */
  rewound?: boolean;
  /** A journey has been made, so nobody makes another one this battle. */
  travelled?: boolean;
  /**
   * The move that journey was made with, so a Scoba that joins afterwards has
   * it taken off too rather than being offered one it can never cast.
   */
  spent?: string;
  /**
   * A journey in progress: the rounds still to play again, where the traveller
   * is standing, and the seat it is coming back to. While this is set, the only
   * choice asked for is the traveller's: everyone else repeats what they chose
   * the first time around.
   */
  travelling?: {
    left: TurnRecord[];
    visitor: TargetRef;
    seat: TargetRef;
    /** The machine it rides, for the scene to carry it there and away again. */
    art?: string;
    /** It has ridden away, so the rounds still to play have nobody to ask. */
    gone?: true;
  };
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

/**
 * Something growing on one mark. It holds a status instance, which is what
 * carries the number it snapshotted as it was planted and who planted it, so
 * a patch keeps working at full strength after that Scoba has left the field.
 */
export interface Patch {
  side: 0 | 1;
  slot: Slot;
  status: StatusInstance;
}

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
  /** Two Scobas becoming one. `at` is the fusion and `to` the two it was made of. */
  | "fuse"
  /** A Scoba stepping out of its own time, or back into it. */
  | "travel"
  /** Something drawn or heard that a step asked for, with no line in the log. */
  | "show";
  /** Who the line is about: the one hit, healed, marked or sent out. */
  at?: TargetRef;
  /**
   * Which Scoba `at` named when the line was written. A rewind later in the
   * same round renumbers whatever the round appended, so a place that held a
   * called Pawn can hold somebody else by the time the scene plays the call.
   */
  uid?: string;
  /** Who brought it about, when that is somebody else. */
  by?: TargetRef;
  /**
   * For a `travel` line: whether a Scoba is leaving its own time, taking its
   * seat back, or the whole battle has wound back to an earlier turn.
   */
  way?: "out" | "back" | "again";
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
   * A fusion's two HP bars and two mana bars once this event has landed, first
   * slot's first. A fusion's readout reads these rather than `hp` and `mana`.
   */
  bars?: { hp: number[]; max: number[]; mana: number[] };
  /**
   * What the field over those sides has become, null for one that has lifted.
   * A field laid over both sides is one event and not two, so the Scoba that
   * called it rattles once rather than twice.
   */
  field?: { id: string | null; sides: (0 | 1)[] };
  /** A patch planted on a mark, or taken off it once `id` is null. */
  ground?: { id: string | null; side: 0 | 1; slot: Slot };
  /**
   * The card being thrown or dealt, as it looks, and what the hand stands at
   * once it is dealt.
   */
  face?: CardFace;
  count?: number;
  /** Every card in the hand once the dealt one lands on it, oldest first. */
  cards?: CardFace[];
  /** The status a status line is about, for the sound it lands with. */
  status?: string;
  /**
   * How many of that status the Scoba carries once it has landed. Only a
   * status landing has one, which is what lets the scene read several landings
   * in a row as one line.
   */
  stacks?: number;
  /** The sample a hit or a heal lands with, where its step names one. */
  sound?: string;
  /** For a `show` event: the step that asked for it, and who it reaches. */
  visual?: VisualStep;
  to?: TargetRef[];
  /** For a throw that bounces: the Scoba it leaves from, in place of `at`. */
  off?: TargetRef;
}

/** The steps that change only what is drawn and heard. */
export type VisualStep = Extract<Step, { kind: "motion" | "throw" | "show" | "sound" | "flash" | "wait" | "wear" }>;

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
  if (isPawnSlot(slot) || isTravelSlot(slot)) return (st.active[side][slot] ?? -1) >= 0;
  if (slot >= st.slots) return false;
  return side === 1 || st.slotOwner[slot] !== null;
}

/** Which character's Scobas may fill this slot, or `"*"` for no restriction. */
function holderOf(st: BattleState, side: 0 | 1, slot: Slot): SlotHolder {
  if (side === 1 || isPawnSlot(slot) || isTravelSlot(slot)) return "*";
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
  if (isPawnSlot(slot) || isTravelSlot(slot) || !slotInPlay(st, side, slot)) return [];
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
  // While a journey is being played out, the only choice anyone makes is the
  // traveller's: everyone else is repeating what they already chose.
  const journey = st.travelling;
  if (journey) {
    if (journey.gone || side !== journey.visitor.side) return [];
    const at = ALL_SLOTS.find((slot) => st.active[side][slot] === journey.visitor.index);
    return at === undefined ? [] : [at];
  }
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
      !isTravelSlot(slot) &&
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
export function sendIn(
  st: BattleState, side: 0 | 1, slot: Slot, benchIndex: number, answers: Answer[] = [],
): BattleEvent[] {
  if (!slotInPlay(st, side, slot) || (st.active[side][slot] ?? -1) >= 0) return [];
  if (!benchFor(st, side, slot).includes(benchIndex)) return [];
  const c = st.teams[side][benchIndex]!;
  st.active[side][slot] = benchIndex;
  // Filed so a rewind can send the same Scoba on again. A replacement is picked
  // between rounds rather than in one, so nothing else would remember it.
  (st.filling ??= []).push({ side, slot, uid: c.scoba.uid });
  const events: BattleEvent[] = [{
    text: `${displayName(c.scoba)} joins the fight.`,
    kind: "switch",
    at: { side, index: benchIndex },
  }];
  return asking(st, answers, events, (asks) => {
    const ctx: Ctx = { st, events, rng: turnRng(st), depth: 0, asks };
    fire(ctx, { side, index: benchIndex }, { on: "switch-in" }, null);
  });
}

export function startBattle(
  seed: string,
  teamA: ScobaInstance[],
  teamB: ScobaInstance[],
  opts: {
    slots?: 1 | 2; wild?: boolean; owners?: [SlotHolder, SlotHolder];
    /** EZ mode: the players' own Scobas fight this one with a leg-up. */
    ez?: boolean;
    /**
     * What the opening was told, where an entry trigger stopped it to ask
     * something. A battle is built from its seed and its teams, so it is built
     * again with the answers rather than picked up where it stopped.
     */
    answers?: Answer[];
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
    ground: [],
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
  asking(st, opts.answers ?? [], st.opening, (asks) => {
    const ctx: Ctx = { st, events: st.opening, rng: turnRng(st), depth: 0, asks };
    for (const side of [0, 1] as const) {
      st.teams[side].forEach((_c, index) => fire(ctx, { side, index }, { on: "battle-start" }, null));
    }
    forEachStanding(st, (ref) => fire(ctx, ref, { on: "switch-in" }, null));
  });
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
    if (isPawnSlot(slot) || isTravelSlot(slot) || !slotInPlay(st, side, slot)) continue;
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
export function joinBattle(
  st: BattleState, owner: OwnerId, team: ScobaInstance[], answers: Answer[] = [],
): BattleEvent[] {
  const slot = slotOf(owner);
  if (st.winner !== -1 || st.outcome !== "") return [];
  if (st.slotOwner[slot] !== null || slot >= st.slots) return [];
  const base = st.teams[0].length;
  st.teams[0].push(...makeCombatants(team));
  for (let i = base; i < st.teams[0].length; i++) spendJourney(st, st.teams[0][i]!);
  st.slotOwner[slot] = owner;
  const idx = st.teams[0].findIndex((c, i) => i >= base && !c.fainted);
  st.active[0][slot] = idx;
  const joined = idx >= 0 ? st.teams[0][idx]! : null;
  if (!joined) return [{ text: "They have nobody left to send in.", kind: "info" }];
  const events: BattleEvent[] = [{ text: `${displayName(joined.scoba)} joins the fight.`, kind: "switch" }];
  return asking(st, answers, events, (asks) => {
    const ctx: Ctx = { st, events, rng: turnRng(st), depth: 0, asks };
    st.teams[0].forEach((_c, i) => {
      if (i >= base) fire(ctx, { side: 0, index: i }, { on: "battle-start" }, null);
    });
    fire(ctx, { side: 0, index: idx }, { on: "switch-in" }, null);
  });
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

// --- fusions ---

/**
 * Who a combatant acts as: the fusion, for one of the two Scobas in it, and
 * itself for anyone else. A half casts from its own moves and mana, but the
 * fusion is what stands on the field, so it is the fusion that casts.
 */
export function actingAs(st: BattleState, c: Combatant): Combatant {
  if (c.fusedInto === undefined) return c;
  const ref = refOf(st, c);
  return (ref ? st.teams[ref.side][c.fusedInto] : undefined) ?? c;
}

/** Where a combatant acts from: the fusion's place, for one of its halves. */
export function actingRef(st: BattleState, c: Combatant): TargetRef | null {
  const ref = refOf(st, c);
  if (!ref || c.fusedInto === undefined) return ref;
  return { side: ref.side, index: c.fusedInto };
}

/** A target that names one half of a fusion names the fusion. */
function throughFusion(st: BattleState, ref: TargetRef): TargetRef {
  const c = combatantAt(st, ref);
  return c?.fusedInto !== undefined ? { side: ref.side, index: c.fusedInto } : ref;
}

/** The two Scobas a fusion was made of, first slot first. */
export function fusionHalves(st: BattleState, body: Combatant): Combatant[] {
  const ref = body.fusion ? refOf(st, body) : null;
  if (!ref || !body.fusion) return [];
  return body.fusion.parts.map((i) => st.teams[ref.side][i]).filter((c): c is Combatant => !!c);
}

/** Which half of its fusion a Scoba is, or null for one that is not in one. */
function halfOf(st: BattleState, c: Combatant): 0 | 1 | null {
  const body = actingAs(st, c);
  if (body === c || !body.fusion) return null;
  const ref = refOf(st, c);
  const i = ref ? body.fusion.parts.indexOf(ref.index) : -1;
  return i === 0 || i === 1 ? i : null;
}

/** A fusion's two HP bars as they stand, first slot's first. */
export function fusionBars(c: Combatant): { hp: number; max: number }[] | null {
  const f = c.fusion;
  if (!f) return null;
  return f.max.map((max, i) => ({ max, hp: i === f.live ? c.hp : f.hp[i]! }));
}

/** Both bars of whoever an event is about, where that is a fusion. */
function barsAt(st: BattleState, ref: TargetRef | null | undefined): { bars?: BattleEvent["bars"] } {
  const c = ref ? combatantAt(st, ref) : null;
  const bars = c ? fusionBars(c) : null;
  if (!c || !bars) return {};
  return {
    bars: {
      hp: bars.map((b) => b.hp),
      max: bars.map((b) => b.max),
      mana: fusionHalves(st, c).map((half) => half.mana),
    },
  };
}

/**
 * The Speed a combatant acts at. Each half of a fusion keeps its own, with
 * everything the fusion carries applied on top of it.
 */
export function actingSpeed(st: BattleState, c: Combatant): number {
  const body = actingAs(st, c);
  const half = halfOf(st, c);
  if (!body.fusion || half === null) return combatantStats(c).spd;
  const own = { ...body.fusion.line, spd: body.fusion.spd[half] };
  return foldStatEffects(own, continuousEffects(body.statuses)).spd;
}

/**
 * The mana bar a gift lands in. A fusion has one per half: a gift marked for
 * the second bar goes there, and any other goes to whichever bar holds less.
 */
function manaBar(st: BattleState, c: Combatant, second: boolean): Combatant {
  const halves = fusionHalves(st, c);
  if (halves.length < 2) return c;
  if (second) return halves[1]!;
  return halves[1]!.mana < halves[0]!.mana ? halves[1]! : halves[0]!;
}

/** A Scoba's stat line with its Hyper-Mode in it, which is what a fusion pools. */
function lineForFusion(c: Combatant): Stats {
  const own = statsAt(c.scoba, false);
  if (!c.hyper) return own;
  const bonus = hyperBonus(statsAt(c.scoba, true));
  const out = {} as Stats;
  for (const name of STAT_NAMES) out[name] = own[name] + bonus[name];
  return out;
}

/**
 * The statuses two Scobas carry, as one list for the fusion. A status that
 * stacks keeps every instance. One that does not is kept once, whichever has
 * longer to run, so a passive both of them carry counts once. Hyper-Mode itself
 * is already in the pooled line, so it is left out.
 */
function pooledStatuses(lists: StatusInstance[][]): StatusInstance[] {
  const lasts = (s: StatusInstance): number => (s.turnsLeft < 0 ? Infinity : s.turnsLeft);
  const out: StatusInstance[] = [];
  for (const inst of lists.flat()) {
    if (inst.id === "hyper") continue;
    const def = STATUSES[inst.id];
    const same = out.find((s) => s.id === inst.id && !s.chrono === !inst.chrono);
    if (!same || (def?.stacks && !def.hand)) {
      out.push(inst);
      continue;
    }
    if (lasts(inst) > lasts(same)) out[out.indexOf(same)] = inst;
  }
  return out;
}

/** The statuses a set of passives fuses on, which a fusion carries no longer. */
function fuseMarks(statuses: readonly StatusInstance[]): Set<string> {
  return new Set(statuses.flatMap((s) => STATUSES[s.id]?.fuses?.partner ?? []));
}

/** Whether a Scoba can be one half of a fusion right now. */
function canFuse(c: Combatant | null | undefined): c is Combatant {
  return !!c && !c.fainted && c.hyper === true && !c.pawn && !c.aside
    && !c.fusion && c.fusedInto === undefined;
}

/**
 * Fuses the holder with the ally on the other Scoba mark, where that ally
 * carries the partner passive and both are in Hyper-Mode.
 *
 * The fusion is a new combatant on a mark of its own. Its HP is two bars, each
 * half's own as it stood; its stats are both halves' lines, Hyper-Mode in, put
 * together and cut to `FUSION_SHARE`; its level is theirs added; and it carries
 * every status either had except the ones they fused on. Each half stays on
 * its own mark off the field and keeps its moves, cooldowns and mana bar, so
 * each still answers for one move a round. Neither mark takes anyone else
 * until the fusion falls.
 */
function fuse(ctx: Ctx, holderRef: TargetRef, partner: string, into: string): void {
  const st = ctx.st;
  const side = holderRef.side;
  const sp = SPECIES[into];
  if (!sp) return;
  if ((st.active[side][FUSION_SLOT] ?? -1) >= 0) return;
  const mark = [0, 1].find((slot) => st.active[side][slot] === holderRef.index);
  if (mark === undefined) return;
  const holder = combatantAt(st, holderRef);
  const otherIndex = st.active[side][mark === 0 ? 1 : 0] ?? -1;
  const other = otherIndex >= 0 ? st.teams[side][otherIndex] : undefined;
  if (!canFuse(holder) || !canFuse(other)) return;
  if (!other.statuses.some((s) => s.id === partner)) return;

  const parts: [number, number] = mark === 0 ? [holderRef.index, otherIndex] : [otherIndex, holderRef.index];
  const [a, b] = parts.map((i) => st.teams[side][i]!) as [Combatant, Combatant];
  const lines = [lineForFusion(a), lineForFusion(b)];
  const line = {} as Stats;
  for (const name of STAT_NAMES) line[name] = Math.floor(FUSION_SHARE * (lines[0]![name] + lines[1]![name]));
  // One number for anything that needs a single Speed off it, like who answers
  // a sweeping hit first: the faster half's.
  line.spd = Math.max(lines[0]!.spd, lines[1]!.spd);

  const scoba: ScobaInstance = {
    uid: `${a.scoba.uid}+${b.scoba.uid}`,
    speciesId: into,
    level: a.scoba.level + b.scoba.level,
    xp: 0,
    genes: line,
    moves: [],
    secondaryAbility: "",
    hp: 0,
    fusedFrom: [a, b].map((c) => ({
      speciesId: c.scoba.speciesId,
      ...(c.scoba.sire ? { sire: c.scoba.sire } : {}),
      ...(c.scoba.shiny ? { shiny: true } : {}),
      forms: formsOf(c),
      types: scobaTypes(c.scoba),
    })),
  };
  const pooled = pooledStatuses([a.statuses, b.statuses]);
  const spent = fuseMarks(pooled);
  const body: Combatant = {
    scoba,
    hp: a.hp,
    mana: 0,
    cds: {},
    spent: [],
    blocking: false,
    fainted: false,
    statuses: [...pooled.filter((s) => !spent.has(s.id)), ...passiveStatuses(scoba)],
    fusion: {
      parts,
      max: [combatantMaxHp(a), combatantMaxHp(b)],
      hp: [a.hp, b.hp],
      live: 0,
      line,
      spd: [lines[0]!.spd, lines[1]!.spd],
    },
  };
  const index = st.teams[side].length;
  st.teams[side].push(body);
  st.active[side][FUSION_SLOT] = index;
  for (const half of [a, b]) {
    half.fusedInto = index;
    half.statuses = [];
    half.blocking = false;
  }
  // Whatever either half left on anybody now came from the fusion, so its
  // numbers and its kills are the fusion's.
  for (const team of st.teams) {
    for (const c of team) {
      for (const inst of c.statuses) {
        if (inst.from?.side === side && parts.includes(inst.from.index)) inst.from = { side, index };
      }
    }
  }
  const ref = { side, index };
  ctx.events.push({
    text: `${displayName(a.scoba)} and ${displayName(b.scoba)} fuse into ${sp.name}!`,
    kind: "fuse", at: ref, uid: scoba.uid, to: parts.map((i) => ({ side, index: i })), hp: body.hp,
    ...barsAt(st, ref),
  });
  if (ctx.depth < MAX_TRIGGER_DEPTH) fire({ ...ctx, depth: ctx.depth + 1 }, ref, { on: "switch-in" }, null);
}

/**
 * A fusion's bar has run out. Where the other bar still holds anything, the
 * fusion carries on on that one, and whatever was left of the hit that emptied
 * the first is lost. Says whether it did.
 */
function breakBar(ctx: Ctx, ref: TargetRef, c: Combatant): boolean {
  const f = c.fusion;
  if (!f) return false;
  const next = f.live === 0 ? 1 : 0;
  if (f.hp[next] <= 0) return false;
  f.hp[f.live] = 0;
  f.live = next;
  c.hp = f.hp[next];
  ctx.events.push({
    text: `${displayName(c.scoba)} loses one of its HP bars!`,
    kind: "info", at: ref, hp: c.hp, ...barsAt(ctx.st, ref),
  });
  return true;
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
  const own = c.fusion ? c.fusion.line : statsAt(c.scoba, false);
  return foldStatEffects(own, continuousEffects(c.statuses, (inst) => worthOf(c, inst)));
}

/**
 * How effective one status is where it sits: what the holder's own statuses
 * say about it, times what the field says about the holder.
 */
export function worthOf(c: Combatant, inst: StatusInstance): number {
  if (!worthReaches(inst)) return 1;
  const polarity = STATUSES[inst.id]?.polarity;
  if (!polarity) return 1;
  return (c.worth?.[polarity] ?? 1) * selfWorth(c.statuses, polarity);
}

/** Each multiple in `worthOf`, named after the status it comes from. */
export function worthBy(c: Combatant, inst: StatusInstance): { name: string; mult: number }[] {
  if (!worthReaches(inst)) return [];
  const polarity = STATUSES[inst.id]?.polarity;
  if (!polarity) return [];
  const out = (c.worth?.by ?? []).filter((b) => b.polarity === polarity).map(({ name, mult }) => ({ name, mult }));
  for (const own of c.statuses) {
    for (const e of STATUSES[own.id]?.effects ?? []) {
      if (e.kind === "mark-worth" && e.reach === "self" && e.polarity === polarity) {
        out.push({ name: statusName(own.id), mult: Math.pow(e.mult, own.stacks) });
      }
    }
  }
  return out.filter((b) => b.mult !== 1);
}

/**
 * Works out every combatant's `worth` from the `mark-worth` effects standing on
 * the field. Only a Scoba on the field reaches anyone, and only a Scoba on the
 * field is reached, so this runs whenever who is standing there changes.
 */
function refreshWorth(st: BattleState): void {
  const auras: {
    from: TargetRef; name: string; reach: "enemies" | "allies"; polarity: StatusPolarity; mult: number; shown?: string;
  }[] = [];
  forEachStanding(st, (ref) => {
    const c = combatantAt(st, ref);
    for (const inst of c?.statuses ?? []) {
      for (const e of STATUSES[inst.id]?.effects ?? []) {
        if (e.kind !== "mark-worth" || e.reach === "self") continue;
        auras.push({
          from: ref, name: statusName(inst.id), reach: e.reach, polarity: e.polarity, mult: Math.pow(e.mult, inst.stacks),
          ...(e.shown !== undefined ? { shown: e.shown } : {}),
        });
      }
    }
  });
  for (const team of st.teams) for (const c of team) delete c.worth;
  if (auras.length === 0) return;
  forEachStanding(st, (ref) => {
    const c = combatantAt(st, ref);
    if (!c) return;
    const w: NonNullable<Combatant["worth"]> = { good: 1, bad: 1 };
    const shown: string[] = [];
    const by: NonNullable<NonNullable<Combatant["worth"]>["by"]> = [];
    for (const a of auras) {
      const reaches = a.reach === "enemies" ? a.from.side !== ref.side : a.from.side === ref.side;
      if (!reaches) continue;
      w[a.polarity] *= a.mult;
      by.push({ name: a.name, polarity: a.polarity, mult: a.mult });
      // The holder shows its own passive's sigil already, so the one it hands
      // out is for everyone else it reaches. Listed once per source, so the
      // sigil can count them.
      if (a.shown !== undefined && !sameRef(a.from, ref)) shown.push(a.shown);
    }
    if (shown.length > 0) w.shown = shown;
    if (by.length > 0) w.by = by;
    if (w.good !== 1 || w.bad !== 1 || shown.length > 0) c.worth = w;
  });
}

/** The HP bar's size. A fusion's is whichever of its two bars is being hit. */
export function combatantMaxHp(c: Combatant): number {
  if (c.fusion) return c.fusion.max[c.fusion.live];
  return Math.floor(combatantStats(c).hp * 2.8);
}

/**
 * What a combatant's own statuses and the field it is standing under both say,
 * as one list. A field carries no stacks, so each of its effects counts once.
 */
function readEffects(c: Combatant, field: FieldEffect[]): ReadEffect[] {
  const out = continuousEffects(c.statuses, (inst) => worthOf(c, inst));
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
    if (effect.kind === "frail") mult *= Math.pow(effect.mult, stacks);
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
  const full = handed ? MOVES[moveId]?.manaCost ?? 0 : moveCost(c.scoba, moveId);
  // A traveller casts cheaply while it is in the past: it is spending mana it
  // has not earned yet.
  return Math.max(0, full - (c.costOff ?? 0));
}

export function moveReady(c: Combatant, moveId: string): { ok: boolean; why?: string } {
  const move = MOVES[moveId];
  if (!move) return { ok: false, why: "Unknown move." };
  const shut = spellsShutBy(c.statuses);
  if (shut) return { ok: false, why: `${shut.name} stops it casting abilities.` };
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

/**
 * The move a combatant's basic attack has become, where a passive it carries
 * says so, or null for the plain blow. The latest one it gained wins, so a
 * Hyper-Mode passive can change a basic attack the primary already changed.
 */
export function basicAttackOf(c: Combatant): Move | null {
  for (let i = c.statuses.length - 1; i >= 0; i--) {
    const id = STATUSES[c.statuses[i]!.id]?.basicAttack;
    const move = id ? MOVES[id] : undefined;
    if (move) return move;
  }
  return null;
}

/** What this combatant's basic attack is aimed at: its move's aim where a passive made it one. */
export function basicSpecs(c: Combatant): TargetSpec[] {
  return basicAttackOf(c)?.targets ?? BASIC_ATTACK_TARGETS;
}

/** Why this Scoba cannot go Hyper right now, or null if it can. */
export function hyperError(c: Combatant): string | null {
  const sp = SPECIES[c.scoba.speciesId];
  if (!sp?.hyperAbility) return "This Scoba has no Hyper-Mode.";
  if (c.hyper) return "Already in Hyper-Mode.";
  if (hyperShut(c.statuses)) return "Its Hyper-Mode is gone.";
  if (c.mana < HYPER_COST) return `Costs ${HYPER_COST} mana.`;
  return null;
}

/** The target specs a choice has to satisfy before it is legal. */
/**
 * What an action asks to be aimed at. Given the battle, a basic attack that a
 * passive turned into a move is aimed the way that move is, which for one that
 * calls something up is nowhere at all.
 */
export function specsFor(c: Choice, st?: BattleState): TargetSpec[] {
  if (c.kind === "attack") {
    const user = st ? combatant(st, c.side, c.slot) : null;
    return st && user ? basicSpecs(actingAs(st, user)) : BASIC_ATTACK_TARGETS;
  }
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
    if (isTravelSlot(c.slot)) return "It is not even from this turn.";
    if (!slotInPlay(st, c.side, c.slot)) return "Nobody is playing that slot.";
    // A rooted Scoba stays where it is. Checked before the bench, since what
    // stops the switch is the one leaving rather than the one coming in.
    const leaving = combatant(st, c.side, c.slot);
    if (leaving && !leaving.fainted && leaving.fusedInto !== undefined) return "A fusion cannot be switched out.";
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
  if (c.kind === "block") return user.fusedInto !== undefined ? "A fusion cannot block." : null;
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
    if (st.travelled && MOVES[c.moveId]?.cast.some((s) => s.kind === "travel")) {
      return "That journey has already been made.";
    }
  }
  const specs = specsFor(c, st);
  const picks = c.picks ?? [];
  if (picks.length !== specs.length) return "Wrong number of targets.";
  // A half aims from where its fusion stands.
  const userRef = actingRef(st, user);
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
  /**
   * What the round has been told and what it still wants to know. Held as one
   * object rather than as fields, because a trigger runs on a copy of the
   * context and the count of questions has to be the round's own.
   */
  asks: Asks;
}

interface Asks {
  /** What the round has already been told, in the order it asked. */
  answers: Answer[];
  /** How many questions it has raised, which is what an answer is keyed by. */
  count: number;
  /** The ones nobody has answered. */
  open: Question[];
}

/**
 * One question a round stopped to ask. A round can stop several times, and a
 * stop can hold a question for each of several Scobas: everyone answers, then
 * the round carries on from where it was.
 */
export interface Question {
  /** Which Scoba is being asked, by where it stands. */
  at: TargetRef;
  /** What it is being asked, written for the action row. */
  prompt: string;
  /** What it may pick. A question with nothing to pick is answered with nothing. */
  options: TargetRef[];
  /** The move or the status that raised it, so a readout can name what is asking. */
  by: string;
  /**
   * What it wants back. A "pick" question wants one of its options, and an
   * "act" question wants the whole action its asker takes this round, which
   * is what a move that looks ahead asks for once it has shown the round.
   */
  kind?: "pick" | "act";
}

/** What one question was answered with. */
export interface Answer {
  pick: TargetRef | null;
  /** The action taken, where the question asked for one. */
  act?: Choice;
}

/**
 * Thrown to stop a round that has asked something nobody has answered. The
 * round is resolved again from the start once the answers are in hand, so
 * whatever it did before it stopped is thrown away with the state it did it to.
 */
class Asked extends Error {}

/** A run that cannot stop to ask anything. */
const noAsks = (): Asks => ({ answers: [], count: 0, open: [] });

/**
 * Runs something that can stop to ask, and files what it asked rather than
 * letting the stop escape. What comes back is whatever it said before it
 * stopped. Anything that stops this way is run again from where it started,
 * with the answers in hand, so its caller keeps what it was working on.
 */
function asking(
  st: BattleState, answers: Answer[], events: BattleEvent[], run: (asks: Asks) => void,
): BattleEvent[] {
  const asks: Asks = { answers, count: 0, open: [] };
  delete st.asking;
  try {
    run(asks);
  } catch (stopped) {
    if (!(stopped instanceof Asked)) throw stopped;
    st.asking = asks.open;
  }
  return events;
}

/**
 * Puts a question to one Scoba. It comes back with what that Scoba was
 * answered with, or undefined where nobody has answered it yet, in which case
 * the question is filed and the step that raised it stops the round.
 */
function askOne(ctx: Ctx, q: Question): Answer | undefined {
  const n = ctx.asks.count;
  ctx.asks.count += 1;
  const said = ctx.asks.answers[n];
  if (said) return said;
  ctx.asks.open.push(q);
  return undefined;
}

/** Stops the round where anything it asked this step has gone unanswered. */
function stopIfAsking(ctx: Ctx): void {
  if (ctx.asks.open.length > 0) throw new Asked();
}

/** How a hit should be treated once it reaches `dealDamage`. */
interface HitMeta {
  element: ElementType;
  category: DamageCategory | "mixed";
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
  /** A basic attack a passive turned into a move: it names the move, but it is no spell. */
  basic?: boolean;
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
  } else {
    // A flat hit takes its number off the caster's level instead of a stat,
    // and is an ordinary hit from there on.
    dmg = 0;
    // What of it came off Magic, which is the half a mixed hit reads Resistance against.
    let magical = 0;
    if (attack.step.perLevel !== undefined) {
      dmg = attack.step.perLevel * user.scoba.level;
    } else {
      for (const s of attack.step.scaling) {
        const part = uStats[s.stat] * s.scale;
        dmg += part;
        if (s.stat === "mag") magical += part;
      }
      // A flat share is written as what it comes to at the ceiling, so a level
      // 6 attacker lands a fifth of it.
      const flat = attack.step.flatAtCeiling;
      if (flat !== undefined) dmg += (flat * user.scoba.level) / MAX_LEVEL;
    }
    // Every multiplier below reaches both halves alike, so the share stays put.
    const magicShare = dmg > 0 ? magical / dmg : 0;
    // Counted once per stack the target carries, so what it comes to is what
    // the attacker built up there.
    if (attack.step.perStackOf !== undefined) dmg *= stacksOf(target.statuses, attack.step.perStackOf);
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
    const category = hitCategory(attack.step);
    if (category === "mixed") {
      dmg = dmg * (1 - magicShare) * mitigation(tStats.def) + dmg * magicShare * mitigation(tStats.res);
    } else {
      dmg *= mitigation(category === "physical" ? tStats.def : tStats.res);
    }
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
  const stat: StatName | null = hit.perLevel !== undefined ? null : hit.scaling[0]?.stat ?? null;
  const ref = targetRef ?? firstStanding(st, userRef.side === 0 ? 1 : 0);
  const target = ref ? combatantAt(st, ref) : null;
  const scale = hit.perLevel !== undefined ? 0 : hit.scaling[0]?.scale ?? 0;
  if (!target) {
    return { element: move.type, category, stat, scale, damage: null, eff: 1, heal: null };
  }
  const { dmg, eff } = damageOf(user, target, { step: hit, move }, fieldEffects(st.fields[userRef.side]));
  return { element: move.type, category, stat, scale, damage: dmg, eff, heal: null };
}

function firstStanding(st: BattleState, side: 0 | 1): TargetRef | null {
  for (const slot of ALL_SLOTS) {
    const index = st.active[side][slot] ?? -1;
    const c = index >= 0 ? st.teams[side][index] : undefined;
    if (c && !c.fainted && c.fusedInto === undefined) return { side, index };
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
  dmg *= shieldFactor(ctx, target, targetRef, meta);
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
    ...barsAt(ctx.st, targetRef),
    ...(meta.sound !== undefined ? { sound: meta.sound } : {}),
  });

  if (meta.triggersOnHit && ctx.depth < MAX_TRIGGER_DEPTH) {
    const deeper = { ...ctx, depth: ctx.depth + 1 };
    // A basic attack names no move, which is what tells a spell trigger from
    // the plain swing that carries the same category.
    const spell = meta.moveId !== undefined && meta.basic !== true;
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
 * What a shield leaves of one instance of damage, spending itself where it
 * catches something. Read on both paths damage lands on.
 */
function shieldFactor(ctx: Ctx, target: Combatant, targetRef: TargetRef, meta: HitMeta): number {
  const shield = softenOn(target.statuses, (i) => worthOf(target, i));
  if (!shield) return 1;
  if (shield.inst.chargesLeft > 0) shield.inst.chargesLeft -= 1;
  target.statuses = target.statuses.filter((held) => held.chargesLeft !== 0);
  ctx.events.push({
    text: `${statusName(shield.inst.id)} takes the worst of it for ${displayName(target.scoba)}.`,
    kind: "status", at: targetRef, by: meta.source ?? undefined,
  });
  return 1 - shield.frac;
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
  dmg *= shieldFactor(ctx, target, targetRef, meta);
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
    ...barsAt(ctx.st, targetRef),
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
    const spell = meta.moveId !== undefined && meta.basic !== true;
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
  const given = Math.min(max - target.hp, Math.max(1, Math.floor(amount + healBonus(ctx.st, targetRef))));
  if (given <= 0) return 0;
  target.hp += given;
  ctx.events.push({
    text: `${displayName(target.scoba)} recovered ${given} HP.`,
    kind: "heal", at: targetRef, hp: target.hp, ...barsAt(ctx.st, targetRef),
    ...(from?.source ? { by: from.source } : {}),
    ...(from?.moveId ? { moveId: from.moveId } : {}),
    ...(from?.sound !== undefined ? { sound: from.sound } : {}),
  });
  return given;
}

/**
 * What every heal landing on this one restores on top: each ally standing on
 * the field that carries a `heal-bonus`, the one healed included, adds its
 * amount at its own level.
 */
function healBonus(st: BattleState, ref: TargetRef): number {
  let bonus = 0;
  for (const allyRef of fieldOf(st, ref.side, false)) {
    const ally = combatantAt(st, allyRef);
    if (!ally) continue;
    for (const inst of ally.statuses) {
      for (const e of STATUSES[inst.id]?.effects ?? []) {
        if (e.kind !== "heal-bonus") continue;
        bonus += (e.flatAtCeiling * ally.scoba.level / MAX_LEVEL) * inst.stacks * worthOf(ally, inst);
      }
    }
  }
  return bonus;
}

/** Marks a combatant down and fans out every trigger that a death sets off. */
function killed(ctx: Ctx, targetRef: TargetRef, meta: HitMeta): void {
  const st = ctx.st;
  const target = combatantAt(st, targetRef);
  if (!target || target.fainted) return;
  // A fusion with a bar left carries on on it rather than falling.
  if (breakBar(ctx, targetRef, target)) return;
  target.fainted = true;
  // Both halves go down with it, before anything answers the fall: it was the
  // two of them that fell, and neither is left to mourn the other.
  for (const half of fusionHalves(st, target)) {
    half.fainted = true;
    half.hp = 0;
  }
  if (target.fusion) {
    target.fusion.hp = [0, 0];
  }
  ctx.events.push({
    text: `${displayName(target.scoba)} fainted!`, kind: "faint", at: targetRef, hp: 0, ...barsAt(st, targetRef),
  });

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
  // Whatever it was making stronger on the field goes with it.
  refreshWorth(st);
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
  if (event.on === "switch-in") {
    // Fusing comes first: the fusion takes the field in the holder's place and
    // answers the arrival itself, so nothing goes off twice.
    tryFusing(ctx, holderRef);
    refreshWorth(ctx.st);
  }
  for (const inst of [...holder.statuses]) {
    // Fused, and what it carried went to the fusion, which answers for itself.
    if (holder.fusedInto !== undefined) break;
    const def = STATUSES[inst.id];
    if (!def || inst.chargesLeft === 0) continue;
    // Every `when` block a record has answers its own trigger.
    const blocks = [
      { trigger: def.trigger, steps: def.effects.filter((e): e is Step => !isContinuous(e.kind)) },
      ...(def.also ?? []),
    ];
    for (const block of blocks) {
      if (inst.chargesLeft === 0 || holder.fusedInto !== undefined) break;
      if (!triggerFits(block.trigger, event)) continue;
      // A mark that landed this turn waits for the next one before it ticks.
      if (!ticksThisTurn(inst, event, ctx.st.turn)) continue;
      if (inst.chargesLeft > 0) inst.chargesLeft -= 1;
      // A status made stronger or weaker where it sits deals and mends that much.
      const worth = worthOf(holder, inst);
      runSteps(ctx, {
        // A passive was left by nobody, so what it reads as its source is the
        // Scoba carrying it: "10% of source magic" is its own Magic.
        record: def.id, self: holderRef, source: inst.from ?? (def.innate ? holderRef : null), other,
        groups: [], alive: aliveNow(ctx.st), picked: null, raised: null, card: null, draws: 0,
        status: { def, inst }, cast: null,
        ...(worth !== 1 ? { scale: worth } : {}),
      }, block.steps);
    }
  }
  holder.statuses = holder.statuses.filter((s) => s.chargesLeft !== 0);
}

/** Fuses the holder where a passive it carries says it fuses and the pair is ready. */
function tryFusing(ctx: Ctx, holderRef: TargetRef): void {
  const holder = combatantAt(ctx.st, holderRef);
  if (!holder) return;
  for (const inst of [...holder.statuses]) {
    const fuses = STATUSES[inst.id]?.fuses;
    if (!fuses) continue;
    fuse(ctx, holderRef, fuses.partner, fuses.into);
    if (holder.fusedInto !== undefined) return;
  }
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
  /** What an `ask` step was answered with, by the name that step gave it. */
  asked?: Map<string, TargetRef[]>;
  /** The Scoba a `raise` step put on the field, for the steps after it. */
  raised: TargetRef | null;
  /**
   * What this run is worth against the record as written, and whether it is an
   * echo of a cast rather than the cast itself. An echo's numbers are a share
   * of the real ones, and what it leaves behind is marked as an echo too.
   */
  scale?: number;
  chrono?: boolean;
  /** The card a `draw-card` step drew, for the steps after it. */
  card: DrawnCard | null;
  /** How many cards these steps have drawn, so each draw rolls its own card. */
  draws: number;
  /** The status running these steps, where a status is. */
  status: { def: StatusDef; inst: StatusInstance } | null;
  /**
   * The move being cast, what was paid for it, and whose bar paid: the caster's
   * own, or for a fusion, the half that picked the move.
   */
  cast: { move: Move; paid: number; payer?: TargetRef } | null;
  /** A basic attack played as the move a passive turned it into. */
  basic?: boolean;
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
  if (typeof who === "object") {
    if ("aim" in who) return run.groups[who.aim] ?? [];
    if ("asked" in who) return run.asked?.get(who.asked) ?? [];
    if ("next" in who) {
      const skip = whoRefs(ctx, run, who.from);
      const side = who.next === "ally" ? run.self.side : run.self.side === 0 ? 1 : 0;
      const next = fieldOf(ctx.st, side, true).find((ref) => !skip.some((s) => sameRef(s, ref)));
      return next ? [next] : [];
    }
    const first = whoRefs(ctx, run, who.first).filter((ref) => combatantAt(ctx.st, ref)?.fainted === false);
    return first.length > 0 ? first : whoRefs(ctx, run, who.then);
  }
  const foe: 0 | 1 = run.self.side === 0 ? 1 : 0;
  switch (who) {
    case "self": return [run.self];
    case "source": return run.source ? [run.source] : [];
    case "other": return run.other ? [run.other] : [];
    case "raised": return run.raised ? [run.raised] : [];
    case "traveller": return ctx.st.travelling ? [ctx.st.travelling.visitor] : [];
    case "field-allies": return fieldOf(ctx.st, run.self.side, false);
    case "field-enemies": return fieldOf(ctx.st, foe, false);
    case "ally-scobas": return fieldOf(ctx.st, run.self.side, true);
    case "enemy-scobas": return fieldOf(ctx.st, foe, true);
    case "ally-pawns": return fieldOf(ctx.st, run.self.side, false).filter((ref) => combatantAt(ctx.st, ref)?.pawn);
    case "enemy-pawns": return fieldOf(ctx.st, foe, false).filter((ref) => combatantAt(ctx.st, ref)?.pawn);
    default: return teamOf(ctx.st, run.self, who);
  }
}

/**
 * Everyone standing on one side of the field, in mark order: every Scoba mark,
 * then the Pawn marks, then the rest. `scobas` leaves the Pawns out. A fusion is
 * a Scoba, and its two halves are inside it rather than standing there.
 */
function fieldOf(st: BattleState, side: 0 | 1, scobas: boolean): TargetRef[] {
  const out: TargetRef[] = [];
  for (const slot of ALL_SLOTS) {
    const index = st.active[side][slot] ?? -1;
    const c = index >= 0 ? st.teams[side][index] : undefined;
    if (!c || c.fainted || c.fusedInto !== undefined) continue;
    if (scobas && c.pawn) continue;
    out.push({ side, index });
  }
  return out;
}

/** Every standing member of a team, or of both, relative to one Scoba. */
function teamOf(st: BattleState, selfRef: TargetRef, who: "allies" | "enemies" | "everyone" | "others"): TargetRef[] {
  const sides: (0 | 1)[] = who === "everyone" || who === "others"
    ? [0, 1]
    : [who === "allies" ? selfRef.side : (selfRef.side === 0 ? 1 : 0)];
  const out: TargetRef[] = [];
  for (const side of sides) {
    st.teams[side].forEach((c, index) => {
      // A half is inside its fusion, and whatever reaches the team reaches it there.
      if (c.fainted || c.fusedInto !== undefined) return;
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
    case "flash":
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
      // Art shown on a Scoba is shown wherever that Scoba is, fallen or not:
      // a clock over the one it is counting out has to reach it.
      const to = whoRefs(ctx, run, reach)
        .filter((ref) => step.kind === "show" || combatantAt(ctx.st, ref)?.fainted === false);
      // A card is thrown as it was drawn, so the scene shows the card the hand
      // is about to be dealt rather than rolling one of its own.
      if (step.kind === "throw" && step.drawn && !run.card) return true;
      // A bounce leaves from the first of whoever it bounces off.
      const off = step.kind === "throw" && step.off !== undefined ? whoRefs(ctx, run, step.off)[0] : undefined;
      ctx.events.push({
        text: "", kind: "show", at: run.self, visual: step, to,
        ...(run.cast ? { moveId: run.cast.move.id } : {}),
        ...(step.kind === "throw" && step.drawn && run.card ? { face: run.card.face } : {}),
        ...(off ? { off } : {}),
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
        // A hit counted per stack is not thrown at all where there are none.
        if (step.perStackOf !== undefined && stacksOf(target.statuses, step.perStackOf) === 0) return [];
        const { dmg, eff } = damageOf(user, target, attack, field);
        const worth = Math.max(1, Math.floor(dmg * (run.scale ?? 1)));
        const note = eff > 1 ? " Super effective!" : eff < 1 ? " Not very effective." : "";
        const meta: HitMeta = {
          element,
          category: hitCategory(step),
          damageClass: "attack",
          triggersOnHit: true,
          source: run.self,
          note,
          ...(move ? { moveId: move.id } : {}),
          ...(run.basic ? { basic: true } : {}),
          ...(step.sound !== undefined ? { sound: step.sound } : {}),
        };
        return [{ at: ref, raw: worth, meta }];
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
          ctx.events.push({ text: `${run.status.def.name} hits ${displayName(target.scoba)}.`, kind: "status", at: ref });
        }
        const steps = markDamageSteps(ctx.st, ref, run.source, d, target);
        const reduced = power * steps.synergy * steps.elemental * steps.armorMult;
        dealDamage(ctx, ref, Math.max(1, Math.floor(reduced * (run.scale ?? 1))), {
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
        // What the status or the patch running it snapshotted, where it heals by that.
        const amount = step.power
          ? (run.status?.inst.power ?? 0) * (run.scale ?? 1)
          : basisValue(ctx, step.basis, ref, run.source) * step.frac * (run.scale ?? 1);
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
        inflict(
          ctx, ref, step.status, run.source ?? run.self, step.turns,
          run.chrono ? { scale: run.scale ?? 1 } : undefined,
        );
      }
      return true;
    case "cleanse":
      for (const ref of whoRefs(ctx, run, step.on)) cleanse(ctx, ref, step.polarity);
      return true;
    case "travel": {
      travel(ctx, run, step.turns, step.discount, step.art);
      return true;
    }
    case "rewind": {
      const undone = rewind(ctx.st, step.turns);
      if (undone.length === 0) return true;
      ctx.st.rewound = true;
      // A `travel` line rather than a plain one: the board is a different turn
      // now, and the scene has to be put back together before it draws again.
      ctx.events.push({
        text: `The battle winds back ${undone.length} turn${undone.length === 1 ? "" : "s"}.`,
        kind: "travel",
        way: "again",
      });
      return true;
    }
    case "undo-round": {
      const held = ctx.st.undoing ?? [];
      for (const ref of whoRefs(ctx, run, step.on)) {
        const c = combatantAt(ctx.st, ref);
        if (!c || c.fainted) continue;
        // One Scoba is held once a round, by whatever undid it first.
        if (held.some((u) => u.side === ref.side && u.index === ref.index)) continue;
        // The mark goes on before the snapshot is taken, so putting the round
        // back does not put the mark back with it.
        if (step.mark) inflict(ctx, ref, step.mark, run.source ?? run.self);
        const after = combatantAt(ctx.st, ref);
        const bars = fusionBars(c);
        held.push({
          side: ref.side, index: ref.index, hp: c.hp,
          statuses: structuredClone((after ?? c).statuses),
          ...(step.mark ? { mark: step.mark } : {}),
          ...(bars && c.fusion ? { bars: { hp: [bars[0]!.hp, bars[1]!.hp], live: c.fusion.live } } : {}),
        });
      }
      ctx.st.undoing = held;
      return true;
    }
    case "clear-status":
      for (const ref of whoRefs(ctx, run, step.on)) {
        const c = combatantAt(ctx.st, ref);
        if (!c || !c.statuses.some((held) => held.id === step.status)) continue;
        c.statuses = c.statuses.filter((held) => held.id !== step.status);
        ctx.events.push({
          text: `${statusName(step.status)} leaves ${displayName(c.scoba)}.`,
          kind: "status", at: ref,
        });
      }
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
    case "summon": {
      const copied = step.copying !== undefined ? whoRefs(ctx, run, step.copying)[0] ?? null : null;
      // A Pawn called up is what the steps after it reach as `raised`, the same
      // as one a `raise` step put on the field.
      run.raised = summon(ctx, run.self, step, copied) ?? run.raised;
      return true;
    }
    case "raise": {
      const fallen = whoRefs(ctx, run, step.who)[0];
      if (!fallen) return true;
      run.raised = raisePawn(ctx, run.self, fallen, step.levelShare, step.types);
      return true;
    }
    case "grant-item":
      grantItem(ctx, run.self.side, step.item, step.count);
      return true;
    case "mana":
      for (const ref of whoRefs(ctx, run, step.on)) {
        const c = combatantAt(ctx.st, ref);
        if (!c) continue;
        const bar = manaBar(ctx.st, c, step.second === true);
        const before = bar.mana;
        // A negative amount is mana taken off, which stops at an empty bar.
        bar.mana = Math.max(0, Math.min(MAX_MANA, bar.mana + manaAt(step.amount, run.scale ?? 1)));
        if (bar.mana === before) continue;
        ctx.events.push({
          text: bar.mana < before
            ? `${displayName(c.scoba)} is drained.`
            : `${displayName(c.scoba)} is brimming.`,
          kind: "status", at: ref, mana: bar.mana, ...barsAt(ctx.st, ref),
        });
      }
      return true;
    case "field":
      setField(ctx, fieldScope(run.self, step.scope), step.field, run.self);
      return true;
    case "plant":
      for (const ref of whoRefs(ctx, run, step.under)) plant(ctx, ref, step.status, run.source ?? run.self);
      return true;
    case "ask": {
      // Everyone it asks is asked at once, so the round stops once and the
      // whole table answers together rather than one after another.
      const picks: TargetRef[] = [];
      for (const asker of whoRefs(ctx, run, step.who)) {
        const c = combatantAt(ctx.st, asker);
        if (!c || c.fainted) continue;
        const options = candidates(ctx.st, asker, step.mode);
        const said = askOne(ctx, {
          at: asker,
          prompt: step.prompt ?? "Pick one",
          options,
          by: run.record,
        });
        if (said?.pick) picks.push(said.pick);
      }
      stopIfAsking(ctx);
      run.asked ??= new Map();
      run.asked.set(step.name, picks);
      return true;
    }
    case "deal-card":
      if (!run.card) return true;
      for (const ref of whoRefs(ctx, run, step.to)) dealCard(ctx, run.self, ref, step.payoff, step.hand, run.card);
      return true;
    case "if": {
      const holds = whoRefs(ctx, run, step.who).some((ref) => {
        const c = combatantAt(ctx.st, ref);
        return step.test === "stands"
          ? !!c && !c.fainted
          : run.alive.has(refKey(ref)) && c?.fainted === true;
      });
      if (holds) runSteps(ctx, run, step.then);
      return true;
    }
    case "refund": {
      if (!run.cast || !selfC) return true;
      const { move, paid } = run.cast;
      // Back to whichever bar paid for it, which for a fusion is one half's.
      const payer = (run.cast.payer ? combatantAt(ctx.st, run.cast.payer) : null) ?? selfC;
      payer.mana = Math.min(MAX_MANA, payer.mana + paid);
      delete payer.cds[move.id];
      ctx.events.push({
        text: `${move.name} comes back around.`,
        kind: "status", at: run.self, mana: payer.mana, ...barsAt(ctx.st, run.self),
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
      const picked = step.move ?? run.picked;
      if (!picked) return true;
      for (const ref of whoRefs(ctx, run, step.to)) {
        const c = combatantAt(ctx.st, ref);
        if (!c) continue;
        // A fusion casts through its halves, so a move handed to it goes to both.
        const takers = c.fusion ? fusionHalves(ctx.st, c) : [c];
        for (const taker of takers) {
          if (step.slot === null) taker.given = [picked];
          else taker.swapped = { ...taker.swapped, [step.slot]: picked };
          // What was just handed over is not on cooldown from what stood there before it.
          delete taker.cds[picked];
        }
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
/** Which mark a Scoba is standing on, or null for one that is not on the field. */
function markOf(st: BattleState, ref: TargetRef): Slot | null {
  const at = st.active[ref.side].indexOf(ref.index);
  return at >= 0 ? at : null;
}

/**
 * Puts a patch on the mark a Scoba is standing on. It is planted rather than
 * carried: what it does, it does to whoever is standing there when it goes
 * off, and it measures itself off whoever planted it as it goes down, so that
 * Scoba leaving the field does not weaken it.
 */
function plant(ctx: Ctx, ref: TargetRef, statusId: string, from: TargetRef | null): void {
  const st = ctx.st;
  const def = STATUSES[statusId];
  const slot = markOf(st, ref);
  if (!def || slot === null) return;
  let power: number | undefined;
  if (def.power) {
    power = def.power.basis ? basisValue(ctx, def.power.basis, ref, from) * def.power.frac : 0;
    const source = from ? combatantAt(st, from) : null;
    if (def.power.flatAtCeiling && source) power += (def.power.flatAtCeiling * source.scoba.level) / MAX_LEVEL;
  }
  const inst = newStatus(statusId, from ?? undefined, power, st.turn);
  if (!inst) return;
  // One patch to a mark: a second planting of the same thing stands it up fresh.
  st.ground = st.ground.filter((p) => !(p.side === ref.side && p.slot === slot));
  st.ground.push({ side: ref.side, slot, status: inst });
  ctx.events.push({
    text: `${def.name} grows under ${displayName(combatantAt(st, ref)!.scoba)}.`,
    kind: "status",
    at: ref,
    by: from ?? undefined,
    ground: { id: statusId, side: ref.side, slot },
  });
}

/**
 * Runs the patches down a turn: each one reaches whoever is standing on its
 * mark, and then loses a turn of its own. A mark nobody is standing on still
 * counts the turn down, the same way a field does.
 */
function tickGround(ctx: Ctx): void {
  const st = ctx.st;
  for (const patch of [...st.ground]) {
    const index = st.active[patch.side][patch.slot] ?? -1;
    const on = index >= 0 ? { side: patch.side, index } : null;
    const holder = on ? combatantAt(st, on) : null;
    if (on && holder && !holder.fainted) runPatch(ctx, patch, on);
    if (patch.status.turnsLeft < 0) continue;
    patch.status.turnsLeft -= 1;
    if (patch.status.turnsLeft > 0) continue;
    st.ground = st.ground.filter((p) => p !== patch);
    ctx.events.push({
      text: `The ${STATUSES[patch.status.id]?.name ?? patch.status.id} fades.`,
      kind: "status",
      ground: { id: null, side: patch.side, slot: patch.slot },
    });
  }
}

/** What a patch does, run on whoever is standing on it as though they carried it. */
function runPatch(ctx: Ctx, patch: Patch, holderRef: TargetRef): void {
  const def = STATUSES[patch.status.id];
  if (!def) return;
  const blocks = [
    { trigger: def.trigger, steps: def.effects.filter((e): e is Step => !isContinuous(e.kind)) },
    ...(def.also ?? []),
  ];
  for (const block of blocks) {
    if (!triggerFits(block.trigger, { on: "turn-end" })) continue;
    runSteps(ctx, {
      record: def.id, self: holderRef, source: patch.status.from ?? null, other: null,
      groups: [], alive: aliveNow(ctx.st), picked: null, raised: null, card: null, draws: 0,
      status: { def, inst: patch.status }, cast: null,
    }, block.steps);
  }
}

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
  for (const { effect, stacks } of continuousEffects(source.statuses, (i) => worthOf(source, i))) {
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
  ctx: Ctx,
  targetRef: TargetRef,
  statusId: string,
  from: TargetRef | null,
  turns?: number,
  echo?: { scale: number },
): void {
  const def = STATUSES[statusId];
  const target = combatantAt(ctx.st, targetRef);
  if (!def || !target || target.fainted) return;
  // Its own entry lines would otherwise hand a fusion back the marks it fused on.
  if (target.fusion && fuseMarks(target.statuses).has(statusId)) return;
  let power: number | undefined;
  if (def.power) {
    power = def.power.basis ? basisValue(ctx, def.power.basis, targetRef, from) * def.power.frac : 0;
    const flat = def.power.flatAtCeiling;
    const source = from ? combatantAt(ctx.st, from) : null;
    if (flat && source) power += (flat * source.scoba.level) / MAX_LEVEL;
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
  // A mark's power is reduced the way a hit is. A mark that deals damage is
  // reduced when it deals its damage instead.
  if (power !== undefined && def.power) power *= mitigation(armorAgainst(powerCategory(def), target));
  const inst = newStatus(statusId, from ?? undefined, power, ctx.st.turn);
  if (!inst) return;
  // An echo of a cast lands an echo of the status: worth its share, and beside
  // whatever plain instance is already there rather than refreshing it.
  if (echo) {
    inst.chrono = true;
    inst.scale = echo.scale;
    if (inst.power !== undefined) inst.power *= echo.scale;
  }
  // What put it there can say how long it stands, over the mark's own clock.
  if (turns !== undefined) inst.turnsLeft = turns;
  const before = combatantMaxHp(target);
  const how = applyStatus(target.statuses, inst);
  // A bigger pool keeps the share of it the Scoba had, the way Hyper-Mode does.
  const after = combatantMaxHp(target);
  if (after > before && before > 0) target.hp = Math.round((target.hp * after) / before);
  // A status that makes others stronger across the field starts doing so now.
  if (def.effects.some((e) => e.kind === "mark-worth" && e.reach !== "self")) refreshWorth(ctx.st);
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
    stacks,
  });
  target.hp = Math.min(target.hp, combatantMaxHp(target));
}

/** A name as a group of them: "Grinklings". */
function plural(name: string): string {
  if (/(s|x|z|ch|sh)$/i.test(name)) return `${name}es`;
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/**
 * One line for a status landing on several Scobas in a row, in place of a line
 * for each landing: "All 3 Grinklings are Charged x4." The count shows where
 * every one of them ends up carrying the same number.
 */
export function landingLine(run: BattleEvent[], nameOf: (ref: TargetRef) => string): string {
  const name = statusName(run[0]?.status ?? "");
  const last = new Map<string, { ref: TargetRef; stacks: number }>();
  for (const ev of run) if (ev.at) last.set(refKey(ev.at), { ref: ev.at, stacks: ev.stacks ?? 1 });
  const who = [...last.values()];
  const names = who.map((w) => nameOf(w.ref));
  const first = who[0];
  const count = first && first.stacks > 1 && who.every((w) => w.stacks === first.stacks) ? ` x${first.stacks}` : "";
  if (who.length <= 1) return `${names[0] ?? ""} is ${name}${count}.`;
  const subject = names.every((n) => n === names[0])
    ? `${who.length === 2 ? "Both" : `All ${who.length}`} ${plural(names[0]!)}`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${subject} are ${name}${count}.`;
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

type SummonStep = Extract<Step, { kind: "summon" }>;

/** Calls up whatever a `summon` step names, and says where it landed, or null for nowhere. */
function summon(ctx: Ctx, callerRef: TargetRef, step: SummonStep, copiedRef: TargetRef | null): TargetRef | null {
  const sp = SPECIES[step.species];
  if (!sp) return null;
  const side = callerRef.side;
  const caller = combatantAt(ctx.st, callerRef);
  const copied = copiedRef ? combatantAt(ctx.st, copiedRef) ?? null : null;
  const shared = step.levelShare !== undefined && caller
    ? Math.max(1, Math.round(caller.scoba.level * step.levelShare))
    : undefined;
  const copy = copied ? { from: copied, except: step.except ?? [] } : null;
  if (sp.pawn) return summonPawn(ctx, callerRef, step.species, shared, copy);
  const already = ctx.st.teams[side].filter((c) => c.summoned).length;
  if (already >= MAX_SUMMONS) {
    ctx.events.push({ text: "Nothing else answers the call.", kind: "info" });
    return null;
  }
  const scoba = makeWild(step.species, shared ?? step.level, rngFrom(`${ctx.st.seed}:summon:${ctx.st.turn}:${already}`));
  scoba.owner = caller?.scoba.owner;
  if (copy) copyLine(scoba, copy.from);
  const [c] = makeCombatants([scoba]);
  if (!c) return null;
  if (copy) copyMarks(c, copy.from, copy.except);
  spendJourney(ctx.st, c);
  c.summoned = true;
  c.calledOn = ctx.st.turn;
  const index = ctx.st.teams[side].length;
  ctx.st.teams[side].push(c);
  ctx.events.push({ text: `${displayName(scoba)} answers the call!`, kind: "switch" });
  return { side, index };
}

/** What a `copying` summon copies, and the statuses it leaves out. */
interface SummonCopy {
  from: Combatant;
  except: readonly string[];
}

/**
 * Makes a newly called Scoba's line a copy of another's: the moves it holds,
 * its second passive, and whatever lean it was bred into, carried onto the new
 * line at that line's own scale. A Scoba bred into Strength calls up one with
 * more Strength than its line starts with.
 */
function copyLine(scoba: ScobaInstance, from: Combatant): void {
  scoba.moves = [...heldMoves(from)];
  scoba.secondaryAbility = from.scoba.secondaryAbility;
  const own = SPECIES[scoba.speciesId];
  const theirs = SPECIES[from.scoba.speciesId];
  if (own && theirs) scoba.genes = leanOnto(own.genes, from.scoba.genes, theirs.genes);
  scoba.hp = maxHp(scoba);
}

/**
 * Hands a newly called Scoba every status another carries and every move it
 * was handed for the battle. Hyper-Mode stays behind, since its numbers were
 * measured off the other line, and so does anything `except` names. A status
 * that does not stack and is already there is not doubled.
 */
function copyMarks(c: Combatant, from: Combatant, except: readonly string[]): void {
  for (const inst of from.statuses) {
    if (inst.id === "hyper" || except.includes(inst.id)) continue;
    const def = STATUSES[inst.id];
    if (!def) continue;
    if (!def.stacks && c.statuses.some((s) => s.id === inst.id)) continue;
    c.statuses.push({ ...inst, from: inst.from ? { ...inst.from } : undefined });
  }
  for (const id of from.given ?? []) {
    const given = (c.given ??= []);
    if (!given.includes(id)) given.push(id);
  }
}

/**
 * A Pawn takes a mark of its own rather than a place on the bench, so it is on
 * the field the moment it is called and stays there until it falls. It comes
 * out at its summoner's level, or the share of it the step names, since the
 * only thing that ever decides how big a Pawn is is who called it.
 */
function summonPawn(
  ctx: Ctx, callerRef: TargetRef, speciesId: string, level?: number, copy: SummonCopy | null = null,
): TargetRef | null {
  const st = ctx.st;
  const side = callerRef.side;
  const caller = combatantAt(st, callerRef);
  if (!caller) return null;
  const slot = freePawnSlot(st, side);
  if (slot === null) {
    ctx.events.push({ text: "There is no room for another Pawn.", kind: "info" });
    return null;
  }
  const scoba = makeWild(
    speciesId, level ?? caller.scoba.level,
    // Label kept through the rename, for the reason given in `ai.ts`.
    rngFrom(`${st.seed}:mote:${st.turn}:${side}:${slot}`),
  );
  scoba.owner = caller.scoba.owner;
  inheritFromCaller(scoba, caller.scoba);
  if (copy) copyLine(scoba, copy.from);
  // What it wears is settled where the pixels are. The sim only records who
  // called it; the art layer keeps whichever of the summoner's marks the Pawn's
  // own palette has a colour for.
  const worn: Summoner = { speciesId: caller.scoba.speciesId };
  if (caller.scoba.sire) worn.sire = caller.scoba.sire;
  if (caller.scoba.shiny) worn.shiny = true;
  scoba.summoner = worn;
  const [c] = makeCombatants([scoba]);
  if (!c) return null;
  if (copy) copyMarks(c, copy.from, copy.except);
  spendJourney(ctx.st, c);
  c.summoned = true;
  c.calledOn = ctx.st.turn;
  c.pawn = true;
  if (st.ez && side === 0) grantEz(c);
  const index = st.teams[side].length;
  st.teams[side].push(c);
  st.active[side][slot] = index;
  ctx.events.push({
    text: `${displayName(caller.scoba)} calls up ${displayName(scoba)}!`,
    kind: "summon",
    at: { side, index },
    uid: scoba.uid,
    by: callerRef,
  });
  if (ctx.depth < MAX_TRIGGER_DEPTH) {
    fire({ ...ctx, depth: ctx.depth + 1 }, { side, index }, { on: "switch-in" }, null);
  }
  return { side, index };
}

/**
 * Puts a fallen Scoba back on the field as a Pawn of the caster's side, at a
 * share of the level it fell at and in the caster's colours. The body it was
 * raised from stays down where it lies, so the side that lost it does not get
 * it back, and a raised Pawn is a Pawn in every other way: it takes a Pawn
 * mark, it is never benched, and a side is beaten when its Scobas are.
 */
function raisePawn(
  ctx: Ctx, callerRef: TargetRef, fallenRef: TargetRef, levelShare: number, types?: ElementType[],
): TargetRef | null {
  const st = ctx.st;
  const side = callerRef.side;
  const caller = combatantAt(st, callerRef);
  const body = combatantAt(st, fallenRef);
  if (!caller || !body || !body.fainted) return null;
  const slot = freePawnSlot(st, side);
  if (slot === null) {
    ctx.events.push({ text: "There is no room for another Pawn.", kind: "info" });
    return null;
  }
  const scoba: ScobaInstance = {
    ...body.scoba,
    uid: freshUid(rngFrom(`${st.seed}:raise:${st.turn}:${side}:${slot}`)),
    level: Math.max(1, Math.round(body.scoba.level * levelShare)),
    hp: 0,
  };
  scoba.owner = caller.scoba.owner;
  // With nothing named, it comes back as whatever raised it.
  const asked = types ?? scobaTypes(caller.scoba);
  if (asked[0]) scoba.type1 = asked[0];
  if (asked[1]) scoba.type2 = asked[1];
  else delete scoba.type2;
  // What it wears is settled where the pixels are, the same as anything else
  // called up: the sim records who raised it and the art layer does the rest.
  const worn: Summoner = { speciesId: caller.scoba.speciesId, repaint: true };
  if (caller.scoba.sire) worn.sire = caller.scoba.sire;
  if (caller.scoba.shiny) worn.shiny = true;
  scoba.summoner = worn;
  scoba.hp = maxHp(scoba);
  const [c] = makeCombatants([scoba]);
  if (!c) return null;
  spendJourney(ctx.st, c);
  c.summoned = true;
  c.calledOn = ctx.st.turn;
  c.pawn = true;
  if (st.ez && side === 0) grantEz(c);
  const index = st.teams[side].length;
  st.teams[side].push(c);
  st.active[side][slot] = index;
  ctx.events.push({
    text: `${displayName(caller.scoba)} raises ${displayName(scoba)}!`,
    kind: "summon",
    at: { side, index },
    uid: scoba.uid,
    by: callerRef,
  });
  if (ctx.depth < MAX_TRIGGER_DEPTH) {
    fire({ ...ctx, depth: ctx.depth + 1 }, { side, index }, { on: "switch-in" }, null);
  }
  return { side, index };
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

/** A choice to do nothing, which is what an unanswered question comes to. */
function bracing(c: Choice): Choice {
  return { kind: "block", side: c.side, slot: c.slot };
}

/**
 * Casts the moves that look ahead, before the round is ordered and before
 * anything else in it happens, and hands back the round with whatever each
 * caster picked instead of the move it cast. A caster nobody answers for
 * braces, and so does one whose answer will not stand.
 *
 * The move is the whole of the caster's round until the answer comes: it pays
 * for the move, and then it pays for what it does about what it saw.
 */
function foresight(ctx: Ctx, asked: Choice[]): Choice[] {
  const st = ctx.st;
  const ahead = asked.filter((c) => c.kind === "spell" && MOVES[c.moveId]?.looksAhead === true);
  if (ahead.length === 0) return asked;
  const said = new Map<Choice, Answer | undefined>();
  for (const c of ahead) {
    if (c.kind !== "spell") continue;
    const move = MOVES[c.moveId];
    const user = combatant(st, c.side, c.slot);
    if (!move || !user || user.fainted) continue;
    // A half of a fusion pays from its own bar, and the fusion is what casts.
    const actor = actingAs(st, user);
    const userRef = refOf(st, actor);
    const payerRef = refOf(st, user);
    if (actor.fainted || !userRef || !payerRef) continue;
    const paid = castCost(user, move.id);
    user.mana -= paid;
    if (move.cooldown > 0) user.cds[move.id] = move.cooldown + 1;
    if (move.oncePerBattle && !user.spent.includes(move.id)) user.spent.push(move.id);
    ctx.events.push({
      text: `${displayName(actor.scoba)} cast ${move.name}!`,
      kind: "spell", at: userRef, moveId: move.id, mana: user.mana, ...barsAt(st, userRef),
    });
    const specs = specsFor(c, st);
    const picks = c.picks.map((p) => (p ? throughFusion(st, p) : p));
    const hits = specs.map((spec, i) => resolveTargets(st, userRef, spec, picks[i] ?? null, ctx.rng));
    runSteps(ctx, {
      record: move.id, self: userRef, source: userRef, other: null,
      groups: hits, alive: aliveNow(st), picked: null, raised: null, card: null, draws: 0,
      status: null, cast: { move, paid, payer: payerRef },
    }, move.cast);
    fire(ctx, userRef, { on: "use-ability" }, hits[0]?.[0] ?? null);
    said.set(c, askOne(ctx, {
      at: userRef, prompt: "What will you do now?", options: [], by: move.id, kind: "act",
    }));
  }
  stopIfAsking(ctx);
  return asked.map((c) => {
    if (!said.has(c)) return c;
    const act = said.get(c)?.act ?? null;
    if (!act || act.side !== c.side || act.slot !== c.slot) return bracing(c);
    // Nothing looks ahead twice in a round: the second one would be cast with
    // the round already ordered, which is not where it goes.
    if (act.kind === "spell" && MOVES[act.moveId]?.looksAhead === true) return bracing(c);
    return choiceError(st, act) === null ? act : bracing(c);
  });
}

/**
 * Files a round again under what was actually chosen, once a move that looks
 * ahead has been answered. A rewind plays the round back from what is filed,
 * and a round filed as the question would stop to ask it all over again.
 */
function refile(st: BattleState, choices: Choice[]): void {
  const round = st.history?.[st.history.length - 1];
  if (round) round.choices = structuredClone(choices);
}

/**
 * Resolves a round. What comes back is everything that happened, in order.
 *
 * A round can stop part way to ask something: a step that puts a question to a
 * Scoba needs an answer before the rest of the round can be worked out. Where
 * that happens, what comes back is everything up to the question, and
 * `st.asking` holds the questions. The state is then half a round old and is
 * no use for anything: throw it away, answer the questions, and resolve the
 * round again from where it started with the answers in hand. The round is
 * worked out from its choices, its seed and its answers alone, so the second
 * run does everything the first one did and then carries on past the question.
 */
export function resolveTurn(st: BattleState, unordered: Choice[], answers: Answer[] = []): BattleEvent[] {
  const asks: Asks = { answers, count: 0, open: [] };
  const events: BattleEvent[] = [];
  delete st.asking;
  try {
    return runTurn(st, unordered, events, asks);
  } catch (stopped) {
    if (!(stopped instanceof Asked)) throw stopped;
    st.asking = asks.open;
    return events;
  }
}

function runTurn(st: BattleState, unordered: Choice[], events: BattleEvent[], asks: Asks): BattleEvent[] {
  if (st.winner !== -1 || st.outcome !== "") return [{ text: "The battle is over.", kind: "info" }];
  // Filed before anything reads the state, since `withRecorded` takes a round
  // off a journey and a replay that started after that would run a round short.
  if (recording()) logRound(st.turn, structuredClone(st), structuredClone(unordered), asks.answers);
  // Declared before the choices are settled: a round being played again walks
  // its replacements back on first, and that is the round's opening rather than
  // something that happened before it.
  const asked = canonicalOrder(withRecorded(st, unordered, events));
  for (const c of asked) {
    const err = choiceError(st, c);
    if (err) throw new Error(`illegal choice from side ${c.side} slot ${c.slot}: ${err}`);
  }
  const rng = turnRng(st);
  // Filed before anything happens, since the round is wound back to here.
  remember(st, asked);
  st.turn += 1;
  const ctx: Ctx = { st, events, rng, depth: 0, asks };
  // Between rounds a replacement can have walked on or a field been handed
  // over, so what makes whose statuses stronger is read again before anything.
  refreshWorth(st);

  // A move that looks ahead is cast before the round is ordered, and the round
  // is ordered with whatever its caster picked instead of it.
  const choices = foresight(ctx, asked);
  if (choices !== asked) refile(st, choices);

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
    // Fused this round, after the switch was chosen: the fusion holds the mark
    // for good, and the turn it meant to spend leaving is spent.
    if (leaving && !leaving.fainted && leaving.fusedInto !== undefined) {
      events.push({
        text: `${displayName(leaving.scoba)} is fused and cannot leave.`,
        kind: "info",
        at: actingRef(st, leaving) ?? undefined,
      });
      continue;
    }
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
      return { c, pri, spd: user ? actingSpeed(st, user) : 0, tie: rng() };
    })
    // Priority outranks Speed outright, so a fast Scoba never gets ahead of a
    // move that was written to go first.
    .sort((a, b) => b.pri - a.pri || b.spd - a.spd || b.tie - a.tie)
    .map((o) => o.c);

  for (const c of ordered) {
    if (st.winner !== -1 || st.rewound) break;
    if (c.kind !== "spell" && c.kind !== "attack") continue;
    const user = combatant(st, c.side, c.slot);
    if (!user || user.fainted) continue;
    // A half of a fusion pays from its own bar and cooldowns, and the fusion
    // is what casts: its stats, its level, its elements and its statuses.
    const actor = actingAs(st, user);
    if (actor.fainted) continue;
    const userRef = refOf(st, actor);
    const payerRef = refOf(st, user);
    if (!userRef || !payerRef) continue;

    const move = c.kind === "spell" ? MOVES[c.moveId] ?? null : null;
    const paid = move ? castCost(user, move.id) : 0;
    if (c.kind === "spell" && move) {
      user.mana -= paid;
      if (move.cooldown > 0) user.cds[c.moveId] = move.cooldown + 1;
      if (move.oncePerBattle && !user.spent.includes(move.id)) user.spent.push(move.id);
      events.push({
        text: `${displayName(actor.scoba)} cast ${move.name}!`,
        kind: "spell", at: userRef, moveId: move.id, mana: user.mana, ...barsAt(st, userRef),
      });
    }
    // A passive can turn the basic attack into a move of its own, cast for nothing.
    const basic = c.kind === "attack" ? basicAttackOf(actor) : null;
    if (c.kind === "attack") {
      events.push({
        text: `${displayName(actor.scoba)} attacks!`, kind: "spell", at: userRef,
        ...(basic ? { moveId: basic.id } : {}),
      });
    }

    // Each spec is resolved once and reused, so a move's own hit and its
    // effects agree on which Scoba "target 1" meant. A pick made before a
    // fusion formed this round names one of its halves, which is the fusion now.
    const specs = specsFor(c, st);
    const picks = c.picks.map((p) => (p ? throughFusion(st, p) : p));
    const hits = specs.map((spec, i) => resolveTargets(st, userRef, spec, picks[i] ?? null, rng));

    if (move) {
      const run = {
        record: move.id, self: userRef, source: userRef, other: null,
        groups: hits, alive: aliveNow(st), picked: null, raised: null, card: null, draws: 0,
        status: null,
        cast: { move, paid, payer: payerRef },
      };
      runSteps(ctx, run, move.cast);
      // Cast a second time where something echoes it, for a share of the first
      // and leaving echoes of whatever the first left.
      const echo = echoFrac(actor.statuses, (i) => worthOf(actor, i));
      if (echo > 0 && !actor.fainted && st.winner === -1 && !st.rewound) {
        ctx.events.push({
          text: `${move.name} happens again.`,
          kind: "spell", at: userRef, moveId: move.id,
        });
        runSteps(ctx, { ...run, alive: aliveNow(st), scale: echo, chrono: true }, move.cast);
      }
    } else if (basic) {
      // Still a basic attack to everything watching for one: its hits are no
      // spell, and it answers `when it makes a basic attack`. Nothing echoes it.
      runSteps(ctx, {
        record: basic.id, self: userRef, source: userRef, other: null,
        groups: hits, alive: aliveNow(st), picked: null, raised: null, card: null, draws: 0,
        status: null, cast: { move: basic, paid: 0 }, basic: true,
      }, basic.cast);
    } else {
      basicAttack(ctx, userRef, hits[0] ?? []);
    }

    // Whoever the action was aimed at is the far side of it, so a passive
    // watching for a basic attack can leave a mark on what was struck.
    const struck = hits[0]?.[0] ?? null;
    fire(ctx, userRef, c.kind === "spell" ? { on: "use-ability" } : { on: "basic-attack" }, struck);
  }

  // A round that wound the battle back is over where it was wound back: the
  // end of it belongs to a turn that no longer happened.
  if (st.rewound) {
    delete st.rewound;
    delete st.undoing;
    return events;
  }
  endOfTurn(ctx);
  putBack(ctx);
  for (const side of [0, 1] as const) closeRanks(st, side);
  // The traveller came back for one round, and this was it: it rides away and
  // the rounds it has left play themselves out before anyone is asked again.
  if (st.travelling && !replaying) rideAway(ctx);
  if (st.travelling) playBackRounds(ctx);
  // Catches a battle that opened with a side already down, since nothing
  // fainted this turn to notice it.
  checkWipe(ctx);
  return events;
}

/**
 * Travelling: the battle goes back and the caster stands in that time as a
 * visitor. The round it left ends there. Next round the visitor picks a move
 * like anybody else while everyone around it repeats what they chose, and the
 * rounds after that play themselves out.
 *
 * The visitor is a copy on a spare mark rather than the Scoba itself, because
 * the Scoba itself is already standing there, three rounds younger. Everything
 * reaches it while it is there, and it is taken off the field once the rounds
 * have been played. What happens to it happens to the Scoba it came from: a
 * visitor that falls in the past is a Scoba that fell.
 */
function travel(ctx: Ctx, run: Run, turns: number, discount: number, art?: string): void {
  const st = ctx.st;
  const caster = combatantAt(st, run.self);
  const move = run.cast?.move;
  if (!caster || !move) return;
  // A journey is one round's worth of effect, however complicated, and a
  // battle gets one. Taking the move away is how a Scoba is stopped from
  // reaching for a second, but that is a rule about moves and this is the
  // effect itself: anything that reaches it another way stops here. Winding
  // back inside a wind-back would leave the battle standing in a turn neither
  // journey came from, with two sets of rounds waiting to play again.
  if (st.travelled || st.travelling) {
    ctx.events.push({ text: "That journey has already been made.", kind: "info" });
    return;
  }
  // A visitor is a copy of one Scoba standing on one spare mark, and a fusion
  // is two Scobas casting through a third body, which a copy cannot be.
  if (caster.fusion) {
    ctx.events.push({ text: "A fusion cannot make the journey.", kind: "info" });
    return;
  }
  // One round further back than it travels: the round it is leaving is not one
  // of the rounds played again, so two rounds on file are the fewest that leave
  // anything to play. Counted before anything is wound back: winding back and
  // then giving up left the battle standing in the turn it had landed in, with
  // the round it came from still playing out on top of it.
  if ((st.history ?? []).length < 2) {
    ctx.events.push({ text: "There is no time to go back to.", kind: "info" });
    return;
  }
  const undone = rewind(st, turns + 1);
  const left = undone.slice(0, -1);
  // Set before anything is played again, so a journey recorded in one of those
  // rounds is refused rather than made twice.
  st.travelled = true;
  const side = run.self.side;
  const visitor: Combatant = {
    ...structuredClone(caster), aside: true, blocking: false, ...(discount > 0 ? { costOff: discount } : {}),
  };
  const index = st.teams[side].length;
  st.teams[side].push(visitor);
  st.active[side][TRAVEL_SLOT] = index;
  st.travelling = {
    left, visitor: { side, index }, seat: run.self,
    ...(art !== undefined ? { art } : {}),
  };
  ctx.events.push({
    text: `${displayName(caster.scoba)} steps back ${left.length} turn${left.length === 1 ? "" : "s"}.`,
    kind: "travel",
    way: "out",
    at: { side, index },
  });
  // One journey a battle, for everyone: what is left of the move is a shard.
  st.spent = move.id;
  for (const team of st.teams) for (const c of team) spendJourney(st, c);
  // The round it left is over: what came after it happened in a past that is
  // gone, and the next round is the first of the ones being played again.
  st.rewound = true;
}

/**
 * Takes the journey move off a Scoba, once one has been made. Called for a
 * Scoba that joins afterwards as well as for everyone standing at the time, so
 * a latecomer is never offered a move the battle will not let it cast.
 */
export function spendJourney(st: BattleState, c: Combatant): void {
  const spent = st.spent;
  if (spent === undefined) return;
  c.scoba.moves.forEach((id, at) => {
    if (id === spent) c.swapped = { ...c.swapped, [at]: TRAVEL_SPENT };
  });
  for (const [at, id] of Object.entries(c.swapped ?? {})) {
    if (id === spent) c.swapped![Number(at)] = TRAVEL_SPENT;
  }
}

/**
 * Plays the rounds a journey has left, with everyone repeating what they chose
 * and anything no longer legal simply not happening. The traveller's own choice
 * is the player's, and it is made in the first of those rounds; the rest play
 * themselves out.
 */
function playBackRounds(ctx: Ctx): void {
  const st = ctx.st;
  // Each round played here ends with a call back to this function, so the
  // rounds would nest one inside the next without a guard.
  if (replaying) return;
  replaying = true;
  try {
    while (st.travelling && st.travelling.left.length > 0 && !st.rewound) {
      if (st.winner !== -1 || st.outcome !== "") return;
      ctx.events.push(...resolveTurn(st, []));
    }
  } finally {
    replaying = false;
  }
  if (st.travelling && st.travelling.left.length === 0 && !st.rewound) delete st.travelling;
}

/** Set while `playBackRounds` is running the rounds a journey has left. */
let replaying = false;

/**
 * The traveller takes its seat back. What it is carrying is what Unwind is
 * carrying: it is the one that made the journey. Where the Scoba it left behind
 * fell in the meantime, there is no seat to take and Unwind is dead.
 */
/**
 * The traveller rides away, at the end of the one round it came back for. What
 * became of it there is its own business: whether it walked away or fell, the
 * Scoba the battle goes on with is the one that was already standing here, and
 * the past it changed is the past everyone now has.
 */
function rideAway(ctx: Ctx): void {
  const st = ctx.st;
  const journey = st.travelling;
  if (!journey || journey.gone) return;
  journey.gone = true;
  const visitor = combatantAt(st, journey.visitor);
  // One that fell back there is not riding anywhere, so nothing is shown and
  // its mark is simply cleared.
  if (visitor && !visitor.fainted) {
    if (journey.art !== undefined) {
      ctx.events.push({
        text: "", kind: "show", at: journey.visitor, to: [journey.visitor],
        visual: { kind: "show", art: journey.art, path: "liftoff", on: "self" },
      });
    }
    ctx.events.push({
      text: `${displayName(visitor.scoba)} rides back to its own turn.`,
      kind: "travel", way: "back", at: journey.visitor,
    });
  }
  // Its mark is cleared and it is counted as no longer standing, but it keeps
  // its place in the team. Taking it out renumbers everyone after it, and the
  // rounds still to be played again this round write their events against the
  // numbers as they are now: a Pawn called in one of them took the number the
  // traveller had just given up, and rode off in the machine in its place.
  const { side, index } = journey.visitor;
  const visitorAt = st.teams[side][index];
  if (visitorAt) visitorAt.fainted = true;
  st.active[side] = st.active[side].map((i) => (i === index ? -1 : i));
}

/** What a spent journey leaves in the slot it was cast from. */
const TRAVEL_SPENT = "time-shatter";

/**
 * Puts back what an `undo-round` step held, once the round has played out. A
 * Scoba that fell in the meantime is left where it fell: what an undo answers
 * is damage that was survived.
 */
function putBack(ctx: Ctx): void {
  const held = ctx.st.undoing;
  if (!held) return;
  delete ctx.st.undoing;
  for (const u of held) {
    const c = ctx.st.teams[u.side][u.index];
    if (!c || c.fainted) continue;
    // Both of a fusion's bars go back, and so does which one was being hit: a
    // bar emptied this round is full again.
    if (u.bars && c.fusion) {
      c.fusion.hp = [...u.bars.hp];
      c.fusion.live = u.bars.live;
    }
    const back = Math.min(u.bars ? u.bars.hp[u.bars.live] : u.hp, combatantMaxHp(c));
    const moved = c.hp !== back || c.statuses.length !== u.statuses.length || u.bars !== undefined;
    c.hp = back;
    // The mark the undo wore comes off with the putting back: what it said was
    // that this was coming, and it has come.
    c.statuses = u.statuses.filter((held2) => held2.id !== u.mark);
    if (!moved) continue;
    ctx.events.push({
      text: `${displayName(c.scoba)} is as it was.`,
      kind: "status", at: { side: u.side, index: u.index }, hp: c.hp,
      ...barsAt(ctx.st, { side: u.side, index: u.index }),
    });
  }
}

/**
 * Which mark a Scoba was standing on when a round was filed. A choice names a
 * mark, but a target names a Scoba, so this is what turns one into the other.
 */
function markIn(field: number[], index: number): Slot | undefined {
  return ALL_SLOTS.find((slot) => field[slot] === index);
}

/**
 * A recorded target, aimed at whoever holds that mark now. What a Scoba aimed
 * at is the Scoba across from it, so where the one it picked has fallen and
 * another has taken the mark, the move lands on the one standing there.
 *
 * A target that was on no mark is left alone: it was never a mark that was
 * aimed at, and there is nothing to follow.
 */
function aimedAgain(record: TurnRecord, st: BattleState, pick: TargetRef | null): TargetRef | null {
  if (!pick) return null;
  const was = markIn(record.before.active[pick.side], pick.index);
  if (was === undefined) return pick;
  const now = st.active[pick.side][was] ?? -1;
  return now >= 0 ? { side: pick.side, index: now } : pick;
}

/** The same choice, aimed at the marks it was aimed at rather than at the Scobas. */
function recordedAgain(record: TurnRecord, st: BattleState, c: Choice): Choice {
  if (c.kind !== "spell" && c.kind !== "attack") return c;
  return { ...c, picks: c.picks.map((p) => aimedAgain(record, st, p)) };
}

/**
 * Sends on whoever walked onto an emptied mark before this round, where they
 * can still walk on. One that is already standing, or that fell earlier in this
 * timeline than it did in the last, simply does not.
 */
function fillRecorded(st: BattleState, record: TurnRecord, events: BattleEvent[]): void {
  // By mark rather than in the order they were picked. A co-op fight fills its
  // own marks as the player answers and the peer's as the message lands, so the
  // two clients file the same replacements in whichever order they arrived in.
  const order = [...(record.filled ?? [])].sort((a, b) => a.side - b.side || a.slot - b.slot);
  for (const f of order) {
    const bench = st.teams[f.side].findIndex((c) => c.scoba.uid === f.uid);
    if (bench < 0) continue;
    events.push(...sendIn(st, f.side, f.slot, bench));
  }
}

/**
 * The choices a round runs with. While a journey is being played out, the round
 * is one that already happened: everyone walks back on and repeats what they
 * chose, aimed at the marks they aimed at, and anything that cannot happen at
 * all simply does not. What the traveller does is whatever was asked for now.
 *
 * Every choice is attempted rather than checked against who made it. A move is
 * named on a mark, so a Scoba that walked on to replace the one that chose it
 * casts it too where it knows the same move.
 */
function withRecorded(st: BattleState, asked: Choice[], events: BattleEvent[]): Choice[] {
  const journey = st.travelling;
  if (!journey || journey.left.length === 0) return asked;
  const record = journey.left[0]!;
  journey.left = journey.left.slice(1);
  // Before the choices are read: what a round was chosen by is whoever was
  // standing once the replacements had walked on.
  fillRecorded(st, record, events);
  const mine = asked.filter((c) => {
    const at = markIn(st.active[c.side], journey.visitor.index);
    return c.side === journey.visitor.side && at !== undefined && c.slot === at;
  });
  const again = record.choices
    .filter((c) => !mine.some((m) => m.side === c.side && m.slot === c.slot))
    .map((c) => recordedAgain(record, st, c))
    .filter((c) => choiceError(st, c) === null);
  return [...again, ...mine];
}

/**
 * The battle as it stands, with its history left out: a snapshot is a round's
 * opening, and keeping the rounds before it inside it would nest one copy of
 * the battle inside the next.
 */
function snapshotOf(st: BattleState): Omit<BattleState, "history"> {
  const { history: _history, ...rest } = st;
  return structuredClone(rest);
}

/** Files this round so a later one can go back to it. */
function remember(st: BattleState, choices: Choice[]): void {
  const history = st.history ?? [];
  // Taken off the state before the snapshot, so a round is filed with the
  // replacements that walked on for it rather than carrying them into the next.
  const filled = st.filling;
  delete st.filling;
  history.push({
    turn: st.turn,
    before: snapshotOf(st),
    choices: structuredClone(choices),
    ...(filled && filled.length > 0 ? { filled } : {}),
  });
  while (history.length > REWIND_KEEP) history.shift();
  st.history = history;
}

/**
 * Puts the battle back to how it stood `turns` rounds ago and hands back the
 * rounds that were undone, newest last, so a caller can play them again.
 *
 * Nothing is left of what happened in between: the state is replaced field by
 * field rather than patched, since a rewind that kept anything would be a
 * rewind with a hole in it. Where the battle has not run that many rounds yet,
 * it goes back as far as it has.
 */
export function rewind(st: BattleState, turns: number): TurnRecord[] {
  const history = st.history ?? [];
  if (history.length === 0 || turns < 1) return [];
  const at = Math.max(0, history.length - turns);
  const record = history[at]!;
  const undone = history.slice(at);
  const back = structuredClone(record.before);
  for (const key of Object.keys(st) as (keyof BattleState)[]) {
    if (key !== "history") delete (st as unknown as Record<string, unknown>)[key];
  }
  Object.assign(st, back);
  st.history = history.slice(0, at);
  return undone;
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
 * Deals one card onto a hand and settles it the moment it lands. A hand that
 * reaches twenty one, an Ace counting 1 or 11, pays out and clears. One that
 * goes over busts and clears with nothing, which is what makes a big card a risk
 * rather than a bonus.
 */
function dealCard(
  ctx: Ctx, userRef: TargetRef, at: TargetRef, payoff: number, hand: string, drawn: DrawnCard,
): void {
  const target = combatantAt(ctx.st, at);
  const user = combatantAt(ctx.st, userRef);
  if (!target || !user || target.fainted) return;
  const { card, face } = drawn;
  const held = target.statuses.find((s) => s.id === hand);
  const settled = addToHand({ count: held?.stacks ?? 0, ace: held?.ace === true }, card);
  const cards = [...(held?.faces ?? []), { art: face.art, changes: face.changes.map((c) => ({ ...c })) }];
  ctx.events.push({
    text: `${displayName(target.scoba)} is dealt the ${card.label}.`,
    kind: "card",
    at,
    by: userRef,
    face,
    count: settled.settles === "holds" ? settled.best : BLACKJACK,
    cards,
  });
  if (settled.settles === "pays") {
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
  if (settled.settles === "busts") {
    forgetHand(target, hand);
    ctx.events.push({
      text: `${displayName(target.scoba)} busts at ${settled.count}.`,
      kind: "status",
      at,
    });
    return;
  }
  if (held) {
    // The card joins the hand already there. Inflicting it again would read
    // the old count out as the new one before the card was added to it.
    held.stacks = settled.hand.count;
    if (settled.hand.ace) held.ace = true;
    held.faces = cards;
    ctx.events.push({
      text: `${displayName(target.scoba)} is holding ${settled.best}.`,
      kind: "status",
      at,
      by: userRef,
      status: hand,
    });
    return;
  }
  inflict(ctx, at, hand, userRef);
  const now = target.statuses.find((s) => s.id === hand);
  if (now) {
    now.stacks = settled.hand.count;
    if (settled.hand.ace) now.ace = true;
    now.faces = cards;
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
      const c = index >= 0 ? st.teams[side][index] : undefined;
      // The halves of a fusion are not on the field: the fusion is, once.
      if (c && !c.fainted && c.fusedInto === undefined) fn({ side, index });
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
    // One called up this turn fights its first turn on the mana it arrived
    // with, rather than on that and the turn's as well.
    if (c.calledOn === st.turn) return;
    // A fusion gains its turn's mana in its first bar like anyone gains it in
    // their one. What fills the second is its passive's business.
    const bar = fusionHalves(st, c)[0] ?? c;
    bar.mana = Math.min(MAX_MANA, bar.mana + MANA_PER_TURN);
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
      // A half's HP is its fusion's to keep now, in a bar sized as it fused.
      if (c.fusedInto === undefined) c.hp = Math.min(c.hp, combatantMaxHp(c));
    }
  }
  tickFields(ctx);
  tickGround(ctx);
  // A status that ran out can have been what was making others stronger.
  refreshWorth(st);
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
  return s.nickname ?? speciesName(s);
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
  /** Who left it, for anything drawn in that Scoba's colours. */
  from?: TargetRef;
  /**
   * For a status that moves stats by its power: what it is moving them by on
   * this Scoba right now, every stack in, and which stats.
   */
  shift?: {
    amount: number; stats: StatName[];
    /** What it comes to before anything boosts it, over how many stacks, and each stack's share where they match. */
    written: number; stacks: number; perStack?: number;
  };
  /** What is making it worth more or less than written on this Scoba, by name. */
  boosts?: { name: string; mult: number }[];
}

/** What a status's power moves its holder's stats by right now, the way the stats read it. */
function powerShift(c: Combatant, id: string): StatusMark["shift"] | undefined {
  const moves = STATUSES[id]?.effects.filter((e) => e.kind === "stat-power") ?? [];
  const stats = [...new Set(moves.map((e) => (e.kind === "stat-power" ? e.stat : "hp")))];
  if (stats.length === 0) return undefined;
  let amount = 0;
  let written = 0;
  let stacks = 0;
  const shares = new Set<number>();
  for (const inst of c.statuses) {
    if (inst.id !== id) continue;
    // One stat's worth: every stat a status moves by its power moves the same.
    const read = continuousEffects([inst], (i) => worthOf(c, i)).find((r) => r.effect.kind === "stat-power");
    if (read?.effect.kind !== "stat-power") continue;
    amount += read.power * read.effect.mult * read.stacks;
    const share = (inst.power ?? 0) * read.effect.mult;
    written += share * read.stacks;
    stacks += read.stacks;
    shares.add(Number(share.toFixed(6)));
  }
  const [perStack] = shares.size === 1 ? [...shares] : [];
  return { amount, stats, written, stacks, ...(perStack !== undefined ? { perStack } : {}) };
}

/**
 * What one of a mark's numbers comes to on the Scoba carrying it right now,
 * with the arithmetic behind it. The readouts say the number rather than the
 * share it is of something, and the window over a sigil shows the working.
 *
 * Read after the holder's armor and before blocking, since blocking is a choice
 * made in the round rather than a property of the mark.
 */
export interface MarkNumber {
  kind: "damage" | "heal";
  /** The step in the status it is the number for, so a description can say it in place. */
  step: StatusEffect;
  /** What it comes to, which is what the readout says. */
  amount: number;
  /**
   * Where it starts, before any multiple. Kept unrounded, so the steps shown
   * under it multiply out to the amount rather than to one off it.
   */
  raw: number;
  element: ElementType | null;
  category: DamageCategory;
  /** The share it takes of its basis, as a fraction. */
  share: number;
  /**
   * The stat it is read off and what that stat stood at when the number was
   * measured. For a mark that fixed its number as it landed, that is the stat
   * as it was then rather than as it is now: reading it live left the two rows
   * contradicting each other once the caster's stat moved.
   */
  basis: { label: string; value: number } | null;
  /** What the holder's armor took, as a multiple, or null where nothing did. */
  armor: { label: string; value: number; mult: number } | null;
  /** Half again where the Scoba that left it shares the element, else 1. */
  synergy: number;
  /** Which of the caster's elements earned that, where one did. */
  casterMatch: ElementType | null;
  /** The chart, against whoever is carrying it. */
  elemental: number;
  /** Fixed when it landed, so it does not move with the caster afterwards. */
  snapshot: boolean;
}

/**
 * Every number a mark is carrying for the Scoba it is on. A mark that does
 * nothing by the numbers has none, which is most of them.
 */
export function markNumbers(st: BattleState, ref: TargetRef, inst: StatusInstance): MarkNumber[] {
  const def = STATUSES[inst.id];
  const holder = combatantAt(st, ref);
  if (!def || !holder) return [];
  const out: MarkNumber[] = [];
  // What the field and the holder's own statuses make this one worth right now.
  const worth = worthOf(holder, inst);
  // A passive was left by nobody, so it reads its own stats as the source's.
  const from = inst.from ?? (def.innate ? ref : null);
  const fired = allSteps([
    ...def.effects.filter((e): e is Step => !isContinuous(e.kind)),
    ...(def.also ?? []).flatMap((b) => b.steps),
  ]);
  for (const e of fired) {
    // Only what lands on the holder can be measured against the holder.
    if (e.kind === "damage" && e.to === "self") {
      const d = e.damage;
      const raw = d.snapshot && inst.power !== undefined
        ? inst.power
        : basisOf(st, d.basis, ref, from) * d.frac;
      const steps = markDamageSteps(st, ref, from, d, holder);
      out.push({
        kind: "damage",
        step: e,
        amount: Math.max(1, Math.floor(
          raw * steps.synergy * steps.elemental * steps.armorMult * (inst.scale ?? 1) * worth,
        )),
        raw,
        element: d.element,
        category: d.category,
        share: d.frac,
        basis: basisStat(st, d.basis, ref, from,
          d.snapshot === true && d.frac > 0 ? raw / d.frac : null),
        armor: d.category === "true" ? null : {
          label: STAT_LABELS[d.category === "physical" ? "def" : "res"],
          value: steps.armor,
          mult: steps.armorMult,
        },
        synergy: steps.synergy,
        casterMatch: steps.casterMatch,
        elemental: steps.elemental,
        snapshot: d.snapshot === true,
      });
    }
    if (e.kind === "heal" && (e.to === "self" || e.basis.startsWith("source-"))) {
      const raw = basisOf(st, e.basis, ref, from) * e.frac;
      out.push({
        kind: "heal",
        step: e,
        amount: Math.max(1, Math.floor(raw * (inst.scale ?? 1) * worth)),
        raw,
        element: null,
        category: "true",
        share: e.frac,
        basis: basisStat(st, e.basis, ref, from, null),
        armor: null,
        synergy: 1,
        casterMatch: null,
        elemental: 1,
        snapshot: false,
      });
    }
  }
  return out;
}

/**
 * Everything that stands between a mark's power and what its holder loses.
 * The sim applies these and the readout shows them, from the one function, so
 * the working under a sigil is the arithmetic that actually ran.
 *
 * A mark lands like a move does: half again where the Scoba that left it shares
 * the element, then the chart against whoever is carrying it, then that Scoba's
 * armor. Blocking is not here, because blocking is a choice made in the round.
 */
export function markDamageSteps(
  st: BattleState,
  holderRef: TargetRef,
  from: TargetRef | null,
  d: { element: ElementType; category: DamageCategory },
  holder: Combatant,
): { synergy: number; elemental: number; armorMult: number; armor: number; casterMatch: ElementType | null } {
  const armor = armorAgainst(d.category, holder);
  // True damage is a flat number by definition: it meets no armor, and the
  // chart is a defense like any other, so it meets that neither.
  if (d.category === "true") {
    return { synergy: 1, elemental: 1, armorMult: 1, armor: 0, casterMatch: null };
  }
  const caster = from ? combatantAt(st, from) : null;
  const own = caster ? scobaTypes(caster.scoba) : [];
  const match = own.includes(d.element) ? d.element : null;
  return {
    synergy: match ? 1.5 : 1,
    elemental: typesEffectiveness([d.element], scobaTypes(holder.scoba)),
    armorMult: mitigation(armor),
    armor,
    casterMatch: match,
  };
}

/**
 * The stat a basis reads and what it stood at when the number was taken. `held`
 * is what it worked out to for a mark that fixed its number as it landed, which
 * is the only record of the stat as it was then.
 */
function basisStat(
  st: BattleState, basis: Basis, holderRef: TargetRef, from: TargetRef | null, held: number | null,
): { label: string; value: number } | null {
  const value = Math.round(held ?? basisOf(st, basis, holderRef, from));
  // The script's own two words for whose stat a number is read off, so the
  // window and the line that authored it name the same thing.
  const whose = basis.startsWith("source-") ? "Source's" : "Holder's";
  switch (basis) {
    case "source-str": case "holder-str": return { label: `${whose} ${STAT_LABELS.str}`, value };
    case "source-mag": case "holder-mag": return { label: `${whose} ${STAT_LABELS.mag}`, value };
    case "source-max-hp": case "holder-max-hp": return { label: `${whose} max HP`, value };
    case "holder-hp": return { label: "Health left", value };
  }
}

/** A status that holds nothing and only acts as its holder arrives, or never. */
function onEntryOnly(def: StatusDef): boolean {
  if (def.effects.some((e) => isContinuous(e.kind)) || def.basicAttack !== undefined) return false;
  // Carried only to show its sigil, such as one that hands over a move: it does nothing on entry.
  if (def.effects.length === 0 && (def.also ?? []).length === 0 && def.fuses === undefined) return false;
  const entry = (on: string): boolean => on === "switch-in" || on === "battle-start" || on === "passive";
  return entry(def.trigger.on) && (def.also ?? []).every((b) => entry(b.trigger.on));
}

export function statusSummary(c: Combatant): StatusMark[] {
  const out: StatusMark[] = [];
  for (const inst of c.statuses) {
    // A passive is read on the row like any other mark while it has something
    // left to do: an effect it holds the whole time, or a trigger that can go
    // off again. One that acts as the Scoba enters and never again has nothing
    // to show. A status written with no sigil, like Hyper-Mode, never shows.
    const def = STATUSES[inst.id];
    if (def?.unseen) continue;
    if (def?.innate && onEntryOnly(def)) continue;
    const found = out.find((o) => o.id === inst.id);
    if (found) {
      found.stacks += inst.stacks;
      found.turnsLeft = Math.max(found.turnsLeft, inst.turnsLeft);
      found.chargesLeft = Math.max(found.chargesLeft, inst.chargesLeft);
      continue;
    }
    const boosts = worthBy(c, inst);
    out.push({
      id: inst.id,
      name: statusName(inst.id),
      stacks: inst.stacks,
      turnsLeft: inst.turnsLeft,
      chargesLeft: inst.chargesLeft,
      ...(inst.from ? { from: inst.from } : {}),
      ...(boosts.length > 0 ? { boosts } : {}),
    });
  }
  // What somebody standing on the field is doing to this one's statuses, shown
  // for as long as it reaches it. Nothing is carried for it: it is read off the
  // field, so it goes the moment whoever is doing it leaves.
  const reached = new Map<string, number>();
  for (const id of c.worth?.shown ?? []) reached.set(id, (reached.get(id) ?? 0) + 1);
  for (const [id, sources] of reached) {
    if (out.some((o) => o.id === id)) continue;
    out.push({ id, name: statusName(id), stacks: sources, turnsLeft: -1, chargesLeft: -1 });
  }
  for (const mark of out) {
    const shift = powerShift(c, mark.id);
    if (shift) mark.shift = shift;
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
  parts.push(`g${st.ground.map((p) => `${p.side}.${p.slot}:${p.status.id}:${p.status.turnsLeft}`).sort().join(",")}`);
  for (const side of [0, 1] as const) {
    const f = st.fields[side];
    parts.push(`f${f ? `${f.id}:${f.turnsLeft}` : "-"}`);
    parts.push(`a${st.active[side].join(",")}`);
    st.teams[side].forEach((c, i) => {
      const cds = Object.entries(c.cds).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).sort().join(",");
      // A hand names every card in it, so two clients that drew different
      // cards or colors are caught even where the counts agree.
      const faceOf = (s: StatusInstance): string => (s.faces
        ? `:${s.faces.map((f) => `${f.art}${f.changes.map((ch) => `/${ch.from}>${ch.to}`).join("")}`).join(";")}${s.ace ? "+ace" : ""}`
        : "");
      const sts = c.statuses.map((s) => `${s.id}:${s.stacks}:${s.turnsLeft}:${s.chargesLeft}${faceOf(s)}`).sort().join(",");
      const spent = [...c.spent].sort().join(",");
      const bars = fusionBars(c);
      const fused = bars ? `F${bars.map((b) => `${b.hp}/${b.max}`).join(";")}` : c.fusedInto !== undefined ? `f${c.fusedInto}` : "";
      parts.push(`${side}.${i}:${c.hp}/${c.mana}${c.blocking ? "b" : ""}${c.fainted ? "x" : ""}${c.hyper ? "H" : ""}${fused}[${cds}]<${spent}>{${sts}}`);
    });
  }
  return String(hashSeed(parts.join("|")));
}
