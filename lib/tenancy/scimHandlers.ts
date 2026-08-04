/**
 * SCIM route orchestration — uses identity helpers (parent #64 / phase 3 #77).
 */
import {
  getScimUserById,
  IdentityError,
  listScimUsers,
  scimCreateUser,
  scimSuspendUser,
  scimUpdateUser,
  type ScimListFilter,
} from './identity';
import {
  applyScimPatchOperations,
  identityErrorStatus,
  listResponse,
  parseScimFilter,
  parseScimPagination,
  scimBaseUrlFromRequest,
  scimErrorResponse,
  scimJsonResponse,
  userToScimResource,
  validateScimStringFields,
} from './scimProtocol';

function fromIdentityError(err: unknown): Response {
  if (err instanceof IdentityError) {
    return scimErrorResponse(identityErrorStatus(err.code), err.message);
  }
  console.error('[scim]', err instanceof Error ? err.message : err);
  return scimErrorResponse(500, 'Internal Server Error');
}

export async function handleScimListUsers(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filterRes = parseScimFilter(url.searchParams.get('filter'));
  if (!filterRes.ok) {
    return scimErrorResponse(400, filterRes.detail);
  }
  const pageRes = parseScimPagination(
    url.searchParams.get('startIndex'),
    url.searchParams.get('count'),
  );
  if (!pageRes.ok) {
    return scimErrorResponse(400, pageRes.detail);
  }

  const filter: ScimListFilter | null = filterRes.filter;
  try {
    const { users, totalResults } = await listScimUsers({
      filter,
      startIndex: pageRes.startIndex,
      count: pageRes.count,
    });
    const base = scimBaseUrlFromRequest(req);
    const resources = users.map((u) => userToScimResource(u, base));
    return scimJsonResponse(
      200,
      listResponse(resources, totalResults, pageRes.startIndex, pageRes.count),
    );
  } catch (err) {
    return fromIdentityError(err);
  }
}

export async function handleScimCreateUser(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return scimErrorResponse(400, 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object') {
    return scimErrorResponse(400, 'Invalid body');
  }
  const b = body as Record<string, unknown>;
  let email = '';
  if (typeof b.userName === 'string') {
    email = b.userName;
  } else if (Array.isArray(b.emails) && b.emails[0] && typeof b.emails[0] === 'object') {
    const v = (b.emails[0] as { value?: string }).value;
    if (typeof v === 'string') email = v;
  }
  const displayName =
    typeof b.displayName === 'string'
      ? b.displayName
      : b.name && typeof b.name === 'object' && typeof (b.name as { formatted?: string }).formatted === 'string'
        ? (b.name as { formatted: string }).formatted
        : null;
  const externalId = typeof b.externalId === 'string' ? b.externalId : null;
  const active = typeof b.active === 'boolean' ? b.active : true;

  const lenCheck = validateScimStringFields({ email, displayName, externalId });
  if (!lenCheck.ok) {
    return scimErrorResponse(400, lenCheck.detail);
  }

  try {
    const user = await scimCreateUser({
      email,
      displayName,
      externalId,
      active,
    });
    const base = scimBaseUrlFromRequest(req);
    const resource = userToScimResource(user, base);
    return scimJsonResponse(201, resource, { Location: resource.meta.location });
  } catch (err) {
    return fromIdentityError(err);
  }
}

export async function handleScimGetUser(req: Request, id: string): Promise<Response> {
  try {
    const user = await getScimUserById(id);
    if (!user) {
      return scimErrorResponse(404, 'User not found');
    }
    const base = scimBaseUrlFromRequest(req);
    return scimJsonResponse(200, userToScimResource(user, base));
  } catch (err) {
    return fromIdentityError(err);
  }
}

export async function handleScimPutUser(req: Request, id: string): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return scimErrorResponse(400, 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object') {
    return scimErrorResponse(400, 'Invalid body');
  }
  const b = body as Record<string, unknown>;
  // userName is the SCIM identifier; emails is fallback only (match create).
  let email: string | undefined;
  if (typeof b.userName === 'string') {
    email = b.userName;
  } else if (Array.isArray(b.emails) && b.emails[0] && typeof b.emails[0] === 'object') {
    const v = (b.emails[0] as { value?: string }).value;
    if (typeof v === 'string') email = v;
  }
  const displayName =
    typeof b.displayName === 'string'
      ? b.displayName
      : b.name && typeof b.name === 'object'
        ? ((b.name as { formatted?: string | null }).formatted ?? undefined)
        : undefined;
  const externalId =
    b.externalId === null
      ? null
      : typeof b.externalId === 'string'
        ? b.externalId
        : undefined;
  const active = typeof b.active === 'boolean' ? b.active : undefined;

  const lenCheck = validateScimStringFields({
    email,
    displayName: displayName === undefined ? undefined : displayName,
    externalId,
  });
  if (!lenCheck.ok) {
    return scimErrorResponse(400, lenCheck.detail);
  }

  try {
    const existing = await getScimUserById(id);
    if (!existing) {
      return scimErrorResponse(404, 'User not found');
    }
    const user = await scimUpdateUser(id, {
      email,
      displayName: displayName === undefined ? undefined : displayName,
      externalId,
      active,
    });
    const base = scimBaseUrlFromRequest(req);
    return scimJsonResponse(200, userToScimResource(user, base));
  } catch (err) {
    return fromIdentityError(err);
  }
}

export async function handleScimPatchUser(req: Request, id: string): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return scimErrorResponse(400, 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object') {
    return scimErrorResponse(400, 'Invalid body');
  }
  const operations = (body as { Operations?: unknown }).Operations;
  const applied = applyScimPatchOperations(operations);
  if (!applied.ok) {
    return scimErrorResponse(400, applied.detail);
  }
  const lenCheck = validateScimStringFields(applied.patch);
  if (!lenCheck.ok) {
    return scimErrorResponse(400, lenCheck.detail);
  }
  try {
    const existing = await getScimUserById(id);
    if (!existing) {
      return scimErrorResponse(404, 'User not found');
    }
    const user = await scimUpdateUser(id, applied.patch);
    const base = scimBaseUrlFromRequest(req);
    return scimJsonResponse(200, userToScimResource(user, base));
  } catch (err) {
    return fromIdentityError(err);
  }
}

export async function handleScimDeleteUser(id: string): Promise<Response> {
  try {
    const existing = await getScimUserById(id);
    if (!existing) {
      return scimErrorResponse(404, 'User not found');
    }
    await scimSuspendUser(id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return fromIdentityError(err);
  }
}
