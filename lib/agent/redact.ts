/**
 * Strip known secrets from strings returned to the model or client.
 */
export function redactSecrets(
  text: string,
  secrets: Array<string | undefined | null>,
): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    if (out.includes(s)) {
      out = out.split(s).join('[redacted]');
    }
  }
  return out;
}

export function truncateForModel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated]`;
}

export function truncateSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
