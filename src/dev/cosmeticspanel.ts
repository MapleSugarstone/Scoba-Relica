// The cosmetics editor itself: pick something to move, pick a line, pick which
// of its costumes, and drag.
//
// Plain DOM and its own stylesheet, so it mounts anywhere. The game hangs it on
// a screen behind F3, and `tools/cosmetics` serves it as a page of its own that
// writes the document straight to disk. Both drive the same panel, so what one
// of them shows is what the other shows.
//
// What it writes is a nudge off the automatic answer rather than a position of
// its own, so a costume nobody has touched keeps tracking its own art. See
// `game/cosmetics.ts` for why.
import type { Art } from "../engine/assets";
import { DOLL_H, DOLL_PIVOT, DOLL_W, worldSprite } from "../engine/paperdoll";
import { DEFAULT_LOOK } from "../engine/recolor";
import { ART } from "../engine/renderer";
import {
  accessoryBox, accessorySpot, autoPieceSpot, centerAnchor, contentBox, contentMiddle,
  critterImage, forgetBuiltArt, movementOf, originAnchor, pivotOf, sizeOf,
} from "../game/critters";
import { MOTIONS } from "../game/actors";
import { bounce } from "../engine/sprite";
import {
  BIG_SHADOW, DEFAULT_SHADOW, NO_SHADOW, PLAYER_COSTUME, asOneStep, canRedo, canUndo,
  clearLine, clearPlacement, cosmeticsJson, movementFor, placedCount, placementFor,
  redoCosmetics, setMovement, setPlacement, setSetup, setupFor, shadowFor,
  undoCosmetics,
  type CostumeSetup, type Placement, type ShadowSetup, type Spot,
} from "../game/cosmetics";
import type { TextKind } from "../game/texts";
import { buildDataPanel } from "./datapanel";
import { el } from "./dom";
import { buildNewScoba } from "./newscoba";
import { describeAbility, describeMoveEffects } from "../sim/describe";
import { TOKENS } from "../sim/prose";
import { proseNodes } from "../ui/prose";
import {
  ABILITIES, HYPER_FORM, MOVES, SPECIES, artNameFor, costumesOf, kinCostumes,
  type Costume, type MovementStyle, type Species,
} from "../sim/species";

/** How much bigger than the sprite the preview is drawn. */
const ZOOM = 3;
/** The zooms the stage steps through, whole numbers so every art pixel stays square. */
const ZOOMS = [1, 2, 3, 4, 6, 8];

/**
 * How the preview moves the drawing. Each is a thing the game actually does
 * with it: standing in the world, walking about in it, waiting its turn on the
 * battle stage, and walking onto that stage.
 */
type Showing = "still" | "overworld" | "idle" | "entering";

const SHOWINGS: { id: Showing; label: string; hint: string }[] = [
  { id: "still", label: "Still", hint: "Standing where it is." },
  { id: "overworld", label: "Overworld", hint: "Walking about the island." },
  { id: "idle", label: "In battle", hint: "Waiting its turn on the stage." },
  { id: "entering", label: "Walking on", hint: "Coming onto the stage." },
];

/** How much of its walk a Scoba keeps while it waits on the battle stage. */
const BATTLE_IDLE = 0.45;

/**
 * How far off its mark a Scoba starts when it walks onto the stage, in sprite
 * pixels. Inside the frame rather than off the edge of it, so the whole walk is
 * on screen in a box this size.
 */
const WALK_ON_FROM = 26;

/** Sprite pixels a second, which is about the pace the stage walks one on at. */
const WALK_ON_PACE = 40;

/** The box every dex portrait is fitted into, so the grid is one size throughout. */
const DEX_CELL = { w: 74, h: 62 };

/** Every gait a line can be given, and the entry that hands it back to its species. */
const GAITS: MovementStyle[] = ["hop", "scamper", "hover", "skitter", "moonhop"];

/**
 * What the drag moves. Each is one thing stored against a costume, except the
 * piece, which is stored against a costume and an accessory together.
 */
type Tool = "piece" | "shadow" | "body" | "origin" | "center";

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: "piece", label: "Piece", hint: "Drag the piece onto the head." },
  { id: "shadow", label: "Shadow", hint: "Drag the shadow under the feet, or pick a size." },
  { id: "body", label: "Body", hint: "Drag the whole drawing off its feet line." },
  { id: "origin", label: "Throws from", hint: "Drag to where a throw should leave." },
  { id: "center", label: "Lands on", hint: "Drag to where a throw should land." },
];

/** What the host around the panel provides. */
export interface PanelHost {
  /** Says what just happened, wherever the host puts such lines. */
  note: (text: string) => void;
  /** Offered as a button where the host has somewhere to go back to. */
  onDone?: () => void;
  /**
   * What the panel's Save button does, and what to call it. A host that can
   * write the document offers one; a host that cannot leaves it off and the
   * panel falls back to a download.
   */
  save?: { label: string; run: (json: string) => Promise<string> };
}

export interface Panel {
  root: HTMLElement;
  /** Takes the panel's key handling off again. */
  dispose: () => void;
  /** Whether any game data has been applied and not yet saved. */
  unsavedData: () => boolean;
}

/**
 * Whether a key event came from something you type into, which keeps its own
 * keys. Every kind of input counts, a slider included, since arrows move one.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** One line of writing a player reads, on the record it belongs to. */
interface Words {
  kind: TextKind;
  id: string;
  /** Which sort of thing it is about, for the heading over the box. */
  what: string;
  name: string;
}

/** Everything about one line that is written in words: itself, its passives, its moves. */
function wordsFor(sp: Species): Words[] {
  const out: Words[] = [{ kind: "species", id: sp.id, what: "Scoba", name: sp.name }];
  const passives = [sp.primaryAbility, ...sp.secondaryPool, sp.hyperAbility ?? ""];
  for (const id of passives) {
    const ability = ABILITIES[id];
    if (!ability || out.some((w) => w.kind === "ability" && w.id === id)) continue;
    out.push({ kind: "ability", id, what: "Passive", name: ability.name });
  }
  for (const id of sp.moves) {
    const move = MOVES[id];
    if (!move || out.some((w) => w.kind === "move" && w.id === move.id)) continue;
    out.push({ kind: "move", id: move.id, what: "Move", name: move.name });
  }
  return out;
}

/** Every line something could be placed on, the Pawns and the special one too. */
function lines(): Species[] {
  return Object.values(SPECIES).filter((sp) => sp.sprite.kind === "art");
}

/** Which passive hands out a piece, for saying what a nudge is actually for. */
function ownerOf(accessory: string): string {
  const found = Object.values(ABILITIES).find((a) => a.accessory === accessory);
  return found ? found.name : accessory;
}

/**
 * What to call a costume on its tab. The base drawing is named after the line
 * rather than after the fact that it is the one the art was drawn as, which
 * said nothing about what picking it does.
 */
function costumeName(sp: Species, c: Costume): string {
  if (c.tags.length === 0) return sp.name;
  return c.tags.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" + ");
}


const STYLE_ID = "cosmetics-panel-style";

/**
 * The panel's own stylesheet, put in once. It carries everything the panel
 * needs rather than leaning on the game's, because the standalone page has
 * none of the game's CSS at all.
 */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .cosPanel {
      --ink: #10131f;
      --deep: #0b0e1a;
      --glow: #fff3d0;
      --ground: #191d2e;
      --panel: #2a3049;
      --quiet: #222741;
      --raised: #3a4263;
      --dead: #212434;
      --text: #e9edf9;
      --dim: #99a2c0;
      --dead-text: #585e76;
      /* Deep enough that the one text colour clears 4.5:1 on every one of them,
         which is what decides these values rather than how bright they look. */
      --act: #3d63c9;
      --confirm: #2c6b41;
      --warn: #7d581e;
      --danger: #ab4038;
      --pick: #e8c46a;

      display: flex;
      flex-direction: column;
      gap: 10px;
      width: min(100%, 940px);
      margin: 0 auto;
      color: var(--text);
    }

    /* Every control is one raised box lit from the top left. A component picks
       a fill and inherits the rest, so a category reads by its colour alone. */
    .cosPanel button, .cosPanel .cosField {
      --fill: var(--panel);
      --gloss: #0000;
      --lit: color-mix(in srgb, var(--fill) 74%, var(--glow));
      --shade: color-mix(in srgb, var(--fill) 70%, var(--deep));
      font: inherit;
      font-size: 12px;
      line-height: 1.25;
      color: var(--text);
      border: 2px solid var(--ink);
      border-radius: 0;
      padding: 5px 9px;
      cursor: pointer;
      background:
        linear-gradient(var(--gloss) 0 0) 0 0 / 100% 100% no-repeat,
        linear-gradient(var(--lit) 0 0) 0 0 / 100% 2px no-repeat,
        linear-gradient(var(--lit) 0 0) 0 0 / 2px 100% no-repeat,
        linear-gradient(to top, var(--shade) 0 2px, #0000 2px) 0 0 / 100% 100% no-repeat,
        linear-gradient(to left, var(--shade) 0 2px, #0000 2px) 0 0 / 100% 100% no-repeat,
        var(--fill);
    }
    @media (hover: hover) {
      .cosPanel button:hover:not(:disabled) { --gloss: #fff4dd16; }
    }
    /* A press sinks the box: the two faces swap and the label drops with them. */
    .cosPanel button:active:not(:disabled) {
      background:
        linear-gradient(var(--shade) 0 0) 0 0 / 100% 2px no-repeat,
        linear-gradient(var(--shade) 0 0) 0 0 / 2px 100% no-repeat,
        linear-gradient(to top, var(--lit) 0 2px, #0000 2px) 0 0 / 100% 100% no-repeat,
        linear-gradient(to left, var(--lit) 0 2px, #0000 2px) 0 0 / 100% 100% no-repeat,
        var(--fill);
      transform: translateY(1px);
    }
    .cosPanel button:focus-visible {
      outline: 2px solid var(--pick);
      outline-offset: -5px;
    }
    .cosPanel button:disabled {
      --fill: var(--dead);
      color: var(--dead-text);
      cursor: default;
    }

    /* The categories. Each is a fill, so nothing depends on reading the label.
       Every one is scoped to the panel, because the rule that sets the default
       fill names an element as well as a class and would otherwise outrank a
       bare category class. */
    .cosPanel .cosTool { --fill: var(--quiet); text-align: left; }
    .cosPanel .cosTool.on { --fill: var(--act); }
    .cosPanel .cosSub { --fill: var(--quiet); }
    .cosPanel .cosSub.on { --fill: var(--raised); }
    .cosPanel .cosTab { --fill: var(--quiet); }
    .cosPanel .cosTab.on { --fill: var(--raised); }
    .cosPanel .cosGaitB { --fill: var(--quiet); }
    .cosPanel .cosGaitB.on { --fill: var(--raised); }
    .cosPanel .cosAct { --fill: var(--panel); }
    .cosPanel .cosAct.on { --fill: var(--act); }
    .cosPanel .cosGo { --fill: var(--confirm); }
    /* Above the frame, where they sit beside the costume tabs. */
    .cosPanel .cosMini { --fill: var(--quiet); font-size: 11px; padding: 3px 7px; }
    .cosAbove { align-items: center; }
    .cosSteps { margin-left: auto; }
    .cosPanel .cosWarn { --fill: var(--warn); }
    .cosPanel .cosDanger { --fill: var(--danger); }

    .cosHead { font-weight: 700; font-size: 15px; letter-spacing: 0.02em; }
    .cosNote { font-size: 12px; color: var(--dim); }
    .cosLabel {
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--dim);
    }
    .cosRow { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }

    /* A sunken well: the same two faces the other way up. */
    .cosWell {
      --fill: var(--ground);
      --lit: color-mix(in srgb, var(--fill) 74%, var(--glow));
      --shade: color-mix(in srgb, var(--fill) 70%, var(--deep));
      border: 2px solid var(--ink);
      background:
        linear-gradient(var(--shade) 0 0) 0 0 / 100% 2px no-repeat,
        linear-gradient(var(--shade) 0 0) 0 0 / 2px 100% no-repeat,
        linear-gradient(to top, var(--lit) 0 2px, #0000 2px) 0 0 / 100% 100% no-repeat,
        linear-gradient(to left, var(--lit) 0 2px, #0000 2px) 0 0 / 100% 100% no-repeat,
        var(--fill);
    }

    /* Three columns where there is room for them, and the dex wraps to a row of
       its own where there is not. Wrapping rather than a width query, because
       the panel is mounted in two hosts of different widths. */
    .cosBody { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
    .cosSide { flex: 0 0 132px; }
    .cosMain { flex: 1 1 ${DOLL_W * ZOOM + 12}px; min-width: ${DOLL_W * ZOOM + 12}px; }
    .cosDex { flex: 1 1 252px; min-width: 252px; }
    .cosSide { display: flex; flex-direction: column; gap: 4px; padding: 8px; }
    .cosSide .cosLabel { margin-top: 4px; }
    .cosSide .cosLabel:first-child { margin-top: 0; }
    .cosMain { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .cosStage { display: flex; justify-content: center; padding: 6px; }
    .cosCanvas { image-rendering: pixelated; touch-action: none; cursor: crosshair; }
    .cosZoom { min-width: 2.5em; text-align: center; align-self: center; font-size: 12px; }
    .cosField {
      cursor: text;
      width: 100%;
      box-sizing: border-box;
    }

    /* The mini-dex: one cell size for every line, however big it is drawn. */
    .cosDex { display: flex; flex-direction: column; gap: 6px; }
    .cosGrid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
      gap: 4px;
      max-height: 404px;
      overflow-y: auto;
      padding: 6px;
      align-content: start;
    }
    .cosPanel .cosCell {
      --fill: var(--ink);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 4px 2px 3px;
      border-color: var(--raised);
    }
    .cosPanel .cosCell.on { --fill: var(--act); border-color: var(--pick); }
    .cosShot {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      height: 62px;
    }
    .cosShot canvas { image-rendering: pixelated; }
    .cosName {
      font-size: 10px;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cosCell .cosMoved { color: var(--pick); }
    .cosState { padding: 6px 8px; font-size: 12px; }

    /* What the game says about a line, and what an author says instead. */
    .cosWords { display: flex; flex-direction: column; gap: 4px; }
    .cosWord { display: flex; flex-direction: column; gap: 3px; padding: 6px; }
    .cosWordWho { font-size: 11px; font-weight: 700; }
    .cosWordWas { font-size: 11px; color: var(--dim); }
    .cosWordHead { display: flex; align-items: center; gap: 6px; }
    .cosWordHead .cosWordWho { flex: 1; }
    .cosPanel .cosWordBox { font-size: 11px; resize: vertical; min-height: 34px; }
    /* The game's own records, as the JSON they are stored in. */
    .cosData { display: flex; flex-direction: column; gap: 4px; }
    .cosDataBox { display: flex; flex-direction: column; gap: 3px; padding: 6px; }
    .cosDataRole { font-size: 10px; color: var(--dim); font-family: ui-monospace, monospace; }
    .cosPanel .cosDataText {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      line-height: 1.35;
      resize: vertical;
      white-space: pre;
      overflow-x: auto;
      tab-size: 2;
    }
    .cosPanel .cosDataText.bad { border-color: var(--danger); }
    .cosDataProblem { font-size: 11px; color: #ff9a8f; }
    .cosKeys { display: flex; flex-direction: column; gap: 1px; }
    .cosKey { font-size: 10px; color: var(--dim); font-family: ui-monospace, monospace; }
    .cosWordNow { font-size: 11px; padding: 3px 0 0; }
    /* The highlighted word, as the game will draw it. */
    .cosPanel .pnum {
      position: relative;
      color: var(--pick);
      border-bottom: 1px dotted var(--pick);
      cursor: help;
    }
    .cosPanel .pnum .ptip {
      position: absolute;
      left: 0;
      bottom: calc(100% + 3px);
      z-index: 5;
      display: none;
      width: 200px;
      padding: 6px;
      font-size: 10px;
      line-height: 1.3;
      color: var(--text);
      background: var(--ink);
      border: 2px solid var(--act);
    }
    .cosPanel .pnum:hover .ptip, .cosPanel .pnum:focus-within .ptip { display: block; }

    /* A block with a display of its own still goes when it is hidden. */
    .cosPanel [hidden] { display: none !important; }

    /* Picking out of a table: a search box with the matches listed under it. */
    .cosPick { position: relative; flex: 1 1 160px; min-width: 140px; }
    .cosPanel .cosPickIn { font-size: 11px; padding: 3px 7px; }
    .cosPickList {
      position: absolute;
      left: 0;
      right: 0;
      top: 100%;
      z-index: 6;
      display: flex;
      flex-direction: column;
      max-height: 260px;
      overflow-y: auto;
      padding: 3px;
    }
    .cosPanel .cosPickRow {
      --fill: var(--ink);
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      padding: 3px 6px;
      border-color: var(--quiet);
      text-align: left;
      font-size: 11px;
    }
    .cosPickHead { display: flex; gap: 6px; align-items: baseline; }
    .cosPickId, .cosChipId { font-family: ui-monospace, monospace; font-size: 10px; color: var(--dim); }
    .cosPickHint { font-size: 10px; color: var(--dim); }
    .cosPickNone { padding: 4px 6px; }

    /* A line's kit: chips for what it has, a picker beside them for more. */
    .cosKit { display: flex; flex-direction: column; gap: 6px; }
    .cosKitBlock { display: flex; flex-direction: column; gap: 3px; }
    .cosKitRow { align-items: center; }
    .cosKitWhat { font-size: 11px; color: var(--dim); min-width: 42px; }
    .cosChip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 4px 2px 7px;
      font-size: 11px;
      background: var(--quiet);
      border: 2px solid var(--ink);
    }
    .cosPanel .cosChipX { --fill: var(--ink); font-size: 10px; line-height: 1; padding: 1px 5px; }
    .cosPanel .cosLevel { width: 52px; font-size: 11px; padding: 3px 5px; cursor: text; }
    .cosShared { font-size: 10px; }

    /* Forms: a label, then its control, wrapping as a row. */
    .cosFormRow { align-items: center; row-gap: 6px; }
    .cosPanel .cosFormIn { flex: 1 1 120px; min-width: 100px; font-size: 11px; padding: 3px 7px; cursor: text; }
    .cosPanel .cosFormSel { font-size: 11px; padding: 3px 5px; }
    .cosPanel .cosMono { font-family: ui-monospace, monospace; }
    .cosPanel .cosField.bad { border-color: var(--danger); }
    .cosOver { color: #ff9a8f; }
    .cosNew, .cosBuilder { display: flex; flex-direction: column; gap: 6px; padding: 8px; }

    /* The builder: the box on the left, the palette down the right. */
    .cosBuildWork { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
    .cosBuildBox { flex: 1 1 320px; min-width: 260px; display: flex; flex-direction: column; gap: 4px; }
    .cosBuildReads { display: flex; flex-direction: column; gap: 3px; }
    .cosBuildRead { display: flex; flex-direction: column; gap: 1px; font-size: 11px; }
    .cosPalette {
      flex: 0 1 300px;
      min-width: 220px;
      max-height: 420px;
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cosPalGroup { display: flex; flex-direction: column; gap: 2px; }
    .cosPalGroup summary { cursor: pointer; font-size: 11px; font-weight: 700; padding: 2px 0; }
    .cosPanel .cosPalB {
      --fill: var(--ink);
      font-family: ui-monospace, monospace;
      font-size: 10px;
      text-align: left;
      padding: 2px 6px;
      border-color: var(--quiet);
      white-space: pre-wrap;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Builds the editor. The caller mounts `root` wherever it likes and calls
 * `dispose` when it comes down.
 */
export function buildCosmeticsPanel(art: Art, host: PanelHost): Panel {
  ensureStyles();
  const root = el("div", "cosPanel");
  // The shadows live in the same folder but are not worn on anything, so the
  // piece list leaves them to the tool that does place them.
  const pieces = Object.keys(art.accessories)
    .filter((name) => name !== DEFAULT_SHADOW && name !== BIG_SHADOW)
    .sort();

  root.appendChild(el("div", "cosHead", "Cosmetics"));
  const hint = el("div", "cosNote", "");
  root.appendChild(hint);

  let tool: Tool = pieces.length > 0 ? "piece" : "body";
  let piece = pieces[0] ?? "";
  let speciesId = lines()[0]?.id ?? "";
  /** Which of the line's costumes is being placed on. */
  let forms: string[] = [];
  let query = "";

  /** Is the player doll the subject rather than a Scoba? */
  const onPlayer = (): boolean => speciesId === PLAYER_COSTUME;

  /** The drawing being placed on, which is what everything here is keyed by. */
  const costume = (): string => {
    if (onPlayer()) return PLAYER_COSTUME;
    const sp = SPECIES[speciesId];
    return (sp ? artNameFor(sp, forms) : null) ?? speciesId;
  };

  /** The pixels being placed on: a Scoba's costume, or the player's doll. */
  const bodyImage = (): HTMLCanvasElement | HTMLImageElement => {
    if (onPlayer()) return worldSprite(art.doll, DEFAULT_LOOK).img;
    const sp = SPECIES[speciesId];
    return sp ? critterImage(art, sp, undefined, false, { forms }) : new Image();
  };

  /** Has any costume of this line been moved off its own art in any way? */
  const lineMoved = (sp: Species): boolean =>
    costumesOf(sp).some((c) => {
      const name = artNameFor(sp, c.tags) ?? sp.id;
      return Object.keys(setupFor(name)).length > 0
        || pieces.some((p) => placementFor(p, name) !== null);
    }) || movementFor(sp.id, sp.id) !== null;

  /** The drag in progress, on top of whatever is already stored. */
  let dragging: { fromX: number; fromY: number; dx: number; dy: number } | null = null;

  /**
   * What the preview is doing with the drawing, and where it is in that. The
   * phase and the ease are the ones an actor keeps, so what the preview shows
   * is the walk the game would give it rather than one written twice.
   */
  let showing: Showing = "still";
  let hopT = 0;
  let hopEase = 0;
  /** How far left of its mark the walk-on has it, in sprite pixels. */
  let walkOff = 0;
  let frame = 0;
  let last = 0;

  const drag = (): Spot => ({ dx: dragging?.dx ?? 0, dy: dragging?.dy ?? 0 });
  const plus = (a: Spot, b: Spot): Spot => ({ dx: a.dx + b.dx, dy: a.dy + b.dy });

  /** Where the piece sits right now, the drag in progress folded in. */
  const placement = (): Placement => {
    const stored = placementFor(piece, costume()) ?? { dx: 0, dy: 0 };
    if (tool !== "piece" || !dragging) return stored;
    return { ...stored, ...plus(stored, drag()) };
  };

  /** What the costume is set to right now, the drag in progress folded in. */
  const setup = (): CostumeSetup => {
    const stored = setupFor(costume());
    if (!dragging || tool === "piece") return stored;
    const at = drag();
    if (tool === "body") return { ...stored, body: plus(stored.body ?? ZERO, at) };
    if (tool === "origin") return { ...stored, origin: plus(stored.origin ?? ZERO, at) };
    if (tool === "center") return { ...stored, center: plus(stored.center ?? ZERO, at) };
    const shadow = shadowFor(costume());
    return { ...stored, shadow: { ...shadow, ...plus(shadow, at) } };
  };

  /** The shadow on screen, which is the default one until something says otherwise. */
  const shadowNow = (): ShadowSetup => setup().shadow ?? shadowFor(costume());

  /** Is the costume on screen a Hyper-Mode drawing? */
  const onHyper = (): boolean => forms.includes(HYPER_FORM);

  /** What to call the costumes a match reaches, for saying what it did. */
  const kindName = (): string => (onHyper() ? "Hyper" : "ordinary");

  /** The line's costumes drawn from the same body as the one on screen. */
  const kin = (): Costume[] => {
    const sp = SPECIES[speciesId];
    return sp ? kinCostumes(sp, forms) : [];
  };

  // The panel proper: what to place down the side, what it is being placed on
  // in the middle.
  const body = el("div", "cosBody");
  const side = el("aside", "cosSide cosWell");
  const main = el("div", "cosMain");
  body.appendChild(side);
  body.appendChild(main);

  // --- which tool ---
  side.appendChild(el("div", "cosLabel", "Place"));
  const toolRow = el("div", "cosRow");
  toolRow.style.flexDirection = "column";
  toolRow.style.alignItems = "stretch";
  const drawTools = (): void => {
    toolRow.innerHTML = "";
    for (const t of TOOLS) {
      if (t.id === "piece" && pieces.length === 0) continue;
      const b = el("button", `cosTool${t.id === tool ? " on" : ""}`, t.label);
      b.addEventListener("click", () => {
        tool = t.id;
        dragging = null;
        redraw();
      });
      toolRow.appendChild(b);
    }
  };
  side.appendChild(toolRow);

  // --- which piece, or which shadow ---
  const pieceLabel = el("div", "cosLabel", "");
  side.appendChild(pieceLabel);
  const pieceRow = el("div", "cosRow");
  pieceRow.style.flexDirection = "column";
  pieceRow.style.alignItems = "stretch";
  const drawPieces = (): void => {
    pieceRow.innerHTML = "";
    pieceRow.hidden = tool !== "piece" && tool !== "shadow";
    pieceLabel.hidden = pieceRow.hidden;
    pieceLabel.textContent = tool === "shadow" ? "Size" : "Piece";
    if (pieceRow.hidden) return;
    if (tool === "shadow") {
      // Everything stands on one of the two drawn shadows unless it is meant
      // to cast none, so the row is a size rather than a list of every piece.
      const worn = shadowNow().art;
      const sizes: { art: string; label: string }[] = [
        { art: DEFAULT_SHADOW, label: "Normal" },
        { art: BIG_SHADOW, label: "Big" },
        { art: NO_SHADOW, label: "None" },
      ];
      for (const size of sizes) {
        const b = el("button", `cosSub${size.art === worn ? " on" : ""}`, size.label);
        b.disabled = size.art !== NO_SHADOW && !art.accessories[size.art];
        b.addEventListener("click", () => {
          commitSetup({ ...setup(), shadow: { ...shadowNow(), art: size.art } });
        });
        pieceRow.appendChild(b);
      }
      return;
    }
    for (const name of pieces) {
      const b = el("button", `cosSub${name === piece ? " on" : ""}`, ownerOf(name));
      b.addEventListener("click", () => {
        piece = name;
        dragging = null;
        redraw();
      });
      pieceRow.appendChild(b);
    }
  };
  side.appendChild(pieceRow);

  // --- which line: the mini-dex ---
  const dex = el("div", "cosDex");
  const dexHead = el("div", "cosRow");
  dexHead.appendChild(el("div", "cosLabel", "Who"));
  const search = document.createElement("input");
  search.type = "search";
  search.className = "cosField";
  search.placeholder = "Search a Scoba";
  search.autocomplete = "off";
  search.style.flex = "1";
  dexHead.appendChild(search);
  const newB = el("button", "cosMini cosGo", "+");
  newB.title = "Add a new Scoba";
  dexHead.appendChild(newB);
  dex.appendChild(dexHead);

  const grid = el("div", "cosGrid cosWell");

  interface DexEntry {
    id: string;
    name: string;
    img: HTMLCanvasElement | HTMLImageElement;
    box: { x: number; y: number; w: number; h: number };
    moved: boolean;
    pick: () => void;
  }

  /** Everything the dex can show, characters first, in roster order. */
  const dexEntries = (): DexEntry[] => {
    const out: DexEntry[] = [{
      id: PLAYER_COSTUME,
      name: "Characters",
      img: worldSprite(art.doll, DEFAULT_LOOK).img,
      box: contentBox("dex:player", worldSprite(art.doll, DEFAULT_LOOK).img),
      moved: Object.keys(setupFor(PLAYER_COSTUME)).length > 0,
      pick: () => {
        speciesId = PLAYER_COSTUME;
        forms = [];
        // Nothing else is placed on a character yet, so the tool follows.
        if (tool !== "shadow" && tool !== "body") tool = "shadow";
        dragging = null;
        redraw();
      },
    }];
    for (const sp of lines()) {
      const img = critterImage(art, sp, undefined, false, {});
      out.push({
        id: sp.id,
        name: sp.name,
        img,
        box: contentBox(`dex:${sp.id}`, img),
        moved: lineMoved(sp),
        pick: () => {
          speciesId = sp.id;
          // A line's costumes are its own, so the pick starts from its first.
          forms = [];
          dragging = null;
          redraw();
        },
      });
    }
    return out;
  };

  /**
   * One scale for the whole grid, set by the largest thing in it. Every line is
   * then drawn at the same size relative to the others and stood on the same
   * line, so the dex reads as a lineup and a big line looks big.
   */
  const dexScale = (all: DexEntry[]): number => {
    const w = Math.max(1, ...all.map((e) => e.box.w));
    const h = Math.max(1, ...all.map((e) => e.box.h));
    return Math.min(DEX_CELL.w / w, DEX_CELL.h / h);
  };

  /** One cell: the drawn pixels alone, cropped out of the sheet around them. */
  const cell = (e: DexEntry, scale: number): HTMLButtonElement => {
    const b = el("button", `cosCell${e.id === speciesId ? " on" : ""}`);
    const shot = el("span", "cosShot");
    const shown = document.createElement("canvas");
    shown.width = Math.max(1, e.box.w);
    shown.height = Math.max(1, e.box.h);
    const ctx = shown.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(e.img, e.box.x, e.box.y, e.box.w, e.box.h, 0, 0, e.box.w, e.box.h);
    shown.style.width = `${Math.max(1, Math.round(e.box.w * scale))}px`;
    shown.style.height = `${Math.max(1, Math.round(e.box.h * scale))}px`;
    shot.appendChild(shown);
    b.appendChild(shot);
    const label = el("span", "cosName", e.name);
    if (e.moved) label.appendChild(el("span", "cosMoved", " *"));
    b.appendChild(label);
    b.addEventListener("click", e.pick);
    return b;
  };

  const drawLines = (): void => {
    grid.innerHTML = "";
    const all = dexEntries();
    // The scale comes off the whole roster rather than off what the search
    // left, so filtering does not resize everything that survived it.
    const scale = dexScale(all);
    const q = query.trim().toLowerCase();
    for (const e of all) {
      if (q !== "" && !e.name.toLowerCase().includes(q) && !e.id.includes(q)) continue;
      grid.appendChild(cell(e, scale));
    }
    if (grid.children.length === 0) grid.appendChild(el("div", "cosNote", "Nothing by that name."));
  };
  search.addEventListener("input", () => {
    query = search.value;
    drawLines();
  });
  dex.appendChild(grid);

  // --- a new line ---
  const newForm = buildNewScoba(art, {
    create: (sp) => {
      const wrong = data.addSpecies(sp);
      if (wrong.length > 0) return wrong;
      newForm.root.hidden = true;
      newForm.reset();
      speciesId = sp.id;
      forms = [];
      dragging = null;
      refresh();
      return [];
    },
    cancel: () => {
      newForm.root.hidden = true;
    },
    file: (file, text) => data.addRecord(file, text),
    note: (text) => host.note(text),
  });
  newForm.root.hidden = true;
  main.appendChild(newForm.root);
  newB.addEventListener("click", () => {
    newForm.root.hidden = !newForm.root.hidden;
    if (!newForm.root.hidden) newForm.root.scrollIntoView({ block: "nearest" });
  });

  // --- which costume, and the steps back ---
  const above = el("div", "cosRow cosAbove");
  const costumeRow = el("div", "cosRow");
  above.appendChild(costumeRow);
  const steps = el("div", "cosRow cosSteps");
  const undoB = el("button", "cosMini", "Undo");
  const redoB = el("button", "cosMini", "Redo");
  const resetB = el("button", "cosMini cosWarn", "Reset");
  // How close the stage is, for a drawing bigger than the sheet or a pixel
  // that needs looking at. The wheel over the stage does the same.
  const zoomOutB = el("button", "cosMini", "−");
  zoomOutB.title = "Zoom out about the feet. The wheel over the stage zooms about the pointer.";
  const zoomLabel = el("span", "cosZoom", "");
  const zoomInB = el("button", "cosMini", "+");
  zoomInB.title = "Zoom in about the feet. The wheel over the stage zooms about the pointer.";
  steps.appendChild(zoomOutB);
  steps.appendChild(zoomLabel);
  steps.appendChild(zoomInB);
  steps.appendChild(undoB);
  steps.appendChild(redoB);
  steps.appendChild(resetB);
  above.appendChild(steps);
  main.appendChild(above);

  const drawCostumes = (): void => {
    costumeRow.innerHTML = "";
    const sp = SPECIES[speciesId];
    if (!sp || onPlayer()) {
      costumeRow.hidden = true;
      return;
    }
    const all = costumesOf(sp);
    // A line drawn only one way has nothing to choose between.
    costumeRow.hidden = all.length < 2;
    if (!costumeRow.hidden) costumeRow.appendChild(el("div", "cosLabel", "Costume"));
    const here = forms.join("+");
    for (const c of all) {
      const name = artNameFor(sp, c.tags) ?? sp.id;
      const moved = Object.keys(setupFor(name)).length > 0
        || pieces.some((p) => placementFor(p, name) !== null);
      const b = el("button", `cosTab${c.tags.join("+") === here ? " on" : ""}`,
        `${costumeName(sp, c)}${moved ? " *" : ""}`);
      b.title = c.tags.length === 0
        ? `The drawing ${sp.name} walks around in.`
        : `How ${sp.name} is drawn while it is ${c.tags.join(" and ")}.`;
      b.addEventListener("click", () => {
        forms = c.tags;
        dragging = null;
        redraw();
      });
      costumeRow.appendChild(b);
    }
  };

  // --- the preview ---
  const stage = el("div", "cosStage cosWell");
  const canvas = document.createElement("canvas");
  canvas.width = DOLL_W * ZOOM;
  canvas.height = DOLL_H * ZOOM;
  canvas.className = "cosCanvas";
  stage.appendChild(canvas);
  main.appendChild(stage);

  // The stage stays one size and the zoom changes how much of the art fits in
  // it. The feet stay where they sit at the usual zoom, across the middle and
  // at the same height, so zooming never moves the ground out from under a
  // drag.
  let zoom = ZOOM;
  /**
   * How far the view has been moved off the feet, in art px. The buttons zoom
   * about the feet and put this back to nothing; the wheel zooms about the
   * pointer, which is what moves it.
   */
  let pan = { x: 0, y: 0 };
  /** The art pixel at the stage's top left. */
  const view = (): { x: number; y: number } => ({
    x: DOLL_PIVOT.x - canvas.width / (2 * zoom) + pan.x,
    y: DOLL_PIVOT.y - (DOLL_PIVOT.y * ZOOM) / zoom + pan.y,
  });
  /** Where an art pixel lands on the stage. */
  const onStage = (at: { x: number; y: number }): { x: number; y: number } => {
    const v = view();
    return { x: (at.x - v.x) * zoom, y: (at.y - v.y) * zoom };
  };
  /** The art pixel under a point on the screen. */
  const underPointer = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    const v = view();
    return {
      x: v.x + ((clientX - r.left) / r.width) * (canvas.width / zoom),
      y: v.y + ((clientY - r.top) / r.height) * (canvas.height / zoom),
    };
  };
  const showZoom = (): void => {
    zoomLabel.textContent = `${zoom}x`;
    zoomOutB.disabled = zoom === ZOOMS[0];
    zoomInB.disabled = zoom === ZOOMS[ZOOMS.length - 1];
  };
  const nextZoom = (by: 1 | -1): number => {
    const i = ZOOMS.indexOf(zoom);
    return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + by))]!;
  };
  const stepZoom = (by: 1 | -1): void => {
    zoom = nextZoom(by);
    pan = { x: 0, y: 0 };
    showZoom();
    paint();
  };
  showZoom();
  zoomOutB.addEventListener("click", () => stepZoom(-1));
  zoomInB.addEventListener("click", () => stepZoom(1));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const next = nextZoom(e.deltaY < 0 ? 1 : -1);
    if (next === zoom) return;
    // The art pixel under the pointer stays under it.
    const before = underPointer(e.clientX, e.clientY);
    zoom = next;
    const after = underPointer(e.clientX, e.clientY);
    pan = { x: pan.x + before.x - after.x, y: pan.y + before.y - after.y };
    showZoom();
    paint();
  }, { passive: false });

  // Sits with the preview rather than with the buttons, since what it changes
  // is what the preview is showing.
  const optRow = el("div", "cosRow");
  const layerB = el("button", "cosAct", "Layer: behind");
  layerB.addEventListener("click", () => {
    const at = placement();
    commit({ ...at, front: at.front !== true });
  });
  optRow.appendChild(layerB);
  const matchB = el("button", "cosAct", "Match onto the other costumes");
  matchB.addEventListener("click", () => matchAcross());
  optRow.appendChild(matchB);
  main.appendChild(optRow);

  // --- how the line carries itself ---
  const gaitRow = el("div", "cosRow");
  const drawGaits = (): void => {
    gaitRow.innerHTML = "";
    const sp = SPECIES[speciesId];
    gaitRow.hidden = !sp || onPlayer();
    if (!sp) return;
    const worn = costume();
    const set = movementFor(worn, sp.id);
    gaitRow.appendChild(el("div", "cosLabel", "Gait"));
    const own = el("button", `cosGaitB${set === null ? " on" : ""}`, `Its own (${sp.movement})`);
    own.title = `How ${sp.name} carries itself while it is drawn this way.`;
    own.addEventListener("click", () => {
      setMovement(worn, null);
      refresh();
    });
    gaitRow.appendChild(own);
    for (const g of GAITS) {
      const b = el("button", `cosGaitB${set === g ? " on" : ""}`, g);
      b.addEventListener("click", () => {
        setMovement(worn, g);
        refresh();
      });
      gaitRow.appendChild(b);
    }
  };
  main.appendChild(gaitRow);

  // --- what the walk looks like ---
  const showRow = el("div", "cosRow");
  const drawShowings = (): void => {
    showRow.innerHTML = "";
    showRow.appendChild(el("div", "cosLabel", "Moving"));
    for (const s of SHOWINGS) {
      const b = el("button", `cosGaitB cosShowB${s.id === showing ? " on" : ""}`, s.label);
      b.title = s.hint;
      b.addEventListener("click", () => {
        // Pressing the one that is already on starts it again, which is what
        // the walk-on is for: it plays once and then stands there.
        setShowing(s.id);
      });
      showRow.appendChild(b);
    }
  };
  main.appendChild(showRow);

  /**
   * Runs the preview's own frame loop while there is something to see. A still
   * drawing is painted once and left, so nothing turns over in the background
   * while the editor sits open on it.
   */
  const step = (now: number): void => {
    frame = 0;
    const dt = Math.min(0.05, last === 0 ? 1 / 60 : (now - last) / 1000);
    last = now;
    const gait = MOTIONS[gaitNow()];
    hopT += dt * gait.rate;
    if (showing === "entering" && walkOff > 0) {
      walkOff = Math.max(0, walkOff - WALK_ON_PACE * dt);
    }
    // Walking at full while it travels, and down to the battle idle once it
    // has arrived. The same easing an actor does, so both settle alike.
    const want = showing === "overworld" || (showing === "entering" && walkOff > 0)
      ? 1
      : showing === "still" ? 0 : BATTLE_IDLE;
    hopEase += (want - hopEase) * Math.min(1, dt * 9);
    paint();
    const settled = showing === "still" && hopEase < 0.01 && walkOff === 0;
    if (settled) {
      hopEase = 0;
      last = 0;
      paint();
      return;
    }
    frame = requestAnimationFrame(step);
  };

  /** Picks what the preview is doing, and starts the loop where it needs one. */
  const setShowing = (next: Showing): void => {
    showing = next;
    walkOff = next === "entering" ? WALK_ON_FROM : 0;
    if (next === "still") hopT = 0;
    if (frame === 0) {
      last = 0;
      frame = requestAnimationFrame(step);
    }
    drawShowings();
    paint();
  };

  const state = el("div", "cosNote cosState cosWell");
  main.appendChild(state);

  // --- what the game says about it ---
  const words = el("div", "cosWords");
  /** Whose words the section is showing, so its boxes are built once per pick. */
  let wordsShown: string | null = null;

  /** Every box's way of catching up with its line without being rebuilt. */
  let wordSyncs: (() => void)[] = [];

  /**
   * The boxes are built when the subject changes and brought up to date in
   * place on every other redraw. Rebuilt every time, they were torn down under
   * whoever was typing in one: a nudge, an Undo, or leaving one box for the
   * next all redraw the panel, and the box being written in went with it.
   */
  const drawWords = (): void => {
    const sp = SPECIES[speciesId];
    // Keyed by what the line has as well as which line it is, since a move
    // learned or a passive swapped in the Data section needs a box of its own.
    const subject = sp && !onPlayer() ? wordsFor(sp).map((w) => `${w.kind}:${w.id}`).join(",") : null;
    if (subject === wordsShown) {
      for (const catchUp of wordSyncs) catchUp();
      return;
    }
    wordsShown = subject;
    wordSyncs = [];
    words.innerHTML = "";
    words.hidden = subject === null;
    if (!sp || subject === null) return;
    words.appendChild(el("div", "cosLabel", "Words"));
    words.appendChild(el("div", "cosNote",
      "Each box edits a move's or a passive's text line, or the Scoba's blurb. The record"
      + " in the Data section below holds the same line, and Save writes it to that record's"
      + " file. Leave a move or a passive empty and the game describes it itself. Anything in"
      + " [brackets] becomes a highlighted word with the numbers behind a hover, and anything"
      + " the game does not recognize is left exactly as you typed it."));
    const keys = el("div", "cosKeys");
    for (const t of TOKENS) keys.appendChild(el("div", "cosKey", `${t.form} — ${t.says}`));
    words.appendChild(keys);
    for (const entry of wordsFor(sp)) {
      const box = el("div", "cosWord cosWell");
      const head = el("div", "cosWordHead");
      head.appendChild(el("div", "cosWordWho", `${entry.what} · ${entry.name}`));
      const state = el("div", "cosNote");
      head.appendChild(state);
      const back = el("button", "cosMini", "Reset");
      head.appendChild(back);
      box.appendChild(head);

      /** The sentence the game builds for a move or a passive with no text line, read fresh after a data edit. */
      const built = (): string => {
        if (entry.kind === "move") {
          const move = MOVES[entry.id];
          return move ? describeMoveEffects(move) : "";
        }
        return entry.kind === "ability" ? describeAbility(entry.id) : "";
      };
      /** The line as the record holds it, which is empty where it has none. */
      const current = (): string => data.words(entry.kind, entry.id) ?? "";

      const field = document.createElement("textarea");
      field.className = "cosField cosWordBox";
      field.rows = 3;
      field.value = current();
      /**
       * The line as this box last put it on screen. A draft typed over it and
       * not yet committed differs from the field but not from the line, which is
       * how catching up tells the two apart and leaves the draft alone.
       */
      let known = field.value;
      const shown = el("div", "cosWordNow");
      const preview = (): void => {
        shown.innerHTML = "";
        field.placeholder = built();
        const text = field.value.trim() === "" ? built() : field.value;
        shown.appendChild(proseNodes(text, { move: entry.kind === "move" ? MOVES[entry.id] ?? null : null }));
      };
      const mark = (): void => {
        const now = data.words(entry.kind, entry.id);
        const was = data.savedWords(entry.kind, entry.id);
        state.textContent = now !== was ? "changed" : now === null ? "not written" : "saved";
        back.disabled = now === was;
      };
      preview();
      mark();
      field.addEventListener("input", preview);
      // Both write through the record, and the redraw that follows brings this
      // box round to the line as it was stored.
      field.addEventListener("change", () => {
        const wrong = data.setWords(entry.kind, entry.id, field.value);
        if (wrong.length > 0) host.note(wrong.join(" "));
      });
      back.addEventListener("click", () => {
        const wrong = data.setWords(entry.kind, entry.id, data.savedWords(entry.kind, entry.id) ?? "");
        if (wrong.length > 0) host.note(wrong.join(" "));
      });
      wordSyncs.push(() => {
        mark();
        const now = current();
        if (now === known) return;
        // Changed out from under the box, by an Undo, a Redo or a data edit.
        field.value = now;
        known = now;
        preview();
      });
      box.appendChild(field);
      box.appendChild(shown);
      words.appendChild(box);
    }
  };
  main.appendChild(words);

  // --- the data the game reads about it ---
  const data = buildDataPanel({
    note: (text) => host.note(text),
    // A record just applied changes what every other part of the panel reads,
    // from the preview to the words drawn off the move's own numbers.
    changed: () => refresh(),
  });
  main.appendChild(data.root);

  body.appendChild(dex);
  root.appendChild(body);

  // --- drawing it ---

  /** A spot in sprite pixels off the feet, as canvas coordinates. */
  const atFeet = (at: Spot): { x: number; y: number } => ({
    x: DOLL_PIVOT.x + at.dx,
    y: DOLL_PIVOT.y + at.dy,
  });

  /** Where a throw leaves and lands, which are read off the art plus a nudge. */
  const marks = (): { origin: Spot; center: Spot } | null => {
    const sp = SPECIES[speciesId];
    if (!sp || onPlayer()) return null;
    const now = setup();
    // Read through the real functions, then the drag on top, so what the
    // crosshair shows is what the battle stage will use.
    const back = (a: { x: number; y: number }): Spot => ({ dx: a.x * ART, dy: -a.y * ART });
    const base = {
      origin: back(originAnchor(art, sp, forms)),
      center: back(centerAnchor(art, sp, forms)),
    };
    const stored = setupFor(costume());
    return {
      origin: plus(base.origin, minus(now.origin ?? ZERO, stored.origin ?? ZERO)),
      center: plus(base.center, minus(now.center ?? ZERO, stored.center ?? ZERO)),
    };
  };

  const crosshair = (
    ctx: CanvasRenderingContext2D, at: { x: number; y: number }, color: string, live: boolean,
  ): void => {
    const { x, y } = onStage(at);
    const arm = live ? 9 : 6;
    ctx.strokeStyle = color;
    ctx.lineWidth = live ? 2 : 1;
    ctx.globalAlpha = live ? 1 : 0.55;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  /** The gait the drawing on screen carries itself with. */
  const gaitNow = (): MovementStyle => {
    const sp = SPECIES[speciesId];
    return sp && !onPlayer() ? movementOf(sp, forms) : "hop";
  };

  /**
   * Where the body is this frame: how far it has hopped, how far it leans, how
   * far off its mark, and how far a side-to-side gait has carried it over.
   */
  const motion = (): { hop: number; angle: number; dx: number; sway: number } => {
    const b = bounce(MOTIONS[gaitNow()], hopT, hopEase);
    return { hop: b.hop, angle: b.angle, dx: -walkOff, sway: b.sway };
  };

  const paint = (): void => {
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const now = setup();
    const body = bodyImage();
    const worn = tool === "piece" ? art.accessories[piece] : undefined;
    const shadow = shadowNow();
    const shadowArt = shadow.art ? art.accessories[shadow.art] : undefined;

    const moved = motion();
    ctx.save();
    const v = view();
    ctx.setTransform(zoom, 0, 0, zoom, -v.x * zoom, -v.y * zoom);
    // The shadow first, on the ground, then the drawing over it, then the
    // piece on whichever side of it the placement says.
    // Drawn on the same canvas the bodies are, so it goes on whole and lands
    // where it was drawn. The same rule the game draws it by.
    // A walk carries the shadow along, and the hop and the lean leave it where
    // it is: that is the whole reason a shadow is drawn apart from the body.
    ctx.translate(moved.dx, 0);
    if (shadowArt) ctx.drawImage(shadowArt, shadow.dx, shadow.dy);
    // Everything from here hangs off the feet, which is what the game turns a
    // drawing about.
    ctx.translate(DOLL_PIVOT.x + moved.sway, DOLL_PIVOT.y - moved.hop);
    if (moved.angle !== 0) ctx.rotate(moved.angle);
    ctx.translate(-DOLL_PIVOT.x, -DOLL_PIVOT.y);
    // The game hangs a sheet bigger than the doll from its own pivot, so this does too.
    const own = pivotOf(sizeOf(body));
    const sheet = { dx: Math.round(DOLL_PIVOT.x - own.px), dy: Math.round(DOLL_PIVOT.y - own.py) };
    const stored = now.body ?? ZERO;
    const off = { dx: stored.dx + sheet.dx, dy: stored.dy + sheet.dy };
    let pieceAt: { x: number; y: number } | null = null;
    let pieceBox = { x: 0, y: 0, w: 0, h: 0 };
    if (worn) {
      const at = accessorySpot(art, costume(), body, piece, placement());
      pieceBox = accessoryBox(art, piece);
      pieceAt = { x: at.x + off.dx, y: at.y + off.dy };
    }
    const drawPiece = (): void => {
      if (!worn || !pieceAt) return;
      ctx.drawImage(worn, pieceBox.x, pieceBox.y, pieceBox.w, pieceBox.h,
        pieceAt.x, pieceAt.y, pieceBox.w, pieceBox.h);
    };
    if (!placement().front) drawPiece();
    ctx.drawImage(body, off.dx, off.dy);
    if (placement().front) drawPiece();
    ctx.restore();

    // The feet line, which everything here is measured from.
    ctx.strokeStyle = "#7c9df0";
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const feet = onStage({ x: 0, y: DOLL_PIVOT.y }).y;
    ctx.moveTo(0, feet + 0.5);
    ctx.lineTo(canvas.width, feet + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const where = marks();
    if (where) {
      crosshair(ctx, atFeet(where.origin), "#e8c46a", tool === "origin");
      crosshair(ctx, atFeet(where.center), "#7fd6a8", tool === "center");
    }
    if (pieceAt && tool === "piece") {
      // A box round the piece, so it is clear what the drag is moving.
      ctx.strokeStyle = "#e58ab8";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      const box = onStage(pieceAt);
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, pieceBox.w * zoom, pieceBox.h * zoom);
      ctx.setLineDash([]);
    }
  };

  const drawState = (): void => {
    const sp = SPECIES[speciesId];
    const now = setup();
    const sign = (n: number): string => `${n >= 0 ? "+" : ""}${n}`;
    const say = (at: Spot | undefined): string =>
      at ? `${sign(at.dx)}, ${sign(at.dy)}` : "on its own art";
    const worn = forms.length > 0 ? ` (${forms.join(" + ")})` : "";
    const name = onPlayer() ? "Characters" : `${sp?.name ?? speciesId}${worn}`;
    const line = tool === "piece"
      ? `piece ${say(placementFor(piece, costume()) ?? undefined)}, `
        + `${placement().front ? "in front of" : "behind"} it`
      : tool === "shadow"
        ? `shadow ${shadowNow().art || "none"} ${say(shadowNow())}`
        : `${TOOLS.find((t) => t.id === tool)!.label.toLowerCase()} ${say(now[tool])}`;
    state.textContent = `${name}: ${line}. ${placedCount()} set in all.`;
    layerB.hidden = tool !== "piece";
    layerB.textContent = placement().front ? "Layer: in front" : "Layer: behind";
    layerB.classList.toggle("on", placement().front === true);
    // Offered only where there is another costume of the same kind to reach.
    matchB.hidden = onPlayer() || kin().length < 2;
    matchB.textContent = `Match onto the other ${kindName()} costumes`;
    undoB.disabled = !canUndo();
    redoB.disabled = !canRedo();
    resetB.disabled = allCostumes().every((c) => Object.keys(setupFor(c)).length === 0
      && pieces.every((p) => placementFor(p, c) === null))
      && (onPlayer() || movementFor(speciesId, speciesId) === null);
    resetB.title = `Put ${subjectName()} back on its own art, every costume of it.`;
    hint.textContent = TOOLS.find((t) => t.id === tool)!.hint
      + " Arrow keys move it a pixel at a time.";
  };

  /** Whose data the data section is showing, so it is rebuilt only on a new pick. */
  let dataFor: string | null = null;

  const redraw = (): void => {
    // Undo can take away the line on screen, when it was made this session.
    if (!onPlayer() && !SPECIES[speciesId]) {
      speciesId = lines()[0]?.id ?? "";
      forms = [];
      dragging = null;
    }
    // Rebuilt only when the subject changes. Every other redraw would otherwise
    // throw away a record half typed into one of its boxes.
    const subject = onPlayer() ? null : speciesId;
    if (subject !== dataFor) {
      dataFor = subject;
      data.show(subject ? SPECIES[subject] ?? null : null);
    }
    drawWords();
    drawTools();
    drawPieces();
    drawLines();
    drawCostumes();
    drawGaits();
    drawShowings();
    paint();
    drawState();
  };

  const refresh = (): void => {
    // Anything already built wore the old placement.
    forgetBuiltArt();
    // An Undo or Redo may have put a record back under a box that still shows
    // the version it replaced.
    data.sync();
    redraw();
  };

  // --- dragging ---
  const toSprite = (e: PointerEvent): { x: number; y: number } => underPointer(e.clientX, e.clientY);
  canvas.addEventListener("pointerdown", (e) => {
    const at = toSprite(e);
    dragging = { fromX: at.x, fromY: at.y, dx: 0, dy: 0 };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const at = toSprite(e);
    dragging.dx = Math.round(at.x - dragging.fromX);
    dragging.dy = Math.round(at.y - dragging.fromY);
    paint();
    drawState();
  });
  const drop = (): void => {
    if (!dragging) return;
    const at = tool === "piece" ? placement() : null;
    const now = tool === "piece" ? null : setup();
    dragging = null;
    if (at) commit(at);
    else if (now) commitSetup(now);
  };
  canvas.addEventListener("pointerup", drop);
  canvas.addEventListener("pointercancel", drop);

  const commit = (at: Placement): void => {
    setPlacement(piece, costume(), at);
    refresh();
  };

  const commitSetup = (now: CostumeSetup): void => {
    setSetup(costume(), now);
    refresh();
  };

  /** Every costume of whatever is on screen, which is what a reset covers. */
  const allCostumes = (): string[] => {
    if (onPlayer()) return [PLAYER_COSTUME];
    const sp = SPECIES[speciesId];
    if (!sp) return [];
    return costumesOf(sp).map((c) => artNameFor(sp, c.tags) ?? sp.id);
  };

  /** What a reset would be undoing, for saying so before it happens. */
  const subjectName = (): string => (onPlayer() ? "Characters" : SPECIES[speciesId]?.name ?? speciesId);

  undoB.addEventListener("click", () => {
    if (!undoCosmetics()) return host.note("Nothing to undo.");
    refresh();
    host.note("Stepped back.");
  });
  redoB.addEventListener("click", () => {
    if (!redoCosmetics()) return host.note("Nothing to redo.");
    refresh();
    host.note("Stepped forward.");
  });
  resetB.addEventListener("click", () => {
    clearLine(allCostumes(), speciesId);
    refresh();
    host.note(`${subjectName()} is back on its own art.`);
  });

  /** Moves one spot by a step, whichever tool is live. */
  const nudge = (by: Spot): void => {
    if (tool === "piece") {
      const at = placement();
      commit({ ...at, ...plus(at, by) });
      return;
    }
    const now = setup();
    if (tool === "body") return commitSetup({ ...now, body: plus(now.body ?? ZERO, by) });
    if (tool === "origin") return commitSetup({ ...now, origin: plus(now.origin ?? ZERO, by) });
    if (tool === "center") return commitSetup({ ...now, center: plus(now.center ?? ZERO, by) });
    const shadow = shadowNow();
    commitSetup({ ...now, shadow: { ...shadow, ...plus(shadow, by) } });
  };

  /**
   * Puts what this costume is set to onto the line's other costumes of the same
   * kind. Taking a cherry off a Scoba leaves the same body, so a correction made
   * on one of those is the correction the others want. Hyper-Mode is the line
   * drawn again from scratch, so nothing carries between the two.
   */
  const matchAcross = (): void => {
    const sp = SPECIES[speciesId];
    if (!sp || onPlayer()) return;
    const from = costume();
    const now = setupFor(from);
    // Every piece, including the ones this costume leaves on its own art: a
    // match makes the others the same as this one, so a piece nobody has moved
    // here goes back to its own art there rather than keeping an old nudge.
    const worn = pieces.map((p) => ({ piece: p, at: placementFor(p, from) }));
    const mid = contentMiddle(art, sp, forms);
    let moved = 0;
    // However many costumes it reaches, a match is one thing to step back off.
    asOneStep(() => {
    for (const c of kin()) {
      const name = artNameFor(sp, c.tags) ?? sp.id;
      if (name === from) continue;
      // What is stored is a nudge off wherever each drawing puts the thing, and
      // two drawings put it in different places. Copying the nudge would move
      // the piece, so what is carried over is where it ends up, worked back
      // into the nudge this costume needs to put it in the same place.
      const theirs = contentMiddle(art, sp, c.tags);
      const same = (s: Spot): Spot => ({
        dx: Math.round(mid.dx + s.dx - theirs.dx),
        dy: Math.round(mid.dy + s.dy - theirs.dy),
      });
      const copy: CostumeSetup = { ...now };
      if (now.origin) copy.origin = same(now.origin);
      if (now.center) copy.center = same(now.center);
      setSetup(name, copy);
      for (const w of worn) {
        if (!w.at) {
          clearPlacement(w.piece, name);
          continue;
        }
        const here = autoPieceSpot(art, sp, w.piece, forms);
        const there = autoPieceSpot(art, sp, w.piece, c.tags);
        setPlacement(w.piece, name, {
          dx: Math.round(here.dx + w.at.dx - there.dx),
          dy: Math.round(here.dy + w.at.dy - there.dy),
          ...(w.at.front ? { front: true } : {}),
        });
      }
      moved += 1;
    }
    });
    refresh();
    host.note(moved === 0
      ? `${sp.name} has no other ${kindName()} costume.`
      : `${from} copied onto ${moved} other ${kindName()} costume${moved === 1 ? "" : "s"}.`);
  };

  // --- the buttons ---
  const row = el("div", "cosRow");
  const add = (label: string, run: () => void, cls = "cosAct"): HTMLButtonElement => {
    const b = el("button", cls, label);
    b.addEventListener("click", run);
    row.appendChild(b);
    return b;
  };
  if (host.save) {
    const saver = host.save;
    const b = add(saver.label, () => {
      b.disabled = true;
      // The placements and the data are two sets of files, and one press saves
      // both, so nothing edited on the page is left behind by forgetting which
      // button wrote which.
      void Promise.all([saver.run(cosmeticsJson()), data.save()])
        .then(([placed, stored]) => host.note(`${placed} ${stored}`))
        .catch((err: unknown) => host.note(`Could not save: ${String(err)}`))
        .finally(() => {
          b.disabled = false;
        });
    }, "cosGo");
  }
  if (host.onDone) add("Done", host.onDone);
  root.appendChild(row);

  // Arrow keys for the last pixel, since a drag cannot be trusted with one.
  const keys = (e: KeyboardEvent): void => {
    // A key pressed in anything you type into belongs to that field: arrows and
    // Shift+arrows move the caret and the selection, and Ctrl+Z undoes typing.
    // Taken by the editor instead, they nudged a piece and redrew the panel out
    // from under whatever was being written.
    if (isTyping(e.target)) return;
    if (e.ctrlKey || e.metaKey) {
      const lower = e.key.toLowerCase();
      // Both spellings of redo, because the editor runs on either platform.
      const back = lower === "z" && !e.shiftKey;
      const on = lower === "y" || (lower === "z" && e.shiftKey);
      if (!back && !on) return;
      e.preventDefault();
      if (back ? undoCosmetics() : redoCosmetics()) {
        refresh();
        host.note(back ? "Stepped back." : "Stepped forward.");
      } else {
        host.note(back ? "Nothing to undo." : "Nothing to redo.");
      }
      return;
    }
    const step: Record<string, Spot> = {
      ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 },
      ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 },
    };
    const move = step[e.key];
    if (!move) return;
    e.preventDefault();
    nudge(move);
  };
  window.addEventListener("keydown", keys);

  redraw();

  return {
    root,
    dispose: () => {
      window.removeEventListener("keydown", keys);
      if (frame !== 0) cancelAnimationFrame(frame);
    },
    unsavedData: () => data.dirty(),
  };
}

const ZERO: Spot = { dx: 0, dy: 0 };
const minus = (a: Spot, b: Spot): Spot => ({ dx: a.dx - b.dx, dy: a.dy - b.dy });
