import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

const target = resolve(process.cwd(), ".env.local");
const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
const rotate = process.argv.includes("--rotate");
const rotateOwner = process.argv.includes("--rotate-owner");
const sanitize = process.argv.includes("--sanitize");
const ensureConnectors = process.argv.includes("--ensure-connectors");
const enableLanOperator = process.argv.includes("--enable-lan-operator");

if (sanitize) {
  writeFileSync(target, removeEnvValue(existing, "NODE_OPTIONS"), { encoding: "utf8", mode: 0o600, flag: "w" });
  console.log("Configuration locale assainie sans modifier les identifiants.");
} else if (enableLanOperator) {
  const address = findPrivateIpv4();
  if (!address) throw new Error("LAN_ADDRESS_NOT_FOUND");
  const origin = `http://${address}:3020`;
  let updated = existing;
  updated = upsertEnvValue(updated, "OPS_LAN_ENABLED", "true");
  updated = upsertEnvValue(updated, "OPS_LAN_ORIGIN", origin);
  updated = upsertEnvValue(updated, "OPS_OPERATOR_USERNAME", readEnvValue(existing, "OPS_OPERATOR_USERNAME") ?? "operator");
  updated = upsertEnvValue(updated, "OPS_OPERATOR_PASSWORD", readEnvValue(existing, "OPS_OPERATOR_PASSWORD") ?? `company-os-op-${randomBytes(18).toString("base64url")}`);
  writeFileSync(target, updated, { encoding: "utf8", mode: 0o600, flag: "w" });
  console.log(`Accès opérateur LAN configuré pour ${origin}. Les identifiants restent dans .env.local.`);
} else if (ensureConnectors) {
  let updated = existing;
  if (!readEnvValue(existing, "OPS_CONNECTOR_ENCRYPTION_KEY")) {
    updated = upsertEnvValue(updated, "OPS_CONNECTOR_ENCRYPTION_KEY", randomBytes(32).toString("base64url"));
  }
  updated = upsertEnvValue(updated, "OPS_CODEX_MODE", "app-server-stdio");
  updated = upsertEnvValue(updated, "OPS_CODEX_COMMAND", resolve(process.cwd(), "work", "codex-runtime", "codex.exe"));
  updated = upsertEnvValue(updated, "GLOBAL_EXTERNAL_WORK_ENABLED", "false");
  writeFileSync(target, updated, { encoding: "utf8", mode: 0o600, flag: "w" });
  console.log("Coffre local persistant configuré. Aucune valeur secrète n'a été affichée.");
} else if (rotateOwner) {
  let updated = existing;
  updated = upsertEnvValue(updated, "OPS_OWNER_PASSWORD", `company-os-${randomBytes(18).toString("base64url")}`);
  updated = upsertEnvValue(updated, "OPS_SESSION_SECRET", randomBytes(48).toString("base64url"));
  writeFileSync(target, updated, { encoding: "utf8", mode: 0o600, flag: "w" });
  console.log("Identifiants propriétaire locaux renouvelés sans être affichés.");
} else if (!rotate && (/^OPS_OWNER_PASSWORD=/m.test(existing) || /^OPS_SESSION_SECRET=/m.test(existing))) {
  throw new Error("LOCAL_OWNER_ACCESS_ALREADY_EXISTS");
} else {
  const postgresPassword = randomBytes(24).toString("base64url");
  const minioPassword = randomBytes(24).toString("base64url");
  const values = new Map([
    ["APP_URL", "http://localhost:3020"],
    ["NODE_ENV", "development"],
    ["SESSION_SECRET", randomBytes(48).toString("base64url")],
    ["OPS_OWNER_PASSWORD", `company-os-${randomBytes(18).toString("base64url")}`],
    ["OPS_SESSION_SECRET", randomBytes(48).toString("base64url")],
    ["OPS_CODEX_MODE", "app-server-stdio"],
    ["OPS_CODEX_COMMAND", resolve(process.cwd(), "work", "codex-runtime", "codex.exe")],
    ["OPS_CONNECTOR_ENCRYPTION_KEY", randomBytes(32).toString("base64url")],
    ["COMPANY_OS_PROJECT_ID", "company-os"],
    ["COMPANY_OS_PROJECT_NAME", "Company OS"],
    ["COMPANY_OS_PROJECT_ROOT", process.cwd()],
    ["COMPANY_PROJECTS_ALLOWED_ROOTS", resolve(process.cwd(), "..")],
    ["COMPANY_PROJECTS_FORBIDDEN_ROOTS", resolve(process.cwd(), "..", "private")],
    ["POSTGRES_PASSWORD", postgresPassword],
    ["DATABASE_URL", `postgresql://company_os:${postgresPassword}@localhost:5434/company_os`],
    ["DATABASE_SSL", "false"],
    ["MINIO_ROOT_USER", "company_os_local_only"],
    ["MINIO_ROOT_PASSWORD", minioPassword],
    ["S3_ENDPOINT", "http://127.0.0.1:9002"],
    ["S3_REGION", "us-east-1"],
    ["S3_BUCKET", "company-os-system"],
    ["S3_ACCESS_KEY_ID", "company_os_local_only"],
    ["S3_SECRET_ACCESS_KEY", minioPassword],
    ["GLOBAL_EXTERNAL_WORK_ENABLED", "false"],
    ["META_ADS_ENABLED", "false"],
    ["META_DAILY_BUDGET_CAP", "0"],
  ]);
  let updated = existing;
  for (const [key, value] of values) updated = upsertEnvValue(updated, key, value);
  writeFileSync(target, updated, { encoding: "utf8", mode: 0o600, flag: "w" });
  console.log("Company OS local configuré. Les identifiants restent uniquement dans .env.local.");
}

function upsertEnvValue(source, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(source)) return source.replace(pattern, line);
  return `${source}${source.length > 0 && !source.endsWith("\n") ? "\n" : ""}${line}\n`;
}
function removeEnvValue(source, key) { return source.replace(new RegExp(`^${key}=.*(?:\\r?\\n|$)`, "m"), ""); }
function readEnvValue(source, key) { return source.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() || null; }
function findPrivateIpv4() {
  return Object.values(networkInterfaces()).flat().find((entry) => entry && entry.family === "IPv4" && !entry.internal
    && (/^10\./.test(entry.address) || /^192\.168\./.test(entry.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)))?.address ?? null;
}
