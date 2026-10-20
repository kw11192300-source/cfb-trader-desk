"use client";

import { useMemo, useState } from "react";
import StatTable, { fmtD, fmtPct, type StatCol, type StatRow } from "./StatTable";

export type NbaPlayerRow = StatRow & { team: string };

const col = (key: string, label: string, title: string, digits: number, signed = false): StatCol => ({ key, label, title, fmt: fmtD(key, digits), signed });

const COLS: StatCol[] = [
  col("rank", "Rk", "Rank by net rating among rostered players", 0),
  col("net", "Net", "Points per 100 possessions he adds over an average player while on the floor (offence + defence). A lineup of five +1s is +5. Stars are +6 and up.", 1, true),
  col("off", "Off", "Offence: points per 100 possessions his team scores better than with an average player on the floor", 1, true),
  col("def", "Def", "Defence: points per 100 possessions his team allows LESS than with an average player (positive = good). The hardest part of a player to measure from public data.", 1, true),
  col("poss", "Poss", "How many possessions of lineup evidence sit behind the rating (recent seasons count more). Below ~4,000 the rating leans heavily on his box-score line.", 0),
  col("mpg", "MPG", "Minutes per game last season", 1),
  col("gp", "GP", "Games played last season", 0),
  { key: "ts", label: "TS%", title: "True shooting percentage last season", fmt: fmtPct("ts") },
  col("pts36", "Pts", "Points per 36 minutes last season", 1),
  col("reb36", "Reb", "Rebounds per 36 minutes", 1),
  col("ast36", "Ast", "Assists per 36 minutes", 1),
  col("stl36", "Stl", "Steals per 36 minutes", 1),
  col("blk36", "Blk", "Blocks per 36 minutes", 1),
  col("tpm36", "3PM", "Three-pointers made per 36 minutes", 1),
  col("abs_margin", "Out: Spread", "Points of margin per game his team has lost when he sat, over the last five seasons (shrunk toward the average for his minutes, so a few games won't swing it). Negative = worse without him. Read it with the games column.", 1, true),
  col("abs_total", "Out: Total", "Change in the game total (both teams' points) when he sat. Small for most players; a few stars move it.", 1, true),
  col("abs_pace", "Out: Pace", "Change in possessions per 48 minutes when he sat", 1, true),
  col("abs_games", "G out", "Games he missed in the data - how much evidence the Out columns rest on", 0),
];

/** NBA player ratings with a team filter and a minimum-evidence box; rating columns are sortable and the signed ones shaded. */
export default function NbaPlayersTable({ rows, teams }: { rows: NbaPlayerRow[]; teams: string[] }) {
  const [team, setTeam] = useState("All");
  const shown = useMemo(() => (team === "All" ? rows : rows.filter((r) => r.team === team)), [rows, team]);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
        >
          <option value="All">All teams</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <StatTable
        key={team}
        rows={shown}
        cols={COLS}
        nameHeader="Player"
        defaultSort="net"
        minKey="poss"
        minDefault={2000}
        minLabel="Min poss"
        empty="No player ratings published yet - run python -m nba_model.players_table."
      />
    </div>
  );
}
