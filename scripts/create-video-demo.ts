import pg from "pg";
import { z } from "zod";
import { VideoStudioService } from "../src/lib/videos/service";

const projectId = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/).parse(process.argv[2] ?? "wedding-quote-check");
const base = new URL(z.string().url().parse(process.env.DATABASE_URL));
base.pathname = `/company_os_${projectId.replaceAll("-", "_")}`;
const pool = new pg.Pool({ connectionString: base.toString(), max: 2, application_name: "company-os-video-demo" });

void new VideoStudioService(pool, { ...process.env, COMPANY_OS_PROJECT_ID: projectId }).create({
  subject: "Avant de payer l’acompte, montrer avec un exemple simple pourquoi deux devis de mariage au même prix peuvent inclure des prestations différentes et pourquoi il faut vérifier les éléments manquants.",
  goal: "education",
  language: "fr",
  template: "problem_reveal_solution",
  durationSeconds: 15,
}).then((job) => {
  process.stdout.write(`${JSON.stringify({ id: job.id, state: job.state, projectId })}\n`);
}).finally(async () => {
  await pool.end();
});
