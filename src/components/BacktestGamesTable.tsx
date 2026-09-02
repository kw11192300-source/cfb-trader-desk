"use client";

import { Fragment, useMemo, useState } from "react";
import type { ModelBacktestGame } from "@/lib/types";

function fmtSpread(n: number): string {
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

/** market/model/actual, all from the PICKED team's own perspective and in
 * the same spread convention (negative = favored) so they're directly
 * comparable - market − model = edge. market_spread and actual_margin are
 * stored home-perspective; predicted_margin is a predicted POINT MARGIN
 * (opposite sign convention from a spread), so it's negated before the
 * pick-side flip, same fix as EdgesTable's pickPerspective. */
function pickView(g: ModelBacktestGame) {
  const pickHome = g.pick_team === g.home_team;
  const market = pickHome ? g.market_spread : -g.market_spread;
  const modelSpread = -g.predicted_margin;
  const model = pickHome ? modelSpread : -modelSpread;
  const actual = pickHome ? g.actual_margin : -g.actual_margin;
  return { market, model, actual };
}

const MATCHUP_LABELS: Record<string, string> = {
  fbs_vs_fbs: "FBS vs FBS",
  buy_game: "Buy game",
  fcs_vs_fcs: "FCS vs FCS",
};

type ResultFilter = "all" | "win" | "loss";
type SelectionFilter = "selected" | "all";

export default function BacktestGamesTable({ games }: { games: ModelBacktestGame[] }) {
  const seasons = useMemo(() => Array.from(new Set(games.map((g) => g.season))).sort((a, b) => b - a), [games]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [season, setSeason] = useState<number | "all">("all");
  const [matchupType, setMatchupType] = useState<string | "all">("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [selection, setSelection] = useState<SelectionFilter>("selected");
  const [query, setQuery] = useState("");
  const [minEdge, setMinEdge] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const min = minEdge.trim() === "" ? null : Number(minEdge);
    return games.filter((g) => {
      if (season !== "all" && g.season !== season) return false;
      if (matchupType !== "all" && g.matchup_type !== matchupType) return false;
      if (result === "win" && !g.correct) return false;
      if (result === "loss" && g.correct) return false;
      if (selection === "selected" && !g.is_selected) return false;
      if (min !== null && !Number.isNaN(min) && g.edge < min) return false;
      if (q !== "" && !g.home_team.toLowerCase().includes(q) && !g.away_team.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [games, season, matchupType, result, selection, query, minEdge]);

  const wins = filtered.filter((g) => g.correct).length;
  const winRate = filtered.length > 0 ? wins / filtered.length : 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={season}
          onChange={(e) => setSeason(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
        >
          <option value="all">All seasons</option>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={matchupType}
          onChange={(e) => setMatchupType(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
        >
          <option value="all">All matchup types</option>
          <option value="fbs_vs_fbs">FBS vs FBS</option>
          <option value="buy_game">Buy game</option>
          <option value="fcs_vs_fcs">FCS vs FCS</option>
        </select>
        <select
          value={result}
          onChange={(e) => setResult(e.target.value as ResultFilter)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
        >
          <option value="all">Win or loss</option>
          <option value="win">Wins only</option>
          <option value="loss">Losses only</option>
        </select>
        <select
          value={selection}
          onChange={(e) => setSelection(e.target.value as SelectionFilter)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
        >
          <option value="selected">Only picked games (top-15 pool)</option>
          <option value="all">Every graded game</option>
        </select>
        <input
          type="number"
          step="0.5"
          value={minEdge}
          onChange={(e) => setMinEdge(e.target.value)}
          placeholder="Min edge"
          className="w-24 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by team…"
          className="w-44 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <span className="text-xs text-muted">
          {filtered.length} games — <span className={winRate >= 0.524 ? "text-up" : "text-down"}>{(winRate * 100).toFixed(1)}%</span>
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-muted">No games match these filters.</div>
      ) : (
        <div className="max-h-[65vh] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                <th className="sticky top-0 z-10 bg-surface-raised px-3 py-3 font-medium">Season</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Matchup</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Type</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right">Market</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right">Model</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right">Edge</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium">Pick</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right">Actual</th>
                <th className="sticky top-0 z-10 bg-surface-raised px-4 py-3 font-medium text-right">Result</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => {
                const { market, model, actual } = pickView(g);
                const expanded = expandedId === g.id;
                return (
                  <Fragment key={g.id}>
                    <tr
                      onClick={() => setExpandedId(expanded ? null : g.id)}
                      className="cursor-pointer border-b border-border last:border-0 odd:bg-surface/50 hover:bg-surface-raised"
                    >
                      <td className="px-3 py-2 font-mono text-xs text-muted">{g.season}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-foreground">
                        {g.away_team} @ {g.home_team}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted">{MATCHUP_LABELS[g.matchup_type] ?? g.matchup_type}</td>
                      <td className="px-4 py-2 text-right font-mono text-foreground">{fmtSpread(market)}</td>
                      <td className="px-4 py-2 text-right font-mono text-foreground">{fmtSpread(model)}</td>
                      <td className="px-4 py-2 text-right font-mono font-medium text-accent">{g.edge.toFixed(1)}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-foreground">{g.pick_team}</td>
                      <td className="px-4 py-2 text-right font-mono text-muted">{fmtSpread(actual)}</td>
                      <td className={`px-4 py-2 text-right font-mono text-xs font-medium ${g.correct ? "text-up" : "text-down"}`}>
                        {g.correct ? "WIN" : "LOSS"}
                      </td>
                    </tr>
                    {expanded && g.rationale && (
                      <tr className="border-b border-border bg-surface-raised/60 last:border-0">
                        <td colSpan={9} className="px-4 py-3 text-xs leading-relaxed text-muted">
                          {g.rationale}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
