// Checks the TypeScript simulator against the Python one on the SAME saved inputs.
// Usage:  cd python && python -m nhl_model.publish --dry-run   (writes data/nhl/last_publish.json)
//         TS_SIMS=400000 node --experimental-strip-types scripts/nhl-sim-parity.ts
// Both sides are Monte Carlo with different random streams, so they can never match exactly: a
// large TS sample makes the mean SIGNED gap (a real porting error shows up there; noise averages
// out) the number to read, and the worst-game gap should be about Python's own noise (~0.3-0.5 pts).
import { readFileSync } from "node:fs";
import { simulateGame, type GoalieScenario, type SimRates, type SimTables } from "../src/lib/nhlSim.ts";

type Row = {
  game_id: number;
  p_home: number;
  exp_total: number;
  total_dist: Record<string, number>;
  margin_dist: Record<string, number>;
  assumptions: { goalies: { home: GoalieScenario[]; away: GoalieScenario[] } };
  sim_params: { rates: SimRates; tables: SimTables };
};

const pub = JSON.parse(readFileSync("python/data/nhl/last_publish.json", "utf8")) as { predictions: Row[] };
const nSims = Number(process.env.TS_SIMS ?? 40000);
const over = (d: Record<string, number>, line: number) => Object.entries(d).reduce((s, [k, v]) => s + (Number(k) > line ? v : 0), 0);
const cover = (d: Record<string, number>) => Object.entries(d).reduce((s, [k, v]) => s + (Number(k) >= 2 ? v : 0), 0);

const worst = { p: 0, tot: 0, over: 0, cover: 0 };
const bias = { p: 0, tot: 0, over: 0, cover: 0 };
for (const r of pub.predictions) {
  const g = r.assumptions.goalies;
  const ts = simulateGame(r.sim_params.rates, r.sim_params.tables, g.home, g.away, nSims, Math.abs(r.game_id) % 1000003);
  const d = {
    p: ts.p_home - r.p_home,
    tot: ts.exp_total - r.exp_total,
    over: over(ts.total_dist, 5.5) - over(r.total_dist, 5.5),
    cover: cover(ts.margin_dist) - cover(r.margin_dist),
  };
  for (const k of ["p", "tot", "over", "cover"] as const) {
    bias[k] += d[k];
    worst[k] = Math.max(worst[k], Math.abs(d[k]));
  }
}
const n = pub.predictions.length;
const pts = (x: number) => `${(x * 100).toFixed(2)} pts`;
console.log(`${n} games, ${nSims} TS sims each`);
console.log(`mean SIGNED gap (TS - Python): P(home win) ${pts(bias.p / n)} | expected total ${(bias.tot / n).toFixed(3)} | P(over 5.5) ${pts(bias.over / n)} | P(home -1.5) ${pts(bias.cover / n)}`);
console.log(`worst single game:             P(home win) ${pts(worst.p)} | expected total ${worst.tot.toFixed(3)} | P(over 5.5) ${pts(worst.over)} | P(home -1.5) ${pts(worst.cover)}`);
