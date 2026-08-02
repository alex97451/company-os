import { describe, expect, it } from "vitest";
import {
  decryptConnectorCredentials,
  encryptConnectorCredentials,
} from "@/lib/connectors/credential-vault";

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  OPS_CONNECTOR_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
};

describe("connector credential vault", () => {
  it("round-trips credentials without plaintext in the payload", () => {
    const encrypted = encryptConnectorCredentials("reddit", {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
    }, env);
    expect(encrypted).not.toContain("access-secret");
    expect(decryptConnectorCredentials("reddit", encrypted, env)).toEqual({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
    });
  });

  it("rejects another connector and tampering", () => {
    const encrypted = encryptConnectorCredentials("reddit", { accessToken: "secret" }, env);
    expect(() => decryptConnectorCredentials("meta", encrypted, env)).toThrow("CONNECTOR_CREDENTIALS_DECRYPT_FAILED");
    expect(() => decryptConnectorCredentials("reddit", `${encrypted.slice(0, -1)}A`, env)).toThrow("CONNECTOR_CREDENTIALS_DECRYPT_FAILED");
  });
});
