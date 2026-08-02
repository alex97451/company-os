"use client";

import { FormEvent, useState } from "react";
import { Database, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";

export function OpsLogin({ configured }: { configured: boolean }) {
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/ops/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        setError(response.status === 429 ? "Trop de tentatives. Réessaie dans 15 minutes." : "Ce mot de passe n’a pas été accepté.");
        return;
      }
      window.location.assign("/ops");
    } catch {
      setError("Le service de contrôle local est indisponible.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-[100svh] place-items-center overflow-x-clip bg-[#070a10] px-4 py-8 text-slate-100 sm:px-6">
      <section
        className="grid w-full max-w-4xl overflow-hidden rounded-3xl border border-white/10 bg-[#0f141d] shadow-[0_32px_100px_rgba(0,0,0,0.42)] lg:grid-cols-[1.05fr_0.95fr]"
      >
        <div className="border-b border-white/[0.08] bg-[linear-gradient(145deg,rgba(251,191,36,0.10),rgba(15,20,29,0.2)_48%)] p-6 sm:p-8 lg:border-b-0 lg:border-r lg:p-10">
          <span className="grid size-12 place-items-center rounded-2xl border border-amber-300/25 bg-amber-300/10 text-amber-200">
            <LockKeyhole aria-hidden="true" className="size-6" />
          </span>
          <p className="mt-8 text-xs font-bold uppercase tracking-[0.18em] text-amber-300">Accès sécurisé au réseau local</p>
          <h1 className="mt-3 max-w-md text-[clamp(2rem,1.65rem+1.4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-white">
            Pilote l’entreprise depuis un seul endroit.
          </h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-slate-400">
            Dialogue avec le CEO, supervision des travaux et décisions sensibles dans un environnement privé.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-black/10 p-3 text-sm text-slate-300">
              <Database aria-hidden="true" className="size-4 text-emerald-300" />
              Données conservées localement
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-black/10 p-3 text-sm text-slate-300">
              <ShieldCheck aria-hidden="true" className="size-4 text-emerald-300" />
              Actions externes désactivées
            </div>
          </div>
        </div>

        <div className="p-6 sm:p-8 lg:grid lg:content-center lg:p-10">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Command Center</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Authentification</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Connecte-toi comme propriétaire ou avec le compte opérateur autorisé.
          </p>
          {!configured ? (
            <div className="mt-6 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm leading-6 text-amber-100" role="status">
              L’accès propriétaire n’est pas configuré. Ajoute <code>OPS_OWNER_PASSWORD</code> et <code>OPS_SESSION_SECRET</code> à l’environnement local, puis redémarre l’application.
            </div>
          ) : (
            <form className="mt-7" onSubmit={submit}>
              <label className="text-sm font-semibold text-slate-200" htmlFor="ops-username">Identifiant</label>
              <input
                autoComplete="username"
                className="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-[#090d14] px-4 py-3 text-base text-white outline-none transition focus:border-amber-300/60 focus:ring-4 focus:ring-amber-300/10"
                id="ops-username"
                maxLength={32}
                onChange={(event) => setUsername(event.target.value)}
                required
                value={username}
              />
              <label className="mt-4 block text-sm font-semibold text-slate-200" htmlFor="owner-password">Mot de passe</label>
              <div className="relative mt-2">
                <KeyRound aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-500" />
                <input
                  autoComplete="current-password"
                  className="min-h-12 w-full rounded-xl border border-white/10 bg-[#090d14] py-3 pl-12 pr-4 text-base text-white outline-none transition focus:border-amber-300/60 focus:ring-4 focus:ring-amber-300/10"
                  id="owner-password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </div>
              {error ? <p className="mt-3 text-sm text-red-300" role="alert">{error}</p> : null}
              <button
                className="mt-5 flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 text-sm font-bold text-[#181008] transition hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300/40 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={loading}
                type="submit"
              >
                {loading ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <LockKeyhole aria-hidden="true" className="size-4" />}
                {loading ? "Connexion…" : "Ouvrir le cockpit"}
              </button>
            </form>
          )}
          <p className="mt-6 text-xs leading-5 text-slate-500">Cette route privée est absente du parcours client.</p>
        </div>
      </section>
    </main>
  );
}
