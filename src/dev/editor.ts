// The dev-mode world editor. F2 opens it over a running game: the sim pauses,
// the camera goes free, and a side panel offers the tools. Terrain and
// collision paint straight into the live map (the painter reads the same
// arrays), tiles come off a palette of the packed tileset and carry a 3x3
// collision mask each, props, zones and NPCs rebuild through the overworld's
// dev hooks, and everything writes into the one WorldContent document that
// localStorage carries between reloads and Export downloads for committing.
import { ART, type Renderer } from "../engine/renderer";
import { maskHas, maskWith, SUB, SUB_FULL, TILE } from "../engine/tilemap";
import { HAIR_URLS, EYE_URLS, SHIRT_URLS } from "../engine/paperdoll";
import {
  DEFAULT_LOOK, DETAIL_COLORS, HAIR_COLORS, SHIRT_COLORS, SKIN_COLORS, type Look,
} from "../engine/recolor";
import { COLS, ROWS, PROP_KINDS, type PropKind } from "../game/islands";
import {
  blankMap, cellDataAt, cellKey, collisionAt, contentOwned, saveDevContent, clearDevContent,
  freshPadId, mapById, padById, pads, resizeMap, setCellDataAt, setCollisionAt, setSubAt,
  setTerrainAt, setTileAt, snapshotWorld, stackAt, subAt, terrainAt, tileAt, tileLayer,
  tileMask, tileSheet,
  type CellData, type MapDef, type NpcDef, type QuestDef, type QuestStep, type TeleportData,
  type WorldContent,
} from "../game/content";
import {
  familyOf, LAYER_BLURB, LAYER_LABEL, LAYERS, specialOf, tileDescs, TILE_SRC,
  type LayerId, type TileDesc, type TileFamily,
} from "../game/islandart";
import {
  ZONE_DEFAULTS, zoneSpecies, type EncounterZone, type ZoneSpecies,
} from "../game/world";
import { drawReachMarker } from "../game/npcs";
import type { Overworld } from "../game/overworld";
import { SPECIES, rosterSpecies } from "../sim/species";
import type { SaveData } from "../save/save";
import type { UI } from "../ui/screens";

interface Cell {
  cx: number; cy: number;
  /** Subcell inside the tile, 0..2 on each axis. */
  sx: number; sy: number;
  /** The world point itself. */
  x: number; y: number;
}

type Tab = "terrain" | "tiles" | "collision" | "props" | "npcs" | "zones" | "quests" | "maps" | "world";

/** How a tile brush lays itself down. */
type TileTool = "paint" | "fill" | "rect";

/** Collide brushes: three that set a whole tile, two that work a subcell. */
type CollisionBrush = "s" | "o" | "." | "sub+" | "sub-";

/** Something waiting for the next map click. */
type Armed =
  | { kind: "add-npc" }
  | { kind: "move-npc"; npcId: string }
  | { kind: "add-zone" }
  | { kind: "set-spawn" }
  | { kind: "pick-reach"; questId: string; stepIndex: number };

const TABS: { id: Tab; label: string }[] = [
  { id: "terrain", label: "Terrain" },
  { id: "tiles", label: "Tiles" },
  { id: "collision", label: "Collide" },
  { id: "props", label: "Props" },
  { id: "npcs", label: "NPCs" },
  { id: "zones", label: "Zones" },
  { id: "quests", label: "Quests" },
  { id: "maps", label: "Maps" },
  { id: "world", label: "World" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

function splitLines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

function speciesIds(): string[] {
  return rosterSpecies().map((sp) => sp.id).sort();
}

function randomLook(): Look {
  const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)]!;
  return {
    skin: pick(SKIN_COLORS),
    hair: pick(HAIR_COLORS),
    shirt: pick(SHIRT_COLORS),
    shirtDetail: pick(DETAIL_COLORS),
    hairStyle: Math.floor(Math.random() * (HAIR_URLS.length + 1)) - 1,
    eyeStyle: Math.floor(Math.random() * EYE_URLS.length),
    shirtStyle: Math.floor(Math.random() * (SHIRT_URLS.length + 1)) - 1,
  };
}

export class DevEditor {
  active = false;
  private scene: Overworld | null = null;
  private save: SaveData | null = null;
  private cam = { x: 0, y: 0 };
  private tab: Tab = "terrain";
  private terrainBrush: "l" | "w" | "b" = "l";
  private collisionBrush: CollisionBrush = "sub+";
  /** A tileset key, or erase to drop back to the auto-tiled ground. */
  private tileBrush: string | "erase" | null = null;
  private tileTool: TileTool = "paint";
  /** The layer every tile tool writes to. */
  private layer: LayerId = "ground";
  /** Layers currently drawn. Hiding the rest is how one gets isolated. */
  private shown: Record<LayerId, boolean> = { ground: true, overlay: true, sort: true, above: true };
  /** Rectangle being dragged out on the Tiles tab. */
  private rectDrag: { cx0: number; cy0: number; cx1: number; cy1: number } | null = null;
  /** Cell whose teleport or sentinel settings the panel is editing. */
  private specialCell: { cx: number; cy: number } | null = null;
  /** Settings stamped onto the next teleport or sentinel painted. */
  private teleportDefault: CellData = { kind: "teleport", id: "", link: "", map: "", x: 0, y: 0 };
  private sentinelDefault: CellData = {
    kind: "sentinel", cond: "wild", count: 2, radius: 96, npcId: "", label: "Something bars the way.",
  };
  /** Last cell the Collide tab touched, whose mask the panel edits. */
  private subCell: { cx: number; cy: number } | null = null;
  private propBrush: PropKind | "erase" = "bush";
  private armed: Armed | null = null;
  private selNpc: string | null = null;
  private selZone = -1;
  private selQuest: string | null = null;
  private panel: HTMLElement;
  private body: HTMLElement;
  private status: HTMLElement;
  private keys = new Set<string>();
  private hover: { cx: number; cy: number; sx: number; sy: number; x: number; y: number } | null = null;
  private painting = false;
  private panning: { px: number; py: number } | null = null;
  private zoneDrag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private npcDrag: string | null = null;
  private undoStack: string[] = [];
  private saveTimer: number | null = null;
  private unlisten: (() => void)[] = [];

  constructor(
    private ui: UI,
    private renderer: Renderer,
    private content: WorldContent,
  ) {
    this.panel = el("div");
    this.panel.id = "devPanel";
    const head = el("div", "devHead");
    head.appendChild(el("strong", undefined, "Dev Mode"));
    const close = el("button", "pill", "close");
    close.addEventListener("click", () => this.close());
    head.appendChild(close);
    this.panel.appendChild(head);

    const tabs = el("div", "devTabs");
    for (const t of TABS) {
      const b = el("button", "pill", t.label);
      b.dataset["tab"] = t.id;
      b.addEventListener("click", () => {
        this.tab = t.id;
        this.armed = null;
        this.renderPanel();
      });
      tabs.appendChild(b);
    }
    this.panel.appendChild(tabs);

    this.status = el("div", "devStatus");
    this.panel.appendChild(this.status);
    this.body = el("div", "devBody");
    this.panel.appendChild(this.body);
  }

  open(scene: Overworld, save: SaveData): void {
    if (this.active) return;
    this.active = true;
    this.scene = scene;
    this.save = save;
    if (!contentOwned(this.content)) {
      snapshotWorld(this.content, scene.devWorld());
      scene.devReload();
      this.ui.toast("Snapshotted the generated world; it is editable content now.");
    }
    const p = scene.playerPos();
    this.cam = { x: p.x, y: p.y };
    scene.devCam = this.cam;
    scene.overlay = (ctx, camX, camY, w, h) => this.drawOverlay(ctx, camX, camY, w, h);
    document.getElementById("ui")!.appendChild(this.panel);
    this.renderPanel();

    const down = (e: PointerEvent): void => this.pointerDown(e);
    const move = (e: PointerEvent): void => this.pointerMove(e);
    const up = (e: PointerEvent): void => this.pointerUp(e);
    const key = (e: KeyboardEvent): void => this.keyDown(e);
    const keyUp = (e: KeyboardEvent): void => {
      this.keys.delete(e.key.toLowerCase());
    };
    const menu = (e: Event): void => e.preventDefault();
    window.addEventListener("pointerdown", down, { capture: true });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, { capture: true });
    window.addEventListener("keyup", keyUp);
    window.addEventListener("contextmenu", menu);
    this.unlisten = [
      () => window.removeEventListener("pointerdown", down, { capture: true }),
      () => window.removeEventListener("pointermove", move),
      () => window.removeEventListener("pointerup", up),
      () => window.removeEventListener("keydown", key, { capture: true }),
      () => window.removeEventListener("keyup", keyUp),
      () => window.removeEventListener("contextmenu", menu),
    ];
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.flushSave();
    for (const off of this.unlisten) off();
    this.unlisten = [];
    this.keys.clear();
    this.armed = null;
    this.painting = false;
    this.panning = null;
    this.zoneDrag = null;
    this.npcDrag = null;
    if (this.scene) {
      this.scene.devCam = null;
      this.scene.overlay = null;
      this.scene.devShowLayers(() => true);
    }
    this.panel.remove();
  }

  update(dt: number): void {
    const scene = this.scene;
    if (!scene) return;
    scene.devTick(dt);
    const speed = (this.keys.has("shift") ? 520 : 220) * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) dx += 1;
    if (this.keys.has("w") || this.keys.has("arrowup")) dy -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) dy += 1;
    this.cam.x += dx * speed;
    this.cam.y += dy * speed;
  }

  // --- content mutation plumbing ---

  private pushUndo(): void {
    this.undoStack.push(JSON.stringify(this.content));
    if (this.undoStack.length > 60) this.undoStack.shift();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) {
      this.ui.toast("Nothing to undo.");
      return;
    }
    Object.assign(this.content, JSON.parse(prev) as WorldContent);
    this.scene?.devReload();
    this.dirty();
    this.renderPanel();
  }

  /** Persist to localStorage, debounced so paint strokes don't spam it. */
  private dirty(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      saveDevContent(this.content);
    }, 400);
  }

  private flushSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    saveDevContent(this.content);
  }

  // --- pointer / keyboard ---

  private toWorld(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const view = this.scene!.viewRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const k = dpr / (this.renderer.scale * ART);
    return { x: view.x + e.clientX * k, y: view.y + e.clientY * k };
  }

  /** The map the scene has loaded, which is the one every tool writes to. */
  private map(): MapDef | null {
    return this.scene ? mapById(this.content, this.scene.devMapId()) : null;
  }

  /** The cell and the subcell inside it that a world point lands on. */
  private cellAt(w: { x: number; y: number }): Cell {
    const cx = Math.floor(w.x / TILE);
    const cy = Math.floor(w.y / TILE);
    return {
      cx, cy,
      sx: Math.min(SUB - 1, Math.max(0, Math.floor((w.x - cx * TILE) / (TILE / SUB)))),
      sy: Math.min(SUB - 1, Math.max(0, Math.floor((w.y - cy * TILE) / (TILE / SUB)))),
      x: w.x, y: w.y,
    };
  }

  private overCanvas(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    if (this.panel.contains(t)) return false;
    if (t.closest("button, input, textarea, select, #dialog, .screen")) return false;
    return true;
  }

  private keyDown(e: KeyboardEvent): void {
    if (isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === "escape" && this.armed) {
      this.armed = null;
      this.renderPanel();
      e.stopPropagation();
      return;
    }
    if (k === "z" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.undo();
      return;
    }
    if (k === "s" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.flushSave();
      this.ui.toast("Saved to browser storage.");
      return;
    }
    this.keys.add(k);
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.overCanvas(e) || !this.scene) return;
    if (e.button === 1 || e.button === 2 || this.keys.has(" ")) {
      this.panning = { px: e.clientX, py: e.clientY };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const w = this.toWorld(e);
    const cx = Math.floor(w.x / TILE);
    const cy = Math.floor(w.y / TILE);

    if (this.armed) {
      this.fireArmed(w, cx, cy);
      return;
    }

    if (this.tab === "tiles" && this.tileTool !== "paint") {
      this.pushUndo();
      if (this.tileTool === "fill") {
        this.fillFrom(cx, cy);
        this.dirty();
        this.renderPanel();
      } else {
        this.rectDrag = { cx0: cx, cy0: cy, cx1: cx, cy1: cy };
      }
      return;
    }

    if (this.tab === "terrain" || this.tab === "collision" || this.tab === "tiles") {
      this.pushUndo();
      this.painting = true;
      if (this.tab === "collision") this.subCell = { cx, cy };
      this.paintCell(this.cellAt(w));
      // Selecting after the stroke catches a pad the click just laid down as
      // well as one that was already there.
      if (this.tab === "tiles" && specialOf(this.mapTileAt(cx, cy))) {
        this.specialCell = { cx, cy };
        this.renderPanel();
      }
    } else if (this.tab === "props") {
      this.pushUndo();
      this.placeProp(cx, cy);
    } else if (this.tab === "npcs") {
      const hit = this.npcAt(w.x, w.y);
      if (hit) {
        this.selNpc = hit.id;
        this.npcDrag = hit.id;
        this.pushUndo();
        this.renderPanel();
      }
    } else if (this.tab === "zones") {
      const zi = (this.map()?.zones ?? []).findIndex(
        (z) => w.x >= z.x && w.x < z.x + z.w && w.y >= z.y && w.y < z.y + z.h,
      );
      if (zi >= 0) {
        this.selZone = zi;
        this.renderPanel();
      }
    }
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.scene) return;
    if (this.panning) {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const k = dpr / (this.renderer.scale * ART);
      this.cam.x -= (e.clientX - this.panning.px) * k;
      this.cam.y -= (e.clientY - this.panning.py) * k;
      this.panning = { px: e.clientX, py: e.clientY };
      return;
    }
    if (!this.overCanvas(e)) {
      this.hover = null;
      return;
    }
    const w = this.toWorld(e);
    this.hover = this.cellAt(w);
    if (this.rectDrag) {
      this.rectDrag.cx1 = this.hover.cx;
      this.rectDrag.cy1 = this.hover.cy;
    }
    if (this.painting) this.paintCell(this.hover);
    if (this.npcDrag) {
      const npc = this.content.npcs.find((n) => n.id === this.npcDrag);
      if (npc) {
        npc.x = Math.round(w.x);
        npc.y = Math.round(w.y);
      }
    }
    if (this.zoneDrag) {
      this.zoneDrag.x1 = w.x;
      this.zoneDrag.y1 = w.y;
    }
  }

  private pointerUp(e: PointerEvent): void {
    this.panning = null;
    if (this.rectDrag) {
      const r = this.rectDrag;
      this.rectDrag = null;
      this.stampRect(
        Math.min(r.cx0, r.cx1), Math.min(r.cy0, r.cy1),
        Math.max(r.cx0, r.cx1), Math.max(r.cy0, r.cy1),
      );
      this.dirty();
      this.renderPanel();
    }
    if (this.painting) {
      this.painting = false;
      this.dirty();
      // The panel mirrors the cell being worked on, so it has to catch up.
      if (this.tab === "collision" || this.tab === "tiles") this.renderPanel();
    }
    if (this.npcDrag) {
      this.npcDrag = null;
      this.scene?.refreshNpcs();
      this.dirty();
      this.renderPanel();
    }
    if (this.zoneDrag) {
      const d = this.zoneDrag;
      this.zoneDrag = null;
      const x0 = Math.floor(Math.min(d.x0, d.x1) / TILE) * TILE;
      const y0 = Math.floor(Math.min(d.y0, d.y1) / TILE) * TILE;
      const x1 = Math.ceil(Math.max(d.x0, d.x1) / TILE) * TILE;
      const y1 = Math.ceil(Math.max(d.y0, d.y1) / TILE) * TILE;
      const m = this.map();
      if (m && x1 - x0 >= TILE && y1 - y0 >= TILE) {
        this.pushUndo();
        m.zones.push({
          x: x0, y: y0, w: x1 - x0, h: y1 - y0,
          max: ZONE_DEFAULTS.zoneMax, species: [zoneSpecies("catsquito")],
        });
        this.selZone = m.zones.length - 1;
        this.scene?.devRebuildZones();
        this.dirty();
      }
      this.renderPanel();
    }
    void e;
  }

  private fireArmed(w: { x: number; y: number }, cx: number, cy: number): void {
    const armed = this.armed!;
    this.armed = null;
    if (armed.kind === "add-npc") {
      this.pushUndo();
      const id = this.freshId("npc", this.content.npcs.map((n) => n.id));
      this.content.npcs.push({
        id,
        name: "Villager",
        map: this.map()?.id ?? "",
        x: Math.round(w.x),
        y: Math.round(w.y),
        skin: { kind: "villager", look: randomLook() },
        lines: ["Hello there."],
        wander: 20,
      });
      this.selNpc = id;
      this.scene?.refreshNpcs();
      this.dirty();
    } else if (armed.kind === "move-npc") {
      const npc = this.content.npcs.find((n) => n.id === armed.npcId);
      if (npc) {
        this.pushUndo();
        npc.x = Math.round(w.x);
        npc.y = Math.round(w.y);
        this.scene?.refreshNpcs();
        this.dirty();
      }
    } else if (armed.kind === "add-zone") {
      this.zoneDrag = { x0: w.x, y0: w.y, x1: w.x, y1: w.y };
      return; // finishes on pointerup
    } else if (armed.kind === "set-spawn") {
      const m = this.map();
      if (m) {
        this.pushUndo();
        m.spawn = { x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2 };
        this.scene?.devSetSpawn();
        this.dirty();
      }
    } else if (armed.kind === "pick-reach") {
      const quest = this.content.quests.find((q) => q.id === armed.questId);
      const step = quest?.steps[armed.stepIndex];
      if (step && step.kind === "reach") {
        this.pushUndo();
        step.map = this.map()?.id ?? step.map;
        step.x = Math.round(w.x);
        step.y = Math.round(w.y);
        this.dirty();
      }
    }
    this.renderPanel();
  }

  private paintCell(at: Cell): void {
    const { cx, cy } = at;
    const m = this.map();
    if (!m || cx < 0 || cy < 0 || cx >= m.cols || cy >= m.rows || !this.scene) return;
    if (this.tab === "terrain") {
      setTerrainAt(m, cx, cy, this.terrainBrush);
      this.scene.devApplyTerrain(cx, cy);
      return;
    }
    if (this.tab === "tiles") {
      if (this.tileBrush === null) return;
      this.putTile(m, cx, cy, this.tileBrush === "erase" ? null : this.tileBrush);
      this.scene.devApplyTile(cx, cy);
      return;
    }
    const brush = this.collisionBrush;
    if (brush === "sub+" || brush === "sub-") {
      // Painted subcells start from whatever the cell resolves to now, so a
      // first stroke on plain water carves a hole rather than wiping it open.
      const base = this.scene.devWorld().map.cellMask(cx, cy);
      setSubAt(m, cx, cy, maskWith(base, at.sx, at.sy, brush === "sub+"));
    } else {
      setCollisionAt(m, cx, cy, brush);
      setSubAt(m, cx, cy, null);
    }
    this.scene.devApplyCollision(cx, cy);
  }

  // --- tile tools ---

  private mapTileAt(cx: number, cy: number): string | null {
    const m = this.map();
    return m ? tileAt(m, this.layer, cx, cy) : null;
  }

  /**
   * Lay one tile down, stamping the panel's settings on a fresh teleport or
   * sentinel. A cell that already holds the same kind keeps its own settings,
   * so painting over a run does not reset the targets along it.
   */
  private putTile(m: MapDef, cx: number, cy: number, key: string | null): void {
    const wasSpecial = specialOf(tileAt(m, this.layer, cx, cy));
    setTileAt(m, this.layer, cx, cy, key);
    const special = specialOf(key);
    if (!special) return;
    if (wasSpecial === special && cellDataAt(m, cx, cy)) return;
    const stamp = { ...(special === "teleport" ? this.teleportDefault : this.sentinelDefault) };
    // Every pad needs a name of its own, so the stamp cannot carry one.
    if (stamp.kind === "teleport") stamp.id = freshPadId(this.content);
    setCellDataAt(m, cx, cy, stamp);
  }

  /** The tile this brush should put on one cell, spread over its variants. */
  private brushTileFor(family: TileFamily | null): string | null {
    if (this.tileBrush === null) return null;
    if (this.tileBrush === "erase") return null;
    if (!family) return this.tileBrush;
    return family.fill[Math.floor(Math.random() * family.fill.length)] ?? this.tileBrush;
  }

  private brushFamily(): TileFamily | null {
    if (this.tileBrush === null || this.tileBrush === "erase") return null;
    return familyOf(this.tileBrush);
  }

  /** Flood the run of cells that match the one clicked, 4-connected. */
  private fillFrom(cx: number, cy: number): void {
    const m = this.map();
    if (!m || !this.scene || this.tileBrush === null) return;
    if (cx < 0 || cy < 0 || cx >= m.cols || cy >= m.rows) return;
    const family = this.brushFamily();
    const target = tileAt(m, this.layer, cx, cy);
    // Filling a region with what it already holds would never terminate.
    const sameFamily = target !== null && family !== null && family.fill.includes(target);
    if (target === (this.tileBrush === "erase" ? null : this.tileBrush) || sameFamily) return;
    const seen = new Set<string>();
    let front = [{ cx, cy }];
    let guard = m.cols * m.rows;
    while (front.length > 0 && guard-- > 0) {
      const next: { cx: number; cy: number }[] = [];
      for (const cell of front) {
        const key = cellKey(cell.cx, cell.cy);
        if (seen.has(key)) continue;
        if (cell.cx < 0 || cell.cy < 0 || cell.cx >= m.cols || cell.cy >= m.rows) continue;
        if (tileAt(m, this.layer, cell.cx, cell.cy) !== target) continue;
        seen.add(key);
        this.putTile(m, cell.cx, cell.cy, this.brushTileFor(family));
        next.push({ cx: cell.cx + 1, cy: cell.cy }, { cx: cell.cx - 1, cy: cell.cy });
        next.push({ cx: cell.cx, cy: cell.cy + 1 }, { cx: cell.cx, cy: cell.cy - 1 });
      }
      front = next;
    }
    this.scene.devApplyTile(cx, cy);
  }

  /**
   * Fill a rectangle. A family with edge pieces gets them on its border and
   * random interior variants inside; anything else is stamped flat.
   */
  private stampRect(x0: number, y0: number, x1: number, y1: number): void {
    const m = this.map();
    if (!m || !this.scene || this.tileBrush === null) return;
    const family = this.brushFamily();
    const edges = family?.edges;
    for (let cy = Math.max(0, y0); cy <= Math.min(m.rows - 1, y1); cy++) {
      for (let cx = Math.max(0, x0); cx <= Math.min(m.cols - 1, x1); cx++) {
        let key = this.brushTileFor(family);
        if (edges) {
          const n = cy === y0;
          const so = cy === y1;
          const w = cx === x0;
          const e = cx === x1;
          if (n && w) key = edges.nw;
          else if (n && e) key = edges.ne;
          else if (so && w) key = edges.sw;
          else if (so && e) key = edges.se;
          else if (n) key = edges.n;
          else if (so) key = edges.s;
          else if (w) key = edges.w;
          else if (e) key = edges.e;
        }
        this.putTile(m, cx, cy, this.tileBrush === "erase" ? null : key);
      }
    }
    this.scene.devApplyTile(x0, y0);
    this.scene.devRebuildCollision();
  }

  private placeProp(cx: number, cy: number): void {
    const m = this.map();
    if (!m) return;
    const props = m.props;
    const at = props.findIndex((p) => p.cx === cx && p.cy === cy);
    if (this.propBrush === "erase") {
      if (at >= 0) props.splice(at, 1);
    } else {
      if (at >= 0) props.splice(at, 1);
      props.push({ kind: this.propBrush, cx, cy });
    }
    this.scene?.devRebuildProps();
    this.dirty();
  }

  private npcAt(x: number, y: number): NpcDef | null {
    let best: NpcDef | null = null;
    let bestD = 14;
    for (const n of this.content.npcs) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private freshId(prefix: string, taken: string[]): string {
    let i = 1;
    while (taken.includes(`${prefix}${i}`)) i += 1;
    return `${prefix}${i}`;
  }

  // --- overlay ---

  private drawOverlay(ctx: CanvasRenderingContext2D, camX: number, camY: number, w: number, h: number): void {
    const m = this.map();
    const cols = m?.cols ?? COLS;
    const rows = m?.rows ?? ROWS;
    const x0 = Math.max(0, Math.floor(camX / TILE));
    const y0 = Math.max(0, Math.floor(camY / TILE));
    const x1 = Math.min(cols - 1, Math.ceil((camX + w) / TILE));
    const y1 = Math.min(rows - 1, Math.ceil((camY + h) / TILE));

    // The edge of the map, so a resize is visible while it is being set.
    ctx.strokeStyle = "rgba(124,157,240,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(-camX, -camY, cols * TILE, rows * TILE);

    ctx.fillStyle = "rgba(255,255,255,0.07)";
    for (let cx = x0; cx <= x1 + 1; cx++) ctx.fillRect(cx * TILE - camX, y0 * TILE - camY, 0.25, (y1 - y0 + 1) * TILE);
    for (let cy = y0; cy <= y1 + 1; cy++) ctx.fillRect(x0 * TILE - camX, cy * TILE - camY, (x1 - x0 + 1) * TILE, 0.25);

    if (this.tab === "collision") {
      const map = this.scene!.devWorld().map;
      const step = TILE / SUB;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const px = cx * TILE - camX;
          const py = cy * TILE - camY;
          const mask = map.cellMask(cx, cy);
          if (mask === SUB_FULL) {
            ctx.fillStyle = "rgba(217,85,63,0.4)";
            ctx.fillRect(px, py, TILE, TILE);
          } else if (mask !== 0) {
            ctx.fillStyle = "rgba(217,85,63,0.6)";
            for (let sy = 0; sy < SUB; sy++) {
              for (let sx = 0; sx < SUB; sx++) {
                if (maskHas(mask, sx, sy)) ctx.fillRect(px + sx * step, py + sy * step, step, step);
              }
            }
          } else if (m && collisionAt(m, cx, cy) === "o") {
            ctx.fillStyle = "rgba(122,167,74,0.35)";
            ctx.fillRect(px, py, TILE, TILE);
          }
          // Subcell guides, so a rail can be aimed before it is painted.
          ctx.fillStyle = "rgba(255,255,255,0.12)";
          for (let k = 1; k < SUB; k++) {
            ctx.fillRect(px + k * step, py, 0.25, TILE);
            ctx.fillRect(px, py + k * step, TILE, 0.25);
          }
          if (m && subAt(m, cx, cy) !== null) {
            ctx.strokeStyle = "rgba(234,225,120,0.7)";
            ctx.lineWidth = 0.5;
            ctx.strokeRect(px + 0.25, py + 0.25, TILE - 0.5, TILE - 0.5);
          }
        }
      }
      if (this.hover) {
        ctx.strokeStyle = "#f3f2c0";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(
          this.hover.cx * TILE + this.hover.sx * step - camX,
          this.hover.cy * TILE + this.hover.sy * step - camY,
          step, step,
        );
      }
    }

    // What the tile brush would lay down, on the cell it would land on.
    if (this.tab === "tiles" && this.hover && this.tileBrush !== null && this.tileBrush !== "erase") {
      const sheet = tileSheet(this.scene!.devArt());
      const spot = sheet.at(this.tileBrush);
      if (spot) {
        ctx.globalAlpha = 0.7;
        ctx.drawImage(
          sheet.canvas, spot.x, spot.y, TILE_SRC, TILE_SRC,
          this.hover.cx * TILE - camX, this.hover.cy * TILE - camY, TILE, TILE,
        );
        ctx.globalAlpha = 1;
      }
    }

    const zones = m?.zones ?? [];
    zones.forEach((z, i) => {
      const sel = this.tab === "zones" && i === this.selZone;
      ctx.fillStyle = sel ? "rgba(234,225,120,0.18)" : "rgba(234,225,120,0.08)";
      ctx.fillRect(z.x - camX, z.y - camY, z.w, z.h);
      ctx.strokeStyle = sel ? "#eae178" : "rgba(234,225,120,0.6)";
      ctx.lineWidth = sel ? 1 : 0.5;
      ctx.strokeRect(z.x - camX, z.y - camY, z.w, z.h);
    });
    if (this.zoneDrag) {
      const d = this.zoneDrag;
      ctx.strokeStyle = "#eae178";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(d.x0, d.x1) - camX, Math.min(d.y0, d.y1) - camY, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }

    for (const n of this.content.npcs) {
      if (m && n.map !== m.id) continue;
      const sel = n.id === this.selNpc && this.tab === "npcs";
      ctx.strokeStyle = sel ? "#f3f2c0" : "rgba(243,242,192,0.45)";
      ctx.lineWidth = sel ? 1 : 0.5;
      ctx.beginPath();
      ctx.arc(n.x - camX, n.y - camY, 7, 0, Math.PI * 2);
      ctx.stroke();
      if (n.trainer) {
        ctx.fillStyle = "#d9553f";
        ctx.fillRect(n.x - camX - 2, n.y - camY - 12, 4, 4);
      }
    }

    for (const q of this.content.quests) {
      for (const s of q.steps) {
        if (s.kind !== "reach" || (m && s.map !== m.id)) continue;
        drawReachMarker(ctx, s.x - camX, s.y - camY, this.scene!.devWorld().map.waterAnimT);
        if (this.tab === "quests" && q.id === this.selQuest) {
          ctx.strokeStyle = "rgba(229,138,184,0.6)";
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.arc(s.x - camX, s.y - camY, s.r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    const spawn = m?.spawn;
    if (spawn) {
      ctx.strokeStyle = "#7c9df0";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(spawn.x - camX - 5, spawn.y - camY);
      ctx.lineTo(spawn.x - camX + 5, spawn.y - camY);
      ctx.moveTo(spawn.x - camX, spawn.y - camY - 5);
      ctx.lineTo(spawn.x - camX, spawn.y - camY + 5);
      ctx.stroke();
    }

    // Every teleport and sentinel on the map, so they are findable at a glance.
    if (m && (this.tab === "tiles" || this.tab === "maps")) {
      for (const [cell, data] of Object.entries(m.cellData)) {
        const [dx, dy] = cell.split(",").map(Number);
        const px = dx! * TILE - camX;
        const py = dy! * TILE - camY;
        const sel = this.specialCell?.cx === dx && this.specialCell?.cy === dy;
        ctx.strokeStyle = data.kind === "teleport" ? "#7c9df0" : "#e7a03c";
        ctx.lineWidth = sel ? 1 : 0.5;
        ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
        if (data.kind === "teleport") {
          // Names on the map are what make linking two pads a matter of
          // reading rather than remembering.
          ctx.fillStyle = sel ? "#f3f2c0" : "rgba(124,157,240,0.85)";
          ctx.font = "5px monospace";
          ctx.textAlign = "center";
          ctx.fillText(data.id, px + TILE / 2, py - 1);
          ctx.textAlign = "left";
          const far = padById(this.content, data.link);
          if (far && far.map.id === m.id) {
            ctx.beginPath();
            ctx.moveTo(px + TILE / 2, py + TILE / 2);
            ctx.lineTo(far.cx * TILE + TILE / 2 - camX, far.cy * TILE + TILE / 2 - camY);
            ctx.stroke();
          } else if (far && sel) {
            ctx.fillText(`\u2192 ${far.map.name}`, px + TILE / 2, py + TILE + 5);
          }
        }
        if (data.kind === "sentinel" && sel) {
          ctx.beginPath();
          ctx.arc(px + TILE / 2, py + TILE / 2, data.radius, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    if (this.tab === "tiles" && this.hover && m) {
      const stack = stackAt(m, this.hover.cx, this.hover.cy);
      const tx = this.hover.cx * TILE + TILE + 2 - camX;
      let ty = this.hover.cy * TILE + 4 - camY;
      ctx.font = "4px monospace";
      ctx.textAlign = "left";
      for (const id of LAYERS) {
        const key = stack.find((t) => t.layer === id)?.key;
        if (key === undefined && id !== this.layer) continue;
        ctx.fillStyle = !this.shown[id] ? "rgba(217,85,63,0.9)"
          : id === this.layer ? "#f3f2c0" : "rgba(243,242,192,0.5)";
        ctx.fillText(`${LAYER_LABEL[id]}: ${key ?? "\u2014"}`, tx, ty);
        ty += 5;
      }
    }

    if (this.rectDrag) {
      const r = this.rectDrag;
      const rx = Math.min(r.cx0, r.cx1) * TILE - camX;
      const ry = Math.min(r.cy0, r.cy1) * TILE - camY;
      ctx.strokeStyle = "#f3f2c0";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(rx, ry, (Math.abs(r.cx1 - r.cx0) + 1) * TILE, (Math.abs(r.cy1 - r.cy0) + 1) * TILE);
    }

    if (this.hover && (this.tab === "terrain" || this.tab === "collision" || this.tab === "props" || this.tab === "tiles" || this.armed)) {
      ctx.strokeStyle = "#f3f2c0";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(this.hover.cx * TILE - camX, this.hover.cy * TILE - camY, TILE, TILE);
    }
  }

  // --- panel ---

  private renderPanel(): void {
    for (const b of this.panel.querySelectorAll<HTMLElement>(".devTabs .pill")) {
      b.classList.toggle("sel", b.dataset["tab"] === this.tab);
    }
    const on = this.map();
    this.status.textContent = this.armed
      ? this.armed.kind === "add-zone"
        ? "Drag on the map to outline the zone. Esc cancels."
        : "Click the map to place. Esc cancels."
      : `${on ? `${on.name} (${on.cols}x${on.rows})` : "procedural world"} · `
        + "right-drag or space to pan, WASD too, Ctrl+Z undoes.";
    this.body.innerHTML = "";
    const render = {
      terrain: () => this.renderTerrain(),
      tiles: () => this.renderTiles(),
      collision: () => this.renderCollision(),
      props: () => this.renderProps(),
      npcs: () => this.renderNpcs(),
      zones: () => this.renderZones(),
      quests: () => this.renderQuests(),
      maps: () => this.renderMaps(),
      world: () => this.renderWorld(),
    }[this.tab];
    render();
  }

  private pillRow<T extends string>(
    options: { id: T; label: string }[],
    current: T,
    onPick: (id: T) => void,
  ): HTMLElement {
    const row = el("div", "row");
    for (const o of options) {
      const b = el("button", `pill${o.id === current ? " sel" : ""}`, o.label);
      b.addEventListener("click", () => {
        onPick(o.id);
        this.renderPanel();
      });
      row.appendChild(b);
    }
    return row;
  }

  private armButton(label: string, armed: Armed): HTMLElement {
    const b = el("button", "pill", label);
    b.addEventListener("click", () => {
      this.armed = armed;
      this.renderPanel();
    });
    return b;
  }

  private field(label: string, input: HTMLElement): HTMLElement {
    const wrap = el("div", "devField");
    wrap.appendChild(el("label", undefined, label));
    wrap.appendChild(input);
    return wrap;
  }

  private numInput(value: number, onChange: (v: number) => void, min = 0, max = 9999): HTMLInputElement {
    const input = el("input") as HTMLInputElement;
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener("change", () => {
      const v = Math.max(min, Math.min(max, Number(input.value) || 0));
      input.value = String(v);
      onChange(v);
    });
    return input;
  }

  private textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
    const input = el("input") as HTMLInputElement;
    input.type = "text";
    input.value = value;
    input.addEventListener("change", () => onChange(input.value));
    return input;
  }

  private linesInput(value: string[], onChange: (v: string[]) => void): HTMLTextAreaElement {
    const area = el("textarea") as HTMLTextAreaElement;
    area.rows = 3;
    area.placeholder = "One dialog line per row";
    area.value = value.join("\n");
    area.addEventListener("change", () => onChange(splitLines(area.value)));
    return area;
  }

  private speciesSelect(value: string, onChange: (v: string) => void): HTMLSelectElement {
    const sel = el("select") as HTMLSelectElement;
    for (const id of speciesIds()) {
      const o = el("option", undefined, `${SPECIES[id]!.name} (${id})`) as HTMLOptionElement;
      o.value = id;
      sel.appendChild(o);
    }
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  private npcSelect(
    value: string, onChange: (v: string) => void, trainersOnly = false, anyLabel?: string,
  ): HTMLSelectElement {
    const sel = el("select") as HTMLSelectElement;
    const pool = this.content.npcs.filter((n) => !trainersOnly || n.trainer);
    if (anyLabel !== undefined) {
      const o = el("option", undefined, anyLabel) as HTMLOptionElement;
      o.value = "";
      sel.appendChild(o);
    }
    if (pool.length === 0 && anyLabel === undefined) {
      const o = el("option", undefined, trainersOnly ? "(no trainer NPCs yet)" : "(no NPCs yet)") as HTMLOptionElement;
      o.value = "";
      sel.appendChild(o);
    }
    for (const n of pool) {
      const o = el("option", undefined, `${n.name} (${n.id})`) as HTMLOptionElement;
      o.value = n.id;
      sel.appendChild(o);
    }
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  /** Wrap a mutation so it snapshots for undo, persists, and re-renders. */
  private edit(fn: () => void, opts: { npcs?: boolean; zones?: boolean; tiles?: boolean; rerender?: boolean } = {}): void {
    this.pushUndo();
    fn();
    if (opts.npcs) this.scene?.refreshNpcs();
    if (opts.zones) this.scene?.devRebuildZones();
    if (opts.tiles) this.scene?.devRebuildCollision();
    this.dirty();
    if (opts.rerender !== false) this.renderPanel();
  }

  private renderTerrain(): void {
    this.body.appendChild(this.pillRow(
      [{ id: "l" as const, label: "Land" }, { id: "w" as const, label: "Water" }, { id: "b" as const, label: "Bridge" }],
      this.terrainBrush,
      (id) => { this.terrainBrush = id; },
    ));
    this.body.appendChild(el("div", "devHint",
      "Click and drag to paint. Land needs a cell of water on at most one of its east/west sides (1-wide columns have no tile), and the bottom two rows stay water for the cliff face."));
  }

  // --- tiles ---

  /** Every paintable tile, grouped as the tileset declares them. */
  private descs(): TileDesc[] {
    return this.scene ? tileDescs(this.scene.devArt()) : [];
  }

  private descOf(key: string): TileDesc | null {
    return this.descs().find((d) => d.key === key) ?? null;
  }

  /** One tile at source resolution; CSS decides how big it shows. */
  private tileCanvas(key: string): HTMLCanvasElement {
    const cv = el("canvas");
    cv.width = TILE_SRC;
    cv.height = TILE_SRC;
    const ctx = cv.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    const sheet = this.scene ? tileSheet(this.scene.devArt()) : null;
    const spot = sheet?.at(key);
    if (sheet && spot) ctx.drawImage(sheet.canvas, spot.x, spot.y, TILE_SRC, TILE_SRC, 0, 0, TILE_SRC, TILE_SRC);
    return cv;
  }

  /**
   * A 3x3 collision mask laid over the tile it belongs to, so a fence's rail
   * is set by clicking the subcells the rail is drawn in.
   */
  private maskEditor(tileKey: string | null, mask: number, onChange: (m: number) => void): HTMLElement {
    const wrap = el("div", "maskEdit");
    wrap.appendChild(tileKey ? this.tileCanvas(tileKey) : el("div", "maskBlank"));
    const grid = el("div", "maskGrid");
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const cell = el("button", `maskCell${maskHas(mask, sx, sy) ? " on" : ""}`);
        cell.title = `subcell ${sx},${sy}`;
        cell.addEventListener("click", () => onChange(maskWith(mask, sx, sy, !maskHas(mask, sx, sy))));
        grid.appendChild(cell);
      }
    }
    wrap.appendChild(grid);
    return wrap;
  }

  /** Push the current visibility down to the scene and redraw. */
  private applyLayerView(): void {
    this.scene?.devShowLayers((l) => this.shown[l]);
  }

  /** Rows of layer, what is on it, and whether it is drawn. */
  private renderLayers(): void {
    const m = this.map();
    const list = el("div", "devList");
    for (const id of LAYERS) {
      const row = el("div", "layerRow");
      const count = m ? Object.keys(m.tiles[id]).length : 0;
      const pick = el("button", `devItem${id === this.layer ? " sel" : ""}`,
        `${LAYER_LABEL[id]} \u00b7 ${count}`);
      pick.addEventListener("click", () => {
        this.layer = id;
        // Drawing on a layer you cannot see is a trap, so selecting shows it.
        this.shown[id] = true;
        this.applyLayerView();
        this.renderPanel();
      });
      const eye = el("button", `pill${this.shown[id] ? " sel" : ""}`, this.shown[id] ? "on" : "off");
      eye.addEventListener("click", () => {
        this.shown[id] = !this.shown[id];
        this.applyLayerView();
        this.renderPanel();
      });
      row.appendChild(pick);
      row.appendChild(eye);
      list.appendChild(row);
    }
    this.body.appendChild(list);

    const row = el("div", "row");
    const solo = el("button", "pill", "Solo");
    solo.addEventListener("click", () => {
      for (const id of LAYERS) this.shown[id] = id === this.layer;
      this.applyLayerView();
      this.renderPanel();
    });
    const all = el("button", "pill", "Show all");
    all.addEventListener("click", () => {
      for (const id of LAYERS) this.shown[id] = true;
      this.applyLayerView();
      this.renderPanel();
    });
    row.appendChild(solo);
    row.appendChild(all);
    this.body.appendChild(row);
    this.body.appendChild(el("div", "devHint", LAYER_BLURB[this.layer]));
  }

  private renderTiles(): void {
    this.renderLayers();
    this.body.appendChild(this.pillRow(
      [
        { id: "paint" as const, label: "Paint" },
        { id: "fill" as const, label: "Fill" },
        { id: "rect" as const, label: "Rect" },
      ],
      this.tileTool,
      (id) => { this.tileTool = id; },
    ));
    const erase = el("button", `pill${this.tileBrush === "erase" ? " sel" : ""}`, "Erase");
    erase.addEventListener("click", () => {
      this.tileBrush = "erase";
      this.renderPanel();
    });
    const tools = el("div", "row");
    tools.appendChild(erase);
    this.body.appendChild(tools);

    let group = "";
    let pal: HTMLElement | null = null;
    for (const d of this.descs()) {
      if (d.group !== group) {
        group = d.group;
        this.body.appendChild(el("div", "palGroup", group));
        pal = el("div", "tilePal");
        this.body.appendChild(pal);
      }
      const b = el("button", `tileBtn${d.key === this.tileBrush ? " sel" : ""}`);
      b.title = d.label;
      b.appendChild(this.tileCanvas(d.key));
      b.addEventListener("click", () => {
        this.tileBrush = d.key;
        // Reaching for a bush means reaching for the layer bushes live on.
        this.layer = tileLayer(this.scene!.devArt(), this.content, d.key);
        this.shown[this.layer] = true;
        this.applyLayerView();
        this.renderPanel();
      });
      pal!.appendChild(b);
    }

    const key = this.tileBrush;
    if (key === null || key === "erase") {
      this.body.appendChild(el("div", "devHint",
        "Pick a tile, then click and drag on the map to lay it down. Fill floods the run of matching cells, Rect drags out a block. Erase drops a cell back to the auto-tiled ground. Drop a PNG in assets/Tiles and it shows up here, in four turns, on the next reload."));
      this.renderSpecialCell();
      return;
    }

    const family = familyOf(key);
    if (family) {
      this.body.appendChild(el("div", "devHint", family.edges
        ? `Part of the ${family.label} set. Rect rims the block with its edges and corners and scatters the ${family.fill.length} inner variants inside.`
        : `Part of the ${family.label} set, so Fill and Rect scatter its ${family.fill.length} variants.`));
    }

    const card = el("div", "devCard");
    card.appendChild(el("strong", undefined, this.descOf(key)?.label ?? key));
    const art = this.scene!.devArt();
    const mask = tileMask(art, this.content, key);
    card.appendChild(this.maskEditor(key, mask, (m) => this.edit(() => {
      this.content.tileRules[key] = { ...this.content.tileRules[key], solid: m };
    }, { tiles: true })));
    card.appendChild(el("div", "devHint",
      "Default collision. Every cell holding this tile takes it, unless that cell was painted by hand."));

    const home = tileLayer(art, this.content, key);
    card.appendChild(el("div", "devHint", `Reaches for the ${LAYER_LABEL[home]} layer.`));
    const homeRow = el("div", "row");
    for (const id of LAYERS) {
      const b = el("button", `pill${id === home ? " sel" : ""}`, LAYER_LABEL[id]);
      b.addEventListener("click", () => {
        this.layer = id;
        this.shown[id] = true;
        this.applyLayerView();
        this.edit(() => {
          this.content.tileRules[key] = { ...this.content.tileRules[key], layer: id };
        }, { tiles: true });
      });
      homeRow.appendChild(b);
    }
    card.appendChild(homeRow);
    const row = el("div", "row");
    if (this.content.tileRules[key]) {
      const reset = el("button", "pill", "Reset");
      reset.addEventListener("click", () => this.edit(() => {
        delete this.content.tileRules[key];
      }, { tiles: true }));
      row.appendChild(reset);
    }
    card.appendChild(row);
    this.body.appendChild(card);

    const special = specialOf(key);
    if (special === "teleport") {
      this.body.appendChild(el("div", "devHint",
        "Each pad is named as you lay it down. Click one to name it properly and pick the pad it sends you to."));
    } else if (special === "sentinel") {
      this.body.appendChild(this.cellDataCard(
        "New sentinels start with", this.sentinelDefault,
        (d) => { this.sentinelDefault = d; },
      ));
    }
    this.renderSpecialCell();
  }

  /** The settings of the teleport or sentinel cell currently selected. */
  private renderSpecialCell(): void {
    const m = this.map();
    const cell = this.specialCell;
    if (!m || !cell) return;
    const data = cellDataAt(m, cell.cx, cell.cy);
    if (!data) {
      this.specialCell = null;
      return;
    }
    this.body.appendChild(this.cellDataCard(
      `This ${data.kind} at ${cell.cx}, ${cell.cy}`, data,
      (d) => this.edit(() => {
        setCellDataAt(m, cell.cx, cell.cy, d);
      }, { tiles: true }),
    ));
  }

  /** One editor for either kind of cell data, used for defaults and for cells. */
  private cellDataCard(title: string, data: CellData, onChange: (d: CellData) => void): HTMLElement {
    const card = el("div", "devCard");
    card.appendChild(el("strong", undefined, title));
    if (data.kind === "teleport") {
      card.appendChild(this.field("This pad's name", this.textInput(data.id, (v) => {
        const name = v.trim();
        if (name === data.id) return;
        if (name === "" || padById(this.content, name)) {
          this.ui.toast(name === "" ? "A pad needs a name." : `${name} is already a pad.`);
          this.renderPanel();
          return;
        }
        // Anything pointing at the old name has to follow it.
        for (const other of pads(this.content)) {
          if (other.data.link === data.id) other.data.link = name;
        }
        onChange({ ...data, id: name });
      })));

      const sel = el("select") as HTMLSelectElement;
      for (const [value, label] of [["", "(nowhere yet)"], ["@place", "a place, not a pad"]]) {
        const o = el("option", undefined, label) as HTMLOptionElement;
        o.value = value!;
        sel.appendChild(o);
      }
      for (const other of pads(this.content)) {
        if (other.data.id === data.id) continue;
        const o = el("option", undefined,
          `${other.data.id} on ${other.map.name} (${other.cx}, ${other.cy})`) as HTMLOptionElement;
        o.value = other.data.id;
        sel.appendChild(o);
      }
      const usingPlace = data.link === "" && data.map !== "";
      sel.value = usingPlace ? "@place" : data.link;
      sel.addEventListener("change", () => {
        if (sel.value === "@place") {
          const here = this.map();
          onChange({ ...data, link: "", map: data.map || here?.id || "", x: data.x, y: data.y });
        } else {
          onChange({ ...data, link: sel.value, map: "" });
        }
      });
      card.appendChild(this.field("Sends you to", sel));

      if (usingPlace) {
        const mapSel = el("select") as HTMLSelectElement;
        for (const other of this.content.maps) {
          const o = el("option", undefined, `${other.name} (${other.id})`) as HTMLOptionElement;
          o.value = other.id;
          mapSel.appendChild(o);
        }
        mapSel.value = data.map;
        mapSel.addEventListener("change", () => {
          const dest = mapById(this.content, mapSel.value);
          onChange({ ...data, map: mapSel.value, x: dest?.spawn.x ?? 0, y: dest?.spawn.y ?? 0 });
        });
        card.appendChild(this.field("Map", mapSel));
        const row = el("div", "row");
        row.appendChild(this.numInput(Math.round(data.x), (v) => onChange({ ...data, x: v }), 0, 99999));
        row.appendChild(this.numInput(Math.round(data.y), (v) => onChange({ ...data, y: v }), 0, 99999));
        card.appendChild(this.field("Arrive at (world px)", row));
        card.appendChild(el("div", "devHint",
          "Zero for both arrives on that map's spawn."));
      }

      const other = padById(this.content, data.link);
      if (other && other.data.link !== data.id) {
        const back = el("button", "pill", `Link ${other.data.id} back to ${data.id}`);
        back.disabled = data.id === "";
        back.addEventListener("click", () => this.edit(() => {
          other.data.link = data.id;
          other.data.map = "";
        }, { tiles: true }));
        card.appendChild(back);
      }

      card.appendChild(el("div", "devHint", other
        ? `Steps you onto ${other.data.id}, wherever that pad is. Moving it moves the far end with it.`
        : "Name this pad, then pick another pad for it to send you to. A pad with nowhere to go still works as somewhere to arrive. Stepping on the pad you arrive on does nothing until you walk off it."));
      return card;
    }

    card.appendChild(this.pillRow(
      [{ id: "wild" as const, label: "Wild Scobas" }, { id: "trainer" as const, label: "Trainers" }],
      data.cond,
      (id) => onChange({ ...data, cond: id }),
    ));
    card.appendChild(this.field("How many",
      this.numInput(data.count, (v) => onChange({ ...data, count: v }), 1, 99)));
    card.appendChild(this.field("Within (world px)",
      this.numInput(Math.round(data.radius), (v) => onChange({ ...data, radius: v }), 16, 2000)));
    if (data.cond === "trainer") {
      card.appendChild(this.field("Specific trainer",
        this.npcSelect(data.npcId, (v) => onChange({ ...data, npcId: v }), true, "(any in range)")));
    }
    card.appendChild(this.field("Says while shut",
      this.textInput(data.label, (v) => onChange({ ...data, label: v }))));
    card.appendChild(el("div", "devHint",
      "It blocks until that many wins happen inside the radius, then swaps to its open art and lets you past. Progress lives in the save, so clearing one stays cleared."));
    return card;
  }

  private renderCollision(): void {
    this.body.appendChild(this.pillRow(
      [
        { id: "sub+" as const, label: "Paint" },
        { id: "sub-" as const, label: "Erase" },
        { id: "s" as const, label: "Solid" },
        { id: "o" as const, label: "Open" },
        { id: "." as const, label: "Auto" },
      ],
      this.collisionBrush,
      (id) => { this.collisionBrush = id; },
    ));
    this.body.appendChild(el("div", "devHint",
      "Paint and Erase work one subcell at a time, nine to a tile. Solid, Open and Auto set a whole tile at once, Auto handing it back to the terrain and the tile under it. Red is blocked; a yellow outline marks a cell painted by hand."));

    const cell = this.subCell;
    if (!cell || !this.scene) {
      this.body.appendChild(el("div", "devHint", "Click a tile on the map to edit its nine subcells here as well."));
      return;
    }
    const card = el("div", "devCard");
    card.appendChild(el("strong", undefined, `Cell ${cell.cx}, ${cell.cy}`));
    const mask = this.scene.devWorld().map.cellMask(cell.cx, cell.cy);
    const on = this.map();
    if (!on) return;
    const top = stackAt(on, cell.cx, cell.cy);
    card.appendChild(this.maskEditor(top[top.length - 1]?.key ?? null, mask, (v) => this.edit(() => {
      setSubAt(on, cell.cx, cell.cy, v);
      this.scene?.devApplyCollision(cell.cx, cell.cy);
    })));
    if (cellDataAt(on, cell.cx, cell.cy)?.kind === "sentinel") {
      card.appendChild(el("div", "devHint",
        "A sentinel stands here, so this mask only shapes it while it is shut. Passing its condition opens the cell whatever is painted on it."));
    }
    if (subAt(on, cell.cx, cell.cy) !== null) {
      const clear = el("button", "pill", "Drop override");
      clear.addEventListener("click", () => this.edit(() => {
        setSubAt(on, cell.cx, cell.cy, null);
        this.scene?.devApplyCollision(cell.cx, cell.cy);
      }));
      card.appendChild(clear);
    }
    this.body.appendChild(card);
  }

  private renderProps(): void {
    this.body.appendChild(this.pillRow(
      [...PROP_KINDS.map((k) => ({ id: k as PropKind | "erase", label: k })), { id: "erase" as const, label: "erase" }],
      this.propBrush,
      (id) => { this.propBrush = id; },
    ));
    this.body.appendChild(el("div", "devHint",
      "Click a tile to place or erase. Barrels block movement; the nest opens the breeding screen."));
  }

  private renderNpcs(): void {
    this.body.appendChild(this.armButton("+ Add NPC (click map)", { kind: "add-npc" }));
    const here = this.map()?.id ?? "";
    const list = el("div", "devList");
    for (const n of this.content.npcs) {
      if (n.map !== here) continue;
      const b = el("button", `devItem${n.id === this.selNpc ? " sel" : ""}`,
        `${n.name}${n.trainer ? " ⚔" : ""} · ${n.id}`);
      b.addEventListener("click", () => {
        this.selNpc = n.id;
        this.cam.x = n.x;
        this.cam.y = n.y;
        this.renderPanel();
      });
      list.appendChild(b);
    }
    this.body.appendChild(list);

    const npc = this.content.npcs.find((n) => n.id === this.selNpc);
    if (!npc) {
      this.body.appendChild(el("div", "devHint", "Select an NPC to edit it, or drag one on the map to move it."));
      return;
    }

    this.body.appendChild(this.field("Name", this.textInput(npc.name, (v) => this.edit(() => { npc.name = v; }, { npcs: true }))));

    const skinSel = el("select") as HTMLSelectElement;
    const villagerOpt = el("option", undefined, "Villager (paperdoll)") as HTMLOptionElement;
    villagerOpt.value = "villager";
    skinSel.appendChild(villagerOpt);
    for (const id of speciesIds()) {
      const o = el("option", undefined, `Scoba: ${SPECIES[id]!.name}`) as HTMLOptionElement;
      o.value = `scoba:${id}`;
      skinSel.appendChild(o);
    }
    skinSel.value = npc.skin.kind === "villager" ? "villager" : `scoba:${npc.skin.species}`;
    skinSel.addEventListener("change", () => this.edit(() => {
      npc.skin = skinSel.value === "villager"
        ? { kind: "villager", look: randomLook() }
        : { kind: "scoba", species: skinSel.value.slice(6) };
    }, { npcs: true }));
    this.body.appendChild(this.field("Body", skinSel));

    if (npc.skin.kind === "villager") {
      const reroll = el("button", "pill", "Randomize look");
      reroll.addEventListener("click", () => this.edit(() => {
        npc.skin = { kind: "villager", look: randomLook() };
      }, { npcs: true }));
      this.body.appendChild(reroll);
    }

    this.body.appendChild(this.field("Wander radius (px, 0 = still)",
      this.numInput(npc.wander, (v) => this.edit(() => { npc.wander = v; }, { npcs: true }), 0, 200)));
    this.body.appendChild(this.field("Chat",
      this.linesInput(npc.lines, (v) => this.edit(() => { npc.lines = v; }))));

    const trainerToggle = el("button", "pill", npc.trainer ? "Remove trainer fight" : "Make trainer");
    trainerToggle.addEventListener("click", () => this.edit(() => {
      npc.trainer = npc.trainer ? undefined : {
        team: [{ species: speciesIds()[0]!, level: 5 }],
        reward: 100,
        intro: ["You want a fight?"],
        beaten: ["You got me fair and square."],
      };
    }));
    this.body.appendChild(trainerToggle);

    const trainer = npc.trainer;
    if (trainer) {
      const teamCard = el("div", "devCard");
      teamCard.appendChild(el("strong", undefined, "Team"));
      trainer.team.forEach((m, i) => {
        const row = el("div", "row");
        row.appendChild(this.speciesSelect(m.species, (v) => this.edit(() => { m.species = v; }, { rerender: false })));
        row.appendChild(this.numInput(m.level, (v) => this.edit(() => { m.level = v; }, { rerender: false }), 1, 100));
        const del = el("button", "pill", "x");
        del.addEventListener("click", () => this.edit(() => { trainer.team.splice(i, 1); }));
        row.appendChild(del);
        teamCard.appendChild(row);
      });
      if (trainer.team.length < 4) {
        const add = el("button", "pill", "+ member");
        add.addEventListener("click", () => this.edit(() => {
          trainer.team.push({ species: speciesIds()[0]!, level: 5 });
        }));
        teamCard.appendChild(add);
      }
      teamCard.appendChild(this.field("Prize money",
        this.numInput(trainer.reward, (v) => this.edit(() => { trainer.reward = v; }, { rerender: false }))));
      teamCard.appendChild(this.field("Before the fight",
        this.linesInput(trainer.intro, (v) => this.edit(() => { trainer.intro = v; }))));
      teamCard.appendChild(this.field("Once beaten",
        this.linesInput(trainer.beaten, (v) => this.edit(() => { trainer.beaten = v; }))));
      this.body.appendChild(teamCard);
    }

    const row = el("div", "row");
    row.appendChild(this.armButton("Move (click map)", { kind: "move-npc", npcId: npc.id }));
    const del = el("button", "pill warn", "Delete NPC");
    del.addEventListener("click", () => this.edit(() => {
      this.content.npcs = this.content.npcs.filter((n) => n.id !== npc.id);
      this.selNpc = null;
    }, { npcs: true }));
    row.appendChild(del);
    this.body.appendChild(row);
  }

  /** The tiles one kind rises from, as thumbnails you can take away. */
  private spawnTilePicker(kind: ZoneSpecies): HTMLElement {
    const wrap = el("div", "devField");
    wrap.appendChild(el("label", undefined, "Rises from"));
    const pal = el("div", "tilePal");
    for (const key of kind.tiles) {
      const b = el("button", "tileBtn sel");
      b.title = `${key} (click to drop)`;
      b.appendChild(this.tileCanvas(key));
      b.addEventListener("click", () => this.edit(() => {
        kind.tiles = kind.tiles.filter((t) => t !== key);
      }, { zones: true }));
      pal.appendChild(b);
    }
    wrap.appendChild(pal);

    const add = el("select") as HTMLSelectElement;
    const none = el("option", undefined, kind.tiles.length > 0 ? "+ another tile" : "anywhere in the zone") as HTMLOptionElement;
    none.value = "";
    add.appendChild(none);
    for (const d of this.descs()) {
      if (kind.tiles.includes(d.key)) continue;
      const o = el("option", undefined, `${d.group} · ${d.label}`) as HTMLOptionElement;
      o.value = d.key;
      add.appendChild(o);
    }
    add.addEventListener("change", () => {
      if (add.value === "") return;
      this.edit(() => { kind.tiles = [...kind.tiles, add.value]; }, { zones: true });
    });
    wrap.appendChild(add);
    return wrap;
  }

  private zoneSpeciesCard(zone: EncounterZone, kind: ZoneSpecies, i: number): HTMLElement {
    const card = el("div", "devCard");
    const head = el("div", "row");
    head.appendChild(this.speciesSelect(kind.species, (v) => this.edit(() => { kind.species = v; }, { zones: true })));
    const del = el("button", "pill warn", "x");
    del.addEventListener("click", () => this.edit(() => { zone.species.splice(i, 1); }, { zones: true }));
    head.appendChild(del);
    card.appendChild(head);

    const levels = el("div", "row");
    levels.appendChild(this.numInput(kind.minLv, (v) => this.edit(() => {
      kind.minLv = v;
      if (kind.maxLv < v) kind.maxLv = v;
    }, { zones: true }), 1, 100));
    levels.appendChild(this.numInput(kind.maxLv, (v) => this.edit(() => {
      kind.maxLv = Math.max(v, kind.minLv);
    }, { zones: true }), 1, 100));
    card.appendChild(this.field("Levels (min, max)", levels));

    card.appendChild(this.field("Appear (% per second)", this.numInput(
      Math.round(kind.ratePerSec * 100),
      (v) => this.edit(() => { kind.ratePerSec = v / 100; }, { zones: true, rerender: false }),
      0, 1000,
    )));
    card.appendChild(this.field("Most out at once", this.numInput(
      kind.max, (v) => this.edit(() => { kind.max = v; }, { zones: true, rerender: false }), 0, 30,
    )));
    card.appendChild(this.field("Speed (px per second)", this.numInput(
      Math.round(kind.speed), (v) => this.edit(() => { kind.speed = v; }, { zones: true, rerender: false }), 1, 400,
    )));
    card.appendChild(this.field("Notices you within (px)", this.numInput(
      Math.round(kind.detect), (v) => this.edit(() => { kind.detect = v; }, { zones: true, rerender: false }), 0, 600,
    )));
    card.appendChild(this.spawnTilePicker(kind));
    return card;
  }

  private renderZones(): void {
    this.body.appendChild(this.armButton("+ Add zone (drag on map)", { kind: "add-zone" }));
    const zones = this.map()?.zones ?? [];
    const list = el("div", "devList");
    zones.forEach((z, i) => {
      const b = el("button", `devItem${i === this.selZone ? " sel" : ""}`,
        `Zone ${i + 1} · ${z.species.length} kinds · up to ${z.max}`);
      b.addEventListener("click", () => {
        this.selZone = i;
        this.cam.x = z.x + z.w / 2;
        this.cam.y = z.y + z.h / 2;
        this.renderPanel();
      });
      list.appendChild(b);
    });
    this.body.appendChild(list);

    const zone = zones[this.selZone];
    if (!zone) {
      this.body.appendChild(el("div", "devHint",
        "Wild Scobas rise inside zones and charge when you get close. Each kind keeps its own rate, caps, speed and the tiles it comes up from."));
      return;
    }

    this.body.appendChild(this.field("Most Scobas out at once", this.numInput(
      zone.max, (v) => this.edit(() => { zone.max = v; }, { zones: true, rerender: false }), 0, 40,
    )));
    this.body.appendChild(el("div", "devHint",
      "The zone's ceiling holds over every kind's own. Rates roll once a second per kind, and only while both caps leave room."));

    zone.species.forEach((kind, i) => this.body.appendChild(this.zoneSpeciesCard(zone, kind, i)));

    const addRow = el("div", "row");
    const add = el("button", "pill", "+ species");
    add.addEventListener("click", () => this.edit(() => {
      const taken = zone.species.map((sp) => sp.species);
      const next = speciesIds().find((id) => !taken.includes(id)) ?? speciesIds()[0]!;
      zone.species.push(zoneSpecies(next));
    }, { zones: true }));
    addRow.appendChild(add);
    const del = el("button", "pill warn", "Delete zone");
    del.addEventListener("click", () => this.edit(() => {
      zones.splice(this.selZone, 1);
      this.selZone = -1;
    }, { zones: true }));
    addRow.appendChild(del);
    this.body.appendChild(addRow);
  }

  private renderQuests(): void {
    const add = el("button", "pill", "+ Add quest");
    add.addEventListener("click", () => this.edit(() => {
      const id = this.freshId("quest", this.content.quests.map((q) => q.id));
      this.content.quests.push({ id, name: "New quest", steps: [], reward: { money: 50 } });
      this.selQuest = id;
    }));
    this.body.appendChild(add);

    const list = el("div", "devList");
    for (const q of this.content.quests) {
      const b = el("button", `devItem${q.id === this.selQuest ? " sel" : ""}`,
        `${q.name} · ${q.steps.length} steps`);
      b.addEventListener("click", () => {
        this.selQuest = q.id;
        this.renderPanel();
      });
      list.appendChild(b);
    }
    this.body.appendChild(list);

    const quest = this.content.quests.find((q) => q.id === this.selQuest);
    if (!quest) {
      this.body.appendChild(el("div", "devHint",
        "A quest is a chain of steps: talk to an NPC, reach a spot, defeat a trainer. It starts when its first step happens, so open with a talk step."));
      return;
    }

    this.body.appendChild(this.field("Name", this.textInput(quest.name, (v) => this.edit(() => { quest.name = v; }))));

    const afterSel = el("select") as HTMLSelectElement;
    const none = el("option", undefined, "(always available)") as HTMLOptionElement;
    none.value = "";
    afterSel.appendChild(none);
    for (const q of this.content.quests) {
      if (q.id === quest.id) continue;
      const o = el("option", undefined, q.name) as HTMLOptionElement;
      o.value = q.id;
      afterSel.appendChild(o);
    }
    afterSel.value = quest.after ?? "";
    afterSel.addEventListener("change", () => this.edit(() => {
      quest.after = afterSel.value || undefined;
    }));
    this.body.appendChild(this.field("Requires quest", afterSel));

    this.body.appendChild(this.field("Reward money",
      this.numInput(quest.reward?.money ?? 0, (v) => this.edit(() => {
        quest.reward = { ...quest.reward, money: v || undefined };
      }, { rerender: false }))));

    quest.steps.forEach((step, i) => this.body.appendChild(this.stepCard(quest, step, i)));

    const addRow = el("div", "row");
    const addStep = (kind: QuestStep["kind"]): void => this.edit(() => {
      const firstNpc = this.content.npcs[0]?.id ?? "";
      const firstTrainer = this.content.npcs.find((n) => n.trainer)?.id ?? firstNpc;
      const p = this.scene?.playerPos() ?? { x: 0, y: 0 };
      const step: QuestStep = kind === "talk"
        ? { kind, npcId: firstNpc, lines: [] }
        : kind === "reach"
          ? { kind, map: this.map()?.id ?? "", x: Math.round(p.x), y: Math.round(p.y), r: 24, label: "" }
          : { kind, npcId: firstTrainer, intro: [] };
      quest.steps.push(step);
    });
    for (const kind of ["talk", "reach", "defeat"] as const) {
      const b = el("button", "pill", `+ ${kind}`);
      b.addEventListener("click", () => addStep(kind));
      addRow.appendChild(b);
    }
    this.body.appendChild(addRow);

    const tools = el("div", "row");
    const reset = el("button", "pill", "Reset progress");
    reset.addEventListener("click", () => {
      if (!this.save) return;
      this.save.quests = {};
      for (const key of Object.keys(this.save.story.flags)) {
        if (key.startsWith("beat:")) delete this.save.story.flags[key];
      }
      this.ui.toast("Quest progress and trainer defeats cleared.");
    });
    tools.appendChild(reset);
    const del = el("button", "pill warn", "Delete quest");
    del.addEventListener("click", () => this.edit(() => {
      this.content.quests = this.content.quests.filter((q) => q.id !== quest.id);
      this.selQuest = null;
    }));
    tools.appendChild(del);
    this.body.appendChild(tools);
  }

  private stepCard(quest: QuestDef, step: QuestStep, i: number): HTMLElement {
    const card = el("div", "devCard");
    const head = el("div", "row");
    head.appendChild(el("strong", undefined, `${i + 1}. ${step.kind}`));
    const up = el("button", "pill", "↑");
    up.disabled = i === 0;
    up.addEventListener("click", () => this.edit(() => {
      quest.steps.splice(i - 1, 0, quest.steps.splice(i, 1)[0]!);
    }));
    const down = el("button", "pill", "↓");
    down.disabled = i === quest.steps.length - 1;
    down.addEventListener("click", () => this.edit(() => {
      quest.steps.splice(i + 1, 0, quest.steps.splice(i, 1)[0]!);
    }));
    const del = el("button", "pill warn", "x");
    del.addEventListener("click", () => this.edit(() => {
      quest.steps.splice(i, 1);
    }));
    head.appendChild(up);
    head.appendChild(down);
    head.appendChild(del);
    card.appendChild(head);

    if (step.kind === "talk") {
      card.appendChild(this.field("NPC", this.npcSelect(step.npcId, (v) => this.edit(() => { step.npcId = v; }, { rerender: false }))));
      card.appendChild(this.field("They say", this.linesInput(step.lines, (v) => this.edit(() => { step.lines = v; }))));
    } else if (step.kind === "reach") {
      card.appendChild(this.armButton("Pick spot (click map)", { kind: "pick-reach", questId: quest.id, stepIndex: i }));
      card.appendChild(this.field("Radius (px)", this.numInput(step.r, (v) => this.edit(() => { step.r = v; }, { rerender: false }), 8, 200)));
      card.appendChild(this.field("Objective text", this.textInput(step.label, (v) => this.edit(() => { step.label = v; }, { rerender: false }))));
    } else {
      card.appendChild(this.field("Trainer NPC", this.npcSelect(step.npcId, (v) => this.edit(() => { step.npcId = v; }, { rerender: false }), true)));
      card.appendChild(this.field("They say before the fight", this.linesInput(step.intro, (v) => this.edit(() => { step.intro = v; }))));
      const npc = this.content.npcs.find((n) => n.id === step.npcId);
      if (!npc?.trainer) card.appendChild(el("div", "devHint", "That NPC has no trainer team yet, so this step cannot fire."));
    }
    return card;
  }

  // --- maps ---

  /** Open another map: the scene loads it, so every tool follows along. */
  private openMap(id: string): void {
    this.selNpc = null;
    this.selZone = -1;
    this.subCell = null;
    this.specialCell = null;
    this.scene?.devOpenMap(id);
    const m = mapById(this.content, id);
    if (m) this.cam = { x: m.spawn.x, y: m.spawn.y };
    if (this.scene) this.scene.devCam = this.cam;
    this.renderPanel();
  }

  private renderMaps(): void {
    const here = this.map();
    const add = el("button", "pill", "+ New map");
    add.addEventListener("click", () => {
      const id = this.freshId("map", this.content.maps.map((m) => m.id));
      this.edit(() => {
        this.content.maps.push(blankMap(id, `Map ${this.content.maps.length + 1}`, 30, 24));
      }, { rerender: false });
      this.openMap(id);
    });
    const dup = el("button", "pill", "Duplicate");
    dup.disabled = !here;
    dup.addEventListener("click", () => {
      if (!here) return;
      const id = this.freshId("map", this.content.maps.map((m) => m.id));
      this.edit(() => {
        const copy = JSON.parse(JSON.stringify(here)) as MapDef;
        copy.id = id;
        copy.name = `${here.name} copy`;
        this.content.maps.push(copy);
      }, { rerender: false });
      this.openMap(id);
    });
    const row = el("div", "row");
    row.appendChild(add);
    row.appendChild(dup);
    this.body.appendChild(row);

    const list = el("div", "devList");
    for (const m of this.content.maps) {
      const start = m.id === this.content.startMap ? " \u2691" : "";
      const b = el("button", `devItem${m.id === here?.id ? " sel" : ""}`,
        `${m.name}${start} \u00b7 ${m.cols}x${m.rows}`);
      b.addEventListener("click", () => this.openMap(m.id));
      list.appendChild(b);
    }
    this.body.appendChild(list);

    if (!here) {
      this.body.appendChild(el("div", "devHint", "No map is open."));
      return;
    }

    const card = el("div", "devCard");
    card.appendChild(el("strong", undefined, `Editing ${here.id}`));
    card.appendChild(this.field("Name", this.textInput(here.name, (v) => this.edit(() => {
      here.name = v;
    }))));

    // Size is applied on a button rather than per keystroke, since a resize
    // crops whatever falls outside and there is no undoing half a number.
    const wIn = this.numInput(here.cols, () => undefined, 8, 200);
    const hIn = this.numInput(here.rows, () => undefined, 8, 200);
    const sizeRow = el("div", "row");
    sizeRow.appendChild(wIn);
    sizeRow.appendChild(hIn);
    const apply = el("button", "pill", "Resize");
    apply.addEventListener("click", () => {
      const cols = Math.max(8, Math.min(200, Number(wIn.value) || here.cols));
      const rows = Math.max(8, Math.min(200, Number(hIn.value) || here.rows));
      if (cols === here.cols && rows === here.rows) return;
      this.edit(() => {
        resizeMap(here, cols, rows);
      }, { rerender: false });
      this.scene?.devReload();
      this.renderPanel();
      this.ui.toast(`${here.name} is ${cols}x${rows} now.`);
    });
    sizeRow.appendChild(apply);
    card.appendChild(this.field("Width and height, in tiles", sizeRow));
    card.appendChild(el("div", "devHint",
      "Shrinking drops anything outside the new edge. Growing fills with water."));

    if (here.id !== this.content.startMap) {
      const mark = el("button", "pill", "Start new saves here");
      mark.addEventListener("click", () => this.edit(() => {
        this.content.startMap = here.id;
      }));
      card.appendChild(mark);
    }
    card.appendChild(this.armButton("Set spawn (click map)", { kind: "set-spawn" }));

    const reset = el("button", "pill", "Start this map over");
    reset.addEventListener("click", () => {
      const done = this.scene?.resetMapState();
      if (!done) return;
      // Testing means playing, so the editor gets out of the way.
      this.close();
      this.ui.toast(`Map reset: ${done.sentinels} sentinels shut, ${done.trainers} trainers back up.`);
    });
    card.appendChild(reset);
    card.appendChild(el("div", "devHint",
      "Shuts every sentinel here, stands its trainers back up, clears the wilds and drops you on the spawn. F4 does the same without opening this. Quest progress resets in the Quests tab."));

    const del = el("button", "pill warn", "Delete map");
    del.disabled = this.content.maps.length < 2;
    del.addEventListener("click", () => {
      const rest = this.content.maps.filter((m) => m.id !== here.id);
      if (rest.length === 0) return;
      this.edit(() => {
        this.content.maps = rest;
        this.content.npcs = this.content.npcs.filter((n) => n.map !== here.id);
        if (this.content.startMap === here.id) this.content.startMap = rest[0]!.id;
      }, { rerender: false });
      this.openMap(rest[0]!.id);
    });
    card.appendChild(del);
    this.body.appendChild(card);

    const teleports = Object.values(here.cellData).filter((d) => d.kind === "teleport").length;
    const sentinels = Object.values(here.cellData).filter((d) => d.kind === "sentinel").length;
    this.body.appendChild(el("div", "devHint",
      `${here.props.length} props, ${here.zones.length} zones, `
      + `${this.content.npcs.filter((n) => n.map === here.id).length} NPCs, `
      + `${teleports} teleports, ${sentinels} sentinels. `
      + "Teleports and sentinels are painted from the Tiles tab, under Special."));
  }

  private renderWorld(): void {
    this.body.appendChild(this.armButton("Set spawn (click map)", { kind: "set-spawn" }));

    const info = el("div", "devHint",
      `Content: ${this.content.maps.length} maps, ${this.content.npcs.length} NPCs, ` +
      `${this.content.quests.length} quests. ` +
      "Edits live in this browser until you export.");
    this.body.appendChild(info);

    const exportB = el("button", "pill", "Export world.json");
    exportB.addEventListener("click", () => {
      this.flushSave();
      const blob = new Blob([JSON.stringify(this.content, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "world.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.ui.toast("Drop it at src/game/content/world.json to ship it.");
    });
    this.body.appendChild(exportB);

    const importB = el("button", "pill", "Import world.json");
    importB.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const dev = (window as unknown as { scobaDev: { importString(j: string): void } }).scobaDev;
            this.pushUndo();
            dev.importString(String(reader.result));
            this.renderPanel();
            this.ui.toast("Imported.");
          } catch {
            this.ui.toast("Import failed: not a world.json.");
          }
        };
        reader.readAsText(file);
      };
      input.click();
    });
    this.body.appendChild(importB);

    const revert = el("button", "pill warn", "Discard edits (reload)");
    revert.addEventListener("click", () => {
      clearDevContent();
      location.reload();
    });
    this.body.appendChild(revert);
    this.body.appendChild(el("div", "devHint",
      "Discard drops the browser copy and reloads with the world.json baked into the build."));
  }
}
