import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { bootstrapCeoInstance, parseCompanySupervisorConfig, runSupervisorLoop } from "@/company-supervisor/runtime";

describe("company supervisor runtime", () => {
  it("requires an explicit real CEO thread in app-server stdio mode", () => {
    expect(() => parseCompanySupervisorConfig({ OPS_CODEX_MODE: "app-server-stdio" })).toThrow(
      "OPS_CODEX_CEO_THREAD_ID_REQUIRED",
    );
  });

  it("bootstraps the deterministic demo CEO mapping idempotently", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    let exists = false;
    const pool = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.startsWith("SELECT id, thread_id")) {
          return { rows: exists ? [{ id: "instance-1", thread_id: "demo-ceo-local" }] : [], rowCount: exists ? 1 : 0 };
        }
        if (sql.includes("INSERT INTO cockpit_agent_instances")) {
          exists = true;
          return { rows: [{ id: "instance-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;
    const config = parseCompanySupervisorConfig({ OPS_CODEX_MODE: "demo" });
    await bootstrapCeoInstance(pool, config);
    await bootstrapCeoInstance(pool, config);
    expect(calls.filter(({ sql }) => sql.includes("INSERT INTO cockpit_agent_instances"))).toHaveLength(1);
    expect(calls.find(({ sql }) => sql.includes("INSERT INTO cockpit_agent_instances"))?.params[1]).toBe("demo-ceo-local");
  });

  it("reactivates a retired CEO instance through the thread-id upsert", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT id, thread_id")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO cockpit_agent_instances")) {
        return { rows: [{ id: "retired-instance" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const config = parseCompanySupervisorConfig({ OPS_CODEX_MODE: "demo" });
    await expect(bootstrapCeoInstance({ query } as unknown as Pool, config)).resolves.toBe("retired-instance");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (thread_id) DO UPDATE"),
      expect.any(Array),
    );
  });

  it("rejects a CEO thread already owned by another role", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT id, thread_id")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const config = parseCompanySupervisorConfig({ OPS_CODEX_MODE: "demo" });
    await expect(bootstrapCeoInstance({ query } as unknown as Pool, config)).rejects.toThrow(
      "CEO_THREAD_MAPPING_CONFLICT",
    );
  });

  it("runs a sub-second loop, purges retention, and stops on abort", async () => {
    const controller = new AbortController();
    const processOne = vi.fn(async () => {
      controller.abort();
      return { status: "idle" as const };
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT id, thread_id")) return { rows: [{ id: "instance-1", thread_id: "demo-ceo-local" }], rowCount: 1 };
      if (sql.startsWith("DELETE FROM cockpit_events")) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    });
    const logger = { info: vi.fn(), error: vi.fn() };
    await runSupervisorLoop({
      pool: { query } as unknown as Pool,
      config: parseCompanySupervisorConfig({ OPS_CODEX_MODE: "demo", OPS_SUPERVISOR_POLL_MS: "250" }),
      signal: controller.signal,
      logger,
      supervisor: { processOne },
    });
    expect(processOne).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith("DELETE FROM cockpit_events WHERE expires_at <= now()");
    expect(logger.info).toHaveBeenCalledWith("cockpit_events_purged", { count: 2 });
    expect(logger.info).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.anything() }));
  });
});
