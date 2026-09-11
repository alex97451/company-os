import {
  projectInitializationProgressSchema,
  type ProjectInitializationProgress,
  type ProjectInitializationStepId,
} from "./manifest";

const STEP_MESSAGES: Record<ProjectInitializationStepId, string> = {
  folder_check: "Le dossier existe, il est autorisé et accessible en écriture.",
  workspace_analysis: "Les technologies, commandes, documents et l’état Git ont été analysés.",
  local_files: "Les fichiers locaux de Company OS restent à préparer.",
  database: "La base de données isolée reste à préparer.",
  storage: "Le stockage privé reste à préparer.",
  team: "L’équipe Codex dédiée reste à vérifier.",
  cockpit: "Le cockpit local reste à démarrer et à vérifier.",
};

const STEP_ORDER = Object.keys(STEP_MESSAGES) as ProjectInitializationStepId[];

export function createValidatedProjectProgress(): ProjectInitializationProgress {
  return projectInitializationProgressSchema.parse({
    version: 1,
    state: "validated",
    updatedAt: new Date().toISOString(),
    steps: STEP_ORDER.map((id) => ({
      id,
      status: id === "folder_check" || id === "workspace_analysis" ? "complete" : "pending",
      message: STEP_MESSAGES[id],
    })),
  });
}

export function advanceProjectProgress(
  progress: ProjectInitializationProgress,
  completedId: ProjectInitializationStepId,
  completedMessage: string,
  nextId?: ProjectInitializationStepId,
  nextMessage?: string,
): ProjectInitializationProgress {
  return projectInitializationProgressSchema.parse({
    ...progress,
    state: nextId ? "starting" : "ready",
    updatedAt: new Date().toISOString(),
    steps: progress.steps.map((step) => {
      if (step.id === completedId) return { ...step, status: "complete", message: completedMessage };
      if (step.id === nextId) return { ...step, status: "active", message: nextMessage ?? step.message };
      return step;
    }),
  });
}

export function failProjectProgress(
  progress: ProjectInitializationProgress,
  message: string,
): ProjectInitializationProgress {
  return projectInitializationProgressSchema.parse({
    ...progress,
    state: "error",
    updatedAt: new Date().toISOString(),
    steps: progress.steps.map((step) => step.status === "active"
      ? { ...step, status: "error", message }
      : step),
  });
}
