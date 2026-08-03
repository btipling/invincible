import { resolveModelId } from '../model';

/** Exact 503 body — host phase 3 matches this string. */
export const SANDBOX_NOT_CONFIGURED_ERROR =
  'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.' as const;

export const DEFAULT_AGENT_MAX_STEPS = 6;
export const MAX_AGENT_MAX_STEPS = 12;
export const MIN_AGENT_MAX_STEPS = 1;

/** Tool result string cap before returning to the model. */
export const TOOL_RESULT_MAX_CHARS = 8_192;

/** toolTrace summary cap (host will also ≤6 lines). */
export const TOOL_TRACE_SUMMARY_MAX_CHARS = 240;

export const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
export const MAX_EXEC_TIMEOUT_MS = 30_000;

/**
 * Both URL and token required (trimmed non-empty).
 * Server-only — never NEXT_PUBLIC_*.
 */
export function sandboxConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.SANDBOX_URL?.trim() && env.SANDBOX_TOKEN?.trim());
}

export type SandboxConfig = {
  baseUrl: string;
  token: string;
};

export function getSandboxConfig(
  env: Record<string, string | undefined> = process.env,
): SandboxConfig | null {
  const baseUrl = env.SANDBOX_URL?.trim();
  const token = env.SANDBOX_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl: normalizeBaseUrl(baseUrl), token };
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function resolveAgentMaxSteps(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.AGENT_MAX_STEPS?.trim();
  if (!raw) return DEFAULT_AGENT_MAX_STEPS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_AGENT_MAX_STEPS;
  const i = Math.floor(n);
  if (i < MIN_AGENT_MAX_STEPS) return MIN_AGENT_MAX_STEPS;
  if (i > MAX_AGENT_MAX_STEPS) return MAX_AGENT_MAX_STEPS;
  return i;
}

export function resolveAgentModelId(
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.AGENT_MODEL?.trim();
  if (fromEnv) return fromEnv;
  return resolveModelId(env);
}

export function clampExecTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs == null || Number.isNaN(Number(timeoutMs))) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }
  const n = Math.floor(Number(timeoutMs));
  if (n < 1) return 1;
  if (n > MAX_EXEC_TIMEOUT_MS) return MAX_EXEC_TIMEOUT_MS;
  return n;
}
