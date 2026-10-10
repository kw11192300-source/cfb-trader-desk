import type { NhlGoalieStatsRow, NhlTeamStatsRow } from "./types";

export type MatchupLine = {
  label: string;
  hint?: string;
  away: string;
  home: string;
  awayRank: number | null;
  homeRank: number | null;
};

type Spec = { key: string; label: string; hint?: string; digits: number; higherBetter: boolean; pct?: boolean; signed?: boolean; source?: "all" | "l10" };

const SPECS: Spec[] = [
  { key: "power", label: "Power rating", hint: "Expected goal differential per game vs an average team", digits: 2, higherBetter: true, signed: true },
  { key: "xpts_pace", label: "xPts pace (82 gp)", hint: "Expected points per game x 82, from chance quality", digits: 0, higherBetter: true },
  { key: "xgf_pg", label: "xGF / game", digits: 2, higherBetter: true },
  { key: "xga_pg", label: "xGA / game", digits: 2, higherBetter: false },
  { key: "sa_xgf_pct", label: "xGF % (score-adjusted)", digits: 1, higherBetter: true, pct: true },
  { key: "xgf_pct", label: "xGF % - last 10", hint: "Share of expected goals over each team's last 10 games", digits: 1, higherBetter: true, pct: true, source: "l10" },
  { key: "pp_xg60", label: "Power play xG / 60", digits: 2, higherBetter: true },
  { key: "pk_xga60", label: "Penalty kill xGA / 60", hint: "Lower is better", digits: 2, higherBetter: false },
  { key: "pts_diff", label: "Points vs xPts", hint: "Positive = has more points than its chances earned", digits: 1, higherBetter: true, signed: true },
  { key: "finishing_pg", label: "Finishing (goals - xG) / game", digits: 2, higherBetter: true, signed: true },
  { key: "goaltending_pg", label: "Goaltending (xGA - GA) / game", digits: 2, higherBetter: true, signed: true },
];

const fmt = (v: number | null | undefined, s: Spec): string => {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const n = s.pct ? v * 100 : v;
  return `${s.signed && n > 0 ? "+" : ""}${n.toFixed(s.digits)}${s.pct ? "%" : ""}`;
};

function rank(rows: NhlTeamStatsRow[], team: string, key: string, higherBetter: boolean): number | null {
  const vals = rows.map((r) => ({ team: r.name, v: r.stats[key] })).filter((x): x is { team: string; v: number } => typeof x.v === "number");
  const mine = vals.find((x) => x.team === team);
  if (!mine) return null;
  return 1 + vals.filter((x) => (higherBetter ? x.v > mine.v : x.v < mine.v)).length;
}

/** Side-by-side team numbers from the Teams tables, each with its rank among the 32 teams. */
export function teamMatchup(all: NhlTeamStatsRow[], l10: NhlTeamStatsRow[], home: string, away: string): MatchupLine[] {
  const get = (rows: NhlTeamStatsRow[], team: string) => rows.find((r) => r.name === team)?.stats ?? {};
  return SPECS.map((s) => {
    const rows = s.source === "l10" ? l10 : all;
    return {
      label: s.label,
      hint: s.hint,
      away: fmt(get(rows, away)[s.key], s),
      home: fmt(get(rows, home)[s.key], s),
      awayRank: rank(rows, away, s.key, s.higherBetter),
      homeRank: rank(rows, home, s.key, s.higherBetter),
    };
  });
}

export type GoalieLine = { team: string; name: string; weight: number; gsax: string; gsaxPer100: string; svPct: string; gp: string; rating: string };

/** The goalies the model is using for each side, with their season numbers from the Goalies table. */
export function goalieLines(goalies: { name: string; weight: number; rating: number }[], rows: NhlGoalieStatsRow[], team: string): GoalieLine[] {
  const byName = new Map(rows.map((r) => [r.name ?? "", r]));
  return goalies.map((g) => {
    const s = byName.get(g.name)?.stats;
    const f = (v: number | null | undefined, d: number, plus = false) => (v === null || v === undefined ? "—" : `${plus && v > 0 ? "+" : ""}${v.toFixed(d)}`);
    return {
      team,
      name: g.name,
      weight: g.weight,
      gsax: f(s?.gsax, 1, true),
      gsaxPer100: f(s?.gsax_per100, 2, true),
      svPct: s?.sv_pct == null ? "—" : s.sv_pct.toFixed(3).replace(/^0/, ""),
      gp: s?.gp == null ? "—" : String(s.gp),
      rating: `${g.rating > 0 ? "+" : ""}${g.rating.toFixed(2)}`,
    };
  });
}
