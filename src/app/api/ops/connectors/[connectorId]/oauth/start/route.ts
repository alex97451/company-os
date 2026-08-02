import { NextRequest } from "next/server";
import { ConnectorRepository, createOAuthAuthorization, connectorIdSchema } from "@/lib/connectors";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { assertOwnerMutation } from "@/lib/ops/auth";

export const runtime = "nodejs";

type Context = { params: Promise<{ connectorId: string }> };

export async function POST(request: NextRequest, context: Context) {
  try {
    assertOwnerMutation(request);
    const id = connectorIdSchema.parse((await context.params).connectorId);
    if (id !== "meta" && id !== "reddit") throw new Error("CONNECTOR_OAUTH_UNSUPPORTED");
    const authorizationUrl = await createOAuthAuthorization(new ConnectorRepository(getDatabasePool()), id);
    return noStoreJson({ authorizationUrl });
  } catch (error) {
    return apiError(error, "OPS_CONNECTOR_OAUTH_START_FAILED");
  }
}
