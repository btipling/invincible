/**
 * Server-side model id for Phase 1.
 * Must be a Vercel AI Gateway `provider/model` string.
 */
export const DEFAULT_MODEL = 'xai/grok-4.1-fast-non-reasoning' as const;

export function resolveModelId(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DEFAULT_MODEL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_MODEL;
}
