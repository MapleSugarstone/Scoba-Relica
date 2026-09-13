// What a box that holds move script needs from the keyboard.

/** One level of indentation, the same the shipped script files use. */
export const INDENT = "  ";

/**
 * Replaces a run of a box's text the way typing would, so the browser's own
 * undo still takes it back and the box hears about it as input.
 */
export function typeOver(field: HTMLTextAreaElement, from: number, to: number, text: string): void {
  field.setSelectionRange(from, to);
  const typed = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
  if (typed) return;
  field.setRangeText(text, from, to, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Makes Tab indent inside a box rather than leave it. Tab puts two spaces at
 * the caret, Shift+Tab takes one level off the line, and either one works on
 * every line a selection touches. Escape hands the next Tab back to the page,
 * so the keyboard can always get out of the box.
 */
export function indentWithTab(field: HTMLTextAreaElement): void {
  let released = false;
  field.addEventListener("blur", () => { released = false; });
  field.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      released = true;
      return;
    }
    if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey) {
      if (e.key !== "Shift") released = false;
      return;
    }
    if (released) {
      released = false;
      return;
    }
    e.preventDefault();
    const { value, selectionStart: start, selectionEnd: end } = field;
    const selected = value.slice(start, end);
    if (!e.shiftKey && !selected.includes("\n")) {
      typeOver(field, start, end, INDENT);
      return;
    }
    // Every whole line the selection touches. A selection that ends at the
    // very start of a line has not reached into that line.
    const first = value.lastIndexOf("\n", start - 1) + 1;
    const lastReached = end > start && value[end - 1] === "\n" ? end - 1 : end;
    const next = value.indexOf("\n", lastReached);
    const stop = next < 0 ? value.length : next;
    const lines = value.slice(first, stop).split("\n");
    const outdent = (line: string): string =>
      line.startsWith("\t") ? line.slice(1) : line.startsWith(INDENT) ? line.slice(INDENT.length) : line.replace(/^ /, "");
    const changed = lines.map((line) => (e.shiftKey ? outdent(line) : `${INDENT}${line}`)).join("\n");
    if (changed === lines.join("\n")) return;
    typeOver(field, first, stop, changed);
    if (selected.includes("\n")) {
      field.setSelectionRange(first, first + changed.length);
    } else {
      const moved = (lines[0] ?? "").length - (changed.split("\n")[0] ?? "").length;
      const caret = Math.max(first, start - moved);
      field.setSelectionRange(caret, caret);
    }
  });
}
