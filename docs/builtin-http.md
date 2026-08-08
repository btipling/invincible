# Builtin HTTPS fetch (agent)

Optional **native agent tools** (`http_get`, `http_head`) that retrieve public
HTTPS pages during a harness agent turn. Egress for the **target URL** runs in a
**Vercel Sandbox** microVM — not as an open proxy from the Next.js route handler,
and not via the DigitalOcean path-jailed workspace daemon.

Related: [sandbox.md](sandbox.md) · [mcp.md](mcp.md) · [feature-divide.md](feature-divide.md) ·
[SECURITY.md](../SECURITY.md) · [bring-your-own.md](bring-your-own.md)

---

## 1. What it is / is not

| | |
|--|--|
| **Is** | Server-side AI SDK tools on `POST /api/agent` |
| **Is** | Target fetch inside **Vercel Sandbox** (isolated network) after app-side SSRF policy |
| **Is** | Env-gated (`BUILTIN_HTTP_FETCH=sandbox`); default **off** |
| **Is not** | The DO / BYO sandbox daemon (`list_dir` / `read_file` / `write_file` / `exec`) |
| **Is not** | Per-user remote MCP (Exa etc.) — that remains [mcp.md](mcp.md) |
| **Is not** | Browser or Wasm fetch of arbitrary agent URLs |
| **Is not** | POST/PUT/DELETE, or a public MCP server |

## 2. Trust boundary (hop A / hop B)

```text
User (Wasm composer)
  → host POST /api/agent
  → app SSRF policy (https-only, no private/metadata hosts)
  → Hop A: app → Vercel Sandbox control plane (OIDC on Vercel)
  → Hop B: Sandbox microVM → target URL (curl `--max-redirs 0`; app follows redirects hop-by-hop)
  → body truncated / content-type filtered → model + toolTrace
```

- **Gateway keys**, **sandbox tokens**, and **MCP secrets** never enter the microVM env or the client/Wasm.
- Policy runs **before** each hop. Curl does **not** auto-follow (`--max-redirs 0`); the app follows **≤5** redirects only after re-running SSRF policy on each `Location`.

## 3. Enablement

| Env | Values | Default |
|-----|--------|---------|
| `BUILTIN_HTTP_FETCH` | `off` \| `sandbox` | `off` |
| `BUILTIN_HTTP_TIMEOUT_MS` | 1–20000 | `10000` (per fetch) |
| `BUILTIN_HTTP_MAX_BYTES` | ≤ 256 KiB | `65536` |
| `BUILTIN_HTTP_SANDBOX_TIMEOUT_MS` | 5000–55000 | `55000` (VM lifetime) |

Set on the **Vercel project** (server-only). No `NEXT_PUBLIC_*`.

### Operator steps (timeless)

1. Deploy a build that includes builtin HTTP.
2. Vercel → Project → Environment Variables → set `BUILTIN_HTTP_FETCH=sandbox` (Production / Preview as needed).
3. Confirm the Vercel team can use **Vercel Sandbox** (product entitlement on the team — see Vercel docs; do not invent pricing).
4. Smoke from the harness: ask the agent to fetch `https://example.com` and summarize.
5. Expect a short toolTrace system line (`http_get · ✓ ok · …`) and a grounded assistant reply.
6. Disable: set `BUILTIN_HTTP_FETCH=off` (or unset) and redeploy.

Cloud agents may use `vercel link` + `vercel env pull` in the **agent workspace** for OIDC smoke — not a human laptop requirement.

## 4. Coexistence matrix

| Tenancy | DO / BYO workspace | Builtin HTTP | Agent route |
|---------|--------------------|--------------|-------------|
| off | missing | off | **503** exact not-configured string → host falls back to chat |
| off | missing | on | Agent OK — **http tools only** |
| off | present | on/off | FS tools ± http |
| on | grant OK | on/off | FS tools ± http ± user MCP |
| on | grant deny | off | **403** sandbox access denied |
| on | grant deny | on | Agent OK — **http ± user MCP** (no FS tools) |

Host chat fallback still triggers **only** on HTTP **503** with the exact
`SANDBOX_NOT_CONFIGURED_ERROR` string when builtin is off and no DO sandbox.

## 5. Budgets

| Knob | Value |
|------|--------|
| Route `maxDuration` | 3600s (1h) |
| VMs per agent request | ≤ 1 (single-flight create) |
| Sandbox VM lifetime | ≤ 55s (`persistent: false`) |
| Per-fetch timeout | default 10s, max 20s |
| Hop-B transfer cap | curl `--max-filesize` = per-fetch `maxBytes` (default 64 KiB) |
| Model-facing result | `TOOL_RESULT_MAX_CHARS` (8192) |
| Redirect hops | ≤ **5** (policy-checked each) |

## 6. SSRF & content policy

- https only; no URL userinfo
- Block private / link-local / metadata hosts (literal + DNS **preflight** on the app)
- Curl `--max-redirs 0`; app hop-by-hop follow (≤5) with `assertSafePublicHttps` on every `Location` (blocks private/metadata redirect targets)
- Bodies returned only for text-ish types (`text/*`, JSON, XML, `+json`/`+xml`)
- Soft-fail tool strings (`ERROR http_get: …`); never throw into the route

### Residual risk (v1)

Preflight DNS on the app is **not** an IP pin for hop B. The microVM uses
`networkPolicy: allow-all` and curl re-resolves the hostname. A malicious
short-TTL name can answer public during policy check and private/link-local
during fetch (classic DNS rebinding). v1 accepts this residual; do not claim
“SSRF impossible.” Future hardening options: pin with `curl --resolve`, or a
Sandbox egress policy that denies RFC1918 / link-local ranges when available.

## 7. Source map

| Concern | Path |
|---------|------|
| Env parse | `lib/agent/builtinHttpConfig.ts` |
| URL policy | `lib/net/publicUrlPolicy.ts` |
| Tools | `lib/agent/httpFetchTools.ts` |
| Sandbox runner | `lib/agent/vercelSandboxHttpRunner.ts` |
| Route merge + finally close | `app/api/agent/route.ts` |
| Optional FS tools | `lib/agent/runAgent.ts` |
