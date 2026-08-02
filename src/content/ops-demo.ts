export type CompanyState = "waiting" | "working" | "action" | "done" | "problem";
export type ModelProfile = "Rapid" | "Balanced" | "Expert" | "Critical";

export interface CompanyPriority {
  id: string;
  title: string;
  owner: string;
  state: CompanyState;
  due: string;
}

export interface CompanyAgent {
  id: string;
  name: string;
  role: string;
  state: CompanyState;
  task: string;
  profile: ModelProfile;
  lastProgress: string;
}

export interface CompanyTask {
  id: string;
  title: string;
  owner: string;
  state: CompanyState;
  verifier: string;
  result: string;
  resultLabel?: string;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  impact: string;
  reversible: string;
  consequence: string;
  expires: string;
}

export interface CeoMessage {
  id: string;
  author: "CEO" | "Owner";
  body: string;
  time: string;
  status?: string;
}

export interface ActivityItem {
  id: string;
  reference?: string;
  actor: string;
  role?: string;
  summary: string;
  detail?: string;
  time: string;
  state: CompanyState;
}

export const priorities: CompanyPriority[] = [
  { id: "P-104", title: "Finaliser le cockpit local de direction", owner: "CTO", state: "working", due: "Aujourd'hui" },
  { id: "P-103", title: "Valider le parcours gratuit vers paiement", owner: "Product", state: "action", due: "Décision requise" },
  { id: "P-102", title: "Préparer trois créations publicitaires UK", owner: "Growth", state: "waiting", due: "Demain" },
  { id: "P-101", title: "Contrôler les formulations prudentes du rapport", owner: "QA", state: "done", due: "Vérifié" },
  { id: "P-100", title: "Documenter la mise en production sans secrets", owner: "Reliability", state: "working", due: "Cette semaine" },
];

export const agents: CompanyAgent[] = [
  { id: "ceo", name: "CEO", role: "Direction générale", state: "working", task: "Coordonne la livraison du cockpit", profile: "Expert", lastProgress: "Priorités réordonnées il y a 1 min" },
  { id: "product", name: "Product", role: "Produit et parcours", state: "action", task: "Attend la validation du parcours de paiement", profile: "Balanced", lastProgress: "Deux options prêtes il y a 4 min" },
  { id: "design", name: "Design & Conversion", role: "Expérience et conversion", state: "working", task: "Affinage du cockpit responsive", profile: "Balanced", lastProgress: "Vue mobile en cours" },
  { id: "cto", name: "CTO", role: "Ingénierie", state: "working", task: "Architecture du pont Codex", profile: "Expert", lastProgress: "Contrat d'événements défini" },
  { id: "qa", name: "QA & Report Safety", role: "Qualité et sécurité", state: "done", task: "Revue des formulations", profile: "Critical", lastProgress: "Verdict favorable avec réserves" },
  { id: "growth", name: "Growth", role: "Acquisition UK", state: "waiting", task: "Créations publicitaires en brouillon", profile: "Balanced", lastProgress: "Aucune dépense engagée" },
  { id: "content", name: "Content & Brand", role: "Contenu EN/FR", state: "waiting", task: "Attend le brief Growth", profile: "Rapid", lastProgress: "Guide de ton chargé" },
  { id: "sales", name: "Partnerships", role: "Partenariats", state: "waiting", task: "Aucune prospection autorisée", profile: "Rapid", lastProgress: "File d'attente vide" },
  { id: "care", name: "Customer Care", role: "Support client", state: "waiting", task: "Prépare les réponses de récupération", profile: "Balanced", lastProgress: "Modèles de réponse vérifiés" },
  { id: "finance", name: "Finance", role: "Revenus et risque", state: "done", task: "Contrôle du plafond externe", profile: "Expert", lastProgress: "Plafond confirmé à £0" },
  { id: "reliability", name: "Reliability & Privacy", role: "Fiabilité et données", state: "working", task: "Procédure de purge et reprise", profile: "Critical", lastProgress: "Test de purge planifié" },
];

export const tasks: CompanyTask[] = [
  { id: "T-241", title: "Construire le cockpit propriétaire", owner: "CTO", state: "working", verifier: "QA", result: "En cours — vérification responsive attendue" },
  { id: "T-238", title: "Revoir le rapport de démonstration", owner: "QA", state: "done", verifier: "CEO", result: "Vérifié — aucune accusation ni promesse garantie" },
  { id: "T-236", title: "Préparer le pack publicitaire UK", owner: "Growth", state: "waiting", verifier: "Finance", result: "Brouillon seulement — diffusion interdite" },
  { id: "T-232", title: "Tester la purge automatique", owner: "Reliability", state: "working", verifier: "QA", result: "Résultat non encore vérifié" },
];

export const approvals: ApprovalRequest[] = [
  {
    id: "A-018",
    title: "Choisir la variante du parcours de paiement",
    impact: "Modifie uniquement le prochain prototype local. Aucun paiement réel et aucune publication.",
    reversible: "Oui, le choix peut être remplacé avant mise en production.",
    consequence: "En cas de refus, Product préparera une troisième option.",
    expires: "Expire dans 22 h",
  },
];

export const initialMessages: CeoMessage[] = [
  { id: "M-1", author: "CEO", body: "Bonjour Alexe. L'entreprise fonctionne en mode local. J'ai cinq priorités actives et une seule décision à te soumettre.", time: "09:41" },
  { id: "M-2", author: "CEO", body: "Le cockpit est la priorité actuelle. Les autres agents restent observables ici, mais je demeure ton seul interlocuteur.", time: "09:43" },
];

export const activity: ActivityItem[] = [
  { id: "E-42", actor: "CEO", summary: "a confié la revue responsive à Design & Conversion", time: "Il y a 1 min", state: "working" },
  { id: "E-41", actor: "Finance", summary: "a confirmé le plafond de dépense externe à £0", time: "Il y a 6 min", state: "done" },
  { id: "E-40", actor: "Product", summary: "a demandé une décision sur le parcours de paiement", time: "Il y a 12 min", state: "action" },
  { id: "E-39", actor: "QA", summary: "a vérifié les formulations du rapport", time: "Il y a 18 min", state: "done" },
];

export const modelProfiles = [
  { name: "Rapid" as const, use: "Tri, veille, synthèses", share: "18%", color: "sky" },
  { name: "Balanced" as const, use: "Travail courant", share: "42%", color: "violet" },
  { name: "Expert" as const, use: "Architecture et décisions complexes", share: "31%", color: "amber" },
  { name: "Critical" as const, use: "Risque élevé avec vérification", share: "9%", color: "rose" },
];
