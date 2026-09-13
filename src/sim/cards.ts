// The deck Card Throw deals from.
//
// One entry per drawing in `assets/Powers`, so what the sim adds to a hand and
// what the stage throws across the field are the same card. There is no ten:
// the court cards carry that value between them, which is how a deck of twelve
// drawings covers one to ten.

export interface Card {
  /** Its drawing, by file name in `assets/Powers`, lower-cased like the rest. */
  art: string;
  /** What it adds to a hand. */
  value: number;
  label: string;
}

export const DECK: readonly Card[] = [
  { art: "cardace", value: 1, label: "Ace" },
  { art: "cardtwo", value: 2, label: "Two" },
  { art: "cardthree", value: 3, label: "Three" },
  { art: "cardfour", value: 4, label: "Four" },
  { art: "cardfive", value: 5, label: "Five" },
  { art: "cardsix", value: 6, label: "Six" },
  { art: "cardseven", value: 7, label: "Seven" },
  { art: "cardeight", value: 8, label: "Eight" },
  { art: "cardnine", value: 9, label: "Nine" },
  { art: "cardjack", value: 10, label: "Jack" },
  { art: "cardqueen", value: 10, label: "Queen" },
  { art: "cardking", value: 10, label: "King" },
];

/** One color on a card's drawing replaced by another. */
export interface ColorChange {
  from: string;
  to: string;
}

/**
 * How one dealt card looks: its drawing, and whichever of its colors the draw
 * changed. Held on the hand once it lands, so the card over a Scoba's head is
 * the same card that was thrown at it.
 */
export interface CardFace {
  art: string;
  changes: ColorChange[];
}

/** The back of a card, for a hand shown without naming what is in it. */
export const CARD_BACK = "cardblank";

/** The most one card can be worth. */
export const CARD_HIGH = Math.max(...DECK.map((c) => c.value));

/** The count a hand pays out on, and busts above. */
export const BLACKJACK = 21;

/** The card a roll of 0 to 1 turns up. */
export function cardFrom(roll: number): Card {
  return DECK[deckIndex(roll)]!;
}

/** The place in the deck a roll of 0 to 1 lands on, which decides the card's drawing and its value together. */
export function deckIndex(roll: number): number {
  return Math.min(DECK.length - 1, Math.max(0, Math.floor(roll * DECK.length)));
}

/** Which card a value was dealt from, for drawing a hand that was already counted. */
export function cardOfValue(value: number): Card {
  return DECK.find((c) => c.value === value) ?? DECK[DECK.length - 1]!;
}
