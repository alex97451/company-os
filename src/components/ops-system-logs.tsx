"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Database,
  RefreshCw,
  Search,
  Server,
  Terminal,
  XCircle,
} from "lucide-react";

type LogEntry = {
  timestamp: string;
  source: "supervisor" | "system" | "runtime";
  level: "info" | "warn" | "error";
  message: string;
  code?: string;
  raw?: string;
};

type DbEvent = {
  sequence: string;
  id: string;
  eventType: string;
  payload: unknown;
  occurredAt: string;
};

type RuntimeStatus = {
  id: string;
  displayName: string;
  status: string;
  lastErrorCode: string | null;
  lastHeartbeatAt: string | null;
};

type LogsPayload = {
  logs: LogEntry[];
  events: DbEvent[];
  runtimes: RuntimeStatus[];
};

export function OpsSystemLogs() {
  const [data, setData] = useState<LogsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterTab, setFilterTab] = useState<"all" | "supervisor" | "events" | "errors">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/logs", { cache: "no-store" });
      if (!res.ok) throw new Error("LOGS_FETCH_FAILED");
      const json = (await res.json()) as LogsPayload;
      setData(json);
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "LOGS_UNAVAILABLE");
    }
  }, []);

  const handleManualRefresh = async () => {
    setLoading(true);
    await fetchLogs();
    setLoading(false);
  };

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void fetchLogs(), 0);
    const interval = window.setInterval(() => void fetchLogs(), 4_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [fetchLogs]);

  const items = useMemo(() => {
    if (!data) return [];
    const list: Array<{
      id: string;
      timestamp: string;
      type: "log" | "event";
      level: "info" | "warn" | "error";
      title: string;
      details: string;
      raw: string;
    }> = [];

    // Add supervisor log entries
    data.logs.forEach((log, index) => {
      list.push({
        id: `log-${index}-${log.timestamp}`,
        timestamp: log.timestamp,
        type: "log",
        level: log.level,
        title: log.code ? `[SUPERVISOR] ${log.code}` : "[SUPERVISOR LOG]",
        details: log.message,
        raw: log.raw ?? log.message,
      });
    });

    // Add database events
    data.events.forEach((evt) => {
      const isErr = /fail|error|reject|block|oversize/i.test(evt.eventType);
      list.push({
        id: `evt-${evt.id}-${evt.sequence}`,
        timestamp: evt.occurredAt,
        type: "event",
        level: isErr ? "error" : "info",
        title: `[EVENT #${evt.sequence}] ${evt.eventType}`,
        details: JSON.stringify(evt.payload ?? {}),
        raw: `${evt.eventType}: ${JSON.stringify(evt.payload)}`,
      });
    });

    // Sort descending by timestamp
    return list.sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
  }, [data]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (filterTab === "supervisor" && item.type !== "log") return false;
      if (filterTab === "events" && item.type !== "event") return false;
      if (filterTab === "errors" && item.level !== "error") return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          item.title.toLowerCase().includes(q) ||
          item.details.toLowerCase().includes(q) ||
          item.raw.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [items, filterTab, searchQuery]);

  const copyToClipboard = () => {
    const text = filteredItems.map((i) => `[${i.level.toUpperCase()}] ${i.title}: ${i.details}`).join("\n");
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0c1017] p-5 md:p-6 shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] pb-4">
        <div>
          <p className="flex items-center gap-2 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-emerald-400">
            <Terminal className="size-4" />
            Diagnostics & Logs Système
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-white md:text-2xl">
            Journal d’exécution local
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Inspectez les sorties du superviseur, les erreurs de runtime et les événements PostgreSQL en temps réel.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            disabled={loading}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/[0.08] disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin text-amber-300" : ""}`} />
            Rafraîchir
          </button>
          <button
            type="button"
            onClick={copyToClipboard}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/[0.08]"
          >
            <Copy className="size-3.5" />
            {copied ? "Copié !" : "Copier"}
          </button>
        </div>
      </div>

      {notice && (
        <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-200">
          {notice}
        </div>
      )}

      {/* Runtimes status banner if any has error */}
      {data?.runtimes && data.runtimes.some((r) => r.lastErrorCode) && (
        <div className="mt-4 space-y-2">
          {data.runtimes
            .filter((r) => r.lastErrorCode)
            .map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200"
              >
                <div className="flex items-center gap-2">
                  <XCircle className="size-4 shrink-0 text-rose-400" />
                  <span>
                    Projet <strong>{r.displayName}</strong> ({r.id}) : erreur <code>{r.lastErrorCode}</code>
                  </span>
                </div>
                <span className="text-[0.7rem] opacity-75">
                  {r.lastHeartbeatAt ? new Date(r.lastHeartbeatAt).toLocaleTimeString("fr-FR") : "Hors ligne"}
                </span>
              </div>
            ))}
        </div>
      )}

      {/* Filters and search */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/10 bg-[#070b10] p-1">
          <button
            type="button"
            onClick={() => setFilterTab("all")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              filterTab === "all" ? "bg-amber-400/20 text-amber-200" : "text-slate-400 hover:text-white"
            }`}
          >
            Tous ({items.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterTab("supervisor")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              filterTab === "supervisor" ? "bg-amber-400/20 text-amber-200" : "text-slate-400 hover:text-white"
            }`}
          >
            <Server className="size-3" />
            Superviseur
          </button>
          <button
            type="button"
            onClick={() => setFilterTab("events")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              filterTab === "events" ? "bg-amber-400/20 text-amber-200" : "text-slate-400 hover:text-white"
            }`}
          >
            <Database className="size-3" />
            Événements DB
          </button>
          <button
            type="button"
            onClick={() => setFilterTab("errors")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              filterTab === "errors" ? "bg-rose-500/20 text-rose-300" : "text-slate-400 hover:text-white"
            }`}
          >
            <AlertTriangle className="size-3 text-rose-400" />
            Erreurs ({items.filter((i) => i.level === "error").length})
          </button>
        </div>

        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filtrer les logs (ex: protocol, error...)"
            className="w-full rounded-xl border border-white/10 bg-[#070b10] py-2 pl-9 pr-3 text-xs text-white placeholder:text-slate-600 focus:border-amber-300 focus:outline-none"
          />
        </div>
      </div>

      {/* Log Output Console */}
      <div className="mt-4 max-h-[500px] min-h-[220px] overflow-y-auto rounded-xl border border-white/10 bg-[#05080e] p-4 font-mono text-xs leading-6 text-slate-300 [scrollbar-gutter:stable]">
        {filteredItems.length === 0 ? (
          <p className="text-center text-slate-600 py-8">Aucune ligne de journal ne correspond aux filtres actuels.</p>
        ) : (
          filteredItems.map((item) => (
            <div
              key={item.id}
              className={`group flex items-start gap-3 border-b border-white/[0.04] py-1.5 last:border-0 hover:bg-white/[0.02] ${
                item.level === "error" ? "text-rose-300 bg-rose-500/[0.03]" : ""
              }`}
            >
              <span className="shrink-0 select-none text-[0.68rem] text-slate-600">
                {new Date(item.timestamp).toLocaleTimeString("fr-FR")}
              </span>

              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider ${
                  item.level === "error"
                    ? "border border-rose-500/30 bg-rose-500/20 text-rose-300"
                    : item.level === "warn"
                    ? "border border-amber-500/30 bg-amber-500/20 text-amber-200"
                    : "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                }`}
              >
                {item.level}
              </span>

              <div className="min-w-0 flex-1 break-words">
                <span className="font-semibold text-slate-200">{item.title}</span>{" "}
                <span className="text-slate-400">{item.details}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
