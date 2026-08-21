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

/** The default gene line: every stat starts at 5 and grows +1 per level. */
export const BASE_GENES: Stats = stats(5, 5, 5, 5, 5, 5);
