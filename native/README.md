# native/ — Zig build inputs

| Path | Phase | Role |
|------|-------|------|
| `ZIG_VERSION` | 2+ | Pinned compiler (must match runner) |
| `hello.zig` + `build.sh` | 2.5 | Placeholder `export fn add` → `dist/hello.wasm` (runner probe) |
| `dvui-spike/` | 3.1 | Research spike (see docs); superseded by `harness/` for product |
| **`harness/`** | **3.2+** | **Product** dvui web harness → `dist/harness/harness.wasm` |

## Hello (Phase 2 probe)

```bash
./native/build.sh   # → native/dist/hello.wasm
```

## Harness (Phase 3 product)

```bash
./native/harness/build.sh   # → native/dist/harness/harness.wasm
```

Requires Zig **0.16.0**, outbound GitHub (dvui fetch), ~400 MB peak RAM.

| CI | Workflow | Artifact |
|----|----------|----------|
| Probe | `build-wasm.yml` | `hello-wasm` |
| Spike | `build-dvui-spike.yml` | `dvui-spike-wasm` |
| **Harness** | **`build-harness.yml`** | **`harness-wasm`** |

Docs: [`docs/phase-3-dvui-spike.md`](../docs/phase-3-dvui-spike.md) · [`harness/README.md`](harness/README.md).
