#!/usr/bin/env python3
"""Rebuild native/harness/src/fonts/DejaVuSans-symbols.ttf from DejaVu Sans.

Glyphs: code points in selected symbol blocks that exist in DejaVu but not in
Noto Sans Regular (body face). Used when paint routes isSymbolRelated → symbols face.

Usage:
  python3 scripts/build-dejavu-symbols-subset.py /path/to/DejaVuSans.ttf
"""
from __future__ import annotations

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
NOTO = ROOT / "native/harness/src/fonts/NotoSans-Regular.ttf"
OUT = ROOT / "native/harness/src/fonts/DejaVuSans-symbols.ttf"

RANGES = [
    (0x2190, 0x21FF),
    (0x2200, 0x22FF),
    (0x2300, 0x23FF),
    (0x25A0, 0x25FF),
    (0x2600, 0x26FF),
    (0x2700, 0x27BF),
    (0x27F0, 0x27FF),
    (0x2900, 0x297F),
    (0x2B00, 0x2BFF),
]


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    src = Path(sys.argv[1])
    noto = TTFont(NOTO).getBestCmap()
    dejavu = TTFont(src).getBestCmap()
    want = {
        cp
        for a, b in RANGES
        for cp in range(a, b + 1)
        if cp in dejavu and cp not in noto
    }
    if 0x2192 not in want:
        raise SystemExit("U+2192 missing from subset plan — check source font")
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = True
    options.recalc_timestamp = False
    font = TTFont(src)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=sorted(want))
    subsetter.subset(font)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    font.save(OUT)
    cmap = TTFont(OUT).getBestCmap()
    print(f"wrote {OUT} bytes={OUT.stat().st_size} glyphs={len(cmap)}")


if __name__ == "__main__":
    main()
