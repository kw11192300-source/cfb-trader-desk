import type { GradedBet } from "./data";

export type BreakdownRow = { label: string; n: number; wins: number; losses: number; pushes: number; staked: number; profit: number; roi: number | null };

/** Groups already-GRADED bets by whatever keyFn returns (null = excluded -
 * e.g. a bet whose game join is missing) and rolls up record/staked/
 * profit/ROI per group. Shared between RiskDashboard's "by source"/"by
 * week" tables and BetsLedger's "by week" summary so both use the exact
 * same math. */
export function summarizeBets(graded: GradedBet[], keyFn: (g: GradedBet) => string | null): BreakdownRow[] {
  const groups = new Map<string, GradedBet[]>();
  for (const g of graded) {
    const key = keyFn(g);
    if (key === null) continue;
    const list = groups.get(key) ?? [];
    list.push(g);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([label, rows]) => {
    const wins = rows.filter((r) => r.status === "win").length;
    const losses = rows.filter((r) => r.status === "loss").length;
    const pushes = rows.filter((r) => r.status === "push").length;
    const staked = rows.reduce((s, r) => s + r.bet.stake, 0);
    const profit = rows.reduce((s, r) => s + (r.profit ?? 0), 0);
    const roi = staked > 0 ? (profit / staked) * 100 : null;
    return { label, n: rows.length, wins, losses, pushes, staked, profit, roi };
  });
}

export function byWeek(graded: GradedBet[]): BreakdownRow[] {
  return summarizeBets(graded, (g) => (g.game ? `${g.game.season} W${g.game.week}` : null)).sort((a, b) => a.label.localeCompare(b.label));
}

export function fmtUnits(n: number): string {
  return n > 0 ? `+${n.toFixed(2)}u` : `${n.toFixed(2)}u`;
}

export function fmtPct(n: number | null): string {
  if (n === null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
