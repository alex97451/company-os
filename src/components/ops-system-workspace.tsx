"use client";

import { useEffect, useState } from "react";
import { Boxes, PlugZap } from "lucide-react";
import { OpsConnectors } from "@/components/ops-connectors";
import { OpsProjects } from "@/components/ops-projects";

type SystemTab = "projects" | "connectors";

export function OpsSystemWorkspace() {
  const [tab, setTab] = useState<SystemTab>("projects");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).has("connector")) setTab("connectors");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div>
      <div className="mb-4 flex w-full max-w-md rounded-xl border border-white/[0.08] bg-[#0b1018] p-1" aria-label="Configuration du système">
        <SystemTabButton active={tab === "projects"} onClick={() => setTab("projects")} icon={<Boxes className="size-4" />} label="Projets" />
        <SystemTabButton active={tab === "connectors"} onClick={() => setTab("connectors")} icon={<PlugZap className="size-4" />} label="Fournisseurs" />
      </div>
      {tab === "projects" ? <OpsProjects /> : <OpsConnectors />}
    </div>
  );
}

function SystemTabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors ${active ? "bg-amber-300 text-slate-950" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}>{icon}{label}</button>;
}
