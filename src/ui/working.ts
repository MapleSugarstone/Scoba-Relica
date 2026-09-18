// The arithmetic behind a number, as rows under the line that states it.
//
// One builder for every window that shows working: the one over a mark's sigil
// and the one over a number in a written line. They were the same rows built
// twice, and drifted, so a number was coloured in one and plain in the other.
import type { WorkLine } from "../sim/prose";
import { TYPE_COLORS } from "../sim/types";

/**
 * The rows, or null where there is no working to show. The caller decides
 * where they go and whether they are folded away until asked for.
 */
export function workRows(lines: WorkLine[]): HTMLElement | null {
  if (lines.length === 0) return null;
  const box = document.createElement("span");
  box.className = "pwork";
  for (const line of lines) {
    const row = document.createElement("span");
    // A row with nothing in its right column is a sentence rather than a
    // figure, and is given the whole width to wrap into.
    row.className = `wrow${line.value === "" ? " wnote" : ""}${line.tone ? ` ${line.tone}` : ""}`;
    const label = document.createElement("span");
    label.className = "wlabel";
    label.append(line.label);
    const value = document.createElement("span");
    value.className = `wval${line.element ? " welem" : ""}${line.dmg ? ` dmg ${line.dmg}` : ""}`;
    if (line.element) value.style.setProperty("--type-fill", TYPE_COLORS[line.element]);
    value.append(line.value);
    row.append(label, value);
    box.appendChild(row);
  }
  return box;
}
