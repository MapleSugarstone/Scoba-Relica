// Care reminders, client side. The relay does the waking up; this only asks
// permission, hands over a subscription, and takes it back again.
//
// On iOS none of this exists until the game is installed to the home screen,
// which is why the install nudge came first. See claude-notes/installable-app.md.
import { isInstalled, isIosSafari } from "../pwa";
import type { PushSubscriptionJson } from "./protocol";

/**
 * Not a secret: the browser needs it to build a subscription only this relay
 * can push to, and it is public by design. It must match the keypair whose
 * private half is set on the worker with `wrangler secret put`; regenerating
 * that pair invalidates every subscription made against the old one.
 *
 * `VITE_VAPID_PUBLIC_KEY` overrides it, so a second relay can be pointed at
 * without editing this file.
 */
const VAPID_PUBLIC_KEY =
  "BDNx3TVB9_3rkTaFCO-eAShoQL_1XbdkSYaCVvRvBPBngGjfEML3ASEgThPEWoa7FU_kvrtW0aE3pKQSk1vsGW4";

export function vapidPublicKey(): string {
  const override = import.meta.env["VITE_VAPID_PUBLIC_KEY"] as string | undefined;
  return override || VAPID_PUBLIC_KEY;
}

export type ReminderState =
  /** No push support in this browser, or no key configured. */
  | "unavailable"
  /** iOS, and the game is still a tab rather than an installed app. */
  | "needs-install"
  | "off"
  | "on"
  /** The player said no. Only they can undo it, in browser settings. */
  | "blocked";

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    vapidPublicKey() !== ""
  );
}

export async function reminderState(): Promise<ReminderState> {
  if (!supported()) return isIosSafari() && !isInstalled() ? "needs-install" : "unavailable";
  // Asking from a tab on iOS can only ever fail, so it is offered as a step
  // rather than as a button that does nothing.
  if (isIosSafari() && !isInstalled()) return "needs-install";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission === "default") return "off";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  // Built on an explicit ArrayBuffer so it satisfies BufferSource: a bare
  // Uint8Array is generic over SharedArrayBuffer too, which subscribe refuses.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Ask, subscribe, and hand the result back for the relay to store. Must be
 * called from a user gesture: every browser refuses the prompt otherwise, and
 * Safari is the strictest about it.
 */
export async function enableReminders(): Promise<
  { ok: true; sub: PushSubscriptionJson } | { ok: false; state: ReminderState }
> {
  const state = await reminderState();
  if (state === "on") {
    const existing = await currentSubscription();
    if (existing) return { ok: true, sub: existing };
  }
  if (state === "unavailable" || state === "needs-install" || state === "blocked") {
    return { ok: false, state };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, state: permission === "denied" ? "blocked" : "off" };

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    // Required everywhere, and true means every push must show something. The
    // relay only ever pushes reminders, so that is the case regardless.
    userVisibleOnly: true,
    applicationServerKey: keyBytes(vapidPublicKey()),
  });
  return { ok: true, sub: sub.toJSON() as PushSubscriptionJson };
}

async function currentSubscription(): Promise<PushSubscriptionJson | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? (sub.toJSON() as PushSubscriptionJson) : null;
}

/** Drops the subscription locally. The relay is told separately. */
export async function disableReminders(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
}
