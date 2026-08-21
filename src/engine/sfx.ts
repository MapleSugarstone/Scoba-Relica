// Placeholder sounds: tiny synthesized blips, no audio files needed.
let ac: AudioContext | null = null;

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
  tap: () => blip(660, 0.08, "square", 0.05),
  confirm: () => blip(880, 0.14, "triangle", 0.08),
  back: () => blip(330, 0.1, "square", 0.05),
  talk: () => blip(520, 0.05, "square", 0.04),
};
