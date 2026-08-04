/**
 * SCIM 2.0 protocol helpers — pure map/filter/error (parent #64 / phase 3 #77).
 */
import type { User } from '../../db';

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_CONTENT_TYPE = 'application/scim+json';

export const SCIM_DEFAULT_COUNT = 50;
export const SCIM_MAX_COUNT = 100;

/** Field caps at SCIM HTTP boundary (DB columns are unbounded text). */
export const SCIM_MAX_EMAIL_LEN = 320;
export const SCIM_MAX_DISPLAY_NAME_LEN = 256;
export const SCIM_MAX_EXTERNAL_ID_LEN = 255;

export type ScimUserResource = {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { formatted?: string };
  displayName?: string;
  emails: Array<{ value: string; primary: boolean }>;
  active: boolean;
  meta: {
    resourceType: 'User';
    location: string;
  };
};

export type ScimFilter =
  | { kind: 'userName'; value: string }
  | { kind: 'externalId'; value: string };

export type ParseFilterResult =
  | { ok: true; filter: ScimFilter | null }
  | { ok: false; detail: string };

export type ParsePaginationResult =
  | { ok: true; startIndex: number; count: number }
  | { ok: false; detail: string };

export function scimErrorBody(status: number, detail: string) {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail,
  };
}

export function scimErrorResponse(
  status: number,
  detail: string,
  init?: { headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(scimErrorBody(status, detail)), {
    status,
    headers: {
      'Content-Type': SCIM_CONTENT_TYPE,
      ...(init?.headers ?? {}),
    },
  });
}

export function scimJsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': SCIM_CONTENT_TYPE,
      ...(extraHeaders ?? {}),
    },
  });
}

export function userToScimResource(user: User, scimBaseUrl: string): ScimUserResource {
  const location = `${scimBaseUrl.replace(/\/$/, '')}/Users/${user.id}`;
  const resource: ScimUserResource = {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    userName: user.email,
    emails: [{ value: user.email, primary: true }],
    active: user.status === 'active',
    meta: {
      resourceType: 'User',
      location,
    },
  };
  if (user.scimExternalId) {
    resource.externalId = user.scimExternalId;
  }
  if (user.name) {
    resource.displayName = user.name;
    resource.name = { formatted: user.name };
  }
  return resource;
}

export function listResponse(
  resources: ScimUserResource[],
  totalResults: number,
  startIndex: number,
  count: number,
) {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/**
 * v1 filters only: userName eq "x" | externalId eq "x"
 * Quotes optional; comparison case-sensitive on value after email lowercasing at query layer.
 */
export function parseScimFilter(raw: string | null | undefined): ParseFilterResult {
  if (raw == null || !String(raw).trim()) {
    return { ok: true, filter: null };
  }
  const s = String(raw).trim();
  const m = s.match(
    /^(userName|externalId)\s+eq\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/i,
  );
  if (!m) {
    return {
      ok: false,
      detail: 'Unsupported filter. v1 allows: userName eq "..." or externalId eq "..."',
    };
  }
  const attr = m[1].toLowerCase();
  const value = m[2] ?? m[3] ?? m[4] ?? '';
  if (attr === 'username') {
    return { ok: true, filter: { kind: 'userName', value } };
  }
  return { ok: true, filter: { kind: 'externalId', value } };
}

export function parseScimPagination(
  startIndexRaw: string | null | undefined,
  countRaw: string | null | undefined,
): ParsePaginationResult {
  let startIndex = 1;
  if (startIndexRaw != null && String(startIndexRaw).trim() !== '') {
    const n = Number(startIndexRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, detail: 'startIndex must be an integer' };
    }
    startIndex = n < 1 ? 1 : n;
  }

  let count = SCIM_DEFAULT_COUNT;
  if (countRaw != null && String(countRaw).trim() !== '') {
    const n = Number(countRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, detail: 'count must be a non-negative integer' };
    }
    if (n > SCIM_MAX_COUNT) {
      return {
        ok: false,
        detail: `count must be <= ${SCIM_MAX_COUNT}`,
      };
    }
    count = n;
  }

  return { ok: true, startIndex, count };
}

export function scimBaseUrlFromRequest(req: Request): string {
  const url = new URL(req.url);
  return `${url.origin}/api/scim/v2`;
}

/** Map IdentityError.code → HTTP status. */
export function identityErrorStatus(code: string): number {
  switch (code) {
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'forbidden':
    case 'suspended':
      return 403;
    case 'db':
      return 503;
    default:
      return 500;
  }
}

export type PatchOp = {
  op: string;
  path?: string;
  value?: unknown;
};

/**
 * Apply SCIM PATCH Operations (add/replace only) into a flat update patch.
 */
export function applyScimPatchOperations(operations: unknown): {
  ok: true;
  patch: {
    email?: string;
    displayName?: string | null;
    active?: boolean;
    externalId?: string | null;
  };
} | { ok: false; detail: string } {
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, detail: 'Operations array required' };
  }
  const patch: {
    email?: string;
    displayName?: string | null;
    active?: boolean;
    externalId?: string | null;
  } = {};

  for (const raw of operations) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, detail: 'Invalid Operation' };
    }
    const op = raw as PatchOp;
    const opName = String(op.op ?? '').trim().toLowerCase();
    if (opName !== 'add' && opName !== 'replace') {
      return { ok: false, detail: `Unsupported op: ${op.op}` };
    }
    const path = String(op.path ?? '').trim().toLowerCase().replace(/^\//, '');
    const value = op.value;

    if (path === 'active') {
      if (typeof value !== 'boolean') {
        return { ok: false, detail: 'active must be boolean' };
      }
      patch.active = value;
      continue;
    }
    if (path === 'username' || path === 'emails') {
      if (path === 'emails') {
        if (Array.isArray(value) && value[0] && typeof value[0] === 'object') {
          const v = (value[0] as { value?: string }).value;
          if (typeof v === 'string') {
            patch.email = v;
            continue;
          }
        }
        if (typeof value === 'string') {
          patch.email = value;
          continue;
        }
        return { ok: false, detail: 'emails value invalid' };
      }
      if (typeof value !== 'string') {
        return { ok: false, detail: 'userName must be string' };
      }
      patch.email = value;
      continue;
    }
    if (path === 'displayname' || path === 'name.formatted' || path === 'name') {
      if (value === null) {
        patch.displayName = null;
        continue;
      }
      if (typeof value === 'object' && value && 'formatted' in (value as object)) {
        const f = (value as { formatted?: string | null }).formatted;
        patch.displayName = f == null ? null : String(f);
        continue;
      }
      if (typeof value === 'string') {
        patch.displayName = value;
        continue;
      }
      return { ok: false, detail: 'displayName value invalid' };
    }
    if (path === 'externalid') {
      if (value === null) {
        patch.externalId = null;
        continue;
      }
      if (typeof value !== 'string') {
        return { ok: false, detail: 'externalId must be string' };
      }
      patch.externalId = value;
      continue;
    }
    // No path: value is partial resource (userName wins over emails)
    if (!path && value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (typeof v.active === 'boolean') patch.active = v.active;
      if (typeof v.displayName === 'string') patch.displayName = v.displayName;
      if (typeof v.externalId === 'string') patch.externalId = v.externalId;
      if (v.externalId === null) patch.externalId = null;
      if (Array.isArray(v.emails) && v.emails[0] && typeof v.emails[0] === 'object') {
        const ev = (v.emails[0] as { value?: string }).value;
        if (typeof ev === 'string') patch.email = ev;
      }
      if (typeof v.userName === 'string') patch.email = v.userName;
      continue;
    }
    return { ok: false, detail: `Unsupported path: ${op.path}` };
  }

  return { ok: true, patch };
}

export type ScimStringFields = {
  email?: string;
  displayName?: string | null;
  externalId?: string | null;
};

/** Reject oversized SCIM string fields (fail closed with detail). */
export function validateScimStringFields(
  fields: ScimStringFields,
): { ok: true } | { ok: false; detail: string } {
  if (fields.email !== undefined && fields.email.length > SCIM_MAX_EMAIL_LEN) {
    return { ok: false, detail: `userName/email must be <= ${SCIM_MAX_EMAIL_LEN} characters` };
  }
  if (
    fields.displayName != null &&
    fields.displayName.length > SCIM_MAX_DISPLAY_NAME_LEN
  ) {
    return {
      ok: false,
      detail: `displayName must be <= ${SCIM_MAX_DISPLAY_NAME_LEN} characters`,
    };
  }
  if (
    fields.externalId != null &&
    fields.externalId.length > SCIM_MAX_EXTERNAL_ID_LEN
  ) {
    return {
      ok: false,
      detail: `externalId must be <= ${SCIM_MAX_EXTERNAL_ID_LEN} characters`,
    };
  }
  return { ok: true };
}

export function serviceProviderConfig() {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Authentication using SCIM_BEARER_TOKEN',
        specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
        primary: true,
      },
    ],
  };
}

export function schemasDocument() {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 1,
    Resources: [
      {
        id: SCIM_USER_SCHEMA,
        name: 'User',
        description: 'User Account',
        attributes: [
          { name: 'userName', type: 'string', required: true, uniqueness: 'server' },
          { name: 'externalId', type: 'string', required: false },
          { name: 'displayName', type: 'string', required: false },
          { name: 'active', type: 'boolean', required: false },
          {
            name: 'emails',
            type: 'complex',
            multiValued: true,
            required: false,
          },
        ],
      },
    ],
  };
}
