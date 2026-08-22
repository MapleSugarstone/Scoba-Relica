import { loadArt, type Art } from "./engine/assets";
import { Renderer, holdUiScale } from "./engine/renderer";
import { startLoop } from "./engine/loop";
import { Input } from "./engine/input";
import { Overworld } from "./game/overworld";
import {
  UI, titleScreen, newGameFlow, connectScreen, indexScreen, questScreen,
  relicaScreen, settingsScreen,
} from "./ui/screens";
import { battleStage, netBattle, openTrainerBattle, openWildBattle, type ActiveBattle } from "./ui/battle";
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
import { Session } from "./net/session";
import type { BattleNet, PendingBattle } from "./net/battlelink";
import { relayUrl } from "./net/relay";
import { disableReminders, enableReminders, reminderState } from "./net/push";
import type { DiagnosticsControl, ReminderControl } from "./ui/screens";
import { collectDiagnostics, diagnosticsText } from "./net/diagnostics";
import {
  clearStampedGrowth,
  loadSave,
  partyOf,
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
let session: Session | null = null;
let relayStatus: { status: string; partnerHere: boolean } = { status: "offline", partnerHere: false };
/** A fight the peer has started that this player has not walked into yet. */
let pendingPeerBattle: PendingBattle | null = null;
/** The last message kind seen from the peer, for diagnosing a stuck co-op fight. */
let lastFromPeer: string[] = [];
/** How position updates are travelling, for the diagnostics readout. */
let positionCarrier = "none";
let art: Art;

function showTitle(): void {
  editor?.close();
  session?.stop();
  session = null;
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

/**
 * Dials the relay for a save that has a room code. A save without one plays
 * exactly as before: the session is the only thing that knows about the peer,
 * so nothing else has to care whether one is connected.
 */
/**
 * The link a fight is opened with, or null when nobody is on the other end.
 * `battleId` is minted by whoever starts the fight and is what every later
 * message about it is matched on.
 */
function battleNet(save: SaveData, battleId: string, isHost: boolean): BattleNet | null {
  if (!session?.connected || !save.partnerJoined) return null;
  return {
    battleId,
    localOwner: save.localSlot,
    isHost,
    send: (msg) => session?.send(msg),
  };
}

function freshBattleId(): string {
  return `bt${Date.now().toString(36)}${Math.floor(Math.random() * 4096).toString(36)}`;
}

function openSession(save: SaveData): void {
  session?.stop();
  session = new Session(save, {
    onSaveChanged: () => writeSave(save),
    liveBattle: () => netBattle(),
    onCarrier: (carrier) => { positionCarrier = carrier; },
    onTraffic: (kind) => {
      lastFromPeer.push(kind);
      if (lastFromPeer.length > 25) lastFromPeer.shift();
    },
    onBattleOpened: (battle) => {
      pendingPeerBattle = battle;
      // Stand the marker where they are fighting so this player can walk over.
      scene?.openActiveBattle({
        x: battle.at.x, y: battle.at.y,
        guest: () => save.localSlot,
        join: () => {
          session?.joinBattle(battle.battleId, save.localSlot, partyOf(save, save.localSlot));
          ui.toast("Asking to join...");
          return true;
        },
      });
    },
    onBattleClosed: (battleId) => {
      if (pendingPeerBattle?.battleId !== battleId) return;
      pendingPeerBattle = null;
      scene?.closeActiveBattle();
    },
    onBattleAdopted: (battleId, state) => {
      pendingPeerBattle = null;
      void ui.transition(() => {
        openWildBattle(ui, art, save, state.teams[1][0]!.scoba, (res) => {
          scene?.closeActiveBattle();
          scene?.encounterGrace();
          scene?.refreshCompanions();
          void res;
        }, { ...battleNet(save, battleId, false)!, adopted: state });
      });
    },
    onStatus: (status, partnerHere) => {
      relayStatus = { status, partnerHere };
      if (status === "live" && partnerHere) scene?.refreshCompanions();
    },
    onError: (reason) => {
      // Recorded as well as shown: a toast is gone in two seconds and these
      // are exactly what you want to read after the fact.
      lastFromPeer.push(`error: ${reason}`);
      ui.toast(`Relay: ${reason}`);
    },
  });
  session.start();
}

/**
 * Wiring for the Relica screen's reminders card. The relay is what actually
 * wakes a phone, so a room code is as much a prerequisite as permission is,
 * and the notes say which of the two is missing rather than failing quietly.
 */
/** The Settings readout. Everything it needs is async, so it reads on demand. */
function diagnosticsControl(save: SaveData): DiagnosticsControl {
  return {
    read: () => collectDiagnostics({
      status: relayStatus.status,
      partnerHere: relayStatus.partnerHere,
      carrier: positionCarrier,
      relayVersion: session?.relayVersion ?? 0,
      ...(save.room ? { room: save.room } : {}),
    }),
    asText: (lines) => diagnosticsText(lines as { label: string; value: string; ok: boolean }[]),
  };
}

function reminderControl(save: SaveData): ReminderControl {
  return {
    async read() {
      const state = await reminderState();
      if (state === "unavailable") {
        return { label: "Unavailable", note: "This browser cannot show reminders.", actionable: false };
      }
      if (state === "needs-install") {
        return {
          label: "Unavailable",
          note: "Add the game to your Home Screen first, then reminders can be turned on.",
          actionable: false,
        };
      }
      if (state === "blocked") {
        return {
          label: "Blocked",
          note: "Notifications are turned off for this site in your browser settings.",
          actionable: false,
        };
      }
      if (!save.room) {
        return {
          label: "Turn on",
          note: "Host or join a room under Connect first: reminders come from the shared Relica.",
          actionable: false,
        };
      }
      return state === "on"
        ? { label: "Turn off", note: `${SPECIAL.name} will tell you when it needs feeding, washing or playing with.`, actionable: true }
        : { label: "Turn on", note: `Be told when ${SPECIAL.name} needs something, even with the game closed.`, actionable: true };
    },
    async toggle() {
      const state = await reminderState();
      if (state === "on") {
        await disableReminders();
        session?.dropSubscription();
        return { note: "Reminders off." };
      }
      const result = await enableReminders();
      if (!result.ok) {
        return { note: result.state === "blocked"
          ? "Your browser refused. Allow notifications for this site to turn them on."
          : "Reminders were not turned on." };
      }
      session?.sendSubscription(result.sub);
      return { note: `${SPECIAL.name} will let you know when it needs something.` };
    },
  };
}

/** Everything that swaps the title out for a running world. */
function buildGame(save: SaveData): void {
  editor?.close();
  currentSave = save;
  writeSave(save);
  openSession(save);
  ui.closeScreen();
  ui.hud(true);
  // A co-op battle stands in the world while it runs, so the other player can
  // walk over and join it. Solo battles hand back nothing to stand there.
  const stand = (at: { x: number; y: number }, battle: ActiveBattle | null): void => {
    if (!battle) return;
    scene?.openActiveBattle({ x: at.x, y: at.y, guest: battle.guest, join: battle.join });
  };

  /**
   * Starting a fight tells the peer where it is, so their client can stand the
   * same marker and they can walk over. Only the id and the place travel: the
   * fight itself is handed over whole once they actually arrive.
   */
  const announce = (id: string, at: { x: number; y: number }): void => {
    if (session?.connected && save.partnerJoined) session.openBattle(id, save.localSlot, at);
  };

  scene = new Overworld(art, save, content, input, ui, {
    // The other player, when someone is playing them. Sampled every frame so
    // the partner is drawn where the interpolation says, not where the last
    // packet happened to land.
    peerAt: () => session?.peerAt(performance.now()) ?? null,
    // Both clients draw the Relica, so only one of them gets to decide where
    // it went. Character A decides and tells the other; playing alone, the one
    // client decides for itself.
    decidesCompanionship: () => session?.decidesCompanionship ?? true,
    shareCompanionship: (state) => {
      writeSave(save);
      session?.shareCompanionship(state);
    },
    reportSelf: (state) => session?.reportPosition(performance.now(), state),
    onWildBattle: (wild, at) => {
      ui.toast(`A wild ${SPECIES[wild.speciesId]?.name ?? wild.speciesId} charges at you!`);
      // Running into one is what puts it in the index.
      if (!save.seen) save.seen = [];
      if (!save.seen.includes(wild.speciesId)) {
        save.seen.push(wild.speciesId);
        writeSave(save);
      }
      void ui.transition(() => {
        const battleId = freshBattleId();
        announce(battleId, at);
        stand(at, openWildBattle(ui, art, save, wild, (res) => {
          scene?.closeActiveBattle();
          scene?.encounterGrace();
          scene?.refreshCompanions();
          // Catching one clears the encounter as surely as beating it does.
          if (res.outcome === "win" || res.outcome === "caught") {
            scene?.creditSentinels("wild", at);
          }
        }, battleNet(save, battleId, true)));
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
        const trainerBattleId = freshBattleId();
        announce(trainerBattleId, { x: npc.x, y: npc.y });
        stand({ x: npc.x, y: npc.y }, openTrainerBattle(ui, art, save, { name: npc.name, enemies, reward: trainer.reward }, (res) => {
          scene?.closeActiveBattle();
          scene?.encounterGrace();
          scene?.refreshCompanions();
          result(res.outcome === "win");
        }, battleNet(save, trainerBattleId, true)));
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
      reminders: reminderControl(save),
      onCareChange: () => {
        writeSave(save);
        session?.pushCare();
      },
      onPlay: () => openBounceGame(ui, (score) => {
        save.special = play(advanceCare(save.special, Date.now()), score);
        writeSave(save);
        session?.pushCare();
        ui.toast(score > 0
          ? `${SPECIAL.name} had fun. +${Math.round(Math.min(100, score) * 0.4)} mood.`
          : `${SPECIAL.name} shrugs.`);
      }),
    })) },
    { label: "CONNECT", open: withSave((save) => connectScreen(ui, save, {
      onBack: back,
      onChange: () => {
        writeSave(save);
        session?.start();
      },
      relay: () => relayStatus,
    })) },
    { label: "SAVE", open: withSave((save) => {
      flushAutosave();
      writeSave(save);
      exportSave(save);
      ui.toast("Saved, and a copy exported.");
    }) },
    { label: "SETTINGS", open: withSave((save) => settingsScreen(ui, save, {
      onBack: back,
      diagnostics: diagnosticsControl(save),
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
  // Read once at boot so a `?relay=` override is captured even on a launch
  // that never opens a room, which is how it gets set in the first place.
  relayUrl();
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
      const save = currentSave;
      const wild = makeWild(speciesId, level, rngFrom(`debug:${speciesId}:${Date.now().toString(36)}`));
      // Goes through the same announce and link as a real encounter, so a
      // co-op fight can be started from the console rather than by pacing a
      // meadow until one turns up.
      const battleId = freshBattleId();
      const where = scene.debugInfo() as { player?: { x: number; y: number } };
      const spot = { x: where.player?.x ?? 0, y: where.player?.y ?? 0 };
      if (session?.connected && save.partnerJoined) {
        session.openBattle(battleId, save.localSlot, spot);
      }
      void ui.transition(() => {
        const active = openWildBattle(ui, art, save, wild, () => {
          scene?.closeActiveBattle();
          scene?.encounterGrace();
          scene?.refreshCompanions();
        }, battleNet(save, battleId, true));
        if (active) {
          scene?.openActiveBattle({ x: spot.x, y: spot.y, guest: active.guest, join: active.join });
        }
      });
      return true;
    },
    /** Stands in for a won fight, so a sentinel can be tested without one. */
    creditWin(cond: "wild" | "trainer", x: number, y: number, npcId?: string): void {
      scene?.creditSentinels(cond, { x, y }, npcId);
    },
    /** The live save, for setting up a state worth testing from. */
    save: (): SaveData | null => currentSave,
    /** Relay and co-op battle state, for testing two clients against each other. */
    net: (): object => ({
      status: relayStatus,
      battleId: netBattle()?.battleId ?? null,
      battle: netBattle()?.debug() ?? null,
      pending: pendingPeerBattle,
      lastFromPeer,
      carrier: positionCarrier,
      relica: currentSave?.companionship ?? null,
    }),
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
