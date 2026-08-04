# native/ — Zig build inputs

| Path | Role |
|------|------|
| `ZIG_VERSION` | Pinned compiler (must match runner) |
| `hello.zig` + `build.sh` | Placeholder `export fn add` → `dist/hello.wasm` (runner probe) |
| `dvui-spike/` | Research spike; superseded by `harness/` for product |
| **`harness/`** | **Product** dvui web harness → `dist/harness/harness.wasm` |

## Hello (runner probe)

```bash
./native/build.sh   # → native/dist/hello.wasm
```

## Harness (product)

```bash
./native/harness/build.sh   # → native/dist/harness/harness.wasm
```

Requires Zig **0.16.0**, outbound GitHub (dvui fetch), ~400 MB peak RAM.

| CI | Workflow | Artifact |
|----|----------|----------|
| Probe | `build-wasm.yml` | `hello-wasm` |
| Spike | `build-dvui-spike.yml` | `dvui-spike-wasm` |
| **Harness** | **`build-harness.yml`** | **`harness-wasm`** |

Docs: [`harness/README.md`](harness/README.md) · [`docs/runner.md`](../docs/runner.md) · [`docs/feature-divide.md`](../docs/feature-divide.md).
