// Written text put on the screen, with its numbers behind hover windows.
//
// `sim/prose.ts` decides what a token stands for and what hovering it should
// say. This puts that on the page: plain runs as text, tokens as a highlighted
// word carrying a window of its own. The window is the same one a status sigil
// opens, so the game has one kind of hover and not two.
import { parseProse, type Part, type ProseFor } from "../sim/prose";
import { uiZoom } from "../engine/renderer";
import { fitWindow } from "./fit";
import { workRows } from "./working";

/** What takes each window on the screen down if its word leaves the page. */
const watching = new WeakMap<HTMLElement, MutationObserver>();

/**
 * Puts a window on the screen rather than inside whatever is holding the word.
 *
 * A written line can sit in a list that scrolls, and a scroller clips on both
 * axes: a window opening above a word near the top of one was cut off. Moving
 * it to the screen for as long as it is open takes it out of every clipping box
 * on the way up, and it goes back where it belongs when it closes.
 */
function lift(span: HTMLElement, tip: HTMLElement): void {
  const host = span.closest(".screen");
  if (!host) {
    fitWindow(tip);
    return;
  }
  const word = span.getBoundingClientRect();
  const box = host.getBoundingClientRect();
  const zoom = uiZoom();
  host.appendChild(tip);
  tip.classList.add("loose");
  tip.style.left = `${(word.left + word.width / 2 - box.left) / zoom}px`;
  tip.style.bottom = `${(box.bottom - word.top + 4) / zoom}px`;
  fitWindow(tip);
  if (!watching.has(tip)) {
    // The line holding a word can be rewritten while its window is out, and a
    // window whose word has gone would otherwise stay up with nothing to close it.
    const watch = new MutationObserver(() => {
      if (span.isConnected) return;
      watch.disconnect();
      watching.delete(tip);
      tip.remove();
    });
    watch.observe(host, { childList: true, subtree: true });
    watching.set(tip, watch);
  }
}

/** Puts it back under its word, so the line owns it again. */
function drop(span: HTMLElement, tip: HTMLElement): void {
  watching.get(tip)?.disconnect();
  watching.delete(tip);
  if (!tip.classList.contains("loose")) return;
  tip.classList.remove("loose");
  tip.style.left = "";
  tip.style.bottom = "";
  span.appendChild(tip);
}

/** One highlighted word with what it stands for hanging off it. */
function tokenSpan(part: Part & { kind: "token" }): HTMLElement {
  const span = document.createElement("span");
  // A number being dealt takes the colour its kind of damage already has
  // everywhere else in the game, so blue is magic wherever it is read.
  span.className = part.tone ? `pnum dmg ${part.tone}` : "pnum";
  span.tabIndex = 0;
  span.append(part.label);
  const tip = document.createElement("span");
  tip.className = "ptip";
  tip.append(part.detail);
  // Where the number comes from and what happens to it on the way out, under
  // the sentence that says what it is.
  const work = workRows(part.work ?? []);
  if (work) tip.appendChild(work);
  span.appendChild(tip);
  // Open while the word is under the pointer or has been clicked, and on the
  // screen for all of that time. Put back under a word it was still open for,
  // it was drawn in whatever face the line around the word was set in.
  let hovered = false;
  span.addEventListener("pointerenter", () => {
    hovered = true;
    lift(span, tip);
  });
  span.addEventListener("focus", () => lift(span, tip));
  span.addEventListener("pointerleave", () => {
    hovered = false;
    if (document.activeElement !== span) drop(span, tip);
  });
  span.addEventListener("blur", () => {
    if (!hovered) drop(span, tip);
  });
  return span;
}

/** A written line as nodes, ready to put in a box. */
export function proseNodes(template: string, at: ProseFor): DocumentFragment {
  const out = document.createDocumentFragment();
  for (const part of parseProse(template, at)) {
    if (part.kind === "text") out.append(part.text);
    else out.appendChild(tokenSpan(part));
  }
  return out;
}

/** A written line in a box of its own. */
export function proseBox(template: string, at: ProseFor, cls?: string): HTMLElement {
  const box = document.createElement("div");
  if (cls) box.className = cls;
  box.appendChild(proseNodes(template, at));
  return box;
}
