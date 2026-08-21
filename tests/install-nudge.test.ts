import { describe, expect, it } from "vitest";
import { shouldNudge, type NudgeState } from "../src/ui/install";

const DAY = 24 * 60 * 60 * 1000;
const OFFERABLE = { installed: false, canOffer: true };
const fresh: NudgeState = { count: 0, at: 0 };
const now = 1_700_000_000_000;

describe("install nudge backing off", () => {
  it("asks a player who has never been asked", () => {
    expect(shouldNudge(fresh, now, OFFERABLE)).toBe(true);
  });

  it("never asks once the game is installed", () => {
    expect(shouldNudge(fresh, now, { installed: true, canOffer: true })).toBe(false);
  });

  it("stays quiet when there is no way to install", () => {
    expect(shouldNudge(fresh, now, { installed: false, canOffer: false })).toBe(false);
  });

  it("waits a week after being waved off", () => {
    const waved: NudgeState = { count: 1, at: now };
    expect(shouldNudge(waved, now + 6 * DAY, OFFERABLE)).toBe(false);
    expect(shouldNudge(waved, now + 8 * DAY, OFFERABLE)).toBe(true);
  });

  it("gives up after three refusals", () => {
    const done: NudgeState = { count: 3, at: now };
    expect(shouldNudge(done, now + 400 * DAY, OFFERABLE)).toBe(false);
  });

  // A stored `at` of 0 means never dismissed, so it must not read as a
  // dismissal at the epoch that the cooldown has long since cleared.
  it("treats a zero timestamp as never asked rather than asked in 1970", () => {
    expect(shouldNudge({ count: 0, at: 0 }, now, OFFERABLE)).toBe(true);
  });
});
