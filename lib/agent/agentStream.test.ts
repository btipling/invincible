import { TOOL_TRACE_SUMMARY_MAX_CHARS } from '../sandbox/config';
import { describe, expect, it } from 'vitest';
import {
  encodeSseData,
  mapFullStreamPart,
  wantsAgentStream,
  summarizeToolLine,
  salientToolBits,
  buildToolPreview,
  changeDirSuccessCwd,
  metaSandboxSwitchActiveId,
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

  it('attaches the TYPED changeDirCwd on a successful change_dir, even when the summary is truncated (adversarial review #470)', () => {
    // A workspace-relative target long enough that its summarized one-liner
    // (`change_dir · ✓ ok · <path> · cwd=<path>`) exceeds TOOL_LINE_SALIENT_MAX
    // and ends in `…` — with a 320-char budget that needs a path > ~146 chars.
    const LONG_PATH =
      'packages/frontend/src/components/settings/panels/advanced/billing/extra' +
      '/very/deeply/nested/subdirectory/further/still/deeper/beyond/any/budget' +
      '/and/still/yet/even/further/deeper/for/margin';
    expect(LONG_PATH.length).toBeGreaterThan(146);
    const evs = mapFullStreamPart({
      type: 'tool-result',
      toolName: 'change_dir',
      toolCallId: 'c1',
      output: `change_dir ${LONG_PATH}: ok cwd=${LONG_PATH}`,
    });
    const ev = evs[0];
    expect(ev && ev.type).toBe('tool_result');
    if (ev && ev.type === 'tool_result') {
      expect(ev.ok).toBe(true);
      // The typed field carries the FULL raw path (never truncated).
      expect(ev.changeDirCwd).toBe(LONG_PATH);
      // The display summary is clamped and ends in `…` — persistence must NOT use it.
      expect(ev.summary.length).toBeLessThanOrEqual(TOOL_LINE_SALIENT_MAX);
      expect(ev.summary.endsWith('…')).toBe(true);
      expect(ev.summary).not.toContain(`cwd=${LONG_PATH}`);
    }
  });

  it('does NOT attach changeDirCwd to a normal tool or a failed change_dir', () => {
    const errEv = mapFullStreamPart({
      type: 'tool-result',
      toolName: 'change_dir',
      toolCallId: 'c1',
      output: 'ERROR change_dir: no such directory',
    })[0];
    if (errEv && errEv.type === 'tool_result') {
      expect(errEv.ok).toBe(false);
      expect(errEv.changeDirCwd).toBeUndefined();
    }
    const listEv = mapFullStreamPart({
      type: 'tool-result',
      toolName: 'list_dir',
      toolCallId: 'c1',
      output: 'list_dir .: 1 entry',
    })[0];
    if (listEv && listEv.type === 'tool_result') {
      expect(listEv.ok).toBe(true);
      expect(listEv.changeDirCwd).toBeUndefined();
    }
  });
});

describe('changeDirSuccessCwd (adversarial review #470 Major carrier)', () => {
  it('parses the strict raw success line only', () => {
    expect(changeDirSuccessCwd('change_dir invincible/sub: ok cwd=invincible/sub')).toBe(
      'invincible/sub',
    );
  });

  it('returns undefined for errors / non-change_dir / empty', () => {
    expect(changeDirSuccessCwd('ERROR change_dir: boom')).toBeUndefined();
    expect(changeDirSuccessCwd('list_dir .: 2 entries')).toBeUndefined();
    expect(changeDirSuccessCwd('')).toBeUndefined();
    expect(changeDirSuccessCwd(undefined)).toBeUndefined();
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

  it('keeps the REAL output tail when the assembled preview must be char-capped', () => {
    // Adversarial review #359 Major: head/tail are chosen from the FULL output
    // BEFORE the char cap, so a capped preview never shows a "tail" that is
    // really a slice of a truncated prefix.
    const HEAD = TOOL_RUN_PREVIEW_HEAD_LINES;
    const TAIL = TOOL_RUN_PREVIEW_TAIL_LINES;
    const headLines = Array.from({ length: HEAD }, () => 'H'.repeat(2400));
    const tailLines = Array.from(
      { length: TAIL },
      (_, i) => `REAL_END_${i} ` + 'T'.repeat(2400),
    );
    const body = [...headLines, 'middle-a', 'middle-b', ...tailLines].join('\n');
    const preview = buildToolPreview(body)!;
    expect(preview.length).toBeLessThanOrEqual(TOOL_RUN_PREVIEW_MAX_CHARS + 1);
    // The genuine end-of-output survives the cap (the last-tail marker is present).
    expect(preview).toContain(`REAL_END_${TAIL - 1} `);
    expect(preview).toContain('REAL_END_0 ');
    // The collapsed middle lines are gone; head content is still present.
    expect(preview).not.toContain('middle-b');
    expect(preview).toContain('HHHH');
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

describe('metaSandboxSwitchActiveId + activeSandboxId typed field (Phase 2 #627)', () => {
  it('parses a successful switch result to the target id', () => {
    expect(
      metaSandboxSwitchActiveId(
        'switched active sandbox to id=sbx_abc123 tools=["list_dir","exec","read_file","write_file","str_replace","change_dir","pwd","http_get","http_head"]',
      ),
    ).toBe('sbx_abc123');
  });

  it('returns undefined for errors / non-switch / empty', () => {
    expect(metaSandboxSwitchActiveId('ERROR meta_sandbox_switch: no sandbox configured')).toBeUndefined();
    expect(metaSandboxSwitchActiveId('list_dir .: 2 entries')).toBeUndefined();
    expect(metaSandboxSwitchActiveId('')).toBeUndefined();
    expect(metaSandboxSwitchActiveId(undefined)).toBeUndefined();
  });

  it('attaches the TYPED activeSandboxId on a successful meta_sandbox_switch tool_result (Phase 2 #627 test 1)', () => {
    const evs = mapFullStreamPart({
      type: 'tool-result',
      toolName: 'meta_sandbox_switch',
      toolCallId: 'c1',
      output:
        'switched active sandbox to id=sbx_abc123 tools=["list_dir","exec","read_file","write_file","str_replace","change_dir","pwd","http_get","http_head"]',
    });
    const ev = evs[0];
    expect(ev && ev.type).toBe('tool_result');
    if (ev && ev.type === 'tool_result') {
      expect(ev.ok).toBe(true);
      expect(ev.activeSandboxId).toBe('sbx_abc123');
    }
  });

  it('does NOT attach activeSandboxId to a failed switch or a non-switch tool', () => {
    const errEv = mapFullStreamPart({
      type: 'tool-result',
      toolName: 'meta_sandbox_switch',
      toolCallId: 'c1',
      output: 'ERROR meta_sandbox_switch: no sandbox configured',
    })[0];
    if (errEv && errEv.type === 'tool_result') {
      expect(errEv.ok).toBe(false);
      expect(errEv.activeSandboxId).toBeUndefined();
    }
    const listEv = mapFullStreamPart({
      type: 'tool-result',
      toolName: 'list_dir',
      toolCallId: 'c1',
      output: 'list_dir .: 1 entry',
    })[0];
    if (listEv && listEv.type === 'tool_result') {
      expect(listEv.ok).toBe(true);
      expect(listEv.activeSandboxId).toBeUndefined();
    }
  });
});

describe('mapFullStreamPart finish-step / finish usage events (Phase 3 #628)', () => {
  it('emits a usage event from a finish-step part with SDK-shaped usage', () => {
    const evs = mapFullStreamPart({
      type: 'finish-step',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toEqual({
      type: 'usage',
      usage: { source: 'provider', prompt: 100, completion: 50, total: 150 },
    });
  });

  it('emits a usage event from a finish part with SDK-shaped totalUsage', () => {
    const evs = mapFullStreamPart({
      type: 'finish',
      finishReason: 'stop',
      totalUsage: { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toEqual({
      type: 'usage',
      usage: { source: 'provider', prompt: 200, completion: 75, total: 275 },
    });
  });

  it('emits NO usage event when a finish-step part has empty/absent usage', () => {
    // Empty usage object — provider reported nothing usable.
    expect(mapFullStreamPart({ type: 'finish-step', usage: {} })).toEqual([]);
    // No usage field at all.
    expect(mapFullStreamPart({ type: 'finish-step' })).toEqual([]);
    // Null usage.
    expect(mapFullStreamPart({ type: 'finish-step', usage: null })).toEqual([]);
  });

  it('emits NO usage event when a finish part has empty/absent totalUsage', () => {
    expect(mapFullStreamPart({ type: 'finish', finishReason: 'stop' })).toEqual([]);
    expect(mapFullStreamPart({ type: 'finish', totalUsage: null })).toEqual([]);
  });
});
