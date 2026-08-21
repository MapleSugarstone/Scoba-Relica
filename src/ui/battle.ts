import type { Art } from "../engine/assets";
import { sfx } from "../engine/sfx";
import { STAT_LABELS, TYPE_COLORS, type ElementType } from "../sim/types";
import {
  startBattle,
  resolveTurn,
  joinBattle,
  benchFor,
  slotOf,
  slotsAwaitingChoice,
  emptySlots,
  sendIn,
  choiceError,
  moveReady,
  displayName,
  combatantMaxHp,
  statusSummary,
  specsFor,
  targetOptions,
  itemsOnHand,
  spendItem,
  previewMove,
  combatantStats,
  selfRunning,
  BASIC_ATTACK_TARGETS,
  type BattleEvent,
  type BattleState,
  type Choice,
  type Combatant,
  type OwnerId,
  type SlotHolder,
} from "../sim/battle";
import {
  ALL_SLOTS, TARGET_LABELS, isMoteSlot, needsPick, sameRef, type TargetRef, type TargetSpec,
} from "../sim/targeting";
import { STATUSES, statusName, type StatusInstance } from "../sim/status";
import { fieldSigilText, sigilText, sigilUrl, type SigilText } from "./sigil";
import { enemyChoices, moteChoices } from "../sim/ai";
import { rngFrom } from "../sim/rng";
import { gainXp, MAX_LEVEL, maxHp, moveCost, moveName, settleCaught, type ScobaInstance } from "../sim/scoba";
import { AETUS_PER_TRAINER, AETUS_PER_WILD } from "../sim/growth";
import { ABILITIES, abilityStatuses, MAX_MOVES, MOVES, SPECIES, typeLabel, type Move } from "../sim/species";
import { BattleStage } from "../game/battlestage";
import { uiZoom } from "../engine/renderer";
import { typeIcon, typeIcons } from "./typeicon";
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

export function battleStage(): BattleStage | null {
  return liveStage;
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
  onDone: (result: BattleResult) => void;
}

const OTHER: Record<OwnerId, OwnerId> = { A: "B", B: "A" };

/**
 * How much of the screen the action block takes, and how wide it ever gets.
 * Three rows fit inside it whatever page is up, which is what keeps a page from
 * moving the buttons or the scene above them. Wide and shallow: a button that
 * is as tall as it is broad reads as a tile rather than as something to press.
 */
const BAR_SHARE = 0.22;
const BAR_MAX_W = 900;

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
): ActiveBattle | null {
  return runBattle(ui, art, save, { enemies: [wild], wild: true, onDone });
}

export function openTrainerBattle(
  ui: UI,
  art: Art,
  save: SaveData,
  setup: { name: string; enemies: ScobaInstance[]; reward: number },
  onDone: (result: BattleResult) => void,
): ActiveBattle | null {
  return runBattle(ui, art, save, {
    enemies: setup.enemies,
    wild: false,
    trainerName: setup.name,
    rewardMoney: setup.reward,
    onDone,
  });
}

function runBattle(ui: UI, art: Art, save: SaveData, setup: BattleSetup): ActiveBattle | null {
  const { enemies, onDone } = setup;
  // Solo puts both characters in from the start and the one player picks for
  // both. With a second player connected only the character who walked into
  // the fight starts, and the other joins from the overworld.
  const coop = save.partnerJoined;
  const localOwner = save.localSlot;
  const guestOwner = OTHER[localOwner];
  const fighters: OwnerId[] = coop ? [localOwner] : ["A", "B"];

  // Slot 0 is always character A and slot 1 always character B, so two
  // clients building the same battle agree on which slot is whose.
  const owners: [SlotHolder, SlotHolder] = [
    fighters.includes("A") ? "A" : null,
    fighters.includes("B") ? "B" : null,
  ];
  const team = fighters.flatMap((owner) => partyOf(save, owner));
  const seed = `${save.worldSeed}:${Date.now().toString(36)}`;
  const st = startBattle(seed, team, enemies, {
    slots: 2, wild: setup.wild, owners, ez: save.ez,
  });
  // Local player's Scoba reads first, whichever character they control.
  const displayOrder: (0 | 1)[] = localOwner === "A" ? [0, 1] : [1, 0];
  /** Which order the slots are asked about in: Scobas first, Motes after. */
  const askOrder = (slot: number): number =>
    isMoteSlot(slot) ? 10 + slot : displayOrder.indexOf(slot as 0 | 1);

  const stage = new BattleStage(art, st, save, {
    fighters,
    trainer: setup.trainerName !== undefined,
  });
  stage.onFrame = () => positionPlates();
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
  /**
   * The action the current character has chosen but not yet aimed. Picking a
   * move opens this, and it closes once every target spec has an answer.
   */
  let aiming: { action: Choice; specs: TargetSpec[]; picks: (TargetRef | null)[]; at: number } | null = null;
  /** Which page of the action row the current character is looking at. */
  let menu: "main" | "abilities" | "items" | "flee" = "main";

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
   * own mana bar before it is committed to.
   */
  let costPreview: { index: number; cost: number } | null = null;

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
    if (stacks > 1) mark.appendChild(el("b", "sx", String(stacks)));
    const tip = el("span", "sigtip");
    tip.appendChild(el("strong", undefined, said.name));
    if (said.desc) tip.appendChild(el("span", undefined, said.desc));
    if (said.note) tip.appendChild(el("span", "dim", said.note));
    mark.appendChild(tip);
    // The readouts ride over the scene and reach its edges, so a window on
    // one out there is nudged back in rather than drawn off the screen.
    mark.addEventListener("pointerenter", () => nudgeTip(tip));
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
  const fillMarks = (marks: HTMLElement, side: 0 | 1, want: ReturnType<typeof statusSummary>): void => {
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
    for (const m of want) marks.appendChild(sigilMark(m.id, sigilText(m), m.stacks));
  };

  /** Shifts a hover window sideways until it clears both edges of the screen. */
  const nudgeTip = (tip: HTMLElement): void => {
    tip.style.setProperty("--nudge", "0px");
    const box = tip.getBoundingClientRect();
    const pad = 4;
    const over = box.right > window.innerWidth - pad
      ? window.innerWidth - pad - box.right
      : box.left < pad ? pad - box.left : 0;
    if (over !== 0) tip.style.setProperty("--nudge", `${Math.round(over / uiZoom())}px`);
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
    nm.appendChild(el("span", "lv", `Lv ${c.scoba.level}`));
    nm.appendChild(typeIcons(SPECIES[c.scoba.speciesId]!));
    wrap.appendChild(nm);
    const max = combatantMaxHp(c);
    const hpBar = bar("");
    const mpBar = bar("mp");
    // The share to the left of the bar rather than a caption under it: the
    // bar says what it is, and a number beside it is one line instead of two.
    const mpNum = el("span", "bpct", "");
    const mpRow = el("div", "brow");
    mpRow.append(mpNum, mpBar.node);
    const state = el("div", "bnum", "");
    const marks = el("div", "marks");
    wrap.append(hpBar.node, mpRow, state, marks);

    const refresh = (): void => {
      const now = stage.shownOf(ref.side, ref.index);
      const frac = Math.max(0, Math.min(1, now.hp / max));
      hpBar.set(frac, now.hpTrail / max, {
        color: frac < 0.25 ? "#d9553f" : frac < 0.55 ? "#e7a03c" : "#7aa74a",
      });
      const spend = ref.side === 0 && costPreview?.index === ref.index ? costPreview.cost : 0;
      mpBar.set(now.mana / 100, now.manaTrail / 100, { spend: spend / 100 });
      mpNum.textContent = `${now.mana}%`;
      // The bars say the numbers; this line is only for what they cannot.
      state.textContent = now.fainted ? "Fainted" : c.blocking ? "Blocking" : "";
      fillMarks(marks, ref.side, statusSummary(c));
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
   * A Mote's readout: the same numbers, small enough that three of them behind
   * a Scoba read as a row of helpers rather than as a second interface. It
   * carries no owner line and no level, since a Mote is always its summoner's
   * level and never anyone's to swap.
   */
  const moteCard = (c: Combatant, ref: TargetRef): { node: HTMLElement; refresh: () => void } => {
    const wrap = el("div", "bcard bmote");
    wrap.appendChild(el("div", "nm", displayName(c.scoba)));
    // Its own line rather than beside the name: a badge is 41 px of drawn art
    // that cannot be shrunk, and next to the name it would make a card wider
    // than the gap between two Mote marks on a phone.
    wrap.appendChild(typeIcons(SPECIES[c.scoba.speciesId]!));
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
      fillMarks(marks, ref.side, statusSummary(c));
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
   * The readouts, one per slot, laid over the scene and moved under whoever
   * is standing there. They sit below the Scobas rather than in a bar at the
   * top, so a Scoba and its numbers read as one thing.
   */
  const buildPlates = (): HTMLElement => {
    const layer = el("div", "bplates");
    plates = [];
    for (const side of [0, 1] as const) {
      for (const slot of ALL_SLOTS) {
        // Whoever the scene has on this mark, not whoever the battle does: a
        // Scoba downed this round is still standing there until its faint has
        // played, and its readout should fade out with it rather than
        // vanishing the moment the round resolves.
        const mote = isMoteSlot(slot);
        // A Mote called this round is not on the stage yet, so its mark is read
        // off the battle instead. Its readout is built hidden and fades in with
        // the poof rather than turning up a beat after it.
        const index = stage.fighterOn(side, slot)
          ?? (mote && (st.active[side][slot] ?? -1) >= 0 ? st.active[side][slot]! : null);
        const c = index === null ? null : st.teams[side][index];
        const owner = side === 0 && !mote ? st.slotOwner[slot] ?? null : null;
        let built: { node: HTMLElement; refresh: () => void } | null = null;
        if (c && index !== null) {
          built = mote ? moteCard(c, { side, index }) : card(c, { side, index });
          markTarget(built.node, { side, index });
        } else if (mote) {
          // An empty Mote mark is nothing at all: no card holds its place,
          // because nothing is ever coming to fill it.
          continue;
        } else if (side === 0 && owner === null && coop) {
          built = { node: emptyCard("Open slot", "Waiting for a player"), refresh: () => {} };
        } else if (side === 0 && owner !== null && benchFor(st, 0, slot).length > 0) {
          built = { node: emptyCard(nameOf(owner), "Send one in"), refresh: () => {} };
        }
        if (!built) continue;
        built.node.classList.add("bplate");
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
    // `vw`/`vh` are read before the root zoom and would come out at half the
    // screen on a phone, so both go through the zoom by hand.
    const zoom = uiZoom();
    const h = `${Math.round((window.innerHeight / zoom) * BAR_SHARE)}px`;
    const w = `${Math.round(Math.min((window.innerWidth / zoom) * 0.94, BAR_MAX_W))}px`;
    if (bar.style.height !== h) bar.style.height = h;
    if (bar.style.getPropertyValue("--bw") !== w) bar.style.setProperty("--bw", w);
    stage.setSafeBottom(bar.getBoundingClientRect().height);
  };

  const positionPlates = (): void => {
    // Before the `ready` check: the scene is laid out against this, so it has
    // to be known before the opening walk starts rather than after it.
    sizeActionBar();
    // Nothing is placed against a view the scene has not measured yet.
    if (!stage.ready()) return;
    for (const p of plates) {
      if (!p.node.isConnected) continue;
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

  /** Outlines a readout and makes it clickable while a target is being chosen. */
  const markTarget = (node: HTMLElement, ref: TargetRef): HTMLElement => {
    if (!aiming || !aimOptions().some((r) => sameRef(r, ref))) return node;
    node.classList.add("target");
    node.addEventListener("click", () => {
      if (busy) return;
      sfx.tap();
      choose(ref);
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
    stage.setAiming({ options, hover: null });
    const pick = (e: PointerEvent): TargetRef | null => {
      const hit = stage.hitTest(e.clientX, e.clientY);
      return hit && options.some((r) => sameRef(r, hit)) ? hit : null;
    };
    layer.addEventListener("pointermove", (e) => {
      if (!aiming) return;
      stage.setAiming({ options, hover: pick(e) });
    });
    layer.addEventListener("pointerleave", () => {
      if (aiming) stage.setAiming({ options, hover: null });
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
    const refOf = (slot: number): TargetRef | null => {
      const index = st.active[0][slot] ?? -1;
      return index >= 0 ? { side: 0, index } : null;
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

  const render = (): void => {
    // Rebuilding the page takes every button with it, and a removed button
    // never gets its pointerleave, so the mark goes with the page.
    costPreview = null;
    syncTurn();
    ui.screen((s) => {
      s.classList.add("stage");
      s.appendChild(buildPlates());
      s.appendChild(buildAimLayer());

      // The readouts pin to the top and bottom edges; the band between them
      // is left clear for the scene on the canvas behind. The banner and the
      // buttons share one fixed block, so neither resizes the other.
      const bottom = el("div", "bbottom");
      logEl = el("div", `blog${busy ? " on" : ""}`);
      logEl.textContent = busy ? lastLine.text : "";
      if (busy && lastLine.kind) logEl.classList.add(`ev-${lastLine.kind}`);
      bottom.appendChild(logEl);
      bottom.appendChild(buildActions());
      s.appendChild(bottom);
    });
    ui.setLocked(true);
    positionPlates();
  };

  const act = (
    label: string,
    sub: string,
    onPick: () => void,
    opts: { disabled?: boolean; alt?: boolean; small?: boolean; type?: ElementType } = {},
  ): HTMLButtonElement => {
    const b = el("button", `act${opts.alt ? " alt" : ""}${opts.small ? " small" : ""}${opts.type ? " typed" : ""}`) as HTMLButtonElement;
    if (opts.type) b.style.setProperty("--fill", TYPE_COLORS[opts.type]);
    b.appendChild(el("span", undefined, label));
    if (sub) b.appendChild(el("span", "sub", sub));
    b.disabled = !!opts.disabled || busy;
    b.addEventListener("click", () => {
      if (busy) return;
      sfx.tap();
      onPick();
    });
    return b;
  };

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
    if (slot === undefined) return wrap;
    const me = at(0, slot);
    if (!me) return wrap;

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
     * The step back to the other character. It hangs above the top right of
     * the buttons rather than joining a row: dropping it in shuffled
     * everything beside it every time the second picker came around.
     */
    const stepBack = (): HTMLElement | null => {
      if (pickIndex === 0 || menu !== "main") return null;
      const b = act("Back", "", () => {
        staged.pop();
        pickIndex -= 1;
        menu = "main";
        render();
      }, { alt: true, small: true });
      b.classList.add("tiny", "stepback");
      return b;
    };

    if (menu === "abilities") {
      // Always four cells. A Scoba with fewer slots shows the rest as dead
      // ones rather than shrinking the board, and the order never moves,
      // because statuses address these by position.
      const grid = el("div", "bgrid");
      for (let i = 0; i < MAX_MOVES; i++) {
        const id = me.scoba.moves[i];
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
      return rows([grid, minorRow(backToMain)]);
    }

    if (menu === "flee") {
      // Walking out ends it for both characters, so it asks first.
      const yn = el("div", "bactions bthree");
      yn.appendChild(act("Yes", "Leave the fight", () => pick({ kind: "flee", side: 0, slot })));
      yn.appendChild(act("No", "Stay in", () => {
        menu = "main";
        render();
      }, { alt: true }));
      return rows([yn], null, "Are you sure you want to flee the battle?");
    }

    if (menu === "items") {
      wrap.classList.add("bthree");
      const usable = BATTLE_ITEMS.filter((it) => !it.wildOnly || setup.wild);
      for (const item of usable) {
        const held = itemsOnHand(st, 0, item.id, save.bag[item.id] ?? 0);
        wrap.appendChild(act(item.name, `x${held} · ${item.desc}`, () => {
          if (spendItem(st, 0, item.id) === "bag") save.bag[item.id] = (save.bag[item.id] ?? 0) - 1;
          pick({ kind: "catch", side: 0, slot });
        }, { disabled: held <= 0 }));
      }
      if (usable.length === 0) wrap.appendChild(el("div", "aimline", "Nothing here to use."));
      return rows([wrap, minorRow(backToMain)]);
    }

    // What this Scoba does with its turn. Three, always, so the row never
    // changes shape whatever it knows, and three columns wide however narrow
    // the screen is, so it never reflows into two rows and back either.
    wrap.classList.add("bthree");
    // The basic attack has no move behind it, and lands as Plain, so that is
    // the colour it wears.
    wrap.appendChild(act("Basic attack", "100% Str",
      () => startAiming({ kind: "attack", side: 0, slot, picks: [] }), { type: "plain" }));
    wrap.appendChild(act("Abilities", `${me.scoba.moves.length} known`, () => {
      menu = "abilities";
      render();
    }));
    wrap.appendChild(act("Block", "-50% dmg", () => pick({ kind: "block", side: 0, slot }), { alt: true }));

    const minor = minorRow(
      act("Items", itemsNote(), () => {
        menu = "items";
        render();
      }, { alt: true, small: true }),
      act("Flee", "", () => {
        menu = "flee";
        render();
      }, { alt: true, small: true }),
      act("Extra", "", () => renderExtra(slot), { alt: true, small: true }),
    );
    minor.classList.add("bthree");
    return rows([wrap, minor], stepBack());
  };

  /** Stacks the action rows, with the step back floated above their corner. */
  /**
   * Buttons laid across the block three to a row, so a list of any length is
   * rows of standard buttons rather than one row wrapping into smaller ones.
   */
  const grid = (buttons: HTMLElement[]): HTMLElement[] => {
    const out: HTMLElement[] = [];
    for (let i = 0; i < buttons.length; i += 3) {
      const row = el("div", "bactions bthree");
      for (const b of buttons.slice(i, i + 3)) row.appendChild(b);
      out.push(row);
    }
    return out;
  };

  /**
   * A page of the action block. Every one of them is the same three rows tall,
   * so moving between them shifts neither the buttons nor the scene laid out
   * above them. `head` is a prompt hung over the top of the block out of flow,
   * the same place the banner uses, since the two are never up together.
   */
  const rows = (parts: HTMLElement[], corner?: HTMLElement | null, head?: string): HTMLElement => {
    const box = el("div", "bacts");
    if (head) box.appendChild(el("div", "aimline", head));
    if (corner) box.appendChild(corner);
    for (const part of parts) box.appendChild(part);
    return box;
  };

  const itemsNote = (): string => {
    const usable = BATTLE_ITEMS.filter((it) => !it.wildOnly || setup.wild);
    const total = usable.reduce((n, it) => n + itemsOnHand(st, 0, it.id, save.bag[it.id] ?? 0), 0);
    return total > 0 ? `${total} to hand` : "none";
  };

  /** A move as a button, with its cost, cooldown and what it aims at. */
  const abilityButton = (me: Combatant, move: Move, onPick: () => void): HTMLButtonElement => {
    const ready = moveReady(me, move.id);
    const cd = me.cds[move.id] ?? 0;
    const aimNote = move.targets.map((t) => TARGET_LABELS[t.mode]).join(" + ");
    const cost = moveCost(me.scoba, move.id);
    const sub = `${cost}% mana${move.cooldown ? ` · cd${move.cooldown}` : ""}${cd > 0 ? ` · wait ${cd}` : ""} · ${aimNote}`;
    const b = act(move.name, sub, onPick, { disabled: !ready.ok, type: move.type });
    // Reaching for a move marks its cost on the caster's bar, so what it
    // would leave behind is visible before it is picked. Keyboard focus does
    // the same, since a pointer is not the only way through the list.
    const index = st.teams[0].indexOf(me);
    const show = (on: boolean): void => {
      costPreview = on && index >= 0 ? { index, cost } : null;
    };
    b.addEventListener("pointerenter", () => show(true));
    b.addEventListener("pointerleave", () => show(false));
    b.addEventListener("focus", () => show(true));
    b.addEventListener("blur", () => show(false));
    return b;
  };

  // --- aiming ---

  /** The menu the spec being aimed at right now offers. */
  const aimOptions = (): TargetRef[] => {
    if (!aiming) return [];
    const slot = roundSlots[pickIndex];
    if (slot === undefined) return [];
    const index = st.active[0][slot] ?? -1;
    if (index < 0) return [];
    const spec = aiming.specs[aiming.at];
    if (!spec || !needsPick(spec.mode)) return [];
    return targetOptions(st, { side: 0, index }, spec);
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
      const sub = `${c.hp}/${combatantMaxHp(c)}${benched ? " · benched" : ""}`;
      picks.push(act(displayName(c.scoba), sub, () => choose(ref), { alt: ref.side === 0 }));
    }
    picks.push(act("Cancel", "", () => {
      aiming = null;
      render();
    }, { alt: true }));
    return rows(grid(picks), null, `${label}${step}`);
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

      const row = el("div", "bactions");
      if (benchFor(st, 0, slot).length > 0) {
        row.appendChild(act("Swap", "send another out", () => renderSwap(slot, () => renderExtra(slot)), { alt: true }));
      }
      row.appendChild(act("Back", "", () => render(), { alt: true }));
      s.appendChild(row);
    });
    ui.setLocked(true);
  };

  /** One Scoba on the Extra window: where it stands, its stats and its moves. */
  const scobaPanel = (c: Combatant, ref: TargetRef, slot: number): HTMLElement => {
    const wrap = el("div", "card xscoba");
    const sp = SPECIES[c.scoba.speciesId]!;
    const out = st.active[0].includes(ref.index);
    const nm = el("div", "nm");
    nm.appendChild(el("strong", undefined, displayName(c.scoba)));
    nm.appendChild(el("span", "lv", `Lv ${c.scoba.level}`));
    nm.appendChild(typeIcons(sp));
    const mote = st.teams[0].indexOf(c) >= 0 && c.mote;
    nm.appendChild(el("span", "lv",
      c.fainted ? "· fainted" : mote ? "· mote" : out ? "· out" : "· benched"));
    wrap.appendChild(nm);

    const stats = combatantStats(c);
    const line = el("div", "xstats");
    line.appendChild(el("span", undefined, `HP ${c.hp}/${combatantMaxHp(c)}`));
    for (const key of ["str", "def", "res", "mag", "spd"] as const) {
      line.appendChild(el("span", undefined, `${STAT_LABELS[key]} ${stats[key]}`));
    }
    wrap.appendChild(line);

    for (const id of [sp.primaryAbility, c.scoba.secondaryAbility]) {
      const ab = ABILITIES[id];
      if (!ab) continue;
      const row = el("div", "xpass");
      row.appendChild(el("strong", undefined, ab.name));
      row.appendChild(el("span", undefined, ab.desc));
      // A passive with charges left to spend says how many are left.
      const spent = abilityStatuses(id)
        .map((sid) => c.statuses.find((held) => held.id === sid))
        .filter((held): held is StatusInstance => !!held && held.chargesLeft > 0)
        .map((held) => `${statusName(held.id)} x${held.chargesLeft}`);
      if (spent.length > 0) row.appendChild(el("span", "dim", spent.join(", ")));
      wrap.appendChild(row);
    }

    const detail = el("div", "xinfo");
    const row = el("div", "bactions");
    for (const id of c.scoba.moves) {
      const move = MOVES[id];
      if (!move) continue;
      row.appendChild(act(move.name, `${moveCost(c.scoba, move.id)}% mana`, () => {
        detail.innerHTML = "";
        detail.appendChild(explainMove(move, ref, slot));
      }, { type: move.type }));
    }
    wrap.appendChild(row);
    wrap.appendChild(detail);
    return wrap;
  };

  /** Colour a run of text by what kind of damage it is. */
  const dmgSpan = (text: string, category: "physical" | "magic" | "true"): HTMLElement => {
    const e = el("span", `dmg ${category}`, text);
    return e;
  };

  /** What a move does, in numbers, against what is standing there now. */
  const explainMove = (move: Move, ref: TargetRef, slot: number): HTMLElement => {
    const box = el("div");
    const preview = previewMove(st, ref, move.id);
    const holder = st.teams[ref.side][ref.index] ?? null;
    const cost = holder ? moveCost(holder.scoba, move.id) : move.manaCost;
    const head = el("div", "xhead");
    head.appendChild(el("strong", undefined, move.name));
    head.appendChild(typeIcon(move.type));
    head.appendChild(el("span", "dim", `${cost}% mana${move.cooldown ? ` · cooldown ${move.cooldown}` : ""}`));
    // A move a line does not learn is worked rather than known, and says so.
    if (holder && cost > move.manaCost) {
      head.appendChild(el("span", "dim", `· worked, +${cost - move.manaCost}`));
    }
    box.appendChild(head);

    if (preview && preview.stat && preview.scale > 0) {
      const cat = preview.category === "physical" ? "physical" : "magic";
      const line = el("div");
      line.appendChild(document.createTextNode("Scales "));
      line.appendChild(dmgSpan(`${Math.round(preview.scale * 100)}% ${STAT_LABELS[preview.stat]}`, cat));
      box.appendChild(line);
    }
    if (preview && preview.damage !== null) {
      const cat = preview.category === "physical" ? "physical" : "magic";
      const line = el("div");
      line.appendChild(document.createTextNode("Would deal "));
      line.appendChild(dmgSpan(`${preview.damage} damage`, cat));
      if (preview.eff > 1) line.appendChild(el("span", "good", " Super effective."));
      if (preview.eff < 1) line.appendChild(el("span", "dim", " Resisted."));
      box.appendChild(line);
    }
    if (preview && preview.heal !== null) {
      const line = el("div");
      line.appendChild(document.createTextNode("Restores "));
      line.appendChild(el("span", "good", `${preview.heal} HP`));
      line.appendChild(document.createTextNode(` (${Math.round(move.scale * 100)}% of its pool)`));
      box.appendChild(line);
    }

    box.appendChild(el("div", "dim", `Aims at ${move.targets.map((t) => TARGET_LABELS[t.mode]).join(", then ")}.`));

    for (const effect of move.effects ?? []) {
      box.appendChild(explainEffect(effect, move));
    }
    void slot;
    return box;
  };

  const explainEffect = (effect: NonNullable<Move["effects"]>[number], move: Move): HTMLElement => {
    const line = el("div");
    switch (effect.kind) {
      case "status": {
        const def = STATUSES[effect.status];
        line.appendChild(document.createTextNode("Leaves "));
        line.appendChild(el("strong", undefined, def?.name ?? effect.status));
        line.appendChild(document.createTextNode(`: ${def?.desc ?? ""}`));
        break;
      }
      case "transfer": {
        line.appendChild(document.createTextNode(`Takes ${Math.round(effect.frac * 100)}% of target ${effect.from + 1}'s HP and `));
        line.appendChild(effect.deliver === "heal"
          ? el("span", "good", `heals target ${effect.to + 1} with it`)
          : dmgSpan(`spends it on target ${effect.to + 1}`, "true"));
        break;
      }
      case "cleanse":
        line.textContent = `Clears ${effect.polarity === "bad" ? "ailments" : "blessings"} from target ${effect.target + 1}.`;
        break;
      case "copy-statuses":
        line.textContent = `Copies target ${effect.from + 1}'s marks onto target ${effect.to + 1}.`;
        break;
      case "summon": {
        const called = SPECIES[effect.species];
        // A Mote comes out at whoever called it, so naming a level would be a
        // number the move never uses.
        line.textContent = called?.mote
          ? `Calls up a ${called.name} Mote at the caster's own level.`
          : `Calls a level ${effect.level} ${called?.name ?? effect.species} to your side.`;
        break;
      }
      case "grant-item":
        line.textContent = `Finds ${effect.count} ${effect.item}.`;
        break;
      case "damage": {
        line.appendChild(document.createTextNode("Also strikes target "));
        line.appendChild(dmgSpan(`${effect.target + 1} for ${Math.round(effect.scale * 100)}% Strength`, "physical"));
        break;
      }
      case "heal":
        line.appendChild(document.createTextNode("Also restores "));
        line.appendChild(el("span", "good", `${Math.round(effect.frac * 100)}% of target ${effect.target + 1}'s pool`));
        break;
    }
    void move;
    return line;
  };

  /** `back` is where its Back button goes, since Swap is reached from Extra. */
  const renderSwap = (slot: number, back: () => void = render): void => {
    ui.screen((s) => {
      s.appendChild(el("h2", undefined, `${nameOf(st.slotOwner[slot] ?? null)}: send out`));
      const row = el("div", "bactions");
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
    logEl.className = `blog on ev-${kind}`;
    logEl.textContent = text;
  };

  /** Opens a fresh round of choices, letting a queued join in first. */
  const beginRound = (): void => {
    staged = [];
    pickIndex = 0;
    aiming = null;
    sendInSlots = [];
    menu = "main";
    flushJoin();
    // The Motes that run themselves are left off: nobody is asked about them,
    // and their choices come out of the AI when the round is submitted.
    roundSlots = slotsAwaitingChoice(st, 0)
      .filter((slot) => {
        const c = at(0, slot);
        return !!c && !selfRunning(c);
      })
      .sort((a, b) => askOrder(a) - askOrder(b));
    // Nobody left to ask, but the field is not empty: the round still has to
    // play so whatever is standing there gets its turn.
    if (roundSlots.length === 0) {
      submitRound();
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
    // Fleeing ends the battle before anyone acts, so nobody else picks.
    if (choice.kind === "flee") {
      submitRound();
      return;
    }
    pickIndex += 1;
    menu = "main";
    if (pickIndex >= roundSlots.length) submitRound();
    else render();
  };

  const submitRound = (): void => {
    busy = true;
    aiming = null;
    // Motes take no xp from a win: they are not there afterwards to have it.
    for (const slot of [0, 1] as const) {
      const idx = st.active[0][slot] ?? -1;
      if (idx >= 0) participated.add(idx);
    }
    // What the plates show is frozen where the player can see it, then let
    // out event by event as the round plays.
    stage.snapshot();
    const events = resolveTurn(st, [...staged, ...moteChoices(st, 0), ...enemyChoices(st)]);
    staged = [];
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
    sendInSlots = emptySlots(st, 0);
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
  const flushJoin = (): void => {
    const owner = pendingJoin;
    if (owner === null) return;
    if (busy || staged.length > 0) return;
    pendingJoin = null;
    if (!canJoin(owner)) return;
    say(`${nameOf(owner)} joins the battle!`, "win");
    for (const ev of joinBattle(st, owner, partyOf(save, owner))) say(ev.text, ev.kind);
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
    void ui.transition(() => {
      stage.onFrame = null;
      liveStage = null;
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
    return null;
  }
  // The opening walks everyone on, then plays whatever the opening triggers
  // had to say, which is where a passive that calls up a Mote goes off.
  render();
  busy = true;
  void stage.playIntro().then(() => {
    busy = false;
    playThen(st.opening, fillEmpties);
  });

  if (!coop) return null;
  return {
    host: localOwner,
    guest: () => (canJoin(guestOwner) ? guestOwner : null),
    join: requestJoin,
  };
}
