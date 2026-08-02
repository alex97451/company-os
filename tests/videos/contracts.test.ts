import { describe, expect, it } from "vitest";
import { COMPANY_AGENTS } from "../../src/lib/agents/registry";
import { ownerAgentPresentation } from "../../src/lib/agents/owner-presentation";
import { createVideoJobSchema, parseVideoAgentResult, videoAgentResultSchema, videoBriefSchema } from "../../src/lib/videos/contracts";

const brief = {
  version: 1 as const,
  title: "Wedding Quote Check",
  language: "fr" as const,
  platforms: ["tiktok", "instagram_reels"] as const,
  template: "problem_reveal_solution" as const,
  durationSeconds: 15,
  hooks: [
    { id: "hook_1", text: "Avant l’acompte, vérifiez ce qui manque.", score: 91, rationale: "Risque immédiat et action claire." },
    { id: "hook_2", text: "Deux devis ne veulent pas dire deux offres identiques.", score: 84, rationale: "La comparaison crée de la curiosité." },
    { id: "hook_3", text: "Ce prix inclut-il vraiment tout ?", score: 79, rationale: "Question simple et pertinente." },
  ],
  selectedHookId: "hook_1",
  voiceScript: "Avant de payer un acompte, vérifiez les prestations, les frais possibles et les questions à poser.",
  scenes: [
    { id: "scene_1", startSeconds: 0, durationSeconds: 5, headline: "Avant l’acompte", body: "Un prix ne raconte pas toute l’offre.", narration: "Avant de payer un acompte, vérifiez les prestations.", accent: "rose" as const, transition: "zoom" as const },
    { id: "scene_2", startSeconds: 5, durationSeconds: 5, headline: "Repérez les zones floues", body: "Horaires, taxes et suppléments possibles.", narration: "Repérez les frais possibles et les zones floues.", accent: "sky" as const, transition: "slide" as const },
    { id: "scene_3", startSeconds: 10, durationSeconds: 5, headline: "Posez les bonnes questions", body: "Décidez avec des informations claires.", narration: "Posez les bonnes questions avant de décider.", accent: "gold" as const, transition: "wipe" as const },
  ],
  caption: "Comprenez le devis avant de verser l’acompte.",
  hashtags: ["#Mariage", "#DevisMariage", "#WeddingPlanning"],
  heuristicScore: 91,
  rightsDeclarations: [{ asset: "Graphismes", basis: "generated_in_remotion" as const, source: "Gabarit vertical Company OS v1" }],
};

describe("video studio contracts", () => {
  it("registers the twelfth internal agent with a plain-language owner label", () => {
    expect(Object.keys(COMPANY_AGENTS)).toHaveLength(12);
    expect(COMPANY_AGENTS.video_creator.allowedRisks).toContain("write_safe");
    expect(ownerAgentPresentation("video_creator").name).toBe("Créateur de vidéos courtes");
  });

  it("accepts a complete render-ready brief", () => {
    expect(videoBriefSchema.parse(brief).durationSeconds).toBe(15);
    expect(videoAgentResultSchema.parse({ status: "completed", summary: "Brief prêt.", evidence: ["Faits approuvés relus."], brief }).brief).toBeDefined();
    expect(parseVideoAgentResult(JSON.stringify({ status: "completed", summary: "Brief prêt.", evidence: [], brief })).brief).toBeDefined();
  });

  it("rejects a completed result without a brief and scenes that do not cover the duration", () => {
    expect(videoAgentResultSchema.safeParse({ status: "completed", summary: "Prêt.", evidence: [] }).success).toBe(false);
    expect(videoAgentResultSchema.parse({ status: "blocked", summary: "Faits locaux insuffisants.", evidence: [], brief: null }).brief).toBeNull();
    expect(videoBriefSchema.safeParse({ ...brief, scenes: brief.scenes.map((scene, index) => index === 2 ? { ...scene, durationSeconds: 3 } : scene) }).success).toBe(false);
  });

  it("keeps owner requests bounded and strict", () => {
    expect(createVideoJobSchema.parse({ subject: "Présenter le service", goal: "awareness", language: "fr", template: "quick_list", durationSeconds: 30 })).toBeDefined();
    expect(createVideoJobSchema.safeParse({ subject: "x", goal: "awareness", language: "fr", template: "quick_list", durationSeconds: 10, publish: true }).success).toBe(false);
  });
});
