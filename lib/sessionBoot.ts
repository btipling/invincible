/**
 * Host-side initial-session boot (phase 3, #415) — pure + testable.
 *
 * The HarnessHost mounts a **local-first** first paint from SessionStore, then runs
 * the cloud boot async (repo.enabled) using these helpers + orchestrator. Canonical
 * identity rule (parent #415 lock): the persisted `SessionSnapshot.id` IS the
 * server-minted session UUID; the URL `?s=`, repository key, and resource `:id` are
 * all the same id.
 */
import { shouldAdoptServer, type IdSessionRepository } from './sessionRepository';
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

export type SessionBootCallbacks = {
  /** Adopt a server session (local write + Wasm hydrate). Server snapshot owns content. */
  onAdopt: (snapshot: SessionSnapshot, id: string) => void;
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
}): Promise<SessionBootResult> {
  const { repo, urlId, localId, onAdopt, onMint, onUrlUpdate } = options;

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
    // 'disabled' / 'error' → keep local, never blank.
    onUrlUpdate?.(null);
    return { kind: 'local', id: localId };
  }

  // 'local' target (repo disabled) — already returned above; keep local.
  onUrlUpdate?.(null);
  return { kind: 'local', id: localId };
}
