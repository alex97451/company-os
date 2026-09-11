import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProjectWorkspace } from "@/lib/projects/discovery";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project workspace discovery", () => {
  it("detects the useful project facts without changing the folder", async () => {
    const root = await createTemporaryProject();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "README.md"), "# Demo\n", "utf8");
    await writeFile(join(root, "AGENTS.md"), "# Local rules\n", "utf8");
    await writeFile(join(root, "docs", "architecture.md"), "# Architecture\n", "utf8");
    await writeFile(join(root, "tsconfig.json"), "{}\n", "utf8");
    await writeFile(join(root, "package-lock.json"), "{}\n", "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { dev: "next dev", test: "vitest run", "invalid script": "ignored" },
      dependencies: { next: "16.0.0", react: "19.0.0" },
    }), "utf8");
    const before = await snapshotFolder(root);

    const discovery = await inspectProjectWorkspace(root, allowedEnv(root));

    expect(discovery).toMatchObject({
      canonicalPath: root,
      writable: true,
      technologies: ["Node.js", "TypeScript", "Next.js", "React"],
      packageManager: "npm",
      scripts: ["dev", "test"],
      documentation: { readme: true, agentInstructions: true, docsDirectory: true, markdownFiles: 3 },
      suggestedKind: "web_app",
      commands: { verify: "npm run test", start: "npm run dev", stop: "Arrêter le runtime depuis Ops" },
    });
    expect(["not_repository", "unavailable"]).toContain(discovery.git.state);
    expect(await snapshotFolder(root)).toEqual(before);
  });

  it("returns a stable non-technical code when package.json is invalid", async () => {
    const root = await createTemporaryProject();
    await writeFile(join(root, "package.json"), "{invalid", "utf8");

    await expect(inspectProjectWorkspace(root, allowedEnv(root))).rejects.toThrow("PROJECT_PACKAGE_FILE_INVALID");
  });

  it("recognizes an existing Company OS project so initialization can resume", async () => {
    const root = await createTemporaryProject();
    await writeFile(join(root, "company-os.project.json"), JSON.stringify({
      version: 1,
      id: "existing-project",
      displayName: "Existing project",
      kind: "generic",
      isolationMode: "dedicated_runtime",
      companyDirectory: ".company-os",
      agentRoster: ".company-os/agents.json",
      externalWorkEnabledByDefault: false,
      commands: { verify: "À configurer dans Ops", start: "À configurer dans Ops", stop: "Arrêter le runtime depuis Ops" },
    }), "utf8");

    await expect(inspectProjectWorkspace(root, allowedEnv(root))).resolves.toMatchObject({ existingProjectId: "existing-project" });
  });

  it("rejects a path outside the configured project boundary before reading it", async () => {
    const root = await createTemporaryProject();
    const other = await createTemporaryProject();

    await expect(inspectProjectWorkspace(other, allowedEnv(root))).rejects.toThrow("PROJECT_PATH_OUTSIDE_ALLOWED_ROOTS");
  });
});

async function createTemporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "company-os-project-"));
  temporaryRoots.push(root);
  return root;
}

function allowedEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPANY_PROJECTS_ALLOWED_ROOTS: root,
    COMPANY_PROJECTS_FORBIDDEN_ROOTS: "",
  };
}

async function snapshotFolder(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const snapshot: Record<string, string> = {};
  for (const file of files) {
    const fullPath = join(file.parentPath, file.name);
    snapshot[fullPath.slice(root.length + 1).replaceAll("\\", "/")] = await readFile(fullPath, "utf8");
  }
  return snapshot;
}
