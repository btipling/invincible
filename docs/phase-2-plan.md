# Phase 2 plan — DO self-hosted build runner

Tracking is on GitHub (source of truth):

- **Board:** https://github.com/users/btipling/projects/1/views/1
- **Milestone:** https://github.com/btipling/invincible/milestone/2
- **Epic issue:** [#9](https://github.com/btipling/invincible/issues/9)

## Outcome

A DigitalOcean droplet runs a GitHub Actions self-hosted runner with a pinned Zig toolchain, proven by a smoke workflow and a placeholder Wasm artifact. Vercel remains deploy-only for the Next.js app.

## Issue map

| Step | Issue | Delivers |
|------|--------|----------|
| 2.1 | Provision DO droplet | Machine |
| 2.2 | Register GHA runner | `runs-on` target |
| 2.3 | Zig pin + wasm target | Compiler |
| 2.4 | Smoke workflow | Proof |
| 2.5 | Placeholder Wasm + artifact | Pipeline for Phase 3 |
| 2.6 | `docs/runner.md` | Ops / recovery |
| 2.7 | Hardening + cost | Safe boring box |

## Architecture

```text
push / workflow_dispatch
        → GitHub Actions on DO self-hosted runner
        → zig build (wasm)
        → Actions artifact
        → (Phase 3) ship Wasm with Vercel Next app
```

## Definition of done

- Runner Online with labels `self-hosted,linux,x64,invincible,zig`
- Smoke workflow green via `workflow_dispatch`
- `.wasm` artifact from CI
- `docs/runner.md` complete
- No secrets in git

## Explicit non-goals

- dvui / harness UI (Phase 3)
- AI Gateway changes
- Building Zig inside Vercel


Phase 2.5 artifact name: `hello-wasm` (file `hello.wasm`).
