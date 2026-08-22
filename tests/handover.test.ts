import { describe, expect, it } from "vitest";
import {
  HANDOVER_MAX,
  HANDOVER_WAIT,
  Handover,
  MEET_DIST,
  type HandoverSense,
} from "../src/game/handover";

const sense = (over: Partial<HandoverSense> = {}): HandoverSense => ({
  peer: { x: 200, y: 0 },
  sameMap: true,
  dist: 200,
  offView: false,
  faded: false,
  ...over,
});

/** Run a number of frames of the same thing, and hand back the last answer. */
const run = (h: Handover, secs: number, s: HandoverSense): string => {
  let act = "";
  for (let t = 0; t < secs; t += 1 / 60) act = h.step(1 / 60, s);
  return act;
};

describe("handing the character back to the player", () => {
  it("leaves the stand-in following until their position lands", () => {
    const h = new Handover();
    expect(h.step(1 / 60, sense({ peer: null, dist: Infinity }))).toBe("follow");
    expect(run(h, HANDOVER_WAIT - 1, sense({ peer: null, dist: Infinity }))).toBe("follow");
  });

  it("gives up waiting on a player who never says where they are", () => {
    const h = new Handover();
    expect(run(h, HANDOVER_WAIT + 0.5, sense({ peer: null, dist: Infinity }))).toBe("done");
  });

  it("walks to a player standing on this map", () => {
    const h = new Handover();
    expect(h.step(1 / 60, sense())).toBe("meet");
  });

  it("hands over on arrival", () => {
    const h = new Handover();
    expect(h.step(1 / 60, sense())).toBe("meet");
    expect(h.step(1 / 60, sense({ dist: MEET_DIST }))).toBe("done");
  });

  it("walks off the screen for a player who is on another map", () => {
    const h = new Handover();
    expect(h.step(1 / 60, sense({ sameMap: false }))).toBe("leave");
  });

  it("turns a walk off the screen into a meeting when they arrive on this map", () => {
    const h = new Handover();
    expect(h.step(1 / 60, sense({ sameMap: false }))).toBe("leave");
    expect(h.step(1 / 60, sense())).toBe("meet");
  });

  it("fades once it is off the screen, and swaps when the fade is done", () => {
    const h = new Handover();
    expect(h.step(1 / 60, sense({ offView: true }))).toBe("fade");
    // Still going: the swap waits for the fade rather than racing it.
    expect(run(h, 2, sense({ offView: true }))).toBe("fade");
    expect(h.step(1 / 60, sense({ offView: true, faded: true }))).toBe("done");
  });

  it("carries on fading even if the player walks up mid-fade", () => {
    const h = new Handover();
    expect(h.step(1 / 60, sense({ offView: true }))).toBe("fade");
    // Out of sight either way, so it is met a moment later on the far side.
    expect(h.step(1 / 60, sense({ dist: 0 }))).toBe("fade");
    expect(h.step(1 / 60, sense({ dist: 0, faded: true }))).toBe("done");
  });

  it("fades a walk that cannot finish, rather than walking for ever", () => {
    const h = new Handover();
    expect(run(h, HANDOVER_MAX - 1, sense())).toBe("meet");
    expect(run(h, 1.5, sense())).toBe("fade");
  });

  it("stays on when the player drops out again before the swap", () => {
    const h = new Handover();
    expect(h.step(1 / 60, sense())).toBe("meet");
    expect(h.step(1 / 60, sense({ peer: null, dist: Infinity }))).toBe("done");
  });
});
