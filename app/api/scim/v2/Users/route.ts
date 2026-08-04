import { assertScimRequest } from '../../../../../lib/tenancy/scimAuth';
import {
  handleScimCreateUser,
  handleScimListUsers,
} from '../../../../../lib/tenancy/scimHandlers';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  return handleScimListUsers(req);
}

export async function POST(req: Request): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  return handleScimCreateUser(req);
}
