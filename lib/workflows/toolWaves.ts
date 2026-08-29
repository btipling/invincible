/**
 * Split one model round's toolCalls into waves (plan #880 / #872).
 *
 * Bind-mutators (`change_dir`, `meta_sandbox_switch`) are serial separators.
 * Everything between them is one parallel wave (`Promise.all` inside the
 * tool step). No I/O — directive-free so vitest can lock the split without
 * the Workflows VM.
 *
 * Example: [read A, read B, change_dir, read C]
 *   → parallel [A,B] · serial change_dir · parallel [C]
 */

export const BIND_MUTATOR_TOOLS = ['change_dir', 'meta_sandbox_switch'] as const;

export type ToolWaveCall = {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
};

export type ToolWave = {
  /** False = one bind-mutator, run alone. True = independent calls, Promise.all. */
  parallel: boolean;
  calls: ToolWaveCall[];
};

export function isBindMutator(toolName: string): boolean {
  return (BIND_MUTATOR_TOOLS as readonly string[]).includes(toolName);
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
    if (isBindMutator(call.toolName)) {
      flush();
      waves.push({ parallel: false, calls: [call] });
    } else {
      buf.push(call);
    }
  }
  flush();
  return waves;
}
