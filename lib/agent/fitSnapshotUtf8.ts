/**
 * Fit a session-snapshot JSON string under a UTF-8 byte ceiling by dropping
 * **oldest** `messages` (same order as host `trimForCloudPut`). Never throws.
 *
 * Not `truncateMessageCheckpoint` — that helper drops the **newest** rows.
 */

const encoder = new TextEncoder();

function utf8ByteLength(s: string): number {
  return typeof Buffer !== 'undefined'
    ? Buffer.byteLength(s, 'utf8')
    : encoder.encode(s).length;
}

/** UTF-8-safe prefix; no ellipsis (maximize fit under the object ceiling). */
function clipUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = encoder.encode(s);
  if (bytes.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.slice(0, end));
}

/**
 * Return `json` unchanged when it already fits, is not a JSON object, or has
 * no `messages` array. Otherwise drop oldest messages until `utf8 ≤ maxBytes`,
 * then clip the lone remaining row's `text` if still over.
 */
export function fitSnapshotUtf8(json: string, maxBytes: number): string {
  if (maxBytes <= 0) return json;
  if (utf8ByteLength(json) <= maxBytes) return json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json;
  }
  const rec = parsed as Record<string, unknown>;
  if (!Array.isArray(rec.messages)) return json;
  const messages = rec.messages.slice() as unknown[];
  const rebuild = (ms: unknown[]): string =>
    JSON.stringify({ ...rec, messages: ms });
  let out = rebuild(messages);
  while (utf8ByteLength(out) > maxBytes && messages.length > 1) {
    messages.shift();
    out = rebuild(messages);
  }
  if (utf8ByteLength(out) <= maxBytes) return out;
  if (messages.length !== 1) return out;
  const only = messages[0];
  if (only === null || typeof only !== 'object' || Array.isArray(only)) {
    return out;
  }
  const row = { ...(only as Record<string, unknown>) };
  if (typeof row.text !== 'string') return out;
  const original = row.text;
  let budget = utf8ByteLength(original);
  let best = '';
  while (budget > 0) {
    const candidate = clipUtf8(original, budget);
    const cand = rebuild([{ ...row, text: candidate }]);
    if (utf8ByteLength(cand) <= maxBytes) {
      best = candidate;
      break;
    }
    budget = Math.floor(budget / 2);
  }
  out = rebuild([{ ...row, text: best }]);
  if (utf8ByteLength(out) <= maxBytes) return out;
  out = rebuild([]);
  return utf8ByteLength(out) <= maxBytes ? out : json;
}
