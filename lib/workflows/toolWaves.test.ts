import { describe, expect, it } from 'vitest';
import {
  isBindMutator,
  isFsEdit,
  isSerialSeparator,
  splitToolWaves,
} from './toolWaves';

describe('splitToolWaves', () => {
  it('empty → no waves', () => {
    expect(splitToolWaves([])).toEqual([]);
  });

  it('N independent reads → one parallel wave', () => {
    const calls = [
      { toolName: 'list_dir', toolCallId: 'a' },
      { toolName: 'read_file', toolCallId: 'b' },
      { toolName: 'read_file', toolCallId: 'c' },
    ];
    expect(splitToolWaves(calls)).toEqual([{ parallel: true, calls }]);
  });

  it('single bind-mutator → one serial wave', () => {
    expect(splitToolWaves([{ toolName: 'change_dir', toolCallId: 'd' }])).toEqual([
      { parallel: false, calls: [{ toolName: 'change_dir', toolCallId: 'd' }] },
    ]);
  });

  it('reads · change_dir · reads → three waves', () => {
    const a = { toolName: 'read_file', toolCallId: 'a' };
    const b = { toolName: 'read_file', toolCallId: 'b' };
    const cd = { toolName: 'change_dir', toolCallId: 'cd' };
    const c = { toolName: 'list_dir', toolCallId: 'c' };
    expect(splitToolWaves([a, b, cd, c])).toEqual([
      { parallel: true, calls: [a, b] },
      { parallel: false, calls: [cd] },
      { parallel: true, calls: [c] },
    ]);
  });

  it('sandbox switch is a serial separator', () => {
    const sw = { toolName: 'meta_sandbox_switch', toolCallId: 's' };
    const r = { toolName: 'read_file', toolCallId: 'r' };
    expect(splitToolWaves([sw, r])).toEqual([
      { parallel: false, calls: [sw] },
      { parallel: true, calls: [r] },
    ]);
  });

  it('read_file · str_replace → read wave then serial edit (adversarial #881 round-4)', () => {
    const r = { toolName: 'read_file', toolCallId: 'r' };
    const w = { toolName: 'str_replace', toolCallId: 'w' };
    expect(splitToolWaves([r, w])).toEqual([
      { parallel: true, calls: [r] },
      { parallel: false, calls: [w] },
    ]);
  });

  it('reads · write_file · read → three waves (grant happen-before)', () => {
    const a = { toolName: 'read_file', toolCallId: 'a' };
    const b = { toolName: 'read_file', toolCallId: 'b' };
    const w = { toolName: 'write_file', toolCallId: 'w' };
    const c = { toolName: 'list_dir', toolCallId: 'c' };
    expect(splitToolWaves([a, b, w, c])).toEqual([
      { parallel: true, calls: [a, b] },
      { parallel: false, calls: [w] },
      { parallel: true, calls: [c] },
    ]);
  });

  it('exec stays in the parallel read wave', () => {
    const r = { toolName: 'read_file', toolCallId: 'r' };
    const e = { toolName: 'exec', toolCallId: 'e' };
    expect(splitToolWaves([r, e])).toEqual([{ parallel: true, calls: [r, e] }]);
  });

  it('isBindMutator only for cwd / sandbox switch', () => {
    expect(isBindMutator('change_dir')).toBe(true);
    expect(isBindMutator('meta_sandbox_switch')).toBe(true);
    expect(isBindMutator('read_file')).toBe(false);
    expect(isBindMutator('write_file')).toBe(false);
    expect(isBindMutator('str_replace')).toBe(false);
    expect(isBindMutator('exec')).toBe(false);
  });

  it('isSerialSeparator includes FS editors (adversarial #881 round-4)', () => {
    expect(isSerialSeparator('change_dir')).toBe(true);
    expect(isSerialSeparator('meta_sandbox_switch')).toBe(true);
    expect(isSerialSeparator('write_file')).toBe(true);
    expect(isSerialSeparator('str_replace')).toBe(true);
    expect(isSerialSeparator('read_file')).toBe(false);
    expect(isSerialSeparator('exec')).toBe(false);
    expect(isFsEdit('write_file')).toBe(true);
    expect(isFsEdit('change_dir')).toBe(false);
  });
});
