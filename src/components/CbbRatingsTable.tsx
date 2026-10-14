"use client";

import { useMemo, useState } from "react";
import StatTable, { fmtD, type StatCol, type StatRow } from "./StatTable";

export type CbbRatingRow = StatRow & { conference: string };

const col = (key: string, label: string, title: string, digits: number, signed = false): StatCol => ({ key, label, title, fmt: fmtD(key, digits), signed });

function colsFor(kind: string): StatCol[] {
  const base: StatCol[] = [
    col("rank", "Rk", "Rank by net rating", 0),
    col("net", "Net", "Adjusted efficiency margin: points per 100 possessions better (or worse) than an average Division I team on a neutral floor", 1, true),
    col("off", "Off", "Adjusted offence: points scored per 100 possessions against an average defence", 1),
    col("def", "Def", "Adjusted defence: points allowed per 100 possessions against an average offence (lower is better)", 1),
    col("tempo", "Tempo", "Possessions per 40 minutes relative to the average team (+ = plays faster)", 1, true),
  ];
  if (kind === "preseason") {
    base.push(
      col("last_net", "Last yr", "Last season's end-of-season net rating", 1),
      col("change", "Change", "Preseason net minus last season's net - roster turnover and regression to the mean", 1, true),
    );
  } else {
    base.push(col("wins", "W", "Wins last season", 0), col("losses", "L", "Losses last season", 0));
  }
  return base;
}

/** Team ratings with a conference filter; the rating columns are sortable and the signed ones shaded. */
export default function CbbRatingsTable({ rows, kind, conferences }: { rows: CbbRatingRow[]; kind: string; conferences: string[] }) {
  const [conf, setConf] = useState("All");
  const shown = useMemo(() => (conf === "All" ? rows : rows.filter((r) => r.conference === conf)), [rows, conf]);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={conf}
          onChange={(e) => setConf(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
        >
          <option value="All">All conferences</option>
          {conferences.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <StatTable key={`${kind}-${conf}`} rows={shown} cols={colsFor(kind)} nameHeader="Team" defaultSort="net" empty="No ratings published yet." />
    </div>
  );
}
