// Where the other player is, and how that is made to look right.
//
// Two halves. `LocalTrack` decides when this client is worth reporting, which
// keeps the relay fallback affordable without changing how the peer-to-peer
// path behaves. `RemoteTrack` turns whatever arrives into smooth motion.
//
// The remote character is drawn slightly in the past on purpose. Extrapolating
// forward from the last known heading shows the peer at their true position but
// guesses wrong every time they turn, and the correction reads as a stumble.
// Holding a small buffer and interpolating between two samples we already have
// is never wrong, and a fifth of a second of lag on someone walking beside you
// is not something anyone sees.

export interface Step {
  /** Monotonic per sender. The channel is unordered, so this drops stragglers. */
  seq: number;
  x: number;
  y: number;
  dir: 1 | -1;
  moving: boolean;
  /** Which map they are on. They may not be on ours. */
  map: string;
}

export interface Placed {
  x: number;
  y: number;
  dir: 1 | -1;
  moving: boolean;
  map: string;
}

/** Beyond this a sample is a teleport, not a walk, and is snapped to. */
const SNAP_DISTANCE = 96;

/** How far behind live to render, as a multiple of the observed gap. */
const DELAY_FACTOR = 1.6;
const MIN_DELAY_MS = 60;
/**
 * Has to comfortably exceed the slowest send interval in use, or the renderer
 * runs off the end of the buffer between updates: it holds the newest sample,
 * then snaps when the next lands, which is exactly the stutter this whole
 * arrangement exists to avoid. It was 260ms while the relay sent every 300ms,
 * so on the fallback path it was broken by construction.
 */
const MAX_DELAY_MS = 700;

/** Enough to cover a couple of dropped packets without hoarding stale ones. */
const MAX_SAMPLES = 12;

interface Timed extends Step {
  /** Local arrival, so no clock agreement between the two machines is needed. */
  at: number;
}

export class RemoteTrack {
  private samples: Timed[] = [];
  private lastSeq = -1;
  private gaps: number[] = [];
  private lastArrival = 0;

  /** True once anything has been heard from the peer. */
  get live(): boolean {
    return this.samples.length > 0;
  }

  /**
   * Take one update. `now` is a local clock; the sender's is never consulted,
   * which is what keeps this free of clock-skew correction.
   */
  push(step: Step, now: number): void {
    // Unordered delivery means an older packet can arrive after a newer one.
    // Late is worthless here, so it goes in the bin rather than the buffer.
    if (step.seq <= this.lastSeq) return;
    this.lastSeq = step.seq;

    if (this.lastArrival > 0) {
      this.gaps.push(now - this.lastArrival);
      if (this.gaps.length > 8) this.gaps.shift();
    }
    this.lastArrival = now;

    this.samples.push({ ...step, at: now });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** The peer went away; the next sample starts a fresh line rather than a jump. */
  reset(): void {
    this.samples = [];
    this.gaps = [];
    this.lastSeq = -1;
    this.lastArrival = 0;
  }

  /**
   * Adapts to whatever rate is actually arriving, so the same renderer looks
   * right on a 20Hz data channel and on a 3Hz relay fallback.
   */
  private delay(): number {
    if (this.gaps.length === 0) return MIN_DELAY_MS;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, median * DELAY_FACTOR));
  }

  /** Where to draw them now, or null if nothing has been heard yet. */
  sample(now: number): Placed | null {
    if (this.samples.length === 0) return null;
    const target = now - this.delay();
    const newest = this.samples[this.samples.length - 1]!;

    // Nothing old enough to interpolate within: hold the oldest we have rather
    // than inventing a position in front of it.
    const oldest = this.samples[0]!;
    if (target <= oldest.at) return placedOf(oldest);

    // Past the newest sample, which happens when updates stop, either because
    // they stood still or because the connection went quiet. Holding still is
    // right for the first and honest for the second.
    if (target >= newest.at) return placedOf(newest);

    for (let i = this.samples.length - 1; i > 0; i--) {
      const b = this.samples[i]!;
      const a = this.samples[i - 1]!;
      if (target < a.at || target > b.at) continue;
      if (a.map !== b.map) return placedOf(b);
      const span = b.at - a.at;
      const f = span <= 0 ? 1 : (target - a.at) / span;
      // A jump this big is a teleport tile, not a walk. Interpolating it would
      // slide the character through whatever is between the two doors.
      if (Math.hypot(b.x - a.x, b.y - a.y) > SNAP_DISTANCE) return placedOf(b);
      // The neighbours on either side are what bend the line into a walk. Where
      // there is no neighbour, the end point stands in for it, which leaves the
      // ends straight rather than curling them.
      const before = this.samples[i - 2] ?? a;
      const after = this.samples[i + 1] ?? b;
      // A teleport either side would drag the curve across the map, so those
      // stretches stay straight.
      const wild = Math.hypot(a.x - before.x, a.y - before.y) > SNAP_DISTANCE ||
        Math.hypot(after.x - b.x, after.y - b.y) > SNAP_DISTANCE ||
        before.map !== b.map || after.map !== b.map;
      const at = wild
        ? { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
        : curvePoint(before, a, b, after, f);
      return {
        x: at.x,
        y: at.y,
        dir: f < 0.5 ? a.dir : b.dir,
        moving: b.moving || a.moving,
        map: b.map,
      };
    }
    return placedOf(newest);
  }
}

function placedOf(s: Timed): Placed {
  return { x: s.x, y: s.y, dir: s.dir, moving: s.moving, map: s.map };
}

/**
 * A point on a curve through four samples, between the middle two.
 *
 * Straight lines between the points are a polyline, and at the relay's rate the
 * corners in it are visible: the character changes direction in a single frame
 * every time an update lands, which reads as a series of small flinches rather
 * than a walk. A curve through the same points bends the way somebody walking
 * a corner does.
 *
 * Centripetal parameterisation (the square root of the distances) rather than
 * uniform, because uniform overshoots on a sharp turn and can throw the
 * character through the inside of a corner, which is exactly the sort of thing
 * that puts them in a wall.
 */
function curvePoint(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  u: number,
): { x: number; y: number } {
  const knot = (a: { x: number; y: number }, b: { x: number; y: number }, t: number): number =>
    t + Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));
  const t0 = 0;
  const t1 = knot(p0, p1, t0);
  const t2 = knot(p1, p2, t1);
  const t3 = knot(p2, p3, t2);
  // Repeated points collapse a span to zero. Nothing to curve through, so the
  // straight line is both correct and safe from dividing by it.
  if (t1 === t0 || t2 === t1 || t3 === t2) {
    return { x: p1.x + (p2.x - p1.x) * u, y: p1.y + (p2.y - p1.y) * u };
  }
  const t = t1 + (t2 - t1) * u;
  const mix = (
    a: { x: number; y: number }, b: { x: number; y: number },
    ta: number, tb: number,
  ): { x: number; y: number } => {
    const k = (tb - t) / (tb - ta);
    const j = (t - ta) / (tb - ta);
    return { x: a.x * k + b.x * j, y: a.y * k + b.y * j };
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

export interface LocalState {
  x: number;
  y: number;
  dir: 1 | -1;
  moving: boolean;
  map: string;
}

/**
 * Decides when this client is worth reporting. The rate is set by whoever owns
 * the carrier: a direct connection costs nothing per message and can afford to
 * be chatty, while the relay fallback is billed and should not be.
 */
/**
 * Standing perfectly still used to mean saying nothing at all, which is cheap
 * and wrong: a phone behind carrier NAT has its idle connection closed within
 * tens of seconds, and the first anyone knew was the other player turning back
 * into an NPC. A word every few seconds costs almost nothing and keeps the
 * connection from being tidied away underneath us.
 */
const IDLE_HEARTBEAT_MS = 4000;

export class LocalTrack {
  private seq = 0;
  private lastSentAt = -Infinity;
  private last: LocalState | null = null;

  constructor(private intervalMs: number) {}

  /** Swapped when the carrier changes, without losing the sequence. */
  setInterval(ms: number): void {
    this.intervalMs = ms;
  }

  /** A step to send, or null when nothing has changed worth saying. */
  tick(now: number, state: LocalState): Step | null {
    const prev = this.last;
    const changed = !prev ||
      prev.moving !== state.moving ||
      prev.dir !== state.dir ||
      prev.map !== state.map;
    const due = state.moving
      ? now - this.lastSentAt >= this.intervalMs
      // Standing still still says so occasionally. The peer already knows
      // where they are; this is to stop the connection going quiet enough to
      // be closed by something in the middle.
      : now - this.lastSentAt >= IDLE_HEARTBEAT_MS;
    if (!changed && !due) return null;

    this.lastSentAt = now;
    this.last = { ...state };
    this.seq += 1;
    return {
      seq: this.seq, x: state.x, y: state.y,
      dir: state.dir, moving: state.moving, map: state.map,
    };
  }
}
