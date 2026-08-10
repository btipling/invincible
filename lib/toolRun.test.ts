import { describe, expect, it } from 'vitest';
import {
  TOOL_RUN_ITEMS_MAX,
  TOOL_RUN_VERSION,
  addToolResult,
  addToolStart,
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
    addToolResult(g, 'read_file', true, 'read_file · ✓ ok · a.ts');
    expect(g.items.length).toBe(before);
    expect(g.items[0]!.status).toBe('ok');
    expect(g.items[0]!.brief).toContain('✓ ok');
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
});
