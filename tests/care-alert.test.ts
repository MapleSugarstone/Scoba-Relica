import { describe, expect, it } from "vitest";
import { CARE, advanceCare, nextCareAlert, newCareState } from "../src/sim/care";

const HOUR = 60 * 60 * 1000;
const at0 = 1_700_000_000_000;

const state = (over: Partial<ReturnType<typeof newCareState>> = {}) => ({
  ...newCareState(at0),
  ...over,
});

describe("predicting when the Relica will want something", () => {
  it("names hunger first, since it drains fastest", () => {
    const alert = nextCareAlert(state({ hunger: 100, clean: 100, happy: 100 }), at0);
    expect(alert?.need).toBe("feed");
  });

  it("lands on the minute the meter actually crosses", () => {
    const s = state({ hunger: 100, clean: 100, happy: 100 });
    const alert = nextCareAlert(s, at0)!;
    // The predicted moment is under the threshold and the minute before is not,
    // which is the whole contract: clients advancing to that time agree.
    expect(advanceCare(s, alert.at).hunger).toBeLessThan(CARE.alertBelow);
    expect(advanceCare(s, alert.at - 60000).hunger).toBeGreaterThanOrEqual(CARE.alertBelow);
  });

  it("is quiet about a meter that is already low", () => {
    const alert = nextCareAlert(state({ hunger: 5, clean: 5, happy: 5 }), at0);
    expect(alert).toBeNull();
  });

  it("says nothing at all about a hibernating Relica", () => {
    const alert = nextCareAlert(state({ hibernating: true }), at0);
    expect(alert).toBeNull();
  });

  it("puts a well-fed Relica's reminder hours out, not minutes", () => {
    const alert = nextCareAlert(state({ hunger: 100, clean: 100, happy: 100 }), at0)!;
    expect(alert.at - at0).toBeGreaterThan(10 * HOUR);
  });

  it("predicts from the later of the snapshot and now", () => {
    const s = state({ hunger: 100, clean: 100, happy: 100 });
    const later = at0 + 5 * HOUR;
    const alert = nextCareAlert(s, later)!;
    expect(alert.at).toBeGreaterThanOrEqual(later);
  });
});

describe("a snapshot that has been sitting for a while", () => {
  it("does not fire instantly for a meter that already fell below the line", () => {
    // Two days after the snapshot, hunger is long gone; asking now must find
    // the next thing to say, not claim hunger is crossing this minute.
    const s = state({ hunger: 100, clean: 100, happy: 100 });
    const twoDaysOn = at0 + 48 * HOUR;
    const alert = nextCareAlert(s, twoDaysOn);
    expect(alert).toBeNull();
  });

  it("moves on to the next meter once the first has been announced", () => {
    // Cleanliness drains slowest, so a state where only it is still high has
    // its own crossing rather than reporting hunger again.
    const s = state({ hunger: 100, clean: 100, happy: 100 });
    const first = nextCareAlert(s, at0)!;
    expect(first.need).toBe("feed");
    const second = nextCareAlert(s, first.at + 60000);
    expect(second?.need === "wash" || second?.need === "play" || second === null).toBe(true);
    if (second) expect(second.at).toBeGreaterThan(first.at);
  });
});
