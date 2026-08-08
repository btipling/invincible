# Harness embedded fonts

| File | Family | Role | License |
|------|--------|------|---------|
| `NotoSans-Regular.ttf` / `NotoSans-Bold.ttf` / `NotoSans-Italic.ttf` / `NotoSans-BoldItalic.ttf` | Noto Sans | body / bold / italic / bold+italic | SIL OFL 1.1 (Google Noto) |
| `OpenMoji-subset.ttf` | OpenMoji | emoji / pictographs (outline B&W) | CC BY-SA 4.0 (OpenMoji) |
| `DejaVuSans-symbols.ttf` | DejaVu Sans Symbols | text arrows / math ops / dingbats **missing from Noto** (e.g. →) | Bitstream Vera / DejaVu (see below) |
| `VeraMono.ttf` / `VeraMoBd.ttf` | Vera Sans Mono | fences / inline code | Bitstream Vera |

## Attribution

- **Noto Sans** © Google — [SIL Open Font License 1.1](https://scripts.sil.org/OFL)
- **OpenMoji** — design by OpenMoji, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). This repo ships a **glyph-subset** of the black outline (`OpenMoji-black-glyf`) build for Wasm size.
- **DejaVu Sans** (symbols subset) — derived from Bitstream Vera; DejaVu changes are public domain. Subset rebuilt via `scripts/build-dejavu-symbols-subset.py`.
- **Bitstream Vera Sans Mono** — Bitstream Vera license (bundled with dvui historically)

## Coverage honesty

- Noto Sans: Latin, Greek, Cyrillic, and broad European punctuation — **not** full CJK; **not** the Unicode Arrows block (U+2190–U+21FF). Four faces: Regular, Bold, Italic, Bold Italic (rich MD emph/strong compose).
- DejaVu symbols subset: arrows (including **→**), tool status **✓**/**✗**, many math operators and geometric/dingbat code points that Noto omits. Paint routes via `isSymbolRelated` in `rich/unicode_face.zig` (check/ballot marks are carved out of the emoji face so they do not tofu).
- OpenMoji subset: common emoji + modifiers (ZWJ, VS16, skin tones, regional indicators). Color emoji and perfect ZWJ family glyphs depend on the shaper; FreeType/stb outline path is monochrome single-glyph.
- CJK (e.g. 日本語) may still missing-glyph until a CJK face is added.
- Mono (Vera) still lacks arrows — fence code with `→` may still tofu; body/system/tool lines use mixed body+symbols.

## Rebuild symbols subset

```bash
# Obtain DejaVuSans.ttf (e.g. dejavu-fonts-ttf release), then:
python3 scripts/build-dejavu-symbols-subset.py /path/to/DejaVuSans.ttf
```
