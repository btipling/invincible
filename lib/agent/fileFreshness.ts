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
  /** Serializable projection of this run's grants (step-boundary delta/seed), row-capped. */
  snapshot(): FreshnessProjection;
};

/** One grant row in the serialized projection. */
export type FreshnessGrantRow =
  | { path: string; kind: 'truncated' }
  | { path: string; kind: 'fresh'; fp: DiskFingerprint };

/** Projection: grants array + an overflow truncation marker (never throws). */
export type FreshnessProjection = {
  grants: FreshnessGrantRow[];
  truncated: boolean;
};

/**
 * Seed accepted by hydrate / createRunFileFreshness: a serialized JSON string,
 * a raw row array, or a parsed projection object.
 */
export type FreshnessSeed = string | FreshnessGrantRow[] | FreshnessProjection;

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

/** Ceiling for the serialized run file-freshness delta seed (64 KiB) — NEW cap (B5). */
export const TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES = 65536;

/** Ceiling for the number of grant rows in a projection — NEW cap (B5). */
export const TURN_FRESHLEDGER_MAX_GRANTS = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a seed into well-formed grant rows (fail-closed): malformed rows are
 * dropped, never thrown. Accepts a serialized JSON string, a row array, or a
 * `{ grants, truncated }` projection object from serializeRunFileFreshness.
 */
function normalizeSeedRows(seed: FreshnessSeed | undefined): FreshnessGrantRow[] {
  if (seed === undefined) return [];
  let arr: unknown = seed;
  if (typeof seed === 'string') {
    try {
      arr = JSON.parse(seed);
    } catch {
      return [];
    }
  }
  if (isRecord(arr) && Array.isArray(arr['grants'])) arr = arr['grants'];
  if (!Array.isArray(arr)) return [];

  const out: FreshnessGrantRow[] = [];
  for (const raw of arr) {
    if (!isRecord(raw)) continue;
    const path = raw['path'];
    if (typeof path !== 'string') continue;
    const kind = raw['kind'];
    if (kind === 'truncated') {
      out.push({ path, kind: 'truncated' });
    } else if (kind === 'fresh') {
      if (!isRecord(raw['fp'])) continue;
      const fp: DiskFingerprint = {};
      if (isFiniteNumber(raw['fp']['mtimeMs'])) fp.mtimeMs = raw['fp']['mtimeMs'];
      if (isFiniteNumber(raw['fp']['size'])) fp.size = raw['fp']['size'];
      out.push({ path, kind: 'fresh', fp });
    }
    // any other kind → dropped (fail-closed)
  }
  return out.length > TURN_FRESHLEDGER_MAX_GRANTS
    ? out.slice(0, TURN_FRESHLEDGER_MAX_GRANTS)
    : out;
}

function projectionToJson(rows: FreshnessGrantRow[], truncated: boolean): string {
  return JSON.stringify({ grants: rows, truncated });
}

/**
 * Serialize a projection to a JSON delta/seed. On byte- or row-cap overflow the
 * tail rows are dropped deterministically and the `truncated` marker is set —
 * the run is never thrown.
 */
export function serializeRunFileFreshness(f: RunFileFreshness): string {
  const snap = f.snapshot();
  let rows = snap.grants;
  let truncated = snap.truncated;
  if (!truncated && projectionToJson(rows, false).length > TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES) {
    truncated = true;
  }
  if (truncated) {
    // Largest prefix that fits under the byte cap, deterministically.
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (
        projectionToJson(rows.slice(0, mid), true).length <=
        TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES
      ) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    rows = rows.slice(0, lo);
  }
  return projectionToJson(rows, truncated);
}

export function createRunFileFreshness(options: { seed?: FreshnessSeed } = {}): RunFileFreshness {
  const grants = new Map<string, Grant>();
  for (const row of normalizeSeedRows(options.seed)) {
    if (row.kind === 'truncated') {
      grants.set(row.path, { kind: 'truncated' });
    } else {
      grants.set(row.path, { kind: 'fresh', fp: { ...row.fp } });
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
      let rows: FreshnessGrantRow[] = [];
      for (const [path, grant] of grants) {
        if (grant.kind === 'truncated') {
          rows.push({ path, kind: 'truncated' });
        } else {
          rows.push({ path, kind: 'fresh', fp: { ...grant.fp } });
        }
      }
      const truncated = rows.length > TURN_FRESHLEDGER_MAX_GRANTS;
      if (truncated) rows = rows.slice(0, TURN_FRESHLEDGER_MAX_GRANTS);
      return { grants: rows, truncated };
    },
  };
}

/** Seedable re-hydration of a projected ledger back into a working RunFileFreshness. */
export function hydrateRunFileFreshness(seed: FreshnessSeed): RunFileFreshness {
  return createRunFileFreshness({ seed });
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
