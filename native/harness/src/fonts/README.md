# Harness embedded fonts

| File | Family | Role | License |
|------|--------|------|---------|
| `NotoSans-Regular.ttf` / `NotoSans-Bold.ttf` / `NotoSans-Italic.ttf` / `NotoSans-BoldItalic.ttf` | Noto Sans | body / bold / italic / bold+italic | SIL OFL 1.1 (Google Noto) |
| `OpenMoji-subset.ttf` | OpenMoji | emoji / pictographs (outline B&W) | CC BY-SA 4.0 (OpenMoji) |
| `VeraMono.ttf` / `VeraMoBd.ttf` | Vera Sans Mono | fences / inline code | Bitstream Vera |

## Attribution

- **Noto Sans** © Google — [SIL Open Font License 1.1](https://scripts.sil.org/OFL)
- **OpenMoji** — design by OpenMoji, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). This repo ships a **glyph-subset** of the black outline (`OpenMoji-black-glyf`) build for Wasm size.
- **Bitstream Vera Sans Mono** — Bitstream Vera license (bundled with dvui historically)

## Coverage honesty

- Noto Sans: Latin, Greek, Cyrillic, and broad European punctuation — **not** full CJK. Four faces: Regular, Bold, Italic, Bold Italic (rich MD emph/strong compose).
- OpenMoji subset: common emoji + modifiers (ZWJ, VS16, skin tones, regional indicators). Color emoji and perfect ZWJ family glyphs depend on the shaper; FreeType/stb outline path is monochrome single-glyph.
- CJK (e.g. 日本語) may still missing-glyph until a CJK face is added.
