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

const MARKET_LABEL: Record<string, string> = { spread: "Spread", moneyline: "Moneyline", total: "Total", prop: "Player Prop", parlay: "Parlay" };

/** Every distinct market (Spread/Moneyline/Total/Player Prop). */
export function byMarket(graded: GradedBet[]): BreakdownRow[] {
  return summarizeBets(graded, (g) => MARKET_LABEL[g.bet.market] ?? g.bet.market).sort((a, b) => b.n - a.n);
}

/** Just two buckets: player props vs. the three game-level markets - the
 * "am I actually better at picking a number for a guy, or picking a side
 * of the game" question. */
export function byPropVsCore(graded: GradedBet[]): BreakdownRow[] {
  return summarizeBets(graded, (g) => (g.bet.market === "prop" ? "Player Props" : "Core 3 (Spread/ML/Total)")).sort((a, b) => b.n - a.n);
}

/** Prop bets only, grouped by player - null (non-prop bets) excluded. */
export function byPlayer(graded: GradedBet[]): BreakdownRow[] {
  return summarizeBets(graded, (g) => (g.bet.market === "prop" ? g.bet.player : null)).sort((a, b) => b.profit - a.profit);
}

/** Prop bets only, grouped by prop type (Passing Yards, Anytime TD, ...). */
export function byPropType(graded: GradedBet[]): BreakdownRow[] {
  return summarizeBets(graded, (g) => (g.bet.market === "prop" ? g.bet.prop_type : null)).sort((a, b) => b.profit - a.profit);
}

export function fmtUnits(n: number): string {
  return n > 0 ? `+${n.toFixed(2)}u` : `${n.toFixed(2)}u`;
}

export function fmtPct(n: number | null): string {
  if (n === null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
