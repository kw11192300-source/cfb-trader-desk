import { supabase } from "./supabase";
import { supabaseAdmin } from "./supabase-admin";
import { type DisplayLine, mergeLines, pickHeadlineLine } from "./mergedLines";
import { devigTwoWay } from "./oddsMath";
import type { EdgeInputs } from "./nhlEdges";
import { buildMovements, type MoveRow, type MovementGame, type MovementSnapshot } from "./nhlMovement";
import { goalieNewsEvents, type NewsEvent, type NewsGame, type NewsSnapshot } from "./nhlGoalieNews";
import { buildModelMoves, type ModelGame, type ModelMoveRow, type ModelSnapshot } from "./nhlModelMoves";
import { etDay, teamGameRows, type GameInput, type PredInput, type TeamGameRow, type XgInput } from "./nhlTeamGames";
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
  NhlFuturesRow,
  NhlGoalieUnavailable,
  NhlGoalieCallRow,
  NhlMarket,
  CbbTeamRating,
  CbbPlayerRating,
  CbbBoardRow,
  CbbAvailability,
  NbaPlayerRating,
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

/** The stored DraftKings market (last prices we saw) for each of these NHL games, by game id. */
export async function getNhlMarkets(gameIds: number[]): Promise<Map<number, NhlMarket>> {
  if (gameIds.length === 0) return new Map();
  const { data, error } = await supabase.from("nhl_predictions").select("game_id, market").in("game_id", gameIds);
  if (error) {
    if (isMissingTable(error)) return new Map();
    throw new Error(error.message);
  }
  const out = new Map<number, NhlMarket>();
  for (const r of (data ?? []) as unknown as { game_id: number; market: NhlMarket | null }[]) if (r.market) out.set(r.game_id, r.market);
  return out;
}

/** College basketball team ratings for one season and kind (empty before the table exists or is published). */
export async function getCbbRatings(season: number, kind: string): Promise<CbbTeamRating[]> {
  const { data, error } = await supabase.from("cbb_team_ratings").select("*").eq("season", season).eq("kind", kind).limit(1000);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as CbbTeamRating[];
}

/** Players for the CBB players page: filtered and ordered in SQL (by impact, best first) so only one screenful travels. */
export async function getCbbPlayers(opts: {
  season: number;
  kind?: string;
  teamId?: number;
  conference?: string;
  role?: string;
  q?: string;
  limit?: number;
}): Promise<CbbPlayerRating[]> {
  let q = supabase.from("cbb_player_ratings").select("*").eq("season", opts.season).eq("kind", opts.kind ?? "preseason");
  if (opts.teamId !== undefined) q = q.eq("team_id", opts.teamId);
  if (opts.conference) q = q.eq("conference", opts.conference);
  if (opts.role) q = q.eq("stats->>role", opts.role);
  if (opts.q) q = q.ilike("name", `%${opts.q.replace(/[%_]/g, "")}%`);
  const { data, error } = await q.order("impact", { ascending: false, nullsFirst: false }).limit(opts.limit ?? 400);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as CbbPlayerRating[];
}

/** A team's published rating rows (preseason and last season's final), newest season first. */
export async function getCbbTeamRatings(teamId: number): Promise<CbbTeamRating[]> {
  const { data, error } = await supabase.from("cbb_team_ratings").select("*").eq("team_id", teamId).order("season", { ascending: false });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as CbbTeamRating[];
}

/** Ratings for a set of teams (the opponents on a schedule), one kind and season. */
export async function getCbbRatingsFor(teamIds: number[], season: number, kind: string): Promise<CbbTeamRating[]> {
  if (teamIds.length === 0) return [];
  const { data, error } = await supabase.from("cbb_team_ratings").select("*").eq("season", season).eq("kind", kind).in("team_id", teamIds);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as CbbTeamRating[];
}

/** Which (season, kind) pairs have ratings published, newest first - drives the page's toggle. */
export async function getCbbRatingKinds(): Promise<{ season: number; kind: string }[]> {
  const { data, error } = await supabase.from("cbb_team_ratings").select("season, kind").limit(5000);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  const seen = new Map<string, { season: number; kind: string }>();
  for (const r of (data ?? []) as { season: number; kind: string }[]) seen.set(`${r.season}-${r.kind}`, r);
  const order = (k: string) => (k === "current" ? 0 : k === "preseason" ? 1 : 2);
  return [...seen.values()].sort((a, b) => b.season - a.season || order(a.kind) - order(b.kind));
}

/** Every NBA player with a rating for a season (nba_player_ratings), best net rating first. */
export async function getNbaPlayers(season: number): Promise<NbaPlayerRating[]> {
  const { data, error } = await supabase.from("nba_player_ratings").select("*").eq("season", season).eq("kind", "current").order("net", { ascending: false, nullsFirst: false }).limit(1000);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as NbaPlayerRating[];
}

export type NbaInjury = {
  game_date: string;
  team: string;
  player: string;
  matchup: string | null;
  status: string;
  reason_cat: string | null;
  reason_detail: string | null;
  report_time: string;
};

/** The official injury report's latest status for every player listed for games on one Eastern date (nba_injury_status). */
export async function getNbaInjuries(day: string): Promise<NbaInjury[]> {
  const { data, error } = await supabase.from("nba_injury_status").select("game_date, team, player, matchup, status, reason_cat, reason_detail, report_time").eq("game_date", day).limit(2000);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as NbaInjury[];
}

/** One NBA game by id (the `games` table). */
export async function getNbaGame(id: number): Promise<Game | null> {
  const { data, error } = await supabase.from("games").select("*").eq("id", id).eq("sport", "nba").maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as Game | null;
}

/** NBA games in a time window (the `games` table, sport = nba), soonest first. */
export async function getNbaGames(fromIso: string, toIso: string): Promise<Game[]> {
  const { data, error } = await supabase.from("games").select("*").eq("sport", "nba").gte("start_date", fromIso).lte("start_date", toIso).order("start_date", { ascending: true }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as Game[];
}

export type NbaSnapshot = {
  game_id: number;
  captured_at: string;
  ml_home: number | null;
  ml_away: number | null;
  spread_home_line: number | null;
  spread_home_odds: number | null;
  spread_away_odds: number | null;
  total_line: number | null;
  over_odds: number | null;
  under_odds: number | null;
};

/** Every line change we logged for the given NBA games (nba_odds_snapshots), oldest first, grouped by game. */
export async function getNbaSnapshots(gameIds: number[]): Promise<Map<number, NbaSnapshot[]>> {
  const out = new Map<number, NbaSnapshot[]>();
  if (gameIds.length === 0) return out;
  const { data, error } = await supabase
    .from("nba_odds_snapshots")
    .select("game_id, captured_at, ml_home, ml_away, spread_home_line, spread_home_odds, spread_away_odds, total_line, over_odds, under_odds")
    .in("game_id", gameIds)
    .order("captured_at", { ascending: true })
    .limit(20000);
  if (error) {
    if (isMissingTable(error)) return out;
    throw new Error(error.message);
  }
  for (const r of (data ?? []) as NbaSnapshot[]) {
    const list = out.get(r.game_id) ?? [];
    list.push(r);
    out.set(r.game_id, list);
  }
  return out;
}

/** The bottom-up game model: team strength from each player's rating x projected minutes (averaged over who is in / out). */
export type NbaGameModel = {
  margin: number; // home margin (+ = home wins by)
  total: number; // level-matched to the day's posted totals
  total_raw?: number;
  level_shift?: number;
  p_home: number;
  ml_home: number;
  ml_away: number;
  pace: number;
  hca: number;
  L: number;
  home_off: number;
  home_de: number;
  away_off: number;
  away_de: number;
};
export type NbaNewsContrib = { player_id: number; name: string | null; p_play: number; share: number; net: number; effect: number };
export type NbaGameProjection = {
  game_id: number;
  start_date: string;
  home_team: string;
  away_team: string;
  news_move: number | null; // what the report's FRESH news is worth to the home margin (+ = favours home)
  line_open: number | null; // the home team's own number when we first saw a line
  line_now: number | null;
  moved: number | null; // how far the line has moved toward home since then
  gap: number | null; // news_move - moved: what the line has not yet absorbed
  pending_home: boolean;
  pending_away: boolean;
  detail: { contrib?: { home: NbaNewsContrib[]; away: NbaNewsContrib[] }; state_through?: string; hours_to_tip?: number; model?: NbaGameModel } | null;
  computed_at: string;
};
/** One stat's outcome distribution: ge[i] = P(stat >= k0 + i). */
export type NbaStatDist = { mean: number; median: number; k0: number; ge: number[] };
export type NbaPlayerProjection = {
  game_id: number;
  player_id: number;
  name: string;
  team: string;
  side: "home" | "away";
  p_play: number;
  status: string | null;
  reason: string | null;
  base_min: number | null;
  n_prior: number | null;
  min_mean: number | null;
  min_q10: number | null;
  min_q90: number | null;
  exp_min: number | null;
  stats: ({ _joint?: { dd: number; td: number } } & Record<string, unknown>) | null; // per stat: NbaStatDist; _joint = double-double / triple-double chances
  computed_at: string;
};

/** The live projections (nba_game_projections / nba_player_projections) for the given games; empty until the first live run. */
export async function getNbaProjections(gameIds: number[]): Promise<{ games: Map<number, NbaGameProjection>; players: Map<number, NbaPlayerProjection[]> }> {
  const games = new Map<number, NbaGameProjection>();
  const players = new Map<number, NbaPlayerProjection[]>();
  if (gameIds.length === 0) return { games, players };
  const [g, p] = await Promise.all([
    supabase.from("nba_game_projections").select("*").in("game_id", gameIds).limit(200),
    supabase.from("nba_player_projections").select("*").in("game_id", gameIds).order("exp_min", { ascending: false }).limit(5000),
  ]);
  for (const r of [g, p]) {
    if (r.error && !isMissingTable(r.error)) throw new Error(r.error.message);
  }
  for (const r of (g.data ?? []) as NbaGameProjection[]) games.set(r.game_id, r);
  for (const r of (p.data ?? []) as NbaPlayerProjection[]) {
    const list = players.get(r.game_id) ?? [];
    list.push(r);
    players.set(r.game_id, list);
  }
  return { games, players };
}

/** Players marked as out/doubtful/questionable that are still in effect (no end date, or the date has not passed). */
export async function getCbbAvailability(season: number): Promise<CbbAvailability[]> {
  const { data, error } = await supabase.from("cbb_availability").select("*").eq("season", season).order("created_at", { ascending: false }).limit(500);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return ((data ?? []) as CbbAvailability[]).filter((r) => !r.until || r.until >= today);
}

/** The CBB board for a time window (games the model has scored), soonest first. */
export async function getCbbBoard(fromIso: string, toIso: string): Promise<CbbBoardRow[]> {
  const { data, error } = await supabase.from("cbb_game_board").select("*").gte("start_date", fromIso).lte("start_date", toIso).order("start_date", { ascending: true }).limit(1500);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as CbbBoardRow[];
}

export async function getCbbBoardGame(gameId: number): Promise<CbbBoardRow | null> {
  const { data, error } = await supabase.from("cbb_game_board").select("*").eq("game_id", gameId).maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(error.message);
  }
  return (data as CbbBoardRow | null) ?? null;
}

export type CbbSnapshot = { captured_at: string; spread_home_line: number | null; total_line: number | null; ml_home: number | null; ml_away: number | null };

/** Every line change we logged for one game (cbb_odds_snapshots), oldest first. */
export async function getCbbSnapshots(gameId: number): Promise<CbbSnapshot[]> {
  const { data, error } = await supabase
    .from("cbb_odds_snapshots")
    .select("captured_at, spread_home_line, total_line, ml_home, ml_away")
    .eq("game_id", gameId)
    .order("captured_at", { ascending: true })
    .limit(2000);
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as CbbSnapshot[];
}

/** The NHL team names we have games for (as stored: ESPN's full names), alphabetical. */
export async function getNhlTeamNames(): Promise<string[]> {
  const { data, error } = await supabase.from("games").select("home_team").eq("sport", "nhl").limit(3000);
  if (error) throw new Error(error.message);
  return [...new Set((data ?? []).map((r) => r.home_team as string))].sort();
}

const GAME_COLS = "id, start_date, completed, home_team, away_team, home_points, away_points, live_status";

/** One team's games with the model's last pre-game numbers, our xG and DraftKings' closing prices (each null where we don't
 * have it - the model and odds tracking only began with the odds timer). Newest information last in the array order: rows come
 * back oldest first. `before` keeps only games that started earlier than that instant; `limitCompleted` keeps the latest N
 * finished games. Reads only the small columns (no score grids, no simulation inputs). */
export async function getNhlTeamGames(team: string, opts: { before?: string; limitCompleted?: number; includeUpcoming?: boolean } = {}): Promise<TeamGameRow[]> {
  const quoted = `"${team.replace(/"/g, "")}"`;
  let q = supabase.from("games").select(GAME_COLS).eq("sport", "nhl").or(`home_team.eq.${quoted},away_team.eq.${quoted}`).order("start_date", { ascending: true });
  if (opts.before) q = q.lt("start_date", opts.before);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let games = (data ?? []) as GameInput[];
  if (opts.includeUpcoming === false) games = games.filter((g) => g.completed);
  if (opts.limitCompleted !== undefined) {
    const done = games.filter((g) => g.completed);
    const keep = new Set(done.slice(-opts.limitCompleted).map((g) => g.id));
    games = games.filter((g) => keep.has(g.id) || (!g.completed && opts.includeUpcoming !== false));
  }
  if (games.length === 0) return [];
  const ids = games.map((g) => g.id);
  const [xgRes, predRes] = await Promise.all([
    supabase.from("nhl_game_xg").select("game_id, home_xg, away_xg").in("game_id", ids),
    supabase.from("nhl_predictions").select("game_id, p_home, exp_home, exp_away, exp_total, market").in("game_id", ids),
  ]);
  if (xgRes.error && !isMissingTable(xgRes.error)) throw new Error(xgRes.error.message);
  if (predRes.error && !isMissingTable(predRes.error)) throw new Error(predRes.error.message);
  const xg = new Map(((xgRes.data ?? []) as XgInput[]).map((r) => [r.game_id, r]));
  const preds = new Map(((predRes.data ?? []) as unknown as PredInput[]).map((r) => [r.game_id, r]));
  return teamGameRows(team, games, xg, preds);
}

export type NhlDayGame = { id: number; home_team: string; away_team: string; start_date: string; completed: boolean; home_points: number | null; away_points: number | null; live: boolean };

/** The games on the same Eastern-time schedule day as `startIso` (for the switcher on a game page), plus the first game of
 * the previous and next game days so the strip can step across days. */
export async function getNhlGameDay(startIso: string): Promise<{ day: string; games: NhlDayGame[]; prevGameId: number | null; nextGameId: number | null; prevDay: string | null; nextDay: string | null }> {
  const t = new Date(startIso).getTime();
  const from = new Date(t - 4 * 86_400_000).toISOString();
  const to = new Date(t + 4 * 86_400_000).toISOString();
  const { data, error } = await supabase.from("games").select(GAME_COLS).eq("sport", "nhl").gte("start_date", from).lte("start_date", to).order("start_date", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as GameInput[]).map((g) => ({ ...g, day: etDay(g.start_date) }));
  const day = etDay(startIso);
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const prevDay = days.filter((d) => d < day).pop() ?? null;
  const nextDay = days.find((d) => d > day) ?? null;
  const first = (d: string | null) => (d ? (rows.find((r) => r.day === d)?.id ?? null) : null);
  return {
    day,
    games: rows
      .filter((r) => r.day === day)
      .map((g) => ({
        id: g.id,
        home_team: g.home_team,
        away_team: g.away_team,
        start_date: g.start_date,
        completed: g.completed,
        home_points: g.home_points,
        away_points: g.away_points,
        live: Boolean(g.live_status) && !g.completed,
      })),
    prevGameId: first(prevDay),
    nextGameId: first(nextDay),
    prevDay,
    nextDay,
  };
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

/** Every DraftKings price/line change saved in the last `days` days, newest first (the Line moves page). Reads only the price
 * columns of the snapshots, in pages since PostgREST caps a request at 1000 rows. */
export async function getNhlLineMovements(days = 14): Promise<MoveRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const cols = "game_id, captured_at, ml_home, ml_away, spread_home_line, spread_home_odds, spread_away_odds, total_line, over_odds, under_odds, model";
  const snaps: MovementSnapshot[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("nhl_odds_snapshots").select(cols).gte("captured_at", since).order("captured_at", { ascending: true }).range(from, from + 999);
    if (error) {
      if (isMissingTable(error)) return [];
      throw new Error(error.message);
    }
    snaps.push(...((data ?? []) as unknown as MovementSnapshot[]));
    if (!data || data.length < 1000) break;
  }
  if (snaps.length === 0) return [];
  const ids = [...new Set(snaps.map((s) => s.game_id))];
  const { data: games, error: gErr } = await supabase.from("games").select("id, home_team, away_team, start_date").in("id", ids);
  if (gErr) throw new Error(gErr.message);
  return buildMovements(snaps, (games ?? []) as MovementGame[]);
}

/** Every change in the model's numbers for each game in the last `days` days (the Model moves page), newest first - read from
 * the snapshots that carry a model digest, with the price at that moment for the "closer to DraftKings?" comparison. */
export async function getNhlModelMoves(days = 14): Promise<ModelMoveRow[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const snaps: ModelSnapshot[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("nhl_odds_snapshots")
      .select("game_id, captured_at, ml_home, ml_away, model_note, model")
      .not("model", "is", null)
      .gte("captured_at", since)
      .order("captured_at", { ascending: true })
      .range(from, from + 999);
    if (error) {
      if (isMissingTable(error) || /model/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    snaps.push(...((data ?? []) as unknown as ModelSnapshot[]));
    if (!data || data.length < 1000) break;
  }
  if (snaps.length === 0) return [];
  const ids = [...new Set(snaps.map((s) => s.game_id))];
  const { data: games, error: gErr } = await supabase.from("games").select("id, home_team, away_team, start_date").in("id", ids);
  if (gErr) throw new Error(gErr.message);
  return buildModelMoves(snaps, (games ?? []) as ModelGame[]);
}

/** Every goalie-news update (a goalie confirmed or the expected starter switched) this season and how DraftKings' moneyline
 * reacted around it. Pulls only the moneyline prices and the model's win probability out of the snapshots (not the whole
 * model digest) to keep the read small. */
export async function getNhlGoalieNews(): Promise<NewsEvent[]> {
  const snaps: NewsSnapshot[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("nhl_odds_snapshots")
      .select("game_id, captured_at, ml_home, ml_away, model_note, p_home:model->>p_home")
      .order("captured_at", { ascending: true })
      .range(from, from + 999);
    if (error) {
      if (isMissingTable(error) || error.message.includes("model")) return [];
      throw new Error(error.message);
    }
    for (const r of (data ?? []) as unknown as (Omit<NewsSnapshot, "p_home"> & { p_home: string | null })[]) {
      snaps.push({ ...r, p_home: r.p_home === null || r.p_home === undefined ? null : Number(r.p_home) });
    }
    if (!data || data.length < 1000) break;
  }
  if (snaps.length === 0) return [];
  const ids = [...new Set(snaps.filter((s) => s.model_note).map((s) => s.game_id))];
  if (ids.length === 0) return [];
  const { data: games, error: gErr } = await supabase.from("games").select("id, home_team, away_team, start_date").in("id", ids);
  if (gErr) throw new Error(gErr.message);
  return goalieNewsEvents(snaps.filter((s) => ids.includes(s.game_id)), (games ?? []) as NewsGame[]);
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

/** Goalies marked unavailable by hand (empty before the table exists). */
export async function getNhlUnavailableGoalies(): Promise<NhlGoalieUnavailable[]> {
  const { data, error } = await supabase.from("nhl_goalie_unavailable").select("*").order("created_at", { ascending: false });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as NhlGoalieUnavailable[];
}

/** The latest season simulation: one row per team, plus when it was run. Empty before the table exists. */
export async function getNhlFutures(): Promise<{ rows: NhlFuturesRow[]; updated: string | null; season: number | null }> {
  const { data, error } = await supabase.from("nhl_futures").select("season, team, stats, updated_at").order("season", { ascending: false }).limit(200);
  if (error) {
    if (isMissingTable(error)) return { rows: [], updated: null, season: null };
    throw new Error(error.message);
  }
  const all = (data ?? []) as unknown as (NhlFuturesRow & { updated_at: string })[];
  if (all.length === 0) return { rows: [], updated: null, season: null };
  const season = all[0].season;
  const rows = all.filter((r) => r.season === season);
  return { rows, season, updated: rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), "") || null };
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
