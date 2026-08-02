import { NextRequest } from "next/server";
import { apiError, noStoreJson } from "@/lib/http";
import { opsOperatorConfigured, requireOwnerSession } from "@/lib/ops/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    requireOwnerSession(request);
    if (!opsOperatorConfigured()) {
      return noStoreJson({ configured: false });
    }
    return noStoreJson({
      configured: true,
      username: process.env.OPS_OPERATOR_USERNAME,
      password: process.env.OPS_OPERATOR_PASSWORD,
      url: `${process.env.OPS_LAN_ORIGIN}/ops`,
    });
  } catch (error) {
    return apiError(error, "OPS_OPERATOR_ACCESS_FAILED");
  }
}
