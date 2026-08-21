// The type badges. They are drawn art like everything else, 41x17 with their
// own outline, read straight out of `assets/Types` by lower-cased file name.
// Anywhere a type is named, this is what says it.
//
// A type with no badge drawn yet falls back to its name in its colour, so a
// missing file reads as a gap in the art rather than a gap in the screen.
import type { Species } from "../sim/species";
import { typesOf } from "../sim/species";
import { TYPE_COLORS, TYPE_LABELS, type ElementType } from "../sim/types";

const FILES = import.meta.glob("../../assets/Types/*.png", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

const URLS = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [
    path.split("/").pop()!.replace(/\.png$/i, "").toLowerCase(),
    url,
  ]),
) as Partial<Record<ElementType, string>>;

/** One badge, at the size it was drawn. */
export function typeIcon(t: ElementType): HTMLElement {
  const url = URLS[t];
  if (!url) {
    const chip = document.createElement("span");
    chip.className = "tbadge";
    chip.textContent = TYPE_LABELS[t];
    chip.style.background = TYPE_COLORS[t];
    return chip;
  }
  const img = document.createElement("img");
  img.className = "tico";
  img.src = url;
  img.alt = TYPE_LABELS[t];
  img.title = TYPE_LABELS[t];
  return img;
}

/** Every type a species carries, in a row: two badges for a two-type Scoba. */
export function typeIcons(sp: Species): HTMLElement {
  const row = document.createElement("span");
  row.className = "ticos";
  for (const t of typesOf(sp)) row.appendChild(typeIcon(t));
  return row;
}
