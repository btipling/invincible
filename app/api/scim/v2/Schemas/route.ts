import { assertScimRequest } from '../../../../../lib/tenancy/scimAuth';
import { schemasDocument, scimJsonResponse } from '../../../../../lib/tenancy/scimProtocol';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  return scimJsonResponse(200, schemasDocument());
}
