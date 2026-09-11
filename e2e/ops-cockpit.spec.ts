import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createOpsSession } from "@/lib/ops/auth";

function localSessionSecret(): string | null {
  try {
    const localEnv = readFileSync(".env.local", "utf8");
    return localEnv.match(/^OPS_SESSION_SECRET=(.+)$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

test.describe("local owner company cockpit", () => {
  test("protects /ops and never invents data while offline", async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const sessionSecret = localSessionSecret();
    test.skip(!sessionSecret, "Run npm run ops:setup to enable the local owner test.");
    await page.route("**/api/ops/snapshot", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "SNAPSHOT_UNAVAILABLE" }),
      });
    });
    await page.route("**/api/ops/projects", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const complete = (id: string, message: string) => ({ id, status: "complete", message });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          projects: [{
            id: "company-os",
            displayName: "Company OS",
            kind: "saas",
            workspacePath: "C:\\CompanyProjects\\company-os",
            isolationMode: "dedicated_runtime",
            status: "online",
            current: true,
            lastHeartbeatAt: "2026-08-14T00:00:00.000Z",
            lastErrorCode: null,
            runtimeState: "online",
            webPort: 3100,
            cockpitUrl: "http://localhost:3100/ops",
            initializedAt: "2026-08-14T00:00:00.000Z",
            discovery: {
              version: 1,
              analyzedAt: "2026-08-14T00:00:00.000Z",
              canonicalPath: "C:\\CompanyProjects\\company-os",
              existingProjectId: "company-os",
              writable: true,
              technologies: ["Node.js", "TypeScript", "Next.js", "React", "Docker"],
              packageManager: "npm",
              scripts: ["build", "dev", "lint", "test", "typecheck", "verify"],
              documentation: { readme: true, agentInstructions: true, docsDirectory: true, markdownFiles: 8 },
              git: { state: "changes", branch: "main", changedFiles: 2 },
              suggestedKind: "web_app",
              commands: { verify: "npm run verify", start: "npm run dev", stop: "Arrêter le runtime depuis Ops" },
            },
            initialization: {
              version: 1,
              state: "ready",
              updatedAt: "2026-08-14T00:00:00.000Z",
              steps: [
                complete("folder_check", "Le dossier existe, il est autorisé et accessible en écriture."),
                complete("workspace_analysis", "Les technologies, commandes, documents et l’état Git ont été analysés."),
                complete("local_files", "Les fichiers locaux sont prêts."),
                complete("database", "La base de données isolée est accessible."),
                complete("storage", "Le stockage privé est prêt."),
                complete("team", "Les douze conversations Codex dédiées ont été vérifiées."),
                complete("cockpit", "Le cockpit local répond et ses services sont actifs."),
              ],
            },
            initialReview: null,
          }, {
            id: "projet-demo",
            displayName: "Projet Démo",
            kind: "web_app",
            workspacePath: "C:\\CompanyProjects\\projet-demo",
            isolationMode: "dedicated_runtime",
            status: "online",
            current: false,
            lastHeartbeatAt: "2026-08-14T00:05:00.000Z",
            lastErrorCode: null,
            runtimeState: "online",
            webPort: 3200,
            cockpitUrl: "http://localhost:3200/ops",
            initializedAt: "2026-08-14T00:00:00.000Z",
            discovery: null,
            initialization: null,
            initialReview: {
              version: 1,
              state: "completed",
              commandId: "11111111-1111-4111-8111-111111111111",
              triggeredAt: "2026-08-14T00:01:00.000Z",
              updatedAt: "2026-08-14T00:04:00.000Z",
              completedAt: "2026-08-14T00:04:00.000Z",
              conclusion: "Le projet possède une base claire et doit maintenant prouver sa vérification locale.",
              limits: ["Le diagnostic initial ne contient pas de retour utilisateur."],
              priorities: [
                { id: "P1", title: "Prouver la qualité locale", observation: "Les commandes sont présentes.", basis: ["commands"], acceptanceCriteria: ["Les contrôles locaux se terminent sans erreur."] },
                { id: "P2", title: "Clarifier le parcours", observation: "La documentation est disponible.", basis: ["documentation"], acceptanceCriteria: ["Le démarrage est décrit et vérifiable."] },
                { id: "P3", title: "Sécuriser la mise en ligne", observation: "Le runtime a répondu.", basis: ["operational_readiness"], acceptanceCriteria: ["Les signaux restent récents pendant le contrôle."] },
              ],
              errorCode: null,
            },
          }],
          policy: { allowedRoots: ["C:\\CompanyProjects"] },
        }),
      });
    });
    await page.route("**/api/ops/connectors", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connectors: [{
            id: "postiz",
            name: "Postiz",
            category: "Publication",
            description: "Planification et publication multi-réseaux.",
            authKind: "api_key",
            docsUrl: "https://docs.postiz.com/public-api/introduction",
            status: "not_connected",
            publicConfig: { baseUrl: "https://api.postiz.com/public/v1" },
            hasCredentials: false,
            tokenExpiresAt: null,
            connectedAt: null,
            lastTestedAt: null,
            lastErrorCode: null,
            configFields: [{ key: "baseUrl", label: "URL API", placeholder: "https://api.postiz.com/public/v1", type: "url", required: true }],
            credentialFields: [{ key: "apiKey", label: "Clé API", placeholder: "Clé Postiz", secret: true, required: true }],
          }],
        }),
      });
    });

    await page.goto("/ops");
    await expect(page).toHaveURL(/\/ops\/login$/);
    process.env.OPS_SESSION_SECRET = sessionSecret!;
    const session = createOpsSession({ actorId: "owner", role: "owner" });
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";
    await page.context().addCookies([
      { name: "company_os_ops_session", value: session.token, url: baseURL, httpOnly: true, sameSite: "Strict", expires: session.expiresAt.getTime() / 1000 },
      { name: "company_os_ops_csrf", value: session.csrfToken, url: baseURL, httpOnly: false, sameSite: "Strict", expires: session.expiresAt.getTime() / 1000 },
    ]);
    await page.goto("/ops");
    const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === "company_os_ops_session");
    expect(sessionCookie?.value).toBeTruthy();
    await expect(page).toHaveURL(/\/ops$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("mérite ton attention");
    await expect(page.getByRole("heading", { name: "Faire avancer l’entreprise avec toute l’équipe" })).toBeVisible();
    await expect(page.getByText("Ops local uniquement", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Lancer le bilan autonome" })).toBeEnabled();
    await expect(page.getByText("Voir le déroulement", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agents de la société" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "Travaux" })).toBeHidden();
    await expect(page.getByText("Journal d’activité", { exact: true })).toBeVisible();
    await expect(page.locator("#activity > details")).not.toHaveAttribute("open", "");
    await expect(page.getByRole("heading", { name: "Conversation avec le CEO" })).toBeVisible();
    await expect(page.getByText("Flux local", { exact: true })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`ops-overview-${testInfo.project.name}.png`), fullPage: true });

    const offlineNotice = page.getByRole("status").filter({ hasText: "Données réelles indisponibles." });
    await expect(offlineNotice).toBeVisible();
    await expect(offlineNotice).toContainText(/aucune donnée de remplacement n’est affichée/i);
    await expect(page.getByRole("navigation", { name: "Navigation du cockpit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Envoyer au CEO" })).toBeDisabled();

    const pause = page.getByRole("button", { name: "Pause générale" });
    const retry = page.getByRole("button", { name: "Réessayer" });
    for (const control of [pause, retry]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const dimensions = await page.evaluate(() => {
      const chat = document.querySelector<HTMLElement>('#ceo [aria-live="polite"]');
      const composer = document.querySelector<HTMLElement>("#ceo form");
      if (!chat || !composer) throw new Error("CEO_CHAT_LAYOUT_MISSING");
      const chatBox = chat.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      return {
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
        chatBottom: chatBox.bottom,
        composerTop: composerBox.top,
        chatOverflowY: getComputedStyle(chat).overflowY,
        composerPosition: getComputedStyle(composer).position,
      };
    });
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.chatBottom).toBeLessThanOrEqual(dimensions.composerTop + 1);
    expect(dimensions.chatOverflowY).toBe("auto");
    expect(dimensions.composerPosition).not.toBe("sticky");
    expect(consoleErrors.filter((message) => message.includes("same key"))).toEqual([]);

    await page.unroute("**/api/ops/snapshot");
    await page.route("**/api/ops/snapshot", async (route) => {
      const signalAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "app-server-stdio",
          project: { id: "company-os", displayName: "Company OS" },
          access: { actorId: "owner", role: "owner" },
          snapshot: {
            agents: [{
              id: "engineering", displayName: "Développement", role: "Architecture et réalisation locale",
              status: "waiting", currentTaskId: null, currentTaskTitle: null, modelProfile: null,
              heartbeatAt: signalAt, ownerStatus: "waiting",
            }, {
              id: "product", displayName: "Produit", role: "Priorités et besoins utilisateurs",
              status: "waiting", currentTaskId: null, currentTaskTitle: null, modelProfile: null,
              heartbeatAt: signalAt, ownerStatus: "waiting",
            }],
            agentActivity: [{
              agentId: "engineering",
              taskId: "11111111-1111-4111-8111-111111111111",
              runId: "22222222-2222-4222-8222-222222222222",
              taskTitle: "Rendre le suivi des agents compréhensible",
              intendedOutcome: "Le propriétaire comprend l’objectif, les décisions et le résultat sans ouvrir les journaux.",
              phase: "completed",
              activityKind: "real",
              currentStep: "Le travail est terminé et sa conclusion est enregistrée.",
              startedAt: signalAt,
              lastSignalAt: signalAt,
              modelProfile: "expert",
              conclusion: "La fiche d’activité présente maintenant les informations essentielles en français.",
              deliverables: ["Les contrôles locaux du contrat d’activité sont validés."],
              decisions: [{
                id: "33333333-3333-4333-8333-333333333333",
                kind: "verification_requested",
                label: "Une vérification indépendante a été demandée.",
                occurredAt: signalAt,
              }],
              events: [{
                sequence: "42",
                id: "44444444-4444-4444-8444-444444444444",
                eventType: "agent.run.completed",
                occurredAt: signalAt,
                tone: "success",
                detail: "La fiche d’activité présente maintenant les informations essentielles en français.",
              }],
            }, {
              agentId: "product", taskId: null, runId: null, taskTitle: null, intendedOutcome: null,
              phase: "idle", activityKind: "waiting", currentStep: "L’agent est disponible et n’a aucun travail actif.",
              startedAt: null, lastSignalAt: signalAt, modelProfile: null, conclusion: null,
              deliverables: [], decisions: [], events: [],
            }],
            tasks: [{
              id: "11111111-1111-4111-8111-111111111111",
              assignedAgentId: "engineering", verifierAgentId: "product",
              title: "Rendre le suivi des agents compréhensible",
              intendedOutcome: "Une fiche lisible sans journaux techniques.",
              completionSummary: "La fiche d’activité présente maintenant les informations essentielles en français.",
              riskClass: "read", status: "done", aggregateVersion: 1, updatedAt: signalAt, ownerStatus: "done",
            }],
            approvals: [],
            messages: [{
              id: "55555555-5555-4555-8555-555555555555", sender: "ceo",
              commandId: "66666666-6666-4666-8666-666666666666",
              safeBody: "Le suivi local est prêt à être consulté.", status: "completed", createdAt: signalAt,
            }],
            pause: { state: "running", reason: null, version: 1, changedBy: "owner", changedAt: signalAt },
            health: {
              database: { status: "connected", heartbeatAt: signalAt },
              supervisor: { component: "supervisor", status: "connected", detailCode: null, heartbeatAt: signalAt },
              bridge: { component: "bridge", status: "connected", detailCode: null, heartbeatAt: signalAt },
              codex: { component: "codex", status: "connected", detailCode: null, heartbeatAt: signalAt },
            },
            latestEvents: [{
              sequence: "42", id: "44444444-4444-4444-8444-444444444444",
              eventType: "agent.run.completed", aggregateType: "run",
              aggregateId: "22222222-2222-4222-8222-222222222222",
              safePayload: { taskId: "11111111-1111-4111-8111-111111111111", summary: "La fiche d’activité présente maintenant les informations essentielles en français." },
              occurredAt: signalAt,
            }],
            lastSequence: "42",
            commandVersion: 1,
          },
        }),
      });
    });
    await retry.click();
    await expect(offlineNotice).toBeHidden();
    await page.getByRole("button", { name: "Équipe", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agents de la société" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Voir l’activité de Développement — Terminé/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Voir l’activité de Produit — En attente/ })).toBeVisible();
    await page.getByRole("button", { name: /Voir l’activité de Développement — Terminé/ }).click();
    await expect(page.getByRole("dialog")).toContainText("Activité réelle enregistrée");
    await expect(page.getByRole("dialog")).toContainText("La fiche d’activité présente maintenant les informations essentielles en français.");
    await expect(page.getByRole("heading", { name: "Décisions importantes" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Livrables et éléments vérifiés" })).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("Les contrôles locaux du contrat d’activité sont validés.");
    await page.getByRole("button", { name: "Fermer l’activité de l’agent" }).click();

    await page.getByRole("button", { name: "Vidéos", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Studio vidéo" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Regarder le résultat" })).toBeVisible();
    await expect(page.getByLabel("Sujet de la vidéo")).toBeVisible();
    await expect(page.getByRole("button", { name: /Créer la vidéo|Une vidéo est déjà en production/ })).toBeVisible();
    const studioDimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(studioDimensions.content).toBeLessThanOrEqual(studioDimensions.viewport + 1);

    await page.getByRole("button", { name: "Santé", exact: true }).click();
    await expect(page.getByRole("heading", { name: "État du système local" })).toBeVisible();
    await expect(page.getByText("Flux local", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Conversation avec le CEO" })).toBeHidden();

    await page.getByRole("button", { name: "Système", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projets connectés" })).toBeVisible();
    await expect(page.locator("#integrations").getByRole("heading", { name: "Company OS", exact: true })).toBeVisible();
    await expect(page.getByText("Prête et vérifiée", { exact: true })).toBeVisible();
    await expect(page.getByText("Dossier analysé et accessible en écriture", { exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Progression de l’initialisation" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Résultat du premier bilan CEO" })).toContainText("Le projet possède une base claire");
    await expect(page.getByRole("list", { name: "Trois priorités proposées" })).toContainText("Prouver la qualité locale");
    await expect(page.getByText("Les contrôles locaux se terminent sans erreur.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Fournisseurs", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connexions & authentification" })).toBeVisible();
    await expect(page.getByText("Infrastructure réelle")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Postiz", exact: true })).toBeVisible();
    await page.getByText("Procédure complète de configuration", { exact: true }).click();
    await expect(page.getByText("1. Préparer le coffre local", { exact: true })).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath(`ops-${testInfo.project.name}.png`), fullPage: true });
  });
});
