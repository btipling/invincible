/**
 * Agent-only request body parse. Chat stays on parseChatBody (no cwd).
 */
import { parseChatBody } from '../chatServer';
import { resolveSandboxDefaultCwd } from '../sandbox/config';
import { parseInitialCwd } from './workPath';

export type ParsedAgentBody =
  | { ok: true; prompt: string; modelId?: string; cwd: string }
  | { ok: false; error: string; status: number };

/**
 * Parse POST /api/agent body: { prompt, modelId?, cwd? }.
 * - Body omits `cwd` → `resolveSandboxDefaultCwd(env)` (env or `.`).
 * - Body provides `cwd` → `parseInitialCwd` (host-absolute / invalid → 400).
 */
export function parseAgentBody(
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): ParsedAgentBody {
  const base = parseChatBody(body);
  if (!base.ok) {
    return base;
  }

  const obj =
    body != null && typeof body === 'object'
      ? (body as { cwd?: unknown })
      : {};

  // Distinguish omitted vs present: parseChatBody already validated shape.
  if (!('cwd' in obj) || obj.cwd === undefined) {
    return {
      ok: true,
      prompt: base.prompt,
      modelId: base.modelId,
      cwd: resolveSandboxDefaultCwd(env),
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
