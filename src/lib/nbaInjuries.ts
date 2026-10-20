import { supabaseAdmin } from "./supabase-admin";
import { fetchLatestReport, type InjuryRow } from "./nbaInjuryParse";

// Server-only. Keeps nba_injury_status (the latest status of every player on the official report, per game) current and writes every
// CHANGE to nba_injury_log with the time we saw it - the timestamped history that lets us study how fast the market reacts to news.
// Called every ~10 minutes by /api/cron/nba-odds and by the "Update scores" button; the report itself is published every 15 minutes.

type Stored = { game_date: string; team: string; player: string; status: string; reason_cat: string | null; reason_detail: string | null };

const isoDate = (mdy: string | null): string | null => {
  const m = mdy ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdy) : null;
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};
const key = (d: string, t: string, p: string) => `${d}|${t}|${p}`;

export type InjuryUpdate = { ok: boolean; message: string; reportTime: string | null; rows: number; changes: number };

export async function updateNbaInjuries(): Promise<InjuryUpdate> {
  const got = await fetchLatestReport().catch(() => null);
  if (!got) return { ok: false, message: "Couldn't reach the NBA injury report.", reportTime: null, rows: 0, changes: 0 };
  const rows: (InjuryRow & { d: string })[] = [];
  for (const r of got.rows) {
    const d = isoDate(r.game_date);
    if (d) rows.push({ ...r, d });
  }
  if (rows.length === 0) return { ok: true, message: "The latest report has no rows yet.", reportTime: got.reportTime.toISOString(), rows: 0, changes: 0 };

  const dates = [...new Set(rows.map((r) => r.d))];
  const { data: existing, error } = await supabaseAdmin.from("nba_injury_status").select("game_date, team, player, status, reason_cat, reason_detail").in("game_date", dates);
  if (error) {
    const missing = error.code === "PGRST205" || error.code === "42P01" || /does not exist|schema cache/i.test(error.message);
    return { ok: missing, message: missing ? "Injury report parsed; run the nba_injury_status block in supabase/schema.sql to save it." : error.message, reportTime: got.reportTime.toISOString(), rows: rows.length, changes: 0 };
  }
  const prev = new Map<string, Stored>();
  for (const s of (existing ?? []) as Stored[]) prev.set(key(s.game_date, s.team, s.player), s);

  const reportIso = got.reportTime.toISOString();
  const status: Record<string, unknown>[] = [];
  const log: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const player = r.player ?? ""; // "" = the team has not submitted yet
    const k = key(r.d, r.team, player);
    seen.add(k);
    const old = prev.get(k);
    const changed = !old || old.status !== r.status || old.reason_cat !== r.reason_cat || old.reason_detail !== r.reason_detail;
    status.push({ game_date: r.d, team: r.team, player, matchup: r.matchup, game_time_et: r.game_time_et, status: r.status, reason_cat: r.reason_cat, reason_detail: r.reason_detail, report_time: reportIso });
    if (changed) log.push({ report_time: reportIso, game_date: r.d, team: r.team, player, old_status: old?.status ?? null, new_status: r.status, reason_cat: r.reason_cat, reason_detail: r.reason_detail });
  }
  // players that disappeared from a team's list (cleared) are logged as Available, and the "not yet submitted" placeholder goes away
  const submittedTeams = new Set(rows.filter((r) => r.player).map((r) => `${r.d}|${r.team}`));
  const gone: Stored[] = [];
  for (const [k, s] of prev) {
    if (seen.has(k)) continue;
    const teamKey = `${s.game_date}|${s.team}`;
    if (s.player === "" && submittedTeams.has(teamKey)) gone.push(s);
    else if (s.player !== "" && rows.some((r) => `${r.d}|${r.team}` === teamKey)) {
      gone.push(s);
      log.push({ report_time: reportIso, game_date: s.game_date, team: s.team, player: s.player, old_status: s.status, new_status: "Removed", reason_cat: null, reason_detail: null });
    }
  }
  for (let i = 0; i < status.length; i += 400) {
    const { error: e } = await supabaseAdmin.from("nba_injury_status").upsert(status.slice(i, i + 400), { onConflict: "game_date,team,player" });
    if (e) return { ok: false, message: `Saving injury status failed: ${e.message}`, reportTime: reportIso, rows: rows.length, changes: 0 };
  }
  for (const g of gone) await supabaseAdmin.from("nba_injury_status").delete().eq("game_date", g.game_date).eq("team", g.team).eq("player", g.player);
  for (let i = 0; i < log.length; i += 400) {
    const { error: e } = await supabaseAdmin.from("nba_injury_log").insert(log.slice(i, i + 400));
    if (e) return { ok: false, message: `Saving injury log failed: ${e.message}`, reportTime: reportIso, rows: rows.length, changes: 0 };
  }
  return { ok: true, message: `Injury report ${got.reportTime.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET: ${rows.filter((r) => r.player).length} players, ${log.length} change${log.length === 1 ? "" : "s"}.`, reportTime: reportIso, rows: rows.length, changes: log.length };
}
