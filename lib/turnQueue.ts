/**
 * backend-agents F21 (plan #815) — persisted backend submit queue + drain.
 *
 * AS-BUILT scope (operator override 2026-08-30: "ship it, Wasm untouched,
 * no plan-review cycle"): the Wasm submit FIFO (protocol v18/v20/v21) stays the
 * runtime source of truth; this module adds the **host-known persisted mirror**
 * of that queue on the session snapshot (`SessionSnapshot.queue`), so the queue
 * survives a reload and re-arms the Wasm FIFO.
 *
 * Deliberate scope (documented residuals, see the F21 issue comment):
 * - The mirror carries prompts the HOST has seen (composer submits, drain
 *   steps). Items enqueued while busy from inside Wasm (band chips via
 *   `enqueueFromUi`, band edit/remove/Clear) are NOT observable by the host
 *   without a new `inv_*` export (protocol bump) — out of scope per override.
 *   They still drain at runtime (promote → pending_submit → poll POST); they
 *   are just not crash-safe persisted.
 * - Storage rides the EXISTING transcript blob (`SessionSnapshot.queue` field,
 *   serialized inside the transcript object) — never `meta`, no new route, no
 *   new server surface, no protocol bump.
 * - Reload hydration re-arms the Wasm FIFO in REVERSE order via the v20
 *   `queuedInsertFront` (each insert becomes the new head), only when the Wasm
 *   queue is empty (never double-enqueues), only after a full ring rebuild
 *   (the v21 default `hydrateMessages` clear wipes the FIFO).
 * - Drain failure budget: give-up drops the item from the mirror with a
 *   painted error after `TURN_QUEUE_DRAIN_MAX_ATTEMPTS` failed attempts
 *   (NEW cap; generous-by-default — the existing in-send 5× retry loop and the
 *   route's own 429/409/503 gates are untouched).
 */

import type { SessionSnapshot } from './sessionStore';
import type { HarnessBridge } from './harnessBridge';

/**
 * Mirror-depth cap — parity with the Wasm `submit_queue.MAX_ITEMS` (16,
 * mirrored as `HARNESS_QUEUE_MAX_ITEMS` in lib/harnessChat.ts). Pinned here
 * (not imported) to keep this module dependency-light and cycle-free.
 */
export const TURN_QUEUE_MAX_ITEMS = 16;

/**
 * Per-item persisted text ceiling. F21's product reality (umbrella #794
 * post-mortem): the queue is for SMALL follow-up prompts; giant prompts are an
 * edge case that belongs on the transcript, not a crash-safe queue mirror.
 * Longer items stay on the ephemeral Wasm band for this page-life; they are
 * just not persisted. (Not a transport cap — `PROMPT_BODY_MAX_CHARS` owns the
 * wire; this only bounds the persisted mirror.)
 */
export const TURN_QUEUE_TEXT_MAX_CHARS = 5000;

/**
 * F21 Caps-table row (plan #815): NEW per-item drain attempt budget before
 * drop-with-paint. Generous by default; the route's own 429/409/503 gates and
 * the in-send 5× retry loop are unchanged.
 */
export const TURN_QUEUE_DRAIN_MAX_ATTEMPTS = 5;

/**
 * Sanitize a queue-mirror value (local JSON parse or cloud blob read):
 * keep string items, trim, drop blanks and over-cap items (fail-closed — an
 * over-cap item is dropped, never truncated into a different prompt), cap
 * depth. Returns `undefined` for a non-array so a poisoned value never sticks.
 */
export function sanitizeQueue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= TURN_QUEUE_MAX_ITEMS) break;
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    if (text.length > TURN_QUEUE_TEXT_MAX_CHARS) continue;
    out.push(text);
  }
  // Empty (or fully-poisoned) input = UNSET carrier, not `[]` — mirrors how
  // removeQueuedText deletes the field and how the read sites guard.
  return out.length > 0 ? out : undefined;
}

/** Read the sanitized mirror from a snapshot (undefined = no queue carrier). */
export function queueOf(session: SessionSnapshot): string[] | undefined {
  return session.queue === undefined ? undefined : sanitizeQueue(session.queue);
}

/**
 * Append one host-known prompt to the mirror. No-op (returns the input
 * session) when the text is blank/over-cap or the mirror is at depth cap —
 * the Wasm band still holds it for this page-life; only persistence skips.
 */
export function queueAppend(
  session: SessionSnapshot,
  text: string,
): SessionSnapshot {
  const t = (text ?? '').trim();
  if (!t || t.length > TURN_QUEUE_TEXT_MAX_CHARS) return session;
  const current = queueOf(session) ?? [];
  if (current.length >= TURN_QUEUE_MAX_ITEMS) return session;
  return { ...session, queue: [...current, t], updatedAt: Date.now() };
}

/**
 * Remove the FIRST array entry equal to `text` (exact-trim). Returns the same
 * reference when text is blank/absent; `undefined` when the result is empty
 * (unset carrier). Worker copy-forward uses this so a this-run user prompt
 * cannot stay on the blob after durable start (adversarial #901 HEAD Major).
 */
export function queueWithoutText(
  queue: string[] | undefined,
  text: string,
): string[] | undefined {
  const t = (text ?? '').trim();
  if (!t || !queue || queue.length === 0) return queue;
  const idx = queue.indexOf(t);
  if (idx === -1) return queue;
  const next = queue.slice(0, idx).concat(queue.slice(idx + 1));
  return next.length > 0 ? next : undefined;
}

/**
 * Remove the FIRST mirror entry equal to `text` (the copy whose durable start
 * was accepted). No-op when absent (e.g. an unobserved Wasm-internal enqueue).
 * Equality is exact-trim; duplicate texts remove one copy per accepted start.
 */
export function removeQueuedText(
  session: SessionSnapshot,
  text: string,
): SessionSnapshot {
  const t = (text ?? '').trim();
  if (!t) return session;
  const current = queueOf(session);
  const next = queueWithoutText(current, t);
  if (next === current) return session;
  const out: SessionSnapshot = { ...session, updatedAt: Date.now() };
  if (next === undefined || next.length === 0) delete out.queue;
  else out.queue = next;
  return out;
}

/**
 * Defer-restore (drain failure): return `text` to the FRONT of the mirror —
 * it was the drained head, and the Wasm band restore is `queuedInsertFront`
 * (also front), so both stay order-consistent. A text not currently in the
 * mirror is inserted at front anyway (first host observation). No-op on
 * blank / over-cap text or at depth cap.
 */
export function queueRestoreHead(
  session: SessionSnapshot,
  text: string,
): SessionSnapshot {
  const t = (text ?? '').trim();
  if (!t || t.length > TURN_QUEUE_TEXT_MAX_CHARS) return session;
  const current = queueOf(session) ?? [];
  const idx = current.indexOf(t);
  const rest =
    idx === -1 ? current : current.slice(0, idx).concat(current.slice(idx + 1));
  if (rest.length >= TURN_QUEUE_MAX_ITEMS) return session;
  return { ...session, queue: [t, ...rest], updatedAt: Date.now() };
}

/**
 * The this-run user text that {@link queueWithoutText} should match.
 *
 * persistStep checkpoints carry `turnWorkflow` `userMessage`, which production
 * `runHarnessTurn` POSTs as `formatPromptWithHistory(session.messages, prompt)`
 * (`lib/harnessChat.ts` `apiPrompt`). After the first turn that string is the
 * folded blob, not the raw queue item — exact-match against `session.queue`
 * no-ops and copy-forward re-arms the in-flight prompt (adversarial #901).
 *
 * Bare prompts (no history) pass through. A history fold ends with
 * `\nUser: ${newUserPrompt}\n\nAssistant:` — take that last User line.
 */
export function queueTextFromUserContent(text: string): string {
  const t = (text ?? '').trim();
  if (!t) return t;
  const suffix = '\n\nAssistant:';
  const head = t.endsWith(suffix) ? t.slice(0, t.length - suffix.length) : t;
  const marker = '\nUser: ';
  const idx = head.lastIndexOf(marker);
  if (idx === -1) return t;
  return head.slice(idx + marker.length).trim();
}

/**
 * Last `user` row text on a snapshot (adopted reconstruct is full history —
 * the tail user is this-run, not the first prompt).
 */
export function lastUserContent(
  messages: ReadonlyArray<{ role: string; text: string }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const t = (m.text ?? '').trim();
    if (t) return m.text;
  }
  return undefined;
}

function countItem(arr: readonly string[], item: string): number {
  let n = 0;
  for (const x of arr) if (x === item) n += 1;
  return n;
}

/**
 * Same-id adopt merge for the F21 queue mirror (adversarial #901).
 *
 * Whole-snapshot server-wins drops a `queueAppend` that lost the coalesced-PUT
 * race to a later worker B7 (copy-forward of an older prior). Union keeps
 * local extras; then strip the in-flight last user (unwrap a history fold)
 * so a stale-long server queue cannot re-arm a drain that already started.
 * Capped at {@link TURN_QUEUE_MAX_ITEMS}. Empty/absent → unset.
 */
export function mergeQueues(
  serverQueue: unknown,
  localQueue: unknown,
  lastUser?: string,
): string[] | undefined {
  const server = sanitizeQueue(serverQueue) ?? [];
  const local = sanitizeQueue(localQueue) ?? [];
  const out = server.slice();
  for (const item of local) {
    if (out.length >= TURN_QUEUE_MAX_ITEMS) break;
    if (countItem(out, item) < countItem(local, item)) out.push(item);
  }
  const started = lastUser ? queueTextFromUserContent(lastUser) : '';
  const merged = out.length > 0 ? out : undefined;
  const stripped = started ? queueWithoutText(merged, started) : merged;
  return stripped !== undefined && stripped.length > 0 ? stripped : undefined;
}

/** Drop the whole mirror (Clear/New semantics; used when a session is reset). */
export function queueClear(session: SessionSnapshot): SessionSnapshot {
  if (session.queue === undefined) return session;
  const out = { ...session };
  delete out.queue;
  return out;
}

/**
 * Reload hydration (F21 "Next load"): re-arm the Wasm FIFO from the persisted
 * mirror. Inserts in REVERSE order via the v20 `queuedInsertFront` (each
 * insert becomes the new head, so reverse yields the original FIFO). Guards:
 * - only when the Wasm queue is currently EMPTY (never double-enqueues;
 *   `hydrateMessages` default clear wiped it — a `preserveQueue` rebuild
 *   keeps a live FIFO and must not re-arm);
 * - a full/blank insert reject stops (fail-closed — the item stays in the
 *   mirror, never silently dropped).
 * Returns the number of items re-armed (parity: callers may compare against
 * `bridge.queuedCount()`).
 *
 * Callers: only **cold** hydrates (boot / adopt / switch). Live ring snaps
 * (Load-earlier / needSnap) must use {@link queueHydratePlan} `'live'` and
 * must not call this — a just-promoted head is already out of the band and
 * still in the mirror until drain-start strip (adversarial #901 HEAD Major).
 */
export function rearmQueueFromMirror(
  bridge: HarnessBridge,
  session: SessionSnapshot,
): number {
  const items = queueOf(session);
  if (!items || items.length === 0) return 0;
  if (bridge.queuedCount() > 0) return 0; // live FIFO — never double-enqueue
  let inserted = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    let ok = false;
    try {
      ok = bridge.queuedInsertFront(items[i]);
    } catch {
      ok = false;
    }
    if (!ok) break; // fail-closed: leave the rest in the mirror
    inserted += 1;
  }
  return inserted;
}

/**
 * Cold vs live ring hydrate (adversarial #901 HEAD Major).
 *
 * - **cold** (F5 / boot / adopt / switch): wipe the stale FIFO
 *   (`inv_clear_messages`) then re-arm from this session's mirror.
 * - **live** (Load-earlier / needSnap before pending submit): keep the current
 *   FIFO (`inv_clear_ring`) and **do not re-arm**. A just-promoted head is
 *   already out of the band and still in the mirror until `runPrompt` strips
 *   it; re-arming would duplicate it and double-POST.
 *
 * Do not key re-arm on `queuedCount()===0` after a live clear: that is the
 * post-promote empty-FIFO (last-item) case.
 */
export type QueueHydrateKind = 'cold' | 'live';

export function queueHydratePlan(kind: QueueHydrateKind): {
  preserveQueue: boolean;
  rearm: boolean;
} {
  if (kind === 'live') return { preserveQueue: true, rearm: false };
  return { preserveQueue: false, rearm: true };
}

