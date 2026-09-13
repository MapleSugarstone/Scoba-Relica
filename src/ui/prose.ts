// Written text put on the screen, with its numbers behind hover windows.
//
// `sim/prose.ts` decides what a token stands for and what hovering it should
// say. This puts that on the page: plain runs as text, tokens as a highlighted
// word carrying a window of its own. The window is the same one a status sigil
// opens, so the game has one kind of hover and not two.
import { parseProse, type Part, type ProseFor } from "../sim/prose";
import { frameRect, uiZoom } from "../engine/renderer";

/** Shifts a hover window sideways until it clears both edges of the frame. */
function nudge(tip: HTMLElement): void {
  tip.style.setProperty("--nudge", "0px");
  const box = tip.getBoundingClientRect();
  const edge = frameRect();
  const pad = 4;
  const over = box.right > edge.right - pad
    ? edge.right - pad - box.right
    : box.left < edge.left + pad ? edge.left + pad - box.left : 0;
  if (over !== 0) tip.style.setProperty("--nudge", `${Math.round(over / uiZoom())}px`);
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
  tip.textContent = part.detail;
  span.appendChild(tip);
  span.addEventListener("pointerenter", () => nudge(tip));
  span.addEventListener("focus", () => nudge(tip));
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
