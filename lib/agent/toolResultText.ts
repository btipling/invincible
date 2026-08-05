/**
 * Flatten tool results for the model + toolTrace (plan #133 / #129).
 * MCP CallToolResult often looks like { content: [{ type: "text", text: "…" }] }.
 */

export function isLikelyMcpContentEnvelope(value: unknown): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((part) => {
    if (typeof part === 'string') return true;
    if (part == null || typeof part !== 'object') return false;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type != null && p.type !== 'text') return false;
    return typeof p.text === 'string' || p.text == null;
  });
}

function textFromPart(part: unknown): string | null {
  if (typeof part === 'string') return part;
  if (part == null || typeof part !== 'object') return null;
  const p = part as { type?: unknown; text?: unknown };
  if (p.type != null && p.type !== 'text') return null;
  if (typeof p.text === 'string') return p.text;
  return null;
}

/**
 * Turn a tool execute result into plain text for the model / summaries.
 */
export function flattenToolResultText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    if (value.trim() === '') return '';
    // Some paths may hand a pure-envelope JSON string (not only objects).
    const unwrapped = parseAndFlattenIfMcpEnvelope(value);
    return unwrapped ?? value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((v) => flattenToolResultText(v))
      .filter((s) => s.length > 0);
    return parts.join('\n');
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    if (isLikelyMcpContentEnvelope(value)) {
      const parts = (obj.content as unknown[])
        .map((part) => textFromPart(part))
        .filter((t): t is string => t != null && t.length > 0);
      if (parts.length > 0) return parts.join('\n');
    }

    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.message === 'string') return obj.message;

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

/**
 * If the entire string is a JSON MCP content envelope, return flattened text.
 * Otherwise null (do not rewrite prose that merely mentions JSON).
 */
export function parseAndFlattenIfMcpEnvelope(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"content"')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isLikelyMcpContentEnvelope(parsed)) return null;
  // Flatten object path only (avoid re-entering string unwrap).
  const obj = parsed as Record<string, unknown>;
  const parts = (obj.content as unknown[])
    .map((part) => textFromPart(part))
    .filter((t): t is string => t != null && t.length > 0);
  if (parts.length > 0) return parts.join('\n');
  return null;
}
