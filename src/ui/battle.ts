import type { Art } from "../engine/assets";
import { sfx } from "../engine/sfx";
import { STAT_LABELS, TYPE_COLORS, TYPE_LABELS, type ElementType } from "../sim/types";
import {
  startBattle,
  resolveTurn,
  joinBattle,
  benchFor,
  slotOf,
  slotsAwaitingChoice,
  stateHash,
  emptySlots,
  sendIn,
  choiceError,
  formsOf,
  markNumbers,
  castableMoves,
  heldMoves,
  hyperError,
  moveReady,
  HYPER_COST,
  displayName,
  combatantMaxHp,
  statusSummary,
  specsFor,
  targetOptions,
  itemsOnHand,
  spendItem,
  previewMove,
  castCost,
  combatantStats,
  selfRunning,
  actingAs,
  actingRef,
  actingSpeed,
  basicAttackOf,
  fusionBars,
  BASIC_ATTACK_TARGETS,
  type BattleEvent,
  type BattleState,
  type Choice,
  type Combatant,
  type OwnerId,
  type SlotHolder,
} from "../sim/battle";
import {
  ALL_SLOTS, TARGET_LABELS, isFusionSlot, isPawnSlot, isTravelSlot, needsPick, sameRef,
  type TargetRef, type TargetSpec,
} from "../sim/targeting";
import { statusName, type StatusInstance } from "../sim/status";
import { restoreDerived } from "../sim/rewrite";
import { abilityText, moveText } from "../game/texts";
import { proseBox, proseNodes } from "./prose";
import { fieldSigilText, sigilText, sigilUrl, type SigilText } from "./sigil";
import { BUILD_VERSION, devMode } from "../version";
import { fitWindow } from "./fit";
import { startReplay, stopReplay, takeReplay } from "../sim/replay";
import { enemyChoices, pawnChoices } from "../sim/ai";
import { PeerChoices, type BattleNet, type NetBattle } from "../net/battlelink";
import { rngFrom } from "../sim/rng";
import { kitted } from "../sim/kit";
import { gainXp, MAX_LEVEL, maxHp, moveName, scobaTypes, settleCaught, type ScobaInstance } from "../sim/scoba";
import { AETUS_PER_TRAINER, AETUS_PER_WILD } from "../sim/growth";
import { ABILITIES, abilityStatuses, MAX_MOVES, MOVES, SPECIES, type Move } from "../sim/species";
import { BattleStage } from "../game/battlestage";
import { frameRect, uiZoom, viewport } from "../engine/renderer";
import { typeIcon, typeIcons } from "./typeicon";
import { actButton, moveSub, type ActOpts } from "./actbutton";
import { countMark } from "./countmark";
import { workRows } from "./working";
import { critterPortrait, lookOf } from "../game/critters";
import type { SaveData } from "../save/save";
import { addToParty, autosave, partyOf, writeSave } from "../save/save";
import type { UI } from "./screens";

export interface BattleResult {
  outcome: "win" | "loss" | "caught" | "fled";
}

/**
 * The running fight's scene, handed to main so the frame loop can drive it.
 * Null once the battle closes.
 */
let liveStage: BattleStage | null = null;

/**
 * The running battle's network handle, so the session can push a peer's
 * choices into it without threading a reference through the overworld.
 */
let livePeer: NetBattle | null = null;

export function battleStage(): BattleStage | null {
  return liveStage;
}

export function netBattle(): NetBattle | null {
  return livePeer;
}

/**
 * The handle a running co-op battle hands back to the overworld, so the other
 * player can walk to the fight and join it. Solo battles return none: both
 * characters are already in.
 */
export interface ActiveBattle {
  /** The character who started the fight. */
  host: OwnerId;
  /** The character whose slot is still open, or null once nobody can join. */
  guest(): OwnerId | null;
  /**
   * Brings that character in. A request that lands mid-round is held until
   * the round resolves. False means they cannot join at all.
   */
  join(owner: OwnerId): boolean;
}

interface BattleSetup {
  enemies: ScobaInstance[];
  wild: boolean;
  /** Shown as the win title and credited for the money reward. */
  trainerName?: string;
  rewardMoney?: number;
  /**
   * Both sides fight at this level. The party goes in as copies set to it, so
   * the fight is about the Scobas rather than the grind and the real party
   * comes out exactly as it went in.
   */
  levelCap?: number;
  /**
   * The party goes in with a hobby and teas picked to suit each Scoba, the way
   * whoever it is fighting was built. Only ever set beside `levelCap`, since
   * both are what makes a practice bout a fair one.
   */
  kit?: boolean;
  onDone: (result: BattleResult) => void;
}

const OTHER: Record<OwnerId, OwnerId> = { A: "B", B: "A" };

/**
 * How much of the screen the action block takes, and how wide it ever gets.
 * Three rows fit inside it whatever page is up, which is what keeps a page from
 * moving the buttons or the scene above them. Wide and shallow: a button that
 * is as tall as it is broad reads as a tile rather than as something to press.
 */
/** How many rows of buttons the action block is, on every page, beside the message box. */
const BUTTON_ROWS = 2;
const BAR_SHARE = 0.4;
const BAR_MAX_W = 1120;

/** Bag entries that do something in a battle. Everything else stays put. */
const BATTLE_ITEMS: { id: string; name: string; desc: string; wildOnly: boolean }[] = [
  { id: "snare", name: "Snare", desc: "Throw it at a wild Scoba to catch it.", wildOnly: true },
];

export function openWildBattle(
  ui: UI,
  art: Art,
  save: SaveData,
  wild: ScobaInstance,
  onDone: (result: BattleResult) => void,
  net: BattleNet | null = null,
): ActiveBattle | null {
  return runBattle(ui, art, save, { enemies: [wild], wild: true, onDone }, net);
}

export function openTrainerBattle(
  ui: UI,
  art: Art,
  save: SaveData,
  setup: { name: string; enemies: ScobaInstance[]; reward: number; levelCap?: number; kit?: boolean },
  onDone: (result: BattleResult) => void,
  net: BattleNet | null = null,
): ActiveBattle | null {
  return runBattle(ui, art, save, {
    enemies: setup.enemies,
    wild: false,
    trainerName: setup.name,
    rewardMoney: setup.reward,
    ...(setup.levelCap !== undefined ? { levelCap: setup.levelCap } : {}),
    ...(setup.kit === true ? { kit: true } : {}),
    onDone,
  }, net);
}

function runBattle(
  ui: UI,
  art: Art,
  save: SaveData,
  setup: BattleSetup,
  net: BattleNet | null = null,
): ActiveBattle | null {
  const { enemies, onDone } = setup;
  // Solo puts both characters in from the start and the one player picks for
  // both. With a second player connected only the character who walked into
  // the fight starts, and the other joins from the overworld. A link is what
  // says which this is: there is one exactly when somebody is on the other end
  // to hand the second character to.
  const coop = net !== null;
  const localOwner = save.localSlot;
  const guestOwner = OTHER[localOwner];
  const fighters: OwnerId[] = coop ? [localOwner] : ["A", "B"];

  // Slot 0 is always character A and slot 1 always character B, so two
  // clients building the same battle agree on which slot is whose.
  const owners: [SlotHolder, SlotHolder] = [
    fighters.includes("A") ? "A" : null,
    fighters.includes("B") ? "B" : null,
  ];
  const cap = setup.levelCap;
  const kitRng = rngFrom(`${save.worldSeed}:kit:${Date.now().toString(36)}`);
  const team = fighters
    .flatMap((owner) => partyOf(save, owner))
    // Copies rather than the party itself: what a capped match does to a Scoba,
    // levels, experience, hobby and teas included, is meant to stay in the match.
    .map((s) => (cap === undefined ? s : { ...s, level: cap, hp: maxHp({ ...s, level: cap }) }))
    .map((s) => (setup.kit === true ? kitted(s, kitRng) : s));
  // The guest is handed the fight as it stands rather than rebuilding it: it
  // may have walked in several rounds late, and only the host was there for
  // what happened before that.
  const st = net?.adopted ?? startBattle(
    `${save.worldSeed}:${Date.now().toString(36)}`,
    team, enemies, { slots: 2, wild: setup.wild, owners, ez: save.ez },
  );
  // A fight handed over part way through can name moves a step rewrote on the
  // host before this client arrived.
  restoreDerived(st);
  // Whoever is working on the game records every fight, so a bug can be handed
  // over as a file rather than as a description of what it looked like.
  if (devMode()) startReplay(BUILD_VERSION);
  const seed = st.seed;
  // Local player's Scoba reads first, whichever character they control.
  const displayOrder: (0 | 1)[] = localOwner === "A" ? [0, 1] : [1, 0];
  /** Which order the slots are asked about in: Scobas first, Pawns after. */
  const askOrder = (slot: number): number =>
    isPawnSlot(slot) || isTravelSlot(slot) ? 10 + slot : displayOrder.indexOf(slot as 0 | 1);

  // Taken from the state rather than from who started it: a guest walking into
  // a fight already in progress has the host standing in it, and building the
  // stage from `fighters` alone left them invisible on the guest's screen.
  const onStage = (["A", "B"] as OwnerId[]).filter((o) => st.slotOwner.includes(o));
  const stage = new BattleStage(art, st, save, {
    fighters: onStage.length > 0 ? onStage : fighters,
    trainer: setup.trainerName !== undefined,
  });
  stage.onFrame = () => { positionPlates(); paintFlash(); };
  stage.onRoster = () => rebuildPlates();
  liveStage = stage;

  const participated = new Set<number>();
  let busy = false;
  /** Choices picked so far this round, one per slot still in the fight. */
  let staged: Choice[] = [];
  let roundSlots: number[] = [];
  let pickIndex = 0;
  /** Slots waiting on a replacement, asked about between rounds. */
  let sendInSlots: number[] = [];
  let pendingJoin: OwnerId | null = null;
  /** Choices the peer has sent for this turn, keyed by turn so an early one keeps. */
  const peerChoices = new PeerChoices();
  /** Teams the peer sent with its join, keyed by character. */
  const joinTeams = new Map<OwnerId, ScobaInstance[]>();
  /** Set once the local player has answered for every slot they own. */
  let localReady = false;
  /**
   * The action the current character has chosen but not yet aimed. Picking a
   * move opens this, and it closes once every target spec has an answer.
   */
  let aiming: { action: Choice; specs: TargetSpec[]; picks: (TargetRef | null)[]; at: number } | null = null;
  /** Which page of the action row the current character is looking at. */
  let menu: "main" | "abilities" | "handed" | "items" | "flee" = "main";

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const nameOf = (owner: SlotHolder): string =>
    owner === "A" || owner === "B" ? save.characters[owner].name : "";

  /**
   * A bar and the highlight trailing it. The fill snaps to the value the event
   * left behind and the highlight covers the ground between there and where
   * the bar stood, easing in until the two meet, so what a hit took reads as a
   * band draining out rather than as the whole bar sliding down.
   */
  const bar = (cls: string): {
    node: HTMLElement;
    set: (frac: number, trailFrac: number, opts?: { color?: string; spend?: number }) => void;
  } => {
    const node = el("div", `bbar ${cls}`);
    const fill = el("i");
    const trail = el("b");
    const spend = el("u");
    node.append(fill, trail, spend);
    const pct = (v: number): number => Math.max(0, Math.min(100, v * 100));
    return {
      node,
      set: (frac, trailFrac, opts) => {
        const now = pct(frac);
        const was = pct(trailFrac);
        fill.style.width = `${now}%`;
        trail.style.left = `${Math.min(now, was)}%`;
        trail.style.width = `${Math.abs(now - was)}%`;
        if (opts?.color) fill.style.background = opts.color;
        // Marked off the near end of the fill, so it reads as the part about
        // to go rather than as something the Scoba has.
        const take = Math.min(now, pct(opts?.spend ?? 0));
        spend.style.left = `${now - take}%`;
        spend.style.width = `${take}%`;
      },
    };
  };

  /**
   * The move under the pointer, so its cost can be marked out on the caster's
   * own mana bar before it is committed to. `bar` is which of a fusion's two
   * mana bars pays for it.
   */
  let costPreview: { index: number; cost: number; bar?: number } | null = null;

  /** Which of its fusion's bars a half pays from, where it is in one. */
  const halfIndex = (c: Combatant): number | undefined => {
    const body = actingAs(st, c);
    if (body === c || !body.fusion) return undefined;
    const i = body.fusion.parts.indexOf(st.teams[0].indexOf(c));
    return i >= 0 ? i : undefined;
  };

  /**
   * One sigil and the window that opens over it. The window is what tells a
   * field from a mark, since the two sit in the same row and only one of them
   * is actually on the Scoba.
   */
  const sigilMark = (id: string, said: SigilText, stacks: number): HTMLElement => {
    const mark = el("span", `mark ${id}`);
    const url = sigilUrl(id);
    if (url) {
      const img = el("img", "sig");
      img.src = url;
      img.alt = said.name;
      mark.appendChild(img);
    } else {
      mark.appendChild(el("span", "sig txt", said.name.slice(0, 2)));
    }
    if (stacks > 1) mark.appendChild(countMark(stacks));
    const tip = el("span", "sigtip");
    tip.appendChild(el("strong", undefined, said.name));
    if (said.desc) {
      const line = el("span");
      for (const part of said.said) {
        line.append(part.dmg ? el("span", `dmg ${part.dmg}`, part.text) : part.text);
      }
      tip.appendChild(line);
    }
    if (said.note) tip.appendChild(el("span", "dim", said.note));
    const work = workRows(said.working);
    if (work) {
      tip.appendChild(work);
      mark.classList.add("hasWork");
    }
    mark.appendChild(tip);
    // The readouts ride over the scene and reach its edges, so a window on
    // one out there is nudged back in rather than drawn off the screen.
    mark.addEventListener("pointerenter", () => fitWindow(tip));
    // Hovering says what the mark does; clicking holds the window open with
    // the working under it, so the numbers can be read without keeping the
    // pointer still. Clicking anywhere else puts it away.
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = mark.classList.contains("held");
      dropHeld();
      if (!open) {
        mark.classList.add("held");
        // The readouts are laid out overlapping and paint in the order they
        // were built, so the one holding a window open has to come over the
        // rest or its neighbour covers half of what it is saying.
        mark.closest(".bcard")?.classList.add("holding");
        fitWindow(tip);
      }
    });
    return mark;
  };

  /**
   * The field standing over a side, as the scene is showing it rather than as
   * the battle holds it, so the mark turns up with the wash instead of the
   * moment the round resolves.
   */
  const fieldMark = (side: 0 | 1): { id: string; turnsLeft: number } | null => {
    const id = stage.shownField(side);
    if (!id) return null;
    const live = st.fields[side];
    return { id, turnsLeft: live && live.id === id ? live.turnsLeft : -1 };
  };

  /**
   * The row of sigils under a card: the field over its side first, then what
   * the Scoba itself is carrying. They sit ghosted, since what the row is for
   * is knowing at a glance that something is on a Scoba rather than reading a
   * list mid-fight, and the one under the pointer comes up to full with a
   * small window saying what it is doing.
   */
  const fillMarks = (marks: HTMLElement, ref: TargetRef, want: ReturnType<typeof statusSummary>): void => {
    const side = ref.side;
    const field = fieldMark(side);
    const key = [
      field ? `@${field.id}:${field.turnsLeft}` : "@",
      ...want.map((m) => `${m.id}:${m.stacks}:${m.turnsLeft}`),
    ].join(",");
    if (marks.dataset["key"] === key) return;
    marks.dataset["key"] = key;
    marks.innerHTML = "";
    // The field leads the row: it is the one mark there that is on the side
    // rather than on the Scoba, and its window is what says so.
    if (field) marks.appendChild(sigilMark(field.id, fieldSigilText(field), 1));
    for (const m of want) {
      // Read off the Scoba the card belongs to, so the window says what the
      // mark comes to here rather than what share of something it is.
      const held = st.teams[ref.side][ref.index]?.statuses.find((inst) => inst.id === m.id);
      const on = held ? markNumbers(st, ref, held) : [];
      marks.appendChild(sigilMark(m.id, sigilText(m, on), m.stacks));
    }
  };

  /** Shifts a hover window sideways until it clears both edges of the screen. */

  /** The move under the pointer and who would cast it, so a readout can say what it would land at before it is picked. */
  let hoverMove: { move: Move; user: TargetRef } | null = null;

  /**
   * What the move being aimed, or the one under the pointer, would land at
   * against this one: the chart's multiple as a short mark, or null where
   * there is nothing to say. That is most of the time: nothing aimed, an
   * ally, a move that heals or lands flat off the chart (the basic attack is
   * one), or a chart that reads even. The number comes from the same preview
   * the cast would run, so a move the chart never touches never shows one.
   */
  const aimEffect = (c: Combatant, ref: TargetRef): { mult: number; label: string } | null => {
    let moveId: string;
    let user: TargetRef;
    if (aiming) {
      if (aiming.action.kind !== "spell") return null;
      const caster = at(0, aiming.action.slot);
      const from = caster ? actingRef(st, caster) : null;
      if (!from) return null;
      moveId = aiming.action.moveId;
      user = from;
    } else if (hoverMove) {
      moveId = hoverMove.move.id;
      user = hoverMove.user;
    } else {
      return null;
    }
    if (ref.side === user.side || c.fainted) return null;
    const p = previewMove(st, user, moveId, ref);
    if (!p || p.damage === null || p.eff === 1) return null;
    const mult = p.eff;
    const label = mult === 0 ? "×0"
      : mult >= 1 ? `×${mult}`
        : `×1/${Math.round(1 / mult)}`;
    return { mult, label };
  };

  /**
   * A Scoba's readout. It reads the stage's lagging copy rather than the
   * combatant, so a bar drops on the hit that caused it instead of emptying
   * the moment the round is resolved.
   */
  const card = (c: Combatant, ref: TargetRef): { node: HTMLElement; refresh: () => void } => {
    const wrap = el("div", "bcard");
    const nm = el("div", "nm");
    nm.appendChild(el("strong", undefined, displayName(c.scoba)));
    if (c.scoba.shiny) {
      const star = el("span", "shiny", "\u2605");
      star.title = "Shiny";
      nm.appendChild(star);
    }
    wrap.appendChild(nm);
    // Its own row, the same rule a Pawn's readout keeps: a badge is 41 px of
    // drawn art that cannot be shrunk, and inline with the name it sets the
    // panel's width rather than the name doing it. The level rides with the
    // badges rather than with the name, so the name has the whole row above
    // and reaches its ellipsis only when it is genuinely too long for one.
    const tline = el("div", "tline");
    tline.appendChild(typeIcons(c.scoba));
    tline.appendChild(el("span", "lv", `Lv ${c.scoba.level}`));
    wrap.appendChild(tline);
    const max = combatantMaxHp(c);
    // A fusion reads two of each, side by side, the first slot's on the left:
    // the left HP bar is the one a hit empties first.
    const pairs = c.fusion ? 2 : 1;
    const pairRow = (bars: ReturnType<typeof bar>[]): HTMLElement => {
      if (bars.length === 1) return bars[0]!.node;
      const row = el("div", "bpair");
      for (const b of bars) row.appendChild(b.node);
      return row;
    };
    const hpBars = Array.from({ length: pairs }, () => bar(""));
    const mpBars = Array.from({ length: pairs }, () => bar("mp"));
    // Both bars run the panel's full width, so a length means the same thing on
    // every readout on the field. The share rides in the footer instead, which
    // is a line the state already reserves.
    const state = el("span", "bnum", "");
    const mpNum = el("span", "bpct", "");
    const foot = el("div", "bfoot");
    foot.append(state, mpNum);
    const marks = el("div", "marks");
    wrap.append(pairRow(hpBars), pairRow(mpBars), foot, marks);

    const refresh = (): void => {
      const now = stage.shownOf(ref.side, ref.index);
      const rows = now.bars ?? [{
        hp: now.hp, hpTrail: now.hpTrail, max, mana: now.mana, manaTrail: now.manaTrail,
      }];
      rows.forEach((row, i) => {
        const frac = Math.max(0, Math.min(1, row.hp / Math.max(1, row.max)));
        hpBars[i]?.set(frac, row.hpTrail / Math.max(1, row.max), {
          color: frac < 0.25 ? "#d9553f" : frac < 0.55 ? "#e7a03c" : "#7aa74a",
        });
        const mine = ref.side === 0 && costPreview?.index === ref.index && (costPreview.bar ?? 0) === i;
        const spend = mine ? costPreview!.cost : 0;
        mpBars[i]?.set(row.mana / 100, row.manaTrail / 100, { spend: spend / 100 });
      });
      mpNum.textContent = rows.map((row) => `${row.mana}%`).join(" · ");
      // The bars say the numbers; this line is only for what they cannot,
      // and while a move is aimed, for what the chart says it would land at.
      const eff = now.fainted || c.blocking ? null : aimEffect(c, ref);
      state.textContent = now.fainted ? "Fainted" : c.blocking ? "Blocking" : eff ? eff.label : "";
      state.classList.toggle("good", eff !== null && eff.mult > 1);
      state.classList.toggle("poor", eff !== null && eff.mult < 1);
      fillMarks(marks, ref, now.marks);
    };
    refresh();
    return { node: wrap, refresh };
  };

  /** An empty ally slot still holds its place, so the two sides stay put. */
  const emptyCard = (label: string, note: string): HTMLElement => {
    const wrap = el("div", "bcard empty");
    wrap.appendChild(el("div", "own", label));
    wrap.appendChild(el("div", "sub", note));
    return wrap;
  };

  /**
   * A Pawn's readout: the same numbers, small enough that three of them behind
   * a Scoba read as a row of helpers rather than as a second interface. It
   * carries no owner line and no level, since a Pawn is always its summoner's
   * level and never anyone's to swap.
   */
  const pawnCard = (c: Combatant, ref: TargetRef): { node: HTMLElement; refresh: () => void } => {
    const wrap = el("div", "bcard bpawn");
    wrap.appendChild(el("div", "nm", displayName(c.scoba)));
    // No type badges: the card lines the foot of the field in a row of three
    // and has to stay short enough to fit between the front readouts and the
    // block. The target picker and the Extra window still say the type.
    const max = combatantMaxHp(c);
    const hpBar = bar("");
    const mpBar = bar("mp");
    const marks = el("div", "marks");
    wrap.append(hpBar.node, mpBar.node, marks);

    const refresh = (): void => {
      const now = stage.shownOf(ref.side, ref.index);
      const frac = Math.max(0, Math.min(1, now.hp / max));
      hpBar.set(frac, now.hpTrail / max, {
        color: frac < 0.25 ? "#d9553f" : frac < 0.55 ? "#e7a03c" : "#7aa74a",
      });
      mpBar.set(now.mana / 100, now.manaTrail / 100);
      fillMarks(marks, ref, now.marks);
    };
    refresh();
    return { node: wrap, refresh };
  };

  const at = (side: 0 | 1, slot: number): Combatant | null => {
    const idx = st.active[side][slot] ?? -1;
    return idx >= 0 ? st.teams[side][idx] ?? null : null;
  };


  let logEl: HTMLElement;
  /** What the banner is saying right now. Only ever one line, Pokemon-style. */
  let lastLine = { text: "", kind: "" };
  /** Who the pointer is over while aiming, from the field or from a readout. */
  let aimHover: TargetRef | null = null;
  /** One readout per slot, moved and refreshed each frame by the stage. */
  let plates: {
    side: 0 | 1;
    slot: number;
    /** Set when the readout belongs to a Scoba rather than an empty mark. */
    index: number | null;
    node: HTMLElement;
    refresh: () => void;
  }[] = [];

  /**
   * The canvas the near row is drawn on. It sits over the far readouts and
   * under the near ones, which is what keeps a big Pawn standing in front of a
   * Scoba from reading as something behind that Scoba's numbers.
   */
  const nearCanvas = (): HTMLCanvasElement => {
    const node = document.createElement("canvas");
    node.className = "bfront";
    stage.frontCanvas = node;
    return node;
  };

  /**
   * The readouts, one per slot, laid over the scene and moved under whoever
   * is standing there. They sit below the Scobas rather than in a bar at the
   * top, so a Scoba and its numbers read as one thing.
   */
  const buildPlates = (near: boolean): HTMLElement => {
    const layer = el("div", near ? "bplates near" : "bplates");
    for (const side of [0, 1] as const) {
      for (const slot of ALL_SLOTS) {
        // The near row is drawn on a canvas of its own over the far readouts,
        // so its readouts go in a layer over that canvas in turn.
        if ((isPawnSlot(slot) || isTravelSlot(slot)) !== near) continue;
        // Whoever the scene has on this mark, not whoever the battle does: a
        // Scoba downed this round is still standing there until its faint has
        // played, and its readout should fade out with it rather than
        // vanishing the moment the round resolves.
        const pawn = isPawnSlot(slot);
        // Both stand at the foot of the field, where a full readout does not
        // fit, so both are read off the short card.
        const small = pawn || isTravelSlot(slot);
        // A Pawn called this round is not on the stage yet, so its mark is read
        // off the battle instead. Its readout is built hidden and fades in with
        // the poof rather than turning up a beat after it.
        // The two halves of a fusion keep their marks off the field, and the
        // fusion's readout stands for both, so neither mark gets a card once the
        // scene has shown them fusing. Until then each keeps its own.
        const seated = st.teams[side][st.active[side][slot] ?? -1];
        if (seated?.fusedInto !== undefined && !seated.fainted && stage.fighterOn(side, slot) === null) continue;
        const index = stage.fighterOn(side, slot)
          ?? (small && (st.active[side][slot] ?? -1) >= 0 ? st.active[side][slot]! : null);
        const c = index === null ? null : st.teams[side][index];
        // The fusion's own mark holds nothing but a fusion, and no card waits on it.
        if (isFusionSlot(slot) && !c) continue;
        const owner = side === 0 && !small ? st.slotOwner[slot] ?? null : null;
        let built: { node: HTMLElement; refresh: () => void } | null = null;
        if (c && index !== null) {
          built = small ? pawnCard(c, { side, index }) : card(c, { side, index });
          markTarget(built.node, { side, index });
        } else if (small) {
          // An empty Pawn mark is nothing at all: no card holds its place,
          // because nothing is ever coming to fill it.
          continue;
        } else if (side === 0 && owner === null && coop) {
          built = { node: emptyCard("Open slot", "Waiting for a player"), refresh: () => {} };
        } else if (side === 0 && owner !== null && benchFor(st, 0, slot).length > 0) {
          built = { node: emptyCard(nameOf(owner), "Send one in"), refresh: () => {} };
        }
        if (!built) continue;
        built.node.classList.add("bplate");
        // A rebuild lands mid-round, so a readout for a Scoba that is still
        // walking on starts hidden and fades in on its own plate alpha rather
        // than appearing over an empty mark for a frame.
        const alpha = c && index !== null
          ? stage.fighterAlpha(side, index)
          : stage.slotAlpha(side, slot);
        if (alpha <= 0.02) built.node.style.visibility = "hidden";
        layer.appendChild(built.node);
        plates.push({ side, slot, index: c ? index : null, node: built.node, refresh: built.refresh });
      }
    }
    return layer;
  };

  /** Puts each readout under its Scoba and brings its numbers up to date. */
  /**
   * The action block takes the bottom third of the screen, three rows of
   * buttons deep, and the scene lays itself out in the rest. Its height is set
   * from the viewport rather than from what is in it, so no page moves it and
   * nothing on the field ever shuffles when one is opened.
   *
   * `innerHeight` is in screen pixels and the interface sits under a root zoom,
   * so the height goes in through that and comes back out of the rect.
   */
  const sizeActionBar = (): void => {
    const bar = document.querySelector(".bbottom");
    if (!(bar instanceof HTMLElement)) return;
    // Sized from the frame rather than the window: the frame is the box the
    // interface is laid out in, and it is the same box on every screen.
    const box = viewport().ui;
    const h = `${Math.round(box.h * BAR_SHARE)}px`;
    const w = `${Math.round(Math.min(box.w - 16, BAR_MAX_W))}px`;
    if (bar.style.height !== h) bar.style.height = h;
    if (bar.style.getPropertyValue("--bw") !== w) bar.style.setProperty("--bw", w);
    // The readouts hang under their fighters and the block is opaque, so the
    // room the scene is left has to cover a plate's height as well as the
    // block's. Measured rather than guessed: a plate is a different height on
    // a narrow screen, and a Pawn's is shorter than a Scoba's.
    const plateRoom = plates.reduce(
      (tallest, p) => Math.max(tallest, p.node.getBoundingClientRect().height),
      0,
    );
    stage.setSafeBottom(bar.getBoundingClientRect().height + plateRoom);
    // The Pawn row is spaced by what a Pawn's card actually came out at, not
    // by a world-unit constant: a world unit is worth a different number of
    // interface pixels on different screens, and the cards are the thing that
    // must not collide. Measured here because this already runs on every
    // resize and the cards are in the document by now.
    const pawnCardW = plates.reduce(
      (widest, p) => p.node.classList.contains("bpawn")
        ? Math.max(widest, p.node.getBoundingClientRect().width)
        : widest,
      0,
    );
    stage.setPawnCard(pawnCardW);
  };

  /** Carries the scene's screen flash across the layers sitting over the canvas. */
  const paintFlash = (): void => {
    const wash = stage.flashNow();
    if (!wash && !flashNode) return;
    if (!flashNode) {
      const screen = document.querySelector(".screen.stage");
      if (!screen) return;
      flashNode = el("div", "bflash");
      screen.appendChild(flashNode);
    }
    if (!wash) {
      flashNode.remove();
      flashNode = null;
      return;
    }
    flashNode.style.background = wash.color;
    flashNode.style.opacity = String(wash.alpha);
  };
  let flashNode: HTMLElement | null = null;

  const positionPlates = (): void => {
    // Before the `ready` check: the scene is laid out against this, so it has
    // to be known before the opening walk starts rather than after it.
    sizeActionBar();
    // Nothing is placed against a view the scene has not measured yet.
    if (!stage.ready()) return;
    // While a move is being aimed, a readout that cannot be picked goes dark
    // and the one under the pointer takes the highlight outline.
    const options = aiming ? aimOptions() : null;
    for (const p of plates) {
      if (!p.node.isConnected) continue;
      const ref = p.index === null ? null : { side: p.side, index: p.index };
      const viable = options !== null && ref !== null && options.some((r) => sameRef(r, ref));
      p.node.classList.toggle("dimmed", options !== null && !viable);
      p.node.classList.toggle("hot", viable && aimHover !== null && ref !== null && sameRef(aimHover, ref));
      const alpha = p.index === null
        ? stage.slotAlpha(p.side, p.slot)
        : stage.fighterAlpha(p.side, p.index);
      // Hidden rather than transparent, so a readout that is not on the field
      // yet cannot be clicked either.
      p.node.style.visibility = alpha <= 0.02 ? "hidden" : "visible";
      if (alpha <= 0.02) continue;
      p.node.style.opacity = alpha < 1 ? String(alpha) : "";
      const at = (p.index === null ? null : stage.fighterScreenPos(p.side, p.index))
        ?? stage.slotScreenPos(p.side, p.slot);
      // The scene is measured in screen pixels and the readouts live in the
      // interface, which is scaled to the pixel grid, so the point has to be
      // put back into the interface's own units before it is used.
      const z = uiZoom();
      p.node.style.transform =
        `translate(${Math.round(at.x / z)}px, ${Math.round(at.y / z) + 6}px) translateX(-50%)`;
      p.refresh();
    }
  };

  /**
   * Rebuilds the readout layer alone, in place. A Scoba switched in mid-round
   * and a replacement sent on between rounds both arrive long after the page
   * was drawn, and a plate is built from whoever the stage has at the moment it
   * is built, so without this they fight the rest of the round with no readout.
   * Only the layer is replaced: re-rendering the screen from here would take
   * the action row out from under whoever is pressing it.
   */
  const rebuildPlates = (): void => {
    const far = document.querySelector(".screen.stage > .bplates:not(.near)");
    const near = document.querySelector(".screen.stage > .bplates.near");
    if (!(far instanceof HTMLElement) || !(near instanceof HTMLElement)) return;
    plates = [];
    far.replaceWith(buildPlates(false));
    near.replaceWith(buildPlates(true));
    positionPlates();
  };

  /** Outlines a readout and makes it clickable while a target is being chosen. */
  const markTarget = (node: HTMLElement, ref: TargetRef): HTMLElement => {
    if (!aiming || !aimOptions().some((r) => sameRef(r, ref))) return node;
    node.classList.add("target");
    node.addEventListener("click", () => {
      if (busy) return;
      sfx.tap();
      choose(ref);
    });
    // The readout sits above the aim layer, so it reports its own hover: the
    // highlight comes up whether the pointer is on the card or on the Scoba.
    node.addEventListener("pointerenter", () => {
      if (aiming) aimHover = ref;
    });
    node.addEventListener("pointerleave", () => {
      if (aiming && aimHover && sameRef(aimHover, ref)) aimHover = null;
    });
    return node;
  };

  /**
   * While a move is being aimed, the field itself is clickable: the stage
   * turns a point into whoever is standing there, so a target can be picked
   * by its place on the ground rather than off a list.
   */
  const buildAimLayer = (): HTMLElement => {
    const layer = el("div", "baim");
    if (!aiming) {
      stage.setAiming(null);
      return layer;
    }
    const options = aimOptions();
    layer.classList.add("on");
    aimHover = null;
    stage.setAiming({ options, hover: null });
    const pick = (e: PointerEvent): TargetRef | null => {
      const hit = stage.hitTest(e.clientX, e.clientY);
      return hit && options.some((r) => sameRef(r, hit)) ? hit : null;
    };
    layer.addEventListener("pointermove", (e) => {
      if (!aiming) return;
      aimHover = pick(e);
      stage.setAiming({ options, hover: aimHover });
    });
    layer.addEventListener("pointerleave", () => {
      if (!aiming) return;
      aimHover = null;
      stage.setAiming({ options, hover: null });
    });
    layer.addEventListener("pointerdown", (e) => {
      if (busy) return;
      const hit = pick(e);
      if (!hit) return;
      e.preventDefault();
      sfx.tap();
      choose(hit);
    });
    return layer;
  };

  /**
   * Which Scoba the player is choosing for, and which of their own are not.
   * Solo picks for both characters in turn, so whichever one is not being
   * controlled right now is darkened, whether its choice is still to come or
   * already made. Co-op players each pick only their own, so nothing dims.
   */
  const syncTurn = (): void => {
    // A half of a fusion is picked for on the fusion, which is what the marker
    // stands over, and the other half is never the one waiting.
    const refOf = (slot: number): TargetRef | null => {
      const index = st.active[0][slot] ?? -1;
      const c = index >= 0 ? st.teams[0][index] : undefined;
      return c ? actingRef(st, c) : null;
    };
    const now = busy ? undefined : roundSlots[pickIndex];
    const acting = now === undefined ? null : refOf(now);
    const waiting = acting === null || coop
      ? []
      : ([0, 1] as const)
        .map(refOf)
        .filter((r): r is TargetRef => r !== null && r.index !== acting.index);
    stage.setTurn({ acting, waiting });
  };

  /**
   * Writes out every round of the fight so far, as the state each one opened
   * on and the picks it was handed. Running the file back through
   * `resolveTurn` gives the same events, so a bug that only shows up in one
   * fight can be handed over rather than described.
   */
  const saveReplay = (): void => {
    const data = takeReplay();
    if (!data) return;
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    a.href = url;
    a.download = `scoba-replay-${pad(d.getMonth() + 1)}${pad(d.getDate())}`
      + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  /** The one button on the battle screen that is not part of the game. */
  const buildReplayButton = (): HTMLElement | null => {
    const data = takeReplay();
    if (!data) return null;
    const b = el("button", "brec") as HTMLButtonElement;
    b.type = "button";
    b.textContent = `Save replay (${data.rounds.length})`;
    b.title = "Downloads every round of this fight as a file.";
    b.addEventListener("click", saveReplay);
    return b;
  };

  /** Puts away a sigil window somebody clicked open. */
  const dropHeld = (): void => {
    for (const held of document.querySelectorAll(".mark.held")) held.classList.remove("held");
    for (const plate of document.querySelectorAll(".bcard.holding")) plate.classList.remove("holding");
  };
  document.addEventListener("click", dropHeld);

  const render = (): void => {
    // A window held open belongs to a readout that is about to be rebuilt.
    dropHeld();
    // Rebuilding the page takes every button with it, and a removed button
    // never gets its pointerleave, so the mark goes with the page.
    costPreview = null;
    syncTurn();
    ui.screen((s) => {
      s.classList.add("stage");
      plates = [];
      s.appendChild(buildPlates(false));
      s.appendChild(nearCanvas());
      s.appendChild(buildPlates(true));
      s.appendChild(buildAimLayer());

      // The readouts pin to the top and bottom edges; the band between them
      // is left clear for the scene on the canvas behind. The message box and
      // the buttons share one fixed block, so neither resizes the other.
      const bottom = el("div", "bbottom");
      bottom.appendChild(buildActions());
      s.appendChild(bottom);
      const rec = buildReplayButton();
      if (rec) s.appendChild(rec);
    });
    ui.setLocked(true);
    positionPlates();
  };

  /**
   * The shared move button, with the fight's own rule on top: nothing is
   * pressable while a round is playing itself out.
   */
  const act = (
    label: string, sub: string, onPick: () => void, opts: ActOpts = {},
  ): HTMLButtonElement => actButton(label, sub, () => {
    if (busy) return;
    onPick();
  }, { ...opts, disabled: opts.disabled === true || busy });

  /**
   * Who walks on for a slot that was emptied. It costs no turn: the pick is
   * made after the round that felled the last one, and whoever comes on picks
   * a move in the next round like anybody else.
   */
  const buildSendIn = (slot: number): HTMLElement => {
    const holder = st.slotOwner[slot];
    const who = holder && holder !== "*" ? nameOf(holder) : "";
    const picks = benchFor(st, 0, slot).map((i) => {
      const c = st.teams[0][i]!;
      return act(displayName(c.scoba), `Lv ${c.scoba.level}`, () => chooseSendIn(slot, i));
    });
    return rows(grid(picks), null, who ? `${who}, send one in` : "Send one in");
  };

  const buildActions = (): HTMLElement => {
    if (aiming) return buildTargetPicker();
    const waiting = sendInSlots[0];
    if (waiting !== undefined) return buildSendIn(waiting);
    const wrap = el("div", "bactions");
    const slot = roundSlots[pickIndex];
    const me = slot === undefined ? null : at(0, slot);
    // Nobody to ask, which is the round playing out: the block is only its
    // message box, saying what is happening.
    if (slot === undefined || !me) return rows([]);

    const backToMain = act("Back", "", () => {
      menu = "main";
      render();
    }, { alt: true, small: true });

    /**
     * The row under the main one: everything that is not an action taken on
     * the field. Small, so a page change never resizes what is above it.
     */
    const minorRow = (...extra: HTMLElement[]): HTMLElement => {
      const row = el("div", "bactions bminor");
      for (const e of extra) row.appendChild(e);
      return row;
    };

    /**
     * The step back to the other character. It sits at the end of the message
     * row rather than joining a row of buttons: dropping it in shuffled
     * everything beside it every time the second picker came around.
     */
    const stepBack = (): HTMLElement | null => {
      if (pickIndex === 0 || menu !== "main") return null;
      return act("Back", "", () => {
        staged.pop();
        pickIndex -= 1;
        menu = "main";
        render();
      }, { alt: true, small: true });
    };

    // The moves an ability hands over. They have no slot for a status to
    // address, and the board is four cells for good, so they are a page of
    // their own, reached from the strip under the board.
    const handed = castableMoves(me).slice(MAX_MOVES)
      .map((id) => MOVES[id])
      .filter((m): m is Move => m !== undefined);
    if (menu === "handed") {
      // The same four-cell board as the moves, with the cells nothing was
      // handed for dead, so the two pages are one shape.
      const board = el("div", "bgrid");
      for (let i = 0; i < MAX_MOVES; i++) {
        const move = handed[i];
        if (!move) {
          const dead = el("button", "act slot-empty") as HTMLButtonElement;
          dead.disabled = true;
          dead.appendChild(el("span", undefined, "None."));
          board.appendChild(dead);
          continue;
        }
        board.appendChild(abilityButton(me, move, () =>
          startAiming({ kind: "spell", side: 0, slot, moveId: move.id, picks: [] })));
      }
      const back = act("Back", "", () => {
        menu = "abilities";
        render();
      }, { alt: true, small: true });
      return rows([board], back, askLine(me));
    }

    if (menu === "abilities") {
      // Always four cells. A Scoba with fewer slots shows the rest as dead
      // ones rather than shrinking the board, and the order never moves,
      // because statuses address these by position.
      const grid = el("div", "bgrid");
      for (let i = 0; i < MAX_MOVES; i++) {
        const id = heldMoves(me)[i];
        const move = id ? MOVES[id] : undefined;
        if (!move) {
          const dead = el("button", "act slot-empty") as HTMLButtonElement;
          dead.disabled = true;
          dead.appendChild(el("span", undefined, "None."));
          grid.appendChild(dead);
          continue;
        }
        grid.appendChild(abilityButton(me, move, () =>
          startAiming({ kind: "spell", side: 0, slot, moveId: move.id, picks: [] })));
      }
      // Hyper-Mode takes the bar along the bottom, for every Scoba, so the
      // board is always three rows. It is not a move and is never cast at
      // anything. A Scoba with no Hyper-Mode says so, with no cost. A story
      // flag can lock the whole thing away as "???" for a later chapter;
      // nothing sets it yet, so it is open from the start.
      const hasHyper = SPECIES[me.scoba.speciesId]?.hyperAbility !== undefined;
      const locked = save.story.flags["hyperLocked"] === true;
      const hyperWhy = hyperError(me);
      const dead = { disabled: true, small: true, alt: true };
      const hyper = locked
        ? act("???", "", () => {}, dead)
        : !hasHyper
          ? act("No hyper", "", () => {}, dead)
          : act("Hyper", hyperWhy ?? `${HYPER_COST} mana`,
            () => pick({ kind: "hyper", side: 0, slot }),
            { disabled: hyperWhy !== null, small: true, alt: true });
      hyper.classList.add("bhyper");
      grid.appendChild(hyper);
      // The track list has to name every row, so the grid says it has three.
      grid.classList.add("rows3");
      // The handed moves have no slot for a status to address and the board
      // is four cells for good, so the way to them sits under the message
      // box, beside the way back, rather than on the board. It is there for
      // every Scoba, dead when nothing is handed, so the page keeps one shape.
      const more = act("More moves", "", () => {
        menu = "handed";
        render();
      }, { small: true, disabled: handed.length === 0 });
      return rows([grid], backToMain, askLine(me), more);
    }

    if (menu === "flee") {
      // Walking out ends it for both characters, so it asks first.
      const yn = el("div", "bactions");
      yn.appendChild(act("Yes", "Leave the fight", () => pick({ kind: "flee", side: 0, slot })));
      yn.appendChild(act("No", "Stay in", () => {
        menu = "main";
        render();
      }, { alt: true }));
      return rows([yn], null, "Are you sure you want to flee the battle?");
    }

    if (menu === "items") {
      const usable = BATTLE_ITEMS.filter((it) => !it.wildOnly || setup.wild);
      for (const item of usable) {
        const held = itemsOnHand(st, 0, item.id, save.bag[item.id] ?? 0);
        wrap.appendChild(act(item.name, `x${held} · ${item.desc}`, () => {
          if (spendItem(st, 0, item.id) === "bag") save.bag[item.id] = (save.bag[item.id] ?? 0) - 1;
          pick({ kind: "catch", side: 0, slot });
        }, { disabled: held <= 0 }));
      }
      return rows([wrap], backToMain,
        usable.length === 0 ? "Nothing here to use." : `What will ${displayName(me.scoba)} use?`);
    }

    // What this Scoba does with its turn. Three, always, so the row never
    // changes shape whatever it knows, and three columns wide however narrow
    // the screen is, so it never reflows into two rows and back either.
    // The basic attack has no move behind it. It lands as Plain, which its
    // sub-line says with the badge: wearing Plain's beige as a fill made the
    // first button on the row look like the disabled one.
    // A passive can turn the basic attack into a move, and the button says which.
    const basicMove = basicAttackOf(actingAs(st, me));
    wrap.appendChild(act("Basic attack", basicMove?.name ?? "",
      () => startAiming({ kind: "attack", side: 0, slot, picks: [] }), { hot: true }));
    wrap.appendChild(act("Abilities", "", () => {
      menu = "abilities";
      render();
    }, { hot: true }));
    // A fusion cannot block. The button stays, dead, so the row keeps its shape.
    const fused = me.fusedInto !== undefined;
    wrap.appendChild(act("Block", fused ? "fused" : "-50% dmg", () => pick({ kind: "block", side: 0, slot }), {
      alt: true, disabled: fused,
    }));

    const minor = minorRow(
      act("Items", "", () => {
        menu = "items";
        render();
      }, { alt: true, small: true }),
      act("Flee", "", () => {
        menu = "flee";
        render();
      }, { alt: true, small: true }),
      act("Extra", "", () => renderExtra(slot), { alt: true, small: true }),
    );
    return rows([wrap, minor], stepBack(), askLine(me));
  };

  /** The question the message box asks while this Scoba's choice is made. */
  const askLine = (me: Combatant): string => {
    const body = actingAs(st, me);
    // A fusion is asked twice a round, once for each half's moves.
    if (body !== me) return `What will ${displayName(body.scoba)} do as ${displayName(me.scoba)}?`;
    return `What will ${displayName(me.scoba)} do?`;
  };

  /**
   * Buttons laid across the block three to a row, so a list of any length is
   * rows of standard buttons rather than one row wrapping into smaller ones.
   */
  const grid = (buttons: HTMLElement[]): HTMLElement[] => {
    const out: HTMLElement[] = [];
    for (let i = 0; i < buttons.length; i += 3) {
      const row = el("div", "bactions");
      const slice = buttons.slice(i, i + 3);
      // A short list shares the row out rather than leaving a lone choice
      // in a third of it, where a move's name has no room to be read.
      row.style.setProperty("--cols", String(slice.length));
      for (const b of slice) row.appendChild(b);
      out.push(row);
    }
    return out;
  };

  /**
   * A page of the action block. The left column is always the message box:
   * the question in `head` while a choice is being made, or the line the
   * round is on while it plays. `corner` is the one way back off the page,
   * under that box. The parts fill the two rows of the right column, packed
   * to the bottom, so every page is the same box and moving between them
   * shifts neither the buttons nor the scene laid out above.
   */
  const rows = (
    parts: HTMLElement[], corner?: HTMLElement | null, head?: string,
    /** One more way off the page, between the message box and the corner. */
    aside?: HTMLElement | null,
  ): HTMLElement => {
    const box = el("div", "bacts");
    const top = el("div", "bhead");
    logEl = el("div", "bmsg");
    if (busy) {
      logEl.textContent = lastLine.text;
      if (lastLine.kind) logEl.classList.add(`ev-${lastLine.kind}`);
    } else {
      logEl.classList.add("prompt");
      logEl.textContent = head ?? "";
    }
    top.appendChild(logEl);
    // The ways off the page share one short row under the box, so the box
    // keeps most of the column whether there are two of them or one.
    if (aside || corner) {
      const ways = el("div", "bways");
      if (corner) ways.appendChild(corner);
      if (aside) ways.appendChild(aside);
      top.appendChild(ways);
    }
    box.appendChild(top);
    // How many of the button rows a part is worth. The move grid is always
    // 2x2; an action row is three across, so six buttons are two rows of it.
    // A longer list still spans two and shares them out inside itself.
    const span = (p: HTMLElement): number =>
      p.classList.contains("bgrid")
        ? 2
        : p.classList.contains("bactions")
          ? Math.min(BUTTON_ROWS, Math.ceil(p.childElementCount / 3))
          : 1;
    const total = Math.min(BUTTON_ROWS, parts.reduce((n, p) => n + span(p), 0));
    let at = BUTTON_ROWS + 1 - total;
    for (const part of parts) {
      const n = Math.max(1, Math.min(span(part), BUTTON_ROWS + 1 - at));
      part.style.gridRow = `${at} / span ${n}`;
      part.style.gridColumn = "2";
      at += n;
      box.appendChild(part);
    }
    return box;
  };

  const itemsNote = (): string => {
    const usable = BATTLE_ITEMS.filter((it) => !it.wildOnly || setup.wild);
    const total = usable.reduce((n, it) => n + itemsOnHand(st, 0, it.id, save.bag[it.id] ?? 0), 0);
    return total > 0 ? `${total} to hand` : "none";
  };

  /** A move as a button, with its cost, cooldown and what it aims at. */
  const abilityButton = (
    me: Combatant, move: Move, onPick: () => void,
    opts: { small?: boolean } = {},
  ): HTMLButtonElement => {
    const ready = moveReady(me, move.id);
    const cd = me.cds[move.id] ?? 0;
    const cost = castCost(me, move.id);
    // A move that is gone for the rest of the battle says so instead of its
    // price: what it would have cost is no longer the reason it cannot be cast.
    const gone = move.oncePerBattle && me.spent.includes(move.id);
    // A small button has a row to share, so it says what it costs and leaves
    // what it aims at to the full-sized one.
    const sub = gone ? "spent" : moveSub(move, cost, { waiting: cd, short: opts.small === true });
    const b = act(move.name, sub, onPick, {
      disabled: !ready.ok, type: move.type, small: opts.small,
      ...(move.type2 ? { type2: move.type2 } : {}),
    });
    // Reaching for a move marks its cost on the caster's bar, so what it
    // would leave behind is visible before it is picked, and puts a line on
    // what it does in the message box. Keyboard focus does the same, since a
    // pointer is not the only way through the list.
    // A half's cost is marked on its own bar of the fusion's readout.
    const from = actingRef(st, me);
    const index = from?.index ?? -1;
    const bar = halfIndex(me);
    const show = (on: boolean): void => {
      costPreview = on && index >= 0 ? { index, cost, ...(bar !== undefined ? { bar } : {}) } : null;
      hoverMove = on && index >= 0 ? { move, user: { side: 0, index } } : null;
      // The bars are only redrawn when something asks them to, so the mark has
      // to ask. Without this the cost was worked out and never drawn.
      for (const p of plates) {
        if (p.side === 0 && p.index === index) p.refresh();
      }
      if (busy || !logEl.isConnected) return;
      logEl.classList.toggle("long", on);
      if (on) logEl.replaceChildren(moveLine(move, me));
      else logEl.textContent = askLine(me);
    };
    b.addEventListener("pointerenter", () => show(true));
    b.addEventListener("pointerleave", () => show(false));
    b.addEventListener("focus", () => show(true));
    b.addEventListener("blur", () => show(false));
    return b;
  };

  /**
   * One line on a move, for the message box while the move is under the
   * pointer. Read against the Scoba about to cast it, so a damage word is the
   * number it would deal, in the color its kind of damage is.
   */
  const moveLine = (move: Move, me: Combatant): HTMLElement => {
    // One inline run, since the message box lays out its children as flex
    // items and would otherwise drop the spaces either side of each number.
    const out = document.createElement("span");
    out.append(`${move.name}: `);
    // Cast by the fusion, for one of its halves, so read against the fusion.
    const caster = actingAs(st, me);
    out.appendChild(proseNodes(moveText(move), {
      move, stats: combatantStats(caster), level: caster.scoba.level, types: scobaTypes(caster.scoba),
    }));
    return out;
  };

  // --- aiming ---

  /** What is being aimed, for the question over the target list. */
  const aimTitle = (action: Choice): string =>
    action.kind === "spell"
      ? MOVES[action.moveId]?.name ?? "Aim"
      : action.kind === "attack" ? "Basic attack" : "Aim";

  /** The menu the spec being aimed at right now offers. */
  const aimOptions = (): TargetRef[] => {
    if (!aiming) return [];
    const slot = roundSlots[pickIndex];
    if (slot === undefined) return [];
    const caster = at(0, slot);
    const from = caster ? actingRef(st, caster) : null;
    if (!from) return [];
    const spec = aiming.specs[aiming.at];
    if (!spec || !needsPick(spec.mode)) return [];
    return targetOptions(st, from, spec);
  };

  /**
   * Opens the picker for an action. Specs that settle themselves (self, a
   * whole team, a roll) are filled in as they come up, so the player is only
   * stopped for the ones that are a decision.
   */
  const startAiming = (action: Choice): void => {
    aiming = { action, specs: specsFor(action), picks: [], at: 0 };
    advanceAim();
  };

  const advanceAim = (): void => {
    const a = aiming;
    if (!a) {
      stage.setAiming(null);
      return;
    }
    while (a.at < a.specs.length && !needsPick(a.specs[a.at]!.mode)) {
      a.picks.push(null);
      a.at += 1;
    }
    if (a.at >= a.specs.length) {
      aiming = null;
      pick({ ...a.action, picks: a.picks } as Choice);
      return;
    }
    if (aimOptions().length === 0) {
      // Nothing legal to aim at, so the move is put back rather than fizzled.
      aiming = null;
      ui.toast("Nothing to aim that at.");
      render();
      return;
    }
    render();
  };

  const choose = (ref: TargetRef): void => {
    const a = aiming;
    if (!a) return;
    a.picks.push(ref);
    a.at += 1;
    advanceAim();
  };

  const buildTargetPicker = (): HTMLElement => {
    const a = aiming!;
    const spec = a.specs[a.at]!;
    const label = spec.prompt ?? TARGET_LABELS[spec.mode];
    const step = a.specs.length > 1 ? ` (target ${a.at + 1} of ${a.specs.length})` : "";
    const picks: HTMLElement[] = [];
    for (const ref of aimOptions()) {
      const c = st.teams[ref.side][ref.index];
      if (!c) continue;
      const benched = !st.active[ref.side].includes(ref.index);
      const eff = aimEffect(c, ref);
      const sub = `${c.hp}/${combatantMaxHp(c)}${benched ? " · benched" : ""}${eff ? ` · ${eff.label}` : ""}`;
      picks.push(act(displayName(c.scoba), sub, () => choose(ref), { alt: ref.side === 0 }));
    }
    const cancel = act("Cancel", "", () => {
      aiming = null;
      render();
    }, { alt: true, small: true });
    return rows(grid(picks), cancel, `${aimTitle(a.action)}: ${label}${step}`);
  };

  /**
   * Everything that is not an action: what this character has on hand, what
   * each of them can do and what it would really land for, plus the swap and
   * the wild-battle options.
   */
  const renderExtra = (slot: number): void => {
    const owner = st.slotOwner[slot] ?? null;
    const mine = st.teams[0]
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => owner === "*" || c.scoba.owner === owner);
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, `${nameOf(owner)} · extra`));
      const list = el("div", "xlist");
      for (const { c, i } of mine) list.appendChild(scobaPanel(c, { side: 0, index: i }, slot));
      s.appendChild(list);

      const row = el("div", "xrow");
      const standing = at(0, slot);
      const fusedHere = standing?.fusedInto !== undefined;
      if (!fusedHere && benchFor(st, 0, slot).length > 0) {
        row.appendChild(act("Swap", "send another out", () => renderSwap(slot, () => renderExtra(slot)), { alt: true }));
      }
      row.appendChild(act("Back", "", () => render(), { alt: true }));
      s.appendChild(row);
    });
    ui.setLocked(true);
  };

  /** How wide and tall a Scoba's portrait is allowed to be on its panel. */
  const FACE_BOX = 44;

  /**
   * Sizes a portrait to fit its box without squashing it. The drawing is
   * cropped to the Scoba, so one line comes out tall and another wide, and a
   * limit on each side separately pulls whichever one is over out of shape.
   */
  const fitted = (cv: HTMLCanvasElement): HTMLCanvasElement => {
    const k = Math.min(1, FACE_BOX / cv.width, FACE_BOX / cv.height);
    cv.style.width = `${Math.round(cv.width * k)}px`;
    cv.style.height = `${Math.round(cv.height * k)}px`;
    return cv;
  };

  /** One Scoba on the Extra window: where it stands, its stats and its moves. */
  const scobaPanel = (c: Combatant, ref: TargetRef, slot: number): HTMLElement => {
    const wrap = el("div", "card xscoba");
    const sp = SPECIES[c.scoba.speciesId]!;
    const out = st.active[0].includes(ref.index);
    const nm = el("div", "nm cardHead");
    // Drawn as it stands on the field, spent forms and Hyper-Mode included, so
    // the panel shows the Scoba the fight is showing.
    const face = el("div", "xface");
    face.appendChild(fitted(critterPortrait(art, sp, c.scoba.sire, c.scoba.shiny, lookOf(sp, c.scoba, formsOf(c)))));
    nm.appendChild(face);
    nm.appendChild(el("strong", undefined, displayName(c.scoba)));
    nm.appendChild(el("span", "lv", `Lv ${c.scoba.level}`));
    nm.appendChild(typeIcons(c.scoba));
    const pawn = st.teams[0].indexOf(c) >= 0 && c.pawn;
    const body = actingAs(st, c);
    const fused = body !== c && !c.fainted;
    nm.appendChild(el("span", "lv",
      c.fainted ? "· fainted" : fused ? `· in ${displayName(body.scoba)}` : pawn ? "· pawn" : out ? "· out" : "· benched"));
    wrap.appendChild(nm);

    // A half fights with the fusion's numbers, its own HP bar and its own Speed.
    const stats = { ...combatantStats(body), spd: actingSpeed(st, c) };
    const half = halfIndex(c);
    const bars = fused ? fusionBars(body) : null;
    const hp = bars && half !== undefined ? bars[half]! : { hp: c.hp, max: combatantMaxHp(c) };
    const line = el("div", "xstats");
    line.appendChild(el("span", undefined, `HP ${hp.hp}/${hp.max}`));
    for (const key of ["str", "def", "res", "mag", "spd"] as const) {
      line.appendChild(el("span", undefined, `${STAT_LABELS[key]} ${stats[key]}`));
    }
    wrap.appendChild(line);

    for (const id of [sp.primaryAbility, c.scoba.secondaryAbility]) {
      const ab = ABILITIES[id];
      if (!ab) continue;
      const row = el("div", "xpass");
      row.appendChild(el("strong", undefined, ab.name));
      row.appendChild(proseBox(abilityText(ab.id), {}, "pline"));
      // A passive with charges left to spend says how many are left.
      const spent = abilityStatuses(id)
        .map((sid) => c.statuses.find((held) => held.id === sid))
        .filter((held): held is StatusInstance => !!held && held.chargesLeft > 0)
        .map((held) => `${statusName(held.id)} x${held.chargesLeft}`);
      if (spent.length > 0) row.appendChild(el("span", "dim", spent.join(", ")));
      wrap.appendChild(row);
    }

    // The same board the fight itself shows: four cells, in the same order,
    // with a move wearing its elements. A Scoba with fewer moves shows the rest
    // as dead cells rather than shrinking the board, because a status can
    // address a slot by its position and the position has to be there.
    const detail = el("div", "xinfo");
    const say = (move: Move | undefined): void => {
      detail.innerHTML = "";
      detail.appendChild(move
        ? explainMove(move, ref, slot)
        : el("span", "dim", "Nothing in that slot."));
    };
    const board = el("div", "bgrid xmoves");
    for (let i = 0; i < MAX_MOVES; i++) {
      const move = MOVES[heldMoves(c)[i] ?? ""];
      if (!move) {
        const dead = el("button", "act slot-empty") as HTMLButtonElement;
        dead.disabled = true;
        dead.appendChild(el("span", undefined, "None."));
        board.appendChild(dead);
        continue;
      }
      const cd = c.cds[move.id] ?? 0;
      const gone = move.oncePerBattle && c.spent.includes(move.id);
      const cost = castCost(c, move.id);
      board.appendChild(act(
        move.name,
        gone ? "spent" : `${cost}% mana${move.cooldown ? ` · cd${move.cooldown}` : ""}${cd > 0 ? ` · wait ${cd}` : ""}`,
        () => say(move),
        { type: move.type, ...(move.type2 ? { type2: move.type2 } : {}) },
      ));
    }
    wrap.appendChild(board);
    // What a move does gets a box of its own, the way the fight's own message
    // box does, rather than running on under the buttons as loose text.
    const box = el("div", "xsay");
    box.appendChild(detail);
    wrap.appendChild(box);
    say(MOVES[heldMoves(c)[0] ?? ""]);
    return wrap;
  };

  /** What a move does, in numbers, against what is standing there now. */
  const explainMove = (move: Move, ref: TargetRef, slot: number): HTMLElement => {
    const box = el("div");
    const holder = st.teams[ref.side][ref.index] ?? null;
    // A half's move is cast by the fusion, so it is measured from there.
    const caster = holder ? actingAs(st, holder) : null;
    const preview = previewMove(st, (holder ? actingRef(st, holder) : null) ?? ref, move.id);
    const cost = holder ? castCost(holder, move.id) : move.manaCost;
    const head = el("div", "xhead");
    head.appendChild(el("strong", undefined, move.name));
    head.appendChild(typeIcon(move.type));
    head.appendChild(el("span", "dim", `${cost}% mana${move.cooldown ? ` · cooldown ${move.cooldown}` : ""}`));
    // A move a line does not learn is worked rather than known, and says so.
    if (holder && cost > move.manaCost) {
      head.appendChild(el("span", "dim", `· worked, +${cost - move.manaCost}`));
    }
    box.appendChild(head);

    // The rule's own line first, then what it comes to against whoever is
    // standing there right now.
    box.appendChild(proseBox(moveText(move), {
      move,
      ...(caster
        ? { stats: combatantStats(caster), level: caster.scoba.level, types: scobaTypes(caster.scoba) }
        : {}),
    }));
    if (preview && preview.heal !== null) {
      const line = el("div");
      line.appendChild(document.createTextNode("Would restore "));
      line.appendChild(el("span", "good", `${preview.heal} HP`));
      box.appendChild(line);
    }
    void slot;
    return box;
  };

  /** `back` is where its Back button goes, since Swap is reached from Extra. */
  const renderSwap = (slot: number, back: () => void = render): void => {
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, `${nameOf(st.slotOwner[slot] ?? null)}: send out`));
      const row = el("div", "xrow");
      for (const i of benchFor(st, 0, slot)) {
        const c = st.teams[0][i]!;
        row.appendChild(act(displayName(c.scoba), `Lv ${c.scoba.level} · ${c.hp}/${combatantMaxHp(c)}`, () => pick({ kind: "switch", side: 0, slot, benchIndex: i })));
      }
      row.appendChild(act("Back", "", () => back(), { alt: true }));
      s.appendChild(row);
    });
    ui.setLocked(true);
  };

  /** Replaces what the banner is saying, rather than stacking a history. */
  const say = (text: string, kind: string): void => {
    lastLine = { text, kind };
    if (!logEl.isConnected) return;
    logEl.className = `bmsg ev-${kind}`;
    logEl.textContent = text;
  };

  /** Opens a fresh round of choices, letting a queued join in first. */
  const beginRound = (): void => {
    staged = [];
    pickIndex = 0;
    aiming = null;
    sendInSlots = [];
    menu = "main";
    const arriving = flushJoin();
    if (arriving.length > 0) {
      // The person walks in first and their Scoba follows, because somebody
      // turning up to a fight arrives before whatever they brought does.
      busy = true;
      stage.sync();
      render();
      void stage.playArrival(joinedOwner!, false).then(() => {
        busy = false;
        playThen(arriving, beginRound);
      });
      return;
    }
    // The Pawns that run themselves are left off: nobody is asked about them,
    // and their choices come out of the AI when the round is submitted.
    localReady = false;
    roundSlots = slotsAwaitingChoice(st, 0)
      .filter((slot) => {
        const c = at(0, slot);
        if (!c || selfRunning(c)) return false;
        // With a peer connected each client answers only for its own
        // character. Solo keeps both, because one player is playing both.
        return !net || answeredBy(slot, c) === net.localOwner;
      })
      .sort((a, b) => askOrder(a) - askOrder(b));
    // Nobody left to ask, but the field is not empty: the round still has to
    // play so whatever is standing there gets its turn.
    if (roundSlots.length === 0) {
      localReady = true;
      tryResolve();
      return;
    }
    render();
  };

  /** Records one slot's action, then moves to the next picker or resolves. */
  const pick = (choice: Choice): void => {
    const err = choiceError(st, choice);
    if (err) {
      ui.toast(err);
      return;
    }
    staged.push(choice);
    net?.send({ t: "battle-choice", battleId: net.battleId, turn: st.turn, choice });
    // Fleeing ends the battle before anyone acts, so nobody else picks.
    if (choice.kind === "flee") {
      localReady = true;
      tryResolve();
      return;
    }
    pickIndex += 1;
    menu = "main";
    if (pickIndex >= roundSlots.length) {
      localReady = true;
      tryResolve();
    } else {
      render();
    }
  };

  /** Slots the peer owns that are still owed a choice this round. */
  const peerSlotsOwed = (): number[] => {
    if (!net) return [];
    return slotsAwaitingChoice(st, 0).filter((slot) => {
      const c = at(0, slot);
      if (!c || selfRunning(c)) return false;
      const by = answeredBy(slot, c);
      return by !== net.localOwner && by !== null;
    });
  };

  /**
   * Who answers for a slot. A Pawn mark is tied to no character, so whoever the
   * Scoba standing on it belongs to is the one asked: a Pawn somebody called,
   * or their own Scoba standing in another time.
   */
  const answeredBy = (slot: number, c: Combatant): SlotHolder =>
    (isPawnSlot(slot) ? (c.scoba.owner as SlotHolder | undefined) ?? null : st.slotOwner[slot] ?? null);

  /**
   * The round goes when both players have answered. Solo resolves the moment
   * the one player is done; with a peer it waits, and the wait is shown rather
   * than looking like the game has stopped.
   */
  const tryResolve = (): void => {
    if (!localReady || busy) return;
    if (!net) {
      submitRound();
      return;
    }
    const owed = peerSlotsOwed();
    const have = peerChoices.forTurn(st.turn);
    if (owed.some((slot) => !have.some((c) => c.slot === slot))) {
      // Rendered first: `render` rebuilds the log element, so saying it before
      // would write the line onto the node that is about to be thrown away.
      render();
      say(`Waiting for ${nameOf(OTHER[net.localOwner])}...`, "info");
      return;
    }
    submitRound();
  };

  const submitRound = (): void => {
    busy = true;
    aiming = null;
    // Pawns take no xp from a win: they are not there afterwards to have it.
    for (const slot of [0, 1] as const) {
      const idx = st.active[0][slot] ?? -1;
      if (idx >= 0) participated.add(idx);
    }
    // What the plates show is frozen where the player can see it, then let
    // out event by event as the round plays.
    stage.snapshot();
    // The peer's picks join ours. `resolveTurn` sorts the round into a
    // canonical order, so it does not matter that the two clients assemble
    // this array from opposite ends.
    const resolvedTurn = st.turn;
    const peers = net ? peerChoices.forTurn(resolvedTurn) : [];
    const events = resolveTurn(st, [...staged, ...peers, ...pawnChoices(st, 0), ...enemyChoices(st)]);
    staged = [];
    localReady = false;
    if (net) {
      peerChoices.clearThrough(resolvedTurn);
      // Both clients hash the result and the relay compares them. Nothing is
      // rolled back on a mismatch: it is reported, because a desync means the
      // two of them stopped playing the same game and only a person can judge.
      net.send({ t: "battle-hash", battleId: net.battleId, turn: resolvedTurn, hash: stateHash(st) });
    }
    stage.setAiming(null);
    render();
    // The scene paces the round: each event writes its log line as its own
    // animation starts, so the text and the picture stay together.
    stage.instant = (window as { __scobaFast?: boolean }).__scobaFast === true;
    void stage.play(events, (ev) => say(ev.text, ev.kind)).then(() => {
      stage.settle();
      busy = false;
      finishTurn();
    });
  };

  const finishTurn = (): void => {
    syncHp();
    if (st.outcome === "fled") return close({ outcome: "fled" });
    if (st.outcome === "caught") return handleCaught();
    if (st.winner === 0) return handleWin();
    if (st.winner === 1) return handleLoss();
    fillEmpties();
  };

  /** Plays a handful of events, then carries on. */
  const playThen = (events: BattleEvent[], then: () => void): void => {
    if (events.length === 0) {
      then();
      return;
    }
    busy = true;
    stage.snapshot();
    render();
    stage.instant = (window as { __scobaFast?: boolean }).__scobaFast === true;
    void stage.play(events, (ev) => say(ev.text, ev.kind)).then(() => {
      stage.settle();
      busy = false;
      then();
    });
  };

  /**
   * Anything that fell is replaced between rounds rather than spending a turn
   * walking on. The enemy sends in whatever is next in its order; each of the
   * player's emptied slots is asked about in turn.
   */
  const fillEmpties = (): void => {
    roundSlots = [];
    pickIndex = 0;
    const events: BattleEvent[] = [];
    for (const slot of emptySlots(st, 1)) {
      const bench = benchFor(st, 1, slot);
      if (bench.length > 0) events.push(...sendIn(st, 1, slot, bench[0]!));
    }
    // Each client fills only its own character's empty slots; the peer's
    // arrive as `battle-send-in`.
    sendInSlots = emptySlots(st, 0)
      .filter((slot) => !net || st.slotOwner[slot] === net.localOwner);
    playThen(events, askSendIn);
  };

  const askSendIn = (): void => {
    if (sendInSlots.length === 0) {
      beginRound();
      return;
    }
    render();
  };

  const chooseSendIn = (slot: number, benchIndex: number): void => {
    const events = sendIn(st, 0, slot, benchIndex);
    sendInSlots = sendInSlots.filter((s) => s !== slot);
    // Arriving costs no turn, so a replacement is not one of the round's
    // choices and the peer has to be told about it separately or the two
    // clients field different Scobas.
    if (net && (slot === 0 || slot === 1)) {
      net.send({ t: "battle-send-in", battleId: net.battleId, turn: st.turn, slot, benchIndex });
    }
    playThen(events, askSendIn);
  };

  /** A replacement the peer walked on. Applied without asking anyone here. */
  const applyPeerSendIn = (slot: 0 | 1, benchIndex: number): void => {
    if (!emptySlots(st, 0).includes(slot)) return;
    const events = sendIn(st, 0, slot, benchIndex);
    sendInSlots = sendInSlots.filter((s) => s !== slot);
    playThen(events, askSendIn);
  };

  const syncHp = (): void => {
    for (const c of st.teams[0]) c.scoba.hp = c.hp;
  };

  // --- the other player walking in ---

  const canJoin = (owner: OwnerId): boolean =>
    coop && st.winner === -1 && st.outcome === "" && st.slotOwner[slotOf(owner)] === null;

  /**
   * Applies a queued join, but only between rounds: a request that arrives
   * while the turn is resolving or while choices are half-picked waits.
   */
  /**
   * Applies a queued join and hands back what it wants played. The events are
   * returned rather than just spoken so the arrival gets its walk-on: saying
   * the lines without playing them had the second Scoba appear on the field
   * fully formed between one frame and the next.
   */
  /** Who the last flushed join was for, so the arrival knows who to walk on. */
  let joinedOwner: OwnerId | null = null;

  const flushJoin = (): BattleEvent[] => {
    const owner = pendingJoin;
    if (owner === null) return [];
    if (busy || staged.length > 0) return [];
    pendingJoin = null;
    if (!canJoin(owner)) return [];
    // A peer brings its own party: this save's copy of the other character's
    // Scobas drifted the moment either player did anything alone.
    const team = joinTeams.get(owner) ?? partyOf(save, owner);
    joinTeams.delete(owner);
    const events = joinBattle(st, owner, team);
    joinedOwner = owner;
    // The host is the one that was here first, so it settles what the state is.
    if (net?.isHost) net.send({ t: "battle-sync", battleId: net.battleId, state: st });
    return [{ text: `${nameOf(owner)} joins the battle!`, kind: "win" }, ...events];
  };

  const requestJoin = (owner: OwnerId): boolean => {
    if (!canJoin(owner)) return false;
    pendingJoin = owner;
    // Idle between rounds, so it can go in now rather than waiting.
    if (!busy && staged.length === 0) beginRound();
    return true;
  };

  // --- endings ---

  const handleCaught = (): void => {
    const wild = enemies[0]!;
    const was = wild.level;
    // A snared Scoba comes down to the ceiling and then a little further: what
    // you catch is a project, never a shortcut past what you raised.
    settleCaught(wild, rngFrom(`${seed}:caught`));
    const dest = addToParty(save, wild, save.localSlot);
    const lines = [dest === "party" ? "Joined the party." : "Sent to the box."];
    if (wild.level !== was) lines.push(`Settled at Lv ${wild.level} (was Lv ${was}).`);
    lines.push(payout());
    showResults(`${displayName(wild)} was caught!`, lines, "caught");
  };

  /** What the fight was worth in Aetus, banked and worded for the results. */
  const payout = (): string => {
    const won = setup.trainerName ? AETUS_PER_TRAINER : AETUS_PER_WILD;
    save.aetus += won;
    return `+${won} Aetus.`;
  };

  const handleWin = (): void => {
    const lines: string[] = [];
    const xp = enemies.reduce((sum, e) => sum + e.level, 0) * 12;
    for (const idx of participated) {
      const c = st.teams[0][idx]!;
      if (c.fainted) continue;
      // At the ceiling there is nothing for xp to do, so the line says so
      // rather than reporting a gain that went nowhere.
      if (c.scoba.level >= MAX_LEVEL) {
        lines.push(`${displayName(c.scoba)} is at Lv ${MAX_LEVEL}.`);
        continue;
      }
      const r = gainXp(c.scoba, xp);
      lines.push(`${displayName(c.scoba)} +${xp} xp${r.levelsGained ? ` → Lv ${c.scoba.level}` : ""}`);
    }
    if (setup.rewardMoney) {
      save.money += setup.rewardMoney;
      lines.push(`Prize: ${setup.rewardMoney} coins.`);
    }
    lines.push(payout());
    syncHp();
    const title = setup.trainerName ? `${setup.trainerName} is defeated!` : "You win!";
    showResults(title, lines, "win");
  };

  const handleLoss = (): void => {
    showResults("Everyone fainted...", ["The party rests at the nest."], "loss");
  };

  /**
   * Every battle hands the party back whole, win or lose. The fights are
   * built to be met by a team at full strength, so carrying damage forward
   * would only ever be a tax on the next one rather than a decision.
   */
  const healParty = (): void => {
    for (const s of [...save.party, ...save.box]) s.hp = maxHp(s);
  };

  const showResults = (title: string, lines: string[], outcome: BattleResult["outcome"]): void => {
    sfx.confirm();
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, title));
      const card = el("div", "card");
      for (const line of lines) card.appendChild(el("div", undefined, line));
      card.appendChild(el("div", "dim", "Everyone is healed and revived."));
      s.appendChild(card);
      const b = el("button", "big primary", "Continue");
      b.addEventListener("click", () => close({ outcome }));
      s.appendChild(b);
    });
    ui.setLocked(true);
  };

  const close = (result: BattleResult): void => {
    // Here rather than on each ending, so walking out of a fight heals the
    // same way winning one does.
    healParty();
    // Under the cover, so the battle screen never blinks off to show the
    // overworld before the overworld is ready to be seen.
    // The peer stops waiting on choices that are never coming.
    net?.send({ t: "battle-close", battleId: net.battleId, outcome: result.outcome });
    void ui.transition(() => {
      stage.onFrame = null;
      stage.onRoster = null;
      liveStage = null;
      livePeer = null;
      document.removeEventListener("click", dropHeld);
      // The rounds are only worth holding while the fight they belong to is
      // still on screen to be exported from.
      stopReplay();
      writeSave(save);
      autosave(save);
      ui.setLocked(false);
      ui.closeScreen();
      onDone(result);
    });
  };

  // A party with nothing standing has no move, no swap and no way out of the
  // screen, so the battle resolves the way a defeat does instead of opening.
  if (st.teams[0].every((c) => c.fainted)) {
    handleLoss();
    liveStage = null;
    livePeer = null;
    return null;
  }
  // The opening walks everyone on, then plays whatever the opening triggers
  // had to say, which is where a passive that calls up a Pawn goes off. The
  // message box has something to say from the first frame rather than sitting
  // empty through the walk-on.
  const first = enemies[0];
  lastLine = {
    text: net?.adopted
      ? "You join the fight!"
      : setup.trainerName
        ? `${setup.trainerName} wants to battle!`
        : first
          ? `A wild ${displayName(first)} appears!`
          : "A wild Scoba appears!",
    kind: "info",
  };
  busy = true;
  render();
  // Adopting a fight means walking into one already happening, so the opening
  // is somebody arriving rather than everybody starting.
  const opening = net?.adopted
    ? stage.playArrival(net.localOwner, true)
    : stage.playIntro();
  void opening.then(() => {
    busy = false;
    playThen(st.opening, fillEmpties);
  });

  // The handle the session drives peer messages through. Registered even when
  // the battle is solo-shaped, because a peer can connect mid-fight.
  livePeer = net ? {
    battleId: net.battleId,
    peerChoice(turn: number, choice: Choice) {
      // A choice for a turn already resolved is a straggler from a resend.
      if (turn < st.turn) return;
      peerChoices.add(turn, choice);
      tryResolve();
    },
    peerSendIn(turn: number, slot: 0 | 1, benchIndex: number) {
      if (turn < st.turn) return;
      applyPeerSendIn(slot, benchIndex);
    },
    peerJoin(guest: OwnerId, team: ScobaInstance[]) {
      if (!canJoin(guest)) return;
      pendingJoin = guest;
      joinTeams.set(guest, team);
      if (!busy && staged.length === 0) beginRound();
    },
    peerLeft() {
      say("The other player left the fight.", "info");
    },
    desynced(reason: string) {
      ui.toast(`Out of step with the other player: ${reason}`);
    },
    debug: () => ({
      coop, busy, staged: staged.length, pendingJoin, roundSlots,
      localReady, slotOwner: [...st.slotOwner], turn: st.turn,
      canJoinGuest: canJoin(guestOwner),
      joinTeams: [...joinTeams.keys()],
      active: [...st.active[0]],
      teamSize: st.teams[0].length,
      // The whole point of the exercise: if these differ, the two clients are
      // no longer playing the same battle.
      hash: stateHash(st),
    }),
  } : null;

  if (!coop) return null;
  return {
    host: localOwner,
    guest: () => (canJoin(guestOwner) ? guestOwner : null),
    join: requestJoin,
  };
}
