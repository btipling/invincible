# Invincible sandbox daemon (protocol v2)

Standalone HTTP service that exposes a **path-jailed workspace** with agent tools:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | `{ ok: true, version: 2 }` (no auth) |
| `POST` | `/v1/list_dir` | List directory entries |
| `POST` | `/v1/read_file` | Read file (max 16 MiB) |
| `POST` | `/v1/write_file` | Write file (max 16 MiB) |
| `POST` | `/v1/str_replace` | Exact string replace |
| `POST` | `/v1/exec` | Run argv command (no shell); optional `stdin`/`heredoc` |

Parent plan: [#45](https://github.com/btipling/invincible/issues/45) · Phase 1: [#46](https://github.com/btipling/invincible/issues/46)

This package is **portable BYO** — run anywhere Node runs.

**Operator guide (BYO, Vercel, verify, security):** [`docs/sandbox.md`](../docs/sandbox.md).

Origin may use a DigitalOcean-hosted sample (reverse-proxy TLS, Vercel-reachable URL); inventory stays private — **do not** hardcode host IPs here.

## Requirements

- Node.js 20+ (developed on 22)
- Linux or macOS recommended (process-group kill on exec timeout uses posix groups)

## Environment

| Name | Required | Default | Notes |
|------|----------|---------|-------|
| `SANDBOX_TOKEN` | **yes** | — | Shared bearer secret (same value Vercel uses as `SANDBOX_TOKEN`) |
| `SANDBOX_WORKSPACE` | **yes** | — | Absolute path to workspace root (jail) |
| `SANDBOX_LISTEN` | no | `127.0.0.1:8787` | Bind address. Localhost is fine behind a reverse proxy |

## Local run

From the repo root (after `npm install`):

```bash
export SANDBOX_TOKEN='dev-secret-change-me'
export SANDBOX_WORKSPACE="$(pwd)/.sandbox-workspace"
mkdir -p "$SANDBOX_WORKSPACE"

npm run sandbox:start
# equivalent:
# node sandbox/server.mjs
```

Smoke:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"version":2}

curl -s -X POST http://127.0.0.1:8787/v1/list_dir \
  -H "Authorization: Bearer $SANDBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## Auth

All `/v1/*` routes require:

```http
Authorization: Bearer <SANDBOX_TOKEN>
```

Missing or wrong token → `401` `{ "error": "Unauthorized" }` (token never reflected).

## Path jail

`resolveJailPath` rejects `..` / absolute escapes **and** resolves symlinks: a link whose real target leaves `SANDBOX_WORKSPACE` is rejected. Workspace root must exist on disk.

## Budgets (locked with parent #45)

| Knob | Value |
|------|--------|
| exec `timeoutMs` default | 300_000 (5 min) |
| exec `timeoutMs` max | 1_800_000 (30 min) |
| read/write max bytes | 16 MiB |
| stdout / stderr / stdin per exec | 4 MiB each (truncated / rejected) |

## exec

Body:

```json
{
  "cmd": "node",
  "args": ["-e", "console.log('hi')"],
  "cwd": ".",
  "timeoutMs": 300000
}
```

Optional **stdin / heredoc** (multi-line input without a shell; **protocol v2+**):

```json
{
  "cmd": "python3",
  "args": ["-"],
  "stdin": "print('hello from heredoc')\n",
  "timeoutMs": 300000
}
```

- **argv only** — no `shell: true`
- Optional `stdin` (or alias `heredoc`) is written to the child process stdin, then closed — safe substitute for shell `<<EOF` heredocs. Prefer `stdin` over `heredoc` when both could apply.
- Stdin cap matches stdout/stderr (`MAX_STDIO_BYTES`, 4 MiB)
- App clients probe `GET /health` and refuse stdin when `version < 2` so stale daemons cannot silently drop the field
- `cwd` is path-jailed under the workspace
- Child env is **minimal** (`PATH`, `HOME`/`TMPDIR` under workspace, locale) — does **not** inherit `SANDBOX_TOKEN` or host secrets. Optional allowlisted overlay (`GH_TOKEN` / `GITHUB_TOKEN`) may be merged by the app client only
- On timeout the process group is killed; response includes `"timedOut": true`

## Production notes

- Prefer binding `127.0.0.1` and terminating TLS on a reverse proxy that Vercel can reach
- Run as a dedicated OS user; never share Actions/GHA credentials with this process
- This is **not** the Zig harness build runner

## Tests

From repo root:

```bash
npm test
```

Sandbox unit tests live in `sandbox/*.test.ts` and run with the rest of the suite.
