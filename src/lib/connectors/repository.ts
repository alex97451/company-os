import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { decryptConnectorCredentials, encryptConnectorCredentials } from "./credential-vault";
import {
  connectorRegistry,
  defaultConnectorConfig,
  type ConnectorId,
  type ConnectorStatus,
} from "./registry";

export type ConnectorView = {
  id: ConnectorId;
  name: string;
  category: string;
  description: string;
  authKind: "api_key" | "oauth2";
  docsUrl: string;
  status: ConnectorStatus;
  publicConfig: Record<string, string>;
  hasCredentials: boolean;
  tokenExpiresAt: string | null;
  connectedAt: string | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  configFields: typeof connectorRegistry[ConnectorId]["configFields"];
  credentialFields: typeof connectorRegistry[ConnectorId]["credentialFields"];
};

type ConnectorRow = {
  id: ConnectorId;
  status: ConnectorStatus;
  public_config: Record<string, unknown>;
  encrypted_credentials: string | null;
  token_expires_at: Date | null;
  connected_at: Date | null;
  last_tested_at: Date | null;
  last_error_code: string | null;
};

export class ConnectorRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<ConnectorView[]> {
    const result = await this.pool.query<ConnectorRow>(
      `SELECT id, status, public_config, encrypted_credentials, token_expires_at,
              connected_at, last_tested_at, last_error_code
         FROM ops_connectors
        ORDER BY id`,
    );
    const rows = new Map(result.rows.map((row) => [row.id, row]));
    return Object.values(connectorRegistry).map((definition) => {
      const row = rows.get(definition.id);
      const expired = Boolean(row?.token_expires_at && row.token_expires_at.getTime() <= Date.now());
      return {
        id: definition.id,
        name: definition.name,
        category: definition.category,
        description: definition.description,
        authKind: definition.authKind,
        docsUrl: definition.docsUrl,
        status: expired ? "expired" : row?.status ?? "not_connected",
        publicConfig: {
          ...defaultConnectorConfig[definition.id],
          ...stringRecord(row?.public_config),
        },
        hasCredentials: Boolean(row?.encrypted_credentials),
        tokenExpiresAt: row?.token_expires_at?.toISOString() ?? null,
        connectedAt: row?.connected_at?.toISOString() ?? null,
        lastTestedAt: row?.last_tested_at?.toISOString() ?? null,
        lastErrorCode: row?.last_error_code ?? null,
        configFields: definition.configFields,
        credentialFields: definition.credentialFields,
      };
    });
  }

  async get(id: ConnectorId): Promise<ConnectorRow | null> {
    const result = await this.pool.query<ConnectorRow>(
      `SELECT id, status, public_config, encrypted_credentials, token_expires_at,
              connected_at, last_tested_at, last_error_code
         FROM ops_connectors WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async save(
    id: ConnectorId,
    publicConfig: Record<string, string>,
    credentialPatch: Record<string, string>,
  ): Promise<void> {
    const current = await this.get(id);
    const previousCredentials = current?.encrypted_credentials
      ? decryptConnectorCredentials(id, current.encrypted_credentials)
      : {};
    const suppliedCredentials = Object.fromEntries(
      Object.entries(credentialPatch).filter(([, value]) => value.trim().length > 0),
    );
    const credentials = { ...previousCredentials, ...suppliedCredentials };
    const encrypted = Object.keys(credentials).length > 0
      ? encryptConnectorCredentials(id, credentials)
      : null;
    await this.pool.query(
      `UPDATE ops_connectors
          SET public_config = $2::jsonb,
              encrypted_credentials = $3,
              status = CASE WHEN $3::text IS NULL THEN 'not_connected' ELSE status END,
              last_error_code = NULL,
              updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(publicConfig), encrypted],
    );
  }

  async credentials(id: ConnectorId): Promise<Record<string, string>> {
    const row = await this.get(id);
    if (!row?.encrypted_credentials) throw new Error("CONNECTOR_NOT_CONNECTED");
    return decryptConnectorCredentials(id, row.encrypted_credentials);
  }

  async markResult(
    id: ConnectorId,
    status: ConnectorStatus,
    errorCode: string | null,
    tokenExpiresAt?: Date | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ops_connectors
          SET status = $2,
              last_error_code = $3,
              last_tested_at = now(),
              connected_at = CASE WHEN $2 = 'connected' THEN COALESCE(connected_at, now()) ELSE connected_at END,
              token_expires_at = COALESCE($4, token_expires_at),
              updated_at = now()
        WHERE id = $1`,
      [id, status, errorCode, tokenExpiresAt ?? null],
    );
  }

  async saveOAuthTokens(
    id: ConnectorId,
    tokenPatch: Record<string, string>,
    expiresAt: Date | null,
  ): Promise<void> {
    const previous = await this.credentials(id);
    await this.pool.query(
      `UPDATE ops_connectors
          SET encrypted_credentials = $2,
              status = 'connected',
              token_expires_at = $3,
              connected_at = COALESCE(connected_at, now()),
              last_tested_at = now(),
              last_error_code = NULL,
              updated_at = now()
        WHERE id = $1`,
      [id, encryptConnectorCredentials(id, { ...previous, ...tokenPatch }), expiresAt],
    );
  }

  async disconnect(id: ConnectorId): Promise<void> {
    await this.pool.query(
      `UPDATE ops_connectors
          SET encrypted_credentials = NULL, status = 'not_connected',
              token_expires_at = NULL, connected_at = NULL,
              last_tested_at = NULL, last_error_code = NULL, updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  async storeOAuthState(id: ConnectorId, state: string, payload: Record<string, string>): Promise<void> {
    const digest = digestState(state);
    await this.pool.query(
      `INSERT INTO ops_oauth_states (state_digest, connector_id, encrypted_payload, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [digest, id, encryptConnectorCredentials(`oauth:${id}`, payload)],
    );
  }

  async consumeOAuthState(id: ConnectorId, state: string): Promise<Record<string, string>> {
    const result = await this.pool.query<{ encrypted_payload: string }>(
      `UPDATE ops_oauth_states
          SET used_at = now()
        WHERE state_digest = $1 AND connector_id = $2
          AND used_at IS NULL AND expires_at > now()
      RETURNING encrypted_payload`,
      [digestState(state), id],
    );
    const payload = result.rows[0]?.encrypted_payload;
    if (!payload) throw new Error("OAUTH_STATE_INVALID");
    return decryptConnectorCredentials(`oauth:${id}`, payload);
  }
}

function digestState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function stringRecord(value: Record<string, unknown> | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
