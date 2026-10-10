"use client";

import { useMemo, useState } from "react";
import StatTable, { fmtD, type StatCol, type StatRow } from "./StatTable";
import { fairOdds, pct } from "@/lib/nhlModel";

export type FuturesRow = StatRow & { conference: string; division: string };

const pctOdds = (key: string) => (r: StatRow) => {
  const p = r.stats[key];
  if (p === null || p === undefined) return "—";
  const digits = p < 0.01 ? 2 : 1;
  return `${pct(p, digits)}  ${p <= 0.0005 || p >= 0.9995 ? "" : fairOdds(p)}`.trim();
};

const COLS: StatCol[] = [
  { key: "cup", label: "Stanley Cup", title: "Chance to win the Cup, and its fair American price (no vig)", fmt: pctOdds("cup") },
  { key: "final", label: "Win conference", title: "Chance to reach (and so win the conference to play in) the Cup final", fmt: pctOdds("final") },
  { key: "r3", label: "Conf. final", title: "Chance to reach the conference final (win the second round)", fmt: pctOdds("r3") },
  { key: "r2", label: "Round 2", title: "Chance to win its first-round series", fmt: pctOdds("r2") },
  { key: "playoffs", label: "Make playoffs", title: "Chance to finish in the top three of its division or as a wild card", fmt: pctOdds("playoffs") },
  { key: "division", label: "Win division", title: "Chance to finish first in its division", fmt: pctOdds("division") },
  { key: "exp_pts", label: "Exp. pts", title: "Average simulated final standings points", fmt: fmtD("exp_pts", 1) },
  { key: "sd_pts", label: "± pts", title: "Standard deviation of simulated final points", fmt: fmtD("sd_pts", 1) },
  { key: "pts", label: "Pts", title: "Points so far", fmt: fmtD("pts", 0) },
  { key: "gp", label: "GP", fmt: fmtD("gp", 0) },
];

const GROUPS = ["All teams", "East", "West", "Atlantic", "Metropolitan", "Central", "Pacific"];

export default function NhlFuturesTable({ rows }: { rows: FuturesRow[] }) {
  const [group, setGroup] = useState("All teams");
  const shown = useMemo(() => rows.filter((r) => group === "All teams" || r.conference === group || r.division === group), [rows, group]);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {GROUPS.map((g) => (
          <button
            key={g}
            onClick={() => setGroup(g)}
            className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${group === g ? "border-accent bg-accent text-background" : "border-border text-muted hover:text-foreground"}`}
          >
            {g}
          </button>
        ))}
      </div>
      <StatTable key={group} rows={shown} cols={COLS} nameHeader="Team" defaultSort="cup" empty="No season simulation published yet." />
    </div>
  );
}
