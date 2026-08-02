import { randomBytes } from "node:crypto";
import type { ConnectorRepository } from "./repository";
import type { ConnectorId } from "./registry";

const REQUEST_TIMEOUT_MS = 12_000;

export async function testConnector(repository: ConnectorRepository, id: ConnectorId): Promise<void> {
  const row = await repository.get(id);
  if (!row) throw new Error("CONNECTOR_NOT_FOUND");
  const config = Object.fromEntries(
    Object.entries(row.public_config).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  let credentials = await repository.credentials(id);
  if (id === "reddit") credentials = await refreshRedditTokenIfNeeded(repository, config, credentials, row.token_expires_at);

  try {
    const response = await connectorRequest(id, config, credentials);
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? "expired" : "error";
      await repository.markResult(id, status, `HTTP_${response.status}`);
      throw new Error(`CONNECTOR_TEST_HTTP_${response.status}`);
    }
    await repository.markResult(id, "connected", null);
  } catch (error) {
    const code = safeErrorCode(error);
    if (!code.startsWith("CONNECTOR_TEST_HTTP_")) await repository.markResult(id, "error", code);
    throw error;
  }
}

export async function createOAuthAuthorization(
  repository: ConnectorRepository,
  id: "meta" | "reddit",
): Promise<string> {
  const row = await repository.get(id);
  if (!row) throw new Error("CONNECTOR_NOT_FOUND");
  const config = asStringRecord(row.public_config);
  const credentials = await repository.credentials(id);
  const clientId = required(config.clientId, "CONNECTOR_CLIENT_ID_REQUIRED");
  required(credentials.clientSecret, "CONNECTOR_CLIENT_SECRET_REQUIRED");
  const redirectUri = `${required(process.env.APP_URL, "APP_URL_REQUIRED")}/api/ops/connectors/${id}/oauth/callback`;
  const state = randomBytes(32).toString("base64url");
  await repository.storeOAuthState(id, state, { redirectUri });

  if (id === "meta") {
    const version = config.apiVersion || "v24.0";
    const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      scope: "pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,instagram_manage_comments",
    }).toString();
    return url.toString();
  }

  const url = new URL("https://www.reddit.com/api/v1/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    duration: "permanent",
    scope: "identity read submit edit history",
  }).toString();
  return url.toString();
}

export async function completeOAuthAuthorization(
  repository: ConnectorRepository,
  id: "meta" | "reddit",
  code: string,
  state: string,
): Promise<void> {
  const oauthState = await repository.consumeOAuthState(id, state);
  const row = await repository.get(id);
  if (!row) throw new Error("CONNECTOR_NOT_FOUND");
  const config = asStringRecord(row.public_config);
  const credentials = await repository.credentials(id);
  const token = id === "meta"
    ? await exchangeMetaCode(config, credentials, code, required(oauthState.redirectUri, "OAUTH_REDIRECT_REQUIRED"))
    : await exchangeRedditCode(config, credentials, code, required(oauthState.redirectUri, "OAUTH_REDIRECT_REQUIRED"));
  await repository.saveOAuthTokens(id, token.credentials, token.expiresAt);
  await testConnector(repository, id);
}

async function connectorRequest(
  id: ConnectorId,
  config: Record<string, string>,
  credentials: Record<string, string>,
): Promise<Response> {
  switch (id) {
    case "postiz":
      return safeFetch(`${trimUrl(config.baseUrl)}/integrations`, {
        headers: { Authorization: required(credentials.apiKey, "CONNECTOR_API_KEY_REQUIRED") },
      });
    case "ayrshare":
      return safeFetch(`${trimUrl(config.baseUrl)}/profiles?limit=1`, {
        headers: { Authorization: `Bearer ${required(credentials.apiKey, "CONNECTOR_API_KEY_REQUIRED")}` },
      });
    case "meta":
      return safeFetch(`https://graph.facebook.com/${config.apiVersion || "v24.0"}/me?fields=id,name`, {
        headers: { Authorization: `Bearer ${required(credentials.accessToken, "CONNECTOR_ACCESS_TOKEN_REQUIRED")}` },
      });
    case "reddit":
      return safeFetch("https://oauth.reddit.com/api/v1/me", {
        headers: {
          Authorization: `Bearer ${required(credentials.accessToken, "CONNECTOR_ACCESS_TOKEN_REQUIRED")}`,
          "User-Agent": required(config.userAgent, "CONNECTOR_USER_AGENT_REQUIRED"),
        },
      });
    case "discourse":
      return safeFetch(`${trimUrl(config.baseUrl)}/session/current.json`, {
        headers: {
          "Api-Key": required(credentials.apiKey, "CONNECTOR_API_KEY_REQUIRED"),
          "Api-Username": required(config.username, "CONNECTOR_USERNAME_REQUIRED"),
          Accept: "application/json",
        },
      });
    case "figma":
      return safeFetch(`${trimUrl(config.baseUrl)}/me`, {
        headers: { "X-Figma-Token": required(credentials.apiToken, "CONNECTOR_API_TOKEN_REQUIRED") },
      });
  }
}

async function refreshRedditTokenIfNeeded(
  repository: ConnectorRepository,
  config: Record<string, string>,
  credentials: Record<string, string>,
  expiresAt: Date | null,
): Promise<Record<string, string>> {
  if (!expiresAt || expiresAt.getTime() > Date.now() + 60_000) return credentials;
  const refreshToken = required(credentials.refreshToken, "CONNECTOR_REFRESH_TOKEN_REQUIRED");
  const response = await safeFetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: basicAuth(required(config.clientId, "CONNECTOR_CLIENT_ID_REQUIRED"), required(credentials.clientSecret, "CONNECTOR_CLIENT_SECRET_REQUIRED")),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": required(config.userAgent, "CONNECTOR_USER_AGENT_REQUIRED"),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await parseTokenResponse(response);
  const patch = { accessToken: data.access_token, refreshToken: data.refresh_token || refreshToken };
  const nextExpiry = new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000);
  await repository.saveOAuthTokens("reddit", patch, nextExpiry);
  return { ...credentials, ...patch };
}

async function exchangeMetaCode(
  config: Record<string, string>,
  credentials: Record<string, string>,
  code: string,
  redirectUri: string,
) {
  const version = config.apiVersion || "v24.0";
  const url = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: required(config.clientId, "CONNECTOR_CLIENT_ID_REQUIRED"),
    client_secret: required(credentials.clientSecret, "CONNECTOR_CLIENT_SECRET_REQUIRED"),
    redirect_uri: redirectUri,
    code,
  }).toString();
  const shortLived = await parseTokenResponse(await safeFetch(url.toString()));
  const longLivedUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  longLivedUrl.search = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: required(config.clientId, "CONNECTOR_CLIENT_ID_REQUIRED"),
    client_secret: required(credentials.clientSecret, "CONNECTOR_CLIENT_SECRET_REQUIRED"),
    fb_exchange_token: required(shortLived.access_token, "OAUTH_ACCESS_TOKEN_MISSING"),
  }).toString();
  const data = await parseTokenResponse(await safeFetch(longLivedUrl.toString()));
  return {
    credentials: { accessToken: data.access_token },
    expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000) : null,
  };
}

async function exchangeRedditCode(
  config: Record<string, string>,
  credentials: Record<string, string>,
  code: string,
  redirectUri: string,
) {
  const response = await safeFetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: basicAuth(required(config.clientId, "CONNECTOR_CLIENT_ID_REQUIRED"), required(credentials.clientSecret, "CONNECTOR_CLIENT_SECRET_REQUIRED")),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": required(config.userAgent, "CONNECTOR_USER_AGENT_REQUIRED"),
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  const data = await parseTokenResponse(response);
  return {
    credentials: { accessToken: data.access_token, refreshToken: required(data.refresh_token, "OAUTH_REFRESH_TOKEN_MISSING") },
    expiresAt: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000),
  };
}

async function parseTokenResponse(response: Response): Promise<Record<string, string>> {
  if (!response.ok) throw new Error(`OAUTH_TOKEN_HTTP_${response.status}`);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("OAUTH_TOKEN_INVALID");
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)]));
}

async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("CONNECTOR_HTTPS_REQUIRED");
  }
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" });
}

function trimUrl(value: string | undefined): string {
  return required(value, "CONNECTOR_BASE_URL_REQUIRED").replace(/\/+$/, "");
}

function required(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}

function asStringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "CONNECTOR_TEST_FAILED";
  return /^[A-Z0-9_:.-]{1,120}$/.test(error.message) ? error.message : "CONNECTOR_TEST_FAILED";
}
