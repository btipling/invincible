# Per-user MCP (Model Context Protocol)

Invincible is an MCP **host/client**: signed-in members can register their own
**remote Streamable HTTP** MCP servers. On agent turns those tools merge with
sandbox tools. Secrets stay **server-side under the tenant DEK** — never in the
Wasm canvas, client bundle, or git.

**Not the same as builtin HTTPS fetch.** Optional native `http_get` tools use Vercel Sandbox egress for public pages — see [builtin-http.md](builtin-http.md). User MCP remains the path for third-party remote tools (e.g. Exa).

## What it is

| | |
|--|--|
| **Transport** | HTTPS Streamable HTTP only (no stdio; nothing spawns on the laptop or Vercel filesystem) |
| **Where tools run** | Vercel backend on `POST /api/agent` only — not single-shot `POST /api/chat` |
| **Who configures** | Each user on **Settings → MCP servers** (`/settings/mcp`) |
| **Not Admin** | MCP rows are **per-user**, not a tenant-wide catalog under `/admin` |
| **Tenancy** | Requires tenancy **on** (identity + DEK). Tenancy off → no user MCP |

## Prerequisites

1. **Tenancy triple** on the deploy: `DATABASE_URL`, `AUTH_SECRET`,
   `CREDENTIALS_ENCRYPTION_KEY` (see [bring-your-own.md §4a](bring-your-own.md#4a-optional-multi-tenant-auth)).
2. **Schema** including `user_mcp_servers` (migration `0004_…`):

   | Step | Action |
   |------|--------|
   | 1 | GitHub → **Actions** → **db-migrate** → Run workflow |
   | 2 | `confirm` = `migrate` (required) |
   | 3 | Optional `dry_run` = true first (validates secret presence only) |
   | 4 | Repository secret `DATABASE_URL` must equal Vercel Production (dual-store) |

   Do **not** use seed / `db-tenancy-bootstrap` for schema-only cutover (seed
   resets bootstrap password + sandbox token ciphertext).

   Workflow: [`.github/workflows/db-migrate.yml`](../.github/workflows/db-migrate.yml).

3. Redeploy if the app was built before the migration landed.

If the table is missing, Settings fail-softs with an unavailable message (no
crash loop). Run **db-migrate**, then retry.

## Settings path

| Surface | Who | Path |
|---------|-----|------|
| Overview | any signed-in member with sole membership | `/settings` |
| MCP servers | same | `/settings/mcp` |
| Nav | AuthNav **Settings** (all signed-in users when tenancy is on) | site chrome |

Admin **Inference keys** (`/admin/inference`) are **tenant BYOK** — different
from personal MCP API keys.

## Config fields

| Field | Notes |
|-------|--------|
| **Name** | Display label (unique per user) |
| **Slug** | Tool prefix: remote tools appear as `mcp_<slug>__<sanitized_name>` |
| **URL** | HTTPS MCP endpoint only (private/link-local/metadata hosts blocked) |
| **Auth header name** | Optional unless an API key is set. Presets: `x-api-key`, `Authorization`, or custom (`A–Z a–z 0–9 -`, ≤64) |
| **API key** | Optional. Empty → public HTTPS MCP (no auth header). Stored **encrypted** under the tenant DEK; UI shows a **mask** only |
| **Enabled** | When on, server is considered on the next agent turn |

**Authorization header:** if the name is `Authorization` (case-insensitive), the
server sends `Bearer <raw secret>`. The database stores the **raw** secret only —
never a `Bearer ` prefix. If the raw value already starts with `Bearer `, it is
sent as-is (no double prefix). Other header names send the raw secret as the
header value.

## Security

| Rule | Detail |
|------|--------|
| At rest | Header secrets ciphertext under **tenant DEK** (same envelope family as provider secrets) |
| UI | Mask / last-four only; never plaintext after save |
| Client / Wasm | Never store or display full keys; no `NEXT_PUBLIC_*` MCP secrets |
| SSRF | https only; no userinfo in URL; block private/link-local/metadata; DNS answers re-checked; MCP HTTP transport does **not** follow redirects |
| Errors | Connect/probe messages redact known secrets; `last_error` is truncated safe text |
| DEK rotate | Owner **DEK rotate** on `/admin` re-encrypts that tenant’s MCP header ciphertexts together with sandbox tokens and provider secrets |

Never commit API keys, paste them into issues, or log them.

## Runtime (agent turns)

```text
User enables MCP servers on /settings/mcp
  → POST /api/agent (Wasm composer → host → agent route)
  → load enabled per-user rows; decrypt keys server-side
  → connect HTTPS MCP clients in parallel (per-server timeout ~5s)
  → merge tools with sandbox tools (name prefix mcp_<slug>__)
  → soft-fail: dead servers set last_error; do not brick the turn
  → generateText multi-step; tool results flattened server-side → host toolTrace
    (≤6 system lines: `mcp_{slug}__{tool} · ✓ ok|✗ failed · preview`, not raw MCP JSON)
  → close MCP clients in finally
  → User reads results in the **Wasm** transcript (not a DOM chat panel)
```

When any MCP tools load, the agent system prompt gets a short addendum that
external tools exist under `mcp_*` prefixes.

## Operator smoke — Exa

Primary smoke MCP for operators (hosted Streamable HTTP + API key).

| Setting | Value |
|---------|--------|
| URL | `https://mcp.exa.ai/mcp` |
| Auth header | `x-api-key` |
| API key | Create a free key in the **Exa** dashboard (operator-owned; never commit) |

### Checklist

1. **Schema:** Actions → **db-migrate** → `confirm=migrate` (if `user_mcp_servers` not applied yet).
2. **Sign in** on the tenancy-on deploy.
3. Open **Settings → MCP servers** (`/settings/mcp`).
4. **Add server:** name e.g. `Exa`, slug `exa`, URL above, header `x-api-key`, paste API key, leave **Enabled** on.
5. **Test connection** — expect success and a non-zero tool count (or a clear error without leaking the key).
6. Open **`/harness`** — type a prompt that needs web search / research tools.
7. Confirm the canvas shows tool activity: system toolTrace lines look like
   `mcp_exa__web_search_exa · ✓ ok · …` (short preview; **not** `{"content":[…]}` raw envelopes).
   Host caps display at **6** lines. The assistant message should be prose, not the MCP JSON envelope.
8. Optional: **Disable** the server and confirm a later turn no longer loads it; re-enable as needed.

If Test fails: check URL/header/key, migrate status, and `last_error` on the card.
If harness has no tools: confirm **Enabled**, tenancy on, and agent path (not chat-only).

## Limits

| Limit | Value |
|-------|--------|
| Servers per user | 5 |
| Connect / list timeout | ~5 seconds per server |
| MCP tools merged cap | ~48 total |
| Host toolTrace lines | 128 (`TOOL_TRACE_MAX_LINES`) |

## Non-goals

- OAuth / dynamic client registration for MCP  
- stdio or local process MCP  
- Tenant-admin shared MCP catalog for all members  
- Invincible acting as an MCP **server**  
- MCP tools on single-shot `POST /api/chat`  
- Resources / prompts surfaces beyond **tools**  
- Per-tool allowlists (whole-server enable only)

## Related

- Feature ownership: [feature-divide.md](feature-divide.md)  
- BYO tenancy / migrate: [bring-your-own.md](bring-your-own.md)  
- Secrets policy: [SECURITY.md](../SECURITY.md)  
- Agent sandbox tools: [sandbox.md](sandbox.md)  
