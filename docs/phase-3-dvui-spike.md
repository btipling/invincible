# Phase 3.1 — dvui Wasm spike notes

**Issue:** [#16](https://github.com/btipling/invincible/issues/16)  
**Date:** 2026-08-02  
**Runner:** `invincible-do-1` · Zig **0.16.0** · labels `self-hosted,invincible,zig`  
**Decision:** **Proceed with dvui web backend** — no Zig bump, no canvas-only fallback.

---

## Compatibility

| Item | Result |
|------|--------|
| dvui + Zig 0.16.0 | **OK** — `minimum_zig_version = "0.16.0"`; README: “Tested with Zig v0.16.0” |
| Pin used | `david-vanderson/dvui` `@4f810ef1d695b55fb714a13536a930b9304d619e` (main, spike day) |
| zon hash | `dvui-0.5.0-dev-AQFJmXxd_QAJS310eGUEjF5iOYHn4QlPT26rwBriRHE0` |
| Target | `wasm32-freestanding` |
| Backend | `-Dbackend=web` / `.backend = .web` |
| libc / FreeType on web | **off** (stb_truetype + stb_image; no freetype) |
| Entry | `entry = .disabled`; exports: `dvui_init`, `dvui_deinit`, `dvui_update`, … |

Zig **0.16** CLI note: release mode is `--release=small` (not `-Doptimize=ReleaseSmall`).

---

## Build (Invincible)

```bash
# on invincible-do-1 or any Zig 0.16.0 host with network
./native/dvui-spike/build.sh
# → native/dist/dvui-spike/{web.wasm,web.js,index.html}
```

| Artifact | Approx size (ReleaseSmall) | Notes |
|----------|----------------------------|--------|
| `web.wasm` | **~1.3 MB** (1 365 046 B local) | Minimal UI (title + button + click counter) |
| `web.js` | **~55 KB** | dvui web glue (WebGL1/2) |
| `index.html` | **~0.7 KB** | canvas + `import { dvui } from "./web.js"` |
| Upstream `web-app` demo | ~6.2 MB wasm | Full `Examples.demo(.full)` + optional ~5.9 MB Noto CJK font |

Peak compile RSS observed locally: ~**370 MB** (fits 4 GB droplet). First build fetches dvui + svg2tvg + stb sources (~minutes); cached rebuild ~10–15 s.

CI workflow: `.github/workflows/build-dvui-spike.yml` → artifact **`dvui-spike-wasm`**.

---

## Browser APIs required

From `dvui` `src/backends/web.js` / `web.zig`:

| API | Role |
|-----|------|
| **WebAssembly** | `instantiateStreaming(fetch(…), { dvui: imports })` preferred; fallback non-streaming |
| **Canvas 2D host surface** | `<canvas id="dvui-canvas">` full viewport |
| **WebGL2** (preferred) or **WebGL1** | Immediate-mode triangle/textured draw |
| **fetch** | Load `.wasm` (and optional fonts via JS) |
| Pointer / keyboard / wheel / touch | Events → `add_event` export |
| `requestAnimationFrame`-style loop | Driven by `dvui_update` wait ms |

**Not required for spike:** WebGPU, SharedArrayBuffer, threads, WASI, local FS.

Serve over **HTTP(S)** (module scripts + streaming compile). `file://` will not work.

---

## Link / compile flags (effective)

- Target: `wasm32-freestanding`
- Optimize: `ReleaseSmall` + strip
- `link_libc = false`
- `single_threaded = true` (web backend)
- Export symbols (backend): `dvui_init`, `dvui_deinit`, `dvui_update`, `add_event`, `arena_u8`, `gpa_u8`, `gpa_free`, `new_font`
- stb compiled with `STBI_NO_STDLIB`, `STBI_NO_SIMD`, custom libc stubs

---

## Load strategy (for 3.4+ Vercel static)

| Concern | Recommendation |
|---------|----------------|
| Transfer size | ~1.3 MB wasm + 55 KB js — gzip/brotli on CDN typically cuts wasm substantially |
| Compile | Prefer **`WebAssembly.instantiateStreaming`** (dvui default when `Content-Type` is wasm) |
| Caching | Long-cache hashed filenames under `/harness/` or `?v=` / content-hash query (dvui’s cache-buster template optional) |
| Fonts | Default embedded stb fonts enough for Latin MVP; skip shipping Noto CJK unless needed (~6 MB) |
| Memory | Browser Wasm linear memory grows as UI runs; no disk as SoT (product constraint) |
| Host page | Next.js static file or `public/harness/*` after CI artifact copy (issue #19/#20) |

---

## Fallback decision

**No fallback.** dvui + Zig 0.16.0 web backend builds and is the Phase 3 UI path.

If a future dvui main breaks 0.16: pin the commit in `native/dvui-spike/build.zig.zon` (and later crate zon) before upgrading Zig.

Not chosen:

- Zig upgrade beyond 0.16.0 (unnecessary)
- Thin canvas + hand-rolled Zig UI (higher cost, no immediate gain)
- FreeType on web (disabled by design; stb_truetype OK)

---

## Layout in repo

```text
native/dvui-spike/
  build.zig / build.zig.zon   # web backend dep + wasm exe
  build.sh                    # pin check + stage to native/dist/dvui-spike
  src/main.zig                # minimal exported frame loop
  static/index.html           # canvas host
```

Phase 2 `hello.wasm` pipeline remains for smoke; harness product path is **dvui-spike** → later `native/harness` (3.2+).

---

## CI proof (invincible-do-1)

| | |
|--|--|
| Workflow | `build-dvui-spike.yml` |
| Run | [30771681826](https://github.com/btipling/invincible/actions/runs/30771681826) (push `3d9e431`) |
| Host | `invincible-do-1` · runner 2.336.0 |
| Duration | ~1m42s (warm caches after first fetch) |
| Artifact | **`dvui-spike-wasm`**: `web.wasm` 1 365 046 B · `web.js` 56 149 B · `index.html` 673 B |

## Acceptance checklist

- [x] Spike notes (`docs/phase-3-dvui-spike.md`)
- [x] Green CI job producing dvui spike `.wasm` on `invincible-do-1`
- [x] Size + load strategy recorded
- [x] Compatibility with Zig 0.16.0 confirmed — **no bump**
