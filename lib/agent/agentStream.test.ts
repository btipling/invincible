import { TOOL_TRACE_SUMMARY_MAX_CHARS } from '../sandbox/config';
import { describe, expect, it } from 'vitest';
import {
  encodeSseData,
  mapFullStreamPart,
  wantsAgentStream,
  summarizeToolLine,
  salientToolBits,
  buildToolPreview,
  TOOL_LINE_SALIENT_MAX,
  TOOL_RUN_PREVIEW_HEAD_LINES,
  TOOL_RUN_PREVIEW_TAIL_LINES,
  TOOL_RUN_PREVIEW_MAX_CHARS,
  LIVE_TOOL_LINES_MAX,
} from './agentStream';

describe('wantsAgentStream', () => {
  it('true for Accept text/event-stream', () => {
    expect(
      wantsAgentStream(
        new Request('http://x/api/agent', {
          headers: { Accept: 'text/event-stream' },
        }),
      ),
    ).toBe(true);
    expect(
      wantsAgentStream(
        new Request('http://x/api/agent', {
          headers: { Accept: 'application/json, text/event-stream' },
        }),
      ),
    ).toBe(true);
  });

  it('false without stream accept', () => {
    expect(wantsAgentStream(new Request('http://x/api/agent'))).toBe(false);
    expect(
      wantsAgentStream(
        new Request('http://x/api/agent', {
          headers: { Accept: 'application/json' },
        }),
      ),
    ).toBe(false);
  });
});

describe('encodeSseData', () => {
  it('formats data line', () => {
    const s = encodeSseData({ type: 'text_delta', text: 'hi' });
    expect(s).toBe('data: {"type":"text_delta","text":"hi"}\n\n');
  });
});

describe('mapFullStreamPart', () => {
  it('maps tool-call → tool_start', () => {
    expect(
      mapFullStreamPart({ type: 'tool-call', toolName: 'list_dir', toolCallId: 'c1' }),
    ).toEqual([{ type: 'tool_start', name: 'list_dir', id: 'c1' }]);
  });

  it('maps tool-result → tool_result with summary + preview', () => {
    const evs = mapFullStreamPart({
      type: 'tool-result',
      toolName: 'list_dir',
      toolCallId: 'c1',
      output: 'a.txt\nb.txt',
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'tool_result', name: 'list_dir', ok: true });
    if (evs[0]!.type === 'tool_result') {
      expect(evs[0].summary).toContain('list_dir · ✓ ok');
      // #353: multi-line output carries a bounded preview → real level-2 detail.
      expect(evs[0].preview).toContain('a.txt');
      expect(evs[0].preview).toContain('b.txt');
    }
  });

  it('maps text-delta', () => {
    expect(mapFullStreamPart({ type: 'text-delta', text: 'Hel' })).toEqual([
      { type: 'text_delta', text: 'Hel' },
    ]);
  });

  it('redacts secrets in text and tool output', () => {
    const secret = 'sk-super-secret';
    expect(
      mapFullStreamPart({ type: 'text-delta', text: `token ${secret}` }, [secret]),
    ).toEqual([{ type: 'text_delta', text: 'token [redacted]' }]);
    const evs = mapFullStreamPart(
      {
        type: 'tool-result',
        toolName: 'exec',
        output: `export KEY=${secret}\nexit=0\nstdout:\nline ok\n`,
      },
      [secret],
    );
    if (evs[0]!.type === 'tool_result') {
      expect(evs[0].summary).not.toContain(secret);
      expect(evs[0].summary).toContain('[redacted]');
      // #353: preview is also redacted, never leaked to paint.
      expect(evs[0].preview).not.toContain(secret);
      expect(evs[0].preview).toContain('[redacted]');
    }
  });

  it('maps reasoning-delta → reasoning_delta', () => {
    expect(mapFullStreamPart({ type: 'reasoning-delta', text: 'think' })).toEqual([
      { type: 'reasoning_delta', text: 'think' },
    ]);
  });

  it('redacts secrets in reasoning_delta', () => {
    const secret = 'sk-reason-secret';
    expect(
      mapFullStreamPart({ type: 'reasoning-delta', text: `see ${secret}` }, [secret]),
    ).toEqual([{ type: 'reasoning_delta', text: 'see [redacted]' }]);
  });

  it('maps error parts', () => {
    expect(mapFullStreamPart({ type: 'error', error: new Error('boom') })).toEqual([
      { type: 'error', error: 'boom' },
    ]);
  });
});

describe('salientToolBits / summarizeToolLine', () => {
  it('read_file shows path + size, not body', () => {
    const body = 'line1\nline2\nline3\n' + 'x'.repeat(500);
    const raw = `read_file src/foo.ts:\n${body}`;
    const bits = salientToolBits('read_file', raw);
    expect(bits).toContain('src/foo.ts');
    expect(bits).toMatch(/lines/);
    expect(bits).not.toContain('xxxxx');
    const line = summarizeToolLine('read_file', raw, true);
    expect(line).toMatch(/^read_file · ✓ ok ·/);
    expect(line).not.toContain('xxxxx');
    expect(line.length).toBeLessThanOrEqual(TOOL_LINE_SALIENT_MAX);
  });

  it('exec shows exit + line counts, not full stdout', () => {
    const raw = 'exec npm\nexit=0\nstdout:\n' + 'ok\n'.repeat(40) + 'stderr:\n';
    const bits = salientToolBits('exec', raw);
    expect(bits).toContain('exit=0');
    expect(bits).toMatch(/stdout/);
    expect(bits).not.toContain('ok\nok\nok');
  });

  it('list_dir keeps entry count', () => {
    const bits = salientToolBits(
      'list_dir',
      'list_dir .: 3 entries — a(file), b(dir), c(file)',
    );
    expect(bits).toContain('3 entries');
  });

  it('http_get shows status + body size, not body', () => {
    const bits = salientToolBits(
      'http_get',
      'http_get https://example.com/docs → 200\n' + '<html>' + 'z'.repeat(2000),
    );
    expect(bits).toContain('→ 200');
    expect(bits).toMatch(/B$/);
    expect(bits).not.toContain('<html>zzzz');
  });

  it('marks ok and failed clearly', () => {
    expect(summarizeToolLine('list_dir', 'a', true)).toContain('✓ ok');
    expect(summarizeToolLine('list_dir', 'ERROR boom', false)).toContain('✗ failed');
  });

  it('soft-caps final line length', () => {
    const line = summarizeToolLine('x', 'y'.repeat(5000), true);
    expect(line.length).toBeLessThanOrEqual(TOOL_LINE_SALIENT_MAX);
  });
});

describe('buildToolPreview (phase 3 #353 — bounded redacted L2 detail)', () => {
  it('omits preview for short single-line results (no pretend expand)', () => {
    expect(buildToolPreview('list_dir .: 3 entries — a, b, c')).toBeUndefined();
    expect(buildToolPreview('')).toBeUndefined();
    expect(buildToolPreview('   ')).toBeUndefined();
  });

  it('keeps multi-line detail verbatim when within head+tail window', () => {
    const body = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');
    expect(buildToolPreview(body)).toBe(body);
  });

  it('collapses long output to head + tail + … (N more lines)', () => {
    const body = Array.from(
      { length: TOOL_RUN_PREVIEW_HEAD_LINES + TOOL_RUN_PREVIEW_TAIL_LINES + 20 },
      (_, i) => `stdout ${i}`,
    ).join('\n');
    const preview = buildToolPreview(body)!;
    expect(preview).toContain(`stdout 0`); // head start
    expect(preview).toContain('… (20 more lines)');
    expect(preview).toContain(`stdout ${
      TOOL_RUN_PREVIEW_HEAD_LINES + TOOL_RUN_PREVIEW_TAIL_LINES + 19
    }`); // tail end
    // Bounded: never more than head+tail lines plus the collapse marker lines.
    expect(preview.split('\n').length).toBeLessThanOrEqual(
      TOOL_RUN_PREVIEW_HEAD_LINES + TOOL_RUN_PREVIEW_TAIL_LINES + 3,
    );
  });

  it('caps a pathological single huge body at TOOL_RUN_PREVIEW_MAX_CHARS', () => {
    const preview = buildToolPreview('x'.repeat(TOOL_RUN_PREVIEW_MAX_CHARS + 5000))!;
    expect(preview.length).toBeLessThanOrEqual(TOOL_RUN_PREVIEW_MAX_CHARS + 1);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('normalizes CRLF and tabs so paint stays newline-safe on the wire', () => {
    const preview = buildToolPreview('exec ls\r\nexit=0\r\nstdout:\r\n\tfoo\tbar');
    expect(preview).toBe('exec ls\nexit=0\nstdout:\n    foo    bar');
  });
});

describe('LIVE_TOOL_LINES_MAX', () => {
  it('is unbounded (no host live-tool product cap)', () => {
    expect(LIVE_TOOL_LINES_MAX).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('salientToolBits cwd tools', () => {
  it('summarizes change_dir and pwd', () => {
    expect(
      salientToolBits('change_dir', 'change_dir invincible: ok cwd=invincible'),
    ).toBe('invincible · cwd=invincible');
    expect(salientToolBits('pwd', 'pwd: invincible')).toBe('invincible');
  });

  it('read_file with cwd annotation', () => {
    const raw = 'read_file invincible/a.ts cwd=invincible:\nline1\nline2';
    const bits = salientToolBits('read_file', raw);
    expect(bits).toContain('invincible/a.ts');
    expect(bits).toContain('cwd=invincible');
    expect(bits).toContain('2 lines');
  });
});
