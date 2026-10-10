"use client";

import StatTable, { fmtD, type StatCol, type StatRow } from "./StatTable";

const COLS: StatCol[] = [
  { key: "gp", label: "GP", title: "Games played", fmt: fmtD("gp", 0) },
  { key: "gs", label: "GS", title: "Games started", fmt: fmtD("gs", 0) },
  { key: "sog", label: "SA", title: "Shots on goal faced", fmt: fmtD("sog", 0) },
  { key: "ga", label: "GA", title: "Goals allowed (empty-net and shootout excluded)", fmt: fmtD("ga", 0) },
  { key: "xga", label: "xGA", title: "Expected goals against - what an average goalie would have allowed on the same chances", fmt: fmtD("xga", 1) },
  { key: "gsax", label: "GSAx", title: "Goals saved above expected = xGA minus GA. Positive = better than an average goalie on the same chances", fmt: fmtD("gsax", 1), signed: true },
  { key: "gsax_per100", label: "GSAx/100", title: "GSAx per 100 unblocked attempts faced - the rate version, fair across different workloads", fmt: fmtD("gsax_per100", 2), signed: true },
  { key: "gsax_pg", label: "GSAx/gm", title: "GSAx per game played", fmt: fmtD("gsax_pg", 2), signed: true },
  { key: "sv_pct", label: "Sv%", title: "Save percentage on shots on goal", fmt: (r) => (r.stats.sv_pct === null || r.stats.sv_pct === undefined ? "—" : r.stats.sv_pct.toFixed(3).replace(/^0/, "")) },
  { key: "sa_pg", label: "SA/gm", title: "Shots on goal faced per game", fmt: fmtD("sa_pg", 1) },
  { key: "ga_pg", label: "GA/gm", title: "Goals allowed per game", fmt: fmtD("ga_pg", 2) },
  { key: "xga_pg", label: "xGA/gm", title: "Expected goals against per game", fmt: fmtD("xga_pg", 2) },
  { key: "xg_per_att", label: "xG/att", title: "Average xG of the attempts he faced - how dangerous his workload was (higher = harder)", fmt: fmtD("xg_per_att", 3) },
  { key: "rating", label: "Model rating", title: "What the simulator uses: GSAx per 100 attempts, time-decayed and shrunk toward average (current season only)", fmt: fmtD("rating", 2), signed: true },
];

export default function NhlGoalieStatsTable({ rows, minDefault }: { rows: StatRow[]; minDefault: number }) {
  return <StatTable rows={rows} cols={COLS} nameHeader="Goalie" defaultSort="gsax" minKey="gp" minDefault={minDefault} minLabel="Min GP" empty="No goalie tables published yet." />;
}
