// The password over the published build. It keeps people who wander onto the
// GitHub Pages address from playing, and it does nothing beyond that: the whole
// game is already downloaded by the time the lock is drawn, so anyone who reads
// the bundle can get past it. See claude-notes/password-lock.md.
import { sfx } from "../engine/sfx";
import type { UI } from "./screens";

/**
 * SHA-256 of SALT + the password, so the word itself is in neither the
 * repository nor the bundle. Change it with `node tools/set-password.mjs`.
 */
const PASS_HASH = "5798859683424b6262ad4b265cf25da5f1dc609f57a98601a454d474dbba1cfe";

/**
 * Mixed in before hashing, so the published digest is not the digest of a bare
 * word that a reverse-lookup site already has an answer for.
 */
const SALT = "scoba-relica lock v1: ";

/** What a browser that has already been let in remembers. */
const KEY = "scoba-lock-v1";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

async function digest(pass: string): Promise<string> {
  const bytes = new TextEncoder().encode(SALT + pass);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function remembered(): boolean {
  try {
    return localStorage.getItem(KEY) === PASS_HASH;
  } catch {
    // Storage is walled off, which is private browsing. Ask every time.
    return false;
  }
}

/**
 * Holds the boot until the password is in. Returns straight away for a browser
 * that has been let in before, in a dev build, and on an origin without Web
 * Crypto. `?lock` puts the screen up anyway, which is how it gets looked at
 * while working on it.
 */
export async function unlock(ui: UI): Promise<void> {
  const forced = new URLSearchParams(location.search).has("lock");
  if (!forced && (import.meta.env.DEV || remembered())) return;
  // Only a secure origin has Web Crypto, so this is a phone reading a preview
  // build off the machine's LAN address rather than the published site.
  if (!globalThis.crypto?.subtle) return;

  await new Promise<void>((resolve) => {
    let field: HTMLInputElement;
    let note: HTMLElement;
    let go: HTMLButtonElement;

    const submit = async (): Promise<void> => {
      if (go.disabled) return;
      go.disabled = true;
      const typed = await digest(field.value.trim());
      go.disabled = false;
      if (typed !== PASS_HASH) {
        sfx.back();
        note.textContent = "That is not the password.";
        note.hidden = false;
        field.select();
        return;
      }
      sfx.confirm();
      try {
        localStorage.setItem(KEY, PASS_HASH);
      } catch {
        // Nothing to remember it in, so the next visit asks again.
      }
      resolve();
    };

    ui.screen((s) => {
      s.appendChild(el("h2", undefined, "Scoba Relica"));

      const card = el("div", "card");
      field = el("input");
      field.type = "password";
      field.placeholder = "Password";
      field.autocomplete = "current-password";
      field.spellcheck = false;
      field.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        void submit();
      });
      card.appendChild(field);
      // Empty until there is something to say, so the card is a field and
      // nothing else.
      note = el("div", "dim");
      note.hidden = true;
      card.appendChild(note);
      s.appendChild(card);

      go = el("button", "big primary", "Play");
      go.addEventListener("click", () => void submit());
      s.appendChild(go);
    });
    // Nothing else exists yet, so there is nothing to escape back to.
    ui.setLocked(true);
    void ui.reveal().then(() => field.focus());
  });

  // Back under the cover the rest of the boot expects to run behind.
  ui.cover();
  ui.closeScreen();
}
