// The hobby hut: pick a Scoba, pick what it does with its time.
//
// A hobby is part of a Scoba rather than a mark it carries, so taking one up
// rewrites its stat line for good, in a battle and out of one alike. That is
// the whole of what happens here, which is why the list shows what each one
// would do to the Scoba in front of you rather than what it does in general.
import type { Art } from "../engine/assets";
import { sfx } from "../engine/sfx";
import { displayName } from "../sim/battle";
import { describeHobby } from "../sim/describe";
import { HOBBIES, type HobbyDef } from "../sim/status";
import { statsAt, type ScobaInstance } from "../sim/scoba";
import { STAT_LABELS, STAT_NAMES, type StatName } from "../sim/types";
import type { SaveData } from "../save/save";
import { writeSave } from "../save/save";
import { face, openBrowser } from "./browser";
import type { UI } from "./screens";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Every hobby, in the order a reader would look for them. */
const listed = (): HobbyDef[] => Object.values(HOBBIES).sort((a, b) => a.name.localeCompare(b.name));

/** What a hobby would move, stat by stat, on this Scoba. */
function shift(s: ScobaInstance, id: string): { name: StatName; from: number; to: number }[] {
  const now = statsAt(s);
  const then = statsAt({ ...s, hobby: id });
  return STAT_NAMES
    .map((name) => ({ name, from: now[name], to: then[name] }))
    .filter((row) => row.from !== row.to);
}

export function openHobbies(ui: UI, art: Art, save: SaveData, onClose: () => void): void {
  const pool = (): ScobaInstance[] => [...save.party, ...save.box];

  const close = (): void => {
    ui.closeScreen();
    onClose();
  };

  const pickScoba = (): void => {
    openBrowser(ui, art, {
      title: "The Hobby Hut",
      memory: "hobbies",
      hint: "Pick a Scoba to set what it does with its time.",
      empty: "Nobody to teach yet.",
      source: pool,
      onBack: close,
      foot: (ctx) => {
        const wrap = el("div", "bxPanel bxPick");
        const chosen = ctx.selected();
        const b = el("button", "bxWide", chosen ? `Teach ${displayName(chosen)}` : "Select");
        b.disabled = !chosen;
        b.addEventListener("click", () => {
          if (!chosen) return;
          sfx.tap();
          pickHobby(chosen);
        });
        wrap.appendChild(b);
        return wrap;
      },
    });
  };

  const pickHobby = (s: ScobaInstance): void => {
    // Starts on whatever it already does, so the panel opens on something to
    // read rather than on an empty card.
    let chosen: string | null = s.hobby ?? null;
    ui.screen((scr) => {
      scr.classList.add("tight");
      scr.appendChild(el("h2", undefined, `What does ${displayName(s)} do with its time?`));
      scr.appendChild(el("div", "sub", "A hobby is part of a Scoba. Taking one up drops whatever it did before."));
      const top = el("div", "spawnTop");

      const search = el("div", "dbgSearch");
      const field = el("input", "dbgField");
      field.type = "search";
      field.placeholder = "Search every hobby";
      field.autocomplete = "off";
      const hits = el("div", "dbgHits hobbyHits");
      search.append(field, hits);

      const side = el("div", "spawnSide");
      const detail = el("div", "card pick");
      const take = el("button", "pill", "Take it up");

      const renderDetail = (): void => {
        detail.innerHTML = "";
        const def = chosen ? HOBBIES[chosen] : undefined;
        take.disabled = !def || def.id === s.hobby;
        take.textContent = def && def.id === s.hobby ? "Already doing this" : "Take it up";
        if (!def) {
          detail.appendChild(el("div", "sub", "Pick one to read it."));
          return;
        }
        detail.appendChild(el("div", "pickName", def.name));
        detail.appendChild(el("div", "sub", def.text));
        const what = describeHobby(def.id);
        if (what !== "") detail.appendChild(el("div", undefined, what));
        // What it comes to on this Scoba, which is the number that matters.
        const rows = shift(s, def.id);
        if (rows.length > 0) {
          const table = el("div", "hobbyShift");
          for (const row of rows) {
            const line = el("div", "hobbyRow");
            line.appendChild(el("span", undefined, STAT_LABELS[row.name]));
            line.appendChild(el("span", row.to > row.from ? "good" : "bad", `${row.from} → ${row.to}`));
            table.appendChild(line);
          }
          detail.appendChild(table);
        }
      };

      // Marked in place, so picking one does not scroll the list back to the top.
      const renderHits = (): void => {
        hits.innerHTML = "";
        const q = field.value.trim().toLowerCase();
        const found = listed().filter((h) =>
          q === "" || h.name.toLowerCase().includes(q) || h.doing.toLowerCase().includes(q) || h.id.includes(q));
        if (found.length === 0) hits.appendChild(el("div", "dim", "Nothing by that name."));
        for (const h of found) {
          const b = el("button", `dbgHit${chosen === h.id ? " sel" : ""}`);
          b.dataset["id"] = h.id;
          b.append(el("span", undefined, h.name), el("span", "sub", h.id === s.hobby ? "Doing this now" : h.doing));
          b.addEventListener("click", () => {
            sfx.tap();
            chosen = h.id;
            for (const hit of hits.querySelectorAll<HTMLElement>(".dbgHit")) {
              hit.classList.toggle("sel", hit.dataset["id"] === chosen);
            }
            renderDetail();
          });
          hits.appendChild(b);
        }
      };
      field.addEventListener("input", renderHits);

      take.addEventListener("click", () => {
        const def = chosen ? HOBBIES[chosen] : undefined;
        if (!def || def.id === s.hobby) return;
        s.hobby = def.id;
        writeSave(save);
        sfx.confirm();
        ui.toast(`${displayName(s)} takes up ${def.name}.`);
        pickScoba();
      });

      const back = el("button", "big", "Back");
      back.addEventListener("click", () => {
        sfx.back();
        pickScoba();
      });
      const exit = el("div", "backRow");
      exit.appendChild(back);

      side.append(detail, take);
      top.append(search, side);
      scr.append(top, exit);
      renderHits();
      renderDetail();
    });
  };

  pickScoba();
}
