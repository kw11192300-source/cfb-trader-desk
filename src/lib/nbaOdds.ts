import { supabaseAdmin } from "./supabase-admin";
import { type CbbMarket, type EspnOdds, parseMarket, PRICE_FIELDS, samePrices } from "./cbbOdds";
import { NBA_GAME_ID_OFFSET } from "./nbaTeams";
import { gradeNbaProps, type GradeResult } from "./nbaProps";
import { updateNbaInjuries } from "./nbaInjuries";

// Server-only. NBA: keeps the `games` table current (schedule, live status, finals) straight from ESPN's scoreboard and logs every
// change in the posted lines (spread, total, moneyline) to nba_odds_snapshots - the history that lets a bet be compared with where
// the line closed (closing-line value). Called every ~10 minutes by src/app/api/cron/nba-odds/route.ts and by the "Update scores"
// button. Same shape as the college basketball timer (cbbOdds.ts) on purpose, and it shares that file's ESPN odds parser.

const ESPN_NBA_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";
const DAYS_BACK = 2;
const DAYS_FORWARD = 4;

type EspnEvent = {
  id: string;
  date: string;
  season?: { year?: number; type?: number };
  status?: { type?: { state?: string; completed?: boolean; shortDetail?: string }; period?: number; displayClock?: string };
  competitions?: {
    venue?: { fullName?: string };
    odds?: EspnOdds[];
    competitors?: { homeAway?: string; score?: string; team?: { displayName?: string } }[];
  }[];
};

/** The season's START year: the 2026-27 season is 2026 (games run October to June). */
function seasonOf(iso: string): number {
  const d = new Date(new Date(iso).getTime() - 8 * 3_600_000);
  return d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

export type NbaUpdateResult = {
  ok: boolean;
  message: string;
  games: number;
  priced: number;
  moved: number;
  snapshots: number;
  live: number;
  final: number;
  graded: GradeResult | null;
};

export async function updateNba(opts: { grade?: boolean } = {}): Promise<NbaUpdateResult> {
  const blank = { games: 0, priced: 0, moved: 0, snapshots: 0, live: 0, final: 0, graded: null as GradeResult | null };
  const fail = (message: string): NbaUpdateResult => ({ ok: false, message, ...blank });
  const fetchedAt = new Date().toISOString();
  const now = Date.now();
  const days: string[] = [];
  for (let d = -DAYS_BACK; d <= DAYS_FORWARD; d++) days.push(new Date(now + d * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""));

  const events: EspnEvent[] = [];
  try {
    const boards = await Promise.all(
      days.map(async (d) => {
        const res = await fetch(`${ESPN_NBA_SCOREBOARD}?dates=${d}&limit=100`, { cache: "no-store" });
        if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
        return (await res.json()) as { events?: EspnEvent[] };
      }),
    );
    const seen = new Set<string>();
    for (const b of boards) {
      for (const e of b.events ?? []) {
        if (seen.has(e.id) || e.competitions?.[0]?.competitors?.length !== 2) continue;
        seen.add(e.id);
        events.push(e);
      }
    }
  } catch (e) {
    return fail(`Couldn't reach ESPN: ${e instanceof Error ? e.message : "unknown error"}.`);
  }
  if (events.length === 0) {
    const graded = opts.grade ? await gradeNbaProps().catch(() => null) : null;
    const inj0 = await updateNbaInjuries().catch(() => null);
    return { ok: true, message: `No NBA games on the board right now.${inj0?.message ? ` ${inj0.message}` : ""}`, ...blank, graded };
  }

  // ---- games table: schedule, live status, finals
  let live = 0;
  let final = 0;
  const gameRows = events.map((e) => {
    const comp = e.competitions![0];
    const home = comp.competitors!.find((c) => c.homeAway === "home");
    const away = comp.competitors!.find((c) => c.homeAway === "away");
    const state = e.status?.type?.state;
    const completed = Boolean(e.status?.type?.completed);
    const hp = home?.score !== undefined && home.score !== "" ? Number(home.score) : null;
    const ap = away?.score !== undefined && away.score !== "" ? Number(away.score) : null;
    if (state === "in") live++;
    if (completed) final++;
    const season = seasonOf(e.date);
    const week = Math.max(1, Math.floor((new Date(e.date).getTime() - Date.UTC(season, 9, 1)) / (7 * 86_400_000)) + 1); // weeks since Oct 1
    const t = e.season?.type;
    return {
      id: -(Number(e.id) + NBA_GAME_ID_OFFSET),
      sport: "nba",
      season,
      week,
      season_type: t === 3 ? "postseason" : t === 1 ? "preseason" : "regular",
      start_date: e.date,
      completed,
      neutral_site: false,
      venue: comp.venue?.fullName ?? null,
      home_team: home?.team?.displayName ?? "Home",
      home_points: hp,
      away_team: away?.team?.displayName ?? "Away",
      away_points: ap,
      live_status:
        state === "in" && hp !== null && ap !== null
          ? { home_points: hp, away_points: ap, period: e.status?.period ?? null, clock: e.status?.displayClock ?? null, detail: e.status?.type?.shortDetail ?? null, updated_at: fetchedAt }
          : null,
    };
  });
  for (let i = 0; i < gameRows.length; i += 400) {
    const { error } = await supabaseAdmin.from("games").upsert(gameRows.slice(i, i + 400), { onConflict: "id" });
    if (error) return fail(`Saving games failed: ${error.message}`);
  }

  // ---- odds: every not-yet-started game with a posted line; a snapshot whenever any price moved
  const incoming = new Map<number, CbbMarket>();
  for (const e of events) {
    if (e.status?.type?.state !== "pre") continue;
    const o = e.competitions![0].odds?.[0];
    if (!o) continue;
    const m = parseMarket(o);
    if (PRICE_FIELDS.some((k) => m[k] !== null)) incoming.set(-(Number(e.id) + NBA_GAME_ID_OFFSET), m);
  }

  let moved = 0;
  let saved = 0;
  let oddsNote = "";
  if (incoming.size > 0) {
    const last = new Map<number, CbbMarket>();
    const { data: snaps, error: snapErr } = await supabaseAdmin
      .from("nba_odds_snapshots")
      .select("game_id, captured_at, provider, ml_home, ml_away, spread_home_line, spread_home_odds, spread_away_odds, total_line, over_odds, under_odds")
      .in("game_id", [...incoming.keys()])
      .order("captured_at", { ascending: false })
      .limit(5000);
    if (snapErr) {
      const missing = snapErr.code === "PGRST205" || snapErr.code === "42P01" || /does not exist|schema cache/i.test(snapErr.message);
      if (!missing) return fail(snapErr.message);
      oddsNote = " Lines not logged yet - run the nba_odds_snapshots block in supabase/schema.sql.";
    } else {
      for (const s of snaps ?? []) if (!last.has(s.game_id as number)) last.set(s.game_id as number, s as unknown as CbbMarket);
      const rows: Record<string, unknown>[] = [];
      for (const [gid, m] of incoming) {
        const prev = last.get(gid) ?? null;
        if (samePrices(prev, m)) continue;
        if (prev) moved++;
        rows.push({ game_id: gid, captured_at: fetchedAt, ...m });
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabaseAdmin.from("nba_odds_snapshots").insert(rows.slice(i, i + 500));
        if (error) return fail(`Saving odds snapshots failed: ${error.message}`);
      }
      saved = rows.length;
    }
  }

  const graded = opts.grade ? await gradeNbaProps().catch(() => null) : null;
  const inj = await updateNbaInjuries().catch(() => null); // never let the injury report stop the scores and lines
  const gradeMsg = graded && graded.graded + graded.voided > 0 ? ` ${graded.graded} prop${graded.graded === 1 ? "" : "s"} graded${graded.voided ? ` (${graded.voided} voided)` : ""}.` : "";
  return {
    ok: true,
    message: `${events.length} games synced (${live} live, ${final} final), ${incoming.size} priced, ${moved} moved, ${saved} snapshot${saved === 1 ? "" : "s"} saved.${gradeMsg}${oddsNote}${inj?.message ? ` ${inj.message}` : ""}`,
    games: events.length,
    priced: incoming.size,
    moved,
    snapshots: saved,
    live,
    final,
    graded,
  };
}
