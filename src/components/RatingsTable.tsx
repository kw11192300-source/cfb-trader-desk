"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import type { PowerRatingRow } from "@/lib/data";

function TeamLogo({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return <div className="h-7 w-7 shrink-0 rounded-full bg-white/90 ring-1 ring-black/10" />;
  }
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/90 ring-1 ring-black/10">
      <Image src={src} alt={alt} width={22} height={22} className="h-[22px] w-[22px] object-contain" unoptimized />
    </div>
  );
}

function fmt(n: number | null, decimals: number = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}`;
}

type SortKey = "overall" | "scoring_off" | "scoring_def" | "efficiency_off" | "efficiency_def";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "overall", label: "Overall" },
  { key: "scoring_off", label: "Off (scoring)" },
  { key: "scoring_def", label: "Def (scoring)" },
  { key: "efficiency_off", label: "Off (efficiency)" },
  { key: "efficiency_def", label: "Def (efficiency)" },
];

type Classification = "all" | "fbs" | "fcs";

export default function RatingsTable({ rows }: { rows: PowerRatingRow[] }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("overall");
  const [classFilter, setClassFilter] = useState<Classification>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows;
    if (classFilter !== "all") {
      out = out.filter((r) => (r.classification ?? "").toLowerCase() === classFilter);
    }
    if (q !== "") {
      out = out.filter((r) => r.team.toLowerCase().includes(q));
    }
    return [...out].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return bv - av;
    });
  }, [rows, query, sortKey, classFilter]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
          {(["all", "fbs", "fcs"] as Classification[]).map((c) => (
            <button
              key={c}
              onClick={() => setClassFilter(c)}
              className={`rounded px-4 py-1.5 text-xs font-medium uppercase transition-colors ${
                classFilter === c ? "bg-accent text-background" : "text-muted hover:text-foreground"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              Sort: {o.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by team…"
          className="w-56 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {query.trim() !== "" && (
          <span className="text-xs text-muted">
            {filtered.length} match{filtered.length === 1 ? "" : "es"}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">No ratings available yet.</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">No teams match &quot;{query}&quot;.</div>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                <th className="sticky top-0 left-0 z-20 w-10 bg-surface-raised px-3 py-3 font-medium text-right">#</th>
                <th className="sticky top-0 left-10 z-20 bg-surface-raised px-4 py-3 font-medium">Team</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Overall</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Off (scoring)</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Def (scoring)</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Off (eff.)</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Def (eff.)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.team_id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                  <td className="sticky left-0 z-10 bg-background px-3 py-2.5 text-right font-mono text-xs text-muted">{i + 1}</td>
                  <td className="sticky left-10 z-10 bg-background px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <TeamLogo src={r.logo_url} alt={r.team} />
                      <span className="text-foreground">{r.team}</span>
                      {r.classification && (
                        <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] uppercase text-muted">{r.classification}</span>
                      )}
                    </div>
                  </td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">{fmt(r.overall)}</td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">{fmt(r.scoring_off)}</td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">{fmt(r.scoring_def)}</td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">{fmt(r.efficiency_off, 2)}</td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">{fmt(r.efficiency_def, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
