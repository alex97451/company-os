import pg from "pg";

const base = new URL(process.env.DATABASE_URL);
const registry = new pg.Client({ connectionString: base.toString() });
await registry.connect();
const projects = (await registry.query("SELECT id, status FROM company_projects ORDER BY id")).rows;
process.stdout.write(`registry ${projects.map((project) => `${project.id}:${project.status}`).join(",")}\n`);
await registry.end();

for (const project of [{ id: "company-os" }, ...projects.filter((project) => project.id !== "company-os")]) {
  const url = new URL(base);
  url.pathname = `/company_os${project.id === "company-os" ? "" : `_${project.id.replaceAll("-", "_")}`}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const agents = (await client.query("SELECT count(id)::int AS value FROM cockpit_agents WHERE enabled")).rows[0].value;
  const instances = (await client.query("SELECT count(id)::int AS value FROM cockpit_agent_instances WHERE retired_at IS NULL")).rows[0].value;
  const migration = (await client.query("SELECT count(id)::int AS value FROM schema_migrations WHERE id IN ('014_video_studio','015_video_retry')")).rows[0].value;
  const videoTable = (await client.query("SELECT count(table_name)::int AS value FROM information_schema.tables WHERE table_name = 'video_jobs'")).rows[0].value;
  process.stdout.write(`${project.id} agents=${agents} instances=${instances} videoMigrations=${migration}/2 videoTable=${videoTable}\n`);
  await client.end();
}
