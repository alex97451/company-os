import { NextRequest } from "next/server";
import { ConnectorRepository, connectorIdSchema, testConnector } from "@/lib/connectors";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOwnerMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

type Context = { params: Promise<{ connectorId: string }> };

export async function POST(request: NextRequest, context: Context) {
  try {
    assertOwnerMutation(request);
    const id = connectorIdSchema.parse((await context.params).connectorId);
    await testConnector(new ConnectorRepository(getDatabasePool()), id);
    return noStoreJson({ ok: true });
  } catch (error) {
    return apiError(error, "OPS_CONNECTOR_TEST_FAILED");
  }
}
