"use client";

import { useMemo, useState } from "react";
import NhlTeamGamesTable from "./NhlTeamGamesTable";
import { pct } from "@/lib/nhlModel";
import { summarizeTeam, type TeamGameRow } from "@/lib/nhlTeamGames";

const WINDOWS = [
  { label: "Last 5", n: 5 },
  { label: "Last 10", n: 10 },
  { label: "Season", n: 0 },
];

const chip = (on: boolean) =>
  `rounded-md border px-3 py-1 text-xs font-medium transition-colors ${on ? "border-accent bg-accent text-background" : "border-border text-muted hover:text-foreground"}`;

function Tile({ label, value, sub, tone = "text-foreground" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`font-mono text-base font-semibold ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

/** A team's season log with a venue / recent-window filter and the trends over whatever is shown. */
export default function NhlTeamLog({ rows }: { rows: TeamGameRow[] }) {
  const [venue, setVenue] = useState<"all" | "home" | "away">("all");
  const [win, setWin] = useState(0);

  const shown = useMemo(() => {
    let list = rows.filter((r) => venue === "all" || (venue === "home") === r.isHome);
    if (win > 0) {
      const keep = new Set(
        list
          .filter((r) => r.completed)
          .sort((a, b) => b.startDate.localeCompare(a.startDate))
          .slice(0, win)
          .map((r) => r.gameId),
      );
      list = list.filter((r) => !r.completed || keep.has(r.gameId));
    }
    return list;
  }, [rows, venue, win]);
  const s = useMemo(() => summarizeTeam(shown), [shown]);
  const signed = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {WINDOWS.map((w) => (
          <button key={w.label} onClick={() => setWin(w.n)} className={chip(win === w.n)}>
            {w.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {(["all", "home", "away"] as const).map((v) => (
          <button key={v} onClick={() => setVenue(v)} className={chip(venue === v)}>
            {v === "all" ? "Home + away" : v === "home" ? "Home" : "Away"}
          </button>
        ))}
      </div>

      {s.games > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <Tile label="Record" value={`${s.wins}-${s.losses}`} sub={`${s.games} games`} />
          <Tile label="Goals / game" value={`${s.gf.toFixed(2)} – ${s.ga.toFixed(2)}`} sub="for – against" />
          <Tile
            label="xG / game"
            value={s.xgf !== null && s.xga !== null ? `${s.xgf.toFixed(2)} – ${s.xga.toFixed(2)}` : "—"}
            sub={s.xgShare !== null ? `${pct(s.xgShare, 0)} of the chances` : undefined}
            tone={s.xgShare !== null ? (s.xgShare >= 0.5 ? "text-up" : "text-down") : "text-foreground"}
          />
          <Tile
            label="Model win % vs actual"
            value={s.modelWin !== null && s.actualWin !== null ? `${pct(s.modelWin, 0)} → ${pct(s.actualWin, 0)}` : "—"}
            sub={s.modelN > 0 ? `${s.modelN} games with a pre-game number` : "tracking began Oct 9"}
          />
          <Tile
            label="Moneyline, 1u each"
            value={s.closeN > 0 ? `${signed(s.mlUnits)}u` : "—"}
            sub={s.closeN > 0 ? `at the close, ${s.closeN} games` : undefined}
            tone={s.closeN > 0 ? (s.mlUnits >= 0 ? "text-up" : "text-down") : "text-foreground"}
          />
          <Tile label="Puck line · O/U" value={s.closeN > 0 ? `${s.coverW}-${s.coverL} · ${s.over}-${s.under}${s.push ? `-${s.push}` : ""}` : "—"} sub="covers · over-under" />
        </div>
      )}

      <NhlTeamGamesTable rows={shown} />
      <p className="mt-2 text-[11px] text-muted">
        Model numbers and DraftKings closes exist only for games since the odds timer started (Oct 9) - earlier games show a dash. Actual xG is our model&apos;s
        count of each team&apos;s chances; the close is the last DraftKings price we saw before puck drop. Green on the result columns means the team&apos;s side hit.
      </p>
    </div>
  );
}
