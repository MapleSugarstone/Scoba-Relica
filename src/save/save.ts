import type { ScobaInstance } from "../sim/scoba";
import { MAX_LEVEL, maxHp } from "../sim/scoba";
import { MOVES, RETIRED_SPECIES, SPECIES, speciesMoves } from "../sim/species";
import { BASE_GENES } from "../sim/types";
import type { CareState } from "../sim/care";
import type { Companionship } from "../sim/companionship";
import { DEFAULT_LOOK, type Look } from "../engine/recolor";

export type SlotId = "A" | "B";

export interface Pronouns {
  subject: string;
  object: string;
  possessive: string;
}

export interface CharacterDef {
  name: string;
  pronouns: Pronouns;
  look: Look;
  /** Species id of the Scoba this character chose at the start. */
  starter: string;
}

export interface SaveData {
  version: 12;
  createdAt: number;
  updatedAt: number;
  worldSeed: string;
  /** Which character the local player controls. */
  localSlot: SlotId;
  /** True once a second player has claimed the other slot. */
  partnerJoined: boolean;
  characters: Record<SlotId, CharacterDef>;
  party: ScobaInstance[];
  box: ScobaInstance[];
  bag: Record<string, number>;
  money: number;
  /** Spent on raising Scobas that never went into a fight. */
  aetus: number;
  story: { chapter: number; flags: Record<string, boolean> };
  /** Steps completed per quest id; missing means not started. */
  quests: Record<string, number>;
  pos: { map: string; x: number; y: number };
  /** Species ids run into in the wild, which is what fills the index. */
  seen?: string[];
  /** Room code the two players share. Set by Connect; no relay reads it yet. */
  room?: string;
  /**
   * Monotonic counter for the shared Relica and story flags, so the relay can
   * tell which of two clients changed them last. Optional: a save written
   * before there was a relay simply starts at zero.
   */
  careRev?: number;
  /**
   * Who the Relica is walking with, and how much time it owes the other one.
   * Optional: a save written before it could choose simply starts even.
   */
  companionship?: Companionship;
  /** EZ mode: the players' own Scobas gain far more from every level. */
  ez?: boolean;
  /** Qualifying wins counted so far, keyed "<mapId>:<cx>,<cy>" per sentinel. */
  sentinels: Record<string, number>;
  special: CareState;
}

export const SAVE_KEY = "scoba-skeeple-save-v1";

/** Scobas a character keeps on hand: the ones that walk with them and the
 * ones they can field or swap to in a battle. The rest go to the box. */
export const PARTY_PER_CHARACTER = 3;

export function partyOf(save: SaveData, owner: SlotId): ScobaInstance[] {
  return save.party
    .filter((s) => s.owner === owner && !SPECIES[s.speciesId]?.special)
    .slice(0, PARTY_PER_CHARACTER);
}

/** The Scobas a character keeps out of the party, in the order they were put by. */
export function boxOf(save: SaveData, owner: SlotId): ScobaInstance[] {
  return save.box.filter((s) => s.owner === owner && !SPECIES[s.speciesId]?.special);
}

/**
 * Moves one of a character's party members up or down their own order, which
 * is what decides who is fielded first and who walks where behind them.
 */
export function reorderParty(save: SaveData, owner: SlotId, uid: string, dir: -1 | 1): boolean {
  const mine = save.party.filter((s) => s.owner === owner);
  const at = mine.findIndex((s) => s.uid === uid);
  const swapWith = mine[at + dir];
  if (at < 0 || !swapWith) return false;
  const a = save.party.indexOf(mine[at]!);
  const b = save.party.indexOf(swapWith);
  [save.party[a], save.party[b]] = [save.party[b]!, save.party[a]!];
  return true;
}

/** Sends a party member to the box. A character never empties their party. */
export function sendToBox(save: SaveData, uid: string): boolean {
  const at = save.party.findIndex((s) => s.uid === uid);
  const scoba = save.party[at];
  if (!scoba) return false;
  if (partyOf(save, scoba.owner ?? save.localSlot).length <= 1) return false;
  save.party.splice(at, 1);
  save.box.push(scoba);
  return true;
}

/** Takes one out of the box, if its owner has a slot free. */
export function takeFromBox(save: SaveData, uid: string): boolean {
  const at = save.box.findIndex((s) => s.uid === uid);
  const scoba = save.box[at];
  if (!scoba) return false;
  const owner = scoba.owner ?? save.localSlot;
  if (!partyHasRoom(save, owner)) return false;
  save.box.splice(at, 1);
  scoba.owner = owner;
  save.party.push(scoba);
  return true;
}

export function partyHasRoom(save: SaveData, owner: SlotId): boolean {
  return partyOf(save, owner).length < PARTY_PER_CHARACTER;
}

/**
 * An earlier EZ mode wrote a growth rate onto the Scobas themselves. It is a
 * battle-long status now, so anything a save is still carrying is cleared and
 * whatever it inflated is pulled back under the ceiling.
 */
export function clearStampedGrowth(save: SaveData): void {
  for (const s of [...save.party, ...save.box]) {
    const legacy = s as ScobaInstance & { growth?: number };
    if (legacy.growth === undefined) continue;
    delete legacy.growth;
    s.hp = Math.min(s.hp, maxHp(s));
  }
}

/** Puts a newly caught or hatched Scoba wherever its owner has room. */
export function addToParty(save: SaveData, scoba: ScobaInstance, owner: SlotId): "party" | "box" {
  scoba.owner = owner;
  if (!partyHasRoom(save, owner)) {
    save.box.push(scoba);
    return "box";
  }
  save.party.push(scoba);
  return "party";
}

export const PRONOUN_PRESETS: Pronouns[] = [
  { subject: "she", object: "her", possessive: "her" },
  { subject: "he", object: "him", possessive: "his" },
  { subject: "they", object: "them", possessive: "their" },
];

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

function migrate(data: unknown): SaveData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Omit<SaveData, "version"> & { version: number };
  if (d.version === 1) {
    // v1 -> v2: combat rework. Stats became hp/str/def/res/mag/spd with genes
    // starting at 5; old moves were replaced wholesale, so refill from the
    // current learnsets. Snares were added for catching.
    for (const s of [...d.party, ...d.box]) {
      const sp = SPECIES[s.speciesId];
      s.genes = sp ? { ...sp.genes } : { ...BASE_GENES };
      s.moves = s.moves.filter((m) => MOVES[m]);
      if (sp) {
        // Top up emptied slots from the learnset, newest teachable first.
        for (const m of speciesMoves(sp)) {
          if (s.moves.length >= 4) break;
          if (!s.moves.includes(m)) s.moves.push(m);
        }
        if (s.moves.length === 0) s.moves = [sp.learnset[0]!.move];
      }
      if (sp && !sp.secondaryPool.includes(s.secondaryAbility)) {
        s.secondaryAbility = sp.secondaryPool[0]!;
      }
      s.hp = maxHp(s);
    }
    d.bag["snare"] = (d.bag["snare"] ?? 0) + 5;
    d.version = 2;
  }
  if (d.version === 2) {
    // v2 -> v3: the creator moved from palette indices to free colors and
    // layered parts, so old looks map onto their former swatch values.
    for (const c of Object.values(d.characters) as CharacterDef[]) {
      c.look = migrateLook(c.look as unknown as Record<string, unknown>);
    }
    d.version = 3;
  }
  if (d.version === 3) {
    // v3 -> v4: the four-element chart became nine primary types, and each
    // character now picks a starter Scoba.
    const renamed: Record<string, string> = {
      "fire-heart": "sun-heart",
      "water-heart": "flux-heart",
      "plant-heart": "moss-heart",
    };
    for (const s of [...d.party, ...d.box]) {
      s.secondaryAbility = renamed[s.secondaryAbility] ?? s.secondaryAbility;
      s.moves = s.moves.filter((m) => MOVES[m]);
      const sp = SPECIES[s.speciesId];
      if (sp) {
        for (const m of speciesMoves(sp)) {
          if (s.moves.length >= 4) break;
          if (!s.moves.includes(m)) s.moves.push(m);
        }
        if (!sp.secondaryPool.includes(s.secondaryAbility)) s.secondaryAbility = sp.secondaryPool[0]!;
      }
    }
    for (const slot of ["A", "B"] as SlotId[]) {
      const c = d.characters[slot];
      if (c && !c.starter) c.starter = DEFAULT_STARTERS[slot];
    }
    d.version = 4;
  }
  if (d.version === 4) {
    // v4 -> v5: party Scobas belong to one character or the other, and the
    // special Scoba left the party for good since it never battles.
    const other: SlotId = d.localSlot === "A" ? "B" : "A";
    d.party = d.party.filter((s) => !SPECIES[s.speciesId]?.special);
    d.box = d.box.filter((s) => !SPECIES[s.speciesId]?.special);
    let theirsTaken = false;
    for (const s of d.party) {
      if (s.owner) continue;
      if (!theirsTaken && s.speciesId === d.characters[other]?.starter) {
        s.owner = other;
        theirsTaken = true;
      } else {
        s.owner = d.localSlot;
      }
    }
    d.version = 5;
  }
  if (d.version === 5) {
    // v5 -> v6: the starters got their real names when the art landed.
    const renamed: Record<string, string> = {
      solka: "flarea", sproutle: "obera", runik: "clikkit",
      taffle: "pieble", clovie: "aulium", nibbin: "plib", skeeple: "relica",
    };
    for (const s of [...d.party, ...d.box]) {
      s.speciesId = renamed[s.speciesId] ?? s.speciesId;
    }
    for (const slot of ["A", "B"] as SlotId[]) {
      const c = d.characters[slot];
      if (c.starter) c.starter = renamed[c.starter] ?? c.starter;
    }
    d.version = 6;
  }
  if (d.version === 6) {
    // v6 -> v7: quest progress joined the save alongside story flags.
    d.quests = {};
    d.version = 7;
  }
  if (d.version === 7) {
    // v7 -> v8: moves stopped being learned by levelling. Every Scoba holds
    // its species' whole set, topped up around anything it inherited, and
    // ordered by cost because statuses address moves by position.
    for (const s of [...d.party, ...d.box]) {
      const sp = SPECIES[s.speciesId];
      if (!sp) continue;
      // The species' default set, then anything inherited put back on the
      // slot it was holding: the slot is what a status will address.
      const slots = speciesMoves(sp);
      if (slots.length === 0) continue;
      s.moves.forEach((m, i) => {
        if (!MOVES[m] || slots.includes(m)) return;
        slots[Math.min(i, slots.length - 1)] = m;
      });
      s.moves = slots;
    }
    d.version = 8;
  }
  if (d.version === 8) {
    // v8 -> v9: the stand-in species left with the placeholder art pack. Each
    // one becomes the drawn Scoba nearest it, and since the new lines have
    // gene spreads of their own rather than a flat five, the genes, moves and
    // ability are reset to what that species starts with.
    for (const s of [...d.party, ...d.box]) {
      const to = RETIRED_SPECIES[s.speciesId];
      if (!to) continue;
      const sp = SPECIES[to]!;
      s.speciesId = to;
      s.genes = { ...sp.genes };
      s.moves = speciesMoves(sp);
      if (!sp.secondaryPool.includes(s.secondaryAbility)) s.secondaryAbility = sp.secondaryPool[0]!;
      s.hp = maxHp(s);
    }
    d.version = 9;
  }
  if (d.version === 9) {
    // v9 -> v10: Aetus, and a level ceiling that everything already raised
    // comes down to.
    d.aetus = 0;
    for (const s of [...d.party, ...d.box]) {
      if (s.level <= MAX_LEVEL) continue;
      s.level = MAX_LEVEL;
      s.xp = 0;
      s.hp = maxHp(s);
    }
    d.version = 10;
  }
  if (d.version === 10) {
    // v10 -> v11: the three wild lines were given one ability holding both of
    // their passives. Each is two now, a primary and a secondary, so anything
    // holding a stand-in from the old pool is moved onto its real one.
    const signature: Record<string, { was: string[]; now: string }> = {
      catsquito: { was: ["swift", "brawn"], now: "restless" },
      meepa: { was: ["mystic", "warded"], now: "moonwell" },
      cactunny: { was: ["thick-coat", "moss-skin"], now: "sun-ward" },
    };
    for (const s of [...d.party, ...d.box]) {
      const fix = signature[s.speciesId];
      // Anything else it holds was bred in on purpose and is left alone.
      if (fix && fix.was.includes(s.secondaryAbility)) s.secondaryAbility = fix.now;
    }
    d.version = 11;
  }
  if (d.version === 11) {
    // v11 -> v12: the world grew more than one map, so a save has to say which
    // one it is on, and sentinels need somewhere to keep their tally.
    d.sentinels = {};
    d.pos = { ...d.pos, map: typeof d.pos?.map === "string" ? d.pos.map : "" };
    d.version = 12;
  }
  if (d.version !== 12) return null;
  const out = d as unknown as SaveData;
  if (!out.sentinels || typeof out.sentinels !== "object") out.sentinels = {};
  clearStampedGrowth(out);
  return out;
}

const DEFAULT_STARTERS: Record<SlotId, string> = { A: "cresce", B: "grima" };

const V2_SKIN = ["#f3d8c5", "#e8b5ac", "#c98a6c", "#9c6644", "#5e4130"];
const V2_HAIR = ["#eae178", "#e09a4e", "#b4553d", "#7a4a32", "#2e2a3a", "#c8cdd6", "#7aa74a", "#7c9df0", "#d977b8"];
const V2_OUTFIT = ["#f3f2c0", "#d9553f", "#e7a03c", "#7aa74a", "#4f8fba", "#8d63c0", "#e58ab8", "#3f4a66"];

function migrateLook(look: Record<string, unknown>): Look {
  const at = (table: string[], i: unknown, fallback: string): string =>
    typeof i === "number" && table[i] !== undefined ? table[i]! : fallback;
  return {
    ...DEFAULT_LOOK,
    skin: at(V2_SKIN, look["skin"], DEFAULT_LOOK.skin),
    hair: at(V2_HAIR, look["hair"], DEFAULT_LOOK.hair),
    shirt: at(V2_OUTFIT, look["outfit"], DEFAULT_LOOK.shirt),
  };
}

let pending: number | null = null;
let current: SaveData | null = null;

export function writeSave(data: SaveData): void {
  data.updatedAt = Date.now();
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}

/** Debounced autosave; also flushed on pagehide/visibility loss. */
export function autosave(data: SaveData): void {
  current = data;
  if (pending !== null) return;
  pending = window.setTimeout(() => {
    pending = null;
    if (current) writeSave(current);
  }, 2000);
}

export function flushAutosave(): void {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  if (current) writeSave(current);
}

// Guarded so the party helpers below can be imported by the vitest suites,
// which have no DOM.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushAutosave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAutosave();
  });
}

export function clearSave(): void {
  current = null;
  localStorage.removeItem(SAVE_KEY);
}

export function exportSave(data: SaveData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  a.href = url;
  a.download = `scoba-relica-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function importSave(): Promise<SaveData | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(migrate(JSON.parse(String(reader.result))));
        } catch {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
