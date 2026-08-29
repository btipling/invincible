/**
 * Split one model round's toolCalls into waves (plan #880 / #872).
 *
 * Serial separators run alone:
 *  - bind-mutators (`change_dir`, `meta_sandbox_switch`) — cwd/sandbox must
 *    apply before the next wave.
 *  - FS editors (`write_file`, `str_replace`) — `assertCanEdit` must see
 *    preceding `read_file` grants. PathLock only serializes same-path writes,
 *    not read-then-edit (adversarial #881 round-4).
 *
 * Everything between them is one parallel wave (`Promise.all` inside the
 * tool step). `exec` stays parallel so reads can overlap a long exec.
 * No I/O — directive-free so vitest can lock the split without the
 * Workflows VM.
 *
 * Example: [read A, read B, change_dir, read C]
 *   → parallel [A,B] · serial change_dir · parallel [C]
 * Example: [read A, str_replace A]
 *   → parallel [read A] · serial str_replace A
 */

export const BIND_MUTATOR_TOOLS = ['change_dir', 'meta_sandbox_switch'] as const;
export const FS_EDIT_TOOLS = ['write_file', 'str_replace'] as const;

export type ToolWaveCall = {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
};

export type ToolWave = {
  /** False = one serial separator, run alone. True = independent calls, Promise.all. */
  parallel: boolean;
  calls: ToolWaveCall[];
};

export function isBindMutator(toolName: string): boolean {
  return (BIND_MUTATOR_TOOLS as readonly string[]).includes(toolName);
}

export function isFsEdit(toolName: string): boolean {
  return (FS_EDIT_TOOLS as readonly string[]).includes(toolName);
}

/** Serial wave: bind-mutator or FS editor. */
export function isSerialSeparator(toolName: string): boolean {
  return isBindMutator(toolName) || isFsEdit(toolName);
}

export function splitToolWaves(
  calls: ReadonlyArray<ToolWaveCall>,
): ToolWave[] {
  const waves: ToolWave[] = [];
  let buf: ToolWaveCall[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    waves.push({ parallel: true, calls: buf });
    buf = [];
  };
  for (const call of calls) {
    if (isSerialSeparator(call.toolName)) {
      flush();
      waves.push({ parallel: false, calls: [call] });
    } else {
      buf.push(call);
    }
  }
  flush();
  return waves;
}
