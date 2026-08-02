import { NextRequest } from "next/server";
import {
  ConnectorRepository,
  connectorIdSchema,
  connectorUpdateSchema,
  validateConnectorInput,
} from "@/lib/connectors";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOwnerMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

type Context = { params: Promise<{ connectorId: string }> };

export async function PUT(request: NextRequest, context: Context) {
  try {
    assertOwnerMutation(request);
    const id = connectorIdSchema.parse((await context.params).connectorId);
    const input = connectorUpdateSchema.parse(await request.json());
    const repository = new ConnectorRepository(getDatabasePool());
    const existing = await repository.get(id);
    validateConnectorInput(id, input.publicConfig, input.credentials, Boolean(existing?.encrypted_credentials));
    await repository.save(id, input.publicConfig, input.credentials);
    return noStoreJson({ ok: true });
  } catch (error) {
    return apiError(error, "OPS_CONNECTOR_SAVE_FAILED");
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertOwnerMutation(request);
    const id = connectorIdSchema.parse((await context.params).connectorId);
    await new ConnectorRepository(getDatabasePool()).disconnect(id);
    return noStoreJson({ ok: true });
  } catch (error) {
    return apiError(error, "OPS_CONNECTOR_DISCONNECT_FAILED");
  }
}
