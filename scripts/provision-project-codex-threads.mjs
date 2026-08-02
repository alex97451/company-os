import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = readArgs(process.argv.slice(2));
const projectId = required(args, "project-id");
const projectName = required(args, "project-name");
const workspace = resolve(required(args, "workspace"));
const output = resolve(required(args, "output"));
const command = process.env.OPS_CODEX_COMMAND?.trim();
if (!command) throw new Error("OPS_CODEX_COMMAND_REQUIRED");

const roles = {
  ceo: "company/agents/ceo.md",
  product: "company/agents/product.md",
  design_conversion: "company/agents/design-conversion.md",
  engineering: "company/agents/engineering.md",
  qa_safety: "company/agents/qa-safety.md",
  growth: "company/agents/growth.md",
  content_brand: "company/agents/content-brand.md",
  video_creator: "company/agents/video-creator.md",
  sales_partnerships: "company/agents/sales-partnerships.md",
  customer_care: "company/agents/customer-care.md",
  finance_risk: "company/agents/finance-risk.md",
  reliability_privacy: "company/agents/reliability-privacy.md",
};

const existing = existsSync(output) ? readExistingThreadMap(JSON.parse(readFileSync(output, "utf8"))) : null;
const missingRoles = Object.keys(roles).filter((role) => !existing?.threads[role]);

const child = spawn(command, ["app-server", "--listen", "stdio://"], {
  cwd: workspace,
  stdio: ["pipe", "pipe", "ignore"],
  windowsHide: true,
});
let buffer = "";
let nextId = 1;
const pending = new Map();
const completedTurns = new Set();
const turnWaiters = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      const handler = pending.get(message.id);
      if (message.id !== undefined && handler) {
        handler(message);
        pending.delete(message.id);
      }
      if (message.method === "turn/completed" && typeof message.params?.turn?.id === "string") {
        const turnId = message.params.turn.id;
        completedTurns.add(turnId);
        turnWaiters.get(turnId)?.();
        turnWaiters.delete(turnId);
      }
    }
    newline = buffer.indexOf("\n");
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CODEX_REQUEST_TIMEOUT_${method}`));
    }, 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`CODEX_RPC_${method}_${message.error.code}`));
      else resolvePromise(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function waitForTurn(turnId) {
  if (completedTurns.has(turnId)) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      turnWaiters.delete(turnId);
      reject(new Error("CODEX_THREAD_INITIALIZATION_TIMEOUT"));
    }, 120_000);
    turnWaiters.set(turnId, () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

await request("initialize", {
  clientInfo: { name: "company_os_project_provisioner", title: `${projectName} — Company OS`, version: "0.2.0" },
  capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
});
child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

const threadIds = { ...(existing?.threads ?? {}) };
try {
  for (const role of Object.keys(roles).filter((candidate) => !missingRoles.includes(candidate))) {
    try {
      await request("thread/resume", {
        threadId: threadIds[role],
        excludeTurns: true,
        permissions: ":workspace",
        runtimeWorkspaceRoots: [workspace],
      });
    } catch {
      delete threadIds[role];
      missingRoles.push(role);
    }
  }
  const entries = Object.entries(roles).filter(([role]) => missingRoles.includes(role));
  for (let offset = 0; offset < entries.length; offset += 3) {
    await Promise.all(entries.slice(offset, offset + 3).map(async ([role, manifestPath]) => {
      const roleManifest = readFileSync(resolve(process.cwd(), manifestPath), "utf8");
      const result = await request("thread/start", {
        cwd: workspace,
        runtimeWorkspaceRoots: [workspace],
        permissions: ":workspace",
        approvalPolicy: "never",
        serviceName: `${projectName} — ${role}`,
        ephemeral: false,
        developerInstructions: [
          `Tu es l'agent interne ${role} du projet ${projectName} (${projectId}).`,
          `Ton seul espace de travail est ${workspace}.`,
          "Lis et respecte le AGENTS.md du projet avant toute action s'il existe.",
          "N'accède jamais à un chemin hors de l'espace de travail ni à une racine interdite configurée par Company OS.",
          "Aucune dépense, publicité, publication, email, paiement, déploiement ou action externe sans approbation explicite enregistrée.",
          "Ne révèle jamais de secret ni de donnée client brute.",
          "Retourne une conclusion compréhensible, les livrables et les vérifications réelles.",
          role === "ceo" ? "Le propriétaire communique avec toi. Délègue le travail borné aux spécialistes et synthétise leurs résultats." : "Accepte uniquement les tâches correspondant à ton rôle.",
          "Manifeste de rôle :",
          roleManifest,
        ].join("\n"),
      });
      const threadId = result?.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error(`CODEX_THREAD_ID_MISSING_${role}`);
      const initialization = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Initialise ce rôle interne local. Réponds uniquement : PRÊT.", text_elements: [] }],
        cwd: workspace,
        runtimeWorkspaceRoots: [workspace],
        permissions: ":workspace",
        approvalPolicy: "never",
      });
      const turnId = initialization?.turn?.id;
      if (typeof turnId !== "string" || !turnId) throw new Error(`CODEX_INITIALIZATION_TURN_MISSING_${role}`);
      await waitForTurn(turnId);
      threadIds[role] = threadId;
    }));
  }
  const stored = validateThreadMap({
    version: 1,
    projectId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    threads: threadIds,
  });
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, output);
  process.stdout.write(`${JSON.stringify(stored)}\n`);
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGTERM"), 1_500);
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500)),
  ]);
  clearTimeout(timer);
}

function validateThreadMap(value) {
  if (!value || value.version !== 1 || value.projectId !== projectId || !value.threads || typeof value.threads !== "object") {
    throw new Error("PROJECT_CODEX_THREAD_MAP_INVALID");
  }
  for (const role of Object.keys(roles)) if (typeof value.threads[role] !== "string" || !value.threads[role]) throw new Error("PROJECT_CODEX_THREAD_MAP_INCOMPLETE");
  if (new Set(Object.values(value.threads)).size !== Object.keys(roles).length) throw new Error("PROJECT_CODEX_THREADS_NOT_UNIQUE");
  return value;
}
function readExistingThreadMap(value) {
  if (!value || value.version !== 1 || value.projectId !== projectId || !value.threads || typeof value.threads !== "object") {
    throw new Error("PROJECT_CODEX_THREAD_MAP_INVALID");
  }
  const knownThreads = Object.fromEntries(Object.entries(value.threads).filter(([role, threadId]) =>
    Object.hasOwn(roles, role) && typeof threadId === "string" && threadId.length > 0,
  ));
  if (new Set(Object.values(knownThreads)).size !== Object.keys(knownThreads).length) {
    throw new Error("PROJECT_CODEX_THREADS_NOT_UNIQUE");
  }
  return { ...value, threads: knownThreads };
}
function readArgs(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (key && value) result.set(key, value);
  }
  return result;
}
function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`ARGUMENT_REQUIRED_${key.toUpperCase().replaceAll("-", "_")}`);
  return value;
}
