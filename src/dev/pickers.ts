// A search box that lists what matches as you type and hands back the one you
// pick. Every list in the editor that reaches into a table is one of these:
// moves, passives, lines, and every record for opening one by name.
import { el } from "./dom";

export interface PickEntry {
  id: string;
  name: string;
  /** A line under the name: the type and cost of a move, what a passive does. */
  hint?: string;
}

export interface Picker {
  root: HTMLElement;
  focus(): void;
}

export interface PickerOpts {
  placeholder: string;
  /** Read each time the list is drawn, so a record added since is in it. */
  entries: () => PickEntry[];
  /** Ids to leave out, such as the ones already picked. */
  exclude?: () => Set<string>;
  onPick: (id: string) => void;
  /** How many matches to list. */
  limit?: number;
}

/** Whether an entry answers a query, and how well: a match at the start ranks first. */
function rank(e: PickEntry, q: string): number {
  const id = e.id.toLowerCase();
  const name = e.name.toLowerCase();
  if (q === "") return 1;
  if (id === q || name === q) return 4;
  if (id.startsWith(q) || name.startsWith(q)) return 3;
  if (id.includes(q) || name.includes(q)) return 2;
  if (e.hint?.toLowerCase().includes(q)) return 1;
  return 0;
}

export function buildPicker(opts: PickerOpts): Picker {
  const root = el("div", "cosPick");
  const input = document.createElement("input");
  input.type = "search";
  input.className = "cosField cosPickIn";
  input.placeholder = opts.placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  root.appendChild(input);
  const list = el("div", "cosPickList cosWell");
  list.hidden = true;
  root.appendChild(list);

  /** The matches on screen, in order, for Enter to take the first of. */
  let shown: PickEntry[] = [];

  const draw = (): void => {
    const q = input.value.trim().toLowerCase();
    const left = opts.exclude?.() ?? new Set<string>();
    shown = opts.entries()
      .filter((e) => !left.has(e.id))
      .map((e) => ({ e, r: rank(e, q) }))
      .filter((x) => x.r > 0)
      .sort((a, b) => b.r - a.r || a.e.name.localeCompare(b.e.name))
      .slice(0, opts.limit ?? 12)
      .map((x) => x.e);
    list.innerHTML = "";
    if (shown.length === 0) {
      list.appendChild(el("div", "cosNote cosPickNone", q === "" ? "Nothing left to pick." : "Nothing by that name."));
      return;
    }
    for (const e of shown) {
      const row = el("button", "cosPickRow");
      row.type = "button";
      const head = el("span", "cosPickHead");
      head.appendChild(el("b", undefined, e.name));
      head.appendChild(el("span", "cosPickId", e.id));
      row.appendChild(head);
      if (e.hint) row.appendChild(el("span", "cosPickHint", e.hint));
      // Picking must not blur the box first, or the list is gone before the click lands.
      row.addEventListener("pointerdown", (ev) => ev.preventDefault());
      row.addEventListener("click", () => take(e.id));
      list.appendChild(row);
    }
  };

  const take = (id: string): void => {
    input.value = "";
    list.hidden = true;
    opts.onPick(id);
  };

  input.addEventListener("focus", () => {
    list.hidden = false;
    draw();
  });
  input.addEventListener("input", () => {
    list.hidden = false;
    draw();
  });
  input.addEventListener("blur", () => {
    list.hidden = true;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = shown[0];
      if (first) take(first.id);
    } else if (e.key === "Escape") {
      input.blur();
    }
  });

  return { root, focus: () => input.focus() };
}
