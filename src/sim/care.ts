// Special Scoba care. Both players' clients must agree on its condition, so
// decay is a pure function of the last synced state and wall-clock time,
// quantized to whole minutes. Whoever logs in computes the same result,
// applies it, and pushes it back to the sync server.
export interface CareState {
  form: number;
  careXp: number;
  hunger: number; // 0-100
  clean: number; // 0-100
  happy: number; // 0-100
  hibernating: boolean;
  lastCalc: number; // epoch ms of last advance
}

export const CARE = {
  hungerPerHour: 4,
  cleanPerHour: 2.5,
  happyDriftPerHour: 6,
  hibernateBelow: 8, // all three meters below this -> hibernation
  wakeAt: 60, // all three meters at/above this -> wakes up
  feedAmount: 40,
  washAmount: 60,
  xpPerAction: 5,
  xpPerLevel: 50,
  /** A meter below this is worth telling someone about. */
  alertBelow: 30,
} as const;

export function newCareState(now: number): CareState {
  return { form: 0, careXp: 0, hunger: 90, clean: 90, happy: 80, hibernating: false, lastCalc: now };
}

export function careLevel(s: CareState): number {
  return Math.floor(s.careXp / CARE.xpPerLevel);
}

const clamp = (v: number): number => Math.max(0, Math.min(100, v));

/**
 * Advance decay to `now` in fixed one-minute steps. Stepping makes the result
 * path-independent: advancing in many small chunks or one big jump lands on
 * the identical state, so clients that tick at different rates still agree
 * with whatever the sync server stored.
 */
export function advanceCare(s: CareState, now: number): CareState {
  const minutes = Math.floor((now - s.lastCalc) / 60000);
  if (minutes <= 0) return { ...s };
  let { hunger, clean, happy, hibernating } = s;
  const hungerStep = CARE.hungerPerHour / 60;
  const cleanStep = CARE.cleanPerHour / 60;
  const driftStep = CARE.happyDriftPerHour / 60;
  for (let i = 0; i < minutes; i++) {
    hunger = clamp(hunger - hungerStep);
    clean = clamp(clean - cleanStep);
    // Mood drifts toward how well fed and clean it is.
    const target = (hunger + clean) / 2;
    happy = clamp(happy > target ? Math.max(target, happy - driftStep) : Math.min(target, happy + driftStep));
    if (!hibernating && hunger < CARE.hibernateBelow && clean < CARE.hibernateBelow && happy < CARE.hibernateBelow) {
      hibernating = true;
    }
  }
  return { ...s, hunger, clean, happy, hibernating, lastCalc: s.lastCalc + minutes * 60000 };
}

function afterAction(s: CareState): CareState {
  const out = { ...s, careXp: s.careXp + CARE.xpPerAction };
  if (out.hibernating && out.hunger >= CARE.wakeAt && out.clean >= CARE.wakeAt && out.happy >= CARE.wakeAt) {
    out.hibernating = false;
  }
  return out;
}

export function feed(s: CareState): CareState {
  return afterAction({ ...s, hunger: clamp(s.hunger + CARE.feedAmount) });
}

export function wash(s: CareState): CareState {
  return afterAction({ ...s, clean: clamp(s.clean + CARE.washAmount) });
}

/** Minigames report a 0-100 score; happiness refills proportionally. */
export function play(s: CareState, score: number): CareState {
  return afterAction({ ...s, happy: clamp(s.happy + Math.max(0, Math.min(100, score)) * 0.4) });
}


export type CareNeed = "feed" | "wash" | "play";

export interface CareAlert {
  /** Epoch ms of the crossing. */
  at: number;
  need: CareNeed;
}

/** How far ahead it is worth predicting. Past this, nobody is coming back soon. */
const ALERT_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When the Relica will next want something, worked out rather than watched.
 * Decay is a pure function of the last synced state and elapsed time, so the
 * crossing can be found now and slept through, which is what lets the relay
 * set one alarm per room instead of polling every room.
 *
 * A meter already under the threshold is skipped: it has had its say, and
 * re-announcing it every time the state syncs would be a nag rather than a
 * reminder.
 */
export function nextCareAlert(s: CareState, from: number): CareAlert | null {
  const base = Math.max(from, s.lastCalc);
  // Which meters are worth watching is decided from the state at `base`, not
  // from the raw snapshot. A snapshot left alone for a day has meters that
  // already fell below the line, and judging by its stored numbers would call
  // that a crossing about to happen and fire the moment it was asked.
  const atBase = advanceCare(s, base);
  if (atBase.hibernating) return null;
  const watched: { need: CareNeed; startsAbove: boolean }[] = [
    { need: "feed", startsAbove: atBase.hunger >= CARE.alertBelow },
    { need: "wash", startsAbove: atBase.clean >= CARE.alertBelow },
    { need: "play", startsAbove: atBase.happy >= CARE.alertBelow },
  ];
  if (!watched.some((w) => w.startsAbove)) return null;

  const horizon = base + ALERT_HORIZON_MS;
  // Walked in whole minutes because that is the grain `advanceCare` steps in,
  // so the answer agrees with what the clients will actually compute.
  for (let t = base; t <= horizon; t += 60000) {
    const at = advanceCare(s, t);
    for (const w of watched) {
      if (!w.startsAbove) continue;
      const value = w.need === "feed" ? at.hunger : w.need === "wash" ? at.clean : at.happy;
      if (value < CARE.alertBelow) return { at: t, need: w.need };
    }
    if (at.hibernating) return null;
  }
  return null;
}

/** What to say about a Relica that wants something. */
export function careAlertText(need: CareNeed, name: string): { title: string; body: string } {
  const body = need === "feed"
    ? `${name} is hungry.`
    : need === "wash"
      ? `${name} could do with a wash.`
      : `${name} is bored and wants to play.`;
  return { title: name, body };
}
