import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const MIGRATION_LOCK = "company_os_migrations_v1";

const migrations = [
  {
    id: "001_company_foundation",
    file: "001_initial.sql",
    probes: [
      ...relations(
        "company_tasks",
        "company_memory",
        "agent_runs",
        "agent_daily_usage",
        "agent_policies",
        "agent_circuit_breaker",
        "agent_approvals",
        "agent_action_reservations",
        "agent_schedules",
        "audit_log",
      ),
      probe("company policy seed", "SELECT count(*) = 12 AS ready FROM agent_policies WHERE policy_version = 1"),
    ],
  },
  {
    id: "002_company_cockpit",
    file: "002_company_cockpit.sql",
    probes: [
      ...relations(
        "cockpit_agents",
        "cockpit_agent_instances",
        "cockpit_one_live_instance_per_agent_idx",
        "cockpit_commands",
        "cockpit_commands_pending_idx",
        "cockpit_command_remote_turn_idx",
        "cockpit_messages",
        "cockpit_messages_recent_idx",
        "cockpit_messages_expiry_idx",
        "cockpit_one_ceo_message_per_command_idx",
        "cockpit_tasks",
        "cockpit_tasks_status_updated_idx",
        "cockpit_model_allowlist",
        "cockpit_runs",
        "cockpit_one_unfinished_run_per_task_idx",
        "cockpit_turn_correlation_idx",
        "cockpit_events",
        "cockpit_events_expiry_idx",
        "cockpit_events_aggregate_idx",
        "cockpit_approvals",
        "cockpit_approvals_pending_idx",
        "cockpit_budgets",
        "cockpit_pause",
        "cockpit_outbox",
        "cockpit_outbox_pending_idx",
      ),
      probe(
        "agent seed",
        `SELECT count(*) = 12 AS ready
           FROM cockpit_agents
          WHERE id = ANY($1::text[])`,
        [[
          "ceo",
          "product",
          "design_conversion",
          "engineering",
          "qa_safety",
          "growth",
          "content_brand",
          "video_creator",
          "sales_partnerships",
          "customer_care",
          "finance_risk",
          "reliability_privacy",
        ]],
      ),
      probe(
        "model allowlist seed",
        `SELECT count(*) = 4 AS ready
           FROM cockpit_model_allowlist
          WHERE (profile, model, reasoning_effort) IN (
            ('rapid','gpt-5.6-terra','low'),
            ('balanced','gpt-5.6-terra','medium'),
            ('expert','gpt-5.6-sol','high'),
            ('critical','gpt-5.6-sol','xhigh')
          )`,
      ),
      probe("pause seed", "SELECT EXISTS (SELECT 1 FROM cockpit_pause WHERE id = 1) AS ready"),
    ],
  },
  {
    id: "003_cockpit_messages",
    file: "003_cockpit_messages.sql",
    probes: [
      column("cockpit_commands", "remote_thread_id"),
      column("cockpit_commands", "remote_turn_id"),
      ...relations(
        "cockpit_command_remote_turn_idx",
        "cockpit_messages",
        "cockpit_messages_recent_idx",
        "cockpit_messages_expiry_idx",
        "cockpit_one_ceo_message_per_command_idx",
      ),
    ],
  },
  {
    id: "004_owner_state",
    file: "004_owner_state.sql",
    probes: [
      relation("cockpit_owner_state"),
      column("cockpit_owner_state", "command_version"),
      probe("owner state seed", "SELECT EXISTS (SELECT 1 FROM cockpit_owner_state WHERE id = 1) AS ready"),
    ],
  },
  {
    id: "005_runtime_safety",
    file: "005_runtime_safety.sql",
    probes: [
      relation("cockpit_runtime_health"),
      probe(
        "runtime health seed",
        `SELECT count(*) = 3 AS ready
           FROM cockpit_runtime_health
          WHERE component = ANY($1::text[])`,
        [["supervisor", "bridge", "codex"]],
      ),
    ],
  },
  {
    id: "006_ceo_delegations",
    file: "006_ceo_delegations.sql",
    probes: [
      column("cockpit_tasks", "ceo_turn_id"),
      column("cockpit_tasks", "delegation_index"),
      relation("cockpit_ceo_delegation_once_idx"),
      constraint("cockpit_tasks", "cockpit_tasks_delegation_index_check"),
    ],
  },
  {
    id: "007_local_model_budget",
    file: "007_local_model_budget.sql",
    probes: [
      probe(
        "daily model budget seed",
        `SELECT EXISTS (
           SELECT 1 FROM cockpit_budgets
           WHERE scope = 'company:model:daily'
             AND period_start = date_trunc('day', now())
             AND period_end = date_trunc('day', now()) + interval '1 day'
             AND external_spend_limit_usd_micros = 0
         ) AS ready`,
      ),
    ],
  },
  {
    id: "008_outbox_completion",
    file: "008_outbox_completion.sql",
    probes: [
      probe(
        "outbox completion state",
        `SELECT EXISTS (
           SELECT 1 FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           WHERE t.relname = 'cockpit_outbox'
             AND c.conname = 'cockpit_outbox_state_check'
             AND pg_get_constraintdef(c.oid) LIKE '%completed%'
         ) AS ready`,
      ),
    ],
  },
  {
    id: "009_external_connectors",
    file: "009_external_connectors.sql",
    probes: [
      ...relations(
        "ops_connectors",
        "ops_oauth_states",
        "ops_oauth_states_expiry_idx",
        "community_conversation_state",
      ),
      probe(
        "external connector seed",
        `SELECT count(*) = 6 AS ready
           FROM ops_connectors
          WHERE id = ANY($1::text[])`,
        [["postiz", "ayrshare", "meta", "reddit", "discourse", "figma"]],
      ),
    ],
  },
  {
    id: "010_company_projects",
    file: "010_company_projects.sql",
    probes: [
      ...relations(
        "company_projects",
        "company_projects_status_idx",
        "company_project_runtimes",
      ),
    ],
  },
  {
    id: "011_strategic_company_sessions",
    file: "011_strategic_company_sessions.sql",
    probes: [
      ...relations(
        "company_sessions",
        "company_one_active_session_per_project_idx",
        "company_session_participants",
        "company_session_contributions",
        "company_session_contributions_progress_idx",
        "company_session_execution_tasks",
        "company_session_deliverables",
        "company_session_deliverables_session_idx",
        "company_session_events",
        "company_session_events_session_idx",
      ),
    ],
  },
  {
    id: "012_global_company_review",
    file: "012_global_company_review.sql",
    probes: [
      probe(
        "global company review participant capacity",
        `SELECT EXISTS (
           SELECT 1
             FROM pg_constraint constraint_record
             JOIN pg_class table_record ON table_record.oid = constraint_record.conrelid
            WHERE table_record.relname = 'company_session_participants'
              AND constraint_record.conname = 'company_session_participants_invitation_order_check'
              AND pg_get_constraintdef(constraint_record.oid) LIKE '%9%'
         ) AS ready`,
      ),
    ],
  },
  {
    id: "013_ops_lan_collaboration",
    file: "013_ops_lan_collaboration.sql",
    probes: [
      ...relations(
        "ops_collaborator_presence",
        "ops_collaborator_presence_recent_idx",
      ),
    ],
  },
  {
    id: "014_video_studio",
    file: "014_video_studio.sql",
    probes: [
      ...relations(
        "video_jobs",
        "video_one_active_job_idx",
        "video_jobs_created_idx",
        "video_jobs_worker_idx",
      ),
      probe("video creator roster seed", "SELECT EXISTS (SELECT 1 FROM cockpit_agents WHERE id = 'video_creator' AND enabled = true) AS ready"),
      probe("video creator policy seed", "SELECT EXISTS (SELECT 1 FROM agent_policies WHERE agent_id = 'video_creator' AND policy_version = 1 AND enabled = true) AS ready"),
    ],
  },
  {
    id: "015_video_retry",
    file: "015_video_retry.sql",
    probes: [
      column("video_jobs", "brief_attempt_count"),
      constraint("video_jobs", "video_jobs_brief_attempt_count_check"),
    ],
  },
];

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required.");
    process.exitCode = 1;
  } else {
    await runMigrations(connectionString).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown migration failure";
      console.error(`Cockpit migration failed: ${message}`);
      process.exitCode = 1;
    });
  }
}

async function runMigrations(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  let client;
  let locked = false;
  try {
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK]);
    locked = true;
    await inTransaction(client, async () => {
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
    });

    for (const migration of migrations) {
      const source = await readFile(resolve(process.cwd(), "migrations", migration.file), "utf8");
      const migrationSql = unwrapTransaction(source, migration.file);
      await inTransaction(client, async () => {
        const applied = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [migration.id]);
        if (applied.rowCount) {
          console.log(`${migration.id} already applied.`);
          return;
        }

        const baseline = await inspectBaseline(client, migration.probes);
        if (baseline === "partial") {
          throw new Error(
            `${migration.id} found a partial or incompatible schema; repair it explicitly before retrying`,
          );
        }
        if (baseline === "complete") {
          await recordMigration(client, migration.id);
          console.log(`${migration.id} existing schema verified and recorded as applied.`);
          return;
        }

        await client.query(migrationSql);
        await recordMigration(client, migration.id);
        console.log(`${migration.id} applied.`);
      });
    }
  } finally {
    if (locked && client) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK]).catch(() => undefined);
    }
    client?.release();
    await pool.end();
  }
}

async function inspectBaseline(client, probes) {
  const results = [];
  for (const item of probes) {
    await client.query("SAVEPOINT cockpit_baseline_probe");
    try {
      const result = await client.query(item.sql, item.values);
      results.push(result.rows[0]?.ready === true);
      await client.query("RELEASE SAVEPOINT cockpit_baseline_probe");
    } catch {
      // A dependent relation can be absent while checking a seed. That is still
      // an absent/partial schema state, never proof that the migration ran.
      await client.query("ROLLBACK TO SAVEPOINT cockpit_baseline_probe");
      await client.query("RELEASE SAVEPOINT cockpit_baseline_probe");
      results.push(false);
    }
  }
  return classifyBaseline(results);
}

async function recordMigration(client, id) {
  await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
}

async function inTransaction(client, callback) {
  await client.query("BEGIN");
  try {
    await callback();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export function classifyBaseline(results) {
  if (!Array.isArray(results) || results.length === 0 || results.some((ready) => typeof ready !== "boolean")) {
    throw new Error("Baseline probes must be a non-empty boolean array");
  }
  if (results.every(Boolean)) return "complete";
  if (results.every((ready) => !ready)) return "absent";
  return "partial";
}

export function unwrapTransaction(source, file) {
  const normalized = source.replace(/^\uFEFF/, "").trim();
  const wrapped = normalized.match(/^BEGIN\s*;\s*([\s\S]*?)\s*COMMIT\s*;\s*$/i);
  if (!wrapped) {
    throw new Error(`${file} must contain exactly one outer BEGIN/COMMIT block`);
  }
  const body = wrapped[1].trim();
  if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b\s*;/i.test(body)) {
    throw new Error(`${file} contains nested transaction control`);
  }
  return body;
}

function probe(label, sql, values = []) {
  return { label, sql, values };
}

function relation(name) {
  return probe(
    `relation ${name}`,
    "SELECT to_regclass($1) IS NOT NULL AS ready",
    [`public.${name}`],
  );
}

function relations(...names) {
  return names.map(relation);
}

function column(table, name) {
  return probe(
    `column ${table}.${name}`,
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS ready`,
    [table, name],
  );
}

function constraint(table, name) {
  return probe(
    `constraint ${table}.${name}`,
    `SELECT EXISTS (
       SELECT 1
         FROM pg_constraint constraint_record
         JOIN pg_class table_record ON table_record.oid = constraint_record.conrelid
         JOIN pg_namespace schema_record ON schema_record.oid = table_record.relnamespace
        WHERE schema_record.nspname = 'public'
          AND table_record.relname = $1
          AND constraint_record.conname = $2
     ) AS ready`,
    [table, name],
  );
}
