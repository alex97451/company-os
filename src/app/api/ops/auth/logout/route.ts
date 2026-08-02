import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { assertOpsMutation, clearOpsCookies } from "@/lib/ops/auth";

export async function POST(request: NextRequest) {
  try {
    assertOpsMutation(request);
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    clearOpsCookies(response);
    return response;
  } catch (error) {
    return apiError(error, "OPS_LOGOUT_FAILED");
  }
}
