# Builtin HTTPS fetch (agent)

Optional **native agent tools** (`http_get`, `http_head`) that retrieve public
HTTPS pages during a harness agent turn. Egress for the **target URL** runs in a
**durable user HTTP/curl Vercel Sandbox instance** (or a host-configured attach
name when tenancy is off) — not as an open proxy from the Next.js route handler,
and not via the BYO path-jailed workspace daemon.

Related: [sandbox.md](sandbox.md) · [mcp.md](mcp.md) · [feature-divide.md](feature-divide.md) ·
[SECURITY.md](../SECURITY.md) · [bring-your-own.md](bring-your-own.md)

---

## 1. What it is / is not

| | |
|--|--|
| **Is** | Server-side AI SDK tools on `POST /api/agent` |
| **Is** | Target fetch inside a **Vercel Sandbox** microVM (isolated network) after app-side SSRF policy |
| **Is** | Env-gated (`BUILTIN_HTTP_FETCH=sandbox`); default **off** |
| **Is** | **Attach-only** to a durable **HTTP/curl instance** the user created under **Settings → Sandbox** (tenancy on), or to `BUILTIN_HTTP_INSTANCE_NAME` (tenancy off) |
| **Is not** | The BYO sandbox daemon (`list_dir` / `read_file` / `write_file` / `exec`) |
| **Is not** | The **Workspace** FS instance — hop-B uses a **separate** named microVM (`purpose=http`) |
| **Is not** | Create-on-turn or create-on-fetch — the agent **never** `Sandbox.create` / `getOrCreate` for HTTP |
| **Is not** | Per-user remote MCP (Exa etc.) — that remains [mcp.md](mcp.md) |
| **Is not** | Browser or Wasm fetch of arbitrary agent URLs |
| **Is not** | POST/PUT/DELETE, or a public MCP server |

---

## 2. Trust boundary (hop A / hop B)

```text
User (Wasm composer)
  → host POST /api/agent
  → app SSRF policy (https-only, no private/metadata hosts)
  → Hop A: app → Vercel Sandbox control plane (OIDC on Vercel)
       attach: Sandbox.get({ name, resume: true }) + best-effort extendTimeout
  → Hop B: durable HTTP microVM → target URL (curl `--max-redirs 0`; app follows redirects hop-by-hop)
  → body truncated / content-type filtered → model + toolTrace
  → turn end: release handle (extendTimeout); **never** stop/delete the durable VM
```

- **Gateway keys**, **sandbox tokens**, and **MCP secrets** never enter the microVM env or the client/Wasm.
- Policy runs **before** each hop. Curl does **not** auto-follow (`--max-redirs 0`); the app follows **≤5** redirects only after re-running SSRF policy on each `Location`.
- Lifecycle Create/Start/Stop/Destroy for the HTTP instance is **Settings only** — see [sandbox.md](sandbox.md) (user instances).

---

## 3. Enablement

| Env | Values | Default |
|-----|--------|---------|
| `BUILTIN_HTTP_FETCH` | `off` \| `sandbox` | `off` |
| `BUILTIN_HTTP_TIMEOUT_MS` | 1–1800000 | `120000` (per fetch) |
| `BUILTIN_HTTP_MAX_BYTES` | ≤ 16 MiB | `2 MiB` |
| `BUILTIN_HTTP_INSTANCE_NAME` | durable instance name | empty — **tenancy off only** |

Set on the **Vercel project** (server-only). No `NEXT_PUBLIC_*`.

Idle extendTimeout for the attached VM uses the same **30 minute** family as Workspace instances (not a short ephemeral create timeout).

### Operator steps (tenancy on)

1. Deploy a build that includes builtin HTTP.
2. Vercel → Project → Environment Variables → set `BUILTIN_HTTP_FETCH=sandbox`.
3. Confirm the Vercel team can use **Vercel Sandbox** (product entitlement).
4. In the product: **Settings → Sandbox → HTTP / curl instance → Create** (once).
5. Smoke from the harness: ask the agent to fetch `https://example.com` and summarize.
6. Expect a short toolTrace system line (`http_get · ✓ ok · …`) and a grounded assistant reply.
7. If the HTTP instance is missing/stopped, the turn **omits** http tools (FS/MCP may still run) — the agent does **not** create a VM.
8. Disable: set `BUILTIN_HTTP_FETCH=off` (or unset) and redeploy.

### Operator steps (tenancy off)

1. Set `BUILTIN_HTTP_FETCH=sandbox`.
2. Set **`BUILTIN_HTTP_INSTANCE_NAME`** to an existing durable sandbox name in the **host** Vercel project (create that VM out of band / with host tooling — the agent never creates).
3. If the name is empty while builtin is on → agent returns a **config error** (fail closed; no create).
4. Optional: keep BYO `SANDBOX_URL`/`SANDBOX_TOKEN` for FS tools independently.

Cloud agents may use `vercel link` + `vercel env pull` in the **agent workspace** for OIDC smoke — not a human laptop requirement.

---

## 4. Coexistence matrix

| Tenancy | Workspace FS | Builtin HTTP | Agent route |
|---------|--------------|--------------|-------------|
| off | missing | off | **503** exact not-configured string → host falls back to chat |
| off | missing | on + instance name | Agent OK — **http tools only** (attach) |
| off | missing | on + **no** name | **503** config error (`BUILTIN_HTTP_INSTANCE_REQUIRED`) |
| off | present (`SANDBOX_*`) | on + name | FS tools + http attach |
| on | grant OK + Workspace running | on + HTTP running | FS tools + http + MCP |
| on | Workspace missing/stopped | on + HTTP running | Soft-continue: **http ± MCP**, no FS |
| on | grant OK + Workspace running | on + HTTP missing/stopped | FS ± MCP; **http tools omitted** |
| on | grant deny | on + HTTP running | **http ± MCP** only |
| on | grant deny | on + HTTP missing | **403** grant (no tools assembled) |

Host chat fallback still triggers **only** on HTTP **503** with the exact
`SANDBOX_NOT_CONFIGURED_ERROR` string when builtin is off and no BYO sandbox.

---

## 5. Budgets

| Knob | Value |
|------|--------|
| Route `maxDuration` | 1800s (30m; Vercel max) |
| Attaches per agent request | ≤ 1 HTTP instance (single-flight get) |
| Idle auto-stop | ~30 minutes without extendTimeout use |
| Per-fetch timeout | default 2 min (env clamp) |
| Hop-B transfer cap | curl `--max-filesize` = per-fetch `maxBytes` |
| Model-facing result | `TOOL_RESULT_MAX_CHARS` (8192) |
| Redirect hops | ≤ **5** (policy-checked each) |

---

## 6. SSRF & content policy

- https only; no URL userinfo
- Block private / link-local / metadata hosts (literal + DNS **preflight** on the app)
- Curl `--max-redirs 0`; app hop-by-hop follow (≤5) with `assertSafePublicHttps` on every `Location`
- Bodies returned only for text-ish types (`text/*`, JSON, XML, `+json`/`+xml`)
- Soft-fail tool strings (`ERROR http_get: …`); never throw into the route

### Residual risk (v1)

Preflight DNS on the app is **not** an IP pin for hop B. The HTTP instance uses
`networkPolicy: allow-all` at Create and curl re-resolves the hostname. A malicious
short-TTL name can answer public during policy check and private/link-local
during fetch (classic DNS rebinding). v1 accepts this residual; do not claim
“SSRF impossible.”

---

## 7. Source map

| Concern | Path |
|---------|------|
| Env parse | `lib/agent/builtinHttpConfig.ts` |
| URL policy | `lib/net/publicUrlPolicy.ts` |
| Tools | `lib/agent/httpFetchTools.ts` |
| Attach-only runner | `lib/agent/vercelSandboxHttpRunner.ts` |
| Instance lifecycle | `lib/tenancy/userSandboxInstance.ts` (Settings Create) |
| Route merge + finally release | `app/api/agent/route.ts` |
| Optional FS tools | `lib/agent/runAgent.ts` |
