/** What a game between two teams should look like, from their published ratings - the same formula as python/cbb_model/ratings.py.
 * `off`/`def` are absolute points per 100 possessions (league average = mu), `tempo` is possessions per 40 minutes relative to
 * the average team (mu_t). */
export type TeamLine = { off: number; def: number; tempo: number; mu: number; hca: number; mu_t: number };

export function teamLine(stats: Record<string, number | string | null> | undefined): TeamLine | null {
  if (!stats) return null;
  const n = (k: string) => (typeof stats[k] === "number" ? (stats[k] as number) : null);
  const off = n("off");
  const def = n("def");
  const tempo = n("tempo");
  const mu = n("mu");
  const hca = n("hca");
  const mu_t = n("mu_t");
  if (off === null || def === null || tempo === null || mu === null || hca === null || mu_t === null) return null;
  return { off, def, tempo, mu, hca, mu_t };
}

export type Projection = { homePts: number; awayPts: number; spread: number; total: number; poss: number; homeWin: number };

/** Standard normal CDF (Abramowitz-Stegun), for turning a spread into a win probability. */
function phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

const MARGIN_SD = 11.3; // standard deviation of a D1 game's final margin around the line (measured 11.27 vs closing lines, 2022-25; the market's moneylines imply 11.8)

export function project(home: TeamLine, away: TeamLine, neutral: boolean): Projection {
  const mu = (home.mu + away.mu) / 2;
  const hca = neutral ? 0 : (home.hca + away.hca) / 2;
  const poss = (home.mu_t + away.mu_t) / 2 + home.tempo + away.tempo;
  const homePts = ((mu + hca + (home.off - home.mu) + (away.def - away.mu)) * poss) / 100;
  const awayPts = ((mu - hca + (away.off - away.mu) + (home.def - home.mu)) * poss) / 100;
  const spread = homePts - awayPts;
  return { homePts, awayPts, spread, total: homePts + awayPts, poss, homeWin: phi(spread / MARGIN_SD) };
}
