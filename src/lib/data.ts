import { supabase } from "./supabase";
import { supabaseAdmin } from "./supabase-admin";
import { type DisplayLine, mergeLines, pickHeadlineLine } from "./mergedLines";
import type {
  Bet,
  BettingLine,
  BoardRow,
  Game,
  LineSnapshot,
  ModelBacktest,
  ModelBacktestGame,
  OddsApiLine,
  Prediction,
  SeasonFuture,
  Team,
  TeamPowerRating,
} from "./types";

/**
 * Same idea as the Python side's current_week.py: the earliest
 * not-yet-completed game this calendar year is "the current week." Kept as
 * its own query (not shared code with Python) since it's a two-line lookup,
 * not worth a cross-language shared module for.
 */
export async function getCurrentWeek(): Promise<{ season: number; week: number; seasonType: string } | null> {
  const year = new Date().getFullYear();
  const { data, error } = await supabase
    .from("games")
    .select("season, week, season_type, start_date")
    .eq("season", year)
    .eq("completed", false)
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
export async function getAvailableWeeks(season: number): Promise<number[]> {
  const { data, error } = await supabase.from("games").select("week").eq("season", season).eq("season_type", "regular");
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
    const current = await getCurrentWeek();
    if (!current) return null;
    target = current;
  }

  const { data: games, error: gamesError } = await supabase
    .from("games")
    .select("*")
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
  ] = await Promise.all([
    supabase.from("betting_lines").select("*").eq("game_id", id),
    supabase.from("odds_api_lines").select("*").eq("game_id", id),
    teamIds.length > 0 ? supabase.from("teams").select("*").in("id", teamIds) : Promise.resolve({ data: [] as Team[], error: null }),
    supabase.from("predictions").select("*").eq("game_id", id),
  ]);
  if (linesError) throw new Error(linesError.message);
  if (oddsApiError) throw new Error(oddsApiError.message);
  if (teamsError) throw new Error(teamsError.message);
  if (predictionsError) throw new Error(predictionsError.message);

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
function gradeBet(bet: Bet, game: Game): { status: BetStatus; profit: number | null } {
  if (!game.completed || game.home_points === null || game.away_points === null) {
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

  const gameIds = Array.from(new Set(bets.map((b) => b.game_id)));
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
    const game = gameById.get(bet.game_id) ?? null;
    const currentLine = pickHeadlineLine(mergeLines(linesByGame.get(bet.game_id) ?? [], oddsApiByGame.get(bet.game_id) ?? []));
    if (!game) return { bet, game: null, status: "pending" as const, profit: null, currentLine };
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
