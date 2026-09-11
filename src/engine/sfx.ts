// Sound: drawn samples out of `assets/Sounds` where there are any, and tiny
// synthesized blips for the interface noises nobody has recorded. Both ride
// the one volume, so the slider means the same thing for either.
let ac: AudioContext | null = null;

// Samples come straight from `assets/Sounds`: drop an mp3 in there and it is
// available under its lower-cased file name, which is the key a move points at
// with `sound` and a species with `cry`. Each is levelled to one loudness as it
// decodes, so a file does not have to be mastered before it goes in the folder.
const SOUND_FILES = import.meta.glob("../../assets/Sounds/*.mp3", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

const SOUND_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(SOUND_FILES).map(([path, url]) => [
    path.split("/").pop()!.replace(/\.mp3$/i, "").toLowerCase(),
    url,
  ]),
);

/** Decoded samples with the gain that brings each one to a common loudness. */
const decoded = new Map<string, { buf: AudioBuffer; gain: number }>();
const loading = new Set<string>();

/** The loudness every sample is levelled to, as a root mean square amplitude. */
const TARGET_RMS = 0.16;
/**
 * The highest a levelled sample's loudest point may reach. Raising a sample is
 * capped here rather than at the target, so a recording with one sharp spike in
 * it comes out a little under instead of distorting.
 */
const MAX_PEAK = 1;
/** A window below this share of the loudest one counts as tail rather than sound. */
const LOUD_GATE = 0.1;
const WINDOW_SECONDS = 0.05;
const GAIN_FLOOR = 0.2;
const GAIN_CEILING = 6;

/**
 * How much to scale a decoded sample so it is as loud as every other one.
 * Measured over short windows with the quiet ones dropped, because a recording
 * that ends in a long tail is not a quiet recording, and limited by the
 * loudest point so that raising a quiet sample cannot clip it.
 */
export function levelGain(channels: Float32Array[], sampleRate: number): number {
  if (channels.length === 0) return 1;
  const span = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS));
  const length = channels[0]!.length;
  const windows: number[] = [];
  let peak = 0;
  for (let start = 0; start < length; start += span) {
    const stop = Math.min(length, start + span);
    let sum = 0;
    for (const data of channels) {
      for (let i = start; i < stop; i++) {
        const v = data[i]!;
        sum += v * v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
    windows.push(sum / ((stop - start) * channels.length));
  }
  const loudest = Math.max(...windows);
  if (loudest <= 0) return 1;
  const body = windows.filter((w) => w >= loudest * LOUD_GATE);
  const rms = Math.sqrt(body.reduce((a, b) => a + b, 0) / body.length);
  const gain = Math.min(TARGET_RMS / rms, MAX_PEAK / peak);
  return Math.max(GAIN_FLOOR, Math.min(GAIN_CEILING, gain));
}

function channelsOf(buf: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c));
  return out;
}

/**
 * Two levels, 0 to 1, kept between visits. Nothing plays music yet, so that
 * one is only stored: whatever ends up playing it reads `musicVolume`.
 */
const KEYS = { sound: "scoba-skeeple-vol-sound", music: "scoba-skeeple-vol-music" };

function stored(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
  } catch {
    return fallback;
  }
}

let soundVol = stored(KEYS.sound, 0.8);
let musicVol = stored(KEYS.music, 0.6);

function keep(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    // A browser that refuses storage still holds the level for this visit.
  }
}

function ctx(): AudioContext | null {
  if (!ac) {
    try {
      ac = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ac.state === "suspended") void ac.resume();
  return ac;
}

function blip(freq: number, dur: number, type: OscillatorType, vol: number): void {
  if (soundVol <= 0) return;
  const a = ctx();
  if (!a) return;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol * soundVol, a.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
  osc.connect(gain).connect(a.destination);
  osc.start();
  osc.stop(a.currentTime + dur);
}

const clamp = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * A sample ready to play, fetching and levelling it if this is the first time
 * it has been asked for. Returns null while that is still going on.
 */
function load(name: string): { buf: AudioBuffer; gain: number } | null {
  const key = name.toLowerCase();
  const held = decoded.get(key);
  if (held) return held;
  const url = SOUND_URLS[key];
  const a = ctx();
  if (!url || !a || loading.has(key)) return null;
  loading.add(key);
  void fetch(url)
    .then((r) => r.arrayBuffer())
    .then((bytes) => a.decodeAudioData(bytes))
    .then((b) => decoded.set(key, { buf: b, gain: levelGain(channelsOf(b), b.sampleRate) }))
    .catch(() => undefined)
    .finally(() => loading.delete(key));
  return null;
}

/**
 * Plays a drawn sample. One that is not decoded yet is dropped rather than
 * queued: a cry arriving after the Scoba it belongs to has left the screen is
 * worse than no cry at all.
 */
function sample(name: string, vol = 1): boolean {
  if (soundVol <= 0) return false;
  const held = load(name);
  const a = ctx();
  if (!held || !a) return false;
  const src = a.createBufferSource();
  const gain = a.createGain();
  src.buffer = held.buf;
  gain.gain.value = vol * soundVol * held.gain;
  src.connect(gain).connect(a.destination);
  src.start();
  return true;
}

/**
 * Pulls every sample in and levels it, so the first time one is asked for it
 * is ready. A browser refuses to start an audio context until the page has
 * been touched, so this waits for that first touch: without it the opening
 * cast of every move is silent and only the second one is heard.
 */
export function warmSounds(): void {
  const pull = (): void => {
    for (const name of Object.keys(SOUND_URLS)) load(name);
  };
  if (ac?.state === "running") {
    pull();
    return;
  }
  const once = (): void => {
    window.removeEventListener("pointerdown", once);
    window.removeEventListener("keydown", once);
    pull();
  };
  window.addEventListener("pointerdown", once);
  window.addEventListener("keydown", once);
}

export const sfx = {
  volume: (): number => soundVol,
  setVolume: (v: number): void => {
    soundVol = clamp(v);
    keep(KEYS.sound, soundVol);
  },
  musicVolume: (): number => musicVol,
  setMusicVolume: (v: number): void => {
    musicVol = clamp(v);
    keep(KEYS.music, musicVol);
  },
  /** A call answered: two notes up, the second landing as the poof does. */
  summon: (): void => {
    blip(392, 0.12, "triangle", 0.07);
    window.setTimeout(() => blip(659, 0.22, "triangle", 0.08), 120);
  },
  /**
   * A drawn sample by name, with a blip to fall back on for anything that has
   * none. Returns whether a sample actually played, so a caller that wants a
   * different fallback can tell.
   */
  play: (name: string | undefined, vol = 1): boolean =>
    name !== undefined && sample(name, vol),
  tap: () => blip(660, 0.08, "square", 0.05),
  confirm: () => blip(880, 0.14, "triangle", 0.08),
  back: () => blip(330, 0.1, "square", 0.05),
  talk: () => blip(520, 0.05, "square", 0.04),
};
