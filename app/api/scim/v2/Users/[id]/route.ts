import { assertScimRequest } from '../../../../../../lib/tenancy/scimAuth';
import {
  handleScimDeleteUser,
  handleScimGetUser,
  handleScimPatchUser,
  handleScimPutUser,
} from '../../../../../../lib/tenancy/scimHandlers';
import { scimErrorResponse } from '../../../../../../lib/tenancy/scimProtocol';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) return scimErrorResponse(400, 'id required');
  return handleScimGetUser(req, id);
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) return scimErrorResponse(400, 'id required');
  return handleScimPutUser(req, id);
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) return scimErrorResponse(400, 'id required');
  return handleScimPatchUser(req, id);
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const gate = assertScimRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) return scimErrorResponse(400, 'id required');
  return handleScimDeleteUser(id);
}
