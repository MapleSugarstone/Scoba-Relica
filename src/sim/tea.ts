// Teeleevs, cups, and what a Scoba is holding.
//
// A tea is one stat on a Scoba, worth `TEA_AT_CEILING` of it, and a Scoba
// holds `TEAS_MAX` of them. The leaves are how the player gets there: a fight
// hands over a leaf or three, each one for a stat and ranked 1 to 3, and three
// points of one stat's leaves brew one cup. Rank is the point value, so a rank
// 3 leaf is a cup on its own and a rank 2 wants a rank 1 beside it.
import type { Rng } from "./rng";
import { TEAS_MAX } from "./scoba";
import { STAT_LABELS, STAT_NAMES, type StatName } from "./types";

/** What one cup takes, counted in leaf ranks. */
export const CUP_POINTS = 3;

/** The ranks a leaf can turn up at, and how often each one does. */
export const LEAF_ODDS: { rank: number; chance: number }[] = [
  { rank: 1, chance: 0.5 },
  { rank: 2, chance: 0.35 },
  { rank: 3, chance: 0.15 },
];

/** The most leaves one fight hands over, and the fewest. */
export const DROP_MIN = 1;
export const DROP_MAX = 3;

/** One kind of leaf: the stat it brews for, and what it is worth towards a cup. */
export interface Leaf {
  stat: StatName;
  rank: number;
}

/** The bag key one kind of leaf is counted under. */
export function leafId(stat: StatName, rank: number): string {
  return `leaf-${stat}-${rank}`;
}

/** The leaf a bag key names, or null where it names something else. */
export function readLeaf(id: string): Leaf | null {
  const parts = id.split("-");
  if (parts.length !== 3 || parts[0] !== "leaf") return null;
  const stat = STAT_NAMES.find((name) => name === parts[1]);
  const rank = Number(parts[2]);
  if (!stat || !LEAF_ODDS.some((o) => o.rank === rank)) return null;
  return { stat, rank };
}

/** What a leaf is called where a player reads it. */
export function leafName(leaf: Leaf): string {
  return `${STAT_LABELS[leaf.stat]} Teeleev ${"I".repeat(leaf.rank)}`;
}

/** Every kind of leaf, in the order a list should show them. */
export function everyLeaf(): Leaf[] {
  return STAT_NAMES.flatMap((stat) => LEAF_ODDS.map((o) => ({ stat, rank: o.rank })));
}

/** What a fight hands over: a leaf or three, each for a stat and a rank of its own. */
export function rollLeaves(rng: Rng): Leaf[] {
  const many = DROP_MIN + Math.floor(rng() * (DROP_MAX - DROP_MIN + 1));
  const out: Leaf[] = [];
  for (let i = 0; i < many; i++) {
    const stat = STAT_NAMES[Math.floor(rng() * STAT_NAMES.length)] ?? "str";
    out.push({ stat, rank: rollRank(rng) });
  }
  return out;
}

function rollRank(rng: Rng): number {
  let roll = rng();
  for (const { rank, chance } of LEAF_ODDS) {
    if (roll < chance) return rank;
    roll -= chance;
  }
  return LEAF_ODDS[0]?.rank ?? 1;
}

/** A cup being filled: what it brews for, and the leaves in it so far. */
export interface Cup {
  stat: StatName | null;
  leaves: Leaf[];
}

export function emptyCups(): Cup[] {
  return Array.from({ length: TEAS_MAX }, () => ({ stat: null, leaves: [] }));
}

/** What a cup holds towards the three points it takes. */
export function cupPoints(cup: Cup): number {
  return cup.leaves.reduce((sum, leaf) => sum + leaf.rank, 0);
}

export function cupFull(cup: Cup): boolean {
  return cupPoints(cup) >= CUP_POINTS;
}

/** Whether this leaf would go in this cup: same stat, and room for its rank. */
export function fitsCup(cup: Cup, leaf: Leaf): boolean {
  if (cup.stat !== null && cup.stat !== leaf.stat) return false;
  return cupPoints(cup) + leaf.rank <= CUP_POINTS;
}

/** The first cup this leaf would go in, or -1 where none of them takes it. */
export function cupFor(cups: Cup[], leaf: Leaf): number {
  // A cup already brewing this stat before an empty one, so leaves gather
  // rather than opening a cup each.
  const started = cups.findIndex((cup) => cup.stat === leaf.stat && fitsCup(cup, leaf));
  if (started >= 0) return started;
  return cups.findIndex((cup) => cup.stat === null && fitsCup(cup, leaf));
}

/** The leaves in the bag, counted by kind, most useful first. */
export function leavesOnHand(bag: Record<string, number>): { leaf: Leaf; count: number }[] {
  return everyLeaf()
    .map((leaf) => ({ leaf, count: bag[leafId(leaf.stat, leaf.rank)] ?? 0 }))
    .filter((held) => held.count > 0);
}

/** What serving these cups leaves the Scoba holding. Only full cups are served. */
export function servedTeas(cups: Cup[]): StatName[] {
  return cups.filter((cup) => cupFull(cup) && cup.stat !== null).map((cup) => cup.stat!);
}
