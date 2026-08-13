/**
 * Agent-only request body parse. Chat stays on parseChatBody (no cwd).
 */
import { parseChatBody } from '../chatServer';
import { parseInitialCwd } from './workPath';

export type ParsedAgentBody =
  | { ok: true; prompt: string; modelId?: string; cwd: string }
  | { ok: false; error: string; status: number };

/**
 * Parse POST /api/agent body: { prompt, modelId?, cwd? }.
 * - Body omits `cwd` (or null) → `'.'` (workspace-root default; env ignored —
 *   there is no host-wide `SANDBOX_DEFAULT_CWD`). Session controls cwd (#452).
 * - Body provides `cwd` → `parseInitialCwd` (host-absolute / invalid → 400).
 */
export function parseAgentBody(
  body: unknown,
  _env: Record<string, string | undefined> = process.env,
): ParsedAgentBody {
  const base = parseChatBody(body);
  if (!base.ok) {
    return base;
  }

  const obj =
    body != null && typeof body === 'object'
      ? (body as { cwd?: unknown })
      : {};

  // Omit / null → '.' always. Distinguish from present invalid (400) or empty (→ ".").
  if (!('cwd' in obj) || obj.cwd === undefined || obj.cwd === null) {
    return {
      ok: true,
      prompt: base.prompt,
      modelId: base.modelId,
      cwd: '.',
    };
  }

  const cwdParsed = parseInitialCwd(obj.cwd);
  if (!cwdParsed.ok) {
    return { ok: false, status: 400, error: cwdParsed.error };
  }

  return {
    ok: true,
    prompt: base.prompt,
    modelId: base.modelId,
    cwd: cwdParsed.cwd,
  };
}
