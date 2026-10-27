import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase-admin";

// Server-only. The odds timers only need each game's MOST RECENT logged line to decide whether a price moved. Reading a game's whole
// history every ten minutes (the old query: up to 5,000 rows) was the single biggest thing leaving the database, so look at the last
// few hours first, and only go further back for games whose line has not changed since.

const COLS = "game_id, captured_at, provider, ml_home, ml_away, spread_home_line, spread_home_odds, spread_away_odds, total_line, over_odds, under_odds";
const RECENT_HOURS = 6;

export async function latestSnapshots(table: "cbb_odds_snapshots" | "nba_odds_snapshots", gameIds: number[]): Promise<{ rows: Map<number, Record<string, unknown>>; error: PostgrestError | null }> {
  const rows = new Map<number, Record<string, unknown>>();
  if (gameIds.length === 0) return { rows, error: null };
  const since = new Date(Date.now() - RECENT_HOURS * 3_600_000).toISOString();
  const a = await supabaseAdmin.from(table).select(COLS).in("game_id", gameIds).gte("captured_at", since).order("captured_at", { ascending: false }).limit(2000);
  if (a.error) return { rows, error: a.error };
  for (const s of a.data ?? []) if (!rows.has(s.game_id as number)) rows.set(s.game_id as number, s as Record<string, unknown>);
  const missing = gameIds.filter((id) => !rows.has(id));
  if (missing.length > 0) {
    // no change in the window: their history is short, so a small look-back finds the last row (a miss only means one repeat row is logged)
    const b = await supabaseAdmin.from(table).select(COLS).in("game_id", missing).order("captured_at", { ascending: false }).limit(Math.min(missing.length * 4, 1500));
    if (!b.error) for (const s of b.data ?? []) if (!rows.has(s.game_id as number)) rows.set(s.game_id as number, s as Record<string, unknown>);
  }
  return { rows, error: null };
}
