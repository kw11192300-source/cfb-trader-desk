"use client";

import StatTable, { fmtD, fmtPct, type StatCol, type StatRow } from "./StatTable";

const COLS: StatCol[] = [
  { key: "gp", label: "GP", fmt: fmtD("gp", 0) },
  { key: "w", label: "W-L-OTL", title: "Wins - regulation losses - overtime/shootout losses", fmt: (r) => `${r.stats.w}-${r.stats.l}-${r.stats.otl}` },
  { key: "pts", label: "Pts", title: "Real standings points (2 for a win, 1 for an overtime/shootout loss)", fmt: fmtD("pts", 0) },
  { key: "xpts", label: "xPts", title: "Expected points from the quality of chances each game, adjusted for the score at the time of each shot (see the note above)", fmt: fmtD("xpts", 1) },
  { key: "xpts_raw", label: "xPts (raw)", title: "Same, without the score adjustment - leading teams look worse here because they sit back and get out-shot", fmt: fmtD("xpts_raw", 1) },
  { key: "pts_diff", label: "Pts − xPts", title: "Real points minus expected points. Positive = got more than the chances deserved (finishing, goaltending, luck)", fmt: fmtD("pts_diff", 1), signed: true },
  { key: "xpts_pace", label: "xPts pace", title: "xPts per game x 82", fmt: fmtD("xpts_pace", 0) },
  { key: "gf_pg", label: "GF/g", title: "Goals for per game (overtime included, shootout excluded)", fmt: fmtD("gf_pg", 2) },
  { key: "ga_pg", label: "GA/g", title: "Goals against per game", fmt: fmtD("ga_pg", 2) },
  { key: "xgf_pg", label: "xGF/g", title: "Our expected goals for per game", fmt: fmtD("xgf_pg", 2) },
  { key: "xga_pg", label: "xGA/g", title: "Our expected goals against per game", fmt: fmtD("xga_pg", 2) },
  { key: "xgd_pg", label: "xGD/g", title: "xGF minus xGA per game", fmt: fmtD("xgd_pg", 2), signed: true },
  { key: "xgf_pct", label: "xGF%", title: "Share of all expected goals (all situations, raw)", fmt: fmtPct("xgf_pct") },
  { key: "sa_xgf_pct", label: "Score-adj xGF%", title: "Share of expected goals in regulation after adjusting each shot for the score at the time (leaders get out-chanced, trailers push)", fmt: fmtPct("sa_xgf_pct") },
  { key: "ev_xgf_pct", label: "EV xGF%", title: "Share of expected goals at even strength", fmt: fmtPct("ev_xgf_pct") },
  { key: "cf_pct", label: "CF%", title: "Share of shot attempts (regulation)", fmt: fmtPct("cf_pct") },
  { key: "pp_xg60", label: "PP xG/60", title: "Expected goals created per 60 minutes of power play", fmt: fmtD("pp_xg60", 2) },
  { key: "pk_xga60", label: "PK xGA/60", title: "Expected goals allowed per 60 minutes shorthanded (lower is better)", fmt: fmtD("pk_xga60", 2) },
  { key: "finishing_pg", label: "Finishing/g", title: "Goals scored minus xG, per game. Positive = scoring more than the chances suggest", fmt: fmtD("finishing_pg", 2), signed: true },
  { key: "goaltending_pg", label: "Goaltending/g", title: "xG against minus goals against, per game. Positive = the goalies stopped more than expected", fmt: fmtD("goaltending_pg", 2), signed: true },
];

export default function NhlTeamStatsTable({ rows }: { rows: StatRow[] }) {
  return <StatTable rows={rows} cols={COLS} nameHeader="Team" defaultSort="xgf_pct" empty="No team tables published yet." />;
}
