"""Samples an outline font onto the pixel grid the game's art is drawn on.

A browser antialiases an outline glyph whatever a stylesheet asks of it, and
there is no way left to turn that off. A font whose glyphs are already whole
pixels sidesteps it: each lit pixel becomes a square in the outline, so at the
size it was sampled at, and at whole multiples of that size, every edge lands
on a pixel boundary and there is nothing for the browser to blend.

Run from the repo root:

    python tools/pixelfont.py

It reads the bundled Nunito and writes assets/Fonts/, which the stylesheet
picks up. A letter the sampler gets wrong can be drawn by hand in the face's
file under tools/glyphs/, and the build takes that drawing instead. Nothing at runtime depends on this script; it is the thing that made
the files.
"""
from __future__ import annotations

import os
import sys

from collections import Counter

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.fontBuilder import FontBuilder
from PIL import ImageFont

# The sizes the interface writes at, in CSS px, and the weights each is written
# in. One face is sampled per size and weight, at the number of art pixels that
# size actually covers, so every face is shown at exactly the size it was drawn
# at.
#
# A face shown at a whole multiple of its own size is still sharp, but each of
# its pixels becomes a block of that many, which reads as crunchy rather than as
# writing. Smooth and sharp at once means sampling at the size it will be shown
# at, so a size gets a face rather than a scale factor.
#
# 52 is the title screen and nothing else, and a heading is bold, so it is the
# one size with no regular cut. A face that large costs as much as the other
# three together.
SIZES = {12: (400, 700), 18: (400, 700), 24: (400, 700), 52: (700,)}

# The art is drawn at four pixels to a world unit and the interface lays out at
# two of those to a CSS px, so a CSS px covers this many art pixels.
ART_PER_CSS = 2

# The gap between two letters, as a share of the em. Every pair gets the same
# one: a typeface spaces its letters by eye for smooth type at reading sizes,
# and those judgements land on whole pixels here as holes between some pairs
# and not others. Even tracking is what reads as even.
TRACK = 1 / 12

# How wide a space is, as a share of the em, since it has no ink to measure.
SPACE = 1 / 6

# Font units per art pixel. A whole power of two keeps every square on a round
# number and the em a size every rasterizer is happy with.
UNIT = 64

# Written out rather than escaped, so the feature text below stays readable.
NL = chr(10)

# Everything the game writes. Sampling the whole of Latin would be a file ten
# times the size for glyphs no screen ever shows.
CHARS = (
    " !\"#$%&'()*+,-./0123456789:;<=>?@"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`"
    "abcdefghijklmnopqrstuvwxyz{|}~"
    "·…—–’‘“”×÷±°"
)

SRC = "node_modules/@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2"
OUT = "assets/Fonts"
# Glyphs drawn by hand, one file per face, named the same as the face it
# replaces letters in. A face with no file is sampled whole.
DRAWN = "tools/glyphs"


def instance(path: str, weight: int, to: str) -> str:
    """One weight of a variable font, written out as a plain TTF."""
    font = TTFont(path)
    font.flavor = None
    if "fvar" in font:
        font = instancer.instantiateVariableFont(font, {"wght": weight})
    font.save(to)
    return to


def pixels(font: ImageFont.FreeTypeFont, ch: str, em: int) -> tuple[set[tuple[int, int]], int]:
    """A character's ink and its width, in art pixels.

    The cells come back with x counted from the letter's own left edge and y
    counted up from the baseline, which is where the rest of this works.

    Asked for in monochrome rather than taken as a threshold of grey. The
    rasterizer grid-fits a stem when it has no greys to spend, so every upright
    of a letter comes out the same width; thresholding its greyscale instead
    left one stem two pixels wide and the next three, by where each happened to
    fall between pixels.

    The ink comes back with the blank columns either side of it taken off. The
    spacing a typeface carries is drawn for smooth type at reading sizes, and
    at this size it reads as holes: the n and w of Unwind sat five pixels apart
    where two letters of the same word should sit as close as any other pair.
    What goes back is the letter, and the caller sets the gap.
    """
    mask, (_, top) = font.getmask2(ch, mode="1")
    w, h = mask.size
    ascent, _ = font.getmetrics()
    cols = [x for x in range(w) if any(mask.getpixel((x, y)) for y in range(h))]
    if not cols:
        # A space carries no ink, so its width is the one thing it is.
        return set(), round(em * SPACE)
    x0, x1 = cols[0], cols[-1]
    lit = {
        (x - x0, ascent - top - y - 1)
        for y in range(h)
        for x in range(x0, x1 + 1)
        if mask.getpixel((x, y))
    }
    return lit, x1 - x0 + 1


def rests(src: TTFont, ch: str, em: int) -> bool:
    """Whether the character is drawn sitting on the baseline.

    Read off the outline rather than guessed from the sample, so a descender
    and a quote mark are never mistaken for one. The tolerance is the overshoot
    a round letter is drawn with, which the rasterizer pulls back onto the line
    anyway.
    """
    cmap = src.getBestCmap()
    if ord(ch) not in cmap:
        return False
    glyph = src["glyf"][cmap[ord(ch)]]
    if glyph.numberOfContours == 0:
        return False
    return abs(glyph.yMin) <= src["head"].unitsPerEm * 0.02


def level(drawn: dict[str, set[tuple[int, int]]], sitting: set[str]) -> int:
    """Pulls a letter that missed the baseline by one pixel back onto it.

    The rasterizer aligns each letter to the grid on its own, and now and then
    it puts one a pixel off: the bold r sat a pixel above the line at every
    size, over the x-height at the top and off the line at the bottom, which is
    visible in a word. What the others agree on is the line.
    """
    feet = Counter(min(y for _, y in drawn[ch]) for ch in sitting if drawn[ch])
    if not feet:
        return 0
    line, _ = feet.most_common(1)[0]
    moved = 0
    for ch in sitting:
        lit = drawn[ch]
        if not lit:
            continue
        foot = min(y for _, y in lit)
        # Only ever a pixel: anything further off is the letter, not a slip.
        if abs(foot - line) == 1:
            drawn[ch] = {(x, y + line - foot) for x, y in lit}
            moved += 1
    return moved


def mend(lit: set[tuple[int, int]]) -> set[tuple[int, int]]:
    """Lights a cell that is dark with ink on three of its four sides.

    A letter drawn three pixels wide has places where the rasterizer leaves a
    single cell out, and a single cell out reads as a nick rather than as a
    shape: the arm of the bold r hung off its stem by a corner, and the bowl of
    the a had a pixel missing from its foot. A counter is never this narrow, so
    nothing that should be open is closed.
    """
    if not lit:
        return lit
    xs = [x for x, _ in lit]
    ys = [y for _, y in lit]
    add = set()
    for x in range(min(xs), max(xs) + 1):
        for y in range(min(ys), max(ys) + 1):
            if (x, y) in lit:
                continue
            sides = sum(1 for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)) if (x + dx, y + dy) in lit)
            if sides >= 3:
                add.add((x, y))
    return lit | add


def by_hand(path: str) -> dict[str, tuple[set[tuple[int, int]], int]]:
    """The glyphs drawn by hand for one face, as ink and width.

    The file format is described at the top of each file in DRAWN. The ink
    comes back in the same terms `pixels()` uses, trimmed to its own columns
    and counted up from the baseline, so a drawn glyph and a sampled one are
    interchangeable.
    """
    if not os.path.exists(path):
        return {}
    blocks: list[tuple[str, int, list[str]]] = []
    with open(path, encoding="utf-8") as f:
        for n, raw in enumerate(f, 1):
            line = raw.rstrip()
            if not line or line.startswith(";"):
                continue
            if line.startswith("glyph "):
                parts = line.split(" ")
                if len(parts) != 3 or len(parts[1]) != 1:
                    raise ValueError(f"{path}:{n}: expected `glyph <character> <bottom row>`")
                blocks.append((parts[1], int(parts[2]), []))
                continue
            if not blocks or set(line) - {"#", "."}:
                raise ValueError(f"{path}:{n}: a row is # and . only, under a `glyph` line")
            blocks[-1][2].append(line)

    glyphs = {}
    for ch, foot, rows in blocks:
        if ch not in CHARS:
            raise ValueError(f"{path}: {ch!r} is not a character the faces carry")
        cols = [x for row in rows for x, v in enumerate(row) if v == "#"]
        if not cols:
            raise ValueError(f"{path}: {ch!r} has no ink")
        x0, x1 = min(cols), max(cols)
        lit = {
            (x - x0, foot + len(rows) - 1 - r)
            for r, row in enumerate(rows)
            for x, v in enumerate(row)
            if v == "#"
        }
        glyphs[ch] = (lit, x1 - x0 + 1)
    return glyphs


def square(pen: TTGlyphPen, x: int, y: int) -> None:
    """One art pixel, as a square contour in font units."""
    x0, y0 = x * UNIT, y * UNIT
    pen.moveTo((x0, y0))
    pen.lineTo((x0 + UNIT, y0))
    pen.lineTo((x0 + UNIT, y0 + UNIT))
    pen.lineTo((x0, y0 + UNIT))
    pen.closePath()


def kerning(src: TTFont, em: int, names: dict[str, str]) -> str:
    """The source font's own kerning, rounded onto the pixel grid.

    Read off its GPOS rather than measured: the layout engine behind the
    rasterizer sets a pair at its plain advances and never sees this, so a pair
    the typeface tightens by hand is otherwise set as wide as one that needs no
    help.

    A pair worth less than half a pixel rounds to nothing, which is most of
    them. What is left is the handful a reader would notice.
    """
    gpos = src["GPOS"].table if "GPOS" in src else None
    if gpos is None:
        return ""
    upem = src["head"].unitsPerEm
    cmap = src.getBestCmap()
    # Which of the font's own glyph names carry the characters being sampled.
    mine = {cmap[ord(ch)]: name for ch, name in names.items() if ord(ch) in cmap}
    pairs = []
    for lookup in gpos.LookupList.Lookup:
        if lookup.LookupType != 2:
            continue
        for st in lookup.SubTable:
            if getattr(st, "Format", None) != 1 or not hasattr(st, "PairSet"):
                continue
            for i, first in enumerate(st.Coverage.glyphs):
                if first not in mine:
                    continue
                for rec in st.PairSet[i].PairValueRecord:
                    if rec.SecondGlyph not in mine:
                        continue
                    step = round(getattr(rec.Value1, "XAdvance", 0) / upem * em)
                    if step != 0:
                        pairs.append(f"    pos {mine[first]} {mine[rec.SecondGlyph]} {step * UNIT};")
    if not pairs:
        return ""
    return "feature kern {" + NL + NL.join(pairs) + NL + "} kern;" + NL


def build(ttf: str, out: str, name: str, em: int, src: TTFont, hand: dict[str, tuple[set[tuple[int, int]], int]]) -> None:
    pil = ImageFont.truetype(ttf, em)
    ascent, descent = pil.getmetrics()
    # Half the gap on each side of every letter, so the space between any two
    # of them is the same whichever two they are.
    track = max(1, round(em * TRACK / 2))

    glyphs: dict[str, object] = {}
    widths: dict[str, int] = {}
    order = [".notdef"]
    cmap: dict[int, str] = {}

    pen = TTGlyphPen(None)
    glyphs[".notdef"] = pen.glyph()
    widths[".notdef"] = em // 2 * UNIT

    # Every letter is sampled before any is drawn, because where the baseline
    # actually came out is whatever most of them agree on.
    drawn = {}
    spans = {}
    for ch in CHARS:
        drawn[ch], spans[ch] = pixels(pil, ch, em)
    level(drawn, {ch for ch in CHARS if rests(src, ch, em)})
    # A glyph drawn by hand is taken exactly as drawn, so nothing after this
    # point second-guesses it.
    for ch, (lit, span) in hand.items():
        drawn[ch], spans[ch] = lit, span

    for ch in CHARS:
        gname = f"u{ord(ch):04X}"
        pen = TTGlyphPen(None)
        cells = drawn[ch] if ch in hand else mend(drawn[ch])
        # Top row first and left to right within a row. A glyph's points are
        # stored as steps from the point before, so squares written in a
        # scrambled order cost four times the file.
        for x, y in sorted(cells, key=lambda cell: (-cell[1], cell[0])):
            # The ink starts one gap in, so a letter has the same room on its
            # left as it leaves on its right.
            square(pen, track + x, y)
        glyphs[gname] = pen.glyph()
        widths[gname] = (spans[ch] + track * 2) * UNIT
        order.append(gname)
        cmap[ord(ch)] = gname

    fb = FontBuilder(em * UNIT, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({g: (widths[g], 0) for g in order})
    fb.setupHorizontalHeader(ascent=ascent * UNIT, descent=-descent * UNIT)
    fb.setupNameTable({
        "familyName": name,
        "styleName": "Regular",
        "psName": name.replace(" ", "") + "-Regular",
    })
    fb.setupOS2(sTypoAscender=ascent * UNIT, sTypoDescender=-descent * UNIT, usWinAscent=ascent * UNIT, usWinDescent=descent * UNIT)
    fb.setupPost()
    fb.font.flavor = "woff2"
    fb.save(out)


def main() -> int:
    if not os.path.exists(SRC):
        print(f"no source font at {SRC}", file=sys.stderr)
        return 1
    os.makedirs(OUT, exist_ok=True)
    for weight, tag in ((400, "regular"), (700, "bold")):
        tmp = os.path.join(OUT, f"_nunito-{weight}.ttf")
        instance(SRC, weight, tmp)
        shaped = TTFont(tmp)
        for size, weights in SIZES.items():
            if weight not in weights:
                continue
            face = f"relica-{size}-{tag}"
            out = os.path.join(OUT, f"{face}.woff2")
            hand = by_hand(os.path.join(DRAWN, f"{face}.txt"))
            build(tmp, out, f"Relica {size}", size * ART_PER_CSS, shaped, hand)
            drew = f", drawn by hand: {''.join(sorted(hand))}" if hand else ""
            print(f"wrote {out}  (sampled at {size * ART_PER_CSS} art px, shown at {size} CSS px{drew})")
        os.remove(tmp)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
