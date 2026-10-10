import { supabase } from "./supabase";
import { supabaseAdmin } from "./supabase-admin";
import { type DisplayLine, mergeLines, pickHeadlineLine } from "./mergedLines";
import { devigTwoWay } from "./oddsMath";
import type { EdgeInputs } from "./nhlEdges";
import type {
  Bet,
  BettingLine,
  BoardRow,
  Game,
  LineSnapshot,
  ModelBacktest,
  ModelBacktestGame,
  NhlEdgeLogRow,
  NhlGameXg,
  NhlGoalieCallRow,
  NhlGoalieStatsRow,
  NhlOddsSnapshot,
  NhlSkaterRatingRow,
  NhlTeamStatsRow,
  NhlPrediction,
  OddsApiLine,
  Prediction,
  PredictionMarketLine,
  SeasonFuture,
  Team,
  TeamPowerRating,
  WatchlistPick,
} from "./types";

/**
 * Same idea as the Python side's current_week.py: the earliest
 * not-yet-completed game is "the current week." Kept as its own query (not
 * shared code with Python) since it's a two-line lookup, not worth a
 * cross-language shared module for.
 *
 * Checks both this calendar year and last as the `season` value - a season
 * is stored by start-year, but one that crosses the calendar boundary
 * (NFL/NHL) still has real games in the new year; filtering to only
 * today's year would make every one of those invisible to this query once
 * January hits. No-op widening for CFB, which never crosses the boundary.
 */
export async function getCurrentWeek(sport: string = "cfb"): Promise<{ season: number; week: number; seasonType: string } | null> {
  const year = new Date().getFullYear();
  // Same stale cutoff as current_week.py: a game that kicked off 18+ hours
  // ago and still isn't completed is stale data, not in progress - without
  // this, one game the score sync can never find permanently pins the
  // whole site on its own week.
  const staleCutoff = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("games")
    .select("season, week, season_type, start_date")
    .eq("sport", sport)
    .in("season", [year, year - 1])
    .eq("completed", false)
    .gt("start_date", staleCutoff)
    .order("start_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { season: data.season, week: data.week, seasonType: data.season_type };
}

/** Every distinct (regular-season) week this season has at least one game
 * for, ascending - powers the Board's week tabs. Not restricted to weeks
 * up to "current" - the full schedule is usually backfilled well ahead,
 * so future weeks show up too (browsing ahead works the same as back). */
export async function getAvailableWeeks(season: number, sport: string = "cfb"): Promise<number[]> {
  const { data, error } = await supabase
    .from("games")
    .select("week")
    .eq("sport", sport)
    .eq("season", season)
    .eq("season_type", "regular");
  if (error) throw new Error(error.message);
  const weeks = Array.from(new Set((data ?? []).map((r) => r.week as number)));
  return weeks.sort((a, b) => a - b);
}

/** Joins a list of games with every book's line for each, both teams' logos,
 * and the model's own prediction for each game if one exists (most games
 * won't have one yet - only week-1 FBS-vs-FBS games do right now). */
async function buildBoardRows(games: Game[]): Promise<BoardRow[]> {
  const gameIds = games.map((g) => g.id);
  const teamIds = Array.from(new Set(games.flatMap((g) => [g.home_id, g.away_id]).filter((id): id is number => id !== null)));

  const [
    { data: lines, error: linesError },
    { data: oddsApiLines, error: oddsApiError },
    { data: teams, error: teamsError },
    { data: predictions, error: predictionsError },
  ] = await Promise.all([
    gameIds.length > 0
      ? supabase.from("betting_lines").select("*").in("game_id", gameIds)
      : Promise.resolve({ data: [] as BettingLine[], error: null }),
    gameIds.length > 0
      ? supabase.from("odds_api_lines").select("*").in("game_id", gameIds)
      : Promise.resolve({ data: [] as OddsApiLine[], error: null }),
    teamIds.length > 0
      ? supabase.from("teams").select("*").in("id", teamIds)
      : Promise.resolve({ data: [] as Team[], error: null }),
    gameIds.length > 0
      ? supabase.from("predictions").select("*").in("game_id", gameIds)
      : Promise.resolve({ data: [] as Prediction[], error: null }),
  ]);
  if (linesError) throw new Error(linesError.message);
  if (oddsApiError) throw new Error(oddsApiError.message);
  if (teamsError) throw new Error(teamsError.message);
  if (predictionsError) throw new Error(predictionsError.message);

  const linesByGame = new Map<number, BettingLine[]>();
  for (const line of (lines ?? []) as BettingLine[]) {
    const list = linesByGame.get(line.game_id) ?? [];
    list.push(line);
    linesByGame.set(line.game_id, list);
  }
  const oddsApiByGame = new Map<number, OddsApiLine[]>();
  for (const line of (oddsApiLines ?? []) as OddsApiLine[]) {
    const list = oddsApiByGame.get(line.game_id) ?? [];
    list.push(line);
    oddsApiByGame.set(line.game_id, list);
  }
  const teamById = new Map((teams as Team[]).map((t) => [t.id, t]));
  // If a game somehow ends up with predictions from more than one model
  // version, keep the newest - a stale superseded prediction isn't useful.
  const predictionByGame = new Map<number, Prediction>();
  for (const p of (predictions ?? []) as Prediction[]) {
    const existing = predictionByGame.get(p.game_id);
    if (!existing || new Date(p.created_at) > new Date(existing.created_at)) {
      predictionByGame.set(p.game_id, p);
    }
  }

  return games.map((game) => ({
    game,
    lines: linesByGame.get(game.id) ?? [],
    oddsApiLines: oddsApiByGame.get(game.id) ?? [],
    homeLogo: game.home_id !== null ? (teamById.get(game.home_id)?.logo_url ?? null) : null,
    awayLogo: game.away_id !== null ? (teamById.get(game.away_id)?.logo_url ?? null) : null,
    prediction: predictionByGame.get(game.id) ?? null,
  }));
}

/** The Board for one specific week, or the current week if none is given.
 * Includes BOTH upcoming/live and already-completed games (unlike the old
 * completed=false-only query) - ordered so completed ones sort after
 * everything still in play, chronologically within each group, so a
 * finished week reads top-to-bottom the same as a live one, with finals
 * naturally landing at the bottom. */
export async function getBoard(
  season?: number,
  week?: number,
  seasonType?: string,
  sport: string = "cfb",
): Promise<{
  season: number;
  week: number;
  seasonType: string;
  rows: BoardRow[];
} | null> {
  let target: { season: number; week: number; seasonType: string };
  if (season !== undefined && week !== undefined && seasonType !== undefined) {
    target = { season, week, seasonType };
  } else {
    const current = await getCurrentWeek(sport);
    if (!current) return null;
    target = current;
  }

  const { data: games, error: gamesError } = await supabase
    .from("games")
    .select("*")
    .eq("sport", sport)
    .eq("season", target.season)
    .eq("week", target.week)
    .eq("season_type", target.seasonType)
    .order("completed", { ascending: true })
    .order("start_date", { ascending: true });
  if (gamesError) throw new Error(gamesError.message);

  const rows = await buildBoardRows(games as Game[]);
  return { season: target.season, week: target.week, seasonType: target.seasonType, rows };
}

export type GameDetail = {
  game: Game;
  lines: BettingLine[];
  oddsApiLines: OddsApiLine[];
  homeTeam: Team | null;
  awayTeam: Team | null;
  prediction: Prediction | null;
  predictionMarkets: PredictionMarketLine[];
};

export async function getGame(id: number): Promise<GameDetail | null> {
  const { data: game, error: gameError } = await supabase.from("games").select("*").eq("id", id).maybeSingle();
  if (gameError) throw new Error(gameError.message);
  if (!game) return null;

  const teamIds = [game.home_id, game.away_id].filter((tid): tid is number => tid !== null);
  const [
    { data: lines, error: linesError },
    { data: oddsApiLines, error: oddsApiError },
    { data: teams, error: teamsError },
    { data: predictions, error: predictionsError },
    { data: predictionMarkets, error: predictionMarketsError },
  ] = await Promise.all([
    supabase.from("betting_lines").select("*").eq("game_id", id),
    supabase.from("odds_api_lines").select("*").eq("game_id", id),
    teamIds.length > 0 ? supabase.from("teams").select("*").in("id", teamIds) : Promise.resolve({ data: [] as Team[], error: null }),
    supabase.from("predictions").select("*").eq("game_id", id),
    supabase.from("prediction_market_lines").select("*").eq("game_id", id),
  ]);
  if (linesError) throw new Error(linesError.message);
  if (oddsApiError) throw new Error(oddsApiError.message);
  if (teamsError) throw new Error(teamsError.message);
  if (predictionsError) throw new Error(predictionsError.message);
  if (predictionMarketsError) throw new Error(predictionMarketsError.message);

  const teamById = new Map((teams as Team[]).map((t) => [t.id, t]));
  // Same "keep the newest if more than one model version predicted this
  // game" rule as the board - see buildBoardRows.
  const prediction = ((predictions ?? []) as Prediction[]).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )[0];
  return {
    game: game as Game,
    lines: (lines ?? []) as BettingLine[],
    oddsApiLines: (oddsApiLines ?? []) as OddsApiLine[],
    homeTeam: game.home_id !== null ? (teamById.get(game.home_id) ?? null) : null,
    awayTeam: game.away_id !== null ? (teamById.get(game.away_id) ?? null) : null,
    prediction: prediction ?? null,
    predictionMarkets: (predictionMarkets ?? []) as PredictionMarketLine[],
  };
}

/** Full poll history for a game, oldest first — what poll_lines.py has captured since it started running. */
export async function getLineHistory(gameId: number): Promise<LineSnapshot[]> {
  const { data, error } = await supabase
    .from("line_snapshots")
    .select("*")
    .eq("game_id", gameId)
    .order("captured_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as LineSnapshot[];
}

/** A power rating row with its team's logo joined in, for display. */
export type PowerRatingRow = TeamPowerRating & { logo_url: string | null };

/** CFB Trader Desk's own power ratings — current snapshot, every team (FBS + FCS), with logos. */
export async function getPowerRatings(): Promise<PowerRatingRow[]> {
  const [{ data: ratings, error: ratingsError }, { data: teams, error: teamsError }] = await Promise.all([
    // classification filter is defense in depth - sync_power_ratings.py
    // shouldn't write non-fbs/fcs rows at all, but don't rely on that alone.
    supabase.from("team_power_ratings").select("*").in("classification", ["fbs", "fcs"]).order("overall", { ascending: false, nullsFirst: false }),
    supabase.from("teams").select("id, logo_url"),
  ]);
  if (ratingsError) throw new Error(ratingsError.message);
  if (teamsError) throw new Error(teamsError.message);

  const logoById = new Map((teams as { id: number; logo_url: string | null }[]).map((t) => [t.id, t.logo_url]));
  return (ratings ?? []).map((r) => ({ ...r, logo_url: logoById.get(r.team_id) ?? null })) as PowerRatingRow[];
}

/** A model prediction joined with its game and both teams' logos, for display. */
export type EdgeRow = {
  prediction: Prediction;
  game: Game;
  homeLogo: string | null;
  awayLogo: string | null;
};

/** CFB Trader Desk's own model edges (python/modeling/predict_week1.py and
 * future serving scripts) for one model version, ranked by |edge_spread|
 * descending (biggest model-vs-market disagreement first). */
export async function getEdges(modelVersion: string): Promise<EdgeRow[]> {
  const { data: predictions, error: predError } = await supabase
    .from("predictions")
    .select("*")
    .eq("model_version", modelVersion)
    .not("edge_spread", "is", null);
  if (predError) throw new Error(predError.message);
  if (!predictions || predictions.length === 0) return [];

  const gameIds = predictions.map((p) => p.game_id);
  const [{ data: games, error: gamesError }, { data: teams, error: teamsError }] = await Promise.all([
    supabase.from("games").select("*").in("id", gameIds),
    supabase.from("teams").select("id, logo_url"),
  ]);
  if (gamesError) throw new Error(gamesError.message);
  if (teamsError) throw new Error(teamsError.message);

  const gameById = new Map((games as Game[]).map((g) => [g.id, g]));
  const logoById = new Map((teams as { id: number; logo_url: string | null }[]).map((t) => [t.id, t.logo_url]));

  return (predictions as Prediction[])
    .map((prediction) => {
      const game = gameById.get(prediction.game_id);
      if (!game) return null;
      return {
        prediction,
        game,
        homeLogo: game.home_id !== null ? (logoById.get(game.home_id) ?? null) : null,
        awayLogo: game.away_id !== null ? (logoById.get(game.away_id) ?? null) : null,
      };
    })
    .filter((r): r is EdgeRow => r !== null)
    .sort((a, b) => Math.abs(b.prediction.edge_spread ?? 0) - Math.abs(a.prediction.edge_spread ?? 0));
}

/** Week-2+ "model view" (python/modeling/predict_inseason.py) - reads a
 * SEPARATE table from getEdges' `predictions`, deliberately: this model
 * has no validated edge (see /edges page's own disclaimer), and keeping
 * it out of `predictions` means the Board's gold/validated-edge treatment
 * (which just checks "does a predictions row exist," not which model)
 * can never accidentally pick it up. Reuses the same EdgeRow/Prediction
 * shape as getEdges purely so the existing EdgesTable component renders
 * it unchanged - every predictions-only field (win prob, total, CLV,
 * alert) is simply null here, same as any other model version that
 * doesn't populate them. */
export async function getInseasonEdges(modelVersion: string): Promise<EdgeRow[]> {
  const { data: rows, error: rowsError } = await supabase
    .from("inseason_edges")
    .select("*")
    .eq("model_version", modelVersion)
    .not("edge_spread", "is", null);
  if (rowsError) throw new Error(rowsError.message);
  if (!rows || rows.length === 0) return [];

  const gameIds = rows.map((r) => r.game_id);
  const [{ data: games, error: gamesError }, { data: teams, error: teamsError }] = await Promise.all([
    supabase.from("games").select("*").in("id", gameIds),
    supabase.from("teams").select("id, logo_url"),
  ]);
  if (gamesError) throw new Error(gamesError.message);
  if (teamsError) throw new Error(teamsError.message);

  const gameById = new Map((games as Game[]).map((g) => [g.id, g]));
  const logoById = new Map((teams as { id: number; logo_url: string | null }[]).map((t) => [t.id, t.logo_url]));

  return rows
    .map((row) => {
      const game = gameById.get(row.game_id);
      if (!game) return null;
      const prediction: Prediction = {
        game_id: row.game_id,
        model_version: row.model_version,
        predicted_home_win_prob: null,
        predicted_margin: row.predicted_margin,
        predicted_total: null,
        market_spread: row.market_spread,
        market_total: null,
        edge_spread: row.edge_spread,
        edge_total: null,
        predicted_clv_move: null,
        predicted_clv_direction: null,
        rationale: row.rationale,
        suggested_units: row.suggested_units,
        created_at: row.created_at,
      };
      return {
        prediction,
        game,
        homeLogo: game.home_id !== null ? (logoById.get(game.home_id) ?? null) : null,
        awayLogo: game.away_id !== null ? (logoById.get(game.away_id) ?? null) : null,
      };
    })
    .filter((r): r is EdgeRow => r !== null)
    .sort((a, b) => Math.abs(b.prediction.edge_spread ?? 0) - Math.abs(a.prediction.edge_spread ?? 0));
}

/** Stored walk-forward backtest rows for one model version, grouped by
 * group_key (e.g. "season_win_rate" -> one row per test season). */
export async function getBacktestResults(modelVersion: string): Promise<Record<string, ModelBacktest[]>> {
  const { data, error } = await supabase
    .from("model_backtests")
    .select("*")
    .eq("model_version", modelVersion)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);

  const grouped: Record<string, ModelBacktest[]> = {};
  for (const row of (data ?? []) as ModelBacktest[]) {
    (grouped[row.group_key] ??= []).push(row);
  }
  return grouped;
}

/** Every individual graded week-1 game from the backtest, newest season
 * first — the full pool for the site's filter tool, not just the top-15
 * selection (that's what is_selected + matchup_type='fbs_vs_fbs' filters
 * down to). */
export async function getBacktestGames(modelVersion: string): Promise<ModelBacktestGame[]> {
  const { data, error } = await supabase
    .from("model_backtest_games")
    .select("*")
    .eq("model_version", modelVersion)
    .order("season", { ascending: false })
    .order("edge", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ModelBacktestGame[];
}

export type BetStatus = "pending" | "win" | "loss" | "push";

/** A bet joined with its game, graded live (never stored) so a result can
 * never go stale - status/profit reflect the game's CURRENT state every
 * time this is called. */
export type GradedBet = {
  bet: Bet;
  game: Game | null;
  status: BetStatus;
  profit: number | null; // units, null while pending; stake risked, not "to win"
  currentLine: DisplayLine | null; // the game's current headline line - null if no book has posted one. Powers CLV (see BetsLedger.tsx) - "current," not necessarily the eventual true close.
};

function americanToDecimal(odds: number): number {
  return odds < 0 ? 100 / Math.abs(odds) + 1 : odds / 100 + 1;
}

/** margin > 0 means the bet's side beat its number; < 0 means it didn't;
 * 0 is a push. Spread convention throughout (negative = favored), same as
 * the rest of the site. */
function gradeBet(bet: Bet, game: Game | null): { status: BetStatus; profit: number | null } {
  // A manual call always wins - the ONLY way a prop or parlay ever gets
  // graded (no player-stats feed to check a prop against; a parlay spans
  // multiple games/markets at once so there's no single game score to
  // check it against either), and a general override for any bet whose
  // real result needs a human call (postponement, settlement dispute)
  // rather than the game score.
  if (bet.manual_result) {
    if (bet.manual_result === "push") return { status: "push", profit: 0 };
    const won = bet.manual_result === "win";
    return { status: won ? "win" : "loss", profit: won ? bet.stake * (americanToDecimal(bet.odds) - 1) : -bet.stake };
  }

  if (bet.market === "prop" || bet.market === "parlay") {
    return { status: "pending", profit: null }; // waiting on a manual result, always
  }

  if (!game || !game.completed || game.home_points === null || game.away_points === null) {
    return { status: "pending", profit: null };
  }

  let margin: number;
  if (bet.market === "total") {
    const total = game.home_points + game.away_points;
    margin = bet.side === "over" ? total - bet.line : bet.line - total;
  } else if (bet.market === "moneyline") {
    const homeWon = game.home_points > game.away_points;
    const sideIsHome = bet.side === game.home_team;
    margin = (sideIsHome ? homeWon : !homeWon) ? 1 : -1; // no push concept for moneyline
  } else {
    // spread (default)
    const sideIsHome = bet.side === game.home_team;
    const actualMarginForSide = sideIsHome ? game.home_points - game.away_points : game.away_points - game.home_points;
    margin = actualMarginForSide + bet.line;
  }

  if (margin > 0) return { status: "win", profit: bet.stake * (americanToDecimal(bet.odds) - 1) };
  if (margin < 0) return { status: "loss", profit: -bet.stake };
  return { status: "push", profit: 0 };
}

/** Every bet ever logged, newest first, graded live against each game's
 * current state. */
export async function getBets(): Promise<GradedBet[]> {
  // Secret-key client, deliberately - `bets` holds real stakes/P&L, the
  // one genuinely sensitive table in this app, and its RLS no longer
  // allows public reads (see schema.sql). Every other query in this file
  // stays on the public client; games/predictions/etc. are just public
  // sports data with no privacy reason to lock down.
  const { data: bets, error } = await supabaseAdmin.from("bets").select("*").order("placed_at", { ascending: false });
  if (error) throw new Error(error.message);
  if (!bets || bets.length === 0) return [];

  const gameIds = Array.from(new Set(bets.map((b) => b.game_id).filter((id): id is number => id !== null)));
  const [{ data: games, error: gamesError }, { data: lines, error: linesError }, { data: oddsApiLines, error: oddsApiError }] = await Promise.all([
    supabase.from("games").select("*").in("id", gameIds),
    supabase.from("betting_lines").select("*").in("game_id", gameIds),
    supabase.from("odds_api_lines").select("*").in("game_id", gameIds),
  ]);
  if (gamesError) throw new Error(gamesError.message);
  if (linesError) throw new Error(linesError.message);
  if (oddsApiError) throw new Error(oddsApiError.message);
  const gameById = new Map((games as Game[]).map((g) => [g.id, g]));

  const linesByGame = new Map<number, BettingLine[]>();
  for (const l of (lines ?? []) as BettingLine[]) {
    const list = linesByGame.get(l.game_id) ?? [];
    list.push(l);
    linesByGame.set(l.game_id, list);
  }
  const oddsApiByGame = new Map<number, OddsApiLine[]>();
  for (const l of (oddsApiLines ?? []) as OddsApiLine[]) {
    const list = oddsApiByGame.get(l.game_id) ?? [];
    list.push(l);
    oddsApiByGame.set(l.game_id, list);
  }

  return (bets as Bet[]).map((bet) => {
    const game = bet.game_id !== null ? (gameById.get(bet.game_id) ?? null) : null;
    const currentLine =
      bet.game_id !== null ? pickHeadlineLine(mergeLines(linesByGame.get(bet.game_id) ?? [], oddsApiByGame.get(bet.game_id) ?? [])) : null;
    const { status, profit } = gradeBet(bet, game);
    return { bet, game, status, profit, currentLine };
  });
}

/** One team's season future joined with its logo. */
export type SeasonFutureRow = SeasonFuture & { logo: string | null };

/** Latest season-long projection per team (python/modeling/season_sim.py),
 * ranked by |edge| where a market number exists, then by championship_prob
 * for teams with no market match. Exploratory/unvalidated - see the
 * SeasonFuture type doc and season_sim.py's module docstring. */
export async function getSeasonFutures(season: number, modelVersion: string): Promise<SeasonFutureRow[]> {
  const { data: rows, error } = await supabase
    .from("season_futures")
    .select("*")
    .eq("season", season)
    .eq("model_version", modelVersion);
  if (error) throw new Error(error.message);
  if (!rows || rows.length === 0) return [];

  const { data: teams, error: teamsError } = await supabase.from("teams").select("school, logo_url");
  if (teamsError) throw new Error(teamsError.message);
  const logoBySchool = new Map((teams as { school: string; logo_url: string | null }[]).map((t) => [t.school, t.logo_url]));

  return (rows as SeasonFuture[])
    .map((r) => ({ ...r, logo: logoBySchool.get(r.team) ?? null }))
    .sort((a, b) => {
      const aEdge = a.edge !== null ? Math.abs(a.edge) : -1;
      const bEdge = b.edge !== null ? Math.abs(b.edge) : -1;
      if (aEdge !== bEdge) return bEdge - aEdge;
      return b.championship_prob - a.championship_prob;
    });
}

export type WatchlistRow = WatchlistPick & {
  homeTeam: string;
  awayTeam: string;
  startDate: string;
  homeLogo: string | null;
  awayLogo: string | null;
};

/** Active + recently-confirmed in-season watchlist picks (python/modeling/
 * watchlist.py) - joined with each game's matchup/kickoff for display.
 * Confirmed (alert_sent_at set) rows are included so the page can show
 * "confirmed" history, not just what's still being watched. */
export async function getWatchlist(modelVersion: string): Promise<WatchlistRow[]> {
  const { data: rows, error } = await supabase
    .from("watchlist_picks")
    .select("*")
    .eq("model_version", modelVersion)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  if (!rows || rows.length === 0) return [];

  const gameIds = [...new Set((rows as WatchlistPick[]).map((r) => r.game_id))];
  const { data: games, error: gamesError } = await supabase
    .from("games")
    .select("id, home_team, away_team, start_date")
    .in("id", gameIds);
  if (gamesError) throw new Error(gamesError.message);
  const gameById = new Map((games as { id: number; home_team: string; away_team: string; start_date: string }[]).map((g) => [g.id, g]));

  const { data: teams, error: teamsError } = await supabase.from("teams").select("school, logo_url");
  if (teamsError) throw new Error(teamsError.message);
  const logoBySchool = new Map((teams as { school: string; logo_url: string | null }[]).map((t) => [t.school, t.logo_url]));

  return (rows as WatchlistPick[])
    .map((r) => {
      const g = gameById.get(r.game_id);
      return {
        ...r,
        homeTeam: g?.home_team ?? "?",
        awayTeam: g?.away_team ?? "?",
        startDate: g?.start_date ?? r.created_at,
        homeLogo: g ? (logoBySchool.get(g.home_team) ?? null) : null,
        awayLogo: g ? (logoBySchool.get(g.away_team) ?? null) : null,
      };
    })
    .filter((r) => Boolean(gameById.get(r.game_id)));
}

/** Upcoming/live games plus anything completed in the last 2 days, for
 * any sport - "NFL Board"-equivalent (no odds/model yet, just schedule +
 * score, see sync_nfl_espn.py) used to pick a game to log a bet against.
 * 2 days (not My Games' 1) since NFL games cluster on Sun/Mon/Thu and a
 * bettor checking back Monday still wants to see Sunday's late games. */
export async function getUpcomingGames(sport: string): Promise<Game[]> {
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("sport", sport)
    .or(`completed.eq.false,start_date.gte.${cutoff}`)
    .order("start_date", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Game[];
}

export type SharpMoneyRow = {
  game: Game;
  homeLogo: string | null;
  awayLogo: string | null;
  source: "kalshi" | "polymarket";
  pmHomeProb: number;
  pmAwayProb: number;
  bookHomeProb: number;
  bookAwayProb: number;
  edge: number; // percentage points (0-100), always positive
  pmLikesHome: boolean; // which side the prediction market is MORE bullish on than the book
  volume: number | null;
  liquidity: number | null;
  numBooks: number; // how many books' moneylines went into the de-vigged consensus
  fetched_at: string;
};

// Odds API's own polling cadence is ~6h (see poll-odds-api.yml), so a
// book being up to several hours old is normal, expected freshness, not
// staleness - 24h comfortably clears that while still catching CFBD's
// multi-day gaps (poll_lines.py only refreshes "the current week").
const STALE_LINE_HOURS = 24;

/** Ranks every game with BOTH a prediction-market price (Kalshi/
 * Polymarket) and at least one sportsbook moneyline by how much the two
 * disagree, de-vigged - the "sharp money" read: a meaningful gap backed
 * by real prediction-market volume/liquidity is the signal worth
 * watching, a big gap on a zero-volume market is just noise (a market
 * that opened seconds ago with nobody trading it yet). Exploratory
 * comparison only - see prediction_market_lines' schema.sql docstring. */
export async function getSharpMoneyEdges(): Promise<SharpMoneyRow[]> {
  const { data: pmRows, error: pmError } = await supabase.from("prediction_market_lines").select("*");
  if (pmError) throw new Error(pmError.message);
  if (!pmRows || pmRows.length === 0) return [];

  const gameIds = [...new Set((pmRows as PredictionMarketLine[]).map((r) => r.game_id))];
  const [
    { data: games, error: gamesError },
    { data: lines, error: linesError },
    { data: oddsApiLines, error: oddsError },
    { data: teams, error: teamsError },
  ] = await Promise.all([
    supabase.from("games").select("*").in("id", gameIds),
    supabase.from("betting_lines").select("*").in("game_id", gameIds),
    supabase.from("odds_api_lines").select("*").in("game_id", gameIds),
    supabase.from("teams").select("school, logo_url"),
  ]);
  if (gamesError) throw new Error(gamesError.message);
  if (linesError) throw new Error(linesError.message);
  if (oddsError) throw new Error(oddsError.message);
  if (teamsError) throw new Error(teamsError.message);

  const gameById = new Map((games as Game[]).map((g) => [g.id, g]));
  const logoBySchool = new Map((teams as { school: string; logo_url: string | null }[]).map((t) => [t.school, t.logo_url]));
  const linesByGame = new Map<number, BettingLine[]>();
  for (const l of lines as BettingLine[]) linesByGame.set(l.game_id, [...(linesByGame.get(l.game_id) ?? []), l]);
  const oddsApiByGame = new Map<number, OddsApiLine[]>();
  for (const l of oddsApiLines as OddsApiLine[]) oddsApiByGame.set(l.game_id, [...(oddsApiByGame.get(l.game_id) ?? []), l]);

  const rows: SharpMoneyRow[] = [];
  for (const pm of pmRows as PredictionMarketLine[]) {
    const game = gameById.get(pm.game_id);
    if (!game || pm.home_implied_prob === null || pm.away_implied_prob === null) continue;

    const books = mergeLines(linesByGame.get(pm.game_id) ?? [], oddsApiByGame.get(pm.game_id) ?? []);
    const withMoneyline = books.filter(
      (b): b is DisplayLine & { homeMoneyline: number; awayMoneyline: number } => b.homeMoneyline !== null && b.awayMoneyline !== null,
    );
    // CFBD's line only refreshes for "the current week" (see poll_lines.py) -
    // a non-current-week game's CFBD row can sit stale for days, exactly
    // the gap already found and fixed for the model's own edge computation.
    // Excluded here rather than averaged in, so a 6-day-old CFBD moneyline
    // doesn't dilute the comparison against a prediction market's current
    // price - confirmed live, an Oklahoma @ Michigan CFBD row was 144.8h
    // old while Odds API's own books for the same game were 17-35h old.
    const staleCutoff = Date.now() - STALE_LINE_HOURS * 60 * 60 * 1000;
    const mlBooks = withMoneyline.filter((b) => b.fetchedAt !== null && new Date(b.fetchedAt).getTime() >= staleCutoff);
    if (mlBooks.length === 0) continue;

    const devigged = mlBooks.map((b) => devigTwoWay(b.homeMoneyline, b.awayMoneyline));
    const bookHomeProb = devigged.reduce((s, d) => s + d.home, 0) / devigged.length;
    const bookAwayProb = 1 - bookHomeProb;

    rows.push({
      game,
      homeLogo: logoBySchool.get(game.home_team) ?? null,
      awayLogo: logoBySchool.get(game.away_team) ?? null,
      source: pm.source,
      pmHomeProb: pm.home_implied_prob,
      pmAwayProb: pm.away_implied_prob,
      bookHomeProb,
      bookAwayProb,
      edge: Math.abs(pm.home_implied_prob - bookHomeProb) * 100,
      pmLikesHome: pm.home_implied_prob > bookHomeProb,
      volume: pm.volume,
      liquidity: pm.liquidity,
      numBooks: mlBooks.length,
      fetched_at: pm.fetched_at,
    });
  }
  return rows.sort((a, b) => b.edge - a.edge);
}

/** PostgREST says a table is missing ("could not find the table ... in the schema cache") until its
 * migration has been run - the NHL model tables are optional, so that's "no predictions yet", not an error. */
function isMissingTable(error: { code?: string; message: string }): boolean {
  return error.code === "PGRST205" || error.code === "42P01" || /schema cache|does not exist/i.test(error.message);
}

/** Model predictions for NHL games (python/nhl_model/publish.py), keyed by game id. Empty before the
 * nhl_predictions migration has been run or the publisher has produced anything. */
export async function getNhlPredictions(gameIds: number[]): Promise<Map<number, NhlPrediction>> {
  if (gameIds.length === 0) return new Map();
  const { data, error } = await supabase.from("nhl_predictions").select(NHL_PREDICTION_COLUMNS).in("game_id", gameIds);
  if (error) {
    if (isMissingTable(error)) return new Map();
    throw new Error(error.message);
  }
  return new Map((data as unknown as NhlPrediction[]).map((p) => [p.game_id, p]));
}

// Everything except sim_params (the heaviest column, only the game page needs it).
const NHL_PREDICTION_COLUMNS =
  "game_id, model_version, generated_at, p_home, p_home_reg, p_tie_reg, p_shootout, exp_home, exp_away, exp_total, total_dist, margin_dist, score_matrix, score_matrix_reg, extras, assumptions, market";

/** Our xG for finished NHL games, keyed by game id (same optional-table treatment as above). */
export async function getNhlGameXg(gameIds: number[]): Promise<Map<number, NhlGameXg>> {
  if (gameIds.length === 0) return new Map();
  const { data, error } = await supabase.from("nhl_game_xg").select("*").in("game_id", gameIds);
  if (error) {
    if (isMissingTable(error)) return new Map();
    throw new Error(error.message);
  }
  return new Map((data as NhlGameXg[]).map((x) => [x.game_id, x]));
}

/** When the NHL model last published predictions, across all games (null before the first run). */
export async function getNhlLastPublished(): Promise<string | null> {
  const { data, error } = await supabase.from("nhl_predictions").select("generated_at").order("generated_at", { ascending: false }).limit(1);
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(error.message);
  }
  return data?.[0]?.generated_at ?? null;
}

export type NhlStatsScope = "all" | "l10";

/** Seasons that have team/goalie tables published (newest first), and whether the current one has a last-10 view. */
export async function getNhlStatSeasons(): Promise<{ seasons: number[]; hasL10: Record<number, boolean> }> {
  // BOS has played every season, so its rows are a cheap stand-in for "which seasons exist"
  const { data, error } = await supabase.from("nhl_team_stats").select("season, scope").eq("team", "BOS");
  if (error) {
    if (isMissingTable(error)) return { seasons: [], hasL10: {} };
    throw new Error(error.message);
  }
  const seasons = [...new Set((data ?? []).map((r) => r.season as number))].sort((a, b) => b - a);
  const hasL10: Record<number, boolean> = {};
  for (const r of data ?? []) if (r.scope === "l10") hasL10[r.season as number] = true;
  return { seasons, hasL10 };
}

/** When the team/goalie tables were last rebuilt (null before the first publish). */
export async function getNhlStatsUpdated(): Promise<string | null> {
  const { data, error } = await supabase.from("nhl_team_stats").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(error.message);
  }
  return data?.[0]?.updated_at ?? null;
}

export async function getNhlTeamStats(season: number, scope: NhlStatsScope): Promise<NhlTeamStatsRow[]> {
  const { data, error } = await supabase.from("nhl_team_stats").select("season, scope, team, name, stats").eq("season", season).eq("scope", scope);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as NhlTeamStatsRow[];
}

export async function getNhlGoalieStats(season: number, scope: NhlStatsScope): Promise<NhlGoalieStatsRow[]> {
  const { data, error } = await supabase.from("nhl_goalie_stats").select("season, scope, goalie_id, name, team, stats").eq("season", season).eq("scope", scope);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as NhlGoalieStatsRow[];
}

/** Upcoming NHL games (not started) that have a published prediction, with just the fields needed to price their DraftKings
 * lines - for the all-edges list. Kept slim on purpose: no score grids, no simulation inputs. */
export async function getNhlUpcomingEdgeInputs(): Promise<{ game: Game; pred: EdgeInputs & { generated_at: string } }[]> {
  const { data: games, error } = await supabase
    .from("games")
    .select("*")
    .eq("sport", "nhl")
    .eq("completed", false)
    .gt("start_date", new Date().toISOString())
    .order("start_date", { ascending: true });
  if (error) throw new Error(error.message);
  if (!games || games.length === 0) return [];
  const { data: preds, error: predError } = await supabase
    .from("nhl_predictions")
    .select("game_id, generated_at, p_home, margin_dist, total_dist, market")
    .in("game_id", games.map((g) => g.id));
  if (predError) {
    if (isMissingTable(predError)) return [];
    throw new Error(predError.message);
  }
  const byGame = new Map((preds ?? []).map((p) => [p.game_id as number, p as unknown as EdgeInputs & { generated_at: string }]));
  return (games as Game[]).flatMap((game) => {
    const pred = byGame.get(game.id);
    return pred ? [{ game, pred }] : [];
  });
}

/** Every saved DraftKings price set for one game, oldest first (empty before the snapshot tables exist or the timer runs). */
export async function getNhlOddsSnapshots(gameId: number): Promise<NhlOddsSnapshot[]> {
  const { data, error } = await supabase.from("nhl_odds_snapshots").select("*").eq("game_id", gameId).order("captured_at", { ascending: true });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as NhlOddsSnapshot[];
}

/** Every GRADED edge-log row (the data behind the Edge log page), read in pages since PostgREST caps a request at 1000
 * rows. Also returns how many logged rows are still waiting on a result. */
export async function getNhlEdgeLog(): Promise<{ graded: NhlEdgeLogRow[]; pending: number; games: number }> {
  const graded: NhlEdgeLogRow[] = [];
  const cols = "game_id, kind, market, side_key, side, line, book_odds, book_implied, model_prob, ev, clv_pts, result, profit";
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("nhl_edge_log").select(cols).not("result", "is", null).order("id", { ascending: true }).range(from, from + 999);
    if (error) {
      if (isMissingTable(error)) return { graded: [], pending: 0, games: 0 };
      throw new Error(error.message);
    }
    graded.push(...((data ?? []) as unknown as NhlEdgeLogRow[]));
    if (!data || data.length < 1000) break;
  }
  const [{ count: pending }, { count: gameCount }] = await Promise.all([
    supabase.from("nhl_edge_log").select("id", { count: "exact", head: true }).is("result", null).eq("kind", "close"),
    supabase.from("nhl_edge_log").select("id", { count: "exact", head: true }).eq("kind", "close"),
  ]);
  return { graded, pending: Math.round((pending ?? 0) / 6), games: Math.round((gameCount ?? 0) / 6) };
}

/** Every rated skater (about 1,100 rows) and when the ratings were last refit. Empty before the table exists. */
export async function getNhlSkaterRatings(): Promise<{ rows: NhlSkaterRatingRow[]; updated: string | null }> {
  const rows: NhlSkaterRatingRow[] = [];
  let updated: string | null = null;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("nhl_skater_ratings").select("player_id, name, pos, team, stats, updated_at").order("player_id", { ascending: true }).range(from, from + 999);
    if (error) {
      if (isMissingTable(error)) return { rows: [], updated: null };
      throw new Error(error.message);
    }
    for (const r of data ?? []) {
      rows.push({ player_id: r.player_id as number, name: r.name as string | null, pos: r.pos as string | null, team: r.team as string | null, stats: r.stats as Record<string, number | null> });
      const u = r.updated_at as string | null;
      if (u && (!updated || u > updated)) updated = u;
    }
    if (!data || data.length < 1000) break;
  }
  return { rows, updated };
}

/** Every graded goalie call, read in pages (PostgREST caps a request at 1000 rows), plus how many are still waiting. */
export async function getNhlGoalieCalls(): Promise<{ graded: NhlGoalieCallRow[]; pending: number }> {
  const graded: NhlGoalieCallRow[] = [];
  const cols = "game_id, side, kind, source, espn_status, top_p, p_actual, hit_espn, hit_top";
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("nhl_goalie_log").select(cols).not("graded_at", "is", null).order("id", { ascending: true }).range(from, from + 999);
    if (error) {
      if (isMissingTable(error)) return { graded: [], pending: 0 };
      throw new Error(error.message);
    }
    graded.push(...((data ?? []) as unknown as NhlGoalieCallRow[]));
    if (!data || data.length < 1000) break;
  }
  const { count } = await supabase.from("nhl_goalie_log").select("id", { count: "exact", head: true }).is("graded_at", null).eq("kind", "last");
  return { graded, pending: count ?? 0 };
}

/** One NHL game plus its model output, for the game page. */
export async function getNhlGame(id: number): Promise<{ game: Game; prediction: NhlPrediction | null; xg: NhlGameXg | null } | null> {
  const { data: game, error } = await supabase.from("games").select("*").eq("id", id).eq("sport", "nhl").maybeSingle();
  if (error) throw new Error(error.message);
  if (!game) return null;
  const [predRes, xg] = await Promise.all([supabase.from("nhl_predictions").select("*").eq("game_id", id).maybeSingle(), getNhlGameXg([id])]);
  if (predRes.error && !isMissingTable(predRes.error)) throw new Error(predRes.error.message);
  return { game: game as Game, prediction: (predRes.data as NhlPrediction | null) ?? null, xg: xg.get(id) ?? null };
}
