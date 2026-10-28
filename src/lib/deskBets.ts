import type { GradedBet } from "./data";

/** A bet reduced to what the desk lists need (plain data, so it can cross from a server page into a client component). */
export type DeskBet = {
  id: number;
  sport: string;
  market: string;
  side: string;
  player: string | null;
  propType: string | null;
  legs: string[] | null;
  line: number;
  odds: number;
  stake: number;
  book: string | null;
  status: "pending" | "win" | "loss" | "push";
  profit: number | null;
  placedAt: string;
  gameId: number | null;
  start: string | null; // game start (ISO)
  away: string | null;
  home: string | null;
  completed: boolean;
  live: boolean; // the game is in progress
  liveDetail: string | null;
  awayPts: number | null;
  homePts: number | null;
};

/** The slim row the by-day history table needs for every bet ever logged: when it belongs (game start, or the day a parlay was placed). */
export type HistBet = { t: string; sport: string; stake: number; status: "pending" | "win" | "loss" | "push"; profit: number | null };

/** Graded bets -> desk rows. `windowDays` keeps bets whose game is within that many days of now (pending bets are always kept). */
export function toDeskBets(all: GradedBet[], windowDays?: number): DeskBet[] {
  const now = Date.now();
  const out: DeskBet[] = [];
  for (const g of all) {
    const b = g.bet;
    const start = g.game?.start_date ?? null;
    if (windowDays !== undefined) {
      const at = new Date(start ?? b.placed_at).getTime();
      if (Math.abs(at - now) > windowDays * 86_400_000 && g.status !== "pending") continue;
    }
    out.push({
      id: b.id,
      sport: b.sport,
      market: b.market,
      side: b.side,
      player: b.player,
      propType: b.prop_type,
      legs: b.legs,
      line: b.line,
      odds: b.odds,
      stake: b.stake,
      book: b.sportsbook,
      status: g.status,
      profit: g.profit,
      placedAt: b.placed_at,
      gameId: b.game_id,
      start,
      away: g.game?.away_team ?? null,
      home: g.game?.home_team ?? null,
      completed: Boolean(g.game?.completed),
      live: Boolean(g.game?.live_status) && !g.game?.completed,
      liveDetail: g.game?.live_status?.detail ?? null,
      awayPts: g.game?.away_points ?? null,
      homePts: g.game?.home_points ?? null,
    });
  }
  return out;
}

export const toHistory = (all: GradedBet[]): HistBet[] => all.map((g) => ({ t: g.game?.start_date ?? g.bet.placed_at, sport: g.bet.sport, stake: g.bet.stake, status: g.status, profit: g.profit }));
