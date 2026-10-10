import { marketEdges } from "./nhlEdges";
import { overUnder, probToAmerican } from "./nhlModel";
import { simulateGame, type GoalieScenario } from "./nhlSim";
import type { NhlPrediction } from "./types";

export type ScenarioRow = {
  key: string;
  /** "As modeled" is the model's current assumption (a hedge across the likely starters). */
  asModeled: boolean;
  away: string;
  home: string;
  awayRating: number | null;
  homeRating: number | null;
  pHome: number;
  /** Home win as a fair American price. */
  homeOdds: number | null;
  expTotal: number;
  /** P(over the book's total), pushes refunded; null when there is no total posted. */
  overAtBook: number | null;
  bookTotal: number | null;
  /** The best DraftKings side in this scenario by EV (null when there are no lines). */
  best: { side: string; market: string; ev: number; bookOdds: number } | null;
};

const SIMS = 12000;
const nick = (t: string) => t.split(" ").slice(-1)[0];

type PoolGoalie = { id: number | null; name: string; rating: number };
type Option = { name: string; rating: number | null; scenario: GoalieScenario[] };

/** The goalies worth running for one side: just the starter when he is confirmed (or locked), otherwise the two most likely
 * starters, with a replacement-level goalie only if there aren't two to choose from. */
function optionsFor(pool: PoolGoalie[], current: { name: string; weight: number; rating: number }[], settled: boolean): Option[] {
  const seen = new Set<string>();
  const out: Option[] = [];
  const candidates = [...current].sort((a, b) => b.weight - a.weight).map((c) => ({ id: null as number | null, name: c.name, rating: c.rating }));
  const limit = settled ? 1 : 2;
  for (const g of settled ? candidates : [...candidates, ...pool]) {
    if (seen.has(g.name) || g.name.startsWith("Other")) continue;
    seen.add(g.name);
    out.push({ name: g.name, rating: g.rating, scenario: [{ rating: g.rating, weight: 1 }] });
    if (out.length === limit) break;
  }
  if (out.length < limit || out.length === 0) out.push({ name: "Replacement-level (league average)", rating: 0, scenario: [{ rating: 0, weight: 1 }] });
  return out;
}

/** Re-runs the game for each plausible goalie combination so you can see how much of an edge depends on who starts. Uses
 * the same inputs the live model used (stored with the prediction), so the "as modeled" row matches the headline numbers. */
export function goalieScenarios(pred: NhlPrediction, home: string, away: string): ScenarioRow[] {
  const sp = pred.sim_params;
  const a = pred.assumptions;
  if (!sp || !a) return [];
  const seed = Math.abs(pred.game_id) % 1000003;
  const toScenario = (g: { rating: number; weight: number }): GoalieScenario => ({ rating: g.rating, weight: g.weight });

  const run = (homeG: GoalieScenario[], awayG: GoalieScenario[]) => {
    const s = simulateGame(sp.rates, sp.tables, homeG, awayG, SIMS, seed);
    const m = pred.market;
    const line = m?.total_line ?? null;
    let over: number | null = null;
    if (line !== null) {
      const { over: o, under: u } = overUnder(s.total_dist, line);
      over = o + u > 0 ? o / (o + u) : null;
    }
    const edges = marketEdges({ p_home: s.p_home, margin_dist: s.margin_dist, total_dist: s.total_dist, market: m }, home, away);
    const best = edges.length > 0 ? edges.reduce((x, y) => (y.ev > x.ev ? y : x)) : null;
    return {
      pHome: s.p_home,
      homeOdds: probToAmerican(s.p_home),
      expTotal: s.exp_total,
      overAtBook: over,
      bookTotal: line,
      best: best ? { side: best.side.replace(away, nick(away)).replace(home, nick(home)), market: best.market, ev: best.ev, bookOdds: best.bookOdds } : null,
    };
  };

  const label = (g: { name: string; weight: number }[]) =>
    g.length === 0 ? "—" : g.length === 1 ? g[0].name : g.map((x) => `${x.name} ${Math.round(x.weight * 100)}%`).join(" / ");
  const rating = (g: { rating: number; weight: number }[]) => (g.length === 0 ? null : g.reduce((s, x) => s + x.rating * x.weight, 0));

  const rows: ScenarioRow[] = [];
  const curHome = a.goalies.home;
  const curAway = a.goalies.away;
  rows.push({
    key: "as-modeled",
    asModeled: true,
    away: label(curAway),
    home: label(curHome),
    awayRating: rating(curAway),
    homeRating: rating(curHome),
    ...run(curHome.map(toScenario), curAway.map(toScenario)),
  });

  const settled = (side: "home" | "away") => Boolean(a.confirmed?.[side]) || a.sources?.[side] === "locked";
  const awayOpts = optionsFor(sp.pool.away, curAway, settled("away"));
  const homeOpts = optionsFor(sp.pool.home, curHome, settled("home"));
  for (const ao of awayOpts) {
    for (const ho of homeOpts) {
      rows.push({ key: `${ao.name}|${ho.name}`, asModeled: false, away: ao.name, home: ho.name, awayRating: ao.rating, homeRating: ho.rating, ...run(ho.scenario, ao.scenario) });
    }
  }
  return rows;
}
