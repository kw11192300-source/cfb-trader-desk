import { supabase } from "./supabase";
import type { BettingLine, BoardRow, Game, LineSnapshot, OddsApiLine, Team } from "./types";

/**
 * Same idea as the Python side's current_week.py: the earliest
 * not-yet-completed game this calendar year is "the current week." Kept as
 * its own query (not shared code with Python) since it's a two-line lookup,
 * not worth a cross-language shared module for.
 */
async function getCurrentWeek(): Promise<{ season: number; week: number; seasonType: string } | null> {
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

/** Joins a list of games with every book's line for each and both teams' logos. */
async function buildBoardRows(games: Game[]): Promise<BoardRow[]> {
  const gameIds = games.map((g) => g.id);
  const teamIds = Array.from(new Set(games.flatMap((g) => [g.home_id, g.away_id]).filter((id): id is number => id !== null)));

  const [{ data: lines, error: linesError }, { data: oddsApiLines, error: oddsApiError }, { data: teams, error: teamsError }] =
    await Promise.all([
      gameIds.length > 0
        ? supabase.from("betting_lines").select("*").in("game_id", gameIds)
        : Promise.resolve({ data: [] as BettingLine[], error: null }),
      gameIds.length > 0
        ? supabase.from("odds_api_lines").select("*").in("game_id", gameIds)
        : Promise.resolve({ data: [] as OddsApiLine[], error: null }),
      teamIds.length > 0
        ? supabase.from("teams").select("*").in("id", teamIds)
        : Promise.resolve({ data: [] as Team[], error: null }),
    ]);
  if (linesError) throw new Error(linesError.message);
  if (oddsApiError) throw new Error(oddsApiError.message);
  if (teamsError) throw new Error(teamsError.message);

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

  return games.map((game) => ({
    game,
    lines: linesByGame.get(game.id) ?? [],
    oddsApiLines: oddsApiByGame.get(game.id) ?? [],
    homeLogo: game.home_id !== null ? (teamById.get(game.home_id)?.logo_url ?? null) : null,
    awayLogo: game.away_id !== null ? (teamById.get(game.away_id)?.logo_url ?? null) : null,
  }));
}

export async function getCurrentWeekBoard(): Promise<{
  season: number;
  week: number;
  seasonType: string;
  rows: BoardRow[];
} | null> {
  const current = await getCurrentWeek();
  if (!current) return null;

  // CFBD's own "week" windows span more than 7 days, so a single week
  // routinely mixes games that already finished with ones still upcoming
  // (e.g. Tuesday MACtion already final, Saturday's slate still ahead).
  // completed=false keeps this a live board of tradeable markets rather
  // than mixing in settled games with stale odds.
  const { data: games, error: gamesError } = await supabase
    .from("games")
    .select("*")
    .eq("season", current.season)
    .eq("week", current.week)
    .eq("season_type", current.seasonType)
    .eq("completed", false)
    .order("start_date", { ascending: true });
  if (gamesError) throw new Error(gamesError.message);

  const rows = await buildBoardRows(games as Game[]);
  return { season: current.season, week: current.week, seasonType: current.seasonType, rows };
}

export type GameDetail = {
  game: Game;
  lines: BettingLine[];
  oddsApiLines: OddsApiLine[];
  homeTeam: Team | null;
  awayTeam: Team | null;
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
  ] = await Promise.all([
    supabase.from("betting_lines").select("*").eq("game_id", id),
    supabase.from("odds_api_lines").select("*").eq("game_id", id),
    teamIds.length > 0 ? supabase.from("teams").select("*").in("id", teamIds) : Promise.resolve({ data: [] as Team[], error: null }),
  ]);
  if (linesError) throw new Error(linesError.message);
  if (oddsApiError) throw new Error(oddsApiError.message);
  if (teamsError) throw new Error(teamsError.message);

  const teamById = new Map((teams as Team[]).map((t) => [t.id, t]));
  return {
    game: game as Game,
    lines: (lines ?? []) as BettingLine[],
    oddsApiLines: (oddsApiLines ?? []) as OddsApiLine[],
    homeTeam: game.home_id !== null ? (teamById.get(game.home_id) ?? null) : null,
    awayTeam: game.away_id !== null ? (teamById.get(game.away_id) ?? null) : null,
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
