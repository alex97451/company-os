import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDatabasePool } from "@/lib/db";
import { apiError, noStoreJson } from "@/lib/http";
import { requireOpsSession } from "@/lib/ops/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LogEntry = {
  timestamp: string;
  source: "supervisor" | "system" | "runtime";
  level: "info" | "warn" | "error";
  message: string;
  code?: string;
  raw?: string;
};

export async function GET(request: NextRequest) {
  try {
    requireOpsSession(request);
    const pool = getDatabasePool();

    const root = process.cwd();
    const stderrPath = resolve(root, "work", "supervisor.stderr.log");
    const stdoutPath = resolve(root, "work", "supervisor.stdout.log");

    const [stderrContent, stdoutContent] = await Promise.all([
      readFile(stderrPath, "utf8").catch(() => ""),
      readFile(stdoutPath, "utf8").catch(() => ""),
    ]);

    const logEntries = parseLogs(stderrContent, stdoutContent);

    const eventsResult = await pool.query<{
      sequence: string;
      id: string;
      event_type: string;
      safe_payload: unknown;
      occurred_at: Date;
    }>(
      `SELECT sequence, id, event_type, safe_payload, occurred_at
         FROM cockpit_events
        ORDER BY sequence DESC
        LIMIT 60`,
    );

    const runtimesResult = await pool.query<{
      id: string;
      display_name: string;
      status: string;
      last_error_code: string | null;
      last_heartbeat_at: Date | null;
    }>(
      `SELECT id, display_name, status, last_error_code, last_heartbeat_at
         FROM company_projects
        ORDER BY updated_at DESC`,
    );

    return noStoreJson({
      logs: logEntries,
      events: eventsResult.rows.map((row) => ({
        sequence: row.sequence,
        id: row.id,
        eventType: row.event_type,
        payload: row.safe_payload,
        occurredAt: row.occurred_at.toISOString(),
      })),
      runtimes: runtimesResult.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        status: row.status,
        lastErrorCode: row.last_error_code,
        lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    return apiError(error, "OPS_LOGS_FAILED");
  }
}

function parseLogs(stderr: string, stdout: string): LogEntry[] {
  const entries: LogEntry[] = [];

  const processFile = (content: string, defaultLevel: "info" | "error") => {
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines.slice(-120)) {
      const sanitized = sanitizeSecrets(line);
      try {
        const parsed = JSON.parse(sanitized) as Record<string, unknown>;
        const level = (parsed.level as "info" | "warn" | "error") || defaultLevel;
        const code = typeof parsed.code === "string" ? parsed.code : undefined;
        const message = typeof parsed.message === "string"
          ? parsed.message
          : code
            ? `[${code}] ${JSON.stringify(parsed)}`
            : sanitized;

        entries.push({
          timestamp: new Date().toISOString(),
          source: "supervisor",
          level,
          message: truncate(message, 1_000),
          code,
          raw: sanitized,
        });
      } catch {
        const safeRuntimeLine = sanitizeRuntimeLine(sanitized);
        if (!safeRuntimeLine) continue;
        const level: "info" | "warn" | "error" = /error|failed|exception/i.test(sanitized)
          ? "error"
          : /warn|warning/i.test(sanitized)
            ? "warn"
            : defaultLevel;

        entries.push({
          timestamp: new Date().toISOString(),
          source: "supervisor",
          level,
          message: truncate(safeRuntimeLine, 1_000),
          raw: safeRuntimeLine,
        });
      }
    }
  };

  processFile(stdout, "info");
  processFile(stderr, "error");

  return entries.slice(-150);
}

function sanitizeRuntimeLine(line: string): string | null {
  if (/^\d{2}:\d{2}:\d{2} \[tsx\]/.test(line)) return line;
  if (/terminating connection due to administrator command/i.test(line)) {
    return "PostgreSQL a fermé une ancienne connexion pendant un redémarrage local.";
  }
  if (/Unhandled ['\"]error['\"] event/i.test(line)) {
    return "Une ancienne connexion PostgreSQL a été interrompue ; le superviseur a été relancé.";
  }
  return null;
}

function sanitizeSecrets(input: string): string {
  return input
    .replace(/(password|secret|key|token)=["']?[^"'\s&]+["']?/gi, "$1=[REDACTED]")
    .replace(/("password"|"secret"|"key"|"token")\s*:\s*["'][^"']+["']/gi, '$1:"[REDACTED]"');
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}
