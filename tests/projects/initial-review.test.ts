import { describe, expect, it, vi } from "vitest";
import {
  buildInitialProjectReviewPrompt,
  formatInitialProjectReviewForOwner,
  parseInitialProjectReviewResult,
  runInitialProjectReview,
  type InitialProjectReviewCommand,
  type InitialProjectReviewContext,
  type InitialProjectReviewStore,
} from "@/lib/projects/initial-review";
import { projectInitialReviewSchema, type ProjectDiscovery, type ProjectInitialReview } from "@/lib/projects/manifest";

const discovery: ProjectDiscovery = {
  version: 1,
  analyzedAt: "2026-08-14T09:00:00.000Z",
  canonicalPath: "C:\\private\\client-project",
  existingProjectId: null,
  writable: true,
  technologies: ["Node.js", "TypeScript", "Next.js"],
  packageManager: "npm",
  scripts: ["build", "lint", "test", "typecheck"],
  documentation: { readme: true, agentInstructions: true, docsDirectory: true, markdownFiles: 8 },
  git: { state: "changes", branch: "feature/private-name", changedFiles: 4 },
  suggestedKind: "web_app",
  commands: { verify: "npm run test", start: "npm run dev", stop: "Arrêter le runtime depuis Ops" },
};

const validResult = {
  version: 1 as const,
  conclusion: "Le projet possède une base structurée, mais sa préparation doit encore être prouvée par des contrôles reproductibles.",
  limits: ["Le diagnostic ne contient ni retour utilisateur ni indicateur commercial."],
  priorities: [
    {
      id: "P1" as const,
      title: "Stabiliser la vérification locale",
      observation: "Les commandes de contrôle existent et doivent produire un résultat reproductible.",
      basis: ["commands" as const],
      acceptanceCriteria: ["Les contrôles détectés se terminent sans erreur sur la machine locale."],
    },
    {
      id: "P2" as const,
      title: "Clarifier le parcours documenté",
      observation: "La documentation est présente et peut servir de référence commune.",
      basis: ["documentation" as const],
      acceptanceCriteria: ["Le README décrit le démarrage et la vérification avec des étapes vérifiables."],
    },
    {
      id: "P3" as const,
      title: "Sécuriser les changements en cours",
      observation: "Des changements Git sont présents et ont été conservés.",
      basis: ["git" as const],
      acceptanceCriteria: ["Les changements sont relus et associés à un résultat de contrôle local."],
    },
  ],
};

describe("initial CEO project review", () => {
  it("builds a bounded read-only prompt from discovery without exposing the project path or branch", () => {
    const prompt = buildInitialProjectReviewPrompt("Projet Démo", discovery);

    expect(prompt.length).toBeLessThanOrEqual(1_200);
    expect(prompt).toContain("strictement en lecture seule");
    expect(prompt).toContain("aucune action locale ou externe");
    expect(prompt).toContain("scripts=build, lint, test, typecheck");
    expect(prompt).not.toContain(discovery.canonicalPath);
    expect(prompt).not.toContain(discovery.git.branch);
  });

  it("accepts exactly three ordered and traceable priorities", () => {
    const parsed = parseInitialProjectReviewResult(`\`\`\`json\n${JSON.stringify(validResult)}\n\`\`\``);

    expect(parsed.priorities.map(({ id }) => id)).toEqual(["P1", "P2", "P3"]);
    expect(parsed.priorities[0].basis).toEqual(["commands"]);
    expect(() => parseInitialProjectReviewResult(JSON.stringify({
      ...validResult,
      priorities: validResult.priorities.slice(0, 2),
    }))).toThrow("INITIAL_CEO_REVIEW_RESULT_INVALID");
  });

  it("tracks queued, running and completed states without creating a second command", async () => {
    const saved: ProjectInitialReview[] = [];
    const store = fakeStore(null, [
      command("pending"),
      command("dispatched"),
      command("completed", JSON.stringify(validResult)),
    ], saved);

    const result = await runInitialProjectReview(store, {
      now: () => new Date("2026-08-14T09:05:00.000Z"),
      sleep: async () => undefined,
      pollMs: 100,
      timeoutMs: 1_000,
    });

    expect(store.getOrCreateCommand).toHaveBeenCalledTimes(1);
    expect(saved.map(({ state }) => state)).toEqual(["queued", "running", "completed"]);
    expect(result.priorities).toHaveLength(3);
    expect(result.conclusion).toBe(validResult.conclusion);
    const ownerMessage = formatInitialProjectReviewForOwner(result);
    expect(ownerMessage).toContain("P1 — Stabiliser la vérification locale");
    expect(ownerMessage).toContain("Aucune action externe n’a été lancée");
    expect(ownerMessage).not.toContain("\"priorities\"");
  });

  it("resumes the same command after interruption and keeps a completed result idempotent", async () => {
    const existing = projectInitialReviewSchema.parse({
      version: 1,
      state: "running",
      commandId: COMMAND_ID,
      triggeredAt: "2026-08-14T09:04:00.000Z",
      updatedAt: "2026-08-14T09:04:30.000Z",
      completedAt: null,
      conclusion: null,
      limits: [],
      priorities: [],
      errorCode: null,
    });
    const saved: ProjectInitialReview[] = [];
    const store = fakeStore(existing, [command("completed", JSON.stringify(validResult))], saved);

    const resumed = await runInitialProjectReview(store, {
      now: () => new Date("2026-08-14T09:06:00.000Z"),
      sleep: async () => undefined,
      pollMs: 100,
      timeoutMs: 1_000,
    });
    expect(store.getOrCreateCommand).not.toHaveBeenCalled();
    expect(resumed.commandId).toBe(COMMAND_ID);
    expect(resumed.state).toBe("completed");

    const completedStore = fakeStore(resumed, [], []);
    const replay = await runInitialProjectReview(completedStore);
    expect(replay).toEqual(resumed);
    expect(completedStore.getOrCreateCommand).not.toHaveBeenCalled();
    expect(completedStore.readCommand).not.toHaveBeenCalled();
    expect(completedStore.saveReview).toHaveBeenCalledOnce();
  });

  it("shows an explicit limitation instead of publishing an invalid CEO response", async () => {
    const saved: ProjectInitialReview[] = [];
    const store = fakeStore(null, [command("completed", "Analyse libre sans contrat JSON")], saved);

    const result = await runInitialProjectReview(store, {
      now: () => new Date("2026-08-14T09:05:00.000Z"),
      sleep: async () => undefined,
      pollMs: 100,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      state: "error",
      errorCode: "INITIAL_CEO_REVIEW_RESULT_INVALID",
      priorities: [],
    });
    expect(result.conclusion).toContain("forme attendue");
    expect(result.limits).toHaveLength(1);
  });
});

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";

function command(
  state: InitialProjectReviewCommand["state"],
  finalMessage: string | null = null,
): InitialProjectReviewCommand {
  return { id: COMMAND_ID, state, finalMessage };
}

function fakeStore(
  initialReview: ProjectInitialReview | null,
  commands: InitialProjectReviewCommand[],
  saved: ProjectInitialReview[],
): InitialProjectReviewStore & {
  getOrCreateCommand: ReturnType<typeof vi.fn>;
  readCommand: ReturnType<typeof vi.fn>;
  saveReview: ReturnType<typeof vi.fn>;
} {
  const context: InitialProjectReviewContext = {
    projectId: "projet-demo",
    displayName: "Projet Démo",
    discovery,
    initialReview,
    verifiedAt: "2026-08-14T09:04:00.000Z",
  };
  return {
    loadContext: vi.fn(async () => context),
    getOrCreateCommand: vi.fn(async () => COMMAND_ID),
    readCommand: vi.fn(async () => {
      const next = commands.shift();
      if (!next) throw new Error("TEST_COMMAND_SEQUENCE_EMPTY");
      return next;
    }),
    saveReview: vi.fn(async (review: ProjectInitialReview) => {
      saved.push(review);
    }),
  };
}
