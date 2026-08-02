# native/ — Zig build inputs

| Path | Phase | Role |
|------|-------|------|
| `ZIG_VERSION` | 2+ | Pinned compiler (must match runner) |
| `hello.zig` + `build.sh` | 2.5 | Placeholder `export fn add` → `dist/hello.wasm` |
| `dvui-spike/` | **3.1** | Minimal **dvui web** → Wasm harness proof |

## Hello (Phase 2)

```bash
./native/build.sh   # → native/dist/hello.wasm
```

## dvui spike (Phase 3.1)

Requires Zig **0.16.0**, outbound GitHub (fetches dvui), ~400 MB peak RAM.

```bash
./native/dvui-spike/build.sh   # → native/dist/dvui-spike/{web.wasm,web.js,index.html}
```

CI: `.github/workflows/build-dvui-spike.yml` on `[self-hosted, invincible, zig]`.

Spike notes: [`docs/phase-3-dvui-spike.md`](../docs/phase-3-dvui-spike.md).
