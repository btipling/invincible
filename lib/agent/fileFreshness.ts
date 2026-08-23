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
  /**
   * Serialize the observed-grant ledger (paths + fingerprints only) into a
   * JSON-safe projection so read-before-edit state can cross a Workflow step
   * boundary inside one prompt (backend-agents E, parent #764 lock). A step is
   * a fresh Function; the in-memory `Map` closures below do not survive it, so
   * the durable thread is this projection, capped by
   * `TURN_FRESHLEDGER_SERIALIZED_MAX_ENTRIES` / `_MAX_BYTES` (truncation marker,
   * never a throw). Never store the projection in SessionStore/envelope.
   */
  snapshot(): FreshnessLedgerProjection;
};

/**
 * One serialized path-grant row. `truncated` grants carry no fingerprint; fresh
 * grants carry the observable `mtimeMs`/`size` (when finite) used by gate 2.
 */
export type FreshnessLedgerPath = {
  path: string;
  truncated?: boolean;
  mtimeMs?: number;
  size?: number;
};

/**
 * JSON-safe projection of a `RunFileFreshness` ledger — paths + fingerprints
 * only, never closures. `truncated` is set when the projection had to be cut to
 * stay under the serialization caps (a fork note for the caller: the seed only
 * restores the observed prefix; over-edited paths outside it re-require a read).
 */
export type FreshnessLedgerProjection = {
  paths: FreshnessLedgerPath[];
  truncated: boolean;
};

/**
 * NEW additive caps (plan #791 caps table — backend-agents E). A single prompt's
 * observed read/edit ledger carried serializably across Workflow steps. Generous
 * upper bounds far below the step-arg / run-entity wire budget; truncation marker
 * beyond, never a thrown run.
 */
export const TURN_FRESHLEDGER_SERIALIZED_MAX_ENTRIES = 4096;
export const TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES = 128_000;

/** Stable whole-project JSON projection (entry + path) for the byte budget. */
export function serializedLedgerBytes(projection: FreshnessLedgerProjection): number {
  try {
    return new TextEncoder().encode(JSON.stringify(projection)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

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

export function createRunFileFreshness(
  seed?: FreshnessLedgerProjection | null,
): RunFileFreshness {
  const grants = new Map<string, Grant>();
  // Hydrate a prior projection into the in-memory map (Workflow step boundary).
  // Hostile/malformed rows are skipped, never thrown — fail closed (corrupt blob
  // → a missing grant just re-requires a read, a safe default).
  if (seed && Array.isArray(seed.paths)) {
    for (const row of seed.paths) {
      if (!row || typeof row.path !== 'string' || !row.path) continue;
      if (row.truncated) {
        grants.set(row.path, { kind: 'truncated' });
      } else {
        const fp: DiskFingerprint = {};
        if (isFiniteNumber(row.mtimeMs)) fp.mtimeMs = row.mtimeMs;
        if (isFiniteNumber(row.size)) fp.size = row.size;
        grants.set(row.path, { kind: 'fresh', fp });
      }
    }
  }
  let degradeWarned = false;

  function warnDegradeOnce(): void {
    if (degradeWarned) return;
    degradeWarned = true;
    console.warn(DEGRADE_WARN);
  }

  return {
    recordRead(path, info) {
      if (info.truncated) {
        // Never downgrade an existing grant (full → windowed peek).
        // If the file changed on disk between reads, gate 2 (stale
        // fingerprint check) catches it at edit time.
        if (!grants.has(path)) grants.set(path, { kind: 'truncated' });
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

    snapshot() {
      return serializeGrantMap(grants);
    },
  };
}

/**
 * Project the in-memory grant map into a bounded, JSON-safe ledger. Iteration
 * order is insertion order (a small, stable projection). Capped by the NEW
 * entries / bytes caps — a marker `truncated` is set when either would be
 * exceeded (drop further paths, per-path row costs included in the byte
 * budget), never a throw.
 */
function serializeGrantMap(grants: Map<string, Grant>): FreshnessLedgerProjection {
  const entryBudget = TURN_FRESHLEDGER_SERIALIZED_MAX_ENTRIES;
  const byteBudget = TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES;
  const paths: FreshnessLedgerPath[] = [];
  let bytes = 0;
  let truncated = false;

  for (const [path, grant] of grants) {
    if (paths.length >= entryBudget) {
      truncated = true;
      break;
    }
    const row: FreshnessLedgerPath = { path };
    let rowBytes = (path.length * 2) + 16; // path text + keys/overhead estimate
    if (grant.kind === 'truncated') {
      row.truncated = true;
      rowBytes += 8;
    } else {
      const fp = grant.fp;
      if (isFiniteNumber(fp.mtimeMs)) row.mtimeMs = fp.mtimeMs;
      if (isFiniteNumber(fp.size)) row.size = fp.size;
      rowBytes += 16;
    }
    if (bytes + rowBytes > byteBudget) {
      truncated = true;
      break;
    }
    bytes += rowBytes;
    paths.push(row);
  }

  return { paths, truncated };
}

/**
 * Backend-agents E: serialize a ledger to the projection the workflow threads
 * across steps. Equivalent to `ledger.snapshot()`; kept as a named seam so the
 * caller-facing contract documented in the plan (#791) matches the import site.
 */
export function serializeRunFileFreshness(ledger: RunFileFreshness): FreshnessLedgerProjection {
  return ledger.snapshot();
}

/**
 * Backend-agents E: reconstruct a ledger from a projection (or absent/null seed
 * → an empty ledger) in a fresh Workflow step so read-before-edit grants carry
 * across the step boundary inside ONE prompt. Malformed rows are skipped
 * (fail closed) — a dropped grant only re-requires a read.
 */
export function hydrateRunFileFreshness(
  serialized: FreshnessLedgerProjection | null | undefined,
): RunFileFreshness {
  return createRunFileFreshness(serialized ?? null);
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
