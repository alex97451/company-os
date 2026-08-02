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

    await page.getByRole("button", { name: "Santé", exact: true }).click();
    await expect(page.getByRole("heading", { name: "État du système local" })).toBeVisible();
    await expect(page.getByText("Flux local", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Conversation avec le CEO" })).toBeHidden();

    await page.getByRole("button", { name: "Système", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Projets connectés" })).toBeVisible();
    await expect(page.locator("#integrations").getByRole("heading", { name: "Company OS", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Fournisseurs", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connexions & authentification" })).toBeVisible();
    await expect(page.getByText("Infrastructure réelle")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Postiz", exact: true })).toBeVisible();
    await page.getByText("Procédure complète de configuration", { exact: true }).click();
    await expect(page.getByText("1. Préparer le coffre local", { exact: true })).toBeVisible();

    const pause = page.getByRole("button", { name: "Pause générale" });
    const retry = page.getByRole("button", { name: "Réessayer" });
    for (const control of [pause, retry]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await page.screenshot({ path: testInfo.outputPath(`ops-${testInfo.project.name}.png`), fullPage: true });
  });
});
