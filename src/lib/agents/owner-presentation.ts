import type { CompanyAgentId } from "./registry";

export type OwnerAgentPresentation = {
  name: string;
  role: string;
};

export const OWNER_AGENT_PRESENTATION: Readonly<Record<CompanyAgentId, OwnerAgentPresentation>> = {
  ceo: {
    name: "Directeur général",
    role: "Coordonne l’entreprise et répartit les priorités",
  },
  product: {
    name: "Responsable produit",
    role: "Définit le produit, le parcours client et les priorités",
  },
  design_conversion: {
    name: "Designer expérience client",
    role: "Améliore l’interface, l’accessibilité et la conversion",
  },
  engineering: {
    name: "Développeur full-stack",
    role: "Construit et maintient le SaaS de bout en bout",
  },
  qa_safety: {
    name: "Responsable qualité",
    role: "Vérifie les fonctionnalités, les rapports et les formulations",
  },
  growth: {
    name: "Responsable marketing",
    role: "Prépare l’acquisition, les campagnes et les expérimentations",
  },
  content_brand: {
    name: "Responsable contenu et marque",
    role: "Crée les contenus, visuels et publications en anglais et français",
  },
  video_creator: {
    name: "Créateur de vidéos courtes",
    role: "Produit les TikTok et Reels verticaux, du concept au fichier final",
  },
  sales_partnerships: {
    name: "Responsable partenariats",
    role: "Développe les partenariats et opportunités commerciales",
  },
  customer_care: {
    name: "Responsable service client",
    role: "Traite les demandes clients et améliore les réponses",
  },
  finance_risk: {
    name: "Responsable finance",
    role: "Suit les revenus, les coûts, les budgets et les risques",
  },
  reliability_privacy: {
    name: "Responsable sécurité et fiabilité",
    role: "Protège les données et maintient la disponibilité du service",
  },
};

export function ownerAgentPresentation(agentId: CompanyAgentId): OwnerAgentPresentation {
  return OWNER_AGENT_PRESENTATION[agentId];
}
