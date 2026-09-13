// Where a cosmetic sits on a Scoba, and everything else about a drawing that
// the pixels cannot say.
//
// An accessory is placed automatically: the art layer finds the top of a head
// and nestles the piece against it. That is right for most lines and wrong for
// a few, because a head that slopes, or one drawn with a hat already on it,
// needs the piece moved by hand. The same goes for the spot a throw leaves
// from, the spot one lands on, and the shadow a body stands on: each has an
// answer read off the art, and each is wrong somewhere.
//
// So everything here is a nudge off the automatic answer rather than a position
// of its own. A costume with no nudge tracks its own art: redraw the Scoba and
// its shadow, its center and the piece on its head all follow. A costume with
// one keeps the correction whatever else moves.
//
// The committed file is the only copy. Both editors, the standalone one and
// the one behind F3, read it over the dev server's `/api/cosmetics` and write
// it straight back, so there is never a browser copy quietly shadowing what is
// in the repo. A built game reads the file as it was committed and has no
// editor at all.
import type { MovementStyle } from "../sim/species";
import BAKED from "./content/cosmetics.json";

/** Where a piece sits on one costume, and which side of it. */
export interface Placement {
  /** How far off the automatic spot, in sprite pixels. */
  dx: number;
  dy: number;
  /**
   * Drawn over the Scoba rather than behind it. Behind is the default, so a
   * piece reads as sitting against the back of a head rather than stuck to its
   * face, and a line that needs the other way round says so.
   */
  front?: boolean;
}

/**
 * A spot on a drawing, in sprite pixels off the feet it stands on. Down the
 * screen is positive, the way every other offset here is measured.
 */
export interface Spot {
  dx: number;
  dy: number;
}

/** The shadow a body stands on: which drawing, and where it sits under it. */
export interface ShadowSetup extends Spot {
  /** A file in `assets/AccessoryScoba`. Empty for a body that casts none. */
  art: string;
}

/**
 * The drawing every body stands on until its costume says otherwise, and the
 * larger one for a line that needs more ground under it. Both are drawn on the
 * same canvas the bodies are, so each sits where it was drawn.
 */
export const DEFAULT_SHADOW = "shadow";
export const BIG_SHADOW = "shadowbig";

/** No shadow at all, which a costume has to ask for. */
export const NO_SHADOW = "";

/** What a costume is beyond its pixels. Every field is a nudge, so every one is optional. */
export interface CostumeSetup {
  /** The whole drawing, moved off the feet line it hangs from. */
  body?: Spot;
  /** Where a throw leaves from, off the middle of the drawn pixels. */
  origin?: Spot;
  /** Where a throw lands, off the middle of the drawn pixels. */
  center?: Spot;
  shadow?: ShadowSetup;
}

/** What a line is beyond its drawings, which is nothing a single costume owns. */
export interface LineSetup {
  /** Overrides how the line carries itself, for trying a gait without a rebuild. */
  movement?: MovementStyle;
}

/**
 * The whole document.
 *
 * `pieces` is by accessory and then by costume, and the other two are by
 * costume and by line. A costume rather than a line, because what any of this
 * describes is a drawing: a Scoba in Hyper-Mode is drawn again from scratch and
 * its head, its middle and its feet are all somewhere else, so a nudge tuned to
 * the one it walks around in would be wrong there. The key is the art name,
 * which is what `artNameFor` answers, so a line with no costumes has exactly
 * one entry and reads the way it always did.
 */
export interface CosmeticDoc {
  pieces: Record<string, Record<string, Placement>>;
  costumes: Record<string, CostumeSetup>;
  lines: Record<string, LineSetup>;
  /**
   * Words written over the ones the game works out for itself, keyed by what
   * they are about: `species:allin`, `ability:invested`, `move:card-throw`.
   * Plain prose with nothing read back out of it, so an entry here replaces
   * the whole of what would have been shown and can say anything.
   */
  texts: Record<string, string>;
}

/** What a written line can be about. */
export type TextKind = "species" | "ability" | "move";

/** The key one is stored under. */
export const textKey = (kind: TextKind, id: string): string => `${kind}:${id}`;

/** The costume key the player characters are placed under, who have no species. */
export const PLAYER_COSTUME = "player";

/** Nothing moved: every drawing takes the answers its own art gives. */
export function emptyCosmetics(): CosmeticDoc {
  return { pieces: {}, costumes: {}, lines: {}, texts: {} };
}

/**
 * Reads a document, taking a file written before there was anything in it but
 * placements as the placements it is.
 */
export function readCosmetics(parsed: unknown): CosmeticDoc {
  if (!parsed || typeof parsed !== "object") return emptyCosmetics();
  const doc = parsed as Partial<CosmeticDoc> & Record<string, unknown>;
  if (doc.pieces || doc.costumes || doc.lines || doc.texts) {
    return {
      pieces: doc.pieces ?? {},
      costumes: doc.costumes ?? {},
      lines: doc.lines ?? {},
      texts: doc.texts ?? {},
    };
  }
  return { pieces: parsed as CosmeticDoc["pieces"], costumes: {}, lines: {}, texts: {} };
}

function parse(raw: string | null): CosmeticDoc | null {
  if (!raw) return null;
  try {
    return readCosmetics(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

let working: CosmeticDoc | null = null;

/**
 * Where a change goes. The game keeps its working copy in localStorage; the
 * standalone editor holds the document in memory and writes the file itself.
 * Kept behind this so both drive the same document and the same rules.
 */
let persist: (doc: CosmeticDoc) => void = () => undefined;

/**
 * Hands the module the document an editor is working on, and somewhere to put
 * changes. Everything downstream reads the same document either way, so a
 * nudge means the same thing in the game and in the editor.
 */
export function installCosmetics(
  doc: CosmeticDoc,
  onChange: (doc: CosmeticDoc) => void,
): void {
  working = doc;
  persist = onChange;
  past.length = 0;
  future.length = 0;
  lastTag = "";
}

// --- stepping back ---
//
// A step is a copy of something as it stood rather than a record of what
// changed. For the placements that something is the whole document, which is a
// few hundred numbers, so copying it costs nothing, and a copy cannot fall out
// of step with itself the way a list of reversible edits can once two of them
// touch the same costume.
//
// The editor's game data shares the one history, so a single Undo takes back
// whatever was done last, placement or record. A data step copies only the one
// record it touched. That is safe for the same reason: an edit to a record
// replaces the whole of it, so there is nothing partial for the copy to miss.

/**
 * Something a step can put back: a way to read what it is now and a way to
 * write back what it was. Both deal in strings, so a step is only ever a copy.
 */
export interface Undoable {
  read(): string;
  write(state: string): void;
}

interface Entry {
  target: Undoable;
  state: string;
}

/** The placements, as a thing a step can copy and put back. */
const docTarget: Undoable = {
  read: () => JSON.stringify(cosmetics()),
  write: (state) => {
    working = parseCosmetics(state);
    persist(working);
  },
};

const past: Entry[] = [];
const future: Entry[] = [];

/** How far back the editor can go. */
const HISTORY_DEPTH = 80;

/** Changes to one thing this close together are one step rather than many. */
const RUN_MS = 1500;

let lastTag = "";
let lastAt = 0;
let grouping = 0;

/**
 * Puts the document as it stands on the stack, before something changes it.
 * A run of changes to the same thing collapses into one step, so tuning a piece
 * with the arrow keys undoes as the single move it reads as.
 */
function remember(tag: string): void {
  rememberStep(tag, docTarget);
}

/**
 * Puts something as it stands on the stack, before it changes. The editor's
 * game data comes in through here with a target of its own; the placements come
 * in through `remember`. A run of changes to the same thing collapses into one
 * step, whichever of the two it is.
 */
export function rememberStep(tag: string, target: Undoable): void {
  if (grouping > 0) return;
  const now = Date.now();
  const sameRun = tag === lastTag && now - lastAt < RUN_MS && past.length > 0;
  lastTag = tag;
  lastAt = now;
  if (sameRun) return;
  past.push({ target, state: target.read() });
  if (past.length > HISTORY_DEPTH) past.shift();
  future.length = 0;
}

/**
 * Runs several changes as one step. An action that touches every costume of a
 * line is one thing the editor did and has to come back off in one go.
 */
export function asOneStep<T>(run: () => T): T {
  const outermost = grouping === 0;
  if (outermost) {
    remember("group");
    // Whatever the group did, the next change after it starts a step of its own.
    lastTag = "";
  }
  grouping += 1;
  try {
    return run();
  } finally {
    grouping -= 1;
  }
}

export const canUndo = (): boolean => past.length > 0;
export const canRedo = (): boolean => future.length > 0;

/** Steps back one change. False where there is nothing to step back to. */
export function undoCosmetics(): boolean {
  const back = past.pop();
  if (back === undefined) return false;
  // What it is now goes the other way first, so redo has it to put back.
  future.push({ target: back.target, state: back.target.read() });
  back.target.write(back.state);
  // The next change is its own step rather than a continuation of the one
  // that was just taken off.
  lastTag = "";
  return true;
}

/** Steps forward again, as far as the last change undone. */
export function redoCosmetics(): boolean {
  const ahead = future.pop();
  if (ahead === undefined) return false;
  past.push({ target: ahead.target, state: ahead.target.read() });
  ahead.target.write(ahead.state);
  lastTag = "";
  return true;
}

/**
 * The document in force: the one an editor is working on where there is one,
 * and the committed file otherwise. Read every time something is placed, so a
 * nudge moves what is already on screen.
 */
export function cosmetics(): CosmeticDoc {
  if (!working) working = readCosmetics(BAKED);
  return working;
}

/** Reads a document off a string, falling back to nothing moved. */
export function parseCosmetics(raw: string): CosmeticDoc {
  return parse(raw) ?? emptyCosmetics();
}

/** How this costume wears this piece, or nothing where it takes the default. */
export function placementFor(accessory: string, costume: string): Placement | null {
  return cosmetics().pieces[accessory]?.[costume] ?? null;
}

/** Places one piece on one costume. A default placement is stored as nothing. */
export function setPlacement(accessory: string, costume: string, at: Placement): void {
  const doc = cosmetics();
  if (at.dx === 0 && at.dy === 0 && !at.front) return clearPlacement(accessory, costume);
  remember(`piece:${accessory}:${costume}`);
  const kept: Placement = { dx: Math.round(at.dx), dy: Math.round(at.dy) };
  if (at.front) kept.front = true;
  doc.pieces[accessory] = { ...doc.pieces[accessory], [costume]: kept };
  save();
}

/** Puts one costume back on the placement its art asks for. */
export function clearPlacement(accessory: string, costume: string): void {
  const doc = cosmetics();
  const forPiece = doc.pieces[accessory];
  if (!forPiece || !(costume in forPiece)) return;
  remember(`piece:${accessory}:${costume}`);
  const rest = { ...forPiece };
  delete rest[costume];
  if (Object.keys(rest).length === 0) delete doc.pieces[accessory];
  else doc.pieces[accessory] = rest;
  save();
}

/** What has been set on one costume, or nothing where it takes every default. */
export function setupFor(costume: string): CostumeSetup {
  return cosmetics().costumes[costume] ?? {};
}

/**
 * The shadow this costume actually stands on. Every body stands on the default
 * one, so what the document holds is a costume that wants the larger drawing, a
 * costume that wants it moved, or a costume that casts none at all.
 */
export function shadowFor(costume: string): ShadowSetup {
  return cosmetics().costumes[costume]?.shadow ?? { art: DEFAULT_SHADOW, dx: 0, dy: 0 };
}

/** A spot is stored only while it is off the automatic one. */
const moved = (at: Spot | undefined): boolean => at !== undefined && (at.dx !== 0 || at.dy !== 0);

/**
 * Changes one costume. A field set back to its automatic answer is dropped, and
 * a costume with nothing left on it goes with it, so the file only ever holds
 * what somebody actually decided.
 */
export function setSetup(costume: string, setup: CostumeSetup): void {
  const doc = cosmetics();
  remember(`setup:${costume}`);
  const kept: CostumeSetup = {};
  if (moved(setup.body)) kept.body = round(setup.body!);
  if (moved(setup.origin)) kept.origin = round(setup.origin!);
  if (moved(setup.center)) kept.center = round(setup.center!);
  // A shadow is stored whenever it is anything but the default drawing sitting
  // where it was drawn, casting none included, since that is a decision too.
  const shadow = setup.shadow;
  if (shadow && (shadow.art !== DEFAULT_SHADOW || moved(shadow))) {
    kept.shadow = { art: shadow.art, ...round(shadow) };
  }
  if (Object.keys(kept).length === 0) delete doc.costumes[costume];
  else doc.costumes[costume] = kept;
  save();
}

const round = (at: Spot): Spot => ({ dx: Math.round(at.dx), dy: Math.round(at.dy) });

/** Puts one costume back on every answer its art gives. */
export function clearSetup(costume: string): void {
  const doc = cosmetics();
  if (!(costume in doc.costumes)) return;
  remember(`setup:${costume}`);
  delete doc.costumes[costume];
  save();
}

/** What has been set on one line, or nothing where it takes every default. */
export function lineSetupFor(speciesId: string): LineSetup {
  return cosmetics().lines[speciesId] ?? {};
}

/** How this line carries itself, or nothing where its species decides. */
export function movementFor(speciesId: string): MovementStyle | null {
  return cosmetics().lines[speciesId]?.movement ?? null;
}

/** Overrides a line's gait. Passing nothing puts it back on its species'. */
export function setMovement(speciesId: string, movement: MovementStyle | null): void {
  const doc = cosmetics();
  remember(`gait:${speciesId}`);
  if (movement === null) delete doc.lines[speciesId];
  else doc.lines[speciesId] = { ...doc.lines[speciesId], movement };
  save();
}

/**
 * Puts one line back on its own art: every costume it is drawn in, every piece
 * on any of them, and its gait. One step, because it is one thing to undo.
 */
export function clearLine(costumes: readonly string[], lineId: string): void {
  asOneStep(() => {
    const doc = cosmetics();
    for (const costume of costumes) {
      delete doc.costumes[costume];
      for (const piece of Object.keys(doc.pieces)) {
        const worn = doc.pieces[piece];
        if (!worn || !(costume in worn)) continue;
        delete worn[costume];
        if (Object.keys(worn).length === 0) delete doc.pieces[piece];
      }
    }
    delete doc.lines[lineId];
    save();
  });
}

/** What has been written over this one, or nothing where the game says it. */
export function writtenText(kind: TextKind, id: string): string | null {
  return cosmetics().texts[textKey(kind, id)] ?? null;
}

/** Writes over what the game would say. An empty line puts its own words back. */
export function setText(kind: TextKind, id: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed === "") return clearText(kind, id);
  remember(`text:${kind}:${id}`);
  cosmetics().texts[textKey(kind, id)] = trimmed;
  save();
}

/** Hands one back to the game to say for itself. */
export function clearText(kind: TextKind, id: string): void {
  const doc = cosmetics();
  const key = textKey(kind, id);
  if (!(key in doc.texts)) return;
  remember(`text:${kind}:${id}`);
  delete doc.texts[key];
  save();
}

/** Drops every nudge. Nothing is written until the editor saves. */
export function resetCosmetics(): void {
  remember("reset");
  working = emptyCosmetics();
  persist(working);
}

function save(): void {
  persist(working ?? emptyCosmetics());
}

/** The document as it would be committed. */
export function cosmeticsJson(): string {
  return JSON.stringify(cosmetics(), null, 2);
}

/** How many costumes have been moved off what their art asks for. */
export function placedCount(): number {
  const doc = cosmetics();
  const pieces = Object.values(doc.pieces).reduce((n, byLine) => n + Object.keys(byLine).length, 0);
  return pieces + Object.keys(doc.costumes).length + Object.keys(doc.lines).length;
}
