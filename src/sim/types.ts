export const TYPES = [
  "moon", "sun", "flux", "moss", "cipher", "mystic", "sugar", "fortuna", "plain",
] as const;

export type ElementType = (typeof TYPES)[number];

export type StatName = "hp" | "str" | "def" | "res" | "mag" | "spd";
export type Stats = Record<StatName, number>;

export const STAT_NAMES: StatName[] = ["hp", "str", "def", "res", "mag", "spd"];

export const STAT_LABELS: Record<StatName, string> = {
  hp: "HP",
  str: "Strength",
  def: "Defense",
  res: "Resistance",
  mag: "Magic",
  spd: "Speed",
};

export const TYPE_LABELS: Record<ElementType, string> = {
  moon: "Moon",
  sun: "Sun",
  flux: "Flux",
  moss: "Moss",
  cipher: "Cipher",
  mystic: "Mystic",
  sugar: "Sugar",
  fortuna: "Fortuna",
  plain: "Plain",
};

export const TYPE_COLORS: Record<ElementType, string> = {
  moon: "#7c9df0",
  sun: "#e7a03c",
  flux: "#9a8fb5",
  moss: "#7aa74a",
  cipher: "#4f8fba",
  mystic: "#8d63c0",
  sugar: "#e58ab8",
  fortuna: "#eae178",
  plain: "#b9b7a4",
};

// Rows are the attacking type, columns the defending type, both in TYPES order.
// Every type resists itself except Plain, which is neutral everywhere and is
// only ever hit hard by Fortuna.
const CHART: Record<ElementType, number[]> = {
  //         moon sun  flux moss ciph myst suga fort plai
  moon:    [ 0.5, 2,   1,   0.5, 1,   1,   1,   0.5, 1   ],
  sun:     [ 0.5, 0.5, 2,   2,   1,   0.5, 2,   1,   1   ],
  flux:    [ 1,   0.5, 0.5, 2,   2,   0.5, 0.5, 2,   1   ],
  moss:    [ 2,   0.5, 0.5, 0.5, 1,   2,   1,   1,   1   ],
  cipher:  [ 0.5, 1,   1,   1,   0.5, 2,   1,   2,   1   ],
  mystic:  [ 0.5, 2,   2,   1,   0.5, 0.5, 1,   1,   1   ],
  sugar:   [ 0.5, 1,   2,   1,   2,   1,   0.5, 0.5, 1   ],
  fortuna: [ 2,   1,   0.5, 1,   0.5, 0.5, 2,   0.5, 2   ],
  plain:   [ 1,   1,   1,   1,   1,   1,   1,   1,   1   ],
};

const INDEX: Record<string, number> = Object.fromEntries(TYPES.map((t, i) => [t, i]));

export function effectiveness(attack: ElementType, defend: ElementType): number {
  return CHART[attack]?.[INDEX[defend] ?? -1] ?? 1;
}

export function stats(hp: number, str: number, def: number, res: number, mag: number, spd: number): Stats {
  return { hp, str, def, res, mag, spd };
}

/** Points a standard line spends across the six stats, measured at level 30. */
export const STAT_BUDGET = 500;

/** What a baby line spends instead. A baby is its own line at this scale. */
export const BABY_BUDGET = 300;

/** How far a parent is scaled down when its line has no baby form to read. */
export const BABY_SCALE = BABY_BUDGET / STAT_BUDGET;

/** The most any one stat may hold, whatever the budget would allow. */
export const STAT_CAPS: Stats = stats(500, 300, 300, 300, 300, 200);

/**
 * The least each stat may be driven to, or null for one that can be driven
 * under nothing.
 *
 * Defense, Resistance and Speed go negative, where a negative reads as worse
 * than none at all: a negative defence takes more than an undefended hit
 * rather than the same, and negative Speed simply acts last. Strength and
 * Magic stop at nothing, since a hit scaled off a negative would heal what it
 * struck. HP stops at one, because a pool of nothing is a Scoba that cannot be
 * put on the field at all.
 */
export const STAT_FLOOR: Record<StatName, number | null> = {
  hp: 1, str: 0, def: null, res: null, mag: 0, spd: null,
};

/** What a line totals, for the check that it was built to budget. */
export function statTotal(line: Stats): number {
  return STAT_NAMES.reduce((sum, name) => sum + line[name], 0);
}

/** A line with every stat brought inside its cap. */
export function capStats(line: Stats): Stats {
  const out = {} as Stats;
  for (const name of STAT_NAMES) out[name] = Math.min(STAT_CAPS[name], Math.max(0, line[name]));
  return out;
}

/** The default base line: the standard budget spread evenly. */
export const BASE_GENES: Stats = stats(120, 76, 76, 76, 76, 76);
