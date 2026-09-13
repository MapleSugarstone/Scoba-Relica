// What the game says about a thing, and what an author would rather it said.
//
// Everything here has an answer the game works out for itself: a passive from
// the effects its statuses carry, a move from what it does and what it costs, a
// line from the blurb its species was written with. Any of the three can be
// written over in the cosmetics editor, and the written line replaces the whole
// of the generated one.
//
// Nothing reads these back out again. They are prose shown to a player and
// nowhere else, so a written line can say anything without breaking something
// downstream.
import { describeAbility, describeMoveEffects } from "../sim/describe";
import { ABILITIES, type Move, type Species } from "../sim/species";
import { writtenText, type TextKind } from "./cosmetics";

/**
 * What a passive does: what an author wrote in the editor, then the line the
 * passive ships with, then the sentence the game builds itself.
 */
export function abilityText(id: string): string {
  return writtenText("ability", id) ?? ABILITIES[id]?.text ?? describeAbility(id);
}

/**
 * What a move does, without its cost line: what an author wrote in the editor,
 * then the line the move ships with, then the sentence the game builds itself.
 */
export function moveText(move: Move): string {
  return writtenText("move", move.id) ?? move.text ?? describeMoveEffects(move);
}

/** What a line is, for the index and the picker. */
export function speciesText(sp: Species): string {
  return writtenText("species", sp.id) ?? sp.blurb ?? "";
}

/** What the game would say on its own, for showing an author what they are replacing. */
export const generatedText = {
  ability: (id: string): string => ABILITIES[id]?.text ?? describeAbility(id),
  move: (move: Move): string => move.text ?? describeMoveEffects(move),
  species: (sp: Species): string => sp.blurb ?? "",
};

/**
 * Whether a line was written by hand, which is the only kind that can carry
 * tokens. The generated ones are already the long form and have nothing to
 * hide behind a hover.
 */
export function isWritten(kind: TextKind, id: string): boolean {
  return writtenText(kind, id) !== null;
}
