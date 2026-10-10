"use client";

import { useMemo, useState } from "react";
import StatTable, { fmtD, type StatCol, type StatRow } from "./StatTable";

export type SkaterRow = StatRow & { pos: string | null };

const COLS: StatCol[] = [
  { key: "value_pg", label: "Value/gm", title: "Net impact x 5v5 minutes per game: expected goals per game above an average skater. This is what the rank is sorted on", fmt: fmtD("value_pg", 3), signed: true, heat: "high" },
  { key: "net", label: "Net /60", title: "Offense + defense: how many more expected goals per 60 minutes of 5v5 his team outscores opponents by with him on the ice, vs an average skater", fmt: fmtD("net", 2), signed: true, heat: "high" },
  { key: "off", label: "Offense /60", title: "Extra expected goals his team creates per 60 minutes of 5v5 with him on the ice", fmt: fmtD("off", 2), signed: true, heat: "high" },
  { key: "def_good", label: "Defense /60", title: "Expected goals his team PREVENTS per 60 minutes of 5v5 with him on the ice (positive = fewer goals allowed)", fmt: fmtD("def_good", 2), signed: true, heat: "high" },
  { key: "toi_pg", label: "5v5 min/gm", title: "Even-strength minutes per game", fmt: fmtD("toi_pg", 1) },
  { key: "gp", label: "GP", title: "Games in the rating window (last few seasons)", fmt: fmtD("gp", 0) },
  { key: "rank", label: "Rank", title: "Rank by Value/gm among all rated skaters", fmt: fmtD("rank", 0) },
  { key: "pct", label: "Pctile", title: "Percentile among rated skaters (100 = best)", fmt: (r) => (r.stats.pct === null || r.stats.pct === undefined ? "—" : `${(r.stats.pct * 100).toFixed(0)}`), heat: "high" },
];

const POS_GROUPS: { label: string; test: (p: string | null) => boolean }[] = [
  { label: "All skaters", test: () => true },
  { label: "Forwards", test: (p) => p === "C" || p === "L" || p === "R" || p === "LW" || p === "RW" },
  { label: "Centers", test: (p) => p === "C" },
  { label: "Wingers", test: (p) => p === "L" || p === "R" || p === "LW" || p === "RW" },
  { label: "Defensemen", test: (p) => p === "D" },
];

/** The rated skaters, sortable and filterable; a position dropdown narrows the list before the shared table sorts it. */
export default function NhlSkaterStatsTable({ rows }: { rows: SkaterRow[] }) {
  const [group, setGroup] = useState(0);
  const filtered = useMemo(() => rows.filter((r) => POS_GROUPS[group].test(r.pos)), [rows, group]);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {POS_GROUPS.map((g, i) => (
          <button
            key={g.label}
            onClick={() => setGroup(i)}
            className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${group === i ? "border-accent bg-accent text-background" : "border-border text-muted hover:text-foreground"}`}
          >
            {g.label}
          </button>
        ))}
      </div>
      <StatTable key={group} rows={filtered} cols={COLS} nameHeader="Skater" defaultSort="value_pg" minKey="gp" minDefault={20} minLabel="Min GP" empty="No skater ratings published yet." />
    </div>
  );
}
