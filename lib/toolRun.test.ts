import { describe, expect, it } from 'vitest';
import {
  BRIEF_PREVIEW_MAX,
  TOOL_RUN_ITEMS_MAX,
  TOOL_RUN_MSG_HARD_MAX,
  TOOL_RUN_VERSION,
  addToolResult,
  addToolStart,
  asciiStatus,
  buildTraceGroups,
  countToolRunItems,
  createToolRunGroup,
  decodeToolRun,
  encodeToolRun,
  hasRunningTool,
  toolRunIsFull,
} from './toolRun';

describe('toolRun encode/decode (protocol v10 / plan #345)', () => {
  it('round-trips a group with all statuses + counts', () => {
    const g = createToolRunGroup();
    addToolStart(g, 'list_dir'); // running
    addToolResult(g, 'list_dir', true, 'list_dir · ✓ ok · .: 3 entries'); // ok
    addToolResult(g, 'exec', false, 'exec · ✗ failed · exit=1'); // appended fail

    const text = encodeToolRun(g);
    expect(text).not.toBeNull();

    const decoded = decodeToolRun(text!);
    expect(decoded).not.toBeNull();
    expect(decoded!.items.map((it) => it.name)).toEqual(['list_dir', 'exec']);
    expect(decoded!.items[0]!.status).toBe('ok');
    expect(decoded!.items[1]!.status).toBe('fail');
    const counts = countToolRunItems(decoded!.items);
    expect(counts).toEqual({ ok: 1, fail: 1, pending: 0 });
  });

  it('completes a running item in place (does not append a duplicate)', () => {
    const g = createToolRunGroup();
    addToolStart(g, 'read_file');
    const before = g.items.length;
    addToolResult(
      g,
      'read_file',
      true,
      'read_file · ✓ ok · a.ts',
      'first line\nsecond line',
    );
    expect(g.items.length).toBe(before);
    expect(g.items[0]!.status).toBe('ok');
    // #358 Major: brief text is ASCII (symbol glyph lives in the mark column only).
    expect(g.items[0]!.brief).toContain('· ok');
    expect(g.items[0]!.brief).not.toContain('✓');
    // #353: L2 detail carries the server preview when it enriches L1.
    expect(g.items[0]!.detail).toBe('first line\nsecond line');
  });

  it('escapes tabs / newlines / backslashes across fields', () => {
    const g = createToolRunGroup();
    g.items.push({
      id: 1,
      status: 'ok',
      name: 'with\ttab',
      brief: 'line one\nline two',
      detail: 'back\\slash',
    });
    const text = encodeToolRun(g);
    const decoded = decodeToolRun(text!);
    expect(decoded).not.toBeNull();
    expect(decoded!.items[0]!.name).toBe('with\ttab');
    expect(decoded!.items[0]!.brief).toBe('line one\nline two');
    expect(decoded!.items[0]!.detail).toBe('back\\slash');
  });

  it('fails open on empty / bad header / unknown version', () => {
    expect(decodeToolRun('')).toBeNull();
    expect(decodeToolRun('garbage')).toBeNull();
    expect(decodeToolRun(`toolrun\t${TOOL_RUN_VERSION + 1}\t1/0/0`)).toBeNull();
    expect(decodeToolRun('toolrun\tjunk\t1/0/0')).toBeNull();
    expect(decodeToolRun('notatoolrun\t1\t1/0/0')).toBeNull();
  });

  it('reports header version constant', () => {
    expect(TOOL_RUN_VERSION).toBe(1);
  });
});

describe('toolRun grouping', () => {
  it('hasRunningTool finds the most recent running item', () => {
    const g = createToolRunGroup();
    addToolStart(g, 'exec');
    expect(hasRunningTool(g, 'exec')).toBe(true);
    addToolResult(g, 'exec', true, 'exec ok');
    expect(hasRunningTool(g, 'exec')).toBe(false);
  });

  it('toolRunIsFull only at the cap', () => {
    const g = createToolRunGroup();
    for (let i = 0; i < TOOL_RUN_ITEMS_MAX - 1; i++) {
      addToolStart(g, `t${i}`);
    }
    expect(toolRunIsFull(g)).toBe(false);
    addToolStart(g, `t${TOOL_RUN_ITEMS_MAX - 1}`);
    expect(toolRunIsFull(g)).toBe(true);
  });
});

describe('buildTraceGroups (JSON/non-stream fallback)', () => {
  it('chunks a long trace at TOOL_RUN_ITEMS_MAX', () => {
    const n = TOOL_RUN_ITEMS_MAX + 3;
    const trace = Array.from({ length: n }, (_, i) => ({
      name: `t${i}`,
      ok: true,
      summary: `step ${i}`,
    }));
    const groups = buildTraceGroups(trace);
    expect(groups.length).toBe(2);
    expect(groups[0]!.items).toHaveLength(TOOL_RUN_ITEMS_MAX);
    expect(groups[1]!.items).toHaveLength(3);
    let total = 0;
    for (const g of groups) total += g.items.length;
    expect(total).toBe(n);
    for (const g of groups) {
      const text = encodeToolRun(g);
      expect(decodeToolRun(text!)!.items).toHaveLength(g.items.length);
    }
  });

  it('marks failure status from trace ok flag', () => {
    const groups = buildTraceGroups([
      { name: 'a', ok: true, summary: 'a ok' },
      { name: 'b', ok: false, summary: 'b fail' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((it) => it.status)).toEqual(['ok', 'fail']);
  });

  it('returns empty for undefined / empty trace', () => {
    expect(buildTraceGroups(undefined)).toEqual([]);
    expect(buildTraceGroups([])).toEqual([]);
  });

  it('records running vs done counts', () => {
    const g = createToolRunGroup();
    addToolStart(g, 'run');
    addToolResult(g, 'ok1', true, 'ok1');
    addToolResult(g, 'fail1', false, 'fail1');
    expect(countToolRunItems(g.items)).toEqual({ ok: 1, fail: 1, pending: 1 });
  });

  it('level-2 detail carries the preview while brief is a short one-liner', () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i} of output`).join(
      '\n',
    );
    const g = createToolRunGroup();
    // #353: rich detail flows through the `preview` param (server tool_result.preview).
    addToolResult(g, 'exec', true, 'exec · ✓ ok · exit=0', long);
    const it0 = g.items[0]!;
    // Acceptance for two-level detail: level-2 is genuinely longer than level-1.
    expect(it0.detail).toBe(long);
    expect(it0.detail.length).toBeGreaterThan(it0.brief.length);
    expect(it0.brief.length).toBeLessThanOrEqual(BRIEF_PREVIEW_MAX + 1);
    expect(it0.brief).not.toContain('\n');

    // Short/empty summary without a richer preview → name+status fallback, empty
    // detail (static label — no duplicate-of-L1 expander, phase 3 #353).
    // #358 Major: brief text is ASCII — the ✓/✗ symbol is the mark column's job,
    // and the Noto text faces the L1 expander / L2 body paint with do not cover it.
    addToolResult(g, 'read_file', true, 'read_file · ✓ ok · a.ts');
    addToolResult(g, 'noop', true, '');
    expect(g.items[1]!.brief).toContain('· ok');
    expect(g.items[1]!.brief).not.toContain('✓');
    expect(g.items[1]!.detail).toBe('');
    expect(g.items[2]!.brief).toBe('noop · ok');
    expect(g.items[2]!.detail).toBe('');

    // Tiering survives encode→decode round-trip.
    const decoded = decodeToolRun(encodeToolRun(g)!);
    expect(decoded).not.toBeNull();
    expect(decoded!.items[0]!.detail).toBe(long);
    expect(decoded!.items[0]!.detail.length).toBeGreaterThan(
      decoded!.items[0]!.brief.length,
    );
  });

  it('meaningfulDetail: preview only when it truly enriches the L1 one-liner', () => {
    const g = createToolRunGroup();
    // Identical preview → no pretend expand (empty detail → static label).
    addToolResult(g, 'list_dir', true, 'list_dir · ✓ ok · .: 3 entries', 'list_dir · ok · .: 3 entries');
    expect(g.items[0]!.detail).toBe('');
    // No preview (short result from the backend) → empty detail.
    addToolResult(g, 'pwd', true, 'pwd · ✓ ok · /tmp');
    expect(g.items[1]!.detail).toBe('');
    // Empty summary but a real preview → keep the preview (backend only emits a
    // preview when it is richer than an L1 one-liner; never silently drop a body).
    addToolResult(g, 'noop', true, '', 'some preview');
    expect(g.items[2]!.detail).toBe('some preview');
    // Richer multi-line preview → kept verbatim (body keeps its symbols).
    addToolResult(g, 'exec', true, 'exec · ✓ ok · exit=0', 'cmd\nline two\n→ done');
    expect(g.items[3]!.detail).toBe('cmd\nline two\n→ done');
  });

  it('clamps a multi-preview group so the encoded message stays ≤ TOOL_RUN_MSG_HARD_MAX', () => {
    // Adversarial review #359 Major / Nit L6: several near-100k previews in ONE
    // group must never overflow the 262 144-byte ring/cloud per-msg cap. The
    // group encode budget clips/omits later previews (explicit `…` or a dropped
    // static-label detail), never a silent mid-payload truncation.
    const g = createToolRunGroup();
    const big = 'y'.repeat(99_000);
    addToolResult(g, 'exec', true, 'exec · ✓ ok', big);
    addToolResult(g, 'read_file', true, 'read_file · ✓ ok', big);
    addToolResult(g, 'exec', true, 'exec · ✓ ok', big);
    const text = encodeToolRun(g)!;
    expect(text.length).toBeLessThanOrEqual(TOOL_RUN_MSG_HARD_MAX);
    // Header + rows stay 5-field aligned → decodes cleanly, counts exact.
    const decoded = decodeToolRun(text);
    expect(decoded).not.toBeNull();
    expect(decoded!.items).toHaveLength(3);
    expect(countToolRunItems(decoded!.items)).toEqual({ ok: 3, fail: 0, pending: 0 });
    // At least the first preview survives fully; the message still fits.
    expect(decoded!.items[0]!.detail).toBe(big);
  });

  it('buildTraceGroups can never overflow the per-message hard cap either', () => {
    const trace = Array.from({ length: 40 }, (_, i) => ({
      name: `t${i}`,
      ok: true,
      summary: 's'.repeat(20_000), // oversize summaries still bounded by group budget
    }));
    const groups = buildTraceGroups(trace);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const text = encodeToolRun(group)!;
      expect(text.length).toBeLessThanOrEqual(TOOL_RUN_MSG_HARD_MAX);
      expect(decodeToolRun(text)).not.toBeNull();
    }
  });
});

describe('asciiStatus / no symbol tofu in brief·detail text (#358 Major)', () => {
  it('rewrites the deterministic status token to ASCII letters', () => {
    expect(asciiStatus('list_dir · ✓ ok · a')).toBe('list_dir · ok · a');
    expect(asciiStatus('exec · ✗ failed · exit=1')).toBe('exec · failed · exit=1');
    expect(asciiStatus('tool · running…')).toBe('tool · running…');
    expect(asciiStatus('no · token here')).toBe('no · token here');
  });

  it('brief/detail never carry the ✓/✗ glyphs the Noto text faces cannot paint', () => {
    const g = createToolRunGroup();
    addToolResult(g, 'list_dir', true, 'list_dir · ✓ ok · .: 3 entries');
    addToolResult(g, 'exec', false, 'exec · ✗ failed · exit=1');
    for (const it of g.items) {
      expect(it.brief).not.toContain('✓');
      expect(it.brief).not.toContain('✗');
      expect(it.detail).not.toContain('✓');
      expect(it.detail).not.toContain('✗');
      // Letters remain so the status is still readable in text.
      expect(it.brief).toContain(it.status === 'ok' ? '· ok' : '· failed');
    }
    // The wire payload that feeds the expander/body paint is symbol-free too.
    const text = encodeToolRun(g);
    expect(text).not.toContain('✓');
    expect(text).not.toContain('✗');
  });

  it('buildTraceGroups also emits ASCII brief/detail (non-stream fallback)', () => {
    const groups = buildTraceGroups([
      { name: 'a', ok: true, summary: 'a · ✓ ok · x' },
      { name: 'b', ok: false, summary: 'b · ✗ failed · y' },
    ]);
    const items = groups[0]!.items;
    expect(items[0]!.brief).toBe('a · ok · x');
    expect(items[0]!.detail).toBe('a · ok · x');
    expect(items[1]!.brief).toBe('b · failed · y');
    expect(items[1]!.brief).not.toContain('✗');
    expect(items[1]!.detail).not.toContain('✗');
  });

  it('collapsed brief sanitizes the → symbol (single Noto run)', () => {
    const g = createToolRunGroup();
    addToolResult(g, 'http_get', true, 'http_get https://x.com → 200 · 12 B');
    const it0 = g.items[0]!;
    // L1 expander paints brief with a single Noto run — no symbol fallback →
    // the arrow must become ASCII in the collapsed preview.
    expect(it0.brief).toBe('http_get https://x.com -> 200 · 12 B');
    expect(it0.brief).not.toContain('→');
    // #353: single-line result without a richer preview → static label (empty
    // detail), no duplicate-of-L1 expander.
    expect(it0.detail).toBe('');
  });

  it('L2 preview detail keeps symbols; the body face renders them (not tofu)', () => {
    const g = createToolRunGroup();
    addToolResult(g, 'http_get', true, 'http_get · ✓ ok', 'title line\nbody → 200\nmore');
    // The symbols-aware L2 body (`mixed_text`) can paint `→`; only the collapsed
    // L1 `brief` (single Noto run) must be ASCII.
    expect(g.items[0]!.detail).toBe('title line\nbody → 200\nmore');
    expect(g.items[0]!.detail).toContain('→');
  });
});
