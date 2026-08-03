# Invincible sandbox daemon (protocol v1)

Standalone HTTP service that exposes a **path-jailed workspace** with four tools:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | `{ ok: true, version: 1 }` (no auth) |
| `POST` | `/v1/list_dir` | List directory entries |
| `POST` | `/v1/read_file` | Read file (max 256 KiB) |
| `POST` | `/v1/write_file` | Write file (max 256 KiB) |
| `POST` | `/v1/exec` | Run argv command (no shell) |

Parent plan: [#45](https://github.com/btipling/invincible/issues/45) · Phase 1: [#46](https://github.com/btipling/invincible/issues/46)

This package is **portable BYO** — run anywhere Node runs. The origin DigitalOcean sample (reverse-proxy TLS, Vercel-reachable URL) is documented later in phase 4; **do not** hardcode host IPs here.

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
# {"ok":true,"version":1}

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
| exec `timeoutMs` default | 10_000 |
| exec `timeoutMs` max | 30_000 |
| read/write max bytes | 256 KiB |
| stdout / stderr per exec | 32 KiB each (truncated) |

## exec

Body:

```json
{
  "cmd": "node",
  "args": ["-e", "console.log('hi')"],
  "cwd": ".",
  "timeoutMs": 10000
}
```

- **argv only** — no `shell: true`
- `cwd` is path-jailed under the workspace
- Child env is **minimal** (`PATH`, `HOME`/`TMPDIR` under workspace, locale) — does **not** inherit `SANDBOX_TOKEN` or host secrets
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
