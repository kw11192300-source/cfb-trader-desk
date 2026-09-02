"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import type { EdgeRow } from "@/lib/data";

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

function fmtSpread(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

const TOP_N = 15;

export default function EdgesTable({ rows, generatedAt }: { rows: EdgeRow[]; generatedAt: string | null }) {
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => rows, [rows]); // already sorted by |edge| in getEdges
  const visible = showAll ? sorted : sorted.slice(0, TOP_N);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
          <button
            onClick={() => setShowAll(false)}
            className={`rounded px-4 py-1.5 text-xs font-medium transition-colors ${
              !showAll ? "bg-accent text-background" : "text-muted hover:text-foreground"
            }`}
          >
            Top {TOP_N}
          </button>
          <button
            onClick={() => setShowAll(true)}
            className={`rounded px-4 py-1.5 text-xs font-medium transition-colors ${
              showAll ? "bg-accent text-background" : "text-muted hover:text-foreground"
            }`}
          >
            All ({rows.length})
          </button>
        </div>
        {generatedAt && (
          <span className="text-xs text-muted">
            Generated <LocalDateTime iso={generatedAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
          No edges computed yet — run <code className="text-foreground">python -m modeling.predict_week1</code>.
        </div>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                <th className="sticky top-0 left-0 z-20 w-10 bg-surface-raised px-3 py-3 font-medium text-right">#</th>
                <th className="sticky top-0 left-10 z-20 bg-surface-raised px-4 py-3 font-medium">Matchup</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Market</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Model</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium text-right">Edge</th>
                <th className="sticky top-0 z-10 border-l border-border bg-surface-raised px-4 py-3 font-medium">Pick</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => {
                const { prediction: p, game } = r;
                const edge = p.edge_spread ?? 0;
                const pickHome = edge > 0;
                const pickTeam = pickHome ? game.home_team : game.away_team;
                const pickLogo = pickHome ? r.homeLogo : r.awayLogo;
                return (
                  <tr key={p.game_id} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                    <td className="sticky left-0 z-10 bg-background px-3 py-2.5 text-right font-mono text-xs text-muted">{i + 1}</td>
                    <td className="sticky left-10 z-10 bg-background px-4 py-2.5 whitespace-nowrap">
                      <Link href={`/games/${game.id}`} className="group flex flex-col gap-1">
                        <div className="text-[10px] text-muted">
                          <LocalDateTime iso={game.start_date} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                        </div>
                        <div className="flex items-center gap-1.5 text-foreground group-hover:text-accent">
                          <TeamLogo src={r.awayLogo} alt={game.away_team} />
                          <span>{game.away_team}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-foreground group-hover:text-accent">
                          <TeamLogo src={r.homeLogo} alt={game.home_team} />
                          <span>{game.home_team}</span>
                        </div>
                      </Link>
                    </td>
                    <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">{fmtSpread(p.market_spread)}</td>
                    <td className="border-l border-border px-4 py-2.5 text-right font-mono text-foreground">{fmtSpread(p.predicted_margin)}</td>
                    <td className="border-l border-border px-4 py-2.5 text-right font-mono font-medium text-accent">{Math.abs(edge).toFixed(1)}</td>
                    <td className="border-l border-border px-4 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 text-foreground">
                        <TeamLogo src={pickLogo} alt={pickTeam} />
                        <span>{pickTeam}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
