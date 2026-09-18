"""Samples an outline font onto the pixel grid the game's art is drawn on.

A browser antialiases an outline glyph whatever a stylesheet asks of it, and
there is no way left to turn that off. A font whose glyphs are already whole
pixels sidesteps it: each lit pixel becomes a square in the outline, so at the
size it was sampled at, and at whole multiples of that size, every edge lands
on a pixel boundary and there is nothing for the browser to blend.

Run from the repo root:

    python tools/pixelfont.py

It reads the bundled Nunito and writes assets/Fonts/, which the stylesheet
picks up. Nothing at runtime depends on this script; it is the thing that made
the files.
"""
from __future__ import annotations

import os
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.fontBuilder import FontBuilder
from PIL import ImageFont

# The sizes the interface writes at, in CSS px. One face is sampled for each,
# at the number of art pixels that size actually covers, so every face is shown
# at exactly the size it was drawn at.
#
# A face shown at a whole multiple of its own size is still sharp, but each of
# its pixels becomes a block of that many, which reads as crunchy rather than as
# writing. Smooth and sharp at once means sampling at the size it will be shown
# at, so a size gets a face rather than a scale factor.
SIZES = (12, 18, 24)

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


def instance(path: str, weight: int, to: str) -> str:
    """One weight of a variable font, written out as a plain TTF."""
    font = TTFont(path)
    font.flavor = None
    if "fvar" in font:
        font = instancer.instantiateVariableFont(font, {"wght": weight})
    font.save(to)
    return to


def pixels(font: ImageFont.FreeTypeFont, ch: str, em: int) -> tuple[list[tuple[int, int]], int, int]:
    """A character's ink, its width, and how far down from the top of the line
    it sits.

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
    cols = [x for x in range(w) if any(mask.getpixel((x, y)) for y in range(h))]
    if not cols:
        # A space carries no ink, so its width is the one thing it is.
        return [], round(em * SPACE), top
    x0, x1 = cols[0], cols[-1]
    lit = [(x - x0, y) for y in range(h) for x in range(x0, x1 + 1) if mask.getpixel((x, y))]
    return lit, x1 - x0 + 1, top


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


def build(ttf: str, out: str, name: str, em: int, src: TTFont) -> None:
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

    for ch in CHARS:
        gname = f"u{ord(ch):04X}"
        lit, width, top = pixels(pil, ch, em)
        pen = TTGlyphPen(None)
        for x, y in lit:
            # PIL counts rows down from the top of the drawn box; a font counts
            # up from the baseline. The ink starts one gap in, so a letter has
            # the same room on its left as it leaves on its right.
            square(pen, track + x, ascent - top - y - 1)
        glyphs[gname] = pen.glyph()
        widths[gname] = (width + track * 2) * UNIT
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
        for size in SIZES:
            out = os.path.join(OUT, f"relica-{size}-{tag}.woff2")
            build(tmp, out, f"Relica {size}", size * ART_PER_CSS, shaped)
            print(f"wrote {out}  (sampled at {size * ART_PER_CSS} art px, shown at {size} CSS px)")
        os.remove(tmp)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
