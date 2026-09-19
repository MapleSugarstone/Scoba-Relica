// The words the move script knows, each list held to the type it stands for.
//
// Adding a member to one of the unions without giving it a word here fails the
// type check or the content test, rather than leaving a value the script can
// hold but never write.
import type { CasterAnim, FieldScope, MoveVfx, ShowPath, StatusPolarity, StatusTrigger } from "../status";
import type { TargetMode } from "../targeting";
import { TYPES, type ElementType, type StatName } from "../types";

/** A table from a phrase to a value, with its own inverse for writing it back. */
export interface Vocab<T extends string> {
  read: Record<string, T>;
  write: Record<T, string>;
}

function vocab<T extends string>(pairs: readonly (readonly [string, T])[]): Vocab<T> {
  const read: Record<string, T> = {};
  const write = {} as Record<T, string>;
  for (const [phrase, value] of pairs) {
    read[phrase] = value;
    // The first phrase listed for a value is the one it is written back as.
    if (!(value in write)) write[value] = phrase;
  }
  return { read, write };
}

export const STAT_WORDS = vocab<StatName>([
  ["hp", "hp"], ["strength", "str"], ["defense", "def"],
  ["resistance", "res"], ["magic", "mag"], ["speed", "spd"],
]);

export const ELEMENT_WORDS = vocab<ElementType>(TYPES.map((t) => [t, t] as const));

export const ANIM_WORDS = vocab<CasterAnim>([
  ["shake", "shake"], ["lunge", "lunge"], ["blink", "blink"], ["rear", "rear"], ["focus", "focus"],
  ["dance", "dance"],
]);

export const PATH_WORDS = vocab<MoveVfx>([
  ["bolt", "bolt"], ["lob", "lob"], ["toss", "toss"], ["drop", "drop"],
  ["burst", "burst"], ["flames", "flames"], ["glow", "glow"], ["beam", "beam"],
]);

export const SHOW_WORDS = vocab<ShowPath>([
  ["wheel", "wheel"], ["glow", "glow"], ["burst", "burst"], ["ghost", "ghost"], ["flames", "flames"],
  ["clock", "clock"], ["liftoff", "liftoff"], ["landing", "landing"], ["rise", "rise"],
]);

export const AIM_WORDS = vocab<TargetMode>([
  ["self", "self"],
  ["any ally", "any-ally"],
  ["other ally", "other-ally"],
  ["any enemy", "any-enemy"],
  ["any scoba", "any-scoba"],
  ["fallen scoba", "fallen-scoba"],
  ["benched ally", "benched-ally"],
  ["benched enemy", "benched-enemy"],
  ["all allies", "ally-team"],
  ["all enemies", "enemy-team"],
  ["random ally", "random-ally"],
  ["random enemy", "random-enemy"],
  ["random scoba", "random-scoba"],
]);

export const POLARITY_WORDS = vocab<StatusPolarity>([["good", "good"], ["bad", "bad"]]);

export const FIELD_SCOPE_WORDS = vocab<FieldScope>([
  ["its side", "allies"], ["the enemy side", "enemies"], ["both sides", "both"],
]);

/** The triggers that take no number or element. */
type PlainTrigger = Exclude<StatusTrigger["on"], "passive" | "hit-element" | "hp-below" | "deal-element">;

export const TRIGGER_WORDS = vocab<PlainTrigger>([
  ["the battle starts", "battle-start"],
  ["a turn starts", "turn-start"],
  ["a turn ends", "turn-end"],
  ["it makes a basic attack", "basic-attack"],
  ["it casts", "use-ability"],
  ["it blocks", "block"],
  ["hit by magic", "hit-magic"],
  ["hit by physical", "hit-physical"],
  ["hit", "hit-any"],
  ["it lands magic", "deal-magic"],
  ["it lands physical", "deal-physical"],
  ["it lands a hit", "deal-any"],
  ["it lands a spell", "deal-spell"],
  ["it kills", "kill-attack"],
  ["it faints", "death"],
  ["it takes the field", "switch-in"],
  ["an ally faints", "ally-death"],
  ["an enemy faints", "enemy-death"],
  ["anyone faints", "any-death"],
]);

/**
 * Every member of each union. Each object has to name all of them and nothing
 * else, so the type checker keeps it in step with the union, and `missingWords`
 * keeps the word tables in step with these.
 */
const everyAnim: Record<CasterAnim, true> = {
  shake: true, lunge: true, blink: true, rear: true, focus: true, dance: true,
};
const everyPath: Record<MoveVfx, true> = {
  bolt: true, lob: true, toss: true, drop: true, burst: true, flames: true, glow: true, beam: true,
};
const everyShow: Record<ShowPath, true> = {
  wheel: true, glow: true, burst: true, ghost: true, flames: true, clock: true, liftoff: true, landing: true,
  rise: true,
};
const everyStat: Record<StatName, true> = { hp: true, str: true, def: true, res: true, mag: true, spd: true };
const everyMode: Record<TargetMode, true> = {
  "self": true, "any-ally": true, "other-ally": true, "any-enemy": true, "any-scoba": true,
  "fallen-scoba": true, "benched-ally": true, "benched-enemy": true, "ally-team": true, "enemy-team": true,
  "random-ally": true, "random-enemy": true, "random-scoba": true,
};
const everyTrigger: Record<PlainTrigger, true> = {
  "battle-start": true, "turn-start": true, "turn-end": true, "basic-attack": true,
  "use-ability": true, block: true, "hit-magic": true, "hit-physical": true, "hit-any": true,
  "deal-magic": true, "deal-physical": true, "deal-any": true, "deal-spell": true,
  "kill-attack": true, death: true, "switch-in": true, "ally-death": true, "enemy-death": true,
  "any-death": true,
};

/** Checked when the module loads, so a word missing for a member fails every test at once. */
export function missingWords(): string[] {
  const out: string[] = [];
  const need = <T extends string>(all: Record<T, true>, words: Vocab<T>, what: string): void => {
    for (const member of Object.keys(all) as T[]) {
      if (!(member in words.write)) out.push(`${what} ${member}`);
    }
  };
  need(everyAnim, ANIM_WORDS, "animation");
  need(everyPath, PATH_WORDS, "path");
  need(everyShow, SHOW_WORDS, "show");
  need(everyStat, STAT_WORDS, "stat");
  need(everyMode, AIM_WORDS, "aim");
  need(everyTrigger, TRIGGER_WORDS, "trigger");
  return out;
}

/** How far apart two words are, for guessing what a mistyped one meant. */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const here = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = here;
    }
  }
  return row[b.length]!;
}

/** The closest of some choices to what was written, if any is close enough to be a typo. */
export function nearest(written: string, choices: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of choices) {
    const d = distance(written.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  // A short word has to be close to count as a typo. A longer one can drift
  // further, the way "enemy" is still plainly "enemies".
  const allowed = written.length <= 3 ? 1 : Math.max(2, Math.ceil(written.length / 2));
  return best !== null && bestD <= allowed ? best : null;
}
