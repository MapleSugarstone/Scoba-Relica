// The name a hybrid goes by: the front of its mother's species name joined to
// the back of its father's.
//
// Every way of cutting the two names is tried. A few cuts are never allowed,
// and the rest are scored. The weights were fitted to names written by hand, see
// `claude-notes/hybrid-names.md`. A tie goes to the name that sorts first, so
// every client names the same pairing the same way.

/** Letter pairs that make one sound, which a cut never separates. */
const DIGRAPH = /^(qu|sh|ch|th|ph|wh|ck)$/;

/** Consonant pairs that start a syllable together, which the mother's part never ends between. */
const ONSET = /^(bl|cl|fl|gl|pl|br|cr|dr|fr|gr|pr|tr)$/;

/** Whether the letter at `k` is a vowel. A u after a q is part of the consonant. */
function isVowel(s: string, k: number): boolean {
  const c = s[k];
  if (c === undefined) return false;
  if (c === "u" && s[k - 1] === "q") return false;
  return "aeiouy".includes(c);
}

function hasVowel(s: string, from: number, to: number): boolean {
  for (let k = from; k < to; k++) if (isVowel(s, k)) return true;
  return false;
}

/** Where a name's first pair of vowels starts, or -1 where it has none. */
function firstVowelPair(s: string): number {
  for (let k = 0; k + 1 < s.length; k++) if (isVowel(s, k) && isVowel(s, k + 1)) return k;
  return -1;
}

/**
 * How many vowels, or consonants, sit together where the mother's part meets
 * the father's. The qu at the front of the father's part is one consonant.
 */
function runAcross(a: string, i: number, b: string, j: number, vowels: boolean): number {
  let n = 0;
  for (let k = i - 1; k >= 0 && isVowel(a, k) === vowels; k--) n += 1;
  for (let k = j; k < b.length && isVowel(b, k) === vowels; k++) {
    if (!(b[k] === "u" && b[k - 1] === "q")) n += 1;
  }
  return n;
}

/** How many vowel sounds a name has from `from` on, counting a run of vowels as one. */
function vowelSounds(s: string, from: number): number {
  let n = 0;
  for (let k = from; k < s.length; k++) if (isVowel(s, k) && !isVowel(s, k - 1)) n += 1;
  return n;
}

/**
 * Whether the father's part starts too far inside a consonant cluster in the
 * middle of his name: two consonant sounds in where it starts on a consonant,
 * three where it starts on a vowel. A doubled letter or a letter pair that makes
 * one sound counts once. A cluster at the front of his name is his first
 * syllable and can be cut anywhere.
 */
function deepInCluster(b: string, j: number): boolean {
  let sounds = 0;
  let k = j - 1;
  while (k >= 0 && !isVowel(b, k)) {
    if (k > 0 && (b[k - 1] === b[k] || DIGRAPH.test(b.slice(k - 1, k + 1)))) k -= 1;
    sounds += 1;
    k -= 1;
  }
  if (k < 0) return false;
  return sounds >= (isVowel(b, j) ? 3 : 2);
}

/** A hybrid's name, from its mother's species name and its father's. */
export function blendNames(mother: string, father: string): string {
  const a = mother.toLowerCase();
  const b = father.toLowerCase();
  if (a === b) return mother;
  const pair = firstVowelPair(b);
  const fatherSounds = vowelSounds(b, 0);
  let best: { name: string; score: number } | null = null;
  for (let i = 2; i < a.length; i++) {
    const around = a.slice(i - 1, i + 1);
    if (!hasVowel(a, 0, i) || DIGRAPH.test(around) || ONSET.test(around)) continue;
    for (let j = 1; j < b.length - 1; j++) {
      if (!hasVowel(b, j, b.length) || DIGRAPH.test(b.slice(j - 1, j + 1)) || deepInCluster(b, j)) continue;
      const x = a[i - 1]!;
      const y = b[j]!;
      // The father's vowel pair stays whole, unless the mother's part ends in
      // the letter that was cut off it.
      if (isVowel(b, j - 1) && isVowel(b, j) && x !== b[j - 1]) continue;
      // Two parts may meet on a doubled letter, but never on a tripled one, and
      // the only vowels that double are e and o.
      if (x === y && (a[i - 2] === x || b[j + 1] === y)) continue;
      if (x === y && isVowel(a, i - 1) && x !== "e" && x !== "o") continue;
      const name = a.slice(0, i) + b.slice(j);
      if (name === a || name === b) continue;

      let score = 0;
      if (x === y) score += 1;
      else if (isVowel(a, i - 1) !== isVowel(b, j)) score += 0.5;
      else score -= 1;
      if (runAcross(a, i, b, j, false) > (x === y ? 3 : 2)) score -= 3;
      if (runAcross(a, i, b, j, true) > 2) score -= 3;
      // Enough of each parent is kept to recognize it.
      score -= 4 * Math.abs(i / a.length - 0.6);
      score -= 3 * Math.abs((b.length - j) / b.length - 0.5);
      score -= 0.4 * Math.abs(name.length - (a.length + b.length) / 2);
      // The father's part starts on a syllable where it can. A pair like sh
      // or qu is one consonant here, so shake and queen are whole syllables.
      const onset = DIGRAPH.test(b.slice(j, j + 2)) ? 2 : 1;
      if (!isVowel(b, j) && isVowel(b, j + onset)) score += 0.5;
      if (a[i - 1] === a[i]) score -= 1;
      if (pair >= 0 && j <= pair) score += 2;
      // A father with three vowel sounds or more keeps two of them.
      if (fatherSounds >= 3 && vowelSounds(b, j) >= 2) score += 0.5;
      if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && name < best.name)) {
        best = { name, score };
      }
    }
  }
  const out = best?.name ?? a;
  return out.charAt(0).toUpperCase() + out.slice(1);
}
