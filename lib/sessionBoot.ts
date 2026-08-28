/**
 * Host-side initial-session boot (phase 3, #415) — pure + testable.
 *
 * The HarnessHost mounts a **local-first** first paint from SessionStore, then runs
 * the cloud boot async (repo.enabled) using these helpers + orchestrator. Canonical
 * identity rule (parent #415 lock): the persisted `SessionSnapshot.id` IS the
 * server-minted session UUID; the URL `?s=`, repository key, and resource `:id` are
 * all the same id.
 */
import { shouldAdoptServer, type CloudGetResult, type IdSessionRepository } from './sessionRepository';
import type { SessionSnapshot } from './sessionStore';

/** Local placeholder ids minted by `createEmptySession` when never cloud-bound. */
export const LOCAL_OPAQUE_PREFIX = 'sess_';

/** True for a server-minted id (UUID) vs the local `sess_…` placeholder. */
export function isServerMintedSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.length > 0 && !id.startsWith(LOCAL_OPAQUE_PREFIX);
}

/** Read the active session id from a URL's `?s=` param. */
export function readUrlSessionId(url: string): string | null {
  try {
    const u = new URL(url, 'http://localhost');
    const s = u.searchParams.get('s');
    return s && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/** Clone a URL string with `?s=<id>` set (or removed when id is null/empty). */
export function withUrlSessionId(url: string, id: string | null): string {
  const u = new URL(url, 'http://localhost');
  if (id && id.length > 0) u.searchParams.set('s', id);
  else u.searchParams.delete('s');
  return u.toString();
}

export type InitialTarget =
  | { kind: 'pin'; id: string } // URL-provided id to get()
  | { kind: 'adopt'; id: string } // bound local id to get()
  | { kind: 'mint' } // create a (first) server session
  | { kind: 'local' }; // repo disabled → local only

export function decideInitialTarget(opts: {
  urlId: string | null;
  localId: string | null;
  repoEnabled: boolean;
}): InitialTarget {
  if (opts.urlId) return { kind: 'pin', id: opts.urlId };
  if (opts.repoEnabled && opts.localId && isServerMintedSessionId(opts.localId)) {
    return { kind: 'adopt', id: opts.localId };
  }
  if (opts.repoEnabled) return { kind: 'mint' };
  return { kind: 'local' };
}

/**
 * When a pinned/adopted id is gone (404) — **never blank** (parent #411 lock).
 * Falls back to the bound local id if present, else mints a fresh session, else
 * stays local-only. Returns an `InitialTarget` for the caller to resolve.
 */
export function fallbackAfterGone(
  goneId: string,
  opts: { localId: string | null; repoEnabled: boolean },
): InitialTarget {
  if (opts.localId && isServerMintedSessionId(opts.localId) && opts.localId !== goneId) {
    return { kind: 'adopt', id: opts.localId };
  }
  if (opts.repoEnabled) return { kind: 'mint' };
  return { kind: 'local' };
}

/**
 * Decide whether a boot `get(id)` server snapshot should be adopted over the live
 * local session — the LWW guard for the boot-pin path (adversarial re-review #430,
 * pass 3). A server-minted row can be the **empty** mint (`updatedAt: 0`) while the
 * local store holds dialogue under the **same id** (a deferred-mint bind wrote it,
 * but a still-in-flight `put` hasn't flushed it to the cloud yet). Adopting that
 * empty body would wipe the first-turn transcript on reload. So when `local.id ===
 * server.id`, only adopt if the server actually wins LWW; when the ids differ this is
 * a genuine pin/adopt of a *different* session, so we adopt (server owns content).
 */
export function shouldAdoptBootServer(
  local: SessionSnapshot,
  server: SessionSnapshot,
): boolean {
  if (local.id === server.id) {
    return shouldAdoptServer(local, server);
  }
  return true;
}

/**
 * LWW for an **ok** cloud GET. Non-ok results never reach this helper on the
 * host (`bootCloudSession` skips `onAdopt`). Int F5/C15 rows must use
 * {@link snapshotAfterRepoGet} so they match that skip.
 *
 * Envelope-wins on an unreadable blob is {@link snapshotAfterRepoGet}
 * (error carriers) plus `bootCloudSession` `onGetMiss`. Overlay-only
 * inside `bootCloudSnapshot` cannot reach `kickColdAttach` — `getEnvelope`
 * passes `getEnvelopeParseLocal` (empty mint) that loses LWW to a completed
 * local.
 *
 * Pin vs rehydrate is {@link restoreOnGetMiss}: same-id only, and a live
 * GET still returns `'adopted'` on identity so `bootCloudSession` pins
 * `?s=` instead of clearing it.
 */
export function snapshotAfterCloudGet(
  local: SessionSnapshot,
  got: CloudGetResult,
): SessionSnapshot {
  if (got.action === 'ok' && shouldAdoptBootServer(local, got.snapshot)) {
    return got.snapshot;
  }
  return local;
}

/**
 * Host restore after `repo.get` — every `CloudGetResult` action.
 *
 * Matches `bootCloudSession` + `HarnessHost`:
 * - `action === 'ok'` → LWW via {@link snapshotAfterCloudGet}, then merge
 *   **live** envelope carriers onto the snapshot we keep (phase-2 safety:
 *   a readable blob that loses LWW still attaches).
 * - `action !== 'ok'` → keep `local` messages; merge live carriers from the
 *   error result. Host `onGetMiss` uses {@link restoreOnGetMiss}: rehydrate
 *   when the merge changes the snapshot; pin `?s=` on live identity.
 *
 * Live = `turnStatus === 'running'` and a non-empty `turnRunId`. Same-id is
 * the host's job (`onGetMiss` refuses `local.id !== id`).
 *
 * No-op returns the **same reference** as `local` (or the LWW-kept base) so
 * `onGetMiss` does not re-hydrate when carriers already match. Pin is a
 * separate decision ({@link restoreOnGetMiss}): a live GET still pins `?s=`
 * on identity overlay.
 */
export function snapshotAfterRepoGet(
  local: SessionSnapshot,
  got: CloudGetResult,
): SessionSnapshot {
  const base = got.action === 'ok' ? snapshotAfterCloudGet(local, got) : local;
  const live = liveTurnCarriers(got);
  if (!live) return base;
  if (
    base.turnStatus === live.turnStatus &&
    base.turnRunId === live.turnRunId &&
    (live.turnStreamCursor === undefined || base.turnStreamCursor === live.turnStreamCursor)
  ) {
    return base;
  }
  const out: SessionSnapshot = {
    ...base,
    turnStatus: live.turnStatus,
    turnRunId: live.turnRunId,
  };
  if (live.turnStreamCursor !== undefined) out.turnStreamCursor = live.turnStreamCursor;
  return out;
}

function liveTurnCarriers(got: CloudGetResult): {
  turnStatus: 'running';
  turnRunId: string;
  turnStreamCursor?: number;
} | null {
  if (got.action === 'ok') {
    const s = got.snapshot;
    if (s.turnStatus === 'running' && s.turnRunId) {
      return {
        turnStatus: 'running',
        turnRunId: s.turnRunId,
        ...(s.turnStreamCursor !== undefined ? { turnStreamCursor: s.turnStreamCursor } : {}),
      };
    }
    return null;
  }
  if (got.action === 'error' && got.turnStatus === 'running' && got.turnRunId) {
    return {
      turnStatus: 'running',
      turnRunId: got.turnRunId,
      ...(got.turnStreamCursor !== undefined ? { turnStreamCursor: got.turnStreamCursor } : {}),
    };
  }
  return null;
}

/**
 * Host `onGetMiss` policy. Same-id only.
 *
 * - Overlay changed → rehydrate (`adopt`) and pin.
 * - Overlay identity but GET is live → pin only (local already has carriers;
 *   post-boot `kickColdAttach` attaches). Must **not** skip pin: same-tab F5
 *   during a live turn hits identity, and `bootCloudSession` clears `?s=`
 *   unless this returns `'adopted'`.
 * - Else skip (disabled / non-live error / id mismatch).
 */
export type GetMissRestore =
  | { kind: 'skip' }
  | { kind: 'pin' }
  | { kind: 'adopt'; snapshot: SessionSnapshot };

export function restoreOnGetMiss(
  local: SessionSnapshot,
  got: CloudGetResult,
  getId: string,
): GetMissRestore {
  if (local.id !== getId) return { kind: 'skip' };
  const restored = snapshotAfterRepoGet(local, got);
  if (restored !== local) return { kind: 'adopt', snapshot: restored };
  if (liveTurnCarriers(got)) return { kind: 'pin' };
  return { kind: 'skip' };
}

export type SessionBootCallbacks = {
  /** Adopt a server session (local write + Wasm hydrate). Server snapshot owns content. */
  onAdopt: (snapshot: SessionSnapshot, id: string) => void;
  /**
   * Pin/adopt `repo.get` returned error or disabled. `onAdopt` is not called.
   * Host runs {@link restoreOnGetMiss}: live overlay rehydrates; live identity
   * still returns `'adopted'` so boot pins `?s=` (does not `onUrlUpdate(null)`).
   *
   * `id` is the GET target (`?s=` pin or bound local).
   */
  onGetMiss?: (got: CloudGetResult, id: string) => 'adopted' | void;
  /**
   * Bind a freshly minted server id (host preserves local transcript, hydrates).
   * Return `'deferred'` when the id cannot be fully bound yet — e.g. a prompt is
   * streaming and re-hydrating the ring would wipe bridge-only partial output.
   * bootCloudSession then SKIPS the `?s=` URL pin: never advertise a server row
   * as the canonical active id before the host has actually bound it (adversarial
   * re-review #430). `undefined` / `'bound'` → URL updated.
   */
  onMint: (snapshot: SessionSnapshot, id: string) => 'bound' | 'deferred' | void;
  /** Update the URL `?s=` param. */
  onUrlUpdate?: (id: string | null) => void;
};

export type SessionBootResult =
  | { kind: 'used'; id: string }
  | { kind: 'minted'; id: string }
  | { kind: 'kept'; id: string | null }
  | { kind: 'local'; id: string | null };

/**
 * Resolve the active session after first paint. Guarantees: never returns blank —
 * on a gone `?s=` it falls back to a bound local id or mints; on repo disabled it
 * stays local-only and clears any stale `?s=`.
 */
export async function bootCloudSession(options: {
  repo: IdSessionRepository;
  urlId: string | null;
  localId: string | null;
  onAdopt?: SessionBootCallbacks['onAdopt'];
  onMint?: SessionBootCallbacks['onMint'];
  onUrlUpdate?: SessionBootCallbacks['onUrlUpdate'];
  onGetMiss?: SessionBootCallbacks['onGetMiss'];
}): Promise<SessionBootResult> {
  const { repo, urlId, localId, onAdopt, onMint, onUrlUpdate, onGetMiss } = options;

  if (!repo.enabled) {
    onUrlUpdate?.(null);
    return { kind: 'local', id: localId };
  }

  const target = decideInitialTarget({ urlId, localId, repoEnabled: true });

  if (target.kind === 'mint') {
    const created = await repo.create();
    if (created.action !== 'ok') return { kind: 'local', id: localId };
    // A deferred mint (mid-stream) must NOT pin `?s=` to the empty server row yet —
    // the host will rebind once the turn finishes. See onMint doc.
    if (onMint?.(created.snapshot, created.snapshot.id) !== 'deferred') {
      onUrlUpdate?.(created.snapshot.id);
    }
    return { kind: 'minted', id: created.snapshot.id };
  }

  if (target.kind === 'pin' || target.kind === 'adopt') {
    const got = await repo.get(target.id);
    if (got.action === 'ok') {
      onAdopt?.(got.snapshot, got.snapshot.id);
      onUrlUpdate?.(got.snapshot.id);
      return { kind: 'used', id: got.snapshot.id };
    }

    if (got.action === 'notfound') {
      // Never blank.
      const fallback = fallbackAfterGone(target.id, { localId, repoEnabled: true });
      if (fallback.kind === 'mint') {
        const created = await repo.create();
        if (created.action === 'ok') {
          if (onMint?.(created.snapshot, created.snapshot.id) !== 'deferred') {
            onUrlUpdate?.(created.snapshot.id);
          }
          return { kind: 'minted', id: created.snapshot.id };
        }
      } else if (fallback.kind === 'adopt') {
        const g2 = await repo.get(fallback.id);
        if (g2.action === 'ok') {
          onAdopt?.(g2.snapshot, g2.snapshot.id);
          onUrlUpdate?.(g2.snapshot.id);
          return { kind: 'used', id: g2.snapshot.id };
        }
        if (g2.action === 'notfound') {
          onUrlUpdate?.(null);
          return { kind: 'kept', id: localId };
        }
      } else {
        onUrlUpdate?.(null);
        return { kind: 'kept', id: localId };
      }
    }
    // 'disabled' / 'error' → keep local, never blank — unless onGetMiss
    // reports it adopted a restore (envelope-wins). Then pin the GET id;
    // do not onUrlUpdate(null) after a successful restore.
    if (got.action === 'error' || got.action === 'disabled') {
      if (onGetMiss?.(got, target.id) === 'adopted') {
        onUrlUpdate?.(target.id);
        return { kind: 'used', id: target.id };
      }
    }
    onUrlUpdate?.(null);
    return { kind: 'local', id: localId };
  }

  // 'local' target (repo disabled) — already returned above; keep local.
  onUrlUpdate?.(null);
  return { kind: 'local', id: localId };
}
