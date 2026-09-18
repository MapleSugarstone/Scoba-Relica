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

# Font units per art pixel. A whole power of two keeps every square on a round
# number and the em a size every rasterizer is happy with.
UNIT = 64

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


def pixels(font: ImageFont.FreeTypeFont, ch: str) -> tuple[list[tuple[int, int]], int, int, int]:
    """Which pixels a character lights, its advance, and where the ink sits:
    how far in from the pen and how far down from the top of the line."""
    mask = font.getmask(ch, mode="L")
    w, h = mask.size
    # Where the ink starts, which is not the pen: a letter is set in from it by
    # its own bearing, and ignoring that runs every letter into the last.
    left, top = font.getbbox(ch)[:2]
    lit = []
    for y in range(h):
        for x in range(w):
            # Half coverage or more is a pixel, which is the same call a
            # rasterizer makes when it has no greys to spend.
            if mask.getpixel((x, y)) >= 128:
                lit.append((x, y))
    return lit, round(font.getlength(ch)), left, top


def square(pen: TTGlyphPen, x: int, y: int) -> None:
    """One art pixel, as a square contour in font units."""
    x0, y0 = x * UNIT, y * UNIT
    pen.moveTo((x0, y0))
    pen.lineTo((x0 + UNIT, y0))
    pen.lineTo((x0 + UNIT, y0 + UNIT))
    pen.lineTo((x0, y0 + UNIT))
    pen.closePath()


def build(ttf: str, out: str, name: str, em: int) -> None:
    pil = ImageFont.truetype(ttf, em)
    ascent, descent = pil.getmetrics()

    glyphs: dict[str, object] = {}
    widths: dict[str, int] = {}
    order = [".notdef"]
    cmap: dict[int, str] = {}

    pen = TTGlyphPen(None)
    glyphs[".notdef"] = pen.glyph()
    widths[".notdef"] = em // 2 * UNIT

    for ch in CHARS:
        gname = f"u{ord(ch):04X}"
        lit, advance, left, top = pixels(pil, ch)
        pen = TTGlyphPen(None)
        for x, y in lit:
            # PIL counts rows down from the top of the drawn box; a font counts
            # up from the baseline.
            square(pen, left + x, ascent - top - y - 1)
        glyphs[gname] = pen.glyph()
        widths[gname] = advance * UNIT
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
        for size in SIZES:
            out = os.path.join(OUT, f"relica-{size}-{tag}.woff2")
            build(tmp, out, f"Relica {size}", size * ART_PER_CSS)
            print(f"wrote {out}  (sampled at {size * ART_PER_CSS} art px, shown at {size} CSS px)")
        os.remove(tmp)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
