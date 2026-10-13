import { americanToProb } from "./nhlModel";

/** What we store per game (games + nhl_game_xg + nhl_predictions' last pre-game state), reduced to one team's point of view. */
export type TeamGameRow = {
  gameId: number;
  startDate: string;
  completed: boolean;
  live: boolean;
  isHome: boolean;
  opp: string;
  teamPts: number | null;
  oppPts: number | null;
  /** Actual expected goals created / allowed by this team (all situations, live-net). */
  xgFor: number | null;
  xgAgainst: number | null;
  /** The model's last pre-game numbers, from this team's side. */
  model: { win: number; expFor: number; expAgainst: number; expTotal: number } | null;
  /** DraftKings' last prices before the game (the close), from this team's side. */
  close: {
    ml: number | null;
    oppMl: number | null;
    puckLine: number | null; // this team's handicap
    puckOdds: number | null;
    oppPuckOdds: number | null;
    totalLine: number | null;
    over: number | null;
    under: number | null;
  } | null;
};

export type GameInput = {
  id: number;
  start_date: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  home_points: number | null;
  away_points: number | null;
  live_status: unknown;
};
export type XgInput = { game_id: number; home_xg: number | null; away_xg: number | null };
export type PredInput = {
  game_id: number;
  p_home: number;
  exp_home: number;
  exp_away: number;
  exp_total: number;
  market: {
    ml_home: number | null;
    ml_away: number | null;
    spread_home_line: number | null;
    spread_home_odds: number | null;
    spread_away_odds: number | null;
    total_line: number | null;
    over_odds: number | null;
    under_odds: number | null;
  } | null;
};

/** One team's rows, in the order given. */
export function teamGameRows(team: string, games: GameInput[], xg: Map<number, XgInput>, preds: Map<number, PredInput>): TeamGameRow[] {
  return games
    .filter((g) => g.home_team === team || g.away_team === team)
    .map((g) => {
      const isHome = g.home_team === team;
      const x = xg.get(g.id);
      const p = preds.get(g.id);
      const m = p?.market ?? null;
      const f = (n: number | null | undefined) => (n === null || n === undefined ? null : Number(n));
      return {
        gameId: g.id,
        startDate: g.start_date,
        completed: g.completed,
        live: Boolean(g.live_status) && !g.completed,
        isHome,
        opp: isHome ? g.away_team : g.home_team,
        teamPts: isHome ? g.home_points : g.away_points,
        oppPts: isHome ? g.away_points : g.home_points,
        xgFor: f(isHome ? x?.home_xg : x?.away_xg),
        xgAgainst: f(isHome ? x?.away_xg : x?.home_xg),
        model: p
          ? {
              win: isHome ? Number(p.p_home) : 1 - Number(p.p_home),
              expFor: Number(isHome ? p.exp_home : p.exp_away),
              expAgainst: Number(isHome ? p.exp_away : p.exp_home),
              expTotal: Number(p.exp_total),
            }
          : null,
        close:
          m && (m.ml_home !== null || m.total_line !== null)
            ? {
                ml: isHome ? m.ml_home : m.ml_away,
                oppMl: isHome ? m.ml_away : m.ml_home,
                puckLine: m.spread_home_line === null ? null : isHome ? m.spread_home_line : -m.spread_home_line,
                puckOdds: isHome ? m.spread_home_odds : m.spread_away_odds,
                oppPuckOdds: isHome ? m.spread_away_odds : m.spread_home_odds,
                totalLine: m.total_line,
                over: m.over_odds,
                under: m.under_odds,
              }
            : null,
      };
    });
}

export type MarketResult = { ml: "win" | "loss" | null; puck: "cover" | "no" | null; total: "over" | "under" | "push" | null };

/** How the finished game fell against DraftKings' closing prices (null parts where there was no close). */
export function marketResult(r: TeamGameRow): MarketResult {
  const out: MarketResult = { ml: null, puck: null, total: null };
  if (!r.completed || r.teamPts === null || r.oppPts === null) return out;
  const margin = r.teamPts - r.oppPts;
  if (r.close) {
    if (r.close.ml !== null) out.ml = margin > 0 ? "win" : "loss";
    if (r.close.puckLine !== null) out.puck = margin + r.close.puckLine > 0 ? "cover" : "no";
    if (r.close.totalLine !== null) {
      const t = r.teamPts + r.oppPts;
      out.total = t > r.close.totalLine ? "over" : t < r.close.totalLine ? "under" : "push";
    }
  }
  return out;
}

/** Profit on a 1-unit bet at an American price (win/loss only; pushes return the stake). */
const profit = (odds: number, won: boolean) => (won ? (odds > 0 ? odds / 100 : 100 / -odds) : -1);

export type TeamSummary = {
  games: number;
  wins: number;
  losses: number;
  gf: number;
  ga: number;
  xgf: number | null;
  xga: number | null;
  xgShare: number | null;
  modelN: number;
  modelWin: number | null; // average model win probability
  actualWin: number | null; // how often the team actually won those games
  closeN: number;
  mlUnits: number; // flat 1u on this team's moneyline at the close
  coverW: number;
  coverL: number;
  over: number;
  under: number;
  push: number;
};

/** Trends over the completed games in `rows`. */
export function summarizeTeam(rows: TeamGameRow[]): TeamSummary {
  const done = rows.filter((r) => r.completed && r.teamPts !== null && r.oppPts !== null);
  const wins = done.filter((r) => (r.teamPts as number) > (r.oppPts as number)).length;
  const withXg = done.filter((r) => r.xgFor !== null && r.xgAgainst !== null);
  const xgf = withXg.reduce((s, r) => s + (r.xgFor as number), 0);
  const xga = withXg.reduce((s, r) => s + (r.xgAgainst as number), 0);
  const withModel = done.filter((r) => r.model);
  const closed = done.filter((r) => r.close);
  let units = 0;
  let cw = 0;
  let cl = 0;
  let over = 0;
  let under = 0;
  let push = 0;
  for (const r of closed) {
    const res = marketResult(r);
    if (res.ml && r.close?.ml !== null && r.close?.ml !== undefined) units += profit(r.close.ml, res.ml === "win");
    if (res.puck === "cover") cw++;
    else if (res.puck === "no") cl++;
    if (res.total === "over") over++;
    else if (res.total === "under") under++;
    else if (res.total === "push") push++;
  }
  const n = done.length;
  return {
    games: n,
    wins,
    losses: n - wins,
    gf: n ? done.reduce((s, r) => s + (r.teamPts as number), 0) / n : 0,
    ga: n ? done.reduce((s, r) => s + (r.oppPts as number), 0) / n : 0,
    xgf: withXg.length ? xgf / withXg.length : null,
    xga: withXg.length ? xga / withXg.length : null,
    xgShare: withXg.length && xgf + xga > 0 ? xgf / (xgf + xga) : null,
    modelN: withModel.length,
    modelWin: withModel.length ? withModel.reduce((s, r) => s + (r.model as NonNullable<TeamGameRow["model"]>).win, 0) / withModel.length : null,
    actualWin: withModel.length ? withModel.filter((r) => (r.teamPts as number) > (r.oppPts as number)).length / withModel.length : null,
    closeN: closed.length,
    mlUnits: units,
    coverW: cw,
    coverL: cl,
    over,
    under,
    push,
  };
}

/** The no-vig win probability the market had for this team at the close, when both prices exist. */
export function marketWin(r: TeamGameRow): number | null {
  if (!r.close || r.close.ml === null || r.close.oppMl === null) return null;
  const a = americanToProb(r.close.ml);
  const b = americanToProb(r.close.oppMl);
  return a / (a + b);
}

/** Eastern-time calendar day ("2026-10-13") of an instant - the NHL's schedule day. */
export function etDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
