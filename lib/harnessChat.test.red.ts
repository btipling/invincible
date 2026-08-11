/**
 * Phase-1 red-fixture / investigation suite for #387 (harness rich MD glue).
 *
 * IMPORTANT — run coordination:
 *   - `npm run test:red` runs THIS file only.
 *   - Default `npm test` EXCLUDES any `*.test.red.ts` file (see package.json
 *     `test` script and vitest.config.ts `include`), so the ordinary gate stays
 *     green while #387 is triaged.
 *   - When phase 2 (parent #390) fixes the failing invariant, move this file to
 *     a normal `*.test.ts` so it becomes a locked regression test.
 *
 * What is genuinely RED here:
 *   A whitespace-only `text_delta` (the `\n\n` that separates an ATX heading
 *   from its paragraph) is dropped by `growAssistant` (`if (!chunk.trim())
 *   return;`). In a single-segment turn `finalizeAssistant` settles the row to
 *   the authoritative final text, masking it. But in a MULTI-SEGMENT turn (a
 *   tool/thinking boundary closes the first assistant bubble) the dropped
 *   whitespace throws off the tail-slice in the multi-segment branch of
 *   `finalizeAssistant`, so the visible assistant row ends up GLUED/wrong and
 *   inconsistent with the authoritative text — exactly the #387 symptom on a
 *   finished row.
 */
import { describe, expect, it, vi } from 'vitest';
import { runHarnessTurn } from './harnessChat';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessBridge,
  INV_PING_XOR,
  Lifecycle,
  MessageKind,
  type HarnessBridgeExports,
} from './harnessBridge';
import type { AgentResult } from './agentApi';
import { createEmptySession } from './sessionStore';

function makeMockExports(): HarnessBridgeExports & {
  __messages: { kind: number; text: string }[];
} {
  let buf = new ArrayBuffer(64 * 1024);
  const memory = {
    get buffer() {
      return buf;
    },
  };
  let nextPtr = 1024;
  let lifecycle = Lifecycle.Boot;
  const messages: { kind: number; text: string }[] = [];

  const gpa_u8 = (len: number) => {
    if (len <= 0) return 0;
    const ptr = nextPtr;
    nextPtr += len + 16;
    if (ptr + len > buf.byteLength) {
      const bigger = new ArrayBuffer(Math.max(buf.byteLength * 2, ptr + len + 1024));
      new Uint8Array(bigger).set(new Uint8Array(buf));
      buf = bigger;
    }
    return ptr;
  };

  const read = (ptr: number, len: number) =>
    new TextDecoder().decode(new Uint8Array(buf, ptr, len));

  return {
    memory,
    gpa_u8,
    gpa_free: () => {},
    inv_protocol_version: () => HARNESS_PROTOCOL_VERSION,
    inv_ping: (x: number) => (x | 0) ^ INV_PING_XOR,
    inv_set_lifecycle: (s: number) => {
      lifecycle = s as Lifecycle;
    },
    inv_get_lifecycle: () => lifecycle,
    inv_message_count: () => messages.length,
    inv_begin_batch: () => {},
    inv_end_batch: () => {},
    inv_push_message: (kind: number, ptr: number, len: number) => {
      messages.push({ kind, text: len === 0 ? '' : read(ptr, len) });
    },
    inv_update_last_message: (kind: number, ptr: number, len: number) => {
      if (messages.length === 0) return 0;
      const last = messages[messages.length - 1]!;
      if (last.kind !== kind) return 0;
      last.text = len === 0 ? '' : read(ptr, len);
      return 1;
    },
    inv_clear_messages: () => {
      messages.length = 0;
    },
    inv_echo: () => 0,
    inv_echo_len: () => 0,
    inv_echo_copy: () => 0,
    inv_has_pending_submit: () => 0,
    inv_pending_submit_len: () => 0,
    inv_pending_submit_copy: () => 0,
    inv_ack_pending_submit: () => {},
    inv_set_can_load_earlier: () => {},
    inv_has_pending_load_earlier: () => 0,
    inv_ack_pending_load_earlier: () => {},
    inv_has_pending_cancel: () => 0,
    inv_ack_pending_cancel: () => {},
    inv_clear_model_catalog: () => {},
    inv_push_model_catalog_entry: () => 0,
    inv_model_catalog_count: () => 0,
    inv_selected_model_len: () => 0,
    inv_selected_model_copy: () => 0,
    inv_cycle_selected_model: () => 0,
    inv_image_cache_put: () => 0,
    inv_image_cache_clear: () => {},
    inv_math_cache_put: () => 0,
    inv_math_cache_clear: () => {},
    __messages: messages,
  };
}

const AUTHORITATIVE = 'part one part two\n\nIt will 401';

describe('#387 host red fixture — multi-segment whitespace boundary (KNOWN RED)', () => {
  it('visible assistant tail stays consistent with authoritative text when a whitespace-only delta divides segments', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();

    const agent = vi.fn(
      async (_prompt: string, init): Promise<AgentResult> => {
        const onEvent = init?.onEvent;
        await onEvent?.({ type: 'text_delta', text: 'part one ' });
        await onEvent?.({ type: 'text_delta', text: 'part two' });
        // Whitespace-only boundary (the "\n\n" after the heading). growAssistant
        // DROPS it (`if (!chunk.trim()) return;`) — see file header.
        await onEvent?.({ type: 'text_delta', text: '\n\n' });
        // A tool closes the first assistant segment.
        await onEvent?.({ type: 'tool_start', name: 'list_dir' });
        await onEvent?.({
          type: 'tool_result',
          name: 'list_dir',
          ok: true,
          summary: 'list_dir · ok · a',
        });
        await onEvent?.({ type: 'text_delta', text: 'It will 401' });
        await onEvent?.({ type: 'done', text: AUTHORITATIVE });
        return { ok: true, text: AUTHORITATIVE };
      },
    );

    const result = await runHarnessTurn(bridge, session, 'repro', {
      streamAgent: true,
      sendAgentStream: agent,
    });

    // The persisted session settle to the authoritative (well-formed) text.
    const settled = result.session.messages.find((m) => m.role === 'assistant');
    expect(settled?.text).toBe(AUTHORITATIVE);

    // The visible assistant row must match the authoritative final text, not a
    // whitespace-tail-sliced glu. THIS FAILS today (phase-1 red fixture).
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    const lastAssistant = assistants[assistants.length - 1]!;
    expect(lastAssistant.text).toBe(AUTHORITATIVE);
  });
});

describe('#387 host green pins — well-formed deltas preserve whitespace', () => {
  it('single-segment `## What I did` + `\\n\\n` + paragraph reassembles with the newline intact', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();

    const result = await runHarnessTurn(bridge, session, 'md', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        const onEvent = init?.onEvent;
        await onEvent?.({ type: 'text_delta', text: '## What I did' });
        await onEvent?.({ type: 'text_delta', text: '\n\n' });
        await onEvent?.({
          type: 'text_delta',
          text: 'The adversarial review verdict was **CONCERNS**.',
        });
        await onEvent?.({
          type: 'done',
          text: '## What I did\n\nThe adversarial review verdict was **CONCERNS**.',
        });
        return {
          ok: true,
          text: '## What I did\n\nThe adversarial review verdict was **CONCERNS**.',
        };
      },
    });

    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe(
      '## What I did\n\nThe adversarial review verdict was **CONCERNS**.',
    );
    const settled = result.session.messages.find((m) => m.role === 'assistant');
    expect(settled?.text).toBe(
      '## What I did\n\nThe adversarial review verdict was **CONCERNS**.',
    );
  });

  it('a whitespace-only text_delta does NOT open an empty assistant bubble on its own', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();

    await runHarnessTurn(bridge, session, 'ws', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        const onEvent = init?.onEvent;
        await onEvent?.({ type: 'text_delta', text: '   ' });
        await onEvent?.({ type: 'text_delta', text: 'ok' });
        await onEvent?.({ type: 'done', text: 'ok' });
        return { ok: true, text: 'ok' };
      },
    });

    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    // Exactly one assistant row, containing the final text (no empty bubble from
    // the leading whitespace-only delta).
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe('ok');
  });
});
