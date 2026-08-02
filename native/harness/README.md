# native/harness — Invincible agent harness (Zig + dvui)

Durable Zig crate for the in-browser harness. Built on **`invincible-do-1`** (Zig **0.16.0**).

## Relation to other `native/` targets

| Path | Status | Role |
|------|--------|------|
| `hello.zig` + root `build.sh` | Phase 2 probe | Tiny `add` export → `hello.wasm`. **Keep for runner smoke**; not the product UI. |
| `dvui-spike/` | Phase 3.1 research | One-off spike notes + minimal UI. Superseded by this crate for product work. |
| **`harness/` (this)** | **Phase 3 product** | dvui web → **`harness.wasm`** + `web.js` + host HTML. |

Deprecation plan: once `/harness` ships in production (3.5+), freeze `hello` as CI probe only; archive or delete `dvui-spike` after a milestone if unused.

## Build

```bash
# requires zig == $(cat ../ZIG_VERSION), outbound GitHub for dvui fetch (first time)
./build.sh
# → native/dist/harness/{harness.wasm,web.js,index.html,web.wasm}
```

Zig 0.16 release flag: `--release=small` (used by `build.sh`).

CI: `.github/workflows/build-harness.yml` → artifact **`harness-wasm`**.

## Export surface (JS ↔ Wasm)

Host is dvui’s `web.js`. Required exports (provided by app + backend):

| Export | Role |
|--------|------|
| `dvui_init(platform_ptr, platform_len) → i32` | Create backend + window (`0` = ok) |
| `dvui_deinit()` | Tear down |
| `dvui_update() → i32` | One frame; return wait ms (`-1` quit) |
| `add_event` / `arena_u8` / `gpa_u8` / `gpa_free` / `new_font` | Backend memory + input (from dvui web backend) |

App code: `src/main.zig` (lifecycle) · `src/ui.zig` (frames). Later issues add a thinner JS bridge (#21) and Gateway calls via host `fetch` to `/api/chat` (no secrets in Wasm).

## Browser requirements

WebAssembly, Canvas, WebGL1/2, `fetch`. Serve over HTTP(S). See [`docs/phase-3-dvui-spike.md`](../../docs/phase-3-dvui-spike.md).
