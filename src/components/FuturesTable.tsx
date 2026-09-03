"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import type { SeasonFutureRow } from "@/lib/data";

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

function pct(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtEdge(n: number | null): string {
  if (n === null || n === undefined) return "—";
  const pts = n * 100;
  return pts > 0 ? `+${pts.toFixed(1)}` : pts.toFixed(1);
}

type SortKey = "edge" | "championship_prob" | "playoff_prob" | "proj_wins";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "edge", label: "Edge vs market" },
  { key: "championship_prob", label: "Title probability" },
  { key: "playoff_prob", label: "Playoff probability" },
  { key: "proj_wins", label: "Projected wins" },
];

export default function FuturesTable({ rows }: { rows: SeasonFutureRow[] }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("edge");
  const [marketOnly, setMarketOnly] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows;
    if (marketOnly) out = out.filter((r) => r.edge !== null);
    if (q !== "") out = out.filter((r) => r.team.toLowerCase().includes(q));
    return [...out].sort((a, b) => {
      if (sortKey === "edge") {
        const av = a.edge !== null ? Math.abs(a.edge) : -1;
        const bv = b.edge !== null ? Math.abs(b.edge) : -1;
        return bv - av;
      }
      return b[sortKey] - a[sortKey];
    });
  }, [rows, query, sortKey, marketOnly]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
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
        <button
          onClick={() => setMarketOnly((v) => !v)}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            marketOnly ? "border-accent bg-accent text-background" : "border-border text-muted hover:text-foreground"
          }`}
        >
          Market-priced only
        </button>
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
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
          No futures projections yet — run <code className="text-foreground">python -m modeling.season_sim</code>.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">No teams match &quot;{query}&quot;.</div>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                <th className="sticky top-0 left-0 z-20 w-10 bg-surface-raised px-3 py-3 font-medium text-right">#</th>
                <th className="sticky top-0 left-10 z-20 bg-surface-raised px-4 py-3 font-medium">Team</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Proj. wins</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Playoff %</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Title % (model)</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Title % (market)</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Edge (pts)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.team} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                  <td className="sticky left-0 z-10 bg-background px-3 py-2.5 text-right font-mono text-xs text-muted">{i + 1}</td>
                  <td className="sticky left-10 z-10 bg-background px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <TeamLogo src={r.logo} alt={r.team} />
                      <span className="text-foreground">{r.team}</span>
                    </div>
                  </td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">
                    {r.proj_wins.toFixed(1)} <span className="text-muted">±{r.win_total_std.toFixed(1)}</span>
                  </td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">{pct(r.playoff_prob)}</td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">{pct(r.championship_prob)}</td>
                  <td className="border-l border-border px-4 py-2.5 text-right font-mono text-muted">{pct(r.market_championship_prob)}</td>
                  <td
                    className={`border-l border-border px-4 py-2.5 text-right font-mono font-medium ${
                      r.edge === null ? "text-muted" : r.edge > 0 ? "text-up" : "text-down"
                    }`}
                  >
                    {fmtEdge(r.edge)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
