import { z } from "zod";

export const connectorIds = ["postiz", "ayrshare", "meta", "reddit", "discourse", "figma"] as const;
export type ConnectorId = (typeof connectorIds)[number];
export type ConnectorStatus = "not_connected" | "connected" | "expired" | "error";
export type ConnectorAuthKind = "api_key" | "oauth2";

export type ConnectorField = {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  required?: boolean;
  type?: "text" | "url";
};

export type ConnectorDefinition = {
  id: ConnectorId;
  name: string;
  category: "Publication" | "Communauté" | "Design";
  description: string;
  authKind: ConnectorAuthKind;
  docsUrl: string;
  configFields: ConnectorField[];
  credentialFields: ConnectorField[];
};

export const connectorRegistry: Record<ConnectorId, ConnectorDefinition> = {
  postiz: {
    id: "postiz",
    name: "Postiz",
    category: "Publication",
    description: "Planification et publication multi-réseaux.",
    authKind: "api_key",
    docsUrl: "https://docs.postiz.com/public-api/introduction",
    configFields: [{ key: "baseUrl", label: "URL API", placeholder: "https://api.postiz.com/public/v1", type: "url", required: true }],
    credentialFields: [{ key: "apiKey", label: "Clé API", placeholder: "Clé Postiz", secret: true, required: true }],
  },
  ayrshare: {
    id: "ayrshare",
    name: "Ayrshare",
    category: "Communauté",
    description: "Profils sociaux, messages, commentaires et réponses.",
    authKind: "api_key",
    docsUrl: "https://www.ayrshare.com/docs/apis/overview",
    configFields: [{ key: "baseUrl", label: "URL API", placeholder: "https://api.ayrshare.com/api", type: "url", required: true }],
    credentialFields: [
      { key: "apiKey", label: "Clé API primaire", placeholder: "Clé Ayrshare", secret: true, required: true },
      { key: "profileKey", label: "Clé de profil", placeholder: "Optionnelle pour le profil principal", secret: true },
    ],
  },
  meta: {
    id: "meta",
    name: "Meta",
    category: "Communauté",
    description: "Connexion directe Facebook et Instagram via OAuth.",
    authKind: "oauth2",
    docsUrl: "https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow",
    configFields: [
      { key: "clientId", label: "App ID", placeholder: "Meta App ID", required: true },
      { key: "apiVersion", label: "Version Graph API", placeholder: "v24.0", required: true },
    ],
    credentialFields: [{ key: "clientSecret", label: "App secret", placeholder: "Meta App Secret", secret: true, required: true }],
  },
  reddit: {
    id: "reddit",
    name: "Reddit",
    category: "Communauté",
    description: "Veille, publication et réponses via OAuth permanent.",
    authKind: "oauth2",
    docsUrl: "https://github.com/reddit-archive/reddit/wiki/OAuth2",
    configFields: [
      { key: "clientId", label: "Client ID", placeholder: "Reddit Client ID", required: true },
      { key: "userAgent", label: "User-Agent", placeholder: "windows:company-project:v1 (by /u/username)", required: true },
    ],
    credentialFields: [{ key: "clientSecret", label: "Client secret", placeholder: "Reddit Client Secret", secret: true, required: true }],
  },
  discourse: {
    id: "discourse",
    name: "Discourse",
    category: "Communauté",
    description: "Forums Discourse autorisés et mémoire des conversations.",
    authKind: "api_key",
    docsUrl: "https://docs.discourse.org/",
    configFields: [
      { key: "baseUrl", label: "URL du forum", placeholder: "https://forum.example.com", type: "url", required: true },
      { key: "username", label: "Utilisateur API", placeholder: "system", required: true },
    ],
    credentialFields: [{ key: "apiKey", label: "Clé API", placeholder: "Clé Discourse", secret: true, required: true }],
  },
  figma: {
    id: "figma",
    name: "Figma",
    category: "Design",
    description: "Accès REST aux fichiers et commentaires de design.",
    authKind: "api_key",
    docsUrl: "https://developers.figma.com/docs/rest-api/authentication/",
    configFields: [{ key: "baseUrl", label: "URL API", placeholder: "https://api.figma.com/v1", type: "url", required: true }],
    credentialFields: [{ key: "apiToken", label: "Jeton d’accès", placeholder: "PAT, plan token ou OAuth token", secret: true, required: true }],
  },
};

export const defaultConnectorConfig: Record<ConnectorId, Record<string, string>> = {
  postiz: { baseUrl: "https://api.postiz.com/public/v1" },
  ayrshare: { baseUrl: "https://api.ayrshare.com/api" },
  meta: { clientId: "", apiVersion: "v24.0" },
  reddit: { clientId: "", userAgent: "windows:company-project:v1" },
  discourse: { baseUrl: "", username: "system" },
  figma: { baseUrl: "https://api.figma.com/v1" },
};

export const connectorIdSchema = z.enum(connectorIds);
const safeValue = z.string().trim().max(2_000);
export const connectorUpdateSchema = z.object({
  publicConfig: z.record(z.string(), safeValue).default({}),
  credentials: z.record(z.string(), safeValue).default({}),
}).strict();

export function validateConnectorInput(
  id: ConnectorId,
  publicConfig: Record<string, string>,
  credentials: Record<string, string>,
  hasCredentials: boolean,
): void {
  const definition = connectorRegistry[id];
  for (const field of definition.configFields) {
    const value = publicConfig[field.key]?.trim();
    if (field.required && !value) throw new Error(`CONNECTOR_FIELD_REQUIRED:${field.key}`);
    if (field.type === "url" && value) {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" && !isLocalUrl(parsed)) throw new Error(`CONNECTOR_HTTPS_REQUIRED:${field.key}`);
    }
  }
  if (!hasCredentials) {
    for (const field of definition.credentialFields) {
      if (field.required && !credentials[field.key]?.trim()) throw new Error(`CONNECTOR_CREDENTIAL_REQUIRED:${field.key}`);
    }
  }
}

function isLocalUrl(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}
