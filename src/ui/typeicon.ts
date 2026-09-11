// The type badges. They are drawn art like everything else, 41x17 with their
// own outline, read straight out of `assets/Types` by lower-cased file name.
// Anywhere a type is named, this is what says it.
//
// A type with no badge drawn yet falls back to its name in its colour, so a
// missing file reads as a gap in the art rather than a gap in the screen.
import type { Species } from "../sim/species";
import { typesOf } from "../sim/species";
import { scobaTypes, type ScobaInstance } from "../sim/scoba";
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

/**
 * Every type a Scoba carries, in a row: two badges for a two-type one. Given a
 * Scoba it reads what that Scoba is, which for a bred one takes in the element
 * it inherited with its father's passive. Given a species it reads the line.
 */
export function typeIcons(of: Species | ScobaInstance): HTMLElement {
  const row = document.createElement("span");
  row.className = "ticos";
  const types = "speciesId" in of ? scobaTypes(of) : typesOf(of);
  for (const t of types) row.appendChild(typeIcon(t));
  return row;
}
