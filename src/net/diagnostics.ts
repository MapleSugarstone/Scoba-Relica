// One readout of everything that decides whether the app behaves on a phone.
//
// It exists because iOS cannot be inspected without a Mac. A tester there can
// only ever say "it didn't work", so the alternative to this is guessing. Every
// line is something that silently changes what the game can do: whether it is
// installed, whether the save is safe from eviction, which build is running,
// whether the relay is reachable, and whether reminders could be delivered.
import { isInstalled, isIosSafari } from "../pwa";
import { reminderState } from "./push";
import { relayUrl } from "./relay";
import { SAVE_KEY } from "../save/save";

export interface DiagnosticLine {
  label: string;
  value: string;
  /** false marks something that will stop a feature working. */
  ok: boolean;
}

const yesNo = (b: boolean): string => (b ? "yes" : "no");

/** The build, taken from the worker's cache name, which is a hash of its contents. */
async function buildId(): Promise<string> {
  try {
    const names = await caches.keys();
    const mine = names.find((n) => n.startsWith("scoba-relica-"));
    return mine ? mine.replace("scoba-relica-", "") : "not cached";
  } catch {
    return "unavailable";
  }
}

async function workerState(): Promise<{ text: string; ok: boolean }> {
  if (!("serviceWorker" in navigator)) return { text: "unsupported", ok: false };
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { text: "not registered", ok: false };
    const parts: string[] = [];
    if (reg.active) parts.push("active");
    if (reg.waiting) parts.push("update waiting");
    if (reg.installing) parts.push("installing");
    const controlled = !!navigator.serviceWorker.controller;
    parts.push(controlled ? "controlling" : "not controlling");
    return { text: parts.join(", "), ok: !!reg.active && controlled };
  } catch {
    return { text: "errored", ok: false };
  }
}

async function storageState(): Promise<{ text: string; ok: boolean }> {
  if (!navigator.storage?.persisted) return { text: "unsupported", ok: false };
  try {
    const persisted = await navigator.storage.persisted();
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const used = est?.usage ? `${Math.round(est.usage / 1024)}kb used` : "";
    return {
      text: persisted ? `granted${used ? `, ${used}` : ""}` : `NOT granted${used ? `, ${used}` : ""}`,
      // Not granted is the seven-day eviction risk, which is the whole reason
      // the install nudge exists.
      ok: persisted,
    };
  } catch {
    return { text: "unavailable", ok: false };
  }
}

function saveState(): { text: string; ok: boolean } {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { text: "none", ok: false };
    const parsed = JSON.parse(raw) as { updatedAt?: number };
    const when = parsed.updatedAt ? new Date(parsed.updatedAt).toISOString().slice(0, 16) : "unknown";
    return { text: `${Math.round(raw.length / 1024)}kb, saved ${when}`, ok: true };
  } catch {
    return { text: "unreadable", ok: false };
  }
}

const MOVEMENT_TEXT: Record<string, string> = {
  direct: "peer to peer",
  relay: "via relay (fallback)",
  connecting: "connecting",
  none: "not connected",
};

const REMINDER_TEXT: Record<string, string> = {
  unavailable: "unsupported here",
  "needs-install": "needs Home Screen first",
  off: "off",
  on: "on",
  blocked: "blocked in browser settings",
};

export interface RelaySnapshot {
  status: string;
  partnerHere: boolean;
  room?: string;
  /** Whether movement is going peer to peer or falling back through the relay. */
  carrier?: string;
  /** The wire version the relay reported, or 0 before it has said. */
  relayVersion?: number;
}

/**
 * Everything worth knowing, in the order it matters when something is wrong.
 * A tester screenshots this, so it stays short enough to fit on a phone.
 */
export async function collectDiagnostics(relay: RelaySnapshot): Promise<DiagnosticLine[]> {
  const [worker, storage, reminders, build] = await Promise.all([
    workerState(),
    storageState(),
    reminderState(),
    buildId(),
  ]);
  const save = saveState();
  const installed = isInstalled();

  return [
    { label: "Installed", value: yesNo(installed), ok: installed },
    { label: "Platform", value: isIosSafari() ? "iOS Safari" : navigator.userAgent.slice(0, 28), ok: true },
    { label: "Build", value: build, ok: build !== "not cached" },
    { label: "Worker", value: worker.text, ok: worker.ok },
    { label: "Save kept", value: storage.text, ok: storage.ok },
    { label: "Save", value: save.text, ok: save.ok },
    { label: "Reminders", value: REMINDER_TEXT[reminders] ?? reminders, ok: reminders === "on" },
    {
      label: "Relay",
      value: relay.room
        ? `${relay.status}${relay.partnerHere ? ", partner here" : ""} (${relay.room})`
        : "no room",
      // Playing alone is a legitimate state, not a fault. Only a room that is
      // set but not connected is worth marking, or the mark stops meaning
      // anything and gets ignored on the screenshots this exists for.
      ok: !relay.room || relay.status === "live",
    },
    { label: "Relay host", value: relayUrl().replace(/^wss?:\/\//, ""), ok: true },
    {
      label: "Movement",
      value: MOVEMENT_TEXT[relay.carrier ?? "none"] ?? (relay.carrier ?? "none"),
      // Falling back is not broken, it is slower and billed, so it is worth
      // seeing on a screenshot without being marked as a fault.
      ok: true,
    },
  ];
}

/** The same readout as one block of text, for pasting into a message. */
export function diagnosticsText(lines: DiagnosticLine[]): string {
  return lines.map((l) => `${l.label}: ${l.value}`).join("\n");
}
