"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { SharpMoneyRow } from "@/lib/data";

function TeamLogo({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return <div className="h-6 w-6 shrink-0 rounded-full bg-surface-raised" />;
  return <Image src={src} alt={alt} width={24} height={24} className="h-6 w-6 shrink-0 object-contain" unoptimized />;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

const SOURCE_LABEL: Record<string, string> = { kalshi: "Kalshi", polymarket: "Polymarket" };

export default function SharpMoneyTable({ rows }: { rows: SharpMoneyRow[] }) {
  const [minVolume, setMinVolume] = useState(100);

  const filtered = useMemo(() => rows.filter((r) => (r.volume ?? 0) >= minVolume), [rows, minVolume]);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">
        No overlapping prediction-market + sportsbook data yet — run{" "}
        <code className="text-foreground">python -m cfbd_ingest.sync_prediction_markets</code>.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted">Min. volume</span>
        <div className="flex gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
          {[0, 100, 1000, 10000].map((v) => (
            <button
              key={v}
              onClick={() => setMinVolume(v)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                minVolume === v ? "bg-accent text-background" : "text-muted hover:text-foreground"
              }`}
            >
              {v === 0 ? "Any" : v.toLocaleString()}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">{filtered.length} of {rows.length} shown</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-3 font-medium">Matchup</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">PM likes</th>
              <th className="px-4 py-3 text-right font-medium">Book (de-vig)</th>
              <th className="px-4 py-3 text-right font-medium">Edge</th>
              <th className="px-4 py-3 text-right font-medium">Volume</th>
              <th className="px-4 py-3 text-right font-medium">Liquidity</th>
              <th className="px-4 py-3 text-right font-medium">Books</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const team = r.pmLikesHome ? r.game.home_team : r.game.away_team;
              const logo = r.pmLikesHome ? r.homeLogo : r.awayLogo;
              const pmProb = r.pmLikesHome ? r.pmHomeProb : r.pmAwayProb;
              const bookProb = r.pmLikesHome ? r.bookHomeProb : r.bookAwayProb;
              return (
                <tr key={`${r.game.id}-${r.source}`} className="border-t border-border odd:bg-surface/50 hover:bg-surface-raised">
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <Link href={`/games/${r.game.id}`} className="text-foreground hover:text-accent">
                      {r.game.away_team} @ {r.game.home_team}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-muted">{SOURCE_LABEL[r.source] ?? r.source}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <TeamLogo src={logo} alt={team} />
                      <span className="text-foreground">{team}</span>
                      <span className="font-mono text-accent">{pct(pmProb)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{pct(bookProb)}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-medium text-accent">{r.edge.toFixed(1)}pp</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{r.volume !== null ? Math.round(r.volume).toLocaleString() : "—"}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{r.liquidity ? Math.round(r.liquidity).toLocaleString() : "—"}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{r.numBooks}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
