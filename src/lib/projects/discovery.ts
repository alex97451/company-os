import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  companyProjectManifestSchema,
  projectDiscoverySchema,
  type ProjectDiscovery,
  type ProjectTechnology,
} from "./manifest";
import { assertProjectPathAllowed } from "./path-policy";

const execFileAsync = promisify(execFile);
const MAX_PACKAGE_FILE_BYTES = 1_000_000;
const MAX_MARKDOWN_FILES = 500;

const packageJsonSchema = z.object({
  scripts: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
  main: z.unknown().optional(),
  exports: z.unknown().optional(),
}).passthrough();

type PackageJson = z.infer<typeof packageJsonSchema>;

export async function inspectProjectWorkspace(
  candidate: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectDiscovery> {
  const allowedCandidate = assertProjectPathAllowed(candidate, env);
  let root: string;
  try {
    root = assertProjectPathAllowed(await realpath(allowedCandidate), env);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new Error("PROJECT_PATH_NOT_DIRECTORY");
    await access(root, constants.R_OK | constants.W_OK);
  } catch (error) {
    throw projectAccessError(error);
  }

  const entries = await readdir(root, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const packageJson = await readPackageJson(root, names.has("package.json"));
  const scripts = Object.entries(packageJson?.scripts ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[a-zA-Z0-9:_-]{1,100}$/.test(entry[0]))
    .map(([name]) => name)
    .sort()
    .slice(0, 100);
  const dependencies = new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.devDependencies ?? {}),
  ]);
  const technologies = detectTechnologies(names, dependencies, Boolean(packageJson));
  const documentation = {
    readme: [...names].some((name) => /^readme(?:\.[a-z0-9_-]+)?\.md$|^readme\.md$/.test(name)),
    agentInstructions: names.has("agents.md"),
    docsDirectory: entries.some((entry) => entry.isDirectory() && entry.name.toLowerCase() === "docs"),
    markdownFiles: await countMarkdownFiles(root),
  };
  const packageManager = names.has("pnpm-lock.yaml")
    ? "pnpm"
    : names.has("yarn.lock")
      ? "yarn"
      : names.has("bun.lock") || names.has("bun.lockb")
        ? "bun"
        : packageJson || names.has("package-lock.json")
          ? "npm"
          : "none";

  return projectDiscoverySchema.parse({
    version: 1,
    analyzedAt: new Date().toISOString(),
    canonicalPath: root,
    existingProjectId: await readExistingProjectId(root, names.has("company-os.project.json")),
    writable: true,
    technologies,
    packageManager,
    scripts,
    documentation,
    git: await inspectGit(root),
    suggestedKind: suggestProjectKind(dependencies, scripts, packageJson),
    commands: detectCommands(scripts, packageManager),
  });
}

async function readExistingProjectId(root: string, exists: boolean): Promise<string | null> {
  if (!exists) return null;
  const manifestPath = join(root, "company-os.project.json");
  const manifestStat = await stat(manifestPath);
  if (manifestStat.size > 100_000) throw new Error("PROJECT_MANIFEST_TOO_LARGE");
  try {
    return companyProjectManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))).id;
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new Error("PROJECT_MANIFEST_INVALID");
    throw error;
  }
}

async function readPackageJson(root: string, exists: boolean): Promise<PackageJson | null> {
  if (!exists) return null;
  const packagePath = join(root, "package.json");
  const packageStat = await stat(packagePath);
  if (packageStat.size > MAX_PACKAGE_FILE_BYTES) throw new Error("PROJECT_PACKAGE_FILE_TOO_LARGE");
  try {
    return packageJsonSchema.parse(JSON.parse(await readFile(packagePath, "utf8")));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new Error("PROJECT_PACKAGE_FILE_INVALID");
    throw error;
  }
}

function detectTechnologies(
  names: Set<string>,
  dependencies: Set<string>,
  hasPackageJson: boolean,
): ProjectTechnology[] {
  const technologies = new Set<ProjectTechnology>();
  if (hasPackageJson) technologies.add("Node.js");
  if (names.has("tsconfig.json") || dependencies.has("typescript")) technologies.add("TypeScript");
  else if (hasPackageJson) technologies.add("JavaScript");
  if (dependencies.has("next") || [...names].some((name) => /^next\.config\./.test(name))) technologies.add("Next.js");
  if (dependencies.has("react")) technologies.add("React");
  if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("setup.py")) technologies.add("Python");
  if (names.has("dockerfile") || names.has("docker-compose.yml") || names.has("docker-compose.yaml") || names.has("compose.yml") || names.has("compose.yaml")) {
    technologies.add("Docker");
  }
  return [...technologies];
}

function suggestProjectKind(
  dependencies: Set<string>,
  scripts: string[],
  packageJson: PackageJson | null,
): ProjectDiscovery["suggestedKind"] {
  if (dependencies.has("next") || dependencies.has("react") || dependencies.has("vue") || dependencies.has("svelte")) return "web_app";
  if (["express", "fastify", "@nestjs/core", "hono", "koa"].some((name) => dependencies.has(name))) return "api";
  if (packageJson && (packageJson.exports !== undefined || packageJson.main !== undefined) && !scripts.includes("dev") && !scripts.includes("start")) return "library";
  return "generic";
}

function detectCommands(
  scripts: string[],
  packageManager: ProjectDiscovery["packageManager"],
): ProjectDiscovery["commands"] {
  const runner = packageManager === "pnpm" ? "pnpm" : packageManager === "yarn" ? "yarn" : packageManager === "bun" ? "bun" : "npm run";
  const command = (script: string) => runner === "npm run" ? `${runner} ${script}` : `${runner} ${script}`;
  return {
    verify: scripts.includes("verify")
      ? command("verify")
      : scripts.includes("test")
        ? command("test")
        : scripts.includes("lint")
          ? command("lint")
          : "À configurer dans Ops",
    start: scripts.includes("dev")
      ? command("dev")
      : scripts.includes("start")
        ? command("start")
        : "À configurer dans Ops",
    stop: "Arrêter le runtime depuis Ops",
  };
}

async function inspectGit(root: string): Promise<ProjectDiscovery["git"]> {
  try {
    const result = await execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "--branch", "--untracked-files=normal"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 512_000,
      windowsHide: true,
    });
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const branchLine = lines.find((line) => line.startsWith("## "));
    const branch = branchLine?.slice(3).split("...")[0]?.trim() || null;
    const changedFiles = lines.filter((line) => !line.startsWith("## ")).length;
    return { state: changedFiles > 0 ? "changes" : "clean", branch, changedFiles };
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    if (detail.stderr?.toLowerCase().includes("not a git repository")) {
      return { state: "not_repository", branch: null, changedFiles: 0 };
    }
    return { state: "unavailable", branch: null, changedFiles: 0 };
  }
}

async function countMarkdownFiles(root: string): Promise<number> {
  let count = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3 || count >= MAX_MARKDOWN_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= MAX_MARKDOWN_FILES) return;
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) count += 1;
      if (entry.isDirectory() && !entry.name.startsWith(".") && !["node_modules", "work", "dist", "build"].includes(entry.name.toLowerCase())) {
        await visit(join(directory, entry.name), depth + 1);
      }
    }
  };
  await visit(root, 0);
  return count;
}

function projectAccessError(error: unknown): Error {
  if (error instanceof Error && /^[A-Z0-9_]{3,120}$/.test(error.message)) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new Error("PROJECT_PATH_NOT_FOUND");
  if (code === "EACCES" || code === "EPERM") return new Error("PROJECT_WORKSPACE_WRITE_DENIED");
  return new Error("PROJECT_PATH_UNAVAILABLE");
}
