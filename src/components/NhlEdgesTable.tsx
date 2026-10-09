"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import LocalDateTime from "./LocalDateTime";
import NhlTeamLogo from "./NhlTeamLogo";
import { fairOdds, fmtOdds, pct } from "@/lib/nhlModel";

export type EdgeListRow = {
  key: string;
  gameId: number;
  startDate: string;
  home: string;
  away: string;
  market: "Moneyline" | "Puck line" | "Total";
  side: string;
  bookOdds: number;
  bookImplied: number;
  model: number;
  edgePts: number;
  ev: number;
};

const MIN_OPTIONS = [
  { label: "Any positive EV", value: 0 },
  { label: "EV ≥ 2%", value: 0.02 },
  { label: "EV ≥ 3%", value: 0.03 },
  { label: "EV ≥ 5%", value: 0.05 },
  { label: "Show everything", value: -1 },
];

const pts = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

/** Every DraftKings price our simulation beats, across all upcoming games, best EV first. */
export default function NhlEdgesTable({ rows }: { rows: EdgeListRow[] }) {
  const [minEv, setMinEv] = useState(0);
  const [market, setMarket] = useState<"all" | EdgeListRow["market"]>("all");

  const shown = useMemo(() => rows.filter((r) => (minEv < 0 || r.ev > minEv) && (market === "all" || r.market === market)).sort((a, b) => b.ev - a.ev), [rows, minEv, market]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select value={minEv} onChange={(e) => setMinEv(Number(e.target.value))} className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none">
          {MIN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select value={market} onChange={(e) => setMarket(e.target.value as typeof market)} className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none">
          <option value="all">All markets</option>
          <option value="Moneyline">Moneyline</option>
          <option value="Puck line">Puck line</option>
          <option value="Total">Total</option>
        </select>
        <span className="text-xs text-muted">
          {shown.length} of {rows.length} prices
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          {rows.length === 0 ? "No upcoming games have DraftKings lines and a model prediction yet." : "Nothing clears that filter."}
        </div>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="sticky top-0 z-10 w-8 bg-surface-raised px-2 py-2.5 text-right font-medium">#</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">Game</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">Market</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 font-medium">Side</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">DK price</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium" title="The win probability the posted price needs to break even, vig included">
                  Break-even
                </th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">Model</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">Model price</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">Edge (pts)</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-2.5 text-right font-medium">EV</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={r.key} className="border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised">
                  <td className="px-2 py-2 text-right font-mono text-xs text-muted">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link href={`/nhl/games/${r.gameId}`} prefetch={false} className="block">
                      <span className="flex items-center gap-1.5 whitespace-nowrap text-foreground">
                        <NhlTeamLogo team={r.away} size={18} />
                        {r.away.split(" ").slice(-1)[0]}
                        <span className="text-muted">@</span>
                        <NhlTeamLogo team={r.home} size={18} />
                        {r.home.split(" ").slice(-1)[0]}
                      </span>
                      <span className="text-[11px] text-muted">
                        <LocalDateTime iso={r.startDate} options={{ weekday: "short", hour: "numeric", minute: "2-digit" }} />
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{r.market}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-foreground">
                    {r.side}
                    {r.ev >= 0.03 && <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-background">EDGE</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-up">{fmtOdds(r.bookOdds)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-foreground">{pct(r.bookImplied)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-foreground">{pct(r.model)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-foreground">{fairOdds(r.model)}</td>
                  <td className={`px-3 py-2 text-right font-mono text-xs ${r.edgePts > 0 ? "text-accent" : "text-warn"}`}>{pts(r.edgePts)}</td>
                  <td className={`px-3 py-2 text-right font-mono text-xs font-semibold ${r.ev > 0 ? "text-accent" : "text-muted"}`}>
                    {r.ev >= 0 ? "+" : ""}
                    {(r.ev * 100).toFixed(1)}%
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
