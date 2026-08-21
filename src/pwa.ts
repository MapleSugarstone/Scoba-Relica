// Installability and storage durability. Both matter more than they look:
// a save lives in localStorage, and Safari evicts script-written storage after
// seven days without a visit unless the site is installed to the home screen.
// Installing the app is what turns the save from temporary into permanent, and
// on iOS it is also the only way notification permission can ever be asked for.

/** True when running from a home-screen icon rather than a browser tab. */
export function isInstalled(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS predates display-mode and reports it here instead.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/** Chrome's install event, which the DOM lib does not describe. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredInstall: BeforeInstallPromptEvent | null = null;
let installWaiters: (() => void)[] = [];

// Captured at module load: Chrome fires this once, early, and only honours a
// later `prompt()` call if the default was prevented when it did.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
    const waiting = installWaiters;
    installWaiters = [];
    for (const cb of waiting) cb();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
  });
}

export function canPromptInstall(): boolean {
  return deferredInstall !== null;
}

/** Runs `cb` once the browser offers an install prompt, or now if it already has. */
export function onInstallAvailable(cb: () => void): void {
  if (deferredInstall) cb();
  else installWaiters.push(cb);
}

/** Shows the browser's own install dialog. Resolves to whether it was accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferredInstall;
  if (!event) return false;
  // A captured prompt is single-use, so it is spent whatever the answer is.
  deferredInstall = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome === "accepted";
}

/** iOS has no install prompt, so a nudge has to name the Share-sheet steps. */
export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/**
 * Ask the browser to exempt our storage from eviction. Chrome grants it
 * silently once the app is installed or the site has enough engagement;
 * Safari grants it to installed apps. Resolves to whether it stuck.
 */
export async function requestDurableStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

let waiting: ServiceWorker | null = null;

/** Apply an update that has already downloaded. Reloads once it takes over. */
export function applyUpdate(): void {
  if (!waiting) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  waiting.postMessage("skip-waiting");
  waiting = null;
}

/** Whether a newer build is downloaded and waiting for the next launch. */
export function updateReady(): boolean {
  return waiting !== null;
}

export async function registerServiceWorker(): Promise<void> {
  // The dev server never emits sw.js, and a worker caching the build would
  // fight the editor's reload anyway.
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register(new URL("sw.js", document.baseURI));
    if (reg.waiting) waiting = reg.waiting;
    reg.addEventListener("updatefound", () => {
      const next = reg.installing;
      if (!next) return;
      next.addEventListener("statechange", () => {
        // A worker that reaches `installed` with a controller already present
        // is an update rather than the first install.
        if (next.state === "installed" && navigator.serviceWorker.controller) waiting = next;
      });
    });
  } catch {
    // An unregistrable worker costs offline play and nothing else.
  }
}
