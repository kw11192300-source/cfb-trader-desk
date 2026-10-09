/**
 * TypeScript port of python/nhl_model/sim.py's `simulate` + `summarize_sim`, used ONLY to re-run
 * one game instantly when a goalie is locked in on the game page (the full model - history,
 * ratings, calibration - is Python and runs in the refresh job; it saves each game's inputs in
 * nhl_predictions.sim_params, and this replays the Monte Carlo from those inputs with a different
 * goalie). Keep the two in step: if sim.py's game logic changes, change this too - the parity check
 * in scripts/nhl-sim-parity.ts compares them on the saved inputs.
 *
 * One simulated game: minutes 0-57 by strength state (random power plays that end when they score,
 * even strength otherwise), the empirical last three minutes by lead, then overtime / shootout with
 * the official one-goal credit for the winner.
 */

export type SimRates = {
  r_ev_h: number; // xG per minute, even strength
  r_ev_a: number;
  r_pp_h: number; // xG per minute on the power play
  r_pp_a: number;
  pens_h: number; // expected power plays drawn in a full game
  pens_a: number;
  r_sh: number; // xG per minute shorthanded (league)
  conv: number; // xG -> goals, before the goalie
  beta: number; // goalie effect: goals multiplier = exp(beta * (rating - gbar))
  gbar: number;
};

export type SimTables = {
  pen_minor: number;
  pen_double: number;
  pen_major: number;
  late: Record<string, { pairs: number[][]; cum: number[] }>; // lead (0,1,2,3+) -> empirical last-3:00 goals
  p_ot: number;
  home_ot: number;
  home_so: number;
};

export type GoalieScenario = { rating: number; weight: number };

export type SimSummary = {
  p_home: number;
  p_home_reg: number;
  p_tie_reg: number;
  p_shootout: number;
  exp_home: number;
  exp_away: number;
  exp_total: number;
  total_dist: Record<string, number>;
  margin_dist: Record<string, number>;
  score_matrix: number[][];
  score_matrix_reg: number[][];
  extras: { reg_total_dist: Record<string, number>; ot_total_dist: Record<string, number>; exp_total_reg: number; n_sims: number };
};

const REG_SECONDS_SIM = 3420; // 57:00
const MAX_PEN = 9;

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** One team's power plays across minutes 0-57: seconds on the power play and power-play goals. */
function ppBlock(rng: () => number, lam: number, rateSec: number, t: SimTables): [number, number] {
  const cnt = Math.min(poisson(rng, (lam * REG_SECONDS_SIM) / 3600), MAX_PEN);
  const rate = Math.max(rateSec, 1e-9);
  let len = 0;
  let goals = 0;
  for (let i = 0; i < cnt; i++) {
    const u = rng();
    if (u < t.pen_major) {
      len += 300;
      goals += poisson(rng, rateSec * 300);
    } else {
      const segments = u < t.pen_major + t.pen_double ? 2 : 1; // a double minor is two back-to-back minors
      for (let j = 0; j < segments; j++) {
        const tGoal = -Math.log(1 - rng()) / rate;
        len += Math.min(120, tGoal);
        if (tGoal < 120) goals += 1;
      }
    }
  }
  return [len, goals];
}

function lateGoals(rng: () => number, lead: number, t: SimTables): [number, number] {
  const m = lead === 0 ? 0 : Math.min(Math.abs(lead), 3);
  const { pairs, cum } = t.late[String(m)];
  const u = rng();
  let i = 0;
  while (i < cum.length - 1 && cum[i] < u) i++;
  const [x, y] = pairs[i];
  if (m === 0) return [x, y]; // tied: (home, away)
  return lead > 0 ? [x, y] : [y, x]; // otherwise (leader, trailer)
}

/** Runs `nSims` games across the goalie scenarios (a mixture when a starter isn't certain) and summarizes
 * them the same way publish.py does. */
export function simulateGame(
  rates: SimRates,
  tables: SimTables,
  homeGoalies: GoalieScenario[],
  awayGoalies: GoalieScenario[],
  nSims = 40000,
  seed = 12345,
): SimSummary {
  const combos = homeGoalies.flatMap((h) => awayGoalies.map((a) => ({ h, a, w: h.weight * a.weight })));
  const counts = combos.map((c) => Math.floor(nSims * c.w));
  const top = combos.reduce((best, c, i) => (c.w > combos[best].w ? i : best), 0);
  counts[top] += nSims - counts.reduce((s, n) => s + n, 0);

  const rng = makeRng(seed);
  const totalFinal = new Array(17).fill(0);
  const totalReg = new Array(17).fill(0);
  const totalOt = new Array(17).fill(0);
  const margin = new Array(17).fill(0); // -8..8
  const gridFinal = Array.from({ length: 10 }, () => new Array(10).fill(0));
  const gridReg = Array.from({ length: 10 }, () => new Array(10).fill(0));
  let homeWins = 0;
  let homeRegWins = 0;
  let ties = 0;
  let shootouts = 0;
  let sumH = 0;
  let sumA = 0;
  let sumReg = 0;
  let sumFinal = 0;
  let n = 0;

  combos.forEach((c, ci) => {
    const convH = rates.conv * Math.exp(rates.beta * (c.a.rating - rates.gbar)); // home shots face the AWAY goalie
    const convA = rates.conv * Math.exp(rates.beta * (c.h.rating - rates.gbar));
    const ppHSec = (rates.r_pp_h * convH) / 60;
    const ppASec = (rates.r_pp_a * convA) / 60;
    const shH = (rates.r_sh * convH) / 60;
    const shA = (rates.r_sh * convA) / 60;
    const evH = (rates.r_ev_h * convH) / 60;
    const evA = (rates.r_ev_a * convA) / 60;
    for (let s = 0; s < counts[ci]; s++) {
      const [lenH, gPPH] = ppBlock(rng, rates.pens_h, ppHSec, tables); // home power plays
      const [lenA, gPPA] = ppBlock(rng, rates.pens_a, ppASec, tables); // away power plays
      const shGoalsH = poisson(rng, shH * lenA);
      const shGoalsA = poisson(rng, shA * lenH);
      const evSec = Math.max(REG_SECONDS_SIM - lenH - lenA, 300);
      const h57 = poisson(rng, evH * evSec) + gPPH + shGoalsH;
      const a57 = poisson(rng, evA * evSec) + gPPA + shGoalsA;
      const [lh, la] = lateGoals(rng, h57 - a57, tables);
      const regH = h57 + lh;
      const regA = a57 + la;

      const tie = regH === regA;
      const decidedOt = rng() < tables.p_ot;
      const homeExtra = rng() < (decidedOt ? tables.home_ot : tables.home_so);
      const finH = regH + (tie && homeExtra ? 1 : 0);
      const finA = regA + (tie && !homeExtra ? 1 : 0);
      const otH = regH + (tie && decidedOt && homeExtra ? 1 : 0); // through overtime, no shootout credit
      const otA = regA + (tie && decidedOt && !homeExtra ? 1 : 0);

      n++;
      sumH += finH;
      sumA += finA;
      sumReg += regH + regA;
      sumFinal += finH + finA;
      if (finH > finA) homeWins++;
      if (regH > regA) homeRegWins++;
      if (tie) {
        ties++;
        if (!decidedOt) shootouts++;
      }
      const tf = finH + finA;
      const tr = regH + regA;
      const to = otH + otA;
      if (tf <= 16) totalFinal[tf]++;
      if (tr <= 16) totalReg[tr]++;
      if (to <= 16) totalOt[to]++;
      const m = finH - finA;
      if (m >= -8 && m <= 8) margin[m + 8]++;
      gridFinal[Math.min(finH, 9)][Math.min(finA, 9)]++;
      gridReg[Math.min(regH, 9)][Math.min(regA, 9)]++;
    }
  });

  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  const dist = (arr: number[], offset = 0): Record<string, number> => Object.fromEntries(arr.map((v, i) => [String(i + offset), r5(v / n)]));
  const norm = (g: number[][]) => g.map((row) => row.map((v) => r5(v / n)));
  return {
    p_home: r5(homeWins / n),
    p_home_reg: r5(homeRegWins / n),
    p_tie_reg: r5(ties / n),
    p_shootout: r5(shootouts / n),
    exp_home: Math.round((sumH / n) * 1e3) / 1e3,
    exp_away: Math.round((sumA / n) * 1e3) / 1e3,
    exp_total: Math.round((sumFinal / n) * 1e3) / 1e3,
    total_dist: dist(totalFinal),
    margin_dist: dist(margin, -8),
    score_matrix: norm(gridFinal),
    score_matrix_reg: norm(gridReg),
    extras: { reg_total_dist: dist(totalReg), ot_total_dist: dist(totalOt), exp_total_reg: Math.round((sumReg / n) * 1e3) / 1e3, n_sims: n },
  };
}
