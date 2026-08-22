import { describe, expect, it } from "vitest";
import { LocalTrack, RemoteTrack, type Step } from "../src/net/presence";

const step = (seq: number, x: number, y = 0, over: Partial<Step> = {}): Step => ({
  seq, x, y, dir: 1, moving: true, map: "home", ...over,
});

/** Walks a track through a session and reports what it drew each frame. */
function render(track: RemoteTrack, from: number, to: number, stepMs = 16) {
  const out: { t: number; x: number; y: number }[] = [];
  for (let t = from; t <= to; t += stepMs) {
    const p = track.sample(t);
    if (p) out.push({ t, x: p.x, y: p.y });
  }
  return out;
}

/** The largest jump between consecutive drawn frames, in pixels. */
const biggestJump = (frames: { x: number; y: number }[]): number => {
  let worst = 0;
  for (let i = 1; i < frames.length; i++) {
    const d = Math.hypot(frames[i]!.x - frames[i - 1]!.x, frames[i]!.y - frames[i - 1]!.y);
    if (d > worst) worst = d;
  }
  return worst;
};

describe("drawing a peer who is walking", () => {
  it("says nothing until it has heard something", () => {
    expect(new RemoteTrack().sample(1000)).toBeNull();
  });

  it("moves smoothly between updates rather than jumping between them", () => {
    const track = new RemoteTrack();
    // 5Hz, which is the sparse relay-fallback case: 200ms of ground per update.
    for (let i = 0; i < 10; i++) track.push(step(i + 1, i * 40), 1000 + i * 200);
    const frames = render(track, 1000, 2600);
    expect(frames.length).toBeGreaterThan(50);
    // A frame-to-frame jump anywhere near a whole 40px update would be the
    // character teleporting between samples instead of walking.
    expect(biggestJump(frames)).toBeLessThan(8);
  });

  it("never walks backwards when packets arrive out of order", () => {
    const track = new RemoteTrack();
    track.push(step(1, 0), 1000);
    track.push(step(2, 40), 1200);
    track.push(step(4, 120), 1400);
    // The channel is unordered, so this late one turns up after its successor.
    track.push(step(3, 80), 1420);
    const frames = render(track, 1000, 1800);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.x).toBeGreaterThanOrEqual(frames[i - 1]!.x - 0.001);
    }
  });

  it("stays smooth when arrival times jitter", () => {
    const track = new RemoteTrack();
    const jitter = [0, 45, -20, 70, 10, -35, 55, 5, 30, -15, 60, 0];
    let at = 1000;
    for (let i = 0; i < jitter.length; i++) {
      at += 100 + jitter[i]!;
      track.push(step(i + 1, i * 20), at);
    }
    const frames = render(track, 1100, at);
    expect(biggestJump(frames)).toBeLessThan(8);
  });

  it("carries on through a dropped update instead of stalling", () => {
    const track = new RemoteTrack();
    track.push(step(1, 0), 1000);
    track.push(step(2, 20), 1100);
    // seq 3 never arrives.
    track.push(step(4, 60), 1300);
    const frames = render(track, 1000, 1500);
    expect(biggestJump(frames)).toBeLessThan(8);
    expect(frames[frames.length - 1]!.x).toBeGreaterThan(20);
  });

  it("snaps across a teleport rather than sliding through the wall between", () => {
    const track = new RemoteTrack();
    track.push(step(1, 0), 1000);
    track.push(step(2, 10), 1100);
    track.push(step(3, 600, 400), 1200);
    const frames = render(track, 1000, 1500);
    const midpoints = frames.filter((f) => f.x > 50 && f.x < 550);
    expect(midpoints).toHaveLength(0);
  });

  it("snaps rather than interpolates when the peer changes map", () => {
    const track = new RemoteTrack();
    track.push(step(1, 0), 1000);
    track.push(step(2, 20), 1100);
    track.push(step(3, 20, 0, { map: "cave" }), 1200);
    const after = track.sample(1400);
    expect(after?.map).toBe("cave");
  });

  it("holds them still once they stop, rather than drifting on", () => {
    const track = new RemoteTrack();
    track.push(step(1, 0), 1000);
    track.push(step(2, 40), 1200);
    track.push(step(3, 60, 0, { moving: false }), 1400);
    const a = track.sample(3000);
    const b = track.sample(9000);
    expect(a!.x).toBe(60);
    expect(b!.x).toBe(60);
    expect(b!.moving).toBe(false);
  });
});

describe("drawing a peer at the slow relay rate", () => {
  it("stays smooth at the rate the relay fallback actually sends", () => {
    const track = new RemoteTrack();
    // 300ms apart, which is what the relay path sends. The render delay used to
    // be capped below that, so the renderer ran off the end of the buffer
    // between updates and the character stuttered by construction.
    for (let i = 0; i < 10; i++) track.push(step(i + 1, i * 24), 1000 + i * 300);
    const frames = render(track, 1300, 3400);
    expect(frames.length).toBeGreaterThan(60);
    expect(biggestJump(frames)).toBeLessThan(6);
  });

  it("does not stall between updates at that rate", () => {
    const track = new RemoteTrack();
    for (let i = 0; i < 8; i++) track.push(step(i + 1, i * 24), 1000 + i * 300);
    // Count how many frames are identical to the one before: a renderer that
    // has run out of buffer holds still and then snaps.
    const frames = render(track, 1400, 2800);
    let held = 0;
    for (let i = 1; i < frames.length; i++) {
      if (frames[i]!.x === frames[i - 1]!.x) held++;
    }
    expect(held / frames.length).toBeLessThan(0.5);
  });
});

describe("deciding when to report ourselves", () => {
  const at = (over: Partial<{ x: number; moving: boolean; dir: 1 | -1; map: string }> = {}) => ({
    x: 0, y: 0, dir: 1 as const, moving: true, map: "home", ...over,
  });

  it("reports the first state it sees", () => {
    expect(new LocalTrack(50).tick(0, at())).not.toBeNull();
  });

  it("holds its tongue between intervals", () => {
    const t = new LocalTrack(50);
    t.tick(0, at());
    expect(t.tick(20, at({ x: 5 }))).toBeNull();
    expect(t.tick(60, at({ x: 12 }))).not.toBeNull();
  });

  it("goes quiet while standing still, but not silent", () => {
    const t = new LocalTrack(50);
    t.tick(0, at({ moving: false }));
    // Nothing for a while: the peer already knows where they are standing.
    expect(t.tick(500, at({ moving: false }))).toBeNull();
    expect(t.tick(2000, at({ moving: false }))).toBeNull();
    // But it does speak eventually. Total silence let a phone's idle
    // connection be closed underneath us, and the other player turned back
    // into an NPC on the far screen.
    expect(t.tick(9000, at({ moving: false }))).not.toBeNull();
  });

  it("speaks up the moment they stop, so the peer stops them too", () => {
    const t = new LocalTrack(50);
    t.tick(0, at());
    expect(t.tick(10, at({ moving: false }))).not.toBeNull();
  });

  it("speaks up on a turn without waiting for the interval", () => {
    const t = new LocalTrack(50);
    t.tick(0, at());
    expect(t.tick(5, at({ dir: -1 }))).not.toBeNull();
  });

  it("speaks up on a map change", () => {
    const t = new LocalTrack(50);
    t.tick(0, at({ moving: false }));
    expect(t.tick(5, at({ moving: false, map: "cave" }))).not.toBeNull();
  });

  it("numbers its updates so the peer can drop stragglers", () => {
    const t = new LocalTrack(50);
    const a = t.tick(0, at())!;
    const b = t.tick(100, at({ x: 9 }))!;
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it("changes rate with the carrier without restarting the numbering", () => {
    const t = new LocalTrack(50);
    const a = t.tick(0, at())!;
    t.setInterval(300);
    expect(t.tick(100, at({ x: 5 }))).toBeNull();
    const b = t.tick(400, at({ x: 9 }))!;
    expect(b.seq).toBe(a.seq + 1);
  });
});

describe("the shape of the path it walks", () => {
  it("passes through the points it was given", () => {
    const track = new RemoteTrack();
    // An L: straight along x, then a right-angle turn down y.
    const pts = [[0, 0], [30, 0], [60, 0], [60, 30], [60, 60]];
    pts.forEach(([x, y], i) => track.push(step(i + 1, x!, y!), 1000 + i * 200));
    // Sampled densely, the drawn line should come very close to each waypoint
    // rather than rounding the corner off entirely.
    const frames = render(track, 1000, 2200, 8);
    for (const [x, y] of pts.slice(1, -1)) {
      const nearest = Math.min(...frames.map((f) => Math.hypot(f.x - x!, f.y - y!)));
      expect(nearest).toBeLessThan(6);
    }
  });

  it("does not swing wide of the corner it is turning", () => {
    const track = new RemoteTrack();
    const pts = [[0, 0], [30, 0], [60, 0], [60, 30], [60, 60]];
    pts.forEach(([x, y], i) => track.push(step(i + 1, x!, y!), 1000 + i * 200));
    const frames = render(track, 1000, 2200, 8);
    // A curve that overshoots is what puts somebody inside a wall. Nothing
    // drawn should stray far outside the box the waypoints describe.
    for (const f of frames) {
      expect(f.x).toBeGreaterThan(-8);
      expect(f.x).toBeLessThan(68);
      expect(f.y).toBeGreaterThan(-8);
      expect(f.y).toBeLessThan(68);
    }
  });

  it("keeps a straight walk straight", () => {
    const track = new RemoteTrack();
    for (let i = 0; i < 8; i++) track.push(step(i + 1, i * 30, 0), 1000 + i * 200);
    const frames = render(track, 1200, 2200);
    // A curve through collinear points must not wander off the line.
    for (const f of frames) expect(Math.abs(f.y)).toBeLessThan(0.001);
  });

  it("still snaps a teleport rather than curving across the map", () => {
    const track = new RemoteTrack();
    track.push(step(1, 0), 1000);
    track.push(step(2, 20), 1200);
    track.push(step(3, 700, 500), 1400);
    track.push(step(4, 720, 500), 1600);
    const frames = render(track, 1000, 1800);
    const between = frames.filter((f) => f.x > 60 && f.x < 650);
    expect(between).toHaveLength(0);
  });
});
