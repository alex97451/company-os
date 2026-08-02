import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpSecurityError } from "./security";

export function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export function apiError(error: unknown, fallback = "REQUEST_FAILED"): NextResponse {
  if (error instanceof HttpSecurityError) return noStoreJson({ error: error.code }, { status: error.status });
  if (error instanceof z.ZodError) return noStoreJson({ error: "INVALID_INPUT", issues: error.issues }, { status: 400 });
  const code = error instanceof Error ? error.message : fallback;
  const clientErrors: Record<string, number> = {
    ANALYSIS_NOT_FOUND: 404,
    REPORT_NOT_FOUND: 404,
    INVALID_ANALYSIS_STATE: 409,
    INCOMPATIBLE_COMPARISON: 409,
    SOURCE_RETENTION_TOO_SHORT: 409,
    QUOTA_EXCEEDED: 429,
    EMPTY_FILE: 400,
    FILE_TOO_LARGE: 413,
    UNSUPPORTED_TYPE: 415,
    PDF_PAGE_LIMIT: 422,
    IMAGE_PIXEL_LIMIT: 422,
    COMMAND_STALE_VERSION: 409,
    APPROVAL_STALE_OR_MISMATCHED: 409,
    COMMAND_ALREADY_EXPIRED: 410,
    OWNER_MESSAGE_SENSITIVE_DATA: 422,
    COMPANY_SESSION_ALREADY_ACTIVE: 409,
    COMPANY_SESSION_STALE_VERSION: 409,
    COMPANY_SESSION_NOT_FOUND: 404,
    COMPANY_SESSION_CANNOT_PAUSE: 409,
    COMPANY_SESSION_CANNOT_RESUME: 409,
    COMPANY_SESSION_ALREADY_TERMINAL: 409,
    COMPANY_SESSION_REAL_CODEX_REQUIRED: 503,
    COMPANY_SESSION_RUNTIME_NOT_READY: 503,
    COMPANY_SESSION_COCKPIT_PAUSED: 409,
    COMPANY_SESSION_EXTERNAL_WORK_MUST_BE_DISABLED: 409,
    VIDEO_JOB_ALREADY_ACTIVE: 409,
    VIDEO_JOB_NOT_FOUND: 404,
    VIDEO_MEDIA_NOT_FOUND: 404,
    VIDEO_JOB_NOT_CANCELLABLE: 409,
    VIDEO_JOB_NOT_RETRYABLE: 409,
  };
  const integrationStatus = code.startsWith("CONNECTOR_") || code.startsWith("OAUTH_") || code.startsWith("PROJECT_") ? 400 : undefined;
  const status = clientErrors[code] ?? integrationStatus ?? (code.endsWith("_NOT_CONFIGURED") || code.includes("required") || code.includes("disabled") ? 503 : 500);
  return noStoreJson({ error: status >= 500 ? fallback : code }, { status });
}
