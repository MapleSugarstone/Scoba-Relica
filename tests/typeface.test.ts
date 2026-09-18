import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The writing is bitmap: one face sampled per size, at the art's own
 * resolution. A face shown at the size it was sampled at puts every one of its
 * pixels on a whole device pixel. Shown at anything else it is resampled, and a
 * fraction such as 12 in the 18 face drops and doubles whole rows, which reads
 * as lines drawn through the letters.
 *
 * Nothing in CSS ties a size to a face, so every rule that sets one has to name
 * the other, and these tests are what makes that hold.
 */

const STYLE_DIR = fileURLToPath(new URL("../src/styles", import.meta.url));
const STYLES: Record<string, string> = Object.fromEntries(
  readdirSync(STYLE_DIR)
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, readFileSync(`${STYLE_DIR}/${f}`, "utf8")]),
);
const FONTS = readdirSync(fileURLToPath(new URL("../assets/Fonts", import.meta.url)));

/** What the body is set in, so a rule at this size needs no face of its own. */
const BODY = 12;

interface Rule {
  where: string;
  sel: string;
  size: string | null;
  fam: string | null;
}

/**
 * Every innermost block in the stylesheets, one entry per selector in a list.
 * A block's body cannot hold braces, so a rule nested in an at-rule is read
 * and the at-rule around it is not.
 */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const [where, text] of Object.entries(STYLES)) {
    const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, head = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const size = /font-size:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? null;
      const fam = /font-family:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? null;
      if (!size && !fam) continue;
      for (const sel of head.split(",")) {
        const one = sel.trim().replace(/\s+/g, " ");
        if (one.startsWith("@")) continue;
        out.push({ where, sel: one, size, fam });
      }
    }
  }
  return out;
}

/** The size a family is sampled for, or null for anything that is not a face. */
function faceOf(fam: string | null): number | null {
  const m = fam && /Relica (\d+)/.exec(fam);
  return m ? Number(m[1]) : null;
}

/** A selector's compounds, each as the set of simple selectors in it. */
function compounds(sel: string): string[][] {
  return sel
    .split(/\s*[>+~]\s*|\s+/)
    .filter(Boolean)
    .map((part) => part.match(/[.#]?[^.#:[\s]+(?:\[[^\]]*\])?/g) ?? []);
}

/**
 * Whether `outer` reaches the elements `inner` styles: the same elements, or
 * their ancestors. True when `outer`'s compounds appear in `inner`'s in order
 * and each one asks for no more than the compound facing it, which covers both
 * `.bcard .nm` against `.bcard.bplate .nm` and against `.bcard .nm .lv`.
 */
function reaches(outer: string, inner: string): boolean {
  const a = compounds(outer);
  const b = compounds(inner);
  let i = 0;
  for (const bc of b) {
    const ac = a[i];
    if (ac && ac.every((part) => bc.includes(part))) i++;
  }
  return i === a.length;
}

const all = rules();
const sized = (r: Rule) => (r.size && /^(\d+)px$/.test(r.size) ? Number(r.size.slice(0, -2)) : null);

describe("writing at a size it was sampled for", () => {
  it("names a whole px size and the face that goes with it", () => {
    const wrong = all
      .filter((r) => r.size !== null)
      .filter((r) => {
        const px = sized(r);
        if (px === null) return true;
        if (r.fam === "inherit") return false;
        if (r.fam) return faceOf(r.fam) !== px;
        return px !== BODY;
      })
      .map((r) => `${r.where}  ${r.sel}  ${r.size} / ${r.fam ?? "no face"}`);
    expect(wrong).toEqual([]);
  });

  it("does not leave the body's size under a rule that switched face", () => {
    const switched = all.filter((r) => faceOf(r.fam) !== null && faceOf(r.fam) !== BODY);
    const wrong: string[] = [];
    for (const r of all) {
      if (r.fam || sized(r) !== BODY) continue;
      for (const a of switched) {
        if (reaches(a.sel, r.sel)) wrong.push(`${r.where}  ${r.sel}  ${r.size} under ${a.sel} set in ${a.fam}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("does not switch face under a rule that set another size", () => {
    const wrong: string[] = [];
    for (const r of all) {
      if (r.size || faceOf(r.fam) === null) continue;
      for (const a of all) {
        const px = sized(a);
        if (px === null || a.sel === r.sel || !reaches(a.sel, r.sel)) continue;
        if (faceOf(r.fam) !== px) wrong.push(`${r.where}  ${r.sel}  ${r.fam} under ${a.sel} set at ${a.size}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  // Everything above lets a 12 px rule go without naming a face because the
  // page is set in it. The page once named the face and not the size, and
  // text with no size of its own came out at the browser's 16 px instead.
  it("sets the page in the size and face a bare rule relies on", () => {
    const page = all.find((r) => r.sel === "body");
    expect(page?.size).toBe(`${BODY}px`);
    expect(faceOf(page?.fam ?? null)).toBe(BODY);
  });

  it("reads every stylesheet", () => {
    expect(Object.keys(STYLES).length).toBeGreaterThanOrEqual(3);
    expect(all.length).toBeGreaterThan(50);
  });

  it("has a sampled file behind every face it names", () => {
    const named = new Set(all.map((r) => faceOf(r.fam)).filter((n): n is number => n !== null));
    expect(named.size).toBeGreaterThan(0);
    for (const size of named) {
      expect(FONTS.some((f) => f.startsWith(`relica-${size}-`))).toBe(true);
    }
  });
});
