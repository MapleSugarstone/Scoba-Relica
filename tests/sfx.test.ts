import { describe, expect, it } from "vitest";
import { levelGain } from "../src/engine/sfx";
import { MOVES } from "../src/sim/species";

const RATE = 44100;

/** A sine of a given amplitude, `seconds` long, followed by `tail` of silence. */
function tone(amp: number, seconds: number, tail = 0): Float32Array[] {
  const out = new Float32Array(Math.round(RATE * (seconds + tail)));
  const loud = Math.round(RATE * seconds);
  for (let i = 0; i < loud; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / RATE);
  return [out];
}

/** What a sample's body actually comes out at once the gain is applied. */
function loudnessAfter(channels: Float32Array[]): number {
  const gain = levelGain(channels, RATE);
  const body = [...channels[0]!].filter((v) => v !== 0);
  const rms = Math.sqrt(body.reduce((a, v) => a + v * v, 0) / body.length);
  return rms * gain;
}

describe("levelling a sample", () => {
  it("brings a quiet and a loud recording to the same place", () => {
    const quiet = loudnessAfter(tone(0.05, 0.5));
    const loud = loudnessAfter(tone(0.8, 0.5));
    expect(quiet).toBeCloseTo(loud, 2);
  });

  it("reads a long tail as tail rather than as quiet", () => {
    // The same half second of sound, one of them followed by two seconds of
    // nothing. Averaging over the whole file would call the second one quiet
    // and push it up.
    const bare = levelGain(tone(0.3, 0.5), RATE);
    const tailed = levelGain(tone(0.3, 0.5, 2), RATE);
    expect(tailed).toBeCloseTo(bare, 4);
  });

  it("never raises a sample into clipping", () => {
    // A short spike in an otherwise quiet file: the body wants more gain than
    // the peak can take, and the peak wins.
    const ch = tone(0.05, 0.5)[0]!;
    ch[100] = 0.99;
    expect(levelGain([ch], RATE) * 0.99).toBeLessThanOrEqual(1);
  });

  it("leaves silence alone instead of multiplying it", () => {
    expect(levelGain([new Float32Array(RATE)], RATE)).toBe(1);
    expect(levelGain([], RATE)).toBe(1);
  });

  it("keeps the gain inside its bounds however faint the recording", () => {
    const g = levelGain(tone(1e-6, 0.5), RATE);
    expect(g).toBeLessThanOrEqual(6);
    expect(g).toBeGreaterThanOrEqual(0.2);
  });

  it("counts both channels of a stereo sample as one sound", () => {
    const mono = tone(0.3, 0.5);
    const stereo = [mono[0]!, mono[0]!.slice()];
    expect(levelGain(stereo, RATE)).toBeCloseTo(levelGain(mono, RATE), 4);
  });
});

describe("Cold Wave", () => {
  it("sounds when it fires rather than when it lands", () => {
    expect(MOVES["cold-wave"]!.sound).toBe("coldwave");
    expect(MOVES["cold-wave"]!.soundOn).toBe("cast");
  });

  it("is the only move that does, so the rest still keep the throw noise", () => {
    const cast = Object.values(MOVES).filter((m) => m.soundOn === "cast").map((m) => m.id);
    expect(cast).toEqual(["cold-wave"]);
  });
});
