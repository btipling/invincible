import { assertScimRequest } from '../../../../../../lib/tenancy/scimAuth';
import { scimErrorResponse } from '../../../../../../lib/tenancy/scimProtocol';
import { createProdServices } from '../../../../../../lib/di';

export const runtime = 'nodejs';

const { scim } = createProdServices();

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) return scimErrorResponse(400, 'id required');
  return scim.handleScimGetUser(req, id);
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) return scimErrorResponse(400, 'id required');
  return scim.handleScimPutUser(req, id);
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) return scimErrorResponse(400, 'id required');
  return scim.handleScimPatchUser(req, id);
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) return scimErrorResponse(400, 'id required');
  return scim.handleScimDeleteUser(id);
}
