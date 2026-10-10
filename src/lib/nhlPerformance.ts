import type { NhlEdgeLogRow, NhlGoalieCallRow } from "./types";

export type Group = {
  label: string;
  n: number;
  wins: number;
  pushes: number;
  avgModel: number;
  avgBreakEven: number;
  avgEv: number;
  /** Flat 1-unit stakes: total profit / number of bets. */
  roi: number;
  /** One standard error on that ROI (profit swings are big relative to a few percent of edge). */
  roiSe: number;
  /** Mean closing-line value in probability points ('first' rows with a comparable close), and how many had one. */
  clv: number | null;
  clvN: number;
  clvPositive: number | null;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(label: string, rows: NhlEdgeLogRow[]): Group {
  const n = rows.length;
  const profits = rows.map((r) => r.profit ?? 0);
  const roi = mean(profits);
  const variance = n > 1 ? profits.reduce((a, p) => a + (p - roi) ** 2, 0) / (n - 1) : 0;
  const clvs = rows.map((r) => r.clv_pts).filter((x): x is number => x !== null);
  return {
    label,
    n,
    wins: rows.filter((r) => r.result === "win").length,
    pushes: rows.filter((r) => r.result === "push").length,
    avgModel: mean(rows.map((r) => r.model_prob)),
    avgBreakEven: mean(rows.map((r) => r.book_implied)),
    avgEv: mean(rows.map((r) => r.ev)),
    roi,
    roiSe: n > 1 ? Math.sqrt(variance / n) : 0,
    clv: clvs.length ? mean(clvs) : null,
    clvN: clvs.length,
    clvPositive: clvs.length ? clvs.filter((c) => c > 0).length / clvs.length : null,
  };
}

export const EV_BUCKETS: { label: string; test: (ev: number) => boolean }[] = [
  { label: "EV below 0%", test: (ev) => ev < 0 },
  { label: "EV 0–2%", test: (ev) => ev >= 0 && ev < 0.02 },
  { label: "EV 2–5%", test: (ev) => ev >= 0.02 && ev < 0.05 },
  { label: "EV 5% and up", test: (ev) => ev >= 0.05 },
];

export function byEvBucket(rows: NhlEdgeLogRow[]): Group[] {
  return EV_BUCKETS.map((b) => summarize(b.label, rows.filter((r) => b.test(r.ev))));
}

export function byMarket(rows: NhlEdgeLogRow[]): Group[] {
  return (["Moneyline", "Puck line", "Total"] as const).map((m) => summarize(m, rows.filter((r) => r.market === m)));
}

/** Model probability vs how often the side actually won (pushes excluded), in ten equal-count slices. */
export function calibration(rows: NhlEdgeLogRow[]): { label: string; n: number; model: number; actual: number }[] {
  const live = rows.filter((r) => r.result === "win" || r.result === "loss").sort((a, b) => a.model_prob - b.model_prob);
  if (live.length < 20) return [];
  const slices = 10;
  return Array.from({ length: slices }, (_, i) => {
    const part = live.slice(Math.floor((i * live.length) / slices), Math.floor(((i + 1) * live.length) / slices));
    return {
      label: `${(Math.min(...part.map((r) => r.model_prob)) * 100).toFixed(0)}–${(Math.max(...part.map((r) => r.model_prob)) * 100).toFixed(0)}%`,
      n: part.length,
      model: mean(part.map((r) => r.model_prob)),
      actual: part.filter((r) => r.result === "win").length / part.length,
    };
  });
}

export type GoalieCallGroup = {
  label: string;
  n: number;
  /** How often our top pick (the goalie we gave the highest probability) was the one who started. */
  topHit: number | null;
  /** How often ESPN's named goalie started (null when ESPN named nobody in this group). */
  espnHit: number | null;
  /** Average probability we gave the goalie who actually started. */
  avgP: number | null;
  /** -mean(log p) on the actual starter, probabilities floored at 2% - lower is better. */
  logLoss: number | null;
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function goalieGroup(label: string, rows: NhlGoalieCallRow[]): GoalieCallGroup {
  const top = rows.filter((r) => r.hit_top !== null).map((r) => (r.hit_top ? 1 : 0));
  const espn = rows.filter((r) => r.hit_espn !== null).map((r) => (r.hit_espn ? 1 : 0));
  const p = rows.map((r) => r.p_actual).filter((x): x is number => x !== null);
  return {
    label,
    n: rows.length,
    topHit: avg(top),
    espnHit: avg(espn),
    avgP: avg(p),
    logLoss: p.length ? -(p.reduce((s, x) => s + Math.log(Math.max(x, 0.02)), 0) / p.length) : null,
  };
}

/** Goalie-call accuracy by what we knew: ESPN confirmed, ESPN expected, nothing from ESPN - at the last look before the game. */
export function goalieCallGroups(rows: NhlGoalieCallRow[], kind: "first" | "last"): GoalieCallGroup[] {
  const r = rows.filter((x) => x.kind === kind && x.source !== "locked");
  return [
    goalieGroup("ESPN: confirmed", r.filter((x) => x.source === "espn_confirmed")),
    goalieGroup("ESPN: expected", r.filter((x) => x.source === "espn_expected")),
    goalieGroup("No ESPN call (usage model only)", r.filter((x) => x.source === "usage")),
    goalieGroup("All calls", r),
  ];
}
