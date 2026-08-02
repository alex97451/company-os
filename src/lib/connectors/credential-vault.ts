import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function connectorVaultConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readKey(env);
    return true;
  } catch {
    return false;
  }
}

export function encryptConnectorCredentials(
  connectorId: string,
  credentials: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", readKey(env), iv);
  cipher.setAAD(Buffer.from(connectorId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptConnectorCredentials(
  connectorId: string,
  payload: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const [version, iv, tag, ciphertext, extra] = payload.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext || extra) throw new Error("CONNECTOR_CREDENTIALS_INVALID");
  try {
    const decipher = createDecipheriv("aes-256-gcm", readKey(env), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(connectorId, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const cleartext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(cleartext);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    throw new Error("CONNECTOR_CREDENTIALS_DECRYPT_FAILED");
  }
}

function readKey(env: NodeJS.ProcessEnv): Buffer {
  const value = env.OPS_CONNECTOR_ENCRYPTION_KEY?.trim();
  if (!value) throw new Error("OPS_CONNECTOR_ENCRYPTION_KEY_NOT_CONFIGURED");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("OPS_CONNECTOR_ENCRYPTION_KEY_INVALID");
  return key;
}
