import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import { getVideoMetadata, renderMedia, renderStill, selectComposition } from "@remotion/renderer";

const outputDir = resolve(process.cwd(), "work", "video-render-smoke");
const narrationPath = resolve(outputDir, "narration.txt");
const voicePath = resolve(outputDir, "voice.wav");
const videoPath = resolve(outputDir, "video.mp4");
const thumbnailPath = resolve(outputDir, "thumbnail.png");
const browserExecutable = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "VIDEO_RENDER_SMOKE_FAILED"}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(narrationPath, "Avant de décider, rendez l'information claire. Vérifiez les faits, comparez les options, puis passez à l'action.", "utf8");
  await runVoice();
  const inputProps = {
  title: "Company OS",
  language: "fr",
  durationSeconds: 15,
  template: "problem_reveal_solution",
  selectedHook: "Une décision claire commence par des faits clairs.",
  scenes: [
    { id: "scene_1", startSeconds: 0, durationSeconds: 5, headline: "Trop d’informations ?", body: "Commencez par isoler le vrai problème.", narration: "Avant de décider, rendez l'information claire.", accent: "rose", transition: "zoom" },
    { id: "scene_2", startSeconds: 5, durationSeconds: 5, headline: "Vérifiez les faits", body: "Une preuve utile vaut mieux qu’une promesse.", narration: "Vérifiez les faits et comparez les options.", accent: "sky", transition: "slide" },
    { id: "scene_3", startSeconds: 10, durationSeconds: 5, headline: "Décidez sereinement", body: "Gardez le contrôle de la prochaine étape.", narration: "Puis passez à l'action en gardant le contrôle.", accent: "gold", transition: "wipe" },
  ],
  audioDataUri: `data:audio/wav;base64,${(await readFile(voicePath)).toString("base64")}`,
  };
  const serveUrl = await bundle({ entryPoint: resolve(process.cwd(), "video", "index.ts"), rootDir: process.cwd(), enableCaching: true, onProgress: () => undefined });
  const composition = await selectComposition({ serveUrl, id: "FacelessVerticalV1", inputProps, browserExecutable, logLevel: "error" });
  await renderMedia({ composition, serveUrl, codec: "h264", audioCodec: "aac", pixelFormat: "yuv420p", outputLocation: videoPath, inputProps, browserExecutable, concurrency: 1, x264Preset: "veryfast", logLevel: "error", overwrite: true });
  await renderStill({ composition, serveUrl, output: thumbnailPath, imageFormat: "png", frame: 36, inputProps, browserExecutable, logLevel: "error", overwrite: true });
  const [metadata, videoStats, thumbnailStats] = await Promise.all([getVideoMetadata(videoPath, { logLevel: "error" }), stat(videoPath), stat(thumbnailPath)]);
  if (metadata.width !== 1080 || metadata.height !== 1920 || metadata.codec !== "h264" || metadata.audioCodec === null || videoStats.size < 20_000 || thumbnailStats.size < 2_000) {
    throw new Error("VIDEO_RENDER_SMOKE_INVALID_OUTPUT");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, videoPath, thumbnailPath, width: metadata.width, height: metadata.height, duration: metadata.durationInSeconds, codec: metadata.codec, audioCodec: metadata.audioCodec, bytes: videoStats.size })}\n`);
}

function runVoice(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve(process.cwd(), "scripts", "synthesize-video-voice.ps1"), "-InputTextPath", narrationPath, "-OutputWavePath", voicePath, "-Language", "fr"], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error("VIDEO_VOICE_SMOKE_FAILED")));
  });
}
