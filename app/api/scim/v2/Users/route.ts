import { assertScimRequest } from '../../../../../lib/tenancy/scimAuth';
import { createProdServices } from '../../../../../lib/di';

export const runtime = 'nodejs';

const { scim } = createProdServices();

export async function GET(req: Request): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  return scim.handleScimListUsers(req);
}

export async function POST(req: Request): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  return scim.handleScimCreateUser(req);
}
