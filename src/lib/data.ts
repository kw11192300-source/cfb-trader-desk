import { supabase } from "./supabase";
import type { BettingLine, BoardRow, Game, Team } from "./types";
import { pickLine } from "./lines";

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

  const gameIds = (games as Game[]).map((g) => g.id);
  const teamIds = Array.from(
    new Set((games as Game[]).flatMap((g) => [g.home_id, g.away_id]).filter((id): id is number => id !== null))
  );

  const [{ data: lines, error: linesError }, { data: teams, error: teamsError }] = await Promise.all([
    gameIds.length > 0
      ? supabase.from("betting_lines").select("*").in("game_id", gameIds)
      : Promise.resolve({ data: [] as BettingLine[], error: null }),
    teamIds.length > 0
      ? supabase.from("teams").select("*").in("id", teamIds)
      : Promise.resolve({ data: [] as Team[], error: null }),
  ]);
  if (linesError) throw new Error(linesError.message);
  if (teamsError) throw new Error(teamsError.message);

  const linesByGame = new Map<number, BettingLine[]>();
  for (const line of (lines ?? []) as BettingLine[]) {
    const list = linesByGame.get(line.game_id) ?? [];
    list.push(line);
    linesByGame.set(line.game_id, list);
  }
  const teamById = new Map((teams as Team[]).map((t) => [t.id, t]));

  const rows: BoardRow[] = (games as Game[]).map((game) => ({
    game,
    line: pickLine(linesByGame.get(game.id) ?? []),
    homeLogo: game.home_id !== null ? (teamById.get(game.home_id)?.logo_url ?? null) : null,
    awayLogo: game.away_id !== null ? (teamById.get(game.away_id)?.logo_url ?? null) : null,
  }));

  return { season: current.season, week: current.week, seasonType: current.seasonType, rows };
}
