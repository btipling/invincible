/**
 * Resolve sandbox + grants for an authenticated user.
 * Vercel backend: attach-only Workspace instance (status running); never create.
 * Exactly one sole tenant membership. Among usable grants: use the user's
 * preferred sandbox when set and usable; if exactly one usable grant, use it;
 * if multiple usable and no valid preference → selection-required error.
 * Branch on per-row `backend` (byo | vercel); BYO decrypts token via tenant DEK.
 */
import { and, eq } from 'drizzle-orm';
import {
  sandboxGrants,
  sandboxes,
  tenantMembers,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import { type SandboxClient } from '../sandbox/client';
import { normalizeBaseUrl } from '../sandbox/config';
import { type CreateVercelSandboxClientOptions } from '../sandbox/vercelClient';
import {
  SANDBOX_FORBIDDEN_ERROR,
  SANDBOX_SELECTION_REQUIRED_ERROR,
  WORKSPACE_INSTANCE_REQUIRED_ERROR,
} from './errors';
import {
  effectiveGrantPermissions,
  isUsableGrant,
  type EffectivePermissions,
} from './grants';
import {
  isSandboxBackend,
  resolveVercelSandboxImage,
  type SandboxBackend,
} from './sandboxBackend';
import { decryptSandboxToken } from './tenantKeys';
import { getUserPreferredSandboxId } from './userPreferredSandbox';
import { loadInstance } from './userSandboxInstance';

export type ResolvedAgentSandbox = {
  client: SandboxClient;
  permissions: EffectivePermissions;
  /** Plaintext secrets to scrub (BYO decrypted token only; empty for vercel). */
  secrets: string[];
  sandboxId: string;
  tenantId: string;
  backend: SandboxBackend;
  name: string;
  slug: string;
  status: string;
  /** Present for byo only — never invent a host URL for vercel. */
  baseUrl?: string;
  /** Resolved Vercel image ref; null for byo. */
  resolvedImage: string | null;
  /**
   * Jail workspace root R, resolved per binding (both backends). `null` when a
   * BYO daemon is down/pre-v2/partial so an operational probe failure never
   * 403s the resolve (consumers land in #408 P3; never silently map on null).
   */
  workspaceRoot: string | null;
};

export type ResolveAgentSandboxResult =
  | { ok: true; value: ResolvedAgentSandbox }
  | {
      ok: false;
      response: Response;
      /**
       * When true, agent may continue without FS tools (MCP / builtin HTTP).
       * Grant/selection failures omit this (hard 403 unless route builtin soft path).
       */
      softContinue?: boolean;
      /**
       * True for the SELECTION-REQUIRED class only: the caller has MULTIPLE usable
       * sandboxes and no bound/preferred id to single one out. Unlike `softContinue`
       * (workspace-not-running) or a hard forbidden, the agent's always-present
       * `meta_sandbox_list` / `meta_sandbox_switch` tools can DRIVE the pick, so
       * the route may soft-path for the agent to self-select (blocker B3
       * reachability). Never set alongside `softContinue`; never set for forbidden.
       */
      selectionRequired?: boolean;
    };

export type ResolveAgentSandboxDeps = {
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
  /**
   * Override sandbox-token decrypt for tests.
   * Product default: mode-aware tenant DEK (dual / dek-only).
   * Never called for backend=vercel.
   */
  decryptSandboxToken?: (
    tenantId: string,
    ciphertext: string,
  ) => string | Promise<string>;
  /**
   * Server-owned exec env (user GitHub PAT) merged into sandbox clients.
   * Only allowlisted keys; never from the model.
   */
  execEnv?: Record<string, string>;
  /** BYO HTTP client factory (tests). */
  createByoClient?: (opts: {
    baseUrl: string;
    token: string;
    execEnv?: Record<string, string>;
  }) => SandboxClient;
  /**
   * @deprecated Prefer createByoClient. Alias kept for older tests.
   */
  createClient?: (opts: {
    baseUrl: string;
    token: string;
    execEnv?: Record<string, string>;
  }) => SandboxClient;
  /** Vercel FS client factory (tests). Receives attach name (+ optional image/execEnv). */
  createVercelClient?: (
    opts: Pick<CreateVercelSandboxClientOptions, 'name' | 'image' | 'execEnv'>,
  ) => SandboxClient;
};

/**
 * Belt-and-suspenders: never let a workspaceRoot probe throw out of resolve.
 * The BYO/Vercel clients' own `workspaceRoot()` are already non-throwing, but a
 * faulting client must still degrade to null rather than push `resolveAgentSandbox`
 * into `forbidden()` (which would 403 an operational daemon outage as a grant
 * failure). Root consumers land in #408 P3, so a null is safe to carry.
 */
async function nonThrowingWorkspaceRoot(
  client: SandboxClient,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return (await client.workspaceRoot?.({ signal })) ?? null;
  } catch {
    return null;
  }
}

function forbidden(): ResolveAgentSandboxResult {
  return {
    ok: false,
    response: Response.json({ error: SANDBOX_FORBIDDEN_ERROR }, { status: 403 }),
  };
}

/**
 * Exactly one tenant membership. Usable grants: one → use it; many → preferred
 * sandbox from Settings (or 403 selection-required). A requested active id
 * (`init.requestedSandboxId`) wins strictly when it is a row-usable grant;
 * a requested-but-unusable id fails closed (403 selection-required when other
 * usable grants exist, else forbidden). Fail closed otherwise.
 */
export async function resolveAgentSandbox(
  userId: string,
  deps: ResolveAgentSandboxDeps = {},
  init?: { signal?: AbortSignal; requestedSandboxId?: string },
): Promise<ResolveAgentSandboxResult> {
  const id = userId?.trim();
  if (!id) {
    return forbidden();
  }

  try {
    const result = await withConnection(deps, (db) =>
      resolveWithDb(db, id, deps, init?.requestedSandboxId),
    );
    // Probe the per-binding workspace root only AFTER `withConnection` has
    // closed (its own `finally` ran on return). Probing inside the DB callback
    // held a Neon/PgBouncer client checked out across a foreign BYO /health
    // round-trip (bounded by the health probe timeout), pinning pooler slots
    // on a blackholed daemon. A faulting probe still degrades to `null` —
    // never a mislabeled 403. Passing `init?.signal` lets an aborted request
    // cancel the probe immediately.
    if (!result.ok) {
      return result;
    }
    const workspaceRoot = await nonThrowingWorkspaceRoot(
      result.value.client,
      init?.signal,
    );
    return { ok: true, value: { ...result.value, workspaceRoot } };
  } catch {
    return forbidden();
  }
}

async function resolveWithDb(
  db: Db,
  userId: string,
  deps: ResolveAgentSandboxDeps,
  requestedSandboxId?: string,
): Promise<ResolveAgentSandboxResult> {
  try {
    const memberships = await db
      .select({
        tenantId: tenantMembers.tenantId,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, userId));

    if (memberships.length !== 1) {
      return forbidden();
    }
    const tenantId = memberships[0].tenantId;

    const rows = await db
      .select({
        sandboxId: sandboxes.id,
        backend: sandboxes.backend,
        name: sandboxes.name,
        slug: sandboxes.slug,
        image: sandboxes.image,
        baseUrl: sandboxes.baseUrl,
        tokenCiphertext: sandboxes.tokenCiphertext,
        status: sandboxes.status,
        canRead: sandboxGrants.canRead,
        canWrite: sandboxGrants.canWrite,
      })
      .from(sandboxGrants)
      .innerJoin(sandboxes, eq(sandboxGrants.sandboxId, sandboxes.id))
      .where(
        and(eq(sandboxGrants.userId, userId), eq(sandboxes.tenantId, tenantId)),
      );

    const usable = rows.filter((r) =>
      isUsableGrant(r.status, { canRead: r.canRead, canWrite: r.canWrite }),
    );

    if (usable.length === 0) {
      return forbidden();
    }

    // A requested active id wins strictly (preference ignored) when it is a
    // row-usable grant. Requested-but-unusable → fail closed: selection-required
    // when other usable alternatives exist, else forbidden. Never a silent
    // fallback — the honest 403 is what lets the host clear and re-select.
    const requested = requestedSandboxId?.trim();
    let row: (typeof usable)[number];
    if (requested) {
      const match = usable.find((r) => r.sandboxId === requested);
      if (!match) {
        // Multiple usable alternatives → SELECTION-REQUIRED (self-selectable by the
        // agent's meta_sandbox tools, blocker B3). A single usable grant with a
        // stray requested id → forbidden (nothing to select among; agent can't heal).
        const selection = usable.length > 1;
        return {
          ok: false,
          ...(selection ? { selectionRequired: true as const } : {}),
          response: Response.json(
            { error: selection ? SANDBOX_SELECTION_REQUIRED_ERROR : SANDBOX_FORBIDDEN_ERROR },
            { status: 403 },
          ),
        };
      }
      row = match;
    } else if (usable.length > 1) {
      const preferredId = await getUserPreferredSandboxId(userId, tenantId, {
        db,
      });
      const match = preferredId
        ? usable.find((r) => r.sandboxId === preferredId)
        : undefined;
      if (!match) {
        return {
          ok: false,
          // Selection-required (multiple usable, no preferred match) is the
          // self-selectable class — mark it so the route soft-paths to the agent's
          // meta_sandbox tools (blocker B3) instead of a dead-end operator 403.
          selectionRequired: true as const,
          response: Response.json(
            { error: SANDBOX_SELECTION_REQUIRED_ERROR },
            { status: 403 },
          ),
        };
      }
      row = match;
    } else {
      row = usable[0];
    }
    const permissions = effectiveGrantPermissions({
      canRead: row.canRead,
      canWrite: row.canWrite,
    });

    const backendRaw = (row.backend ?? 'byo').trim();
    if (!isSandboxBackend(backendRaw)) {
      return forbidden();
    }
    const backend: SandboxBackend = backendRaw;

    if (backend === 'vercel') {
      // Never decrypt BYO token for vercel rows (even if stale ciphertext remains).
      // Attach-only: require durable Workspace instance running (Settings Create/Start).
      const loaded = await loadInstance(userId, 'workspace', { db });
      if (!loaded.ok) {
        return {
          ok: false,
          softContinue: true,
          response: Response.json(
            { error: WORKSPACE_INSTANCE_REQUIRED_ERROR },
            { status: 403 },
          ),
        };
      }
      const instance = loaded.value;
      if (!instance || instance.status !== 'running') {
        return {
          ok: false,
          softContinue: true,
          response: Response.json(
            { error: WORKSPACE_INSTANCE_REQUIRED_ERROR },
            { status: 403 },
          ),
        };
      }

      const image = instance.image ?? row.image;
      const resolvedImg = resolveVercelSandboxImage(image);
      if (!resolvedImg.ok) {
        return forbidden();
      }

      let client: SandboxClient;
      try {
        // The composition root binds the real Vercel-FS factory; per-row/attach
        // construction stays data-driven here (module never constructs itself).
        const createVercel = deps.createVercelClient;
        if (!createVercel) {
          return forbidden();
        }
        client = createVercel({
          name: instance.vercelName,
          image: instance.image,
          ...(deps.execEnv ? { execEnv: deps.execEnv } : {}),
        });
      } catch {
        // Invalid name / factory throw — fail closed, no message leak.
        return forbidden();
      }

      // `workspaceRoot` is probed at the `resolveAgentSandbox` top level AFTER
      // the DB connection is closed (see the comment there).
      return {
        ok: true,
        value: {
          client,
          workspaceRoot: null,
          permissions,
          secrets: [],
          sandboxId: row.sandboxId,
          tenantId,
          backend: 'vercel',
          name: row.name,
          slug: row.slug,
          status: row.status,
          resolvedImage: resolvedImg.image,
        },
      };
    }

    // backend === 'byo'
    const baseUrlRaw = row.baseUrl?.trim() ?? '';
    const tokenCt = row.tokenCiphertext?.trim() ?? '';
    if (!baseUrlRaw || !tokenCt) {
      return forbidden();
    }

    const decrypt =
      deps.decryptSandboxToken ??
      ((tid: string, ct: string) => decryptSandboxToken(tid, ct, { db }));
    let token: string;
    try {
      token = await decrypt(tenantId, tokenCt);
    } catch {
      return forbidden();
    }
    if (!token?.trim()) {
      return forbidden();
    }

    const baseUrl = normalizeBaseUrl(baseUrlRaw);
    // The composition root binds the real BYO factory; construction is injectable
    // (tests) never in-body (module never constructs I/O directly).
    const createByo = deps.createByoClient ?? deps.createClient;
    if (!createByo) {
      return forbidden();
    }
    const client = createByo({
      baseUrl,
      token,
      ...(deps.execEnv ? { execEnv: deps.execEnv } : {}),
    });

    // `workspaceRoot` is probed at the `resolveAgentSandbox` top level AFTER
    // the DB connection is closed (see the comment there). runAgent preflight
    // still gates FS turns 426/502; consumers land in #408 P3.
    return {
      ok: true,
      value: {
        client,
        workspaceRoot: null,
        permissions,
        secrets: [token],
        sandboxId: row.sandboxId,
        tenantId,
        backend: 'byo',
        name: row.name,
        slug: row.slug,
        status: row.status,
        baseUrl,
        resolvedImage: null,
      },
    };
  } catch {
    // DB errors → fail closed as 403 (no internal detail to host/Wasm)
    return forbidden();
  }
}

/** Factory (DI): binds a fixed deps closure for composition-root wiring. */
export function createResolveSandbox(deps: ResolveAgentSandboxDeps = {}) {
  return {
    resolveAgentSandbox: (
      userId: string,
      o?: ResolveAgentSandboxDeps,
      init?: { signal?: AbortSignal },
    ) => resolveAgentSandbox(userId, { ...deps, ...o }, init),
  };
}
