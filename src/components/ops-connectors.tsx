"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, CheckCircle2, ChevronDown, ExternalLink, KeyRound, LoaderCircle, PlugZap, RefreshCw, ShieldCheck, Unplug, XCircle } from "lucide-react";

type ConnectorStatus = "not_connected" | "connected" | "expired" | "error";
type Field = { key: string; label: string; placeholder: string; secret?: boolean; required?: boolean; type?: "text" | "url" };
type Connector = {
  id: string;
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
  configFields: Field[];
  credentialFields: Field[];
};

const statusMeta: Record<ConnectorStatus, { label: string; className: string }> = {
  connected: { label: "Connecté", className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200" },
  not_connected: { label: "Non connecté", className: "border-slate-500/25 bg-slate-500/10 text-slate-300" },
  expired: { label: "Expiré", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" },
  error: { label: "Erreur", className: "border-rose-400/25 bg-rose-400/10 text-rose-200" },
};

export function OpsConnectors() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [busy, setBusy] = useState<string | null>("load");
  const callbackOrigin = typeof window === "undefined" ? "http://localhost:3020" : window.location.origin;
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy((current) => current ?? "load");
    try {
      const response = await fetch("/api/ops/connectors", { cache: "no-store" });
      if (!response.ok) throw new Error("CONNECTORS_UNAVAILABLE");
      const data = await response.json() as { connectors: Connector[] };
      setConnectors(data.connectors);
      setNotice(null);
    } catch {
      setNotice("Impossible de charger les connecteurs réels. Vérifie PostgreSQL et la migration 009.");
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const groups = useMemo(() => Object.entries(Object.groupBy(connectors, (connector) => connector.category)), [connectors]);

  async function mutate(connector: Connector, action: "save" | "test" | "disconnect" | "oauth", values?: {
    publicConfig: Record<string, string>;
    credentials: Record<string, string>;
  }) {
    setBusy(`${connector.id}:${action}`);
    setNotice(null);
    try {
      const endpoint = action === "test"
        ? `/api/ops/connectors/${connector.id}/test`
        : action === "oauth"
          ? `/api/ops/connectors/${connector.id}/oauth/start`
          : `/api/ops/connectors/${connector.id}`;
      const response = await fetch(endpoint, {
        method: action === "disconnect" ? "DELETE" : action === "save" ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          "x-company-os-csrf": readCookie("company_os_ops_csrf"),
        },
        body: action === "save" ? JSON.stringify(values) : undefined,
      });
      const data = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "CONNECTOR_ACTION_FAILED");
      if (data.authorizationUrl) {
        window.location.assign(data.authorizationUrl);
        return;
      }
      setNotice(action === "test" ? `${connector.name} a répondu correctement.` : `${connector.name} a été mis à jour.`);
      await load();
    } catch (error) {
      setNotice(`Échec ${connector.name} : ${error instanceof Error ? error.message : "CONNECTOR_ACTION_FAILED"}.`);
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="connectors-title" className="rounded-2xl border border-white/[0.08] bg-[#10151e] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.22)] md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-500"><PlugZap className="size-4" />Infrastructure réelle</p>
          <h2 id="connectors-title" className="mt-2 text-2xl font-semibold tracking-tight text-white md:text-3xl">Connexions & authentification</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Les secrets sont chiffrés dans PostgreSQL et persistent après redémarrage. Aucun jeton n’est affiché ni renvoyé au navigateur.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={busy !== null} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 px-4 text-sm font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-50">
          <RefreshCw className={`size-4 ${busy === "load" ? "animate-spin" : ""}`} /> Actualiser
        </button>
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-sky-400/20 bg-sky-400/[0.06] p-4 text-sm leading-6 text-sky-100">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-sky-300" />
        <p>Tester une connexion effectue uniquement une lecture d’identité ou de profil. Publier, répondre, dépenser ou lancer une campagne reste soumis à une approbation distincte.</p>
      </div>

      {notice && <p role="status" className="mt-4 rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-sm text-slate-200">{notice}</p>}

      <ProviderSetupGuide callbackOrigin={callbackOrigin} />

      <div className="mt-7 space-y-8">
        {groups.map(([category, items]) => (
          <section key={category}>
            <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-400">{category}</h2>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {items?.map((connector) => (
                <ConnectorCard
                  key={`${connector.id}:${connector.status}:${connector.lastTestedAt ?? "never"}:${connector.hasCredentials}`}
                  connector={connector}
                  busy={busy?.startsWith(`${connector.id}:`) ?? false}
                  onAction={mutate}
                />
              ))}
            </div>
          </section>
        ))}
        {busy === null && connectors.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 p-6 text-sm text-slate-400">Aucun connecteur enregistré.</div>
        )}
      </div>
    </section>
  );
}

const providerSteps = (callbackOrigin: string) => [
  {
    title: "0. Séparation obligatoire : Ops local, SaaS public",
    body: (
      <div className="space-y-2">
        <p><strong className="text-white">Ops reste toujours sur localhost.</strong> Il n’est jamais déployé sur Railway, Vercel ou un autre hébergeur.</p>
        <p>Seuls les services du SaaS client peuvent être publiés. Leurs bases, clés, callbacks et variables restent séparés du coffre local d’Ops.</p>
        <p>Si un OAuth exige une URL publique, le callback doit vivre dans le backend du SaaS concerné — jamais dans une instance publique d’Ops.</p>
      </div>
    ),
  },
  {
    title: "1. Préparer le coffre local",
    body: (
      <>
        <p>À exécuter une seule fois depuis le dépôt :</p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-white/10 bg-black/25 p-3 text-xs leading-6 text-amber-100"><code>npm run ops:ensure-connectors{"\n"}npm run ops:migrate</code></pre>
        <p className="mt-3">La clé du coffre reste dans <code className="text-slate-200">.env.local</code>. Ne la supprime pas et ne la remplace pas tant que des identifiants sont enregistrés.</p>
      </>
    ),
  },
  {
    title: "2. Enregistrer les retours OAuth",
    body: (
      <ul className="space-y-2">
        <li><strong className="text-white">Meta :</strong> <code className="break-all text-sky-200">{callbackOrigin}/api/ops/connectors/meta/oauth/callback</code></li>
        <li><strong className="text-white">Reddit :</strong> <code className="break-all text-sky-200">{callbackOrigin}/api/ops/connectors/reddit/oauth/callback</code></li>
        <li>Ajoute ces URL dans la console développeur du fournisseur avant de cliquer sur <strong className="text-white">Connecter avec OAuth</strong>.</li>
      </ul>
    ),
  },
  {
    title: "3. Connecter et vérifier un fournisseur",
    body: (
      <ol className="list-decimal space-y-2 pl-5">
        <li>Renseigne les champs publics et le secret dans la carte correspondante.</li>
        <li>Clique sur <strong className="text-white">Enregistrer</strong>. Un champ secret laissé vide conserve la valeur existante.</li>
        <li>Pour Meta ou Reddit, termine ensuite le parcours OAuth.</li>
        <li>Clique sur <strong className="text-white">Tester</strong> : seule une lecture d’identité ou de profil est exécutée.</li>
      </ol>
    ),
  },
  {
    title: "4. Configurer les fournisseurs du produit",
    body: (
      <div className="grid gap-3 sm:grid-cols-2">
        <SetupItem name="PostgreSQL" text="Base privée, TLS, rôle applicatif minimal, rôle de migration distinct et restauration PITR vérifiée." />
        <SetupItem name="Cloudflare R2" text="Compartiment privé, identifiants limités, URL présignées courtes et suppression des sources sous 24 heures." />
        <SetupItem name="Stripe" text="Produits et prix en mode test, webhook signé, montants choisis côté serveur et aucune donnée de devis dans les métadonnées." />
        <SetupItem name="OpenAI" text="Projet dédié, budget dur, clé uniquement dans le worker, sortie structurée, store:false et fixtures anonymisées." />
        <SetupItem name="Resend" text="Sous-domaine vérifié, clés séparées par environnement, lien de rapport à usage unique et idempotence." />
        <SetupItem name="Railway — SaaS seulement" text="Services web, worker et parser du SaaS séparés. Aucun cockpit, superviseur ou secret Ops n’est déployé." />
      </div>
    ),
  },
  {
    title: "5. Valider avant toute ouverture",
    body: (
      <ul className="space-y-2">
        <li>✓ Aucun secret dans Git, le navigateur, les journaux ou la mémoire des agents.</li>
        <li>✓ Import, aperçu, paiement de test, rapport, email contrôlé et purge vérifiés de bout en bout.</li>
        <li>✓ Webhooks rejoués ou invalides incapables d’accorder un accès.</li>
        <li>✓ Restauration PostgreSQL chronométrée et suppression des sources avant 24 heures.</li>
        <li>✓ Publicité désactivée et budget à zéro jusqu’à une approbation distincte.</li>
      </ul>
    ),
  },
];

function ProviderSetupGuide({ callbackOrigin }: { callbackOrigin: string }) {
  return (
    <details className="group mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.035]">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 [&::-webkit-details-marker]:hidden md:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-amber-300/10 text-amber-200"><BookOpen className="size-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="block">Procédure complète de configuration</span>
          <span className="mt-0.5 block text-xs font-normal text-slate-400">Ops local uniquement · déploiement réservé aux SaaS connectés</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-white/[0.07] p-4 md:p-5">
        <div className="space-y-3">
          {providerSteps(callbackOrigin).map((step) => (
            <details key={step.title} className="group/step rounded-xl border border-white/[0.08] bg-[#0b1018]">
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-semibold text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1">{step.title}</span>
                <ChevronDown className="size-4 shrink-0 text-slate-500 transition-transform group-open/step:rotate-180" />
              </summary>
              <div className="border-t border-white/[0.07] px-4 py-4 text-sm leading-6 text-slate-400">{step.body}</div>
            </details>
          ))}
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">Le guide détaillé et les liens officiels restent également disponibles dans <code>docs/provider-setup.md</code>.</p>
      </div>
    </details>
  );
}

function SetupItem({ name, text }: { name: string; text: string }) {
  return <div className="rounded-xl border border-white/[0.07] bg-black/15 p-3"><p className="font-semibold text-white">{name}</p><p className="mt-1 text-xs leading-5 text-slate-400">{text}</p></div>;
}

function ConnectorCard({
  connector,
  busy,
  onAction,
}: {
  connector: Connector;
  busy: boolean;
  onAction: (connector: Connector, action: "save" | "test" | "disconnect" | "oauth", values?: { publicConfig: Record<string, string>; credentials: Record<string, string> }) => Promise<void>;
}) {
  const [publicConfig, setPublicConfig] = useState(connector.publicConfig);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const meta = statusMeta[connector.status];
  const canConnectOAuth = connector.authKind === "oauth2" && connector.hasCredentials;

  return (
    <article className="rounded-2xl border border-white/[0.08] bg-[#0b1018] p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-white">{connector.name}</h3>
          <p className="mt-1 text-sm leading-5 text-slate-400">{connector.description}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${meta.className}`}>
          {connector.status === "connected" ? <CheckCircle2 className="size-3.5" /> : connector.status === "error" ? <XCircle className="size-3.5" /> : <KeyRound className="size-3.5" />}
          {meta.label}
        </span>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {connector.configFields.map((field) => (
          <FieldInput key={field.key} field={field} value={publicConfig[field.key] ?? ""} onChange={(value) => setPublicConfig((current) => ({ ...current, [field.key]: value }))} />
        ))}
        {connector.credentialFields.map((field) => (
          <FieldInput key={field.key} field={field} value={credentials[field.key] ?? ""} onChange={(value) => setCredentials((current) => ({ ...current, [field.key]: value }))} saved={connector.hasCredentials} />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>{connector.hasCredentials ? "Identifiants chiffrés enregistrés" : "Aucun identifiant enregistré"}</span>
        {connector.lastTestedAt && <span>Testé {new Date(connector.lastTestedAt).toLocaleString("fr-FR")}</span>}
        {connector.tokenExpiresAt && <span>Expiration {new Date(connector.tokenExpiresAt).toLocaleString("fr-FR")}</span>}
        {connector.lastErrorCode && <span className="text-rose-300">{connector.lastErrorCode}</span>}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/[0.07] pt-4">
        <button type="button" disabled={busy} onClick={() => void onAction(connector, "save", { publicConfig, credentials })} className="min-h-11 rounded-xl bg-amber-300 px-4 text-sm font-bold text-slate-950 hover:bg-amber-200 disabled:opacity-50">Enregistrer</button>
        {connector.authKind === "oauth2" && (
          <button type="button" disabled={busy || !canConnectOAuth} onClick={() => void onAction(connector, "oauth")} className="min-h-11 rounded-xl border border-sky-400/25 bg-sky-400/10 px-4 text-sm font-semibold text-sky-200 hover:bg-sky-400/15 disabled:opacity-40">Connecter avec OAuth</button>
        )}
        <button type="button" disabled={busy || !connector.hasCredentials} onClick={() => void onAction(connector, "test")} className="min-h-11 rounded-xl border border-white/10 px-4 text-sm font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-40">{busy ? <LoaderCircle className="mx-auto size-4 animate-spin" /> : "Tester"}</button>
        {connector.hasCredentials && (
          <button type="button" disabled={busy} onClick={() => window.confirm(`Déconnecter ${connector.name} et supprimer ses identifiants chiffrés ?`) && void onAction(connector, "disconnect")} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-400/20 px-3 text-sm font-semibold text-rose-200 hover:bg-rose-400/10 disabled:opacity-40"><Unplug className="size-4" /> Déconnecter</button>
        )}
        <a href={connector.docsUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex min-h-11 items-center gap-2 px-2 text-sm font-semibold text-slate-400 hover:text-white">Documentation <ExternalLink className="size-4" /></a>
      </div>
    </article>
  );
}

function FieldInput({ field, value, onChange, saved = false }: { field: Field; value: string; onChange: (value: string) => void; saved?: boolean }) {
  return (
    <label className="min-w-0 text-xs font-semibold text-slate-300">
      {field.label}{field.required ? " *" : ""}
      <input
        type={field.secret ? "password" : field.type ?? "text"}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.secret && saved ? "Laisser vide pour conserver" : field.placeholder}
        className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-[#070b11] px-3 text-base font-normal text-white placeholder:text-slate-600 focus:border-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-300/20"
      />
    </label>
  );
}

function readCookie(name: string): string {
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : "";
}
