// The nudge that gets the game onto a home screen. It earns its place on the
// title screen: an installed app keeps its save out of reach of Safari's
// seven-day eviction, and on iOS it is the only context notification
// permission can ever be asked from. See claude-notes/installable-app.md.
import { sfx } from "../engine/sfx";
import {
  canPromptInstall,
  isInstalled,
  isIosSafari,
  onInstallAvailable,
  promptInstall,
} from "../pwa";

const NUDGE_KEY = "scoba-install-nudge-v1";
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DISMISSALS = 3;

export interface NudgeState {
  /** How many times it has been waved away. */
  count: number;
  /** When it was last waved away. */
  at: number;
}

function readNudge(): NudgeState {
  try {
    const raw = localStorage.getItem(NUDGE_KEY);
    if (!raw) return { count: 0, at: 0 };
    const v = JSON.parse(raw) as Partial<NudgeState>;
    return {
      count: typeof v.count === "number" ? v.count : 0,
      at: typeof v.at === "number" ? v.at : 0,
    };
  } catch {
    return { count: 0, at: 0 };
  }
}

function recordDismissal(): void {
  const prev = readNudge();
  try {
    localStorage.setItem(NUDGE_KEY, JSON.stringify({ count: prev.count + 1, at: Date.now() }));
  } catch {
    // A blocked or full store only costs us the backoff, so the nudge simply
    // asks again next launch rather than the game failing here.
  }
}

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

/** The iOS Share glyph, on the same 16px grid and stepped edges as the bag icon. */
function shareGlyph(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  // The head is four stepped rows rather than three: at 16px a shallower taper
  // reads as a crossbar, and this glyph has to be matched against a real
  // button in Safari's toolbar.
  const rects: [number, number, number, number][] = [
    [7, 1, 2, 1], [6, 2, 4, 1], [5, 3, 6, 1], [4, 4, 8, 1], // arrowhead, tip first
    [7, 4, 2, 6], // stem, down into the mouth of the box
    [1, 7, 4, 2], [11, 7, 4, 2], // the tabs the open top turns in on
    [1, 7, 2, 8], [13, 7, 2, 8], [1, 13, 14, 2], // walls and floor
  ];
  for (const [x, y, w, h] of rects) {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", String(x));
    r.setAttribute("y", String(y));
    r.setAttribute("width", String(w));
    r.setAttribute("height", String(h));
    svg.appendChild(r);
  }
  return svg;
}

/**
 * Whether to ask again. Kept pure and separate from the DOM so the backing-off
 * is testable: a player who says no is asked at most `MAX_DISMISSALS` times,
 * a week apart, and never again once they have installed it.
 */
export function shouldNudge(
  state: NudgeState,
  now: number,
  env: { installed: boolean; canOffer: boolean },
): boolean {
  if (env.installed || !env.canOffer) return false;
  if (state.count >= MAX_DISMISSALS) return false;
  // `at` of 0 is a player who has never waved it off, not one waved off at the
  // epoch, so the cooldown does not apply to them.
  if (state.at !== 0 && now - state.at < COOLDOWN_MS) return false;
  return true;
}

/** The card, or null when there is nothing to offer or it has been waved off. */
function installCard(): HTMLElement | null {
  const ios = isIosSafari();
  const env = { installed: isInstalled(), canOffer: ios || canPromptInstall() };
  if (!shouldNudge(readNudge(), Date.now(), env)) return null;

  const card = el("div", "card install");
  card.appendChild(el("strong", undefined, "Add Relica to your Home Screen"));
  card.appendChild(el(
    "div",
    "dim",
    ios
      ? "Safari clears saves for sites you have not opened in a week. On your Home Screen it stays put, and Relica can tell you when it needs care."
      : "Keeps the game playable offline, and lets Relica tell you when it needs care.",
  ));

  if (ios) {
    const steps = el("div", "steps");
    steps.appendChild(el("span", undefined, "Tap"));
    steps.appendChild(shareGlyph());
    steps.appendChild(el("span", undefined, "then Add to Home Screen"));
    card.appendChild(steps);
  } else {
    const install = el("button", "pill", "Install");
    install.addEventListener("click", () => {
      sfx.confirm();
      void promptInstall().then((accepted) => {
        if (accepted) card.remove();
      });
    });
    card.appendChild(install);
  }

  const later = el("button", "pill", "Not now");
  later.addEventListener("click", () => {
    sfx.tap();
    recordDismissal();
    card.remove();
  });
  card.appendChild(later);
  return card;
}

/**
 * Hangs the nudge off `parent` when there is one to hang. Chrome can decide a
 * page is installable after the title screen is already built, so a screen
 * that had nothing to show keeps one late chance at it for as long as it is on
 * screen.
 */
export function mountInstallCard(parent: HTMLElement): void {
  const add = (): void => {
    const card = installCard();
    if (card) parent.appendChild(card);
  };
  add();
  // Only the late arrival checks `isConnected`: a screen builder runs before
  // its screen is in the document, so the first call must not test for it, and
  // by the time this one fires the player may have left the title behind.
  if (!isIosSafari() && !canPromptInstall()) {
    onInstallAvailable(() => {
      if (parent.isConnected) add();
    });
  }
}
