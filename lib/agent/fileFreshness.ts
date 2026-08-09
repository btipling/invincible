/**
 * Run-scoped file observation ledger for read-before-edit (gate 1) and
 * disk fingerprint re-check (gate 2). Owned by runAgent / runAgentStream and
 * passed into every createAgentTools call in the same HTTP agent turn.
 *
 * Never store this in SessionStore or multi-device session blobs.
 */

export type DiskFingerprint = {
  mtimeMs?: number;
  size?: number;
};

export type AssertCanEditResult =
  | { ok: true }
  | { ok: false; code: 'read_required' | 'truncated' | 'stale' };

type Grant =
  | { kind: 'truncated' }
  | { kind: 'fresh'; fp: DiskFingerprint };

export type RunFileFreshness = {
  recordRead(path: string, info: DiskFingerprint & { truncated?: boolean }): void;
  recordWrite(path: string, fp: DiskFingerprint): void;
  assertCanEdit(path: string, live: DiskFingerprint): AssertCanEditResult;
};

const DEGRADE_WARN =
  '[invincible] file freshness: gate 2 (disk mtime) unavailable — enforcing read_file grant only. Restart the BYO sandbox daemon if fingerprints are expected.';

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** True when both sides can be compared for gate 2. */
export function fingerprintsComparable(
  a: DiskFingerprint,
  b: DiskFingerprint,
): boolean {
  return (
    isFiniteNumber(a.mtimeMs) &&
    isFiniteNumber(a.size) &&
    isFiniteNumber(b.mtimeMs) &&
    isFiniteNumber(b.size)
  );
}

export function fingerprintsEqual(a: DiskFingerprint, b: DiskFingerprint): boolean {
  if (!fingerprintsComparable(a, b)) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export function createRunFileFreshness(): RunFileFreshness {
  const grants = new Map<string, Grant>();
  let degradeWarned = false;

  function warnDegradeOnce(): void {
    if (degradeWarned) return;
    degradeWarned = true;
    console.warn(DEGRADE_WARN);
  }

  return {
    recordRead(path, info) {
      if (info.truncated) {
        grants.set(path, { kind: 'truncated' });
        return;
      }
      const fp: DiskFingerprint = {};
      if (isFiniteNumber(info.mtimeMs)) fp.mtimeMs = info.mtimeMs;
      if (isFiniteNumber(info.size)) fp.size = info.size;
      grants.set(path, { kind: 'fresh', fp });
    },

    recordWrite(path, fpIn) {
      const fp: DiskFingerprint = {};
      if (isFiniteNumber(fpIn.mtimeMs)) fp.mtimeMs = fpIn.mtimeMs;
      if (isFiniteNumber(fpIn.size)) fp.size = fpIn.size;
      grants.set(path, { kind: 'fresh', fp });
    },

    assertCanEdit(path, live) {
      const grant = grants.get(path);
      if (!grant) return { ok: false, code: 'read_required' };
      if (grant.kind === 'truncated') return { ok: false, code: 'truncated' };

      if (!fingerprintsComparable(grant.fp, live)) {
        warnDegradeOnce();
        return { ok: true };
      }
      if (!fingerprintsEqual(grant.fp, live)) {
        return { ok: false, code: 'stale' };
      }
      return { ok: true };
    },
  };
}

/** Stable soft-fail strings for tools (locked plan #279). */
export function editGateError(
  tool: 'write_file' | 'str_replace',
  code: 'read_required' | 'truncated' | 'stale',
): string {
  if (tool === 'write_file') {
    switch (code) {
      case 'read_required':
        return 'ERROR write_file: read_file required before overwriting an existing file (this agent run)';
      case 'truncated':
        return 'ERROR write_file: truncated read_file is not enough — re-read the full file before overwriting';
      case 'stale':
        return 'ERROR write_file: file changed since last read_file — re-read before overwriting (other session, device, tool, or exec may have modified it)';
    }
  }
  switch (code) {
    case 'read_required':
      return 'ERROR str_replace: read_file required before editing an existing file (this agent run)';
    case 'truncated':
      return 'ERROR str_replace: truncated read_file is not enough — re-read the full file before editing';
    case 'stale':
      return 'ERROR str_replace: file changed since last read_file — re-read before editing (other session, device, tool, or exec may have modified it)';
  }
}
