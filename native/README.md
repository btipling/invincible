# native/ — Zig build inputs (Phase 2)

Placeholder Wasm for the Invincible harness pipeline. **Not** the dvui UI (Phase 3).

| File | Role |
|------|------|
| `ZIG_VERSION` | Pinned compiler (must match runner) |
| `hello.zig` | Minimal `export fn add` |
| `build.sh` | Emit `dist/hello.wasm` |

```bash
./native/build.sh
```

CI: `.github/workflows/build-wasm.yml` on self-hosted `[self-hosted, invincible, zig]`.
