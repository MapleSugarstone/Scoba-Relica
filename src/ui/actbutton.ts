// The button a move is shown on, wherever a move is shown on one.
//
// A move wears its element as its fill and its elements as badges, and a move
// of two wears both. Written once here rather than at each screen, because a
// move board that is nearly the same as the fight's own board reads as a
// different kind of thing rather than as the same board somewhere else.
import { sfx } from "../engine/sfx";
import type { Move } from "../sim/species";
import { TARGET_LABELS } from "../sim/targeting";
import { TYPE_COLORS, type ElementType } from "../sim/types";
import { typeIcon } from "./typeicon";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export interface ActOpts {
  disabled?: boolean;
  alt?: boolean;
  small?: boolean;
  hot?: boolean;
  type?: ElementType;
  type2?: ElementType;
  /** One more badge beside the elements, for what a basic attack lands as. */
  badge?: ElementType;
}

/**
 * The line under a move's name: what it costs, how long it rests after, and
 * what it aims at. `waiting` is a rest still running, which only a fight has.
 * A `short` line is the cost and the wait alone, for a button with a row to
 * share.
 */
export function moveSub(move: Move, cost: number, opts: { waiting?: number; short?: boolean } = {}): string {
  const waiting = opts.waiting ?? 0;
  const wait = waiting > 0 ? ` · wait ${waiting}` : "";
  if (opts.short) return `${cost}% mana${wait}`;
  const rest = move.cooldown ? ` · cd${move.cooldown}` : "";
  const aim = move.targets.map((t) => TARGET_LABELS[t.mode]).join(" + ");
  return `${cost}% mana${rest}${wait}${aim ? ` · ${aim}` : ""}`;
}

/** One button: a name, a line under it, and the badges it wears at its end. */
export function actButton(
  label: string, sub: string, onPick: () => void, opts: ActOpts = {},
): HTMLButtonElement {
  const dual = opts.type !== undefined && opts.type2 !== undefined;
  // The badges a button wears, at its right end: a move's type or types,
  // or the type the basic attack lands as.
  const marks = [opts.type, opts.type2, opts.badge].filter((t): t is ElementType => t !== undefined);
  const b = el("button",
    `act${opts.alt ? " alt" : ""}${opts.small ? " small" : ""}${opts.hot ? " hot" : ""}` +
    `${opts.type ? " typed" : ""}${dual ? " dual" : ""}${marks.length > 0 ? " marked" : ""}`,
  ) as HTMLButtonElement;
  if (opts.type) b.style.setProperty("--type-fill", TYPE_COLORS[opts.type]);
  if (opts.type2) b.style.setProperty("--type-fill2", TYPE_COLORS[opts.type2]);
  const col = el("span", "tcol");
  col.appendChild(el("span", "tlabel", label));
  if (sub) col.appendChild(el("span", "sub", sub));
  b.appendChild(col);
  if (marks.length > 0) {
    const mark = el("span", "tmark");
    for (const t of marks) mark.appendChild(typeIcon(t));
    b.appendChild(mark);
  }
  b.disabled = opts.disabled === true;
  b.addEventListener("click", () => {
    if (b.disabled) return;
    sfx.tap();
    onPick();
  });
  return b;
}
