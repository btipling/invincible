# Invincible sandbox daemon (protocol v2)

Standalone HTTP service that exposes a **path-jailed workspace** with agent tools:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | `{ ok: true, version: 2, daemonVersion: N, workspaceRoot?: "/…" }` (no auth) — `workspaceRoot` is the per-binding jail root on daemon ≥ **2**; it is **omitted** when the jail root cannot yet be resolved (liveness/version always stay 200) |
| `POST` | `/v1/list_dir` | List directory entries |
| `POST` | `/v1/read_file` | Read file (max 16 MiB); response includes additive `mtimeMs` + `size` |
| `POST` | `/v1/write_file` | Write file (max 16 MiB); response includes post-write `mtimeMs` + `size` |
| `POST` | `/v1/str_replace` | Exact string replace; response includes post-write `mtimeMs` + `size` |
| `POST` | `/v1/stat` | Path metadata only: `{ path, type, size, mtimeMs? }` (404 if missing; no content; omit `mtimeMs` when unknown) |
| `POST` | `/v1/exec` | Run argv command (no shell); optional `stdin`/`heredoc` |

**Fingerprints (additive):** `mtimeMs` is `Math.trunc(stat.mtimeMs)` when measurable; **omit** (do not invent `0`) when the backend cannot provide it so freshness gates can degrade. `size` is full on-disk byte length (even when `read_file` content is truncated). Old clients may ignore these fields. BYO daemons should ship them so agent freshness checks work. Protocol version stays **v2** (additive JSON only).

**Daemon version (out-of-date gate):** `daemonVersion` is a **separate**, monotonic
daemon revision from `version` (protocol). The Next backend ships an expected
revision and refuses tools on daemons behind it — the daemon answers **426**
`SANDBOX_DAEMON_OUT_OF_DATE` with an exact error string when a request carries an
`X-Invincible-Expected-Daemon-Version` header that is higher than its own revision
(older clients / curls without the header are unaffected). Bump
`INVINCIBLE_SANDBOX_DAEMON_VERSION` here (and the TS mirror
`EXPECTED_SANDBOX_DAEMON_VERSION`) in the same PR that changes the daemon tool
surface / jail / budgets; the parity unit test keeps them from drifting.

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
| `SANDBOX_AUTO_UPDATE` | no | off | Opt-in: git ff-only self-update then exit for `Restart=always` |
| `SANDBOX_GIT_DIR` | yes if auto-update on | — | Repo-root checkout path (contains `sandbox/`) |
| `SANDBOX_GIT_REF` | no | `origin/main` | ff-only merge target after `git fetch`; passed after `--` so a dash-prefixed ref is never treated as a git option |
| `SANDBOX_UPDATE_CHECK_MS` | no | `60000` | Background check interval; `0` disables the timer (header-trigger only); negative / non-numeric values fail closed to `60000` |

Auto-update runs `git status --porcelain` then (only when clean) `git fetch` +
`git merge --ff-only -- <ref>` (argv only, minimal env), advances HEAD, then the
process exits `0` for the supervisor to restart on the new code. Fails closed on
a **dirty** working tree, divergent local work, or git errors (stays up and keeps
serving 426) — and is **single-flight**: a background timer and a request-triggered
out-of-date restart can never run parallel updates concurrently. These env vars
belong on the **daemon process**, not Vercel.

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
# {"ok":true,"version":2,"daemonVersion":2,"workspaceRoot":"/path/to/.sandbox-workspace"}

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

`resolveJailPath` rejects `..` / absolute escapes **and** resolves symlinks: a link whose real target leaves `SANDBOX_WORKSPACE` is rejected. Workspace root must exist on disk. `GET /health` publishes **`resolveWorkspaceRoot(SANDBOX_WORKSPACE)`** (the realpath jail root the daemon actually enforces — a relative/symlinked env string still yields the absolute root); the app client parses it **fail-closed** (only an absolute, control-char-free **canonical** path — not bare `/`, no `..`, no `//` / trailing slash — is accepted; anything else degrades `workspaceRoot` to `null`). Liveness/version discovery is **not** coupled to `realpath`: if the jail root cannot be resolved (missing / not-yet-mounted workspace), `/health` still returns **200 + `version`/`daemonVersion`** with `workspaceRoot` **omitted** — only the first FS tool against the broken root fails, never the version gate.

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
