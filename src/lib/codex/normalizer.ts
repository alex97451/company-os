import { CODEX_BRIDGE_API_VERSION, safeCodexEventSchema, type SafeCodexEvent } from "./contracts";

export const MAX_CODEX_EVENT_BYTES = 16 * 1024;

const sensitiveKey = /^(?:prompt|input|output|reasoning|raw|content|email|secret|token|authorization|cookie|document|quote)$/i;
const emailLike = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const bearerLike = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi;
const apiKeyLike = /\b(?:sk|pk|rk)_[A-Za-z0-9_-]{12,}\b/gi;

export type NormalizeResult =
  | { accepted: true; event: SafeCodexEvent }
  | { accepted: false; code: "not_an_object" | "event_too_large" | "disallowed_field" | "invalid_event" };

/** Normalizes in memory. Callers must never log or persist `raw`. */
export function normalizeCodexEvent(raw: unknown, occurredAt = new Date().toISOString()): NormalizeResult {
  if (!isPlainObject(raw)) return { accepted: false, code: "not_an_object" };

  const size = safeJsonByteLength(raw);
  if (size === null || size > MAX_CODEX_EVENT_BYTES) return { accepted: false, code: "event_too_large" };
  if (Object.keys(raw).some((key) => sensitiveKey.test(key))) return { accepted: false, code: "disallowed_field" };

  const redacted = redactStrings(raw);
  const parsed = safeCodexEventSchema.safeParse(redacted);
  if (!parsed.success) return { accepted: false, code: "invalid_event" };

  return {
    accepted: true,
    event: { ...parsed.data, bridgeVersion: CODEX_BRIDGE_API_VERSION, occurredAt },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeJsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function redactStrings<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(emailLike, "[redacted-email]")
      .replace(bearerLike, "[redacted-credential]")
      .replace(apiKeyLike, "[redacted-credential]") as T;
  }
  if (Array.isArray(value)) return value.map(redactStrings) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item)])) as T;
  }
  return value;
}
