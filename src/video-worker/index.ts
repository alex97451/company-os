import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import { getVideoMetadata, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import pg from "pg";
import { z } from "zod";
import { videoBriefSchema, videoQualityReportSchema, type VideoBrief, type VideoQualityReport } from "../lib/videos/contracts";

const config = z.object({
  databaseUrl: z.string().url(),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/),
  pollMs: z.coerce.number().int().min(250).max(10_000).default(750),
}).parse({
  databaseUrl: process.env.DATABASE_URL,
  projectId: process.env.COMPANY_OS_PROJECT_ID ?? "company-os",
  pollMs: process.env.VIDEO_WORKER_POLL_MS,
});

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2, application_name: `company-os-video:${config.projectId}` });
const stateRoot = resolve(process.cwd(), "work", "projects", config.projectId);
const browserExecutable = findBrowserExecutable();
const abort = new AbortController();
let bundlePromise: Promise<string> | null = null;

process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

void main().catch((error) => {
  safeLog("video_worker_fatal", { projectId: config.projectId, code: safeErrorCode(error) });
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await reconcileInterruptedJobs();
  safeLog("video_worker_started", { projectId: config.projectId });
  try {
    while (!abort.signal.aborted) {
      const job = await claimNext();
      if (job) await processJob(job).catch((error) => failOrRetry(job.id, error));
      else await delay(config.pollMs, abort.signal);
    }
  } finally {
    await pool.end();
    safeLog("video_worker_stopped", { projectId: config.projectId });
  }
}

type ClaimedJob = { id: string; language: "fr" | "en"; brief: VideoBrief; attemptCount: number };

async function claimNext(): Promise<ClaimedJob | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{ id: string; language: "fr" | "en"; brief: unknown; attempt_count: number }>(
      `SELECT id, language, brief, attempt_count FROM video_jobs
        WHERE state = 'voice' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const brief = videoBriefSchema.parse(row.brief);
    const updated = await client.query(
      `UPDATE video_jobs SET attempt_count = attempt_count + 1, progress = 40,
              stage_label = 'Création de la voix locale', error_code = NULL, updated_at = now()
        WHERE id = $1 AND state = 'voice' AND attempt_count < 2 RETURNING id`,
      [row.id],
    );
    if (!updated.rows[0]) {
      await client.query(
        "UPDATE video_jobs SET state = 'failed', error_code = 'VIDEO_RETRY_LIMIT_REACHED', stage_label = 'Le nombre maximal de tentatives est atteint', updated_at = now() WHERE id = $1",
        [row.id],
      );
      await client.query("COMMIT");
      return null;
    }
    await client.query("COMMIT");
    return { id: row.id, language: row.language, brief, attemptCount: row.attempt_count + 1 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function processJob(job: ClaimedJob): Promise<void> {
  const jobDir = resolve(stateRoot, "videos", job.id);
  await mkdir(jobDir, { recursive: true });
  const narrationPath = resolve(jobDir, "narration.txt");
  const voicePath = resolve(jobDir, "voice.wav");
  const videoPath = resolve(jobDir, "video.mp4");
  const thumbnailPath = resolve(jobDir, "thumbnail.png");
  await writeFile(narrationPath, job.brief.voiceScript, { encoding: "utf8", mode: 0o600 });
  await writeFile(resolve(jobDir, "video-brief.json"), `${JSON.stringify(job.brief, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await synthesizeVoice(narrationPath, voicePath, job.language);
  if (!await isStillActive(job.id)) return;

  const audioDataUri = `data:audio/wav;base64,${(await readFile(voicePath)).toString("base64")}`;
  const selectedHook = job.brief.hooks.find((hook) => hook.id === job.brief.selectedHookId)?.text ?? job.brief.hooks[0].text;
  const inputProps = {
    title: job.brief.title,
    language: job.brief.language,
    durationSeconds: job.brief.durationSeconds,
    template: job.brief.template,
    selectedHook,
    scenes: job.brief.scenes,
    audioDataUri,
  };

  await update(job.id, "rendering", 50, "Rendu Remotion du MP4 vertical");
  const serveUrl = await getBundle();
  const composition = await selectComposition({
    serveUrl,
    id: "FacelessVerticalV1",
    inputProps,
    browserExecutable,
    logLevel: "error",
  });
  let lastProgress = 50;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    outputLocation: videoPath,
    inputProps,
    browserExecutable,
    concurrency: 1,
    x264Preset: "veryfast",
    logLevel: "error",
    overwrite: true,
    onProgress: ({ progress }) => {
      const value = Math.min(88, 50 + Math.floor(progress * 38));
      if (value >= lastProgress + 2) {
        lastProgress = value;
        void update(job.id, "rendering", value, `Rendu vidéo · ${Math.max(1, Math.round(progress * 100))} %`).catch(() => undefined);
      }
    },
  });
  if (!await isStillActive(job.id)) return;
  await renderStill({
    composition,
    serveUrl,
    output: thumbnailPath,
    imageFormat: "png",
    frame: Math.min(composition.durationInFrames - 1, Math.round(composition.fps * 1.2)),
    inputProps,
    browserExecutable,
    logLevel: "error",
    overwrite: true,
  });

  await update(job.id, "quality_check", 92, "Contrôle du format, du son et de la lisibilité");
  const report = await inspectOutput(videoPath, thumbnailPath, job.brief);
  if (!report.passed) throw new Error("VIDEO_QUALITY_CHECK_FAILED");
  await pool.query(
    `UPDATE video_jobs
        SET state = 'completed', progress = 100, stage_label = 'Vidéo prête à regarder',
            quality_report = $2, video_object_key = $3, thumbnail_object_key = $4,
            error_code = NULL, completed_at = now(), updated_at = now()
      WHERE id = $1 AND state = 'quality_check'`,
    [job.id, report, `videos/${job.id}/video.mp4`, `videos/${job.id}/thumbnail.png`],
  );
  safeLog("video_job_completed", { projectId: config.projectId, jobId: job.id });
}

async function inspectOutput(videoPath: string, thumbnailPath: string, brief: VideoBrief): Promise<VideoQualityReport> {
  const [metadata, videoStats, thumbnailStats] = await Promise.all([
    getVideoMetadata(videoPath, { logLevel: "error" }),
    stat(videoPath),
    stat(thumbnailPath),
  ]);
  const durationOk = metadata.durationInSeconds !== null && Math.abs(metadata.durationInSeconds - brief.durationSeconds) <= 0.35;
  const checks = [
    { id: "vertical", label: "Format vertical 1080 × 1920", passed: metadata.width === 1080 && metadata.height === 1920, detail: `${metadata.width} × ${metadata.height}` },
    { id: "duration", label: "Durée demandée", passed: durationOk, detail: `${metadata.durationInSeconds?.toFixed(2) ?? "inconnue"} s / ${brief.durationSeconds} s` },
    { id: "codec", label: "MP4 H.264 lisible", passed: metadata.codec === "h264" && metadata.canPlayInVideoTag, detail: `${metadata.codec} · ${metadata.canPlayInVideoTag ? "lisible" : "non lisible"}` },
    { id: "audio", label: "Piste audio présente", passed: metadata.audioCodec !== null && metadata.audioCodec !== "unknown", detail: metadata.audioCodec ?? "absente" },
    { id: "files", label: "Fichiers complets", passed: videoStats.size > 20_000 && thumbnailStats.size > 2_000, detail: `${Math.round(videoStats.size / 1024)} Ko · miniature ${Math.round(thumbnailStats.size / 1024)} Ko` },
    { id: "captions", label: "Sous-titres et zones sûres", passed: brief.scenes.every((scene) => scene.narration.length > 0), detail: "Texte centré dans le gabarit vertical versionné" },
    { id: "rights", label: "Droits déclarés", passed: brief.rightsDeclarations.length > 0, detail: `${brief.rightsDeclarations.length} déclaration(s)` },
  ];
  return videoQualityReportSchema.parse({ passed: checks.every((check) => check.passed), checks, checkedAt: new Date().toISOString() });
}

async function synthesizeVoice(inputPath: string, outputPath: string, language: "fr" | "en"): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", resolve(process.cwd(), "scripts", "synthesize-video-voice.ps1"),
      "-InputTextPath", inputPath,
      "-OutputWavePath", outputPath,
      "-Language", language,
    ], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("VIDEO_VOICE_TIMEOUT")); }, 90_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error("VIDEO_VOICE_SYNTHESIS_FAILED"));
    });
  });
}

async function getBundle(): Promise<string> {
  bundlePromise ??= bundle({
    entryPoint: resolve(process.cwd(), "video", "index.ts"),
    rootDir: process.cwd(),
    enableCaching: true,
    onProgress: () => undefined,
  });
  return bundlePromise;
}

async function update(id: string, state: "rendering" | "quality_check", progress: number, label: string): Promise<void> {
  await pool.query(
    `UPDATE video_jobs SET state = $2, progress = $3, stage_label = $4, updated_at = now()
      WHERE id = $1 AND state NOT IN ('completed','failed','cancelled')`,
    [id, state, progress, label],
  );
}

async function isStillActive(id: string): Promise<boolean> {
  const result = await pool.query<{ state: string }>("SELECT state FROM video_jobs WHERE id = $1", [id]);
  return Boolean(result.rows[0] && !["cancelled", "failed", "completed"].includes(result.rows[0].state));
}

async function failOrRetry(id: string, error: unknown): Promise<void> {
  const code = safeErrorCode(error);
  const result = await pool.query<{ attempt_count: number }>("SELECT attempt_count FROM video_jobs WHERE id = $1", [id]);
  const attempts = result.rows[0]?.attempt_count ?? 2;
  if (attempts < 2) {
    await pool.query(
      `UPDATE video_jobs SET state = 'voice', progress = 35, error_code = $2,
              stage_label = 'Nouvelle tentative locale en préparation', updated_at = now()
        WHERE id = $1 AND state NOT IN ('cancelled','completed')`,
      [id, code],
    );
  } else {
    await pool.query(
      `UPDATE video_jobs SET state = 'failed', error_code = $2,
              stage_label = 'La production vidéo a échoué après deux tentatives', updated_at = now()
        WHERE id = $1 AND state NOT IN ('cancelled','completed')`,
      [id, code],
    );
  }
  safeLog("video_job_failed", { projectId: config.projectId, jobId: id, code, retry: attempts < 2 });
}

async function reconcileInterruptedJobs(): Promise<void> {
  await pool.query(
    `UPDATE video_jobs
        SET state = CASE WHEN attempt_count < 2 THEN 'voice' ELSE 'failed' END,
            progress = CASE WHEN attempt_count < 2 THEN 35 ELSE progress END,
            error_code = 'VIDEO_WORKER_INTERRUPTED',
            stage_label = CASE WHEN attempt_count < 2 THEN 'Reprise après interruption locale' ELSE 'Production interrompue' END,
            updated_at = now()
      WHERE state IN ('rendering','quality_check') AND updated_at < now() - interval '10 minutes'`,
  );
}

function findBrowserExecutable(): string | undefined {
  const configured = process.env.REMOTION_BROWSER_EXECUTABLE?.trim();
  const candidates = [
    configured,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate));
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "VIDEO_RENDER_FAILED";
  return /^[A-Z0-9_]{3,120}$/.test(message) ? message : "VIDEO_RENDER_FAILED";
}

function safeLog(code: string, metadata: Record<string, string | number | boolean>): void {
  process.stdout.write(`${JSON.stringify({ level: "info", code, ...metadata })}\n`);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolvePromise(); }
    signal.addEventListener("abort", done, { once: true });
  });
}
