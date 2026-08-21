import { loadArt, type Art } from "./engine/assets";
import { Renderer, holdUiScale } from "./engine/renderer";
import { startLoop } from "./engine/loop";
import { Input } from "./engine/input";
import { Overworld } from "./game/overworld";
import {
  UI, titleScreen, newGameFlow, connectScreen, indexScreen, questScreen,
  relicaScreen, settingsScreen,
} from "./ui/screens";
import { battleStage, openTrainerBattle, openWildBattle, type ActiveBattle } from "./ui/battle";
import { openBreeding } from "./ui/breeding";
import { openBox, openParty } from "./ui/roster";
import { openBounceGame } from "./ui/minigame";
import { SPECIAL, SPECIES } from "./sim/species";
import { advanceCare, play } from "./sim/care";
import { makeWild } from "./sim/scoba";
import { rngFrom } from "./sim/rng";
import { loadDevContent, normalizeContent, saveDevContent, type WorldContent } from "./game/content";
import bundledContent from "./game/content/world.json";
import type { DevEditor } from "./dev/editor";
import { registerServiceWorker, requestDurableStorage } from "./pwa";
import {
  clearStampedGrowth,
  loadSave,
  writeSave,
  flushAutosave,
  exportSave,
  importSave,
  type SaveData,
} from "./save/save";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const input = new Input();
const ui = new UI();

// A dev copy in localStorage (the editor's working state) wins over the
// content baked into the build, so edits survive reloads until exported.
const content: WorldContent = loadDevContent() ?? normalizeContent(bundledContent);
const devEnabled = import.meta.env.DEV || new URLSearchParams(location.search).has("dev");

let scene: Overworld | null = null;
let currentSave: SaveData | null = null;
let editor: DevEditor | null = null;
let art: Art;

function showTitle(): void {
  editor?.close();
  scene = null;
  currentSave = null;
  ui.hud(false);
  const existing = loadSave();
  titleScreen(ui, {
    hasSave: existing !== null,
    onContinue: () => {
      const s = loadSave();
      if (s) startGame(s);
    },
    onNew: () => newGameFlow(ui, art, startGame),
    onImport: async () => {
      const s = await importSave();
      if (s) {
        writeSave(s);
        startGame(s);
      } else {
        ui.toast("Import failed. Pick a Scoba Relica save file.");
      }
    },
  });
}

function startGame(save: SaveData): void {
  void ui.transition(() => buildGame(save));
}

/** Everything that swaps the title out for a running world. */
function buildGame(save: SaveData): void {
  editor?.close();
  currentSave = save;
  writeSave(save);
  ui.closeScreen();
  ui.hud(true);
  // A co-op battle stands in the world while it runs, so the other player can
  // walk over and join it. Solo battles hand back nothing to stand there.
  const stand = (at: { x: number; y: number }, battle: ActiveBattle | null): void => {
    if (!battle) return;
    scene?.openActiveBattle({ x: at.x, y: at.y, guest: battle.guest, join: battle.join });
  };

  scene = new Overworld(art, save, content, input, ui, {
    onWildBattle: (wild, at) => {
      ui.toast(`A wild ${SPECIES[wild.speciesId]?.name ?? wild.speciesId} charges at you!`);
      // Running into one is what puts it in the index.
      if (!save.seen) save.seen = [];
      if (!save.seen.includes(wild.speciesId)) {
        save.seen.push(wild.speciesId);
        writeSave(save);
      }
      void ui.transition(() => {
        stand(at, openWildBattle(ui, art, save, wild, (res) => {
          scene?.closeActiveBattle();
          scene?.encounterGrace();
          scene?.refreshCompanions();
          // Catching one clears the encounter as surely as beating it does.
          if (res.outcome === "win" || res.outcome === "caught") {
            scene?.creditSentinels("wild", at);
          }
        }));
      });
    },
    onOpenNest: () => openBreeding(ui, art!, save, () => scene?.refreshCompanions()),
    onTrainerBattle: (npc, result) => {
      const trainer = npc.trainer;
      if (!trainer) return;
      const rng = rngFrom(`${save.worldSeed}:trainer:${npc.id}:${Date.now().toString(36)}`);
      const enemies = trainer.team
        .filter((m) => SPECIES[m.species])
        .map((m) => makeWild(m.species, m.level, rng));
      if (enemies.length === 0) return;
      void ui.transition(() => {
        stand({ x: npc.x, y: npc.y }, openTrainerBattle(ui, art, save, { name: npc.name, enemies, reward: trainer.reward }, (res) => {
          scene?.closeActiveBattle();
          scene?.encounterGrace();
          scene?.refreshCompanions();
          result(res.outcome === "win");
        }));
      });
    },
  });
  hangBagDoors();
  ui.toast(devEnabled
    ? "Autosave is on. F2 opens the map editor, F4 starts the map over."
    : "Autosave is on.");
}

/** Dev: shut every sentinel on this map, stand its trainers back up, respawn. */
function resetMapState(): void {
  const done = scene?.resetMapState();
  if (!done) {
    ui.toast("No map to start over.");
    return;
  }
  ui.toast(`Map reset: ${done.sentinels} sentinels shut, ${done.trainers} trainers back up.`);
}

async function toggleEditor(): Promise<void> {
  if (!scene || !currentSave || ui.locked) return;
  if (!editor) {
    const mod = await import("./dev/editor");
    editor = new mod.DevEditor(ui, renderer, content);
  }
  if (editor.active) editor.close();
  else editor.open(scene, currentSave);
}

/**
 * The Box and Party screens, which both edit the roster and both come back to
 * the menu. Anything they change is written straight out and the overworld
 * rebuilds its companions, since the party is who walks behind you.
 */
function openRoster(
  open: (ui: UI, art: Art, save: SaveData, hooks: { onBack: () => void; onChange: () => void }) => void,
  save: SaveData,
): void {
  if (!art) return;
  open(ui, art, save, {
    // Back goes to the world, not to a menu: the bag is always a tap away.
    onBack: () => ui.closeScreen(),
    onChange: () => {
      writeSave(save);
      scene?.refreshCompanions();
    },
  });
}

/**
 * The doors the bag folds out. Everything the old Menu screen held is behind
 * one of them now: quests and the special's care each got their own, and the
 * party summary lives on the party screen it was a preview of.
 */
function hangBagDoors(): void {
  const back = (): void => ui.closeScreen();
  const withSave = (fn: (save: SaveData) => void) => (): void => {
    if (currentSave) fn(currentSave);
  };
  ui.setBagDoors([
    { label: "PARTY", open: withSave((save) => openRoster(openParty, save)) },
    { label: "BOX", open: withSave((save) => openRoster(openBox, save)) },
    { label: "INDEX", open: withSave((save) => { if (art) indexScreen(ui, art, save, back); }) },
    { label: "QUESTS", open: withSave((save) => questScreen(ui, save, content, back)) },
    { label: "RELICA", open: withSave((save) => relicaScreen(ui, save, {
      onBack: back,
      onCareChange: () => writeSave(save),
      onPlay: () => openBounceGame(ui, (score) => {
        save.special = play(advanceCare(save.special, Date.now()), score);
        writeSave(save);
        ui.toast(score > 0
          ? `${SPECIAL.name} had fun. +${Math.round(Math.min(100, score) * 0.4)} mood.`
          : `${SPECIAL.name} shrugs.`);
      }),
    })) },
    { label: "CONNECT", open: withSave((save) => connectScreen(ui, save, {
      onBack: back,
      onChange: () => writeSave(save),
    })) },
    { label: "SAVE", open: withSave((save) => {
      flushAutosave();
      writeSave(save);
      exportSave(save);
      ui.toast("Saved, and a copy exported.");
    }) },
    { label: "SETTINGS", open: withSave((save) => settingsScreen(ui, save, {
      onBack: back,
      onEzChange: () => {
        writeSave(save);
        ui.toast(save.ez
          ? "EZ Mode on. Your Scobas take the next battle with a leg-up."
          : "EZ Mode off.");
      },
      onExport: () => {
        flushAutosave();
        writeSave(save);
        exportSave(save);
        ui.toast("Save exported.");
      },
      onQuit: () => {
        flushAutosave();
        writeSave(save);
        showTitle();
      },
    })) },
  ]);
}

window.addEventListener("keydown", (e) => {
  if (ui.transitioning) return;
  if (e.key === "F2" && devEnabled) {
    e.preventDefault();
    void toggleEditor();
    return;
  }
  if (e.key === "F4" && devEnabled) {
    e.preventDefault();
    resetMapState();
    return;
  }
  if (e.key !== "Escape") return;
  if (editor?.active) {
    editor.close();
    return;
  }
  if (ui.locked) return;
  if (ui.screenOpen() && scene) ui.closeScreen();
  else if (ui.bagOpen()) ui.closeBag();
  else if (scene) ui.openBag();
});

function updateFrame(dt: number): void {
  // Frozen while the black is solid, so nothing plays out unseen. It starts
  // again as the cover begins to clear, not after.
  if (ui.covered) return;
  if (editor?.active) {
    editor.update(dt);
    return;
  }
  // A running battle owns the frame: the overworld is behind it and paused.
  const stage = battleStage();
  if (stage) {
    stage.update(dt);
    return;
  }
  if (!ui.screenOpen()) scene?.update(dt);
}

function renderFrame(): void {
  renderer.ensureSize();
  const stage = battleStage();
  if (stage) {
    stage.draw(renderer);
    renderer.present();
    return;
  }
  if (scene) {
    scene.draw(renderer);
    renderer.present();
  } else {
    renderer.ctx.fillStyle = "#2a3049";
    renderer.ctx.fillRect(0, 0, renderer.width, renderer.height);
    renderer.present();
  }
}

/**
 * Zooming the browser must not resize the game: the art is drawn to a pixel
 * grid, and the interface is held to the same one so a three pixel line stays
 * three pixels wherever it is drawn.
 */
function pinPixelGrid(): void {
  holdUiScale();
  window.addEventListener("resize", holdUiScale);
  window.visualViewport?.addEventListener("resize", holdUiScale);
  // Zooming does not always resize the window, but it always changes what a
  // CSS pixel is worth, so the density itself is what is watched. The query
  // has to be rebuilt each time, since it only ever matches one density.
  const watch = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const q = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = (): void => {
      q.removeEventListener("change", onChange);
      holdUiScale();
      watch();
    };
    q.addEventListener("change", onChange);
  };
  watch();
}

async function boot(): Promise<void> {
  pinPixelGrid();
  // Neither blocks the first frame: the worker only matters from the next
  // launch, and the storage grant only matters by the first autosave.
  void registerServiceWorker();
  void requestDurableStorage();
  // The page starts covered, so nothing shows until the art is actually in.
  art = await loadArt();
  showTitle();
  startLoop(updateFrame, renderFrame);
  void ui.reveal();
  // Headless/testing hook: step the simulation when rAF is paused.
  (window as unknown as { scobaDebug: object }).scobaDebug = {
    step(frames = 1, dt = 1 / 60): void {
      for (let i = 0; i < frames; i++) updateFrame(dt);
      renderFrame();
    },
    info(): object | undefined {
      return scene?.debugInfo();
    },
    warp(x: number, y: number): void {
      scene?.debugWarp(x, y);
    },
    warpPlayer(x: number, y: number): void {
      scene?.debugWarpPlayer(x, y);
    },
    /** Stands in for the relay: flips the save into two-player mode. */
    setPartnerJoined(on = true): void {
      if (currentSave) currentSave.partnerJoined = on;
    },
    blockedAt(x: number, y: number): boolean {
      return scene?.debugBlocked(x, y) ?? true;
    },
    /** Stands the partner somewhere, so a bad placement can be reproduced. */
    placePartner(x: number, y: number): void {
      scene?.debugPlacePartner(x, y);
    },
    /** Where everyone is standing on the battle scene, and what it is doing. */
    stage(): object | null {
      const st = battleStage();
      if (!st) return null;
      return st.debugInfo();
    },
    /** Stands in for the peer walking to the battle and interacting. */
    joinBattle(): boolean {
      return scene?.debugJoinBattle() ?? false;
    },
    /**
     * Walks straight into a wild fight, so a species can be looked at without
     * pacing an encounter zone until one turns up.
     */
    fight(speciesId: string, level = 4): boolean {
      if (!currentSave || !scene || !SPECIES[speciesId]) return false;
      const wild = makeWild(speciesId, level, rngFrom(`debug:${speciesId}:${Date.now().toString(36)}`));
      void ui.transition(() => {
        openWildBattle(ui, art, currentSave!, wild, () => {
          scene?.encounterGrace();
          scene?.refreshCompanions();
        });
      });
      return true;
    },
    /** Stands in for a won fight, so a sentinel can be tested without one. */
    creditWin(cond: "wild" | "trainer", x: number, y: number, npcId?: string): void {
      scene?.creditSentinels(cond, { x, y }, npcId);
    },
    /** The live save, for setting up a state worth testing from. */
    save: (): SaveData | null => currentSave,
  };
  // Dev/content hook: read and write the authored world from the console.
  (window as unknown as { scobaDev: object }).scobaDev = {
    content: (): WorldContent => content,
    exportString: (): string => JSON.stringify(content, null, 2),
    importString(json: string): void {
      Object.assign(content, normalizeContent(JSON.parse(json)));
      saveDevContent(content);
      scene?.devReload();
    },
    toggle: (): Promise<void> => toggleEditor(),
    resetMap: (): void => resetMapState(),
  };
}

void boot();
